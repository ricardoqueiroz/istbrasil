import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as contract from '../scripts/deploy/production-contract.mjs';
import { inspectProduction, inspectProcesses, readAcl } from '../scripts/deploy/production-inspect.mjs';

const SHA = 'a'.repeat(40), TIME = '2026-10-08T12:00:00.000Z';
const linux = { skip: process.platform !== 'linux' || process.getuid?.() === 0 ? 'Requires Linux non-root POSIX fixtures' : false };
const copy = value => JSON.parse(JSON.stringify(value));
const identity = () => ({ uid: process.getuid?.() ?? 1000, gid: process.getgid?.() ?? 1000, exclusiveGroup: true, verified: true });
const envelope = record => ({ record, sha256: contract.sha256(JSON.stringify(record)) });
function journal(transactionId = randomUUID(), releaseId = randomUUID(), complete = true) {
    return envelope({ version: 1, transactionId, operation: 'deploy', generation: 1, releaseId,
        events: (complete ? contract.PHASES : ['started', 'prepared']).map(phase => ({ phase, at: TIME })) });
}
function lock(transactionId) {
    return { version: 1, transactionId, operation: 'deploy', token: randomUUID(), pid: 42, startTicks: '100', bootId: randomUUID(), createdAt: TIME };
}
function active(paths, releaseId, transactionId) {
    const backend = contract.releasePaths(paths, releaseId).backend;
    return { version: 1, generation: 1, transactionId, previousGeneration: null, confirmedAt: TIME,
        backend: { kind: 'release', releaseId, commitSha: SHA, manifestSha256: 'b'.repeat(64) },
        frontend: { releaseId, manifestSha256: 'b'.repeat(64), indexSha256: 'c'.repeat(64) },
        pm2: { name: 'ist-api', user: 'admin', home: paths.pm2Home, cwd: backend, script: `${backend}/server.js`, node: '20.19.6' } };
}

async function fixture(t, initialized = true) {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'ist-production-fixture-'));
    await fs.chmod(base, 0o700);
    t.after(() => fs.rm(base, { recursive: true, force: true }));
    const paths = { ...contract.canonicalPaths(base), phpMyAdmin: `${base}/fake-phpmyadmin` };
    const mkdir = async name => { await fs.mkdir(name, { recursive: true, mode: 0o700 }); await fs.chmod(name, 0o700); };
    const write = async (name, content) => { await fs.writeFile(name, content, { mode: 0o600 }); await fs.chmod(name, 0o600); };
    for (const name of [paths.repo, paths.html, paths.uploads, paths.private, paths.backendPhp, paths.phpMyAdmin]) await mkdir(name);
    // Fictitious labels only. No production configuration or private data.
    await write(paths.env, 'FIXTURE_LABEL=fictional-env\n');
    await write(paths.envBackup, 'FIXTURE_LABEL=fictional-backup\n');
    await write(`${paths.private}/fictional.txt`, 'fictional private placeholder');
    await write(`${paths.html}/index.html`, '<h1>fictional release</h1>');
    await fs.symlink(paths.phpMyAdmin, `${paths.html}/istdbadmin`);
    let current = null, manifest = null, release = null;
    if (initialized) {
        for (const name of [paths.admin, paths.releases, paths.backups, paths.state, paths.transactions, paths.logs]) await mkdir(name);
        current = active(paths, randomUUID(), randomUUID());
        release = contract.releasePaths(paths, current.backend.releaseId);
        await mkdir(release.root); await mkdir(release.backend); await mkdir(release.frontend);
        await write(`${release.backend}/server.js`, '// fictional backend; not imported\n');
        await write(`${release.backend}/package.json`, '{"name":"fictional"}');
        await write(`${release.backend}/package-lock.json`, '{"lockfileVersion":3}');
        await fs.copyFile(`${paths.html}/index.html`, `${release.frontend}/index.html`);
        await fs.symlink(paths.env, `${release.backend}/.env`);
        await fs.symlink(paths.private, `${release.backend}/istbrasil.private`);
        const entries = [];
        const visit = async (relative, filename) => {
            const stat = await fs.lstat(filename), entry = { path: relative, type: stat.isDirectory() ? 'directory' : stat.isSymbolicLink() ? 'symlink' : 'file', mode: stat.mode & 0o7777, uid: stat.uid, gid: stat.gid };
            if (entry.type === 'file') { entry.size = stat.size; entry.sha256 = contract.sha256(await fs.readFile(filename)); }
            if (entry.type === 'symlink') entry.target = await fs.readlink(filename);
            entries.push(entry);
            if (entry.type === 'directory') for (const name of await fs.readdir(filename)) await visit(`${relative}/${name}`, `${filename}/${name}`);
        };
        await visit('backend', release.backend); await visit('frontend', release.frontend);
        manifest = { version: 1, releaseId: current.backend.releaseId, declaredCommitSha: SHA, gitProvenance: null,
            runtime: { platform: 'linux', arch: process.arch, node: '20.19.6', abi: process.versions.modules }, entries };
        current.frontend.indexSha256 = entries.find(entry => entry.path === 'frontend/index.html').sha256;
        const saveManifest = async () => {
            const bytes = JSON.stringify(manifest);
            await write(release.manifest, bytes);
            current.backend.manifestSha256 = current.frontend.manifestSha256 = contract.sha256(bytes);
            await write(paths.active, JSON.stringify(current));
        };
        await saveManifest();
        await write(`${paths.transactions}/${current.transactionId}.json`, JSON.stringify(journal(current.transactionId, current.backend.releaseId)));
    }
    const processFacts = { proven: true, unknown: false, runtimePathsProven: true,
        pm2: current ? copy(current.pm2) : { name: 'ist-api', user: 'admin', home: paths.pm2Home, cwd: paths.repo, script: `${paths.repo}/server.js`, node: '20.19.6' } };
    const inspect = options => inspectProduction({ paths, identityReader: async () => identity(), aclReader: async () => 'basic', processReader: async () => processFacts, ancestorBoundary: base, ...options });
    return { base, paths, current, manifest, release, processFacts, inspect, write, mkdir,
        saveActive: () => write(paths.active, JSON.stringify(current)),
        saveManifest: async () => { const bytes = JSON.stringify(manifest); await write(release.manifest, bytes); current.backend.manifestSha256 = current.frontend.manifestSha256 = contract.sha256(bytes); await write(paths.active, JSON.stringify(current)); } };
}

async function snapshot(root) {
    const result = {};
    const visit = async name => {
        const stat = await fs.lstat(name), relative = path.relative(root, name);
        result[relative] = { mode: stat.mode, uid: stat.uid, gid: stat.gid, ino: stat.ino, mtime: stat.mtimeMs,
            value: stat.isFile() ? contract.sha256(await fs.readFile(name)) : stat.isSymbolicLink() ? await fs.readlink(name) : null };
        if (stat.isDirectory()) for (const child of await fs.readdir(name)) await visit(path.join(name, child));
    };
    await visit(root);
    return result;
}

test('canonical paths keep original repo/public/persistent locations', () => {
    const p = contract.PATHS;
    assert.equal(p.repo, '/var/www/istbrasil.org.br/backend-node/istbrasil');
    assert.equal(p.html, '/var/www/istbrasil.org.br/html');
    assert.equal(p.private, `${p.repo}/istbrasil.private`);
    assert.equal(p.active, `${p.base}/.deploy/state/active.json`);
    assert.equal(p.envOld, `${p.repo}/.env_old`);
    assert.equal(contract.RESERVE_BYTES, 10737418240n);
});
for (const value of ['/', '/tmp/../etc', '/tmp/', '/tmp\\other', '/tmp\nother', 'relative']) test(`reject unsafe base ${JSON.stringify(value)}`, () => assert.throws(() => contract.canonicalPaths(value)));
test('release IDs and relative traversal cannot escape canonical roots', () => {
    assert.throws(() => contract.releasePaths(contract.PATHS, '../outside'));
    for (const name of ['backend/../.env', '/backend/server.js', 'backend//x', 'backend/x:y', 'backend/x\\y', 'frontend/./index.html']) assert.equal(contract.relativeEntry(name), false);
});
test('only two runtime bindings and internal relative package links are approved', () => {
    const p = contract.PATHS, r = contract.releasePaths(p, randomUUID());
    assert.equal(contract.approvedLink(p, r, 'backend/.env', p.env), true);
    assert.equal(contract.approvedLink(p, r, 'backend/istbrasil.private', p.private), true);
    assert.equal(contract.approvedLink(p, r, 'backend/.env.backup', p.envBackup), false);
    assert.equal(contract.approvedLink(p, r, 'backend/node_modules/.bin/tool', '../tool/main.js'), true);
    for (const target of ['/usr/bin/tool', '../../../.env', '../../../../outside']) assert.equal(contract.approvedLink(p, r, 'backend/node_modules/.bin/tool', target), false);
});
test('ACL parser refuses named users/groups, mask, defaults and malformed output', () => {
    assert.equal(contract.parseAcl('# file: fixture\nuser::rw-\ngroup::---\nother::---\n'), 'basic');
    for (const extra of ['user:123:rw-', 'group:123:r--', 'mask::r--', 'default:user::rwx', 'other::rwx']) assert.equal(contract.parseAcl(`user::rw-\ngroup::---\nother::---\n${extra}`), 'extended');
    assert.equal(contract.parseAcl(null), 'unknown');
});
test('600/640 require owner/group and verified exclusive group for 640', () => {
    const id = identity(), policy = { type: 'file', private: true, config: true, modes: [0o600, 0o640] };
    const meta = { type: 'file', mode: 0o600, uid: id.uid, gid: id.gid, nlink: 1, acl: 'basic' };
    assert.equal(contract.checkMetadata(meta, policy, id), 'safe');
    assert.equal(contract.checkMetadata({ ...meta, mode: 0o640 }, policy, id), 'safe');
    assert.equal(contract.checkMetadata({ ...meta, mode: 0o640 }, policy, { ...id, exclusiveGroup: null }), 'unknown');
    for (const changed of [{ mode: 0o644 }, { mode: 0o640, uid: id.uid + 1 }, { gid: id.gid + 1 }, { nlink: 2 }, { acl: 'extended' }, { mode: 0o4600 }]) assert.equal(contract.checkMetadata({ ...meta, ...changed }, policy, id), 'unsafe');
});
test('strict active schema rejects wrong PM2 identity, unknown keys and skipped generation', () => {
    const good = active(contract.PATHS, randomUUID(), randomUUID());
    assert.equal(contract.validateActive(good), true);
    for (const mutate of [v => v.pm2.user = 'root', v => v.pm2.cwd = contract.PATHS.repo, v => v.password = 'fictional', v => v.previousGeneration = 10, v => v.backend.releaseId = '../bad', v => v.frontend.indexSha256 = 'x']) {
        const value = copy(good); mutate(value); assert.equal(contract.validateActive(value), false);
    }
});
test('journal verifies SHA-256 and requires ordered transitions before confirmation', () => {
    const good = journal(); assert.equal(contract.validateJournal(good), true);
    const bad = copy(good); bad.record.events[1].phase = 'confirmed';
    assert.equal(contract.validateJournal(bad), false);
    assert.equal(contract.validateJournal(envelope(bad.record)), false);
    const failed = copy(good.record); failed.events = [{ phase: 'started', at: TIME }, { phase: 'failed', at: TIME }];
    assert.equal(contract.validateJournal(envelope(failed)), true);
});
test('lock requires token, transaction, PID start and boot identity; age is not recovery permission', () => {
    const good = lock(randomUUID()); assert.equal(contract.validateLock(good), true);
    const bad = copy(good); delete bad.startTicks; assert.equal(contract.validateLock(bad), false);
    assert.equal(contract.validateLock({ ...good, pid: -1 }), false);
});
for (const [status, observation] of [
    ['UNINITIALIZED', { activePresent: false, legacy: true }], ['CONSISTENT', { activePresent: true, consistent: true }], ['IN_PROGRESS', { inProgress: true }],
    ['RECOVERY_REQUIRED', { recoveryRequired: true }], ['UNKNOWN_PROCESS', { unknownProcess: true }], ['INCONCLUSIVE', { inconclusive: true }], ['INVALID', { invalid: true }]
]) test(`classification ${status} never authorizes deploy/rollback`, () => {
    const report = contract.classify(observation); assert.equal(report.status, status); assert.equal(report.deployAuthorized, false); assert.equal(report.rollbackAuthorized, false);
});
test('unsafe/unknown evidence wins over claimed consistency and live transaction', () => {
    assert.equal(contract.classify({}).status, 'INCONCLUSIVE');
    assert.equal(contract.classify({ consistent: true, activePresent: true, invalid: true, inProgress: true }).status, 'INVALID');
    assert.equal(contract.classify({ inProgress: true, inconclusive: true }).status, 'INCONCLUSIVE');
    assert.equal(contract.classify({ recoveryRequired: true, inconclusive: true }).status, 'RECOVERY_REQUIRED');
});
test('declared SHA and stored Git claim never become independent provenance proof', () => {
    const report = contract.classify({ declaredSha: SHA, storedGitClaim: true, consistent: true, activePresent: true });
    assert.equal(report.provenance.declaredSha, SHA); assert.equal(report.provenance.storedGitClaim, true); assert.equal(report.provenance.independentlyVerified, false);
});
test('capacity costs aggregate per filesystem and reserve is not free-space evidence', () => {
    assert.equal(contract.assessCapacity([], null).status, 'UNKNOWN');
    const budgets = [{ device: '1', candidate: '100', backup: '200', restore: '300', temporary: '400', inodes: '20' }];
    const fs = [{ device: '1', availableBytes: (contract.RESERVE_BYTES + 1000n).toString(), availableInodes: '20' }];
    assert.equal(contract.assessCapacity(fs, budgets).sufficient, true);
    assert.equal(contract.assessCapacity(fs, [...budgets, ...budgets]).status, 'INSUFFICIENT');
    assert.equal(contract.assessCapacity([{ ...fs[0], availableInodes: '19' }], budgets).sufficient, false);
    assert.equal(contract.assessCapacity(fs, [{ ...budgets[0], device: 'other' }]).status, 'UNKNOWN');
    assert.equal(contract.assessCapacity(fs, [{ ...budgets[0], backup: null }]).status, 'UNKNOWN');
});

test('legacy inspection stays UNINITIALIZED, creates nothing and does not read protected content', linux, async t => {
    const f = await fixture(t, false), before = await snapshot(f.base);
    const originalOpen = fs.open;
    t.mock.method(fs, 'open', async (filename, flags, ...args) => {
        assert.ok(![f.paths.env, f.paths.envBackup].includes(filename));
        assert.ok(!String(filename).startsWith(`${f.paths.private}/`));
        assert.equal(flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC), 0);
        return originalOpen(filename, flags, ...args);
    });
    for (const name of ['mkdir', 'writeFile', 'appendFile', 'rename', 'unlink', 'rm', 'chmod', 'chown', 'symlink', 'link']) t.mock.method(fs, name, () => { throw new Error(`MUTATION_${name}`); });
    const report = await f.inspect();
    assert.equal(report.status, 'UNINITIALIZED'); assert.equal(report.legacy, true);
    assert.deepEqual(await snapshot(f.base), before);
    assert.equal(report.capacity.status, 'UNKNOWN');
    t.mock.restoreAll();
});
test('real fixture hashes, journal, PM2 observations and published tree yield CONSISTENT', linux, async t => {
    const f = await fixture(t), before = await snapshot(f.base), report = await f.inspect();
    assert.equal(report.status, 'CONSISTENT', JSON.stringify(report)); assert.equal(report.deployAuthorized, false);
    assert.equal(report.provenance.independentlyVerified, false);
    assert.deepEqual(await snapshot(f.base), before);
});
test('.env_old is optional but must be protected when present', linux, async t => {
    const f = await fixture(t); assert.equal((await f.inspect()).status, 'CONSISTENT');
    await f.write(f.paths.envOld, 'FIXTURE_LABEL=old'); assert.equal((await f.inspect()).status, 'CONSISTENT');
    await fs.chmod(f.paths.envOld, 0o644); assert.equal((await f.inspect()).status, 'INVALID');
});
test('missing ACL tool/evidence is INCONCLUSIVE, extended ACL is INVALID', linux, async t => {
    const f = await fixture(t);
    assert.equal((await f.inspect({ aclReader: async () => 'unknown' })).status, 'INCONCLUSIVE');
    assert.equal((await f.inspect({ aclReader: async () => 'extended' })).status, 'INVALID');
    assert.equal(await readAcl(`${f.base}/does-not-exist`), 'unknown');
});
test('unknown listener and insufficient process visibility are conservative', linux, async t => {
    const f = await fixture(t);
    f.processFacts.unknown = true; assert.equal((await f.inspect()).status, 'UNKNOWN_PROCESS');
    f.processFacts.unknown = false; f.processFacts.proven = false; assert.equal((await f.inspect()).status, 'INCONCLUSIVE');
});
test('effective dotenv/products runtime paths are not guessed', linux, async t => {
    const f = await fixture(t); f.processFacts.runtimePathsProven = false;
    const report = await f.inspect(); assert.equal(report.status, 'INCONCLUSIVE'); assert.ok(report.issues.includes('EFFECTIVE_RUNTIME_PATHS_NOT_PROVEN'));
});
test('PM2/backend disagreement requires recovery without modifying state', linux, async t => {
    const f = await fixture(t); f.processFacts.pm2.cwd = f.paths.repo;
    const before = await snapshot(f.base); assert.equal((await f.inspect()).status, 'RECOVERY_REQUIRED'); assert.deepEqual(await snapshot(f.base), before);
});
test('partial frontend publication/unknown public entries require recovery', linux, async t => {
    const f = await fixture(t); await f.write(`${f.paths.html}/index.html`, 'fictional interrupted publication');
    assert.equal((await f.inspect()).status, 'RECOVERY_REQUIRED');
    await fs.copyFile(`${f.release.frontend}/index.html`, `${f.paths.html}/index.html`);
    await f.write(`${f.paths.html}/unmanaged.txt`, 'fixture'); assert.equal((await f.inspect()).status, 'RECOVERY_REQUIRED');
});
test('phpMyAdmin symlink remains unchanged and wrong target is rejected', linux, async t => {
    const f = await fixture(t); await f.inspect(); assert.equal(await fs.readlink(`${f.paths.html}/istdbadmin`), f.paths.phpMyAdmin);
    await fs.unlink(`${f.paths.html}/istdbadmin`); await fs.symlink('/fictional/wrong', `${f.paths.html}/istdbadmin`);
    assert.equal((await f.inspect()).status, 'INVALID');
});
test('release corruption, unexpected payload and manifest tampering are rejected', linux, async t => {
    const f = await fixture(t); await f.write(`${f.release.backend}/server.js`, 'corrupt fictional code');
    assert.equal((await f.inspect()).status, 'INVALID');
});
test('provenance claim is displayed as a claim even with intact content hashes', linux, async t => {
    const f = await fixture(t); f.manifest.gitProvenance = { commitSha: SHA, treeSha: 'd'.repeat(40), verifiedAt: TIME }; await f.saveManifest();
    const report = await f.inspect(); assert.equal(report.status, 'CONSISTENT'); assert.equal(report.provenance.storedGitClaim, true); assert.equal(report.provenance.independentlyVerified, false);
});
test('release schema forbids protected payloads, runtime link expansion and escaping package links', linux, async t => {
    const f = await fixture(t); assert.equal(contract.validateManifest(f.manifest, f.paths), true);
    for (const entry of [
        { path: 'backend/.env.backup', type: 'file', mode: 0o600, uid: identity().uid, gid: identity().gid, size: 1, sha256: 'e'.repeat(64) },
        { path: 'backend/unknown', type: 'symlink', mode: 0o777, uid: identity().uid, gid: identity().gid, target: f.paths.private }
    ]) assert.equal(contract.validateManifest({ ...f.manifest, entries: [...f.manifest.entries, entry] }, f.paths), false);
    const bad = copy(f.manifest); bad.entries.find(entry => entry.path === 'backend/.env').target = f.paths.envBackup;
    assert.equal(contract.validateManifest(bad, f.paths), false);
});
test('symlinked administrative ancestor is refused before reading foreign metadata', linux, async t => {
    const f = await fixture(t); await fs.rename(f.paths.state, `${f.paths.admin}/foreign-state`); await fs.symlink(`${f.paths.admin}/foreign-state`, f.paths.state);
    const before = await snapshot(f.base); assert.equal((await f.inspect()).status, 'INVALID'); assert.deepEqual(await snapshot(f.base), before);
});
test('valid live lock and matching pending journal yield IN_PROGRESS', linux, async t => {
    const f = await fixture(t), pending = journal(randomUUID(), randomUUID(), false);
    pending.record.generation = 2; pending.sha256 = contract.sha256(JSON.stringify(pending.record));
    await f.write(`${f.paths.transactions}/${pending.record.transactionId}.json`, JSON.stringify(pending));
    await f.write(f.paths.lock, JSON.stringify(lock(pending.record.transactionId))); f.processFacts.liveLock = true;
    assert.equal((await f.inspect()).status, 'IN_PROGRESS');
});
test('SIGKILL-style orphan lock remains present and requires manual recovery', linux, async t => {
    const f = await fixture(t); await f.write(f.paths.lock, JSON.stringify(lock(f.current.transactionId))); f.processFacts.orphanLock = true;
    const before = await snapshot(f.base), report = await f.inspect();
    assert.equal(report.status, 'RECOVERY_REQUIRED'); assert.ok(report.issues.includes('ABANDONED_LOCK_REQUIRES_REVIEW')); assert.deepEqual(await snapshot(f.base), before);
});
test('inaccessible lock owner is INCONCLUSIVE and never considered abandoned/safe', linux, async t => {
    const f = await fixture(t); await f.write(f.paths.lock, JSON.stringify(lock(f.current.transactionId))); f.processFacts.lockUnknown = true;
    assert.equal((await f.inspect()).status, 'INCONCLUSIVE');
    assert.ok(await fs.lstat(f.paths.lock));
});
test('malformed lock is INVALID and remains untouched', linux, async t => {
    const f = await fixture(t); await f.write(f.paths.lock, '{invalid fixture');
    assert.equal((await f.inspect()).status, 'INVALID'); assert.equal(await fs.readFile(f.paths.lock, 'utf8'), '{invalid fixture');
});
test('unconfirmed transaction with no lock requires recovery; no automatic journal correction', linux, async t => {
    const f = await fixture(t), pending = journal(randomUUID(), randomUUID(), false);
    await f.write(`${f.paths.transactions}/${pending.record.transactionId}.json`, JSON.stringify(pending));
    const before = await snapshot(f.base); assert.equal((await f.inspect()).status, 'RECOVERY_REQUIRED'); assert.deepEqual(await snapshot(f.base), before);
});
test('failed journal and terminal journal still associated with a live lock require review', linux, async t => {
    const f = await fixture(t), failed = journal(randomUUID(), randomUUID(), false);
    failed.record.events.push({ phase: 'failed', at: TIME }); failed.sha256 = contract.sha256(JSON.stringify(failed.record));
    await f.write(`${f.paths.transactions}/${failed.record.transactionId}.json`, JSON.stringify(failed));
    await f.write(f.paths.lock, JSON.stringify(lock(failed.record.transactionId))); f.processFacts.liveLock = true;
    assert.equal((await f.inspect()).status, 'RECOVERY_REQUIRED');
});
test('corrupt journal hash and missing active confirmation cannot be declared consistent', linux, async t => {
    const f = await fixture(t), filename = `${f.paths.transactions}/${f.current.transactionId}.json`;
    const value = journal(f.current.transactionId, f.current.backend.releaseId); value.sha256 = 'f'.repeat(64);
    await f.write(filename, JSON.stringify(value)); assert.equal((await f.inspect()).status, 'INVALID');
    await fs.unlink(filename); assert.equal((await f.inspect()).status, 'RECOVERY_REQUIRED');
});
test('partial administrative infrastructure is not adopted as a clean legacy installation', linux, async t => {
    const f = await fixture(t, false); await f.mkdir(f.paths.admin);
    assert.equal((await f.inspect()).status, 'RECOVERY_REQUIRED');
});
test('advisory flock existence never implies it is free and is never acquired', linux, async t => {
    const f = await fixture(t); await f.write(f.paths.flock, '');
    const before = await snapshot(f.base); assert.equal((await f.inspect()).status, 'INCONCLUSIVE'); assert.deepEqual(await snapshot(f.base), before);
});
test('report is sanitized: no arbitrary metadata, exceptions, config or private contents', linux, async t => {
    const f = await fixture(t); f.current.extra = 'FICTIONAL_NEVER_PRINT'; await f.saveActive();
    const report = await f.inspect({ processReader: async () => { throw new Error('FICTIONAL_NEVER_PRINT'); } });
    const output = JSON.stringify(report); assert.equal(report.status, 'INVALID'); assert.ok(!output.includes('FICTIONAL_NEVER_PRINT')); assert.ok(!output.includes('fictional-env')); assert.ok(!output.includes('private placeholder'));
});
test('production backup schema and seal exclude configs/private bindings', linux, async t => {
    const f = await fixture(t), id = randomUUID();
    const manifest = { version: 1, backupId: id, sourceGeneration: 1, declaredCommitSha: SHA, runtime: f.manifest.runtime,
        entries: f.manifest.entries.filter(entry => !['backend/.env', 'backend/istbrasil.private'].includes(entry.path)) };
    assert.equal(contract.validateBackupManifest(manifest, f.paths), true);
    assert.equal(contract.validateBackupManifest({ ...manifest, entries: f.manifest.entries }, f.paths), false);
    assert.equal(contract.validateBackupSeal({ version: 1, backupId: id, manifestSha256: 'a'.repeat(64), transactionId: randomUUID() }), true);
});
test('read-only production archive validation detects real payload corruption', linux, async t => {
    const f = await fixture(t), id = randomUUID(), root = `${f.paths.backups}/${id}`, payload = `${root}/payload`;
    await f.mkdir(root); await f.mkdir(payload);
    await fs.cp(f.release.backend, `${payload}/backend`, { recursive: true, dereference: false, verbatimSymlinks: true });
    await fs.cp(f.release.frontend, `${payload}/frontend`, { recursive: true });
    await fs.unlink(`${payload}/backend/.env`); await fs.unlink(`${payload}/backend/istbrasil.private`);
    const manifest = { version: 1, backupId: id, sourceGeneration: 1, declaredCommitSha: SHA, runtime: f.manifest.runtime,
        entries: f.manifest.entries.filter(entry => !['backend/.env', 'backend/istbrasil.private'].includes(entry.path)) };
    const bytes = JSON.stringify(manifest); await f.write(`${root}/manifest.json`, bytes);
    await f.write(`${root}/READY`, JSON.stringify({ version: 1, backupId: id, manifestSha256: contract.sha256(bytes), transactionId: f.current.transactionId }));
    assert.equal((await f.inspect()).status, 'CONSISTENT');
    await f.write(`${payload}/backend/server.js`, 'fixture corruption');
    const before = await snapshot(f.base); assert.equal((await f.inspect()).status, 'INVALID'); assert.deepEqual(await snapshot(f.base), before);
});
test('production contract is integrated only through the gated deployment entrypoint', async () => {
    const deploy = await fs.readFile(new URL('../deploy.sh', import.meta.url), 'utf8');
    assert.ok(deploy.includes('production-contract.mjs')); assert.ok(!deploy.includes('production-inspect.mjs'));
    assert.match(deploy, /PRODUCTION_APPROVED/); assert.match(deploy, /Rollback unavailable/);
    assert.match(deploy, /deployment-runner\.mjs/);
    for (const name of ['production-contract.mjs', 'production-inspect.mjs']) {
        const source = await fs.readFile(new URL(`../scripts/deploy/${name}`, import.meta.url), 'utf8');
        assert.ok(!/^import .*['"].*(?:server\.js|db\.js|backup\.mjs|state\.mjs)['"]/m.test(source));
    }
});

test('metadata changed during inspection cannot produce CONSISTENT', linux, async t => {
    const f = await fixture(t);
    const report = await f.inspect({ processReader: async () => {
        await f.write(f.paths.lock, JSON.stringify(lock(randomUUID())));
        return f.processFacts;
    } });
    assert.equal(report.status, 'INCONCLUSIVE'); assert.ok(report.issues.includes('INSPECTION_CHANGED'));
});
test('release metadata SHA mismatch and unknown release payload are both INVALID', linux, async t => {
    const f = await fixture(t);
    f.current.backend.manifestSha256 = 'f'.repeat(64); await f.saveActive(); assert.equal((await f.inspect()).status, 'INVALID');
    await f.saveManifest(); await f.write(`${f.release.backend}/unexpected.txt`, 'fixture'); assert.equal((await f.inspect()).status, 'INVALID');
});
test('600/640 real POSIX modes and foreign ownership observations are not interchangeable', linux, async t => {
    const f = await fixture(t); await fs.chmod(f.paths.env, 0o640);
    assert.equal((await f.inspect()).status, 'CONSISTENT');
    assert.equal((await f.inspect({ identityReader: async () => ({ ...identity(), exclusiveGroup: false }) })).status, 'INVALID');
    assert.equal((await f.inspect({ identityReader: async () => ({ ...identity(), exclusiveGroup: null }) })).status, 'INCONCLUSIVE');
});
test('missing daemon evidence from the real read-only collector cannot prove a process', linux, async t => {
    const f = await fixture(t);
    const processes = await inspectProcesses({ ...f.paths, pm2Home: `${f.base}/fictional-missing-pm2` }, identity(), null);
    assert.equal(processes.proven, false); assert.equal(processes.pm2, null);
    assert.equal((await f.inspect({ processReader: async () => processes })).status, 'INCONCLUSIVE');
});
test('invalid production archive inputs return false without guessing a schema', () => {
    for (const entries of [null, {}, [null]]) assert.equal(contract.validateBackupManifest({ version: 1, backupId: randomUUID(), sourceGeneration: 0, declaredCommitSha: SHA, runtime: {}, entries }), false);
});
