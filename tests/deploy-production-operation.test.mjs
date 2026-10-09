import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { canonicalPaths, validateActive, validateJournal } from '../scripts/deploy/production-contract.mjs';
import { inspectProduction } from '../scripts/deploy/production-inspect.mjs';
import { activatePreparedRelease, rollbackRelease } from '../scripts/deploy/production-operation.mjs';

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
    assert.ok(await fs.lstat(`${f.paths.backups}/${result.backupId}/READY`));
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
