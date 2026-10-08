import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { createExportWorkspace, exportCommit } from '../scripts/deploy/git-export.mjs';
import { prepareRelease, verifyPreparedRelease } from '../scripts/deploy/release-prepare.mjs';

const linux = { skip: process.platform !== 'linux' || process.getuid?.() === 0 ? 'Linux non-root workspace required' : false };
const hash = (value, algorithm = 'sha1') => createHash(algorithm).update(value).digest('hex');
const object = (type, value) => {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value), raw = Buffer.concat([Buffer.from(`${type} ${bytes.length}\0`), bytes]);
    return { oid: hash(raw), raw };
};
const treeBytes = entries => Buffer.concat([...entries].sort((a, b) => a.name.localeCompare(b.name)).map(entry => Buffer.concat([Buffer.from(`${entry.mode} ${entry.name}\0`), Buffer.from(entry.oid, 'hex')])));

async function put(git, type, value) {
    const current = object(type, value), directory = `${git}/objects/${current.oid.slice(0, 2)}`;
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.writeFile(`${directory}/${current.oid.slice(2)}`, deflateSync(current.raw), { mode: 0o600 });
    return current.oid;
}

async function fixture(t) {
    const workspace = await createExportWorkspace();
    t.after(() => fs.rm(workspace, { recursive: true, force: true }));
    const git = `${workspace}/repository/.git`;
    for (const name of [git, `${git}/objects`, `${git}/refs/heads`]) await fs.mkdir(name, { recursive: true, mode: 0o700 });
    await fs.writeFile(`${git}/HEAD`, 'ref: refs/heads/main\n', { mode: 0o600 });
    await fs.writeFile(`${git}/config`, '[core]\nrepositoryformatversion = 0\n', { mode: 0o600 });
    const files = {
        'server.js': '// fictional backend\n',
        'package.json': JSON.stringify({ name: 'fictional-release', scripts: { build: 'fictional-build' } }),
        'package-lock.json': JSON.stringify({ name: 'fictional-release', lockfileVersion: 3, packages: {} }),
        'angular.json': '{}', 'src/main.ts': '// fictional frontend\n',
    };
    const root = [];
    for (const [name, bytes] of Object.entries(files).filter(([name]) => !name.includes('/'))) root.push({ name, mode: '100644', oid: await put(git, 'blob', bytes) });
    const mainBlob = await put(git, 'blob', files['src/main.ts']);
    const srcTree = await put(git, 'tree', treeBytes([{ name: 'main.ts', mode: '100644', oid: mainBlob }]));
    root.push({ name: 'src', mode: '40000', oid: srcTree });
    const tree = await put(git, 'tree', treeBytes(root));
    const commit = await put(git, 'commit', `tree ${tree}\nauthor Fixture <fixture@invalid.test> 1700000000 +0000\ncommitter Fixture <fixture@invalid.test> 1700000000 +0000\n\nFixture\n`);
    await fs.writeFile(`${git}/refs/heads/main`, `${commit}\n`, { mode: 0o600 });
    const exported = await exportCommit({ workspace, commitSha: commit, approvedMainSha: commit });
    return { workspace, exported };
}

function successfulRunner(calls) {
    return async (command, args, options) => {
        calls.push({ command, args, stage: options.stage, cwd: options.cwd, env: options.env, network: options.network });
        if (options.stage === 'metadata') return { stdout: '11.7.0\n', stderr: '' };
        if (options.stage === 'install') {
            for (const name of ['bcrypt', 'sharp']) {
                const directory = `${options.cwd}/node_modules/${name}`;
                await fs.mkdir(directory, { recursive: true, mode: 0o700 });
                await fs.writeFile(`${directory}/package.json`, JSON.stringify({ name, version: '0.0.0-fixture' }), { mode: 0o600 });
            }
        }
        if (options.stage === 'build') {
            const directory = `${options.cwd}/dist/sakai-ng/browser`;
            await fs.mkdir(directory, { recursive: true, mode: 0o700 });
            await fs.writeFile(`${directory}/index.html`, '<!doctype html><title>fixture</title>', { mode: 0o600 });
        }
        return { stdout: '', stderr: '' };
    };
}

test('normal flow creates a verified PREPARED_INACTIVE release with strict commands', linux, async t => {
    const f = await fixture(t), calls = [];
    const result = await prepareRelease({ workspace: f.workspace, exportId: f.exported.record.exportId, allowRegistry: true, runner: successfulRunner(calls) });
    assert.equal(result.manifest.status, 'PREPARED_INACTIVE');
    assert.deepEqual(calls.map(call => [call.command, call.args, call.stage]), [
        ['npm', ['--version'], 'metadata'],
        ['npm', ['ci', '--include=dev', '--strict-peer-deps'], 'install'],
        ['npm', ['run', 'build', '--', '--configuration', 'production'], 'build'],
        ['node', ['-e', "require('bcrypt'); const sharp=require('sharp'); if (!sharp.versions?.sharp) process.exit(2)"], 'native-probe'],
    ]);
    assert.equal(calls[1].network, true); assert.equal(calls[2].network, false);
    assert.equal((await verifyPreparedRelease({ workspace: f.workspace, preparationId: result.manifest.preparationId })).commitSha, f.exported.record.commitSha);
    await assert.rejects(fs.lstat(`${f.workspace}/PREPARE.lock`), { code: 'ENOENT' });
});

for (const failedStage of ['install', 'build']) test(`${failedStage} failure cannot produce a valid release`, linux, async t => {
    const f = await fixture(t), calls = [];
    const runner = async (command, args, options) => {
        if (options.stage === failedStage) throw Object.assign(new Error('fictional failure'), { code: failedStage === 'install' ? 'DEPENDENCY_INSTALL_FAILED' : 'ANGULAR_BUILD_FAILED' });
        return successfulRunner(calls)(command, args, options);
    };
    await assert.rejects(prepareRelease({ workspace: f.workspace, exportId: f.exported.record.exportId, runner }), { code: failedStage === 'install' ? 'DEPENDENCY_INSTALL_FAILED' : 'ANGULAR_BUILD_FAILED' });
    const ids = await fs.readdir(`${f.workspace}/preparations`);
    assert.equal(ids.length, 1);
    await assert.rejects(fs.lstat(`${f.workspace}/preparations/${ids[0]}/PREPARED_INACTIVE.json`), { code: 'ENOENT' });
    assert.ok(await fs.lstat(`${f.workspace}/preparations/${ids[0]}/FAILED.json`));
});

test('manifest detects payload corruption and unexpected files', linux, async t => {
    const f = await fixture(t), result = await prepareRelease({ workspace: f.workspace, exportId: f.exported.record.exportId, runner: successfulRunner([]) });
    await fs.writeFile(`${result.release}/frontend/index.html`, 'changed fixture');
    await assert.rejects(verifyPreparedRelease({ workspace: f.workspace, preparationId: result.manifest.preparationId }), { code: 'PREPARATION_INTEGRITY_FAILED' });
});

test('workspace lock blocks concurrent preparation and is not removed as stale', linux, async t => {
    const f = await fixture(t); await fs.writeFile(`${f.workspace}/PREPARE.lock`, '{"version":1,"token":"fixture","pid":999999}', { mode: 0o600 });
    const before = await fs.readFile(`${f.workspace}/PREPARE.lock`);
    await assert.rejects(prepareRelease({ workspace: f.workspace, exportId: f.exported.record.exportId, runner: successfulRunner([]) }), { code: 'PREPARATION_LOCK_EXISTS' });
    assert.deepEqual(await fs.readFile(`${f.workspace}/PREPARE.lock`), before);
});

test('runner receives no inherited secrets and all writes remain in the isolated workspace', linux, async t => {
    const f = await fixture(t), calls = [], original = process.env.FICTIONAL_SECRET;
    process.env.FICTIONAL_SECRET = 'must-not-be-forwarded';
    t.after(() => original === undefined ? delete process.env.FICTIONAL_SECRET : process.env.FICTIONAL_SECRET = original);
    const result = await prepareRelease({ workspace: f.workspace, exportId: f.exported.record.exportId, runner: successfulRunner(calls) });
    assert.equal(calls.every(call => !('FICTIONAL_SECRET' in call.env)), true);
    assert.equal(path.relative(f.workspace, result.release).startsWith('..'), false);
});
