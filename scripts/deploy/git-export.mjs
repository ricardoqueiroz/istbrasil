// Phase 2.2-A: verified local Git objects -> isolated test workspace only.
// No application execution, remote access, production paths or Phase 1 imports.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { spawn } from 'node:child_process';
const SHA = /^[a-f0-9]{40}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const FORMAT = 'ist-git-export-test-v1';
const MAX_OBJECT = 64 * 1024 * 1024;
const MAX_FILES = 250000;
const MAX_HISTORY = 10000;
const MAX_BYTES = 2 * 1024 ** 3;
const hash = (data, algorithm = 'sha256') => createHash(algorithm).update(data).digest('hex');
const fail = code => Object.assign(new Error(code), { code });
const requireSha = value => { if (typeof value !== 'string' || !SHA.test(value)) throw fail('INVALID_COMMIT_SHA'); return value; };
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => plain(value) && Object.keys(value).sort().join('|') === [...keys].sort().join('|');
const same = (a, b) => ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'mode', 'uid', 'gid'].every(key => a[key] === b[key]);
const utf8 = data => { try { return new TextDecoder('utf-8', { fatal: true }).decode(data); } catch { throw fail('INVALID_UTF8_PATH'); } };

export const EXPORT_POLICY = Object.freeze({
    id: 'ist-source-export-v1',
    rootFiles: Object.freeze(['server.js', 'package.json', 'package-lock.json', 'angular.json', 'tsconfig.json', 'tsconfig.app.json', 'tsconfig.spec.json', '.postcssrc.json', '.gitattributes', 'LICENSE.md', 'README.md']),
    roots: Object.freeze(['src', 'public']),
    sourceDirectories: Object.freeze(['app', 'assets', 'environments', 'config', 'controllers', 'middlewares', 'routes', 'services']),
    sourceFiles: Object.freeze(['main.ts', 'index.html', 'styles.scss', 'app.component.ts', 'app.config.ts', 'app.routes.ts', 'page-flip.d.ts']),
    protectedComponents: Object.freeze(['html', 'istbrasil.private', 'uploads', 'backend-php', 'database', 'development', 'dump', 'dumps', 'backup', 'backups', 'credentials', 'secrets', '.git', '.npmrc', '.pypirc', '.ssh', '.aws', '.pm2', '.deploy', 'node_modules', '.angular', 'cache', 'caches', 'dist', 'build', 'out-tsc', 'tmp', 'coverage', 'id_rsa', 'id_ecdsa', 'id_ed25519', 'authorized_keys', 'passwd', 'shadow']),
    protectedSuffixes: Object.freeze(['.sql', '.dump', '.db', '.sqlite', '.sqlite3', '.bak', '.backup', '.pem', '.key', '.p12', '.pfx', '.der', '.jks', '.keystore']),
    links: 'reject-all', caseCollisions: 'NFC-lowercase', missingOptionalInputs: 'do-not-generate',
});
export const POLICY_SHA256 = hash(JSON.stringify(EXPORT_POLICY));

export function safeGitPath(value) {
    if (typeof value !== 'string' || !value || value.length > 4096 || /[\x00-\x1f\x7f\\:]/.test(value) || path.posix.isAbsolute(value)
        || value.split('/').some(component => !component || component === '.' || component === '..' || component.endsWith('.') || component.endsWith(' ')
            || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(component))) throw fail('UNSAFE_GIT_PATH');
    return value;
}

export function exclusionReason(relative) {
    safeGitPath(relative);
    const components = relative.split('/').map(component => component.toLowerCase());
    if (components.some(component => component.startsWith('.env'))) return 'ENVIRONMENT_FILE';
    if (components.some(component => EXPORT_POLICY.protectedComponents.includes(component))) return 'PROTECTED_COMPONENT';
    const basename = components.at(-1);
    if (EXPORT_POLICY.protectedSuffixes.some(suffix => basename.endsWith(suffix)) || /(?:credentials?|secrets?)(?:[._-]|$)/i.test(basename)) return 'PROTECTED_FILE';
    if (EXPORT_POLICY.rootFiles.includes(relative) || EXPORT_POLICY.roots.includes(relative)) return null;
    if (relative.startsWith('public/')) return null;
    if (relative.startsWith('src/')) {
        const parts = relative.split('/');
        if (EXPORT_POLICY.sourceFiles.includes(parts.slice(1).join('/')) || EXPORT_POLICY.sourceDirectories.includes(parts[1])) return null;
    }
    return 'NOT_BUILD_INPUT';
}

export function verifyObject(oid, type, bytes) {
    if (!SHA.test(oid) || !['commit', 'tree', 'blob'].includes(type) || !Buffer.isBuffer(bytes) || bytes.length > MAX_OBJECT) throw fail('GIT_OBJECT_INVALID');
    const header = Buffer.from(`${type} ${bytes.length}\0`);
    if (hash(Buffer.concat([header, bytes]), 'sha1') !== oid) throw fail('GIT_OBJECT_HASH_MISMATCH');
    return { oid, type, bytes };
}

export function parseTree(bytes) {
    const entries = [], names = new Set();
    let offset = 0, previous = null;
    while (offset < bytes.length) {
        const space = bytes.indexOf(0x20, offset), end = bytes.indexOf(0, space + 1);
        if (space <= offset || end < space + 2 || end + 21 > bytes.length) throw fail('TREE_INVALID');
        const mode = bytes.subarray(offset, space).toString('latin1');
        if (!['40000', '100644', '100755', '120000', '160000'].includes(mode)) throw fail('GIT_TYPE_UNSUPPORTED');
        const nameBytes = bytes.subarray(space + 1, end), name = utf8(nameBytes);
        safeGitPath(name);
        if (name.includes('/')) throw fail('TREE_INVALID');
        const collision = name.normalize('NFC').toLowerCase();
        if (names.has(collision)) throw fail('PATH_COLLISION');
        names.add(collision);
        const order = Buffer.concat([nameBytes, mode === '40000' ? Buffer.from('/') : Buffer.alloc(0)]);
        if (previous && Buffer.compare(previous, order) >= 0) throw fail('TREE_ORDER_INVALID');
        previous = order;
        entries.push({ name, mode, oid: bytes.subarray(end + 1, end + 21).toString('hex') });
        if (entries.length > MAX_FILES) throw fail('TREE_LIMIT_EXCEEDED');
        offset = end + 21;
    }
    return entries;
}

export function parseCommit(bytes) {
    const end = bytes.indexOf(Buffer.from('\n\n'));
    if (end < 0) throw fail('COMMIT_INVALID');
    // Commit messages/identities never enter diagnostics or export records.
    const headers = bytes.subarray(0, end).toString('utf8').split('\n');
    const trees = headers.filter(line => line.startsWith('tree '));
    const parents = headers.filter(line => line.startsWith('parent ')).map(line => line.slice(7));
    if (trees.length !== 1 || !SHA.test(trees[0].slice(5)) || parents.some(parent => !SHA.test(parent))) throw fail('COMMIT_INVALID');
    return { tree: trees[0].slice(5), parents };
}

function requireLinuxUser() {
    if (process.platform !== 'linux' || typeof process.getuid !== 'function' || process.getuid() === 0) throw fail('LINUX_NON_ROOT_REQUIRED');
}

async function temporaryParent() {
    if (!['/tmp', '/var/tmp'].includes(os.tmpdir())) throw fail('WORKSPACE_TMP_UNSAFE');
    const parent = await fs.realpath(os.tmpdir());
    if (!['/tmp', '/var/tmp'].includes(parent)) throw fail('WORKSPACE_TMP_UNSAFE');
    const stat = await fs.lstat(parent);
    if (!stat.isDirectory() || ![0, process.getuid()].includes(stat.uid) || stat.mode & 0o6000
        || stat.mode & 0o022 && !(stat.uid === 0 && stat.mode & 0o1000)) throw fail('WORKSPACE_TMP_UNSAFE');
    return parent;
}

async function privateStat(filename, directory = false, mode = directory ? 0o700 : 0o600) {
    const stat = await fs.lstat(filename);
    if (stat.isSymbolicLink() || !(directory ? stat.isDirectory() : stat.isFile()) || !directory && stat.nlink !== 1
        || stat.uid !== process.getuid() || stat.gid !== process.getgid() || (stat.mode & 0o7777) !== mode) throw fail('WORKSPACE_UNSAFE');
    return stat;
}

async function regularRead(filename, limit = MAX_OBJECT + 4096) {
    await containedParents(filename);
    const before = await fs.lstat(filename);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.uid !== process.getuid() || before.mode & 0o7022 || before.size > limit) throw fail('LOCAL_FILE_UNSAFE');
    const handle = await fs.open(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
        if (!same(before, await handle.stat())) throw fail('SOURCE_CHANGED');
        const bytes = await handle.readFile();
        if (!same(before, await handle.stat()) || !same(before, await fs.lstat(filename))) throw fail('SOURCE_CHANGED');
        return bytes;
    } finally { await handle.close(); }
}

async function containedParents(filename) {
    const temporary = await temporaryParent();
    const relative = path.relative(temporary, filename), first = relative.split(path.sep)[0];
    if (relative.startsWith('..') || !/^ist-git-export-[A-Za-z0-9]+$/.test(first) || path.resolve(filename) !== filename) throw fail('WORKSPACE_NOT_ISOLATED');
    const root = `${temporary}/${first}`;
    for (let parent = path.dirname(filename), depth = 0; ; parent = path.dirname(parent)) {
        const stat = await fs.lstat(parent);
        if (++depth > 128 || !stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.mode & 0o7022) throw fail('WORKSPACE_UNSAFE');
        if (parent === root) { if ((stat.mode & 0o7777) !== 0o700) throw fail('WORKSPACE_UNSAFE'); break; }
        if (parent === temporary) throw fail('WORKSPACE_NOT_ISOLATED');
    }
}

export async function createExportWorkspace() {
    requireLinuxUser();
    const parent = await temporaryParent();
    const root = await fs.mkdtemp(path.join(parent, 'ist-git-export-'));
    await fs.chmod(root, 0o700);
    for (const name of ['repository', 'exports']) await fs.mkdir(`${root}/${name}`, { mode: 0o700 });
    await fs.writeFile(`${root}/ISOLATED.json`, JSON.stringify({ format: FORMAT }), { flag: 'wx', mode: 0o600 });
    return root;
}

export async function requireExportWorkspace(root) {
    requireLinuxUser();
    if (typeof root !== 'string' || path.resolve(root) !== root || path.dirname(root) !== await temporaryParent() || !/^ist-git-export-[A-Za-z0-9]+$/.test(path.basename(root))) throw fail('WORKSPACE_NOT_ISOLATED');
    await privateStat(root, true);
    if (await fs.realpath(root) !== root) throw fail('WORKSPACE_UNSAFE');
    await privateStat(`${root}/ISOLATED.json`);
    if ((await regularRead(`${root}/ISOLATED.json`, 4096)).toString('utf8') !== JSON.stringify({ format: FORMAT })) throw fail('WORKSPACE_MARKER_INVALID');
    for (const name of ['repository', 'exports']) await privateStat(`${root}/${name}`, true);
    return root;
}

async function validateRepository(root) {
    await requireExportWorkspace(root);
    const git = `${root}/repository/.git`;
    const visit = async (filename, count = { value: 0 }, depth = 0) => {
        const stat = await fs.lstat(filename);
        if (++count.value > MAX_FILES || depth > 32 || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.mode & 0o7022 || !stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1)) throw fail('REPOSITORY_UNSAFE');
        if (stat.isDirectory()) for (const child of await fs.readdir(filename)) await visit(`${filename}/${child}`, count, depth + 1);
    };
    await visit(git);
    for (const name of ['commondir', 'shallow', 'objects/info/alternates', 'objects/info/http-alternates']) {
        try { await fs.lstat(`${git}/${name}`); throw fail('REPOSITORY_EXTERNAL_OR_PARTIAL'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    // Reject config indirection/promisors before any Git CLI could be used.
    try {
        const config = (await regularRead(`${git}/config`, 1024 * 1024)).toString('utf8');
        if (/^\s*\[\s*(include|includeif|extensions)\b/im.test(config) || /^\s*(promisor|partialclone|alternaterefscommand)\s*=/im.test(config)) throw fail('REPOSITORY_CONFIG_UNSUPPORTED');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return git;
}

async function mainSnapshot(git, expected) {
    requireSha(expected);
    const head = (await regularRead(`${git}/HEAD`, 4096)).toString('latin1');
    if (!/^ref: refs\/heads\/main\n?$/.test(head)) throw fail('MAIN_REFERENCE_INVALID');
    let actual;
    try {
        const reference = (await regularRead(`${git}/refs/heads/main`, 4096)).toString('latin1');
        if (!/^[a-f0-9]{40}\n?$/.test(reference)) throw fail('MAIN_REFERENCE_INVALID');
        actual = reference.replace(/\n$/, '');
    }
    catch (error) {
        if (error.code !== 'ENOENT') throw error;
        const lines = (await regularRead(`${git}/packed-refs`, 8 * 1024 * 1024)).toString('latin1').split('\n');
        const matches = lines.filter(line => /^[a-f0-9]{40} refs\/heads\/main$/.test(line));
        if (matches.length !== 1) throw fail('MAIN_REFERENCE_INVALID');
        actual = matches[0].slice(0, 40);
    }
    if (!SHA.test(actual) || actual !== expected) throw fail('MAIN_REFERENCE_CHANGED');
    return actual;
}

function objectReader(git) {
    const gitEnvironment = root => ({
        PATH: '/usr/bin:/bin',
        HOME: root,
        LANG: 'C', LC_ALL: 'C',
        GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0',
        GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: '',
        GIT_CONFIG_COUNT: '0',
    });
    const readPacked = async oid => {
        const stdout = await new Promise((resolve, reject) => {
            const child = spawn('git', ['--no-replace-objects', `--git-dir=${git}`, '-c', 'core.useReplaceRefs=false', 'cat-file', '--batch'], {
                cwd: path.dirname(git), env: gitEnvironment(path.dirname(git)), shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
            });
            const chunks = []; let length = 0, stderrLength = 0;
            child.stdout.on('data', chunk => { length += chunk.length; if (length > MAX_OBJECT + 4096) child.kill(); else chunks.push(chunk); });
            child.stderr.on('data', chunk => { stderrLength += chunk.length; if (stderrLength > 64 * 1024) child.kill(); });
            child.on('error', error => reject(error.code === 'ENOENT' ? fail('GIT_CLI_REQUIRED') : fail('GIT_OBJECT_MISSING_OR_CORRUPT')));
            child.on('close', code => code === 0 && length <= MAX_OBJECT + 4096 ? resolve(Buffer.concat(chunks)) : reject(fail('GIT_OBJECT_MISSING_OR_CORRUPT')));
            child.stdin.end(`${oid}\n`);
        });
        const lineEnd = stdout.indexOf(0x0a);
        if (lineEnd < 0) throw fail('GIT_OBJECT_INVALID');
        const header = stdout.subarray(0, lineEnd).toString('latin1');
        if (header === `${oid} missing`) throw fail('GIT_OBJECT_MISSING');
        const match = /^([a-f0-9]{40}) (commit|tree|blob) (0|[1-9]\d*)$/.exec(header);
        if (!match || match[1] !== oid) throw fail('GIT_OBJECT_INVALID');
        const size = Number(match[3]), body = stdout.subarray(lineEnd + 1);
        if (!Number.isSafeInteger(size) || size > MAX_OBJECT || body.length !== size + 1 || body.at(-1) !== 0x0a) throw fail('GIT_OBJECT_INVALID');
        return verifyObject(oid, match[2], body.subarray(0, size));
    };
    return async oid => {
        requireSha(oid);
        const filename = `${git}/objects/${oid.slice(0, 2)}/${oid.slice(2)}`;
        let raw;
        try {
            const compressed = await regularRead(filename);
            try {
                const inflated = inflateSync(compressed, { maxOutputLength: MAX_OBJECT + 128, info: true });
                if (inflated.engine.bytesWritten !== compressed.length) throw fail('GIT_OBJECT_CORRUPT');
                raw = inflated.buffer;
            }
            catch { throw fail('GIT_OBJECT_CORRUPT'); }
            const end = raw.indexOf(0), header = raw.subarray(0, end).toString('latin1');
            const match = /^(commit|tree|blob) (0|[1-9]\d*)$/.exec(header);
            if (end < 0 || !match || Number(match[2]) !== raw.length - end - 1) throw fail('GIT_OBJECT_INVALID');
            return verifyObject(oid, match[1], raw.subarray(end + 1));
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
        // Policy traversal decides whether a blob is authorized before this reader
        // is called. Native Git may internally decode delta bases, but only the
        // requested object's bytes are returned and independently re-hashed here.
        let names;
        try { names = await fs.readdir(`${git}/objects/pack`); }
        catch (error) { if (error.code === 'ENOENT') throw fail('GIT_OBJECT_MISSING'); throw error; }
        if (names.some(name => name.endsWith('.promisor'))) throw fail('REPOSITORY_EXTERNAL_OR_PARTIAL');
        if (!names.some(name => /^pack-[a-f0-9]{40}\.pack$/.test(name))) throw fail('GIT_OBJECT_MISSING');
        return readPacked(oid);
    };
}

async function syncDirectory(filename) {
    await containedParents(`${filename}/.sync-check`);
    const handle = await fs.open(filename, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try { await handle.sync(); } finally { await handle.close(); }
}

async function writeExclusive(filename, bytes, mode = 0o600) {
    await containedParents(filename);
    const handle = await fs.open(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, mode);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}

async function lease(root) {
    const filename = `${root}/EXPORT.lock`, token = randomUUID();
    try { await writeExclusive(filename, Buffer.from(JSON.stringify({ version: 1, token, pid: process.pid }))); }
    catch (error) { if (error.code === 'EEXIST') throw fail('EXPORT_LOCK_EXISTS'); throw error; }
    const stat = await privateStat(filename);
    return async () => {
        const current = await privateStat(filename);
        if (current.ino !== stat.ino || current.dev !== stat.dev || JSON.parse((await regularRead(filename, 4096)).toString('utf8')).token !== token) throw fail('EXPORT_LOCK_CHANGED');
        await fs.unlink(filename); await syncDirectory(root);
    };
}

async function commitInfo(read, oid) {
    const object = await read(oid);
    if (object.type !== 'commit') throw fail('COMMIT_TYPE_REQUIRED');
    return parseCommit(object.bytes);
}

async function proveAncestry(read, selected, approved) {
    const todo = [approved], seen = new Set();
    while (todo.length) {
        const oid = todo.pop();
        if (seen.has(oid)) continue;
        seen.add(oid);
        if (seen.size > MAX_HISTORY) throw fail('HISTORY_LIMIT_EXCEEDED');
        const info = await commitInfo(read, oid);
        if (oid === selected) return;
        todo.push(...info.parents);
    }
    throw fail('COMMIT_NOT_IN_APPROVED_MAIN');
}

export async function exportCommit({ workspace, commitSha, approvedMainSha }) {
    requireSha(commitSha); requireSha(approvedMainSha);
    const git = await validateRepository(workspace);
    await mainSnapshot(git, approvedMainSha);
    const releaseLease = await lease(workspace);
    let originalError, confirmationStarted = false;
    try {
        const read = objectReader(git);
        const commit = await commitInfo(read, commitSha);
        await proveAncestry(read, commitSha, approvedMainSha);
        const files = [], directories = [], excluded = [], collisions = new Set(), protectedOids = new Set();
        const scan = async (oid, prefix = '', depth = 0) => {
            if (depth > 64) throw fail('TREE_DEPTH_EXCEEDED');
            const object = await read(oid);
            if (object.type !== 'tree') throw fail('TREE_TYPE_REQUIRED');
            for (const entry of parseTree(object.bytes)) {
                const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
                safeGitPath(relative);
                if (entry.mode === '160000') throw fail('SUBMODULE_UNSUPPORTED');
                if (entry.mode === '120000') throw fail('LINK_UNAPPROVED');
                const collision = relative.normalize('NFC').toLowerCase();
                if (collisions.has(collision)) throw fail('PATH_COLLISION');
                collisions.add(collision);
                if (collisions.size > MAX_FILES) throw fail('TREE_LIMIT_EXCEEDED');
                const reason = exclusionReason(relative);
                if (reason) {
                    excluded.push({ path: relative, type: entry.mode === '40000' ? 'tree' : 'blob', gitObjectSha: entry.oid, reason });
                    protectedOids.add(entry.oid);
                    continue; // before reading a protected blob or excluded subtree
                }
                if (entry.mode === '40000') { directories.push(relative); await scan(entry.oid, relative, depth + 1); }
                else files.push({ path: relative, gitBlobSha: entry.oid, gitMode: entry.mode });
            }
        };
        await scan(commit.tree);
        if (files.some(file => protectedOids.has(file.gitBlobSha))) throw fail('OBJECT_SHARED_WITH_EXCLUDED_PATH');
        await mainSnapshot(git, approvedMainSha);
        const exportId = randomUUID(), destination = `${workspace}/exports/${exportId}`, payload = `${destination}/source`;
        await requireExportWorkspace(workspace);
        await fs.mkdir(destination, { mode: 0o700 }); await fs.mkdir(payload, { mode: 0o700 });
        for (const relative of directories) {
            await privateStat(path.dirname(`${payload}/${relative}`), true);
            await fs.mkdir(`${payload}/${relative}`, { mode: 0o700 });
        }
        let total = 0;
        for (const file of files) {
            await mainSnapshot(git, approvedMainSha);
            const object = await read(file.gitBlobSha);
            if (object.type !== 'blob') throw fail('BLOB_TYPE_REQUIRED');
            total += object.bytes.length;
            if (total > MAX_BYTES) throw fail('EXPORT_BYTES_LIMIT_EXCEEDED');
            await requireExportWorkspace(workspace);
            await privateStat(path.dirname(`${payload}/${file.path}`), true);
            file.mode = file.gitMode === '100755' ? 0o700 : 0o600;
            file.size = object.bytes.length; file.sha256 = hash(object.bytes);
            await writeExclusive(`${payload}/${file.path}`, object.bytes, file.mode);
        }
        const record = { version: 1, format: FORMAT, exportId, commitSha, treeSha: commit.tree, approvedMainSha,
            provenance: { kind: 'verified-local-git-objects', remoteVerified: false }, policy: EXPORT_POLICY, policySha256: POLICY_SHA256,
            uid: process.getuid(), gid: process.getgid(), directories, files, excluded };
        await verifyPayload(payload, record);
        await mainSnapshot(git, approvedMainSha);
        const bytes = Buffer.from(JSON.stringify(record));
        if (bytes.length > MAX_OBJECT) throw fail('EXPORT_RECORD_LIMIT_EXCEEDED');
        await writeExclusive(`${destination}/source.json`, bytes);
        for (const relative of [...directories].reverse()) await syncDirectory(`${payload}/${relative}`);
        await syncDirectory(payload);
        await mainSnapshot(git, approvedMainSha);
        confirmationStarted = true;
        await writeExclusive(`${destination}/COMPLETE.json`, Buffer.from(JSON.stringify({ version: 1, exportId, sourceSha256: hash(bytes) })));
        await syncDirectory(destination); await syncDirectory(`${workspace}/exports`);
        await mainSnapshot(git, approvedMainSha);
        return { destination, source: payload, record };
    } catch (error) { originalError = error; throw error; }
    finally {
        try { if (!originalError || !confirmationStarted) await releaseLease(); }
        catch (error) {
            if (!originalError) throw error;
            if (Object.isExtensible(originalError)) { try { Object.defineProperty(originalError, 'cleanupError', { value: error }); } catch { /* preserve original error */ } }
        }
    }
}

async function verifyPayload(payload, record) {
    const expectedFiles = new Map(record.files.map(file => [file.path, file])), expectedDirectories = new Set(record.directories);
    let seenFiles = 0, seenDirectories = 0;
    const visit = async (directory, relative = '') => {
        await privateStat(directory, true);
        for (const name of await fs.readdir(directory)) {
            const current = relative ? `${relative}/${name}` : name;
            safeGitPath(current);
            const filename = `${payload}/${current}`, stat = await fs.lstat(filename);
            if (stat.isDirectory() && !stat.isSymbolicLink() && expectedDirectories.has(current)) { seenDirectories++; await visit(filename, current); continue; }
            const file = expectedFiles.get(current);
            if (!file) throw fail('EXPORT_INVENTORY_MISMATCH');
            await privateStat(filename, false, file.mode);
            const bytes = await regularRead(filename);
            if (bytes.length !== file.size || hash(bytes) !== file.sha256) throw fail('EXPORT_CONTENT_MISMATCH');
            verifyObject(file.gitBlobSha, 'blob', bytes);
            seenFiles++;
        }
    };
    await visit(payload);
    if (seenFiles !== expectedFiles.size || seenDirectories !== expectedDirectories.size) throw fail('EXPORT_INVENTORY_MISMATCH');
}

export async function verifyExport({ workspace, exportId }) {
    await requireExportWorkspace(workspace);
    if (typeof exportId !== 'string' || !UUID.test(exportId)) throw fail('INVALID_EXPORT_ID');
    try { await fs.lstat(`${workspace}/EXPORT.lock`); throw fail('EXPORT_UNCONFIRMED'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const destination = `${workspace}/exports/${exportId}`;
    await privateStat(destination, true);
    if ((await fs.readdir(destination)).sort().join('|') !== 'COMPLETE.json|source|source.json') throw fail('EXPORT_INCOMPLETE');
    await privateStat(`${destination}/source.json`); await privateStat(`${destination}/COMPLETE.json`);
    const bytes = await regularRead(`${destination}/source.json`), record = JSON.parse(bytes.toString('utf8'));
    const seal = JSON.parse((await regularRead(`${destination}/COMPLETE.json`, 4096)).toString('utf8'));
    if (!exactKeys(record, ['version', 'format', 'exportId', 'commitSha', 'treeSha', 'approvedMainSha', 'provenance', 'policy', 'policySha256', 'uid', 'gid', 'directories', 'files', 'excluded']) || record.format !== FORMAT || record.version !== 1 || record.exportId !== exportId || record.uid !== process.getuid() || record.gid !== process.getgid()
        || record.policySha256 !== POLICY_SHA256 || JSON.stringify(record.policy) !== JSON.stringify(EXPORT_POLICY)
        || !exactKeys(record.provenance, ['kind', 'remoteVerified']) || record.provenance.kind !== 'verified-local-git-objects' || record.provenance.remoteVerified !== false
        || !exactKeys(seal, ['version', 'exportId', 'sourceSha256']) || seal.version !== 1 || seal.exportId !== exportId || seal.sourceSha256 !== hash(bytes)) throw fail('EXPORT_RECORD_INVALID');
    const git = await validateRepository(workspace);
    await mainSnapshot(git, requireSha(record.approvedMainSha));
    const read = objectReader(git);
    const commit = await commitInfo(read, requireSha(record.commitSha));
    if (commit.tree !== record.treeSha) throw fail('EXPORT_PROVENANCE_MISMATCH');
    await proveAncestry(read, record.commitSha, record.approvedMainSha);
    // Re-enumerate Git metadata independently; do not trust caller-edited receipts.
    const sourceFiles = new Map(), sourceDirectories = [], sourceExcluded = [];
    const scan = async (oid, prefix = '', depth = 0) => {
        if (depth > 64) throw fail('TREE_DEPTH_EXCEEDED');
        const tree = await read(oid);
        if (tree.type !== 'tree') throw fail('TREE_TYPE_REQUIRED');
        for (const entry of parseTree(tree.bytes)) {
            const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (['120000', '160000'].includes(entry.mode)) throw fail('GIT_TYPE_UNSUPPORTED');
            const reason = exclusionReason(relative);
            if (reason) sourceExcluded.push({ path: relative, type: entry.mode === '40000' ? 'tree' : 'blob', gitObjectSha: entry.oid, reason });
            else if (entry.mode === '40000') { sourceDirectories.push(relative); await scan(entry.oid, relative, depth + 1); }
            else sourceFiles.set(relative, entry);
            if (sourceFiles.size + sourceDirectories.length + sourceExcluded.length > MAX_FILES) throw fail('TREE_LIMIT_EXCEEDED');
        }
    };
    await scan(commit.tree);
    if (!Array.isArray(record.files) || sourceFiles.size !== record.files.length || JSON.stringify(sourceDirectories) !== JSON.stringify(record.directories)
        || JSON.stringify(sourceExcluded) !== JSON.stringify(record.excluded)) throw fail('EXPORT_PROVENANCE_MISMATCH');
    const seen = new Set();
    for (const file of record.files) {
        const entry = sourceFiles.get(file.path);
        if (!exactKeys(file, ['path', 'gitBlobSha', 'gitMode', 'mode', 'size', 'sha256']) || !Number.isSafeInteger(file.size) || file.size < 0 || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)
            || seen.has(file.path) || !entry || file.gitBlobSha !== entry.oid || file.gitMode !== entry.mode || file.mode !== (entry.mode === '100755' ? 0o700 : 0o600)) throw fail('EXPORT_PROVENANCE_MISMATCH');
        seen.add(file.path);
    }
    await verifyPayload(`${destination}/source`, record);
    await mainSnapshot(git, record.approvedMainSha);
    return record;
}
