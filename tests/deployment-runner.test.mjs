import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonicalPaths } from '../scripts/deploy/production-contract.mjs';
import { prepareAndActivate, executeRollback } from '../scripts/deploy/deployment-runner.mjs';

const linux = { skip: process.platform !== 'linux' || process.getuid?.() === 0 ? 'Linux non-root required' : false };
const SHA = 'a'.repeat(40);

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
