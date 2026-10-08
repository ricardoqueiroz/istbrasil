import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { createExportWorkspace, requireExportWorkspace, exportCommit, verifyExport, safeGitPath, exclusionReason, parseTree, verifyObject, EXPORT_POLICY, POLICY_SHA256 } from '../scripts/deploy/git-export.mjs';

const linux = { skip: process.platform !== 'linux' || process.getuid?.() === 0 ? 'Linux non-root workspace required' : false };
const nativeGit = (() => { try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const digest = (value, algorithm = 'sha256') => createHash(algorithm).update(value).digest('hex');
const rawObject = (type, content) => {
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const raw = Buffer.concat([Buffer.from(`${type} ${bytes.length}\0`), bytes]);
    return { oid: digest(raw, 'sha1'), type, bytes, raw };
};
const treeBytes = entries => Buffer.concat([...entries].sort((a, b) => Buffer.compare(Buffer.from(a.name + (a.mode === '40000' ? '/' : '')), Buffer.from(b.name + (b.mode === '40000' ? '/' : ''))))
    .map(entry => Buffer.concat([Buffer.from(`${entry.mode} ${entry.name}\0`), Buffer.from(entry.oid, 'hex')])));

// Genuine loose Git objects, refs and commits; no fake CLI responses. The same
// fixture format is independently checked by native Git wherever available.
async function repository(directory) {
    const git = `${directory}/.git`, objects = new Map();
    for (const name of [git, `${git}/objects`, `${git}/refs`, `${git}/refs/heads`]) await fs.mkdir(name, { recursive: true, mode: 0o700 });
    await fs.writeFile(`${git}/HEAD`, 'ref: refs/heads/main\n', { mode: 0o600 });
    await fs.writeFile(`${git}/config`, '[core]\nrepositoryformatversion = 0\nbare = false\n', { mode: 0o600 });
    const put = async (type, bytes) => {
        const object = rawObject(type, bytes), bucket = `${git}/objects/${object.oid.slice(0, 2)}`;
        await fs.mkdir(bucket, { recursive: true, mode: 0o700 });
        await fs.writeFile(`${bucket}/${object.oid.slice(2)}`, deflateSync(object.raw), { mode: 0o600 });
        objects.set(object.oid, object);
        return object.oid;
    };
    const commit = async (files, parents = []) => {
        const root = new Map(), blobs = new Map();
        for (const [relative, value] of Object.entries(files)) {
            const parts = relative.split('/'), content = typeof value === 'object' && !Buffer.isBuffer(value) ? value.bytes : value;
            const oid = await put('blob', content), mode = typeof value === 'object' && !Buffer.isBuffer(value) ? value.mode : '100644';
            blobs.set(relative, oid);
            let node = root;
            for (const component of parts.slice(0, -1)) { if (!node.has(component)) node.set(component, new Map()); node = node.get(component); }
            node.set(parts.at(-1), { oid, mode });
        }
        const makeTree = async node => {
            const entries = [];
            for (const [name, value] of node) entries.push(value instanceof Map ? { name, oid: await makeTree(value), mode: '40000' } : { name, ...value });
            return put('tree', treeBytes(entries));
        };
        const tree = await makeTree(root), oid = await makeCommit(tree, parents);
        await main(oid);
        return { oid, tree, blobs };
    };
    const makeCommit = (tree, parents = []) => put('commit', `tree ${tree}\n${parents.map(parent => `parent ${parent}\n`).join('')}author Fixture <fixture@invalid.test> 1700000000 +0000\ncommitter Fixture <fixture@invalid.test> 1700000000 +0000\n\nFictional source fixture\n`);
    const main = oid => fs.writeFile(`${git}/refs/heads/main`, `${oid}\n`, { mode: 0o600 });
    return { git, objects, put, commit, makeCommit, main, objectFile: oid => `${git}/objects/${oid.slice(0, 2)}/${oid.slice(2)}` };
}

async function fixture(t, files = { 'server.js': '// fictional source, never executed\n', 'package.json': '{"name":"fixture"}', 'src/main.ts': '// fixture' }) {
    const workspace = await createExportWorkspace();
    t.after(() => fs.rm(workspace, { recursive: true, force: true }));
    const repo = await repository(`${workspace}/repository`), commit = await repo.commit(files);
    const options = { workspace, commitSha: commit.oid, approvedMainSha: commit.oid };
    return { workspace, repo, commit, options, run: additional => exportCommit({ ...options, ...additional }) };
}

async function snapshot(root) {
    const result = {};
    const visit = async filename => {
        const stat = await fs.lstat(filename), relative = path.relative(root, filename);
        result[relative] = { mode: stat.mode, mtime: stat.mtimeMs, uid: stat.uid, gid: stat.gid, ino: stat.ino,
            bytes: stat.isFile() ? digest(await fs.readFile(filename)) : stat.isSymbolicLink() ? await fs.readlink(filename) : null };
        if (stat.isDirectory()) for (const child of await fs.readdir(filename)) await visit(`${filename}/${child}`);
    };
    await visit(root); return result;
}
async function reseal(destination, record) {
    const bytes = JSON.stringify(record);
    await fs.writeFile(`${destination}/source.json`, bytes);
    await fs.writeFile(`${destination}/COMPLETE.json`, JSON.stringify({ version: 1, exportId: record.exportId, sourceSha256: digest(bytes) }));
}

async function packRepository(repo) {
    // Standard PACK v2 and idx v2, without deltas. Fixture data only.
    const entries = [], chunks = [Buffer.from('PACK'), Buffer.from([0, 0, 0, 2])];
    const count = Buffer.alloc(4); count.writeUInt32BE(repo.objects.size); chunks.push(count);
    let offset = 12;
    const crc32 = bytes => {
        let crc = 0xffffffff;
        for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
        return (crc ^ 0xffffffff) >>> 0;
    };
    for (const object of repo.objects.values()) {
        let size = object.bytes.length;
        const header = [({ commit: 1, tree: 2, blob: 3 }[object.type] << 4) | (size & 15)];
        size = Math.floor(size / 16);
        if (size) header[0] |= 128;
        while (size) { const byte = size & 127; size = Math.floor(size / 128); header.push(byte | (size ? 128 : 0)); }
        const data = Buffer.concat([Buffer.from(header), deflateSync(object.bytes)]);
        entries.push({ oid: object.oid, offset, crc: crc32(data) }); chunks.push(data); offset += data.length;
    }
    const packBody = Buffer.concat(chunks), packSha = digest(packBody, 'sha1'), pack = Buffer.concat([packBody, Buffer.from(packSha, 'hex')]);
    entries.sort((a, b) => a.oid.localeCompare(b.oid));
    const fanout = Buffer.alloc(1024), crcs = Buffer.alloc(entries.length * 4), offsets = Buffer.alloc(entries.length * 4);
    for (let i = 0; i < 256; i++) fanout.writeUInt32BE(entries.filter(entry => parseInt(entry.oid.slice(0, 2), 16) <= i).length, i * 4);
    for (let i = 0; i < entries.length; i++) { crcs.writeUInt32BE(entries[i].crc, i * 4); offsets.writeUInt32BE(entries[i].offset, i * 4); }
    const idxBody = Buffer.concat([Buffer.from([255, 116, 79, 99, 0, 0, 0, 2]), fanout, ...entries.map(entry => Buffer.from(entry.oid, 'hex')), crcs, offsets, Buffer.from(packSha, 'hex')]);
    const folder = `${repo.git}/objects/pack`; await fs.mkdir(folder, { mode: 0o700 });
    await fs.writeFile(`${folder}/pack-${packSha}.pack`, pack, { mode: 0o600 });
    await fs.writeFile(`${folder}/pack-${packSha}.idx`, Buffer.concat([idxBody, Buffer.from(digest(idxBody, 'sha1'), 'hex')]), { mode: 0o600 });
    for (const object of repo.objects.values()) await fs.unlink(repo.objectFile(object.oid));
}

test('policy is explicit, versioned and does not consult gitignore', () => {
    assert.equal(POLICY_SHA256, digest(JSON.stringify(EXPORT_POLICY)));
    assert.equal(exclusionReason('src/environments/environment.ts'), null);
    assert.equal(exclusionReason('src/controllers/example.js'), null);
    for (const name of ['app.component.ts', 'app.config.ts', 'app.routes.ts', 'page-flip.d.ts']) assert.equal(exclusionReason(`src/${name}`), null);
    assert.equal(exclusionReason('.gitignore'), 'NOT_BUILD_INPUT');
});
for (const relative of ['html/index.html', '.env', '.env.backup', '.env_old', 'src/assets/.ENV.example', 'istbrasil.private/file.pdf', 'uploads/photo.jpg', 'backend-php/index.php', 'database/data.sql', 'dump/file.txt', 'src/assets/session.session.sql', 'src/assets/data.sqlite', 'src/assets/private.key', 'src/assets/certificate.pfx', 'src/assets/credentials.json', '.git/config', '.npmrc', 'node_modules/pkg/index.js', '.angular/cache/data', 'dist/index.html', 'src/assets/id_rsa']) {
    test(`exclusion policy: ${relative}`, () => assert.notEqual(exclusionReason(relative), null));
}
test('spaces, Unicode, quotes and shell metacharacters are treated as names', () => {
    for (const name of ['src/assets/área musical.txt', 'src/assets/$(not-a-command).txt', 'src/assets/quote";`name.txt', 'src/assets/[file]#%.txt']) assert.equal(safeGitPath(name), name);
});
test('reject traversal, absolute names, controls, backslashes and portable collisions', () => {
    for (const value of ['../x', '/etc/file', 'src/../x', 'src//x', 'src/x\\y', 'src/a:b', 'src/line\nname', 'src/tab\tname', 'src/nul.txt', 'src/trailing.']) assert.throws(() => safeGitPath(value), { code: 'UNSAFE_GIT_PATH' });
    const entries = [{ name: 'A', mode: '100644', oid: 'a'.repeat(40) }, { name: 'a', mode: '100644', oid: 'b'.repeat(40) }];
    assert.throws(() => parseTree(treeBytes(entries)), { code: 'PATH_COLLISION' });
    assert.throws(() => parseTree(treeBytes([{ ...entries[0], name: 'é' }, { ...entries[1], name: 'e\u0301' }])), { code: 'PATH_COLLISION' });
});
test('Git object verification is based on typed raw bytes, not a caller receipt', () => {
    const object = rawObject('blob', 'fictional');
    assert.equal(verifyObject(object.oid, 'blob', object.bytes).oid, object.oid);
    assert.throws(() => verifyObject(object.oid, 'commit', object.bytes), { code: 'GIT_OBJECT_HASH_MISMATCH' });
    assert.throws(() => verifyObject(object.oid, 'blob', Buffer.from('changed')), { code: 'GIT_OBJECT_HASH_MISMATCH' });
});
test('malformed tree bytes, invalid UTF-8, unsupported type and ordering are refused', () => {
    assert.throws(() => parseTree(Buffer.from('100644 missing-null')), { code: 'TREE_INVALID' });
    assert.throws(() => parseTree(Buffer.concat([Buffer.from('100644 '), Buffer.from([0xff, 0]), Buffer.alloc(20)])), { code: 'INVALID_UTF8_PATH' });
    assert.throws(() => parseTree(Buffer.concat([Buffer.from('100664 file\0'), Buffer.alloc(20)])), { code: 'GIT_TYPE_UNSUPPORTED' });
    const a = treeBytes([{ name: 'z', mode: '100644', oid: 'a'.repeat(40) }]), b = treeBytes([{ name: 'a', mode: '100644', oid: 'b'.repeat(40) }]);
    assert.throws(() => parseTree(Buffer.concat([a, b])), { code: 'TREE_ORDER_INVALID' });
});

test('valid commit exports exact Git bytes with hashes, modes and independent verification', linux, async t => {
    const f = await fixture(t, { 'server.js': '// fiction', 'src/assets/área $(literal) "quote".txt': Buffer.from([0, 1, 255, 9]), 'src/services/executable.js': { bytes: '// not executed', mode: '100755' } });
    const result = await f.run();
    assert.equal(result.record.commitSha, f.commit.oid); assert.equal(result.record.treeSha, f.commit.tree);
    assert.equal(result.record.provenance.remoteVerified, false);
    for (const file of result.record.files) {
        const bytes = await fs.readFile(`${result.source}/${file.path}`);
        assert.deepEqual(bytes, f.repo.objects.get(file.gitBlobSha).bytes);
        assert.equal(digest(bytes), file.sha256); assert.equal((await fs.stat(`${result.source}/${file.path}`)).mode & 0o777, file.mode);
    }
    assert.deepEqual(await verifyExport({ workspace: f.workspace, exportId: result.record.exportId }), result.record);
});
test('full SHA, commit type and local existence are mandatory', linux, async t => {
    const f = await fixture(t);
    for (const commitSha of ['main', 'HEAD', f.commit.oid.slice(0, 7), '../outside', 'A'.repeat(40)]) await assert.rejects(f.run({ commitSha }), { code: 'INVALID_COMMIT_SHA' });
    await assert.rejects(f.run({ commitSha: 'f'.repeat(40) }), { code: 'GIT_OBJECT_MISSING' });
    await assert.rejects(f.run({ commitSha: f.commit.tree }), { code: 'COMMIT_TYPE_REQUIRED' });
});
test('ancestor commit is accepted, unrelated commit and wrong approved main are refused', linux, async t => {
    const f = await fixture(t), newer = await f.repo.commit({ 'server.js': '// newer fixture' }, [f.commit.oid]);
    const result = await f.run({ approvedMainSha: newer.oid }); assert.equal(await fs.readFile(`${result.source}/server.js`, 'utf8'), '// fictional source, never executed\n');
    const unrelated = await f.repo.commit({ 'server.js': '// unrelated' });
    await assert.rejects(f.run({ approvedMainSha: unrelated.oid }), { code: 'COMMIT_NOT_IN_APPROVED_MAIN' });
    await assert.rejects(f.run({ approvedMainSha: newer.oid }), { code: 'MAIN_REFERENCE_CHANGED' });
});
test('protected tracked blobs and excluded subtrees are not read, even if absent/corrupt', linux, async t => {
    const f = await fixture(t, { 'server.js': '// authorized fiction', '.env': 'FICTIONAL_EXCLUDED_LABEL', 'istbrasil.private/fiction.pdf': 'fictional private placeholder', 'html/index.html': 'fictional old publication', 'sample.session.sql': 'fictional session placeholder', 'src/assets/credentials.json': 'fictional protected marker', '.gitignore': '.env\n' });
    const envOid = f.commit.blobs.get('.env');
    await fs.unlink(f.repo.objectFile(envOid)); // exported subset must never request it
    const privateOid = f.commit.blobs.get('istbrasil.private/fiction.pdf');
    await fs.writeFile(f.repo.objectFile(privateOid), Buffer.from('not zlib'));
    const originalOpen = fs.open, forbidden = new Set([envOid, privateOid, f.commit.blobs.get('html/index.html'), f.commit.blobs.get('sample.session.sql'), f.commit.blobs.get('src/assets/credentials.json')].map(oid => f.repo.objectFile(oid)));
    t.mock.method(fs, 'open', async (filename, ...args) => { assert.ok(!forbidden.has(filename), 'protected blob requested'); return originalOpen(filename, ...args); });
    const result = await f.run();
    assert.deepEqual(result.record.files.map(file => file.path), ['server.js']);
    assert.ok(result.record.excluded.some(entry => entry.path === 'istbrasil.private' && entry.type === 'tree'));
    assert.ok(!JSON.stringify(result.record).includes('FICTIONAL_EXCLUDED_LABEL'));
    await verifyExport({ workspace: f.workspace, exportId: result.record.exportId });
});
for (const [name, target] of [['commit', f => f.commit.oid], ['tree', f => f.commit.tree], ['blob', f => f.commit.blobs.get('server.js')]]) {
    test(`missing ${name} object fails closed`, linux, async t => {
        const f = await fixture(t); await fs.unlink(f.repo.objectFile(target(f)));
        await assert.rejects(f.run(), { code: 'GIT_OBJECT_MISSING' });
    });
    test(`corrupt ${name} object fails closed`, linux, async t => {
        const f = await fixture(t); await fs.writeFile(f.repo.objectFile(target(f)), Buffer.from('corrupt fixture'));
        await assert.rejects(f.run(), { code: 'GIT_OBJECT_CORRUPT' });
    });
}
test('valid zlib with substituted bytes fails Git OID verification', linux, async t => {
    const f = await fixture(t), oid = f.commit.blobs.get('server.js');
    await fs.writeFile(f.repo.objectFile(oid), deflateSync(rawObject('blob', 'substituted fixture').raw));
    await assert.rejects(f.run(), { code: 'GIT_OBJECT_HASH_MISMATCH' });
});
for (const [mode, code] of [['120000', 'LINK_UNAPPROVED'], ['160000', 'SUBMODULE_UNSUPPORTED']]) test(`Git entry ${mode} cannot be exported or followed`, linux, async t => {
    const f = await fixture(t), blob = await f.repo.put('blob', '/fictional/outside-target');
    const tree = await f.repo.put('tree', treeBytes([{ name: 'server.js', oid: blob, mode }]));
    const commit = await f.repo.makeCommit(tree); await f.repo.main(commit);
    await assert.rejects(f.run({ commitSha: commit, approvedMainSha: commit }), { code });
});
test('malicious Git tree paths and Unicode/case collisions are rejected before blob reads', linux, async t => {
    const f = await fixture(t), oid = await f.repo.put('blob', 'fictional collision');
    for (const entries of [
        [{ name: '../outside', mode: '100644', oid }], [{ name: '/outside', mode: '100644', oid }],
        [{ name: 'server.js', mode: '100644', oid }, { name: 'SERVER.js', mode: '100644', oid }]
    ]) {
        const tree = await f.repo.put('tree', treeBytes(entries)), commit = await f.repo.makeCommit(tree); await f.repo.main(commit);
        await assert.rejects(f.run({ commitSha: commit, approvedMainSha: commit }));
    }
});
test('branch movement during export aborts without following the new main', linux, async t => {
    const f = await fixture(t), other = await f.repo.makeCommit(f.commit.tree, [f.commit.oid]), originalOpen = fs.open;
    let changed = false;
    t.mock.method(fs, 'open', async (filename, ...args) => {
        if (!changed && filename === f.repo.objectFile(f.commit.blobs.get('server.js'))) { changed = true; await f.repo.main(other); }
        return originalOpen(filename, ...args);
    });
    await assert.rejects(f.run(), { code: 'MAIN_REFERENCE_CHANGED' });
    for (const id of await fs.readdir(`${f.workspace}/exports`)) await assert.rejects(fs.lstat(`${f.workspace}/exports/${id}/COMPLETE.json`), { code: 'ENOENT' });
});
test('modified worktree and gitignore cannot influence exported bytes/policy', linux, async t => {
    const f = await fixture(t, { 'server.js': '// committed fixture', '.env': 'FICTIONAL_LABEL' });
    await fs.writeFile(`${f.workspace}/repository/server.js`, '// uncommitted fixture');
    await fs.writeFile(`${f.workspace}/repository/.gitignore`, 'server.js\n');
    const before = await snapshot(`${f.workspace}/repository`), result = await f.run();
    assert.equal(await fs.readFile(`${result.source}/server.js`, 'utf8'), '// committed fixture');
    assert.deepEqual(await snapshot(`${f.workspace}/repository`), before);
});
test('exported content corruption, additions and symlink substitution block verification', linux, async t => {
    const f = await fixture(t), result = await f.run();
    await fs.writeFile(`${result.source}/server.js`, '// changed');
    await assert.rejects(verifyExport({ workspace: f.workspace, exportId: result.record.exportId }), { code: 'EXPORT_CONTENT_MISMATCH' });
    await fs.writeFile(`${result.source}/server.js`, f.repo.objects.get(f.commit.blobs.get('server.js')).bytes);
    await fs.writeFile(`${result.source}/unexpected`, 'fiction');
    await assert.rejects(verifyExport({ workspace: f.workspace, exportId: result.record.exportId }), { code: 'EXPORT_INVENTORY_MISMATCH' });
    await fs.unlink(`${result.source}/unexpected`); await fs.unlink(`${result.source}/server.js`); await fs.symlink('/fictional/outside', `${result.source}/server.js`);
    await assert.rejects(verifyExport({ workspace: f.workspace, exportId: result.record.exportId }), { code: 'WORKSPACE_UNSAFE' });
});
test('recomputed receipts cannot replace Git provenance with different payload bytes', linux, async t => {
    const f = await fixture(t), result = await f.run(), bytes = Buffer.from('// substituted fixture');
    const file = result.record.files.find(file => file.path === 'server.js');
    await fs.writeFile(`${result.source}/server.js`, bytes); file.size = bytes.length; file.sha256 = digest(bytes); file.gitBlobSha = rawObject('blob', bytes).oid;
    await reseal(result.destination, result.record);
    await assert.rejects(verifyExport({ workspace: f.workspace, exportId: result.record.exportId }), { code: 'EXPORT_PROVENANCE_MISMATCH' });
});
test('export policy/exclusions and metadata fields cannot be forged by resealing', linux, async t => {
    const f = await fixture(t, { 'server.js': '// fixture', '.env': 'FICTIONAL_EXCLUDED_LABEL' }), result = await f.run();
    result.record.excluded = []; await reseal(result.destination, result.record);
    await assert.rejects(verifyExport({ workspace: f.workspace, exportId: result.record.exportId }), { code: 'EXPORT_PROVENANCE_MISMATCH' });
    result.record.unexpected = 'fictional'; await reseal(result.destination, result.record);
    await assert.rejects(verifyExport({ workspace: f.workspace, exportId: result.record.exportId }), { code: 'EXPORT_RECORD_INVALID' });
});
test('workspace must be private, canonical, temporary and owned by non-root', linux, async t => {
    const f = await fixture(t);
    await assert.rejects(requireExportWorkspace('/var/www/fictional'), { code: 'WORKSPACE_NOT_ISOLATED' });
    await fs.chmod(f.workspace, 0o755); await assert.rejects(f.run(), { code: 'WORKSPACE_UNSAFE' }); await fs.chmod(f.workspace, 0o700);
    await fs.writeFile(`${f.workspace}/ISOLATED.json`, '{}'); await assert.rejects(f.run(), { code: 'WORKSPACE_MARKER_INVALID' });
});
test('TMPDIR cannot redirect workspace creation into production or another arbitrary path', linux, async t => {
    t.mock.method(os, 'tmpdir', () => '/var/www/fictional-production');
    await assert.rejects(createExportWorkspace(), { code: 'WORKSPACE_TMP_UNSAFE' });
});
test('external Git storage, partial repositories and config indirection are refused', linux, async t => {
    const f = await fixture(t);
    for (const name of ['shallow', 'commondir', 'objects/info/alternates', 'objects/info/http-alternates']) {
        const filename = `${f.repo.git}/${name}`; await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 }); await fs.writeFile(filename, 'fictional', { mode: 0o600 });
        await assert.rejects(f.run(), { code: 'REPOSITORY_EXTERNAL_OR_PARTIAL' }); await fs.unlink(filename);
    }
    await fs.writeFile(`${f.repo.git}/config`, '[include]\npath = /fictional/outside\n');
    await assert.rejects(f.run(), { code: 'REPOSITORY_CONFIG_UNSUPPORTED' });
});
test('symlinked Git storage is refused without reading its destination', linux, async t => {
    const f = await fixture(t), objectFile = f.repo.objectFile(f.commit.blobs.get('server.js'));
    await fs.unlink(objectFile); await fs.symlink('/fictional/outside', objectFile);
    await assert.rejects(f.run(), { code: 'REPOSITORY_UNSAFE' });
});
test('a blob shared with an excluded path is conservatively refused', linux, async t => {
    const f = await fixture(t, { 'server.js': 'fictional shared bytes', '.env': 'fictional shared bytes' });
    await assert.rejects(f.run(), { code: 'OBJECT_SHARED_WITH_EXCLUDED_PATH' });
});
test('existing lock, including an abandoned lock, is never removed automatically', linux, async t => {
    const f = await fixture(t), filename = `${f.workspace}/EXPORT.lock`;
    await fs.writeFile(filename, JSON.stringify({ pid: 999999, token: randomUUID() }), { mode: 0o600 });
    const before = await fs.readFile(filename); await assert.rejects(f.run(), { code: 'EXPORT_LOCK_EXISTS' }); assert.deepEqual(await fs.readFile(filename), before);
});
test('concurrent exports in the same workspace cannot mutate each other', linux, async t => {
    const f = await fixture(t), originalOpen = fs.open;
    let entered, release;
    const ready = new Promise(resolve => entered = resolve), gate = new Promise(resolve => release = resolve);
    let held = false;
    t.mock.method(fs, 'open', async (filename, ...args) => {
        if (!held && filename === f.repo.objectFile(f.commit.oid)) { held = true; entered(); await gate; }
        return originalOpen(filename, ...args);
    });
    const first = f.run(); await ready;
    try { await assert.rejects(f.run(), { code: 'EXPORT_LOCK_EXISTS' }); }
    finally { release(); }
    await first;
});
test('failed copy leaves no completion seal and preserves the original error', linux, async t => {
    const f = await fixture(t), originalOpen = fs.open, original = Object.assign(new Error('FICTIONAL_IO_FAILURE'), { code: 'ENOSPC' });
    t.mock.method(fs, 'open', async (filename, flags, ...args) => {
        if (String(filename).includes('/exports/') && String(filename).endsWith('/source/server.js') && flags & fs.constants.O_CREAT) throw original;
        return originalOpen(filename, flags, ...args);
    });
    await assert.rejects(f.run(), error => error === original);
    for (const id of await fs.readdir(`${f.workspace}/exports`)) await assert.rejects(verifyExport({ workspace: f.workspace, exportId: id }), { code: 'EXPORT_INCOMPLETE' });
});
test('uncertain final seal retains the lock and cannot be treated as confirmed', linux, async t => {
    const f = await fixture(t), originalOpen = fs.open;
    t.mock.method(fs, 'open', async (filename, flags, ...args) => {
        if (String(filename).endsWith('/COMPLETE.json') && flags & fs.constants.O_CREAT) throw Object.assign(new Error('fictional seal failure'), { code: 'EIO' });
        return originalOpen(filename, flags, ...args);
    });
    await assert.rejects(f.run(), { code: 'EIO' }); assert.ok(await fs.lstat(`${f.workspace}/EXPORT.lock`));
    const ids = await fs.readdir(`${f.workspace}/exports`); await assert.rejects(verifyExport({ workspace: f.workspace, exportId: ids[0] }), { code: 'EXPORT_UNCONFIRMED' });
});
test('only the workspace is written; source repository and outside sentinel are unchanged', linux, async t => {
    const f = await fixture(t), outside = await fs.mkdtemp(path.join(os.tmpdir(), 'ist-export-outside-'));
    t.after(() => fs.rm(outside, { recursive: true, force: true }));
    await fs.writeFile(`${outside}/sentinel`, 'fictional untouched sentinel');
    const outsideBefore = await snapshot(outside), sourceBefore = await snapshot(`${f.workspace}/repository`), originalOpen = fs.open;
    t.mock.method(fs, 'open', async (filename, flags, ...args) => {
        if (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC)) assert.ok(String(filename).startsWith(`${f.workspace}/`), 'write outside workspace');
        return originalOpen(filename, flags, ...args);
    });
    await f.run();
    assert.deepEqual(await snapshot(outside), outsideBefore); assert.deepEqual(await snapshot(`${f.workspace}/repository`), sourceBefore);
});
test('environment inputs are exported as committed without generating files or changing PayPal', linux, async t => {
    const prod = 'export const environment = { production: true, apiUrl: "/api" };\n';
    const f = await fixture(t, { 'server.js': '// fixture', 'src/environments/environment.prod.ts': prod }), result = await f.run();
    assert.equal(await fs.readFile(`${result.source}/src/environments/environment.prod.ts`, 'utf8'), prod);
    await assert.rejects(fs.lstat(`${result.source}/src/environments/environment.ts`), { code: 'ENOENT' });
});
test('packed main reference works without moving main or HEAD', linux, async t => {
    const f = await fixture(t); await fs.writeFile(`${f.repo.git}/packed-refs`, `# pack-refs with: peeled fully-peeled sorted\n${f.commit.oid} refs/heads/main\n`, { mode: 0o600 }); await fs.unlink(`${f.repo.git}/refs/heads/main`);
    const before = await snapshot(`${f.workspace}/repository`); await f.run(); assert.deepEqual(await snapshot(`${f.workspace}/repository`), before);
});
test('native Git independently recognizes the generated fixture format when available', async t => {
    if (!nativeGit) { t.skip('Native Git unavailable; independent CLI format cross-check not executed'); return; }
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ist-git-format-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const repo = await repository(root), commit = await repo.commit({ 'server.js': '// independent fixture' });
    const args = [`--git-dir=${repo.git}`, 'cat-file'];
    const options = { cwd: root, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: root, USERPROFILE: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_NO_REPLACE_OBJECTS: '1', GIT_ALLOW_PROTOCOL: '' } };
    for (const packed of [false, true]) {
        if (packed) await packRepository(repo);
        assert.equal(execFileSync('git', [...args, '-t', commit.oid], { ...options, encoding: 'utf8' }).trim(), 'commit');
        assert.deepEqual(execFileSync('git', [...args, 'tree', commit.tree], options), repo.objects.get(commit.tree).bytes);
        assert.deepEqual(execFileSync('git', [...args, 'blob', commit.blobs.get('server.js')], options), Buffer.from('// independent fixture'));
    }
});

test('packed objects are read through native Git and retain byte-level verification', linux, async t => {
    if (!nativeGit) { t.skip('Native Git required for packed-object support'); return; }
    const f = await fixture(t); await packRepository(f.repo);
    const before = await snapshot(`${f.workspace}/repository`);
    const result = await f.run();
    assert.equal(await fs.readFile(`${result.source}/server.js`, 'utf8'), '// fictional source, never executed\n');
    await verifyExport({ workspace: f.workspace, exportId: result.record.exportId });
    assert.deepEqual(await snapshot(`${f.workspace}/repository`), before);
});
test('policy excludes protected packed blobs before requesting their content', linux, async t => {
    if (!nativeGit) { t.skip('Native Git required for packed-object support'); return; }
    const f = await fixture(t, { 'server.js': '// fictional allowed', '.env': 'fictional protected marker' }); await packRepository(f.repo);
    const result = await f.run();
    assert.equal(await fs.readFile(`${result.source}/server.js`, 'utf8'), '// fictional allowed');
    assert.ok(result.record.excluded.some(entry => entry.path === '.env' && entry.reason === 'ENVIRONMENT_FILE'));
    assert.ok(!JSON.stringify(result.record).includes('fictional protected marker'));
});
test('trailing compressed bytes, malformed headers and malformed main refs fail closed', linux, async t => {
    const f = await fixture(t), filename = f.repo.objectFile(f.commit.blobs.get('server.js')), original = await fs.readFile(filename);
    await fs.writeFile(filename, Buffer.concat([original, Buffer.from('trailing')])); await assert.rejects(f.run(), { code: 'GIT_OBJECT_CORRUPT' });
    await fs.writeFile(filename, original); await fs.writeFile(`${f.repo.git}/refs/heads/main`, `${f.commit.oid} `); await assert.rejects(f.run(), { code: 'MAIN_REFERENCE_INVALID' });
});
test('exporter remains disconnected from application, deploy, backup and diagnostics', async () => {
    const source = await fs.readFile(new URL('../scripts/deploy/git-export.mjs', import.meta.url), 'utf8');
    assert.ok(!/^import .*['"].*(?:server\.js|db\.js|backup\.mjs|state\.mjs|production-inspect\.mjs)['"]/m.test(source));
    const deploy = await fs.readFile(new URL('../deploy.sh', import.meta.url), 'utf8');
    assert.ok(!deploy.includes('git-export.mjs')); assert.match(deploy, /DEPLOY DISABLED/); assert.match(deploy, /Rollback unavailable/);
});
