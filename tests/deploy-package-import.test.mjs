import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as tar from 'tar';
import { createExportWorkspace } from '../scripts/deploy/git-export.mjs';
import { importPackage, verifyPackage } from '../scripts/deploy/package-import.mjs';
import { prepareRelease, verifyPreparedRelease, publishPersistentPreparation, verifyPersistentPreparation } from '../scripts/deploy/release-prepare.mjs';
import { canonicalPaths } from '../scripts/deploy/production-contract.mjs';

const linux = { skip: process.platform !== 'linux' || process.getuid?.() === 0 ? 'Linux non-root workspace required' : false };
const digest = value => createHash('sha256').update(value).digest('hex');
const binaryCompare = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const COMMIT = '1'.repeat(40), TREE = '2'.repeat(40);
const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

function tarHeader(name, { size = 0, type = '0', mode = 0o600 } = {}) {
    const header = Buffer.alloc(512);
    const field = (offset, length, value) => Buffer.from(value).copy(header, offset, 0, length);
    field(0, 100, name); field(100, 8, `${mode.toString(8).padStart(7, '0')}\0`);
    field(108, 8, '0000000\0'); field(116, 8, '0000000\0');
    field(124, 12, `${size.toString(8).padStart(11, '0')}\0`); field(136, 12, '00000000000\0');
    header.fill(0x20, 148, 156); field(156, 1, type); field(257, 6, 'ustar\0'); field(263, 2, '00');
    field(148, 8, `${[...header].reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0')}\0 `);
    return header;
}

async function rawArchive(workspace, name, headers) {
    const filename = `${workspace}/${name}`;
    await fs.writeFile(filename, Buffer.concat([...headers, Buffer.alloc(1024)]), { mode: 0o600 });
    await fs.chmod(filename, 0o600);
    return { workspace, packagePath: filename, expectedSha256: digest(await fs.readFile(filename)) };
}

async function packagesEntries(workspace) {
    try { return await fs.readdir(`${workspace}/packages`); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

async function fixture(t, mutate = async () => {}) {
    const workspace = await createExportWorkspace();
    t.after(() => fs.rm(workspace, { recursive: true, force: true }));
    const staging = `${workspace}/package-fixture`, source = `${staging}/source`, packagePath = `${workspace}/release.tar`;
    await fs.mkdir(`${source}/src`, { recursive: true, mode: 0o700 });
    const contents = new Map([
        ['package-lock.json', '{"name":"fixture","lockfileVersion":3,"packages":{}}'],
        ['package.json', '{"name":"fixture","scripts":{"build":"fixture"}}'],
        ['server.js', '// fixture\n'],
        ['src/main.ts', '// fixture\n'],
    ]);
    for (const [relative, value] of contents) { await fs.writeFile(`${source}/${relative}`, value, { mode: 0o600 }); await fs.chmod(`${source}/${relative}`, 0o600); }
    await mutate({ workspace, staging, source, contents });
    const directories = [], files = [];
    const visit = async (directory, relative = '') => {
        for (const name of (await fs.readdir(directory)).sort(binaryCompare)) {
            const current = relative ? `${relative}/${name}` : name, filename = `${source}/${current}`, stat = await fs.lstat(filename);
            if (stat.isDirectory() && !stat.isSymbolicLink()) { directories.push(current); await visit(filename, current); }
            else if (stat.isFile() && !stat.isSymbolicLink()) files.push({ path: current, mode: stat.mode & 0o777, size: stat.size, sha256: digest(await fs.readFile(filename)) });
            else files.push({ path: current, mode: 0o600, size: 0, sha256: digest('') });
        }
    };
    await visit(source);
    const manifest = { version: 1, format: 'ist-release-package-v1', releaseVersion: 'fixture-1', commitSha: COMMIT, treeSha: TREE,
        createdAt: '2026-10-26T00:00:00.000Z', directories, files };
    await fs.writeFile(`${staging}/IST-RELEASE.json`, JSON.stringify(manifest), { mode: 0o600 });
    await tar.c({ cwd: staging, file: packagePath, portable: true, noMtime: true }, ['IST-RELEASE.json', 'source']);
    await fs.chmod(packagePath, 0o600);
    return { workspace, packagePath, expectedSha256: digest(await fs.readFile(packagePath)), manifest };
}

function runner() {
    return async (command, args, options) => {
        if (options.stage === 'metadata') return { stdout: '10.8.2\n', stderr: '' };
        if (options.stage === 'install') for (const name of ['bcrypt', 'sharp']) {
            const directory = `${options.cwd}/node_modules/${name}`; await fs.mkdir(directory, { recursive: true, mode: 0o700 });
            await fs.writeFile(`${directory}/package.json`, JSON.stringify({ name, version: '0.0.0' }), { mode: 0o600 });
        }
        if (options.stage === 'build') {
            const directory = `${options.cwd}/dist/sakai-ng/browser`; await fs.mkdir(directory, { recursive: true, mode: 0o700 });
            await fs.writeFile(`${directory}/index.html`, '<!doctype html>', { mode: 0o600 });
        }
        return { stdout: '', stderr: '' };
    };
}

test('valid package imports, verifies and prepares without a git directory', linux, async t => {
    const f = await fixture(t), imported = await importPackage(f);
    assert.equal((await verifyPackage({ workspace: f.workspace, packageId: imported.record.packageId })).packageSha256, f.expectedSha256);
    const prepared = await prepareRelease({ workspace: f.workspace, packageId: imported.record.packageId, runner: runner() });
    assert.equal(prepared.manifest.sourceType, 'package');
    assert.equal(prepared.manifest.releaseVersion, 'fixture-1');
    assert.equal((await verifyPreparedRelease({ workspace: f.workspace, preparationId: prepared.manifest.preparationId })).commitSha, COMMIT);
    const paths = canonicalPaths(`${f.workspace}/persistent`); await fs.mkdir(paths.admin, { recursive: true, mode: 0o700 }); await fs.chmod(paths.admin, 0o700);
    await publishPersistentPreparation({ workspace: f.workspace, preparationId: prepared.manifest.preparationId, paths });
    await fs.rm(`${f.workspace}/preparations/${prepared.manifest.preparationId}`, { recursive: true });
    const persistent = await verifyPersistentPreparation({ paths, preparationId: prepared.manifest.preparationId });
    assert.equal(persistent.sourceType, 'package'); assert.equal(persistent.packageSha256, f.expectedSha256);
    await assert.rejects(fs.lstat(`${f.workspace}/repository/.git`), { code: 'ENOENT' });
});

test('wrong package digest is rejected before extraction', linux, async t => {
    const f = await fixture(t);
    await assert.rejects(importPackage({ ...f, expectedSha256: '0'.repeat(64) }), { code: 'PACKAGE_DIGEST_MISMATCH' });
    assert.deepEqual(await packagesEntries(f.workspace), []);
});

test('package with an unlisted or changed payload is rejected', linux, async t => {
    const f = await fixture(t);
    const staging = `${f.workspace}/changed`, source = `${staging}/source`, changed = `${f.workspace}/changed.tar`;
    await fs.cp(`${f.workspace}/package-fixture`, staging, { recursive: true });
    await fs.writeFile(`${source}/extra.js`, 'unexpected');
    await tar.c({ cwd: staging, file: changed, portable: true, noMtime: true }, ['IST-RELEASE.json', 'source']); await fs.chmod(changed, 0o600);
    await assert.rejects(importPackage({ workspace: f.workspace, packagePath: changed, expectedSha256: digest(await fs.readFile(changed)) }), { code: 'PACKAGE_INVENTORY_MISMATCH' });
});

test('package links and protected entries are rejected', linux, async t => {
    const linked = await fixture(t, async ({ source }) => fs.symlink('server.js', `${source}/linked.js`));
    await assert.rejects(importPackage(linked), { code: 'PACKAGE_ARCHIVE_ENTRY_UNSAFE' });
    const protectedFile = await fixture(t, async ({ source }) => fs.writeFile(`${source}/secret.pem`, 'fixture'));
    await assert.rejects(importPackage(protectedFile), { code: 'PACKAGE_PROTECTED_ENTRY' });
});

test('manifest traversal is rejected before extraction', linux, async t => {
    const f = await fixture(t), staging = `${f.workspace}/traversal`, archive = `${f.workspace}/traversal.tar`;
    await fs.cp(`${f.workspace}/package-fixture`, staging, { recursive: true });
    const filename = `${staging}/IST-RELEASE.json`, manifest = JSON.parse(await fs.readFile(filename, 'utf8'));
    manifest.directories.unshift('../escape');
    await fs.writeFile(filename, JSON.stringify(manifest));
    await tar.c({ cwd: staging, file: archive, portable: true, noMtime: true }, ['IST-RELEASE.json', 'source']); await fs.chmod(archive, 0o600);
    await assert.rejects(importPackage({ workspace: f.workspace, packagePath: archive, expectedSha256: digest(await fs.readFile(archive)) }), { code: 'PACKAGE_PATH_UNSAFE' });
});

test('unsafe traversal in a TAR header is rejected and cleaned', linux, async t => {
    const workspace = await createExportWorkspace(); t.after(() => fs.rm(workspace, { recursive: true, force: true }));
    const archive = await rawArchive(workspace, 'raw-traversal.tar', [tarHeader('source/', { type: '5', mode: 0o700 }), tarHeader('source/../escape')]);
    await assert.rejects(importPackage(archive), error => ['PACKAGE_ARCHIVE_ENTRY_UNSAFE', 'PACKAGE_PATH_UNSAFE', 'TAR_ENTRY_ERROR'].includes(error.code));
    assert.deepEqual(await packagesEntries(workspace), []);
});

test('packages parent symlink cannot redirect an import', linux, async t => {
    const f = await fixture(t), outside = `${f.workspace}/outside`;
    await fs.mkdir(outside, { mode: 0o700 }); await fs.symlink(outside, `${f.workspace}/packages`);
    await assert.rejects(importPackage(f), { code: 'PACKAGE_DIRECTORY_UNSAFE' });
    assert.deepEqual(await fs.readdir(outside), []);
});

test('TAR entry count and declared size limits fail before extraction', linux, async t => {
    const workspace = await createExportWorkspace(); t.after(() => fs.rm(workspace, { recursive: true, force: true }));
    const tooMany = [tarHeader('source/', { type: '5', mode: 0o700 })];
    for (let index = 0; index < 10000; index += 1) tooMany.push(tarHeader(`source/d${index}/`, { type: '5', mode: 0o700 }));
    await assert.rejects(importPackage(await rawArchive(workspace, 'too-many.tar', tooMany)), { code: 'PACKAGE_ENTRY_LIMIT' });
    assert.deepEqual(await packagesEntries(workspace), []);
    await assert.rejects(importPackage(await rawArchive(workspace, 'too-large.tar', [tarHeader('source/', { type: '5', mode: 0o700 }), tarHeader('source/large.bin', { size: 64 * 1024 * 1024 + 1 })])), { code: 'PACKAGE_SIZE_LIMIT' });
    assert.deepEqual(await packagesEntries(workspace), []);
});

test('case and Unicode-normalized archive collisions are rejected', linux, async t => {
    const caseCollision = await fixture(t, async ({ source }) => { await fs.writeFile(`${source}/Case.js`, 'a'); await fs.writeFile(`${source}/case.js`, 'b'); });
    await assert.rejects(importPackage(caseCollision), { code: 'PACKAGE_DUPLICATE_ENTRY' });
    const unicodeCollision = await fixture(t, async ({ source }) => { await fs.writeFile(`${source}/caf\u00e9.js`, 'a'); await fs.writeFile(`${source}/cafe\u0301.js`, 'b'); });
    await assert.rejects(importPackage(unicodeCollision), { code: 'PACKAGE_DUPLICATE_ENTRY' });
});

test('incomplete package is rejected', linux, async t => {
    const f = await fixture(t, async ({ source }) => fs.rm(`${source}/server.js`));
    await assert.rejects(importPackage(f), { code: 'PACKAGE_INCOMPLETE' });
});

test('imported archive and extracted source are reverified', linux, async t => {
    const f = await fixture(t), imported = await importPackage(f), root = `${f.workspace}/packages/${imported.record.packageId}`;
    await fs.appendFile(`${root}/archive.tar`, 'tampered');
    await assert.rejects(verifyPackage({ workspace: f.workspace, packageId: imported.record.packageId }), { code: 'PACKAGE_DIGEST_MISMATCH' });
});

test('archive metadata rejects symlink, hardlink and unsafe permissions', linux, async t => {
    const replaceAndReject = async replace => {
        const f = await fixture(t), imported = await importPackage(f), root = `${f.workspace}/packages/${imported.record.packageId}`, archive = `${root}/archive.tar`;
        await replace(archive, f.workspace);
        await assert.rejects(verifyPackage({ workspace: f.workspace, packageId: imported.record.packageId }), error => ['PACKAGE_CONTENT_UNSAFE', 'PACKAGE_CONTENT_CHANGED'].includes(error.code));
    };
    await replaceAndReject(async (archive, workspace) => { await fs.rename(archive, `${workspace}/saved.tar`); await fs.symlink(`${workspace}/saved.tar`, archive); });
    await replaceAndReject(async (archive, workspace) => { await fs.link(archive, `${workspace}/archive-hardlink.tar`); });
    await replaceAndReject(async archive => fs.chmod(archive, 0o640));
});

test('archive with a different group is rejected when a secondary group is available', linux, async t => {
    const secondary = process.getgroups().find(gid => gid !== process.getgid());
    if (secondary === undefined) { t.skip('no secondary group available'); return; }
    const f = await fixture(t), imported = await importPackage(f), root = `${f.workspace}/packages/${imported.record.packageId}`, archive = `${root}/archive.tar`;
    try { await fs.chown(archive, process.getuid(), secondary); }
    catch (error) { if (error.code === 'EPERM') { t.skip('group change is not permitted'); return; } throw error; }
    await assert.rejects(verifyPackage({ workspace: f.workspace, packageId: imported.record.packageId }), { code: 'PACKAGE_CONTENT_UNSAFE' });
});

test('archive pathname substitution during extraction is rejected and cleaned', linux, async t => {
    const f = await fixture(t, async ({ source }) => {
        await fs.mkdir(`${source}/src/app`, { mode: 0o700 });
        await fs.writeFile(`${source}/src/app/padding.bin`, Buffer.alloc(8 * 1024 * 1024, 0x49), { mode: 0o600 });
    });
    const importing = importPackage(f);
    let replaced = false;
    for (let attempt = 0; attempt < 10000 && !replaced; attempt += 1) {
        for (const packageId of await packagesEntries(f.workspace)) {
            const root = `${f.workspace}/packages/${packageId}`;
            if (!UUID_PATTERN.test(packageId) || !await fs.lstat(`${root}/source.extracting`).then(() => true, () => false)) continue;
            await fs.rename(`${root}/archive.tar`, `${f.workspace}/archive-opened.tar`);
            await fs.writeFile(`${root}/archive.tar`, 'substituted', { mode: 0o600 }); await fs.chmod(`${root}/archive.tar`, 0o600);
            replaced = true; break;
        }
        if (!replaced) await new Promise(resolve => setTimeout(resolve, 1));
    }
    assert.equal(replaced, true);
    await assert.rejects(importing, { code: 'PACKAGE_CONTENT_CHANGED' });
    assert.deepEqual(await packagesEntries(f.workspace), []);
});

test('metadata symlinks and hardlinks are rejected without following them', linux, async t => {
    for (const metadata of ['record.json', 'COMPLETE.json']) {
        const f = await fixture(t), imported = await importPackage(f), root = `${f.workspace}/packages/${imported.record.packageId}`;
        await fs.rm(`${root}/${metadata}`); await fs.symlink(`${root}/archive.tar`, `${root}/${metadata}`);
        await assert.rejects(verifyPackage({ workspace: f.workspace, packageId: imported.record.packageId }), { code: 'PACKAGE_RECORD_INVALID' });
    }
    const f = await fixture(t), imported = await importPackage(f), root = `${f.workspace}/packages/${imported.record.packageId}`;
    await fs.rm(`${root}/COMPLETE.json`); await fs.link(`${root}/record.json`, `${root}/COMPLETE.json`);
    await assert.rejects(verifyPackage({ workspace: f.workspace, packageId: imported.record.packageId }), { code: 'PACKAGE_RECORD_INVALID' });
});

test('extracted content adulteration and ordering changes are detected', linux, async t => {
    const f = await fixture(t), imported = await importPackage(f), root = `${f.workspace}/packages/${imported.record.packageId}`;
    await fs.writeFile(`${root}/source/server.js`, '// adulterated\n');
    await assert.rejects(verifyPackage({ workspace: f.workspace, packageId: imported.record.packageId }), { code: 'PACKAGE_CONTENT_MISMATCH' });
    const ordered = await fixture(t, async ({ source }) => {
        await fs.mkdir(`${source}/src/app`, { mode: 0o700 });
        await fs.writeFile(`${source}/src/app/Z.ts`, 'z'); await fs.writeFile(`${source}/src/app/a.ts`, 'a');
    });
    const result = await importPackage(ordered);
    assert.deepEqual(result.record.files.map(file => file.path), [...result.record.files.map(file => file.path)].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))));
});

test('preparation requires exactly one source kind and Git preparation remains supported', linux, async t => {
    const f = await fixture(t), imported = await importPackage(f);
    await assert.rejects(prepareRelease({ workspace: f.workspace, runner: runner() }), { code: 'PREPARATION_ARGUMENT_INVALID' });
    await assert.rejects(prepareRelease({ workspace: f.workspace, exportId: imported.record.packageId, packageId: imported.record.packageId, runner: runner() }), { code: 'PREPARATION_ARGUMENT_INVALID' });
});
