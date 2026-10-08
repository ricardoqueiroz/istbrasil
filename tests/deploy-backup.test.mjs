import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createIsolation, requireIsolation, digest, startTransaction, advanceTransaction, readTransaction, inspectTransactions,
    readWorkspaceLock } from '../scripts/deploy/state.mjs';
import { createBackup, verifyBackup, restoreBackup } from '../scripts/deploy/backup.mjs';

const COMMIT = 'a'.repeat(40);
const linux = process.platform === 'linux';

function put(file, content, mode = 0o644) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, content, { mode });
    fs.chmodSync(file, mode);
}

function tree(directory) {
    const result = {};
    function walk(relative) {
        const file = path.join(directory, relative);
        const stat = fs.lstatSync(file);
        result[relative] = stat.isSymbolicLink() ? { link: fs.readlinkSync(file) }
            : stat.isDirectory() ? { directory: true, mode: stat.mode & 0o777 }
                : { sha256: digest(fs.readFileSync(file)), mode: stat.mode & 0o777 };
        if (stat.isDirectory()) for (const name of fs.readdirSync(file).sort()) walk(path.join(relative, name));
    }
    walk('');
    return result;
}

function fixture(t) {
    const isolation = createIsolation();
    t.after(() => {
        // Delete only the generated, canonical temporary workspace, never an input path.
        assert.equal(path.dirname(isolation), fs.realpathSync(os.tmpdir()));
        assert.match(path.basename(isolation), /^ist-deploy-isolated-/);
        assert.equal(fs.realpathSync(isolation), isolation);
        fs.rmSync(isolation, { recursive: true, force: true });
    });
    const backend = path.join(isolation, 'sources/backend');
    const frontend = path.join(isolation, 'sources/html');
    put(path.join(backend, 'server.js'), "console.log(require('fixture-module').label);\n");
    put(path.join(backend, 'package.json'), JSON.stringify({ name: 'fake-backend', private: true }));
    // A legacy conflict is just fixture metadata; restore must not invoke an installer.
    put(path.join(backend, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, fixture: 'legacy-peer-conflict' }));
    put(path.join(backend, 'node_modules/fixture-module/index.js'), "exports.label = 'isolated-backend-ok';\n");
    put(path.join(backend, 'node_modules/fixture-module/package.json'), '{"name":"fixture-module","version":"1.0.0","main":"index.js"}');
    put(path.join(backend, 'node_modules/fixture-module/native.node'), Buffer.from([0, 1, 255, 42]));
    put(path.join(backend, 'node_modules/fixture-module/tool.js'), '#!/usr/bin/env node\n', 0o755);
    fs.mkdirSync(path.join(backend, 'empty'), { mode: 0o750 });
    put(path.join(frontend, 'index.html'), '<html><script src="main.fixture.js"></script></html>');
    put(path.join(frontend, 'main.fixture.js'), 'window.fixture = true;');
    put(path.join(frontend, 'assets/with space.txt'), 'synthetic public asset');
    for (const name of ['.env', '.env.backup', '.env_old', '.env.local', '.npmrc']) {
        put(path.join(backend, name), 'FIXTURE_LABEL=EXCLUDED_FILE\n', 0o600);
    }
    for (const name of ['istbrasil.private', 'uploads', 'backend-php', '.git', 'database', 'dist', '.angular']) {
        put(path.join(backend, name, 'fixture.txt'), 'synthetic excluded data');
    }
    // Match the production tracked-file count with entirely fictitious content.
    for (let i = 0; i < 119; i++) put(path.join(backend, 'istbrasil.private', `document-${i}.pdf`), 'synthetic document');
    put(path.join(backend, 'IST Brasil - MariaDB via SSH.session.sql'), '-- fixture only; never executed');
    put(path.join(backend, 'certificate.key'), 'synthetic excluded file');
    put(path.join(frontend, '.env'), 'FIXTURE_LABEL=PUBLIC_EXCLUDED\n', 0o600);
    put(path.join(isolation, 'sources/uploads/sentinel'), 'synthetic upload');
    put(path.join(isolation, 'sources/backend-php/sentinel'), 'synthetic PHP data');
    return { isolation, backend, frontend, commit: COMMIT };
}

async function snapshot(t) {
    const input = fixture(t);
    return { ...input, backup: await createBackup(input) };
}

function rewriteManifest(input, edit) {
    const base = input.backup.directory;
    const manifest = JSON.parse(fs.readFileSync(path.join(base, 'manifest.json'), 'utf8'));
    edit(manifest);
    const raw = JSON.stringify(manifest, null, 2) + '\n';
    for (const [name, value] of [['manifest.json', raw], ['manifest.sha256', digest(raw) + '\n'], ['READY', digest(raw) + '\n']]) {
        fs.writeFileSync(path.join(base, name), value);
    }
}

test('round trip verifies SHA-256 and executes the restored backend with its original modules', async t => {
    const input = fixture(t);
    const original = tree(path.join(input.isolation, 'sources'));
    const backup = await createBackup(input);
    const manifest = await verifyBackup(input.isolation, backup.id);
    const restored = await restoreBackup({ isolation: input.isolation, id: backup.id });
    assert.equal(execFileSync(process.execPath, [path.join(restored.directory, 'backend/server.js')], { encoding: 'utf8' }).trim(), 'isolated-backend-ok');
    assert.deepEqual(fs.readFileSync(path.join(restored.directory, 'backend/node_modules/fixture-module/native.node')), Buffer.from([0, 1, 255, 42]));
    assert.equal(fs.readFileSync(path.join(restored.directory, 'frontend/index.html'), 'utf8'), fs.readFileSync(path.join(input.frontend, 'index.html'), 'utf8'));
    assert.deepEqual(tree(path.join(input.isolation, 'sources')), original);
    assert.equal(readTransaction(input.isolation, backup.transaction).events.at(-1).phase, 'complete');
    assert.equal(readTransaction(input.isolation, restored.transaction).events.at(-1).phase, 'complete');
    assert.equal(manifest.runtime.node, process.versions.node);
    assert(manifest.entries.some(entry => entry.path === 'backend/empty' && entry.type === 'directory'));
    assert(fs.existsSync(path.join(restored.directory, 'RESTORED.json')));
});

test('all protected files/data are excluded, with no credentials or production data in fixtures', async t => {
    const input = await snapshot(t);
    const manifest = await verifyBackup(input.isolation, input.backup.id);
    assert(manifest.excluded.includes('.env*'));
    for (const entry of manifest.entries) {
        assert(!/(\.env|\.git|\.npmrc|istbrasil\.private|uploads|backend-php|database|certificate\.key|session\.sql)/.test(entry.path));
    }
    const restored = await restoreBackup({ isolation: input.isolation, id: input.backup.id });
    for (const name of ['.env', '.env.backup', '.env_old', 'istbrasil.private', 'uploads', 'backend-php', '.git']) {
        assert(!fs.existsSync(path.join(restored.directory, 'backend', name)));
        assert(fs.existsSync(path.join(input.backend, name)));
    }
    assert(!fs.existsSync(path.join(restored.directory, 'frontend/.env')));
});

test('each restoration has a new destination and never overwrites a previous recovery', async t => {
    const input = await snapshot(t);
    const first = await restoreBackup({ isolation: input.isolation, id: input.backup.id });
    put(path.join(first.directory, 'frontend/local-sentinel'), 'keep this recovery');
    const before = tree(first.directory);
    const second = await restoreBackup({ isolation: input.isolation, id: input.backup.id });
    assert.notEqual(first.directory, second.directory);
    assert.deepEqual(tree(first.directory), before);
    assert(!fs.existsSync(path.join(second.directory, 'frontend/local-sentinel')));
});

test('internal node_modules symlinks survive, phpMyAdmin link is left untouched and never dereferenced', { skip: !linux }, async t => {
    const input = fixture(t);
    const modules = path.join(input.backend, 'node_modules');
    fs.mkdirSync(path.join(modules, '.bin'), { mode: 0o755 });
    fs.symlinkSync('../fixture-module/tool.js', path.join(modules, '.bin/fixture'));
    const php = path.join(input.isolation, 'sources/phpmyadmin');
    put(path.join(php, 'sentinel'), 'synthetic phpMyAdmin');
    fs.symlinkSync(php, path.join(input.frontend, 'istdbadmin'));
    const before = tree(path.join(input.isolation, 'sources'));
    const backup = await createBackup(input);
    const restored = await restoreBackup({ isolation: input.isolation, id: backup.id });
    assert.equal(fs.readlinkSync(path.join(restored.directory, 'backend/node_modules/.bin/fixture')), '../fixture-module/tool.js');
    assert.deepEqual(tree(path.join(input.isolation, 'sources')), before);
    assert.equal(fs.readlinkSync(path.join(input.frontend, 'istdbadmin')), php);
    assert(!fs.existsSync(path.join(restored.directory, 'frontend/istdbadmin')));
    assert(!(await verifyBackup(input.isolation, backup.id)).entries.some(entry => entry.path.includes('istdbadmin')));
});

test('Linux private storage is 700/600; original executable/directory modes are restored', { skip: !linux }, async t => {
    const input = await snapshot(t);
    const restored = await restoreBackup({ isolation: input.isolation, id: input.backup.id });
    assert.equal(fs.statSync(input.isolation).mode & 0o777, 0o700);
    assert.equal(fs.statSync(input.backup.directory).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(input.backup.directory, 'manifest.json')).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(input.backup.directory, 'payload/modules/fixture-module/tool.js')).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(restored.directory, 'backend/node_modules/fixture-module/tool.js')).mode & 0o777, 0o755);
    assert.equal(fs.statSync(path.join(restored.directory, 'backend/empty')).mode & 0o777, 0o750);
});

test('files with Unicode, spaces and Linux newlines have unambiguous manifest paths', async t => {
    const input = fixture(t);
    const name = linux ? 'assets/avaliação\nfinal.txt' : 'assets/avaliação final.txt';
    put(path.join(input.frontend, name), 'synthetic text');
    const backup = await createBackup(input);
    const restored = await restoreBackup({ isolation: input.isolation, id: backup.id });
    assert.equal(fs.readFileSync(path.join(restored.directory, 'frontend', name), 'utf8'), 'synthetic text');
});

test('streaming copies larger binary assets without changing their hashes', async t => {
    const input = fixture(t);
    const bytes = Buffer.alloc(5 * 1024 * 1024, 42);
    put(path.join(input.frontend, 'assets/large.bin'), bytes);
    const backup = await createBackup(input);
    const restored = await restoreBackup({ isolation: input.isolation, id: backup.id });
    assert.equal(digest(fs.readFileSync(path.join(restored.directory, 'frontend/assets/large.bin'))), digest(bytes));
});

for (const [label, mutate] of [
    ['changed file', input => fs.appendFileSync(path.join(input.backup.directory, 'payload/backend/server.js'), 'corrupt')],
    ['missing file', input => fs.unlinkSync(path.join(input.backup.directory, 'payload/frontend/index.html'))],
    ['unexpected file', input => put(path.join(input.backup.directory, 'payload/frontend/unlisted.txt'), 'corrupt', 0o600)],
    ['manifest checksum', input => fs.appendFileSync(path.join(input.backup.directory, 'manifest.json'), ' ')],
    ['completion seal', input => fs.unlinkSync(path.join(input.backup.directory, 'READY'))]
]) test(`corruption (${label}) blocks verification and restoration before creating a destination`, async t => {
    const input = await snapshot(t);
    mutate(input);
    await assert.rejects(verifyBackup(input.isolation, input.backup.id));
    await assert.rejects(restoreBackup({ isolation: input.isolation, id: input.backup.id }));
    assert.deepEqual(fs.readdirSync(path.join(input.isolation, 'restored')), []);
    assert(inspectTransactions(input.isolation).some(record => record.operation === 'restore' && record.events.at(-1).phase === 'failed'));
});

for (const [label, edit] of [
    ['traversal', manifest => { manifest.entries[1].path = 'backend/../../escape'; }],
    ['absolute path', manifest => { manifest.entries[1].path = '/escape'; }],
    ['protected file', manifest => { manifest.entries[1].path = 'backend/.env'; }],
    ['duplicate entry', manifest => { manifest.entries.push(manifest.entries[0]); }],
    ['missing component', manifest => { manifest.entries = manifest.entries.filter(entry => !entry.path.startsWith('modules')); }],
    ['unknown type', manifest => { manifest.entries[1].type = 'device'; }]
]) test(`manifest schema rejects ${label} even with recomputed SHA-256`, async t => {
    const input = await snapshot(t);
    rewriteManifest(input, edit);
    await assert.rejects(verifyBackup(input.isolation, input.backup.id));
});

test('a different native-module ABI blocks restoration', async t => {
    const input = await snapshot(t);
    rewriteManifest(input, manifest => { manifest.runtime.abi = 'invalid-fixture-abi'; });
    await assert.rejects(restoreBackup({ isolation: input.isolation, id: input.backup.id }), /ABI differs/);
    assert.deepEqual(fs.readdirSync(path.join(input.isolation, 'restored')), []);
});

test('production/external sources and arbitrary backup IDs are rejected without touching them', async t => {
    const input = fixture(t);
    const external = path.join(path.parse(input.isolation).root, 'var/www/istbrasil.org.br/backend-node/istbrasil');
    await assert.rejects(createBackup({ ...input, backend: external }), /isolated sources/);
    await assert.rejects(createBackup({ ...input, isolation: path.parse(input.isolation).root }));
    await assert.rejects(verifyBackup(input.isolation, '../escape'));
    await assert.rejects(restoreBackup({ isolation: input.isolation, id: '../escape' }));
    assert.equal(inspectTransactions(input.isolation).length, 0);
});

test('incomplete backend snapshot fails and is recorded without modifying sources', async t => {
    const input = fixture(t);
    fs.unlinkSync(path.join(input.backend, 'server.js'));
    const before = tree(path.join(input.isolation, 'sources'));
    await assert.rejects(createBackup(input), /Incomplete application snapshot/);
    assert.deepEqual(tree(path.join(input.isolation, 'sources')), before);
    assert.equal(inspectTransactions(input.isolation)[0].events.at(-1).phase, 'failed');
    assert(!fs.readdirSync(path.join(input.isolation, 'backups')).some(id => fs.existsSync(path.join(input.isolation, 'backups', id, 'READY'))));
});

test('journal is integrity checked and rejects skipped/terminal transitions', t => {
    const { isolation } = fixture(t);
    const id = startTransaction(isolation, 'backup', randomUUID());
    assert.throws(() => advanceTransaction(isolation, id, 'complete'), /transition/);
    advanceTransaction(isolation, id, 'copying');
    advanceTransaction(isolation, id, 'verifying');
    advanceTransaction(isolation, id, 'complete');
    assert.throws(() => advanceTransaction(isolation, id, 'failed'), /transition/);
    const file = path.join(isolation, 'journal', `${id}.json`);
    const envelope = JSON.parse(fs.readFileSync(file, 'utf8'));
    envelope.record.backupId = randomUUID();
    fs.writeFileSync(file, JSON.stringify(envelope));
    assert.throws(() => readTransaction(isolation, id), /integrity/);
});

test('abrupt Linux interruption leaves an incomplete journal; reviewed failure permits recovery of a valid previous backup', { skip: !linux }, async t => {
    const input = await snapshot(t);
    const bytes = 64 * 1024 * 1024;
    put(path.join(input.frontend, 'assets/interrupt.bin'), Buffer.alloc(bytes, 42));
    const backupURL = new URL('../scripts/deploy/backup.mjs', import.meta.url).href;
    const script = `import {createBackup} from ${JSON.stringify(backupURL)}; await createBackup(JSON.parse(process.argv[1]));`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, JSON.stringify({
        isolation: input.isolation, backend: input.backend, frontend: input.frontend, commit: COMMIT
    })], { stdio: 'ignore' });
    const exited = once(child, 'exit');
    let interrupted;
    try {
        const deadline = Date.now() + 10000;
        while (Date.now() < deadline) {
            const transaction = inspectTransactions(input.isolation).find(record => record.backupId !== input.backup.id);
            if (transaction) {
                const file = path.join(input.isolation, 'backups', transaction.backupId, 'payload/frontend/assets/interrupt.bin');
                const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
                if (size > 0 && size < bytes) { interrupted = transaction; break; }
            }
            if (child.exitCode !== null || child.signalCode !== null) break;
            await new Promise(resolve => setTimeout(resolve, 5));
        }
        assert(interrupted, 'Must interrupt the real backup while a file is only partially copied');
        assert.equal(readWorkspaceLock(input.isolation).pid, child.pid);
        await assert.rejects(createBackup(input), /Workspace locked/);
        await assert.rejects(restoreBackup({ isolation: input.isolation, id: input.backup.id }), /Workspace locked/);
        child.kill('SIGKILL');
        assert.equal((await exited)[1], 'SIGKILL');
    } finally {
        if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
    }
    interrupted = readTransaction(input.isolation, interrupted.id);
    assert.equal(interrupted.events.at(-1).phase, 'copying');
    interrupted = inspectTransactions(input.isolation).find(record => record.id === interrupted.id);
    assert.equal(interrupted.incomplete, true);
    await assert.rejects(verifyBackup(input.isolation, interrupted.backupId));
    await assert.rejects(createBackup(input), /Workspace locked/);
    await assert.rejects(restoreBackup({ isolation: input.isolation, id: input.backup.id }), /Workspace locked/);
    await verifyBackup(input.isolation, input.backup.id);
    // Explicit review acknowledgment, never automatic lock/state deletion or production recovery.
    advanceTransaction(input.isolation, interrupted.id, 'failed');
    await assert.rejects(restoreBackup({ isolation: input.isolation, id: input.backup.id }), /Workspace locked/);
    assert.equal(readWorkspaceLock(input.isolation).pid, child.pid);
    fs.unlinkSync(path.join(input.isolation, 'WORKSPACE.lock')); // Explicit fixture-only review after the child exited.
    const restored = await restoreBackup({ isolation: input.isolation, id: input.backup.id });
    assert(fs.existsSync(path.join(restored.directory, 'frontend/index.html')));
});

test('unsafe source links and hardlinks cannot capture data outside the component', { skip: !linux }, async t => {
    const input = fixture(t);
    fs.symlinkSync('../../.env', path.join(input.backend, 'node_modules/fixture-module/unsafe'));
    await assert.rejects(createBackup(input), /Unsafe relative path|protected|ENOENT/);
    fs.unlinkSync(path.join(input.backend, 'node_modules/fixture-module/unsafe'));
    fs.linkSync(path.join(input.backend, '.env'), path.join(input.backend, 'shared-config'));
    await assert.rejects(createBackup(input), /unshared/);
});

test('symlinked source/storage paths and substituted payload files are rejected', { skip: !linux }, async t => {
    const input = fixture(t);
    fs.symlinkSync(input.backend, path.join(input.isolation, 'sources/alias'));
    await assert.rejects(createBackup({ ...input, backend: path.join(input.isolation, 'sources/alias') }), /Symlink/);
    const backup = await createBackup(input);
    const file = path.join(backup.directory, 'payload/frontend/main.fixture.js');
    fs.unlinkSync(file);
    fs.symlinkSync(path.join(input.backend, '.env'), file);
    await assert.rejects(verifyBackup(input.isolation, backup.id), /symlink/i);
});

test('public backup permissions and unreadable source files fail safely on Linux', { skip: !linux }, async t => {
    assert.notEqual(process.getuid(), 0, 'Linux suite must run as a non-root user');
    const input = await snapshot(t);
    fs.chmodSync(path.join(input.backup.directory, 'manifest.json'), 0o644);
    await assert.rejects(verifyBackup(input.isolation, input.backup.id), /permissions/);
    fs.chmodSync(path.join(input.backup.directory, 'manifest.json'), 0o600);
    fs.chmodSync(path.join(input.backend, 'server.js'), 0o000);
    await assert.rejects(createBackup(input), /EACCES/);
    fs.chmodSync(path.join(input.backend, 'server.js'), 0o644);
    assert(inspectTransactions(input.isolation).some(record => record.events.at(-1).phase === 'failed'));
});

test('phase 1 never connects backup/recovery to the production deploy entrypoint', () => {
    const script = fs.readFileSync(fileURLToPath(new URL('../deploy.sh', import.meta.url)), 'utf8');
    assert.match(script, /DEPLOY DISABLED/);
    assert.match(script, /Rollback unavailable/);
    assert(!script.includes('backup.mjs'));
});

test('a failed isolated destination is journaled and a new attempt restores the valid backup', { skip: !linux }, async t => {
    const input = await snapshot(t);
    const directory = path.join(input.isolation, 'restored');
    fs.chmodSync(directory, 0o500);
    try {
        await assert.rejects(restoreBackup({ isolation: input.isolation, id: input.backup.id }), /EACCES/);
        assert(inspectTransactions(input.isolation).some(record => record.operation === 'restore' && record.events.at(-1).phase === 'failed'));
    } finally { fs.chmodSync(directory, 0o700); }
    const restored = await restoreBackup({ isolation: input.isolation, id: input.backup.id });
    assert.equal(execFileSync(process.execPath, [path.join(restored.directory, 'backend/server.js')], { encoding: 'utf8' }).trim(), 'isolated-backend-ok');
});

test('unexpected protected payload is rejected before trying to read its contents', { skip: !linux }, async t => {
    const input = await snapshot(t);
    const file = path.join(input.backup.directory, 'payload/frontend/.env');
    put(file, 'FIXTURE_LABEL=UNEXPECTED_EXCLUDED\n', 0o000);
    try { await assert.rejects(verifyBackup(input.isolation, input.backup.id), /Protected\/invalid manifest path/); }
    finally { fs.chmodSync(file, 0o600); }
});

test('an exclusive journal lock prevents concurrent transitions without changing the record', t => {
    const input = fixture(t);
    const id = startTransaction(input.isolation, 'backup', randomUUID());
    const file = path.join(input.isolation, 'journal', `${id}.json`);
    const before = fs.readFileSync(file);
    const lock = path.join(input.isolation, 'journal', `${id}.lock`);
    put(lock, 'fixture lock', 0o600);
    assert.throws(() => advanceTransaction(input.isolation, id, 'copying'), /EEXIST/);
    assert.deepEqual(fs.readFileSync(file), before);
    fs.unlinkSync(lock);
    advanceTransaction(input.isolation, id, 'failed');
});

for (const [firstOperation, secondOperation] of [['backup', 'backup'], ['backup', 'restore'], ['restore', 'backup'], ['restore', 'restore']]) {
    test(`workspace exclusion blocks ${secondOperation} while ${firstOperation} is in progress`, async t => {
        const input = await snapshot(t);
        const before = tree(path.join(input.isolation, 'sources'));
        const run = operation => operation === 'backup' ? createBackup(input) : restoreBackup({ isolation: input.isolation, id: input.backup.id });
        const first = run(firstOperation);
        try {
            const lock = readWorkspaceLock(input.isolation);
            assert.equal(lock.operation, firstOperation);
            await assert.rejects(run(secondOperation), /Workspace locked/);
            await first;
            assert.equal(readWorkspaceLock(input.isolation), null);
            assert.equal(inspectTransactions(input.isolation).length, 2, 'Rejected operation must not start a transaction');
            assert.deepEqual(tree(path.join(input.isolation, 'sources')), before);
        } finally { await first.catch(() => {}); }
    });
}

test('a stale/malformed workspace lock is never cleared based on PID or age', async t => {
    const input = await snapshot(t);
    const file = path.join(input.isolation, 'WORKSPACE.lock');
    const record = { version: 1, token: randomUUID(), transaction: randomUUID(), operation: 'backup', pid: 2147483647,
        createdAt: '2000-01-01T00:00:00.000Z' };
    put(file, JSON.stringify(record), 0o600);
    const before = fs.readFileSync(file);
    await assert.rejects(createBackup(input), /Workspace locked/);
    await assert.rejects(restoreBackup({ isolation: input.isolation, id: input.backup.id }), /Workspace locked/);
    assert.deepEqual(fs.readFileSync(file), before);
    fs.writeFileSync(file, 'invalid fixture lock');
    await assert.rejects(createBackup(input), /Workspace locked/);
    assert.equal(fs.readFileSync(file, 'utf8'), 'invalid fixture lock');
});

function failJournalPublication(t, isolation, phase, failure) {
    const rename = fs.renameSync;
    t.mock.method(fs, 'renameSync', function (source, destination) {
        if (path.dirname(destination) === path.join(isolation, 'journal')
            && JSON.parse(fs.readFileSync(source, 'utf8')).record.events.at(-1).phase === phase) throw failure;
        return rename.call(this, source, destination);
    });
}

for (const operation of ['backup', 'restore']) {
    test(`${operation} preserves the original I/O error when publishing failed also fails`, async t => {
        const input = operation === 'backup' ? fixture(t) : await snapshot(t);
        const original = new Error('synthetic original I/O error');
        const secondary = new Error('synthetic journal publication failure');
        const source = operation === 'backup' ? path.join(input.backend, 'server.js')
            : path.join(input.backup.directory, 'payload/backend/server.js');
        const open = fs.promises.open;
        t.mock.method(fs.promises, 'open', async function (file, ...args) {
            if (file === source) throw original;
            return open.call(this, file, ...args);
        });
        failJournalPublication(t, input.isolation, 'failed', secondary);
        const promise = operation === 'backup' ? createBackup(input) : restoreBackup({ isolation: input.isolation, id: input.backup.id });
        await assert.rejects(promise, error => error === original && error.journalError === secondary);
        const lock = readWorkspaceLock(input.isolation);
        const record = inspectTransactions(input.isolation).find(transaction => transaction.id === lock.transaction);
        assert.equal(record.incomplete, true);
        assert.equal(record.unconfirmed, true);
        assert.notEqual(record.events.at(-1).phase, 'complete');
        await assert.rejects(createBackup(input), /Workspace locked/);
    });

    test(`${operation} does not return success when the complete journal transition cannot be published`, async t => {
        const input = operation === 'backup' ? fixture(t) : await snapshot(t);
        const original = new Error('synthetic complete journal failure');
        failJournalPublication(t, input.isolation, 'complete', original);
        const promise = operation === 'backup' ? createBackup(input) : restoreBackup({ isolation: input.isolation, id: input.backup.id });
        await assert.rejects(promise, error => error === original);
        const record = inspectTransactions(input.isolation).find(transaction => transaction.operation === operation && transaction.events.at(-1).phase === 'failed');
        assert(record, 'Failed completion must be recorded as failed, never complete');
        assert.equal(readWorkspaceLock(input.isolation), null, 'Confirmed failure safely releases its own lock');
    });
}

test('failure after journal rename retains the lock and makes visible complete bytes unconfirmed', async t => {
    const input = fixture(t);
    const original = new Error('synthetic directory fsync failure');
    const rename = fs.renameSync, sync = fs.fsyncSync;
    let directorySyncFailed = false, publishedComplete = false;
    t.mock.method(fs, 'renameSync', function (source, destination) {
        const complete = path.dirname(destination) === path.join(input.isolation, 'journal')
            && JSON.parse(fs.readFileSync(source, 'utf8')).record.events.at(-1).phase === 'complete';
        const result = rename.call(this, source, destination);
        if (complete) publishedComplete = true;
        return result;
    });
    t.mock.method(fs, 'fsyncSync', function (fd) {
        if (publishedComplete && !directorySyncFailed && fs.fstatSync(fd).isDirectory()) {
            directorySyncFailed = true;
            throw original;
        }
        return sync.call(this, fd);
    });
    // On Windows directory fsync is skipped, so inject the same post-rename failure there.
    if (!linux) t.mock.method(fs, 'renameSync', function (source, destination) {
        const complete = path.dirname(destination) === path.join(input.isolation, 'journal')
            && JSON.parse(fs.readFileSync(source, 'utf8')).record.events.at(-1).phase === 'complete';
        const result = rename.call(this, source, destination);
        if (complete) throw original;
        return result;
    });
    await assert.rejects(createBackup(input), error => error === original && error.journalError instanceof Error);
    const record = inspectTransactions(input.isolation)[0];
    assert.equal(record.unconfirmed, true);
    assert.equal(record.incomplete, true);
    await assert.rejects(verifyBackup(input.isolation, record.backupId), /unconfirmed/);
    await assert.rejects(restoreBackup({ isolation: input.isolation, id: record.backupId }), /Workspace locked/);
});

test('the original error remains intact even when it cannot hold a secondary diagnostic', async t => {
    const input = fixture(t);
    const original = Object.freeze(new Error('synthetic frozen I/O error'));
    const open = fs.promises.open;
    t.mock.method(fs.promises, 'open', async function (file, ...args) {
        if (file === path.join(input.backend, 'server.js')) throw original;
        return open.call(this, file, ...args);
    });
    failJournalPublication(t, input.isolation, 'failed', new Error('synthetic journal failure'));
    await assert.rejects(createBackup(input), error => error === original);
    assert(readWorkspaceLock(input.isolation));
});

test('integrity is verified before restrictive file/directory modes, then child modes precede parents', { skip: !linux }, async t => {
    const input = await snapshot(t);
    // Modes may be unreadable for the operational user after restoration; payload is still 600/700.
    rewriteManifest(input, manifest => {
        for (const entry of manifest.entries) {
            if (entry.type === 'directory') entry.mode = 0o000;
            else if (entry.type === 'file') entry.mode = 0o000;
        }
    });
    const restored = await restoreBackup({ isolation: input.isolation, id: input.backup.id });
    const manifest = await verifyBackup(input.isolation, input.backup.id);
    // Unlock directories parent-first only in the fixture so each final mode can be inspected/cleaned up.
    for (const entry of manifest.entries.filter(entry => entry.type === 'directory')) {
        const relative = entry.path.startsWith('modules') ? entry.path.replace(/^modules/, 'backend/node_modules') : entry.path;
        const file = path.join(restored.directory, relative);
        assert.equal(fs.lstatSync(file).mode & 0o777, 0o000);
        fs.chmodSync(file, 0o700);
    }
    for (const entry of manifest.entries.filter(entry => entry.type === 'file')) {
        const relative = entry.path.startsWith('modules') ? entry.path.replace(/^modules/, 'backend/node_modules') : entry.path;
        const file = path.join(restored.directory, relative);
        assert.equal(fs.lstatSync(file).mode & 0o777, 0o000);
        fs.chmodSync(file, 0o600);
        assert.equal(digest(fs.readFileSync(file)), entry.sha256);
    }
    assert.equal(readTransaction(input.isolation, restored.transaction).events.at(-1).phase, 'complete');
});
