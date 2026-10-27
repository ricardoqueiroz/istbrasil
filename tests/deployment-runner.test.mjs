import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { canonicalPaths } from '../scripts/deploy/production-contract.mjs';
import { prepareDeployment, activateDeployment, prepareAndActivate, executeRollback, dispatchCli } from '../scripts/deploy/deployment-runner.mjs';

const linux = { skip: process.platform !== 'linux' || process.getuid?.() === 0 ? 'Linux non-root required' : false };
const SHA = 'a'.repeat(40);
const PACKAGE_SHA = 'b'.repeat(64);
const hash = value => createHash('sha256').update(value).digest('hex');

test('CLI routes Git and package preparation without activation side effects', async () => {
    const base = '/var/www/istbrasil.org.br', preparationId = randomUUID(), calls = [];
    const prepare = async input => { calls.push(input); return { preparationId,
        source: input.packagePath ? { type: 'package' } : { type: 'git' }, integrity: { manifestSha256: PACKAGE_SHA, entries: 2 } }; };
    const git = await dispatchCli(['prepare-git', SHA], { base, prepare });
    const packagePath = '/srv/releases/ist.tar';
    const packaged = await dispatchCli(['prepare-package', packagePath, PACKAGE_SHA], { base, prepare });
    assert.deepEqual(calls, [
        { base, repo: `${base}/backend-node/istbrasil`, targetSha: SHA },
        { base, packagePath, expectedSha256: PACKAGE_SHA },
    ]);
    assert.equal(git.operation, 'prepare'); assert.equal(git.preparationId, preparationId); assert.equal(git.source.type, 'git');
    assert.equal(packaged.operation, 'prepare'); assert.equal(packaged.source.type, 'package');
});

test('CLI routes activation and preserves legacy deploy and rollback contracts', async () => {
    const base = '/var/www/istbrasil.org.br', id = randomUUID(), calls = [];
    const result = { transactionId: randomUUID(), backupId: randomUUID(), active: { backend: { releaseId: id }, generation: 4 } };
    const dependencies = {
        base,
        activate: async input => { calls.push(['activate', input]); return result; },
        deploy: async input => { calls.push(['deploy', input]); return result; },
        rollback: async input => { calls.push(['rollback', input]); return result; },
    };
    for (const [args, operation] of [[['activate', id], 'activate'], [['deploy', SHA], 'deploy'], [['rollback', id], 'rollback']]) {
        const output = await dispatchCli(args, dependencies);
        assert.equal(output.operation, operation); assert.equal(output.releaseId, id); assert.equal(output.generation, 4);
    }
    assert.deepEqual(calls, [
        ['activate', { base, preparationId: id }],
        ['deploy', { base, repo: `${base}/backend-node/istbrasil`, targetSha: SHA }],
        ['rollback', { base, backupId: id }],
    ]);
});

test('CLI rejects missing, ambiguous and malformed arguments before delegation', async () => {
    let reached = false; const dependency = async () => { reached = true; };
    for (const args of [[], ['prepare-git'], ['prepare-git', 'bad'], ['prepare-package', 'relative.tar', PACKAGE_SHA],
        ['prepare-package', '/release.tar', 'bad'], ['activate', 'bad'], ['deploy', SHA, 'extra'], ['rollback']]) {
        await assert.rejects(dispatchCli(args, { prepare: dependency, activate: dependency, deploy: dependency, rollback: dependency }),
            { code: 'USAGE_INVALID' });
    }
    assert.equal(reached, false);
});

async function fixture(t) {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'ist-runner-base-'));
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'ist-runner-workspace-'));
    await fs.chmod(base, 0o700); await fs.chmod(workspace, 0o700);
    t.after(() => fs.rm(base, { recursive: true, force: true }));
    t.after(() => fs.rm(workspace, { recursive: true, force: true }));
    const paths = canonicalPaths(base);
    await fs.mkdir(paths.state, { recursive: true, mode: 0o700 });
    await fs.writeFile(`${paths.state}/PRODUCTION_APPROVED`, 'IST_DEPLOY_PRODUCTION_APPROVED_V1\n', { mode: 0o600 });
    const calls = [], exportId = randomUUID(), preparationId = randomUUID();
    const dependencies = {
        createWorkspace: async () => workspace,
        cloneRepository: async (...args) => { calls.push(['clone', ...args]); },
        exporter: async input => { calls.push(['export', input]); return { record: { exportId } }; },
        preparer: async input => { calls.push(['prepare', input]); return { manifest: { preparationId } }; },
        activator: async input => { calls.push(['activate', input]); return { transactionId: randomUUID(), backupId: randomUUID(), active: { backend: { releaseId: randomUUID() }, generation: 1 } }; },
    };
    return { base, paths, workspace, calls, exportId, preparationId, dependencies };
}

function preparationDependencies(f, sourceType = 'git') {
    const packageId = randomUUID(), entries = [{ path: 'backend', type: 'directory', mode: 0o700 }];
    const manifest = sourceType === 'package'
        ? { preparationId: f.preparationId, sourceType: 'package', packageId, packageSha256: PACKAGE_SHA, releaseVersion: 'release-27-10',
            commitSha: SHA, treeSha: SHA, entries }
        : { preparationId: f.preparationId, exportId: f.exportId, commitSha: SHA, treeSha: SHA, entries };
    const persistent = new Map([['previous-preparation', { protected: true }]]);
    return {
        persistent, manifest,
        createWorkspace: async () => { f.calls.push(['workspace']); return f.workspace; },
        cleanupWorkspace: async workspace => { f.calls.push(['cleanup', workspace]); await fs.rm(workspace, { recursive: true, force: false }); },
        cloneRepository: async (...args) => { f.calls.push(['clone', ...args]); },
        exporter: async input => { f.calls.push(['export', input]); return { record: { exportId: f.exportId } }; },
        importer: async input => { f.calls.push(['import', input]); return { record: { packageId } }; },
        preparer: async input => { f.calls.push(['prepare', input]); return { manifest }; },
        verifyPrepared: async input => { f.calls.push(['verify-workspace', input]); return manifest; },
        publishPrepared: async input => { f.calls.push(['publish', input]); persistent.set(f.preparationId, manifest); return { preparationId: f.preparationId, manifest }; },
        verifyPersistent: async input => { f.calls.push(['verify-persistent', input]); return persistent.get(f.preparationId); },
    };
}

test('persistent Git preparation is verified twice, reports integrity and has no activation effects', linux, async t => {
    const f = await fixture(t), dependencies = preparationDependencies(f), repo = `${f.base}/repository`;
    const result = await prepareDeployment({ base: f.base, repo, targetSha: SHA, ...dependencies });
    assert.deepEqual(f.calls.map(call => call[0]), ['workspace', 'clone', 'export', 'prepare', 'verify-workspace', 'publish', 'verify-persistent', 'cleanup']);
    assert.deepEqual(result, { preparationId: f.preparationId,
        source: { type: 'git', exportId: f.exportId, commitSha: SHA, treeSha: SHA },
        integrity: { manifestSha256: hash(JSON.stringify(dependencies.manifest)), entries: 1 } });
    assert.equal(dependencies.persistent.get('previous-preparation').protected, true);
    assert.equal(f.calls.some(call => ['activate', 'snapshot', 'pm2', 'frontend', 'nginx', 'migration'].includes(call[0])), false);
    await assert.rejects(fs.lstat(f.workspace), { code: 'ENOENT' });
});

test('persistent package preparation retains package provenance without claiming independent Git verification', linux, async t => {
    const f = await fixture(t), dependencies = preparationDependencies(f, 'package'), packagePath = `${f.base}/release.tar`;
    const result = await prepareDeployment({ base: f.base, packagePath, expectedSha256: PACKAGE_SHA, allowRegistry: false, ...dependencies });
    assert.deepEqual(f.calls.map(call => call[0]), ['workspace', 'import', 'prepare', 'verify-workspace', 'publish', 'verify-persistent', 'cleanup']);
    assert.equal(f.calls[1][1].expectedSha256, PACKAGE_SHA);
    assert.equal(f.calls[2][1].packageId, dependencies.manifest.packageId);
    assert.equal(f.calls[2][1].allowRegistry, false);
    assert.deepEqual(result.source, { type: 'package', packageId: dependencies.manifest.packageId, packageSha256: PACKAGE_SHA,
        releaseVersion: 'release-27-10', declaredCommitSha: SHA, declaredTreeSha: SHA });
    await assert.rejects(fs.lstat(f.workspace), { code: 'ENOENT' });
});

test('persistent preparation rejects missing, partial or ambiguous origins before creating a workspace', linux, async t => {
    const f = await fixture(t); let reached = false;
    const createWorkspace = async () => { reached = true; return f.workspace; };
    for (const input of [
        {}, { repo: `${f.base}/repository` }, { targetSha: SHA }, { packagePath: `${f.base}/release.tar` }, { expectedSha256: PACKAGE_SHA },
        { repo: `${f.base}/repository`, targetSha: SHA, packagePath: `${f.base}/release.tar`, expectedSha256: PACKAGE_SHA },
    ]) await assert.rejects(prepareDeployment({ base: f.base, createWorkspace, ...input }), { code: 'PREPARATION_ARGUMENT_INVALID' });
    assert.equal(reached, false);
});

test('persistent preparation failure removes only its temporary workspace and preserves older preparations', linux, async t => {
    const f = await fixture(t), dependencies = preparationDependencies(f), original = Object.assign(new Error('build failed'), { code: 'BUILD_FAILED' });
    dependencies.preparer = async input => { f.calls.push(['prepare', input]); throw original; };
    await assert.rejects(prepareDeployment({ base: f.base, repo: `${f.base}/repository`, targetSha: SHA, ...dependencies }), error => error === original);
    assert.equal(dependencies.persistent.get('previous-preparation').protected, true);
    assert.equal(dependencies.persistent.has(f.preparationId), false);
    assert.deepEqual(f.calls.map(call => call[0]), ['workspace', 'clone', 'export', 'prepare', 'cleanup']);
    await assert.rejects(fs.lstat(f.workspace), { code: 'ENOENT' });
});

test('persistent publication failure cleans the workspace and does not remove prior preparations', linux, async t => {
    const f = await fixture(t), dependencies = preparationDependencies(f), original = Object.assign(new Error('publication failed'), { code: 'PUBLICATION_FAILED' });
    dependencies.publishPrepared = async input => { f.calls.push(['publish', input]); throw original; };
    await assert.rejects(prepareDeployment({ base: f.base, repo: `${f.base}/repository`, targetSha: SHA, ...dependencies }), error => error === original);
    assert.equal(dependencies.persistent.get('previous-preparation').protected, true);
    assert.deepEqual(f.calls.map(call => call[0]), ['workspace', 'clone', 'export', 'prepare', 'verify-workspace', 'publish', 'cleanup']);
    await assert.rejects(fs.lstat(f.workspace), { code: 'ENOENT' });
});

test('persistent activation requires approval, performs a diagnostic verification and delegates only the preparationId', linux, async t => {
    const f = await fixture(t), calls = [], expected = { transactionId: randomUUID(), active: { backend: { releaseId: f.preparationId } } };
    const adapter = { synthetic: true };
    const result = await activateDeployment({ base: f.base, preparationId: f.preparationId, adapter,
        verifyPersistent: async input => { calls.push(['verify', input]); return { preparationId: f.preparationId }; },
        activator: async input => { calls.push(['activate', input]); return expected; } });
    assert.equal(result, expected); assert.deepEqual(calls.map(call => call[0]), ['verify', 'activate']);
    assert.equal(calls[0][1].paths.preparations, f.paths.preparations); assert.equal(calls[0][1].preparationId, f.preparationId);
    assert.deepEqual(calls[1][1], { base: f.base, preparationId: f.preparationId, adapter });
});

test('persistent activation rejects invalid IDs and missing approval before verification or activation', linux, async t => {
    const f = await fixture(t); let reached = false;
    await assert.rejects(activateDeployment({ base: f.base, preparationId: 'invalid',
        verifyPersistent: async () => { reached = true; }, activator: async () => { reached = true; } }), { code: 'ACTIVATION_ARGUMENT_INVALID' });
    await fs.unlink(`${f.paths.state}/PRODUCTION_APPROVED`);
    await assert.rejects(activateDeployment({ base: f.base, preparationId: f.preparationId,
        verifyPersistent: async () => { reached = true; }, activator: async () => { reached = true; } }), { code: 'PRODUCTION_APPROVAL_MISSING' });
    assert.equal(reached, false);
});

test('deploy orchestration preserves order, forwards the sealed IDs and removes a successful workspace', linux, async t => {
    const f = await fixture(t), repo = `${f.base}/repository`;
    const result = await prepareAndActivate({ base: f.base, repo, targetSha: SHA, adapter: {}, ...f.dependencies });
    assert.equal(result.active.generation, 1);
    assert.deepEqual(f.calls.map(call => call[0]), ['clone', 'export', 'prepare', 'activate']);
    assert.deepEqual(f.calls[0].slice(1), [repo, f.workspace, SHA]);
    assert.equal(f.calls[1][1].approvedMainSha, SHA);
    assert.equal(f.calls[2][1].exportId, f.exportId);
    assert.equal(f.calls[2][1].allowRegistry, true);
    assert.equal(f.calls[3][1].preparationId, f.preparationId);
    await assert.rejects(fs.lstat(f.workspace), { code: 'ENOENT' });
});

test('a preparation or activation failure retains the private workspace for review', linux, async t => {
    const f = await fixture(t), original = Object.assign(new Error('fixture activation failure'), { code: 'FIXTURE_FAILURE' });
    f.dependencies.activator = async () => { throw original; };
    await assert.rejects(prepareAndActivate({ base: f.base, repo: `${f.base}/repository`, targetSha: SHA, ...f.dependencies }), error => {
        assert.equal(error, original); assert.equal(error.workspace, f.workspace); return true;
    });
    assert.equal((await fs.lstat(f.workspace)).isDirectory(), true);
});

test('missing, linked, incorrectly permissioned or altered approval never reaches mutation', linux, async t => {
    for (const variant of ['missing', 'linked', 'mode', 'content']) await t.test(variant, async () => {
        const f = await fixture(t), marker = `${f.paths.state}/PRODUCTION_APPROVED`; let reached = false;
        if (variant === 'missing') await fs.unlink(marker);
        if (variant === 'linked') { await fs.unlink(marker); await fs.writeFile(`${f.base}/marker`, 'IST_DEPLOY_PRODUCTION_APPROVED_V1\n'); await fs.symlink(`${f.base}/marker`, marker); }
        if (variant === 'mode') await fs.chmod(marker, 0o640);
        if (variant === 'content') await fs.writeFile(marker, 'not-approved\n');
        await assert.rejects(prepareAndActivate({ base: f.base, repo: `${f.base}/repository`, targetSha: SHA,
            createWorkspace: async () => { reached = true; return f.workspace; } }), { code: 'PRODUCTION_APPROVAL_MISSING' });
        assert.equal(reached, false);
    });
});

test('rollback validates approval and delegates the explicit backup without preparing a release', linux, async t => {
    const f = await fixture(t), backupId = randomUUID(), expected = { backupId, transactionId: randomUUID() };
    let received;
    const result = await executeRollback({ base: f.base, backupId, adapter: {}, rollback: async input => { received = input; return expected; } });
    assert.equal(result, expected);
    assert.equal(received.base, f.base); assert.equal(received.backupId, backupId); assert.deepEqual(received.adapter, {});
});
