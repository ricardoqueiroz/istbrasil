import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { canonicalPaths, validateActive, validateJournal } from '../scripts/deploy/production-contract.mjs';
import { inspectProduction } from '../scripts/deploy/production-inspect.mjs';
import { activatePreparedRelease, rollbackRelease, publicationExitCode, publishNoReplace } from '../scripts/deploy/production-operation.mjs';

const linux = { skip: process.platform !== 'linux' || process.getuid?.() === 0 ? 'Linux non-root required' : false };
const SHA = 'a'.repeat(40), TREE = 'b'.repeat(40);
const hash = value => createHash('sha256').update(value).digest('hex');

async function write(filename, value, mode = 0o600) {
    await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    await fs.writeFile(filename, value, { mode });
}
async function snapshot(filename) {
    const result = {};
    const visit = async (current, relative = '') => {
        const stat = await fs.lstat(current);
        result[relative] = stat.isFile() ? hash(await fs.readFile(current)) : stat.isSymbolicLink() ? await fs.readlink(current) : 'directory';
        if (stat.isDirectory()) for (const child of (await fs.readdir(current)).sort()) await visit(`${current}/${child}`, relative ? `${relative}/${child}` : child);
    };
    await visit(filename); return result;
}

async function fixture(t) {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'ist-production-operation-'));
    await fs.chmod(base, 0o700); t.after(() => fs.rm(base, { recursive: true, force: true }));
    const paths = canonicalPaths(base);
    for (const directory of [paths.repo, paths.html, paths.uploads, paths.backendPhp, paths.private]) await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await write(paths.env, 'FICTIONAL_CONFIG=1\n'); await write(paths.envBackup, 'FICTIONAL_BACKUP=1\n');
    await write(`${paths.private}/sentinel.bin`, 'private-fixture'); await write(`${paths.uploads}/photo.bin`, 'upload-fixture');
    await write(`${paths.backendPhp}/index.php`, 'fictional php');
    await write(`${paths.repo}/server.js`, '// legacy server fixture\n');
    await write(`${paths.repo}/package.json`, '{"name":"legacy-fixture"}'); await write(`${paths.repo}/package-lock.json`, '{}');
    await write(`${paths.repo}/src/app.js`, '// legacy source'); await write(`${paths.repo}/node_modules/fixture/package.json`, '{"name":"fixture"}');
    await write(`${paths.html}/index.html`, '<title>legacy frontend</title>'); await write(`${paths.html}/legacy.js`, 'legacy');
    await fs.symlink(paths.phpMyAdmin, `${paths.html}/istdbadmin`);

    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'ist-prepared-operation-'));
    await fs.chmod(workspace, 0o700); t.after(() => fs.rm(workspace, { recursive: true, force: true }));
    const preparationId = randomUUID(), candidate = `${workspace}/preparations/${preparationId}/release`;
    await write(`${candidate}/backend/server.js`, '// candidate server fixture\n');
    await write(`${candidate}/backend/package.json`, '{"name":"candidate-fixture"}'); await write(`${candidate}/backend/package-lock.json`, '{}');
    await write(`${candidate}/backend/src/app.js`, '// candidate source'); await write(`${candidate}/backend/node_modules/fixture/package.json`, '{"name":"fixture"}');
    await write(`${candidate}/frontend/index.html`, '<title>candidate frontend</title>'); await write(`${candidate}/frontend/main.js`, 'candidate');
    const prepared = { commitSha: SHA, treeSha: TREE };
    const verifyPrepared = async input => { assert.equal(input.workspace, workspace); assert.equal(input.preparationId, preparationId); return prepared; };
    const adapter = {
        current: { name: 'ist-api', cwd: paths.repo, script: `${paths.repo}/server.js`, commitSha: 'c'.repeat(40) }, switches: [], healthCalls: 0,
        async describe() { return { ...this.current }; },
        async switchTo(target) { this.switches.push(target); this.current = { ...target, commitSha: SHA }; },
        async health() { this.healthCalls++; if (!await fs.stat(this.current.script).then(stat => stat.isFile(), () => false)) throw Object.assign(new Error('health'), { code: 'BACKEND_HEALTH_FAILED' }); },
    };
    return { base, paths, workspace, preparationId, candidate, verifyPrepared, adapter };
}

async function persistentSnapshot(f) {
    return { env: await fs.readFile(f.paths.env, 'utf8'), envBackup: await fs.readFile(f.paths.envBackup, 'utf8'),
        private: await snapshot(f.paths.private), uploads: await snapshot(f.paths.uploads), php: await snapshot(f.paths.backendPhp) };
}
async function assertNoPreparedSnapshot(f) {
    assert.deepEqual(await fs.readdir(f.paths.backups), []);
    assert.ok(!(await fs.readdir(f.paths.admin)).some(name => name.startsWith('.snapshot-')));
    assert.equal(f.adapter.switches.length, 0);
    assert.equal(await fs.readFile(`${f.paths.html}/index.html`, 'utf8'), '<title>legacy frontend</title>');
    assert.equal(await fs.readFile(`${f.paths.repo}/server.js`, 'utf8'), '// legacy server fixture\n');
}
function arrangeConcurrentDestination(t, f, content = null) {
    const original = fs.lstat; let destination;
    t.mock.method(fs, 'lstat', async (filename, ...args) => {
        if (!destination && String(filename).endsWith('/scripts/deploy/bin/rename-noreplace-linux-x64')) {
            const staging = (await fs.readdir(f.paths.admin)).find(name => name.startsWith('.snapshot-'));
            const backupId = staging.slice(-36); destination = `${f.paths.backups}/${backupId}`;
            await fs.mkdir(destination, { mode: 0o700 });
            if (content !== null) await write(`${destination}/sentinel`, content);
        }
        return original(filename, ...args);
    });
    return () => destination;
}

test('successful activation backs up legacy runtime, switches backend and publishes index last', linux, async t => {
    const f = await fixture(t), persistent = await persistentSnapshot(f);
    const result = await activatePreparedRelease({ base: f.base, workspace: f.workspace, preparationId: f.preparationId, adapter: f.adapter, verifyPrepared: f.verifyPrepared });
    assert.equal(validateActive(result.active, f.paths), true); assert.equal(result.active.generation, 1);
    assert.equal(await fs.readFile(`${f.paths.html}/index.html`, 'utf8'), '<title>candidate frontend</title>');
    assert.equal(await fs.readlink(`${f.paths.html}/istdbadmin`), f.paths.phpMyAdmin);
    assert.equal(await fs.readFile(`${result.active.pm2.cwd}/server.js`, 'utf8'), '// candidate server fixture\n');
    assert.equal(await fs.readlink(`${result.active.pm2.cwd}/.env`), f.paths.env);
    assert.equal(await fs.readlink(`${result.active.pm2.cwd}/istbrasil.private`), f.paths.private);
    assert.deepEqual(await persistentSnapshot(f), persistent);
    const envelope = JSON.parse(await fs.readFile(`${f.paths.transactions}/${result.transactionId}.json`, 'utf8'));
    assert.equal(validateJournal(envelope), true); assert.equal(envelope.record.events.at(-1).phase, 'confirmed');
    const backupRoot = `${f.paths.backups}/${result.backupId}`;
    assert.deepEqual((await fs.readdir(backupRoot)).sort(), ['READY', 'manifest.json', 'payload']);
    assert.ok(await fs.lstat(`${backupRoot}/READY`));
    assert.ok(!(await fs.readdir(f.paths.admin)).some(name => name.startsWith('.snapshot-')));
    await assert.rejects(fs.lstat(f.paths.lock), { code: 'ENOENT' });
    const report = await inspectProduction({ paths: f.paths, ancestorBoundary: f.base,
        identityReader: async () => ({ uid: process.getuid(), gid: process.getgid(), exclusiveGroup: true, verified: true }),
        aclReader: async () => 'basic',
        processReader: async () => ({ proven: true, unknown: false, runtimePathsProven: true, pm2: result.active.pm2 }) });
    assert.equal(report.status, 'CONSISTENT');
});

test('activation and rollback require only .env and do not recreate absent legacy environment files', linux, async t => {
    const f = await fixture(t); await fs.unlink(f.paths.envBackup);
    const deployed = await activatePreparedRelease({ base: f.base, workspace: f.workspace, preparationId: f.preparationId, adapter: f.adapter, verifyPrepared: f.verifyPrepared });
    await assert.rejects(fs.lstat(f.paths.envBackup), { code: 'ENOENT' });
    await assert.rejects(fs.lstat(f.paths.envOld), { code: 'ENOENT' });
    await rollbackRelease({ base: f.base, backupId: deployed.backupId, adapter: f.adapter });
    await assert.rejects(fs.lstat(f.paths.envBackup), { code: 'ENOENT' });
    await assert.rejects(fs.lstat(f.paths.envOld), { code: 'ENOENT' });
});

test('legacy snapshot normalizes only backup file modes and preserves executables and internal package links', linux, async t => {
    const f = await fixture(t), legacy = [
        [`${f.paths.repo}/src/group-writable.js`, 0o664],
        [`${f.paths.repo}/src/world-writable.js`, 0o666],
        [`${f.paths.repo}/node_modules/fixture/tool`, 0o775],
        [`${f.paths.repo}/node_modules/fixture/run`, 0o777],
        [`${f.paths.html}/legacy-writable.js`, 0o666]
    ];
    for (const [filename, mode] of legacy) { await write(filename, `fixture-${mode.toString(8)}`); await fs.chmod(filename, mode); }
    await fs.mkdir(`${f.paths.repo}/node_modules/.bin`, { mode: 0o700 });
    await fs.symlink('../fixture/tool', `${f.paths.repo}/node_modules/.bin/fixture-tool`);
    const originalModes = new Map(await Promise.all(legacy.slice(0, 4).map(async ([filename]) => [filename, (await fs.stat(filename)).mode & 0o777])));
    const originalSwitch = f.adapter.switchTo.bind(f.adapter); let frontendModeBeforePublication;
    f.adapter.switchTo = async target => {
        if (frontendModeBeforePublication === undefined) frontendModeBeforePublication = (await fs.stat(`${f.paths.html}/legacy-writable.js`)).mode & 0o777;
        await originalSwitch(target);
    };

    const result = await activatePreparedRelease({ base: f.base, workspace: f.workspace, preparationId: f.preparationId, adapter: f.adapter, verifyPrepared: f.verifyPrepared });
    const backup = `${f.paths.backups}/${result.backupId}`, manifest = JSON.parse(await fs.readFile(`${backup}/manifest.json`, 'utf8'));
    const expected = new Map([
        ['backend/src/group-writable.js', 0o644],
        ['backend/src/world-writable.js', 0o644],
        ['backend/node_modules/fixture/tool', 0o755],
        ['backend/node_modules/fixture/run', 0o755],
        ['frontend/legacy-writable.js', 0o644]
    ]);
    for (const [relative, mode] of expected) {
        assert.equal((await fs.stat(`${backup}/payload/${relative}`)).mode & 0o777, mode);
        assert.equal(manifest.entries.find(entry => entry.path === relative)?.mode, mode);
    }
    for (const [filename, mode] of originalModes) assert.equal((await fs.stat(filename)).mode & 0o777, mode);
    assert.equal(frontendModeBeforePublication, 0o666);
    assert.equal(await fs.readlink(`${backup}/payload/backend/node_modules/.bin/fixture-tool`), '../fixture/tool');
    assert.equal(manifest.entries.find(entry => entry.path === 'backend/node_modules/.bin/fixture-tool')?.target, '../fixture/tool');
    assert.ok(await fs.lstat(`${backup}/READY`));
    const rolled = await rollbackRelease({ base: f.base, backupId: result.backupId, adapter: f.adapter });
    for (const [relative, mode] of expected) if (relative.startsWith('backend/')) assert.equal((await fs.stat(`${rolled.active.pm2.cwd}/${relative.slice('backend/'.length)}`)).mode & 0o777, mode);
    assert.equal((await fs.stat(`${f.paths.html}/legacy-writable.js`)).mode & 0o777, 0o644);
});

test('unsafe legacy links and protected paths remain rejected before activation', linux, async t => {
    await t.test('link escaping the backend', async t => {
        const f = await fixture(t);
        await fs.symlink('../../../../outside', `${f.paths.repo}/node_modules/fixture/escape`);
        await assert.rejects(activatePreparedRelease({ base: f.base, workspace: f.workspace, preparationId: f.preparationId, adapter: f.adapter, verifyPrepared: f.verifyPrepared }), { code: 'SOURCE_LINK_UNSAFE' });
        await assertNoPreparedSnapshot(f);
    });
    await t.test('protected nested file', async t => {
        const f = await fixture(t);
        await write(`${f.paths.repo}/src/private.key`, 'fictional-key-marker');
        await assert.rejects(activatePreparedRelease({ base: f.base, workspace: f.workspace, preparationId: f.preparationId, adapter: f.adapter, verifyPrepared: f.verifyPrepared }), { code: 'BACKUP_MANIFEST_INVALID' });
        await assertNoPreparedSnapshot(f);
    });
});

test('snapshot preparation failures never publish an incomplete backup', linux, async t => {
    const cases = [
        ['inventory', async (t, f) => {
            const original = fs.readFile;
            t.mock.method(fs, 'readFile', async (filename, ...args) => {
                if (String(filename).includes('/.snapshot-') && String(filename).endsWith('/payload/backend/server.js')) throw Object.assign(new Error('fixture inventory failure'), { code: 'EIO' });
                return original(filename, ...args);
            });
        }],
        ['manifest write', async (t) => {
            const original = fs.open;
            t.mock.method(fs, 'open', async (filename, flags, ...args) => {
                if (String(filename).includes('/.snapshot-') && String(filename).endsWith('/manifest.json') && flags & fs.constants.O_CREAT) throw Object.assign(new Error('fixture manifest failure'), { code: 'EIO' });
                return original(filename, flags, ...args);
            });
        }],
        ['seal write', async (t) => {
            const original = fs.open;
            t.mock.method(fs, 'open', async (filename, flags, ...args) => {
                if (String(filename).includes('/.snapshot-') && String(filename).endsWith('/READY') && flags & fs.constants.O_CREAT) throw Object.assign(new Error('fixture seal failure'), { code: 'EIO' });
                return original(filename, flags, ...args);
            });
        }],
        ['directory sync', async (t) => {
            const original = fs.open;
            t.mock.method(fs, 'open', async (filename, flags, ...args) => {
                const handle = await original(filename, flags, ...args);
                if (String(filename).includes('/.snapshot-') && String(filename).endsWith('/payload/backend/src') && !(flags & fs.constants.O_CREAT)) {
                    handle.sync = async () => { throw Object.assign(new Error('fixture sync failure'), { code: 'EIO' }); };
                }
                return handle;
            });
        }]
    ];
    for (const [label, arrange] of cases) await t.test(label, async t => {
        const f = await fixture(t); await arrange(t, f);
        await assert.rejects(activatePreparedRelease({ base: f.base, workspace: f.workspace, preparationId: f.preparationId, adapter: f.adapter, verifyPrepared: f.verifyPrepared }));
        await assertNoPreparedSnapshot(f);
    });
});

for (const [label, content] of [['empty', null], ['non-empty', 'preexisting']]) test(`atomic publication preserves a concurrent ${label} destination`, linux, async t => {
    const f = await fixture(t), destination = arrangeConcurrentDestination(t, f, content);
    await assert.rejects(activatePreparedRelease({ base: f.base, workspace: f.workspace, preparationId: f.preparationId, adapter: f.adapter, verifyPrepared: f.verifyPrepared }), { code: 'BACKUP_DESTINATION_EXISTS' });
    assert.deepEqual(await fs.readdir(destination()), content === null ? [] : ['sentinel']);
    if (content !== null) assert.equal(await fs.readFile(`${destination()}/sentinel`, 'utf8'), content);
    assert.ok(!(await fs.readdir(f.paths.admin)).some(name => name.startsWith('.snapshot-')));
    assert.equal(f.adapter.switches.length, 0);
});

test('missing helper fails closed before publication', linux, async t => {
    const f = await fixture(t), original = fs.lstat;
    t.mock.method(fs, 'lstat', async (filename, ...args) => {
        if (String(filename).endsWith('/scripts/deploy/bin/rename-noreplace-linux-x64')) throw Object.assign(new Error('fixture missing helper'), { code: 'ENOENT' });
        return original(filename, ...args);
    });
    await assert.rejects(activatePreparedRelease({ base: f.base, workspace: f.workspace, preparationId: f.preparationId, adapter: f.adapter, verifyPrepared: f.verifyPrepared }), { code: 'BACKUP_HELPER_UNAVAILABLE' });
    await assertNoPreparedSnapshot(f);
});

test('unsupported no-replace primitive fails closed with its distinct result', linux, async t => {
    const f = await fixture(t), transactionId = randomUUID(), backupId = randomUUID();
    const staging = `${f.paths.admin}/.snapshot-${transactionId}-${backupId}`, root = `${f.paths.backups}/${backupId}`;
    await fs.mkdir(f.paths.backups, { recursive: true, mode: 0o700 }); await fs.mkdir(staging, { mode: 0o700 });
    await assert.rejects(publishNoReplace(f.paths, transactionId, backupId, staging, root, async () => { throw Object.assign(new Error('fixture unavailable'), { code: 11 }); }), { code: 'BACKUP_PUBLISH_UNAVAILABLE' });
    assert.equal(publicationExitCode(11), 'BACKUP_PUBLISH_UNAVAILABLE');
    assert.ok(await fs.lstat(staging)); await assert.rejects(fs.lstat(root), { code: 'ENOENT' });
});

test('uncertain interruption after atomic rename preserves the complete backup and requires recovery', linux, async t => {
    const f = await fixture(t), original = fs.lstat; let destination, failRoot = false;
    t.mock.method(fs, 'lstat', async (filename, ...args) => {
        if (!destination && String(filename).endsWith('/scripts/deploy/bin/rename-noreplace-linux-x64')) {
            const staging = (await fs.readdir(f.paths.admin)).find(name => name.startsWith('.snapshot-'));
            destination = `${f.paths.backups}/${staging.slice(-36)}`; failRoot = true;
        }
        if (failRoot && filename === destination) { failRoot = false; throw Object.assign(new Error('fixture post-rename inspection'), { code: 'EIO' }); }
        return original(filename, ...args);
    });
    await assert.rejects(activatePreparedRelease({ base: f.base, workspace: f.workspace, preparationId: f.preparationId, adapter: f.adapter, verifyPrepared: f.verifyPrepared }), error => error.code === 'BACKUP_PUBLICATION_UNCERTAIN' && error.rollbackError?.code === 'BACKUP_PUBLICATION_UNCERTAIN');
    assert.deepEqual((await fs.readdir(destination)).sort(), ['READY', 'manifest.json', 'payload']);
    assert.ok(await fs.lstat(f.paths.lock));
    assert.equal(f.adapter.switches.length, 0);
});

for (const target of ['staging', 'root']) test(`secondary ${target} lstat failure preserves the snapshot error and lock`, linux, async t => {
    const f = await fixture(t); await write(`${f.paths.repo}/src/private.key`, 'fictional-key-marker');
    const original = fs.lstat; let stagingChecks = 0;
    t.mock.method(fs, 'lstat', async (filename, ...args) => {
        const value = String(filename);
        if (target === 'staging' && value.includes('/.snapshot-') && !value.includes('/payload') && ++stagingChecks === 2) throw Object.assign(new Error('fixture staging inspection failure'), { code: 'EIO' });
        if (target === 'root' && value.startsWith(`${f.paths.backups}/`) && value !== f.paths.backups) throw Object.assign(new Error('fixture root inspection failure'), { code: 'EIO' });
        return original(filename, ...args);
    });
    await assert.rejects(activatePreparedRelease({ base: f.base, workspace: f.workspace, preparationId: f.preparationId, adapter: f.adapter, verifyPrepared: f.verifyPrepared }), error => error.code === 'BACKUP_MANIFEST_INVALID' && error.rollbackError?.code === 'EIO');
    assert.ok(await fs.lstat(f.paths.lock)); assert.equal(f.adapter.switches.length, 0);
});

test('cleanup failure preserves the snapshot error and retains recovery evidence', linux, async t => {
    const f = await fixture(t); await write(`${f.paths.repo}/src/private.key`, 'fictional-key-marker');
    const original = fs.rm;
    t.mock.method(fs, 'rm', async (filename, ...args) => {
        if (String(filename).includes('/.snapshot-')) throw Object.assign(new Error('fixture cleanup failure'), { code: 'EACCES' });
        return original(filename, ...args);
    });
    await assert.rejects(activatePreparedRelease({ base: f.base, workspace: f.workspace, preparationId: f.preparationId, adapter: f.adapter, verifyPrepared: f.verifyPrepared }), error => error.code === 'BACKUP_MANIFEST_INVALID' && error.rollbackError?.code === 'EACCES');
    assert.deepEqual(await fs.readdir(f.paths.backups), []);
    assert.ok((await fs.readdir(f.paths.admin)).some(name => name.startsWith('.snapshot-')));
    assert.ok(await fs.lstat(f.paths.lock));
    assert.equal(f.adapter.switches.length, 0);
});

test('managed candidate files with unsafe modes remain rejected', linux, async t => {
    const f = await fixture(t);
    await fs.chmod(`${f.candidate}/backend/server.js`, 0o666);
    await assert.rejects(activatePreparedRelease({ base: f.base, workspace: f.workspace, preparationId: f.preparationId, adapter: f.adapter, verifyPrepared: f.verifyPrepared }), { code: 'RELEASE_MANIFEST_INVALID' });
    assert.equal(f.adapter.switches.length, 0);
    assert.equal((await fs.stat(`${f.candidate}/backend/server.js`)).mode & 0o777, 0o666);
});

test('backend activation failure restores previous PM2 target and frontend', linux, async t => {
    const f = await fixture(t), originalSwitch = f.adapter.switchTo.bind(f.adapter); let failed = false;
    f.adapter.switchTo = async target => { if (!failed && target.cwd.includes('/releases/')) { failed = true; throw Object.assign(new Error('fixture PM2 failure'), { code: 'PM2_SWITCH_FAILED' }); } await originalSwitch(target); };
    await assert.rejects(activatePreparedRelease({ base: f.base, workspace: f.workspace, preparationId: f.preparationId, adapter: f.adapter, verifyPrepared: f.verifyPrepared }), { code: 'PM2_SWITCH_FAILED' });
    assert.equal(f.adapter.current.cwd, f.paths.repo); assert.equal(await fs.readFile(`${f.paths.html}/index.html`, 'utf8'), '<title>legacy frontend</title>');
    assert.equal(await fs.readlink(`${f.paths.html}/istdbadmin`), f.paths.phpMyAdmin); await assert.rejects(fs.lstat(f.paths.active), { code: 'ENOENT' });
    await assert.rejects(fs.lstat(f.paths.lock), { code: 'ENOENT' });
});

test('frontend publication failure restores previous backend and complete frontend', linux, async t => {
    const f = await fixture(t), originalSwitch = f.adapter.switchTo.bind(f.adapter), originalCandidate = f.candidate;
    f.adapter.switchTo = async target => { await originalSwitch(target); if (target.cwd.includes('/releases/')) await fs.unlink(`${path.dirname(target.cwd)}/frontend/index.html`); };
    await assert.rejects(activatePreparedRelease({ base: f.base, workspace: f.workspace, preparationId: f.preparationId, adapter: f.adapter, verifyPrepared: f.verifyPrepared }));
    assert.equal(f.adapter.current.cwd, f.paths.repo); assert.equal(await fs.readFile(`${f.paths.html}/index.html`, 'utf8'), '<title>legacy frontend</title>');
    assert.equal(await fs.readFile(`${f.paths.html}/legacy.js`, 'utf8'), 'legacy');
    assert.equal(await fs.readlink(`${f.paths.html}/istdbadmin`), f.paths.phpMyAdmin); assert.ok(originalCandidate);
});

test('explicit rollback creates a new active generation from the verified backup', linux, async t => {
    const f = await fixture(t);
    const deployed = await activatePreparedRelease({ base: f.base, workspace: f.workspace, preparationId: f.preparationId, adapter: f.adapter, verifyPrepared: f.verifyPrepared });
    const rolled = await rollbackRelease({ base: f.base, backupId: deployed.backupId, adapter: f.adapter });
    assert.equal(rolled.active.generation, 2); assert.equal(rolled.active.previousGeneration, 1);
    assert.equal(await fs.readFile(`${rolled.active.pm2.cwd}/server.js`, 'utf8'), '// legacy server fixture\n');
    assert.equal(await fs.readFile(`${f.paths.html}/index.html`, 'utf8'), '<title>legacy frontend</title>');
    assert.equal(validateActive(JSON.parse(await fs.readFile(f.paths.active, 'utf8')), f.paths), true);
});

test('corrupt backup blocks rollback before changing the active runtime', linux, async t => {
    const f = await fixture(t);
    const deployed = await activatePreparedRelease({ base: f.base, workspace: f.workspace, preparationId: f.preparationId, adapter: f.adapter, verifyPrepared: f.verifyPrepared });
    const current = { ...f.adapter.current }, active = await fs.readFile(f.paths.active), html = await fs.readFile(`${f.paths.html}/index.html`);
    await fs.writeFile(`${f.paths.backups}/${deployed.backupId}/payload/backend/server.js`, '// corrupt fixture');
    await assert.rejects(rollbackRelease({ base: f.base, backupId: deployed.backupId, adapter: f.adapter }), { code: 'BACKUP_INTEGRITY_FAILED' });
    assert.deepEqual(f.adapter.current, current); assert.deepEqual(await fs.readFile(f.paths.active), active); assert.deepEqual(await fs.readFile(`${f.paths.html}/index.html`), html);
});

test('operation lock blocks concurrency and files outside authorized roots remain untouched', linux, async t => {
    const f = await fixture(t), outside = await fs.mkdtemp(path.join(os.tmpdir(), 'ist-operation-outside-'));
    t.after(() => fs.rm(outside, { recursive: true, force: true })); await write(`${outside}/sentinel`, 'untouched');
    await fs.mkdir(path.dirname(f.paths.lock), { recursive: true, mode: 0o700 }); await write(f.paths.lock, '{}');
    const before = await snapshot(outside);
    await assert.rejects(activatePreparedRelease({ base: f.base, workspace: f.workspace, preparationId: f.preparationId, adapter: f.adapter, verifyPrepared: f.verifyPrepared }), { code: 'OPERATION_LOCK_EXISTS' });
    assert.deepEqual(await snapshot(outside), before); assert.equal(await fs.readFile(f.paths.lock, 'utf8'), '{}');
});
