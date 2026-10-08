// Operational activation/rollback engine. It is intentionally not connected to deploy.sh.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { canonicalPaths, releasePaths, validateActive, validateBackupManifest, validateBackupSeal, validateJournal, validateLock, validateManifest, sha256 } from './production-contract.mjs';
import { verifyPreparedRelease } from './release-prepare.mjs';

const execute = promisify(execFile);
const FORMAT_VERSION = 1;
const PM2_NAME = 'ist-api';
const fileHash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = (code, cause) => Object.assign(new Error(code, cause ? { cause } : undefined), { code });
const now = () => new Date().toISOString();

async function exists(filename) { try { await fs.lstat(filename); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
async function privateDirectory(filename) {
    const stat = await fs.lstat(filename);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.mode & 0o022) throw fail('UNSAFE_OPERATION_DIRECTORY');
}
async function ensureDirectory(filename) {
    await fs.mkdir(filename, { recursive: true, mode: 0o700 });
    await fs.chmod(filename, 0o700); await privateDirectory(filename);
}
async function writeAtomic(filename, bytes) {
    const temporary = `${path.dirname(filename)}/.pending-${randomUUID()}`;
    const handle = await fs.open(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(temporary, filename);
}

async function processIdentity() {
    const [stat, bootId] = await Promise.all([fs.readFile(`/proc/${process.pid}/stat`, 'utf8'), fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8')]);
    const close = stat.lastIndexOf(')');
    const startTicks = stat.slice(close + 2).split(' ')[19];
    const value = { startTicks, bootId: bootId.trim() };
    if (!/^\d+$/.test(value.startTicks) || !/^[a-f0-9-]{36}$/.test(value.bootId)) throw fail('PROCESS_IDENTITY_UNAVAILABLE');
    return value;
}

async function acquire(paths, operation, transactionId) {
    const identity = await processIdentity(), token = randomUUID();
    const record = { version: 1, transactionId, token, operation, pid: process.pid, ...identity, createdAt: now() };
    if (!validateLock(record)) throw fail('OPERATION_LOCK_INVALID');
    let handle;
    try { handle = await fs.open(paths.lock, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600); }
    catch (error) { if (error.code === 'EEXIST') throw fail('OPERATION_LOCK_EXISTS', error); throw error; }
    await handle.writeFile(JSON.stringify(record)); await handle.sync();
    const stat = await handle.stat(); await handle.close();
    return async retain => {
        if (retain) return;
        const current = await fs.lstat(paths.lock), value = JSON.parse(await fs.readFile(paths.lock, 'utf8'));
        if (current.dev !== stat.dev || current.ino !== stat.ino || value.token !== token) throw fail('OPERATION_LOCK_CHANGED');
        await fs.unlink(paths.lock);
    };
}

async function saveJournal(paths, record) {
    const envelope = { record, sha256: sha256(JSON.stringify(record)) };
    if (!validateJournal(envelope)) throw fail('JOURNAL_INVALID');
    await writeAtomic(`${paths.transactions}/${record.transactionId}.json`, JSON.stringify(envelope));
}
async function phase(paths, record, name) { record.events.push({ phase: name, at: now() }); await saveJournal(paths, record); }

function excludedBackend(relative) {
    const first = relative.split('/')[0];
    return ['.env', '.env.backup', '.env_old', '.git', 'istbrasil.private', 'html', 'dist', '.angular'].includes(first);
}

async function copyTree(source, destination, { skip = () => false, indexLast = false } = {}) {
    const boundary = source;
    await ensureDirectory(destination);
    const visit = async (fromDirectory, toDirectory, relative = '') => {
      const names = (await fs.readdir(fromDirectory)).filter(name => !relative && skip(name) ? false : true)
        .sort((a, b) => indexLast && !relative ? (a === 'index.html') - (b === 'index.html') || a.localeCompare(b) : a.localeCompare(b));
      for (const name of names) {
        const current = relative ? `${relative}/${name}` : name, from = `${fromDirectory}/${name}`, to = `${toDirectory}/${name}`, stat = await fs.lstat(from);
        if (stat.isDirectory() && !stat.isSymbolicLink()) { await ensureDirectory(to); await visit(from, to, current); }
        else if (stat.isFile() && !stat.isSymbolicLink()) { await fs.copyFile(from, to, fs.constants.COPYFILE_EXCL); await fs.chmod(to, stat.mode & 0o777); }
        else if (stat.isSymbolicLink()) {
            const target = await fs.readlink(from), resolved = path.resolve(path.dirname(from), target);
            if (path.isAbsolute(target) || path.relative(boundary, resolved).startsWith('..')) throw fail('SOURCE_LINK_UNSAFE');
            await fs.symlink(target, to);
        } else throw fail('SOURCE_TYPE_UNSAFE');
      }
    }
    await visit(source, destination);
}

async function clearPublished(html) {
    for (const name of await fs.readdir(html)) if (name !== 'istdbadmin') await fs.rm(`${html}/${name}`, { recursive: true, force: false });
}

async function inventory(root, prefix, entries = []) {
    const visit = async (directory, relative = '') => {
        const names = (await fs.readdir(directory)).sort();
        for (const name of names) {
            const current = relative ? `${relative}/${name}` : name, filename = `${directory}/${name}`, stat = await fs.lstat(filename);
            const item = { path: `${prefix}/${current}`, type: stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'special', mode: stat.mode & 0o777, uid: stat.uid, gid: stat.gid };
            if (item.type === 'file') { const bytes = await fs.readFile(filename); item.size = bytes.length; item.sha256 = fileHash(bytes); }
            else if (item.type === 'symlink') item.target = await fs.readlink(filename);
            else if (item.type !== 'directory') throw fail('INVENTORY_TYPE_UNSAFE');
            entries.push(item); if (item.type === 'directory') await visit(filename, current);
        }
    };
    const stat = await fs.lstat(root);
    entries.push({ path: prefix, type: 'directory', mode: stat.mode & 0o777, uid: stat.uid, gid: stat.gid });
    await visit(root); return entries;
}

async function readActive(paths) {
    if (!await exists(paths.active)) return null;
    const value = JSON.parse(await fs.readFile(paths.active, 'utf8'));
    if (!validateActive(value, paths)) throw fail('ACTIVE_STATE_INVALID');
    return value;
}

async function prepareInfrastructure(paths) {
    for (const directory of [paths.admin, paths.releases, paths.backups, paths.state, paths.transactions, paths.logs]) await ensureDirectory(directory);
    for (const persistent of [paths.repo, paths.html, paths.uploads, paths.backendPhp, paths.private]) if (!await exists(persistent)) throw fail('PERSISTENT_PATH_MISSING');
    for (const config of [paths.env, paths.envBackup]) if (!await exists(config)) throw fail('PERSISTENT_CONFIG_MISSING');
    const link = `${paths.html}/istdbadmin`;
    if (!(await fs.lstat(link)).isSymbolicLink() || await fs.readlink(link) !== paths.phpMyAdmin) throw fail('PHPMYADMIN_LINK_INVALID');
}

async function snapshotCurrent(paths, transactionId, active, runtime) {
    const backupId = randomUUID(), root = `${paths.backups}/${backupId}`, payload = `${root}/payload`;
    await ensureDirectory(root); await ensureDirectory(payload);
    const backend = active ? releasePaths(paths, active.backend.releaseId).backend : paths.repo;
    const runtimeRoots = new Set(['server.js', 'package.json', 'package-lock.json', 'angular.json', 'tsconfig.json', 'tsconfig.app.json', 'tsconfig.spec.json', '.postcssrc.json', 'src', 'node_modules']);
    await copyTree(backend, `${payload}/backend`, { skip: name => excludedBackend(name) || !runtimeRoots.has(name) });
    await copyTree(paths.html, `${payload}/frontend`, { skip: name => name === 'istdbadmin' });
    const entries = await inventory(`${payload}/backend`, 'backend'); await inventory(`${payload}/frontend`, 'frontend', entries);
    const manifest = { version: 1, backupId, sourceGeneration: active?.generation || 0, declaredCommitSha: active?.backend.commitSha || runtime.commitSha,
        runtime: { platform: process.platform, arch: process.arch, node: process.versions.node, abi: process.versions.modules }, entries };
    if (!validateBackupManifest(manifest, paths)) throw fail('BACKUP_MANIFEST_INVALID');
    const bytes = Buffer.from(JSON.stringify(manifest)); await fs.writeFile(`${root}/manifest.json`, bytes, { flag: 'wx', mode: 0o600 });
    const seal = { version: 1, backupId, manifestSha256: sha256(bytes), transactionId };
    if (!validateBackupSeal(seal)) throw fail('BACKUP_SEAL_INVALID');
    await fs.writeFile(`${root}/READY`, JSON.stringify(seal), { flag: 'wx', mode: 0o600 });
    return { backupId, root, payload, manifest, runtime };
}

async function installCandidate(paths, workspace, preparationId, prepared) {
    const releaseId = randomUUID(), release = releasePaths(paths, releaseId), candidate = `${workspace}/preparations/${preparationId}/release`;
    await ensureDirectory(release.root); await copyTree(`${candidate}/backend`, release.backend); await copyTree(`${candidate}/frontend`, release.frontend);
    await fs.symlink(paths.env, `${release.backend}/.env`); await fs.symlink(paths.private, `${release.backend}/istbrasil.private`);
    const entries = await inventory(release.backend, 'backend'); await inventory(release.frontend, 'frontend', entries);
    const manifest = { version: 1, releaseId, declaredCommitSha: prepared.commitSha,
        gitProvenance: { commitSha: prepared.commitSha, treeSha: prepared.treeSha, verifiedAt: now() },
        runtime: { platform: process.platform, arch: process.arch, node: process.versions.node, abi: process.versions.modules }, entries };
    if (!validateManifest(manifest, paths)) throw fail('RELEASE_MANIFEST_INVALID');
    const bytes = Buffer.from(JSON.stringify(manifest)); await fs.writeFile(release.manifest, bytes, { flag: 'wx', mode: 0o600 });
    return { releaseId, release, manifest, manifestSha256: sha256(bytes) };
}

async function publishFrontend(paths, source) {
    await clearPublished(paths.html); await copyTree(source, paths.html, { indexLast: true });
    const index = await fs.readFile(`${paths.html}/index.html`);
    if (!index.length || !(await fs.lstat(`${paths.html}/istdbadmin`)).isSymbolicLink()) throw fail('FRONTEND_HEALTH_FAILED');
    return fileHash(index);
}

async function restoreSnapshot(paths, snapshot, adapter) {
    await adapter.switchTo({ name: PM2_NAME, cwd: snapshot.runtime.cwd, script: snapshot.runtime.script });
    await publishFrontend(paths, `${snapshot.payload}/frontend`);
    await adapter.health();
}

async function defaultHealth() {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 5000);
    try { const response = await fetch('http://127.0.0.1:3000/', { signal: controller.signal }); if (!response.ok) throw fail('BACKEND_HEALTH_FAILED'); }
    finally { clearTimeout(timer); }
}

export function createPm2Adapter({ pm2Home = '/home/admin/.pm2', name = PM2_NAME, health = defaultHealth, command = 'pm2' } = {}) {
    if (command !== 'pm2' && !path.isAbsolute(command)) throw fail('PM2_COMMAND_INVALID');
    const env = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: path.dirname(pm2Home), PM2_HOME: pm2Home, LANG: 'C', LC_ALL: 'C' };
    const run = (args, maxBuffer = 4 * 1024 * 1024) => execute(command, args, { env, encoding: 'utf8', maxBuffer });
    const checkedHealth = async () => {
        let last;
        for (let attempt = 0; attempt < 12; attempt++) {
            try { return await health(); } catch (error) { last = error; if (attempt < 11) await new Promise(resolve => setTimeout(resolve, 250)); }
        }
        throw fail('BACKEND_HEALTH_FAILED', last);
    };
    return {
        async describe() {
            const { stdout } = await run(['jlist']);
            const matches = JSON.parse(stdout).filter(item => item.name === name);
            if (matches.length !== 1 || matches[0].pm2_env?.status !== 'online') throw fail('PM2_PROCESS_INVALID');
            const item = matches[0];
            let commitSha = '0000000000000000000000000000000000000000';
            try { commitSha = (await execute('git', ['-C', item.pm2_env.pm_cwd, 'rev-parse', '--verify', 'HEAD'], { env, encoding: 'utf8' })).stdout.trim(); } catch { /* active releases use active.json instead */ }
            return { name, cwd: item.pm2_env.pm_cwd, script: item.pm2_env.pm_exec_path, commitSha };
        },
        async switchTo(target) {
            await run(['delete', name]);
            try { await run(['start', target.script, '--name', name, '--cwd', target.cwd, '--update-env']); }
            catch (error) { throw fail('PM2_SWITCH_FAILED', error); }
        },
        health: checkedHealth,
    };
}

async function operation({ base, operation, workspace, preparationId, backupId, adapter, verifyPrepared = verifyPreparedRelease }) {
    if (process.platform !== 'linux' || process.getuid?.() === 0) throw fail('LINUX_NON_ROOT_REQUIRED');
    const paths = canonicalPaths(base); await prepareInfrastructure(paths);
    const transactionId = randomUUID(), releaseIdForJournal = operation === 'deploy' ? preparationId : randomUUID();
    const active = await readActive(paths), activeBytes = active ? await fs.readFile(paths.active) : null, generation = (active?.generation || 0) + 1;
    const journal = { version: 1, transactionId, operation, generation, releaseId: releaseIdForJournal, events: [{ phase: 'started', at: now() }] };
    const releaseLock = await acquire(paths, operation, transactionId); let retain = false, recoverySnapshot, activePublished = false, activationStarted = false;
    try {
        const runtime = await adapter.describe();
        const expectedBackend = active ? releasePaths(paths, active.backend.releaseId).backend : paths.repo;
        if (runtime.name !== PM2_NAME || runtime.cwd !== expectedBackend || runtime.script !== `${expectedBackend}/server.js`
            || typeof runtime.commitSha !== 'string' || !/^[a-f0-9]{40}$/.test(runtime.commitSha)) throw fail('CURRENT_RUNTIME_DIVERGENT');
        recoverySnapshot = await snapshotCurrent(paths, transactionId, active, runtime);
        let installed;
        if (operation === 'deploy') {
            const prepared = await verifyPrepared({ workspace, preparationId });
            installed = await installCandidate(paths, workspace, preparationId, prepared);
            await verifyPrepared({ workspace, preparationId }); // detect candidate substitution during promotion
            journal.releaseId = installed.releaseId;
        } else {
            const targetSnapshot = await loadBackup(paths, backupId, transactionId, active, runtime);
            installed = await installBackupAsRelease(paths, targetSnapshot); journal.releaseId = installed.releaseId;
        }
        await phase(paths, journal, 'prepared');
        activationStarted = true;
        await adapter.switchTo({ name: PM2_NAME, cwd: installed.release.backend, script: `${installed.release.backend}/server.js` });
        await phase(paths, journal, 'backend_activated');
        const indexSha256 = await publishFrontend(paths, installed.release.frontend);
        await phase(paths, journal, 'frontend_published');
        await adapter.health(); await phase(paths, journal, 'health_verified');
        const next = { version: 1, generation, transactionId, previousGeneration: active?.generation || null, confirmedAt: now(),
            backend: { kind: 'release', releaseId: installed.releaseId, commitSha: installed.manifest.declaredCommitSha, manifestSha256: installed.manifestSha256 },
            frontend: { releaseId: installed.releaseId, manifestSha256: installed.manifestSha256, indexSha256 },
            pm2: { name: PM2_NAME, user: 'admin', home: paths.pm2Home, cwd: installed.release.backend, script: `${installed.release.backend}/server.js`, node: '20.19.6' } };
        if (!validateActive(next, paths)) throw fail('ACTIVE_STATE_INVALID');
        await writeAtomic(paths.active, JSON.stringify(next)); activePublished = true; await phase(paths, journal, 'confirmed');
        return { active: next, backupId: recoverySnapshot.backupId, transactionId };
    } catch (error) {
        let rollbackError;
        if (recoverySnapshot && activationStarted) try { await restoreSnapshot(paths, recoverySnapshot, adapter); } catch (failure) { rollbackError = failure; retain = true; }
        if (activePublished) try { if (activeBytes) await writeAtomic(paths.active, activeBytes); else await fs.unlink(paths.active); }
        catch (failure) { rollbackError ||= failure; retain = true; }
        if (journal.events.at(-1).phase !== 'confirmed') try { await phase(paths, journal, 'failed'); } catch (failure) { rollbackError ||= failure; retain = true; }
        if (rollbackError) { try { Object.defineProperty(error, 'rollbackError', { value: rollbackError }); } catch { /* original wins */ } }
        throw error;
    } finally { await releaseLock(retain); }
}

async function loadBackup(paths, backupId, transactionId, active, runtime) {
    const root = `${paths.backups}/${backupId}`, manifestBytes = await fs.readFile(`${root}/manifest.json`), manifest = JSON.parse(manifestBytes);
    const seal = JSON.parse(await fs.readFile(`${root}/READY`, 'utf8'));
    if (!validateBackupManifest(manifest, paths) || !validateBackupSeal(seal) || seal.backupId !== backupId || seal.manifestSha256 !== sha256(manifestBytes)) throw fail('BACKUP_INVALID');
    const actual = await inventory(`${root}/payload/backend`, 'backend'); await inventory(`${root}/payload/frontend`, 'frontend', actual);
    if (JSON.stringify(actual) !== JSON.stringify(manifest.entries)) throw fail('BACKUP_INTEGRITY_FAILED');
    return { backupId, root, payload: `${root}/payload`, manifest, runtime, transactionId, active };
}

async function installBackupAsRelease(paths, snapshot) {
    const releaseId = randomUUID(), release = releasePaths(paths, releaseId);
    await ensureDirectory(release.root); await copyTree(`${snapshot.payload}/backend`, release.backend); await copyTree(`${snapshot.payload}/frontend`, release.frontend);
    await fs.symlink(paths.env, `${release.backend}/.env`); await fs.symlink(paths.private, `${release.backend}/istbrasil.private`);
    const entries = await inventory(release.backend, 'backend'); await inventory(release.frontend, 'frontend', entries);
    const manifest = { version: 1, releaseId, declaredCommitSha: snapshot.manifest.declaredCommitSha, gitProvenance: null,
        runtime: snapshot.manifest.runtime, entries };
    if (!validateManifest(manifest, paths)) throw fail('RESTORED_RELEASE_INVALID');
    const bytes = Buffer.from(JSON.stringify(manifest)); await fs.writeFile(release.manifest, bytes, { flag: 'wx', mode: 0o600 });
    return { releaseId, release, manifest, manifestSha256: sha256(bytes) };
}

export const activatePreparedRelease = input => operation({ ...input, operation: 'deploy' });
export const rollbackRelease = input => operation({ ...input, operation: 'rollback' });
