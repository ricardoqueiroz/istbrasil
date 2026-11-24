// Operational activation/rollback engine. It is intentionally not connected to deploy.sh.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { canonicalPaths, releasePaths, validId, validateActive, validateBackupManifest, validateBackupSeal, validateJournal, validateLock, validateManifest, classifyStorageContract, assessInitialInstallation, sha256 } from './production-contract.mjs';
import { verifyPreparedRelease, verifyPersistentPreparation, materializePersistentPreparation } from './release-prepare.mjs';
import {verificarArmazenamentoRelease,antesDeAtivar} from './storage-preflight.mjs';

const execute = promisify(execFile);
const FORMAT_VERSION = 1;
const PM2_NAME = 'ist-api';
const PUBLISH_HELPER = fileURLToPath(new URL('./bin/rename-noreplace-linux-x64', import.meta.url));
const PUBLISH_HELPER_SHA256 = 'aea83c5ef4f37b97ebc98c6dce39e527a3e23b99cbbb317d84e2cef61727470b';
const fileHash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = (code, cause) => Object.assign(new Error(code, cause ? { cause } : undefined), { code });
const now = () => new Date().toISOString();

async function exists(filename) { try { await fs.lstat(filename); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
async function privateDirectory(filename) {
    const stat = await fs.lstat(filename);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.mode & 0o022) throw fail('UNSAFE_OPERATION_DIRECTORY');
    return stat;
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
    await syncDirectory(path.dirname(filename));
}
async function syncFile(filename) {
    const handle = await fs.open(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try { await handle.sync(); } finally { await handle.close(); }
}
async function syncDirectory(filename) {
    const handle = await fs.open(filename, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0) | fs.constants.O_NOFOLLOW);
    try { await handle.sync(); } finally { await handle.close(); }
}
async function writeDurable(filename, bytes) {
    const handle = await fs.open(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}
function secondaryFailure(error, failure) {
    try { if (!error.rollbackError) Object.defineProperty(error, 'rollbackError', { value: failure }); } catch { /* original wins */ }
}
export function publicationExitCode(code) {
    if (code === 10) return 'BACKUP_DESTINATION_EXISTS';
    if (code === 11) return 'BACKUP_PUBLISH_UNAVAILABLE';
    if (code === 12) return 'BACKUP_CROSS_DEVICE';
    if (code === 13) return 'BACKUP_PUBLICATION_FAILED';
    return null;
}
async function validatePublishHelper() {
    if (process.platform !== 'linux' || process.arch !== 'x64') throw fail('BACKUP_HELPER_INCOMPATIBLE');
    let stat, real;
    try { stat = await fs.lstat(PUBLISH_HELPER); real = await fs.realpath(PUBLISH_HELPER); }
    catch (error) { throw fail('BACKUP_HELPER_UNAVAILABLE', error); }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || ![0, process.getuid()].includes(stat.uid)
        || (stat.mode & 0o7777) !== 0o755 || real !== PUBLISH_HELPER) throw fail('BACKUP_HELPER_INVALID');
    const bytes = await fs.readFile(PUBLISH_HELPER);
    if (bytes.length < 20 || bytes[0] !== 0x7f || bytes.subarray(1, 4).toString() !== 'ELF' || bytes[4] !== 2 || bytes[5] !== 1
        || bytes.readUInt16LE(18) !== 62 || fileHash(bytes) !== PUBLISH_HELPER_SHA256) throw fail('BACKUP_HELPER_INVALID');
}
export async function publishNoReplace(paths, transactionId, backupId, staging, root, run = execute) {
    const expectedStaging = `${paths.admin}/.snapshot-${transactionId}-${backupId}`, expectedRoot = `${paths.backups}/${backupId}`;
    if (staging !== expectedStaging || root !== expectedRoot || path.posix.dirname(staging) !== paths.admin || path.posix.dirname(root) !== paths.backups) throw fail('BACKUP_PUBLICATION_PATH_INVALID');
    await validatePublishHelper();
    const before = await fs.lstat(staging);
    if (!before.isDirectory() || before.isSymbolicLink() || before.uid !== process.getuid() || before.mode & 0o022) throw fail('BACKUP_STAGING_INVALID');
    try {
        await run(PUBLISH_HELPER, [staging, root], { env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' }, timeout: 10000, maxBuffer: 1024, windowsHide: true });
    } catch (error) {
        const mapped = publicationExitCode(error.code);
        if (mapped) throw fail(mapped, error);
        const uncertain = fail('BACKUP_PUBLICATION_UNCERTAIN', error); uncertain.publicationUncertain = true; throw uncertain;
    }
    try {
        const after = await fs.lstat(root);
        if (!after.isDirectory() || after.dev !== before.dev || after.ino !== before.ino || await exists(staging)) throw fail('BACKUP_PUBLICATION_UNCERTAIN');
    } catch (error) {
        if (error.code === 'BACKUP_PUBLICATION_UNCERTAIN') { error.publicationUncertain = true; throw error; }
        const uncertain = fail('BACKUP_PUBLICATION_UNCERTAIN', error); uncertain.publicationUncertain = true; throw uncertain;
    }
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
        await syncDirectory(path.dirname(paths.lock));
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

async function copyTree(source, destination, { skip = () => false, indexLast = false, normalizeFileModes = false, durable = false, preserveRoot = false, publicReadable = false } = {}) {
    const boundary = source;
    if (preserveRoot) {
        const stat = await fs.lstat(destination);
        if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(destination) !== destination) throw fail('DESTINATION_UNSAFE');
    } else await ensureDirectory(destination);
    const visit = async (fromDirectory, toDirectory, relative = '') => {
      const names = (await fs.readdir(fromDirectory)).filter(name => !relative && skip(name) ? false : true)
        .sort((a, b) => indexLast && !relative ? (a === 'index.html') - (b === 'index.html') || a.localeCompare(b) : a.localeCompare(b));
      for (const name of names) {
        const current = relative ? `${relative}/${name}` : name, from = `${fromDirectory}/${name}`, to = `${toDirectory}/${name}`, stat = await fs.lstat(from);
        if (stat.isDirectory() && !stat.isSymbolicLink()) { await ensureDirectory(to); if (publicReadable) await fs.chmod(to,0o755); await visit(from, to, current); }
        else if (stat.isFile() && !stat.isSymbolicLink()) {
            await fs.copyFile(from, to, fs.constants.COPYFILE_EXCL);
            const mode = stat.mode & 0o777;
            await fs.chmod(to, publicReadable ? (mode & 0o111 ? 0o755 : 0o644) : normalizeFileModes ? mode & ~0o022 : mode);
            if (durable) await syncFile(to);
        }
        else if (stat.isSymbolicLink()) {
            const target = await fs.readlink(from), resolved = path.resolve(path.dirname(from), target);
            if (path.isAbsolute(target) || path.relative(boundary, resolved).startsWith('..')) throw fail('SOURCE_LINK_UNSAFE');
            await fs.symlink(target, to);
        } else throw fail('SOURCE_TYPE_UNSAFE');
      }
      if (durable) await syncDirectory(toDirectory);
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
    const stat = await fs.lstat(paths.active);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o7777) !== 0o600) throw fail('ACTIVE_STATE_INVALID');
    const value = JSON.parse(await fs.readFile(paths.active, 'utf8'));
    if (!validateActive(value, paths)) throw fail('ACTIVE_STATE_INVALID');
    return value;
}

async function assertPriorJournalsResolved(paths, transactionId) {
    await privateDirectory(paths.transactions);
    for (const name of await fs.readdir(paths.transactions)) {
        if (!/^[a-f0-9-]{36}\.json$/.test(name)) throw fail('PRIOR_JOURNAL_INVALID');
        const filename = `${paths.transactions}/${name}`, stat = await fs.lstat(filename);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o7777) !== 0o600) throw fail('PRIOR_JOURNAL_INVALID');
        let envelope;
        try { envelope = JSON.parse(await fs.readFile(filename,'utf8')); } catch { throw fail('PRIOR_JOURNAL_INVALID'); }
        if (!validateJournal(envelope) || `${envelope.record.transactionId}.json` !== name) throw fail('PRIOR_JOURNAL_INVALID');
        if (envelope.record.transactionId === transactionId) continue;
        if (!['confirmed','recovered'].includes(envelope.record.events.at(-1).phase)) throw fail('PRIOR_TRANSACTION_UNRESOLVED');
    }
}

// A recuperação depende do runtime anterior: não presumir seu contrato nem
// confiar em um manifesto que não corresponde ao estado ativo e ao conteúdo.
async function verifiedActiveRelease(paths, active, {allowPending = false} = {}) {
    if (!active) throw fail('ACTIVE_RECOVERY_CONTRACT_UNPROVEN');
    if (active.homologation === 'pending' && !allowPending) throw fail('INITIAL_HOMOLOGATION_PENDING');
    const journalPath = `${paths.transactions}/${active.transactionId}.json`, journalStat = await fs.lstat(journalPath);
    if (!journalStat.isFile() || journalStat.isSymbolicLink() || journalStat.nlink !== 1 || journalStat.uid !== process.getuid() || (journalStat.mode & 0o7777) !== 0o600) throw fail('ACTIVE_JOURNAL_INVALID');
    const envelope = JSON.parse(await fs.readFile(journalPath,'utf8'));
    if (!validateJournal(envelope) || envelope.record.transactionId !== active.transactionId || envelope.record.releaseId !== active.backend.releaseId
        || envelope.record.generation !== active.generation || envelope.record.events.at(-1).phase !== 'confirmed') throw fail('ACTIVE_JOURNAL_INVALID');
    if (envelope.record.operation === 'install' && !Object.hasOwn(active,'homologation')) throw fail('INITIAL_HOMOLOGATION_MISSING');
    if (envelope.record.operation !== 'install' && Object.hasOwn(active,'homologation')) throw fail('INITIAL_HOMOLOGATION_INVALID');
    const release = releasePaths(paths, active.backend.releaseId);
    await privateDirectory(release.root);
    const manifestStat = await fs.lstat(release.manifest);
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.nlink !== 1 || manifestStat.uid !== process.getuid() || (manifestStat.mode & 0o7777) !== 0o600) throw fail('ACTIVE_RELEASE_MANIFEST_INVALID');
    const bytes = await fs.readFile(release.manifest), manifest = JSON.parse(bytes);
    const afterStat = await fs.lstat(release.manifest);
    if (manifestStat.dev !== afterStat.dev || manifestStat.ino !== afterStat.ino || manifestStat.size !== afterStat.size || manifestStat.mtimeMs !== afterStat.mtimeMs) throw fail('ACTIVE_RELEASE_MANIFEST_INVALID');
    if (sha256(bytes) !== active.backend.manifestSha256 || !validateManifest(manifest, paths)
        || manifest.releaseId !== active.backend.releaseId || manifest.declaredCommitSha !== active.backend.commitSha)
        throw fail('ACTIVE_RELEASE_MANIFEST_INVALID');
    const entries = await inventory(release.backend, 'backend'); await inventory(release.frontend, 'frontend', entries);
    if (JSON.stringify(entries) !== JSON.stringify(manifest.entries)) throw fail('ACTIVE_RELEASE_INTEGRITY_FAILED');
    classifyStorageContract(manifest, 'release', paths);
    return {release, manifest, digest: sha256(bytes)};
}

async function verifyPublishedInstitutional(paths, active, manifest) {
    if (active.frontend.releaseId !== active.backend.releaseId || active.frontend.manifestSha256 !== active.backend.manifestSha256) throw fail('PUBLISHED_RELEASE_DIVERGENCE');
    const stat = await fs.lstat(paths.html);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(paths.html) !== paths.html) throw fail('PUBLISHED_PATH_UNSAFE');
    const actual = await inventory(paths.html,'frontend');
    const expected = manifest.entries.filter(entry => entry.path === 'frontend' || entry.path.startsWith('frontend/'))
        .map(entry => entry.path === 'frontend' ? {...entry,mode:actual[0].mode} : entry.type === 'directory' ? {...entry,mode:0o755}
            : entry.type === 'file' ? {...entry,mode:entry.mode & 0o111 ? 0o755 : 0o644} : entry);
    verifyPreparedCopy({entries:expected},actual);
    const expectedByPath = new Map(expected.map(entry => [entry.path,entry]));
    for (const item of actual) {
        if (item.path === 'frontend') continue;
        const original = expectedByPath.get(item.path);
        if (!original || item.uid !== original.uid || item.gid !== original.gid) throw fail('PUBLISHED_OWNERSHIP_DIVERGENCE');
    }
    if (fileHash(await fs.readFile(`${paths.html}/index.html`)) !== active.frontend.indexSha256) throw fail('PUBLISHED_INDEX_DIVERGENCE');
}

async function verifyInstalledRelease(paths, installed) {
    const bytes = await fs.readFile(installed.release.manifest), manifest = JSON.parse(bytes);
    if (sha256(bytes) !== installed.manifestSha256 || !validateManifest(manifest, paths)
        || manifest.releaseId !== installed.releaseId) throw fail('INSTALLED_RELEASE_MANIFEST_INVALID');
    const entries = await inventory(installed.release.backend, 'backend'); await inventory(installed.release.frontend, 'frontend', entries);
    if (JSON.stringify(entries) !== JSON.stringify(manifest.entries)) throw fail('INSTALLED_RELEASE_INTEGRITY_FAILED');
    return manifest;
}

function verifyPreparedCopy(prepared, entries) {
    const expected = new Map(prepared.entries.filter(entry => !['backend/.env', 'backend/istbrasil.private'].includes(entry.path)).map(entry => [entry.path, entry]));
    const actual = entries.filter(entry => !['backend/.env', 'backend/istbrasil.private'].includes(entry.path));
    if (expected.size !== actual.length) throw fail('CANDIDATE_COPY_MISMATCH');
    for (const entry of actual) {
        const item = expected.get(entry.path);
        if (!item || item.type !== entry.type || item.type !== 'symlink' && item.mode !== entry.mode
            || item.type === 'file' && (item.size !== entry.size || item.sha256 !== entry.sha256)
            || item.type === 'symlink' && item.target !== entry.target) throw fail('CANDIDATE_COPY_MISMATCH');
    }
}

async function prepareInfrastructure(paths, {institutional = false} = {}) {
    for (const directory of [paths.admin, paths.releases, paths.backups, paths.state, paths.transactions]) await ensureDirectory(directory);
    for (const persistent of [paths.repo, paths.html, paths.uploads, paths.private, ...(!institutional ? [paths.backendPhp] : [])]) if (!await exists(persistent)) throw fail('PERSISTENT_PATH_MISSING');
    if (!await exists(paths.env)) throw fail('PERSISTENT_CONFIG_MISSING');
    if (!institutional) {
        const link = `${paths.html}/istdbadmin`;
        if (!(await fs.lstat(link)).isSymbolicLink() || await fs.readlink(link) !== paths.phpMyAdmin) throw fail('PHPMYADMIN_LINK_INVALID');
    }
}

async function snapshotCurrent(paths, transactionId, active, runtime, activeManifest) {
    const backupId = randomUUID(), root = `${paths.backups}/${backupId}`;
    const staging = `${paths.admin}/.snapshot-${transactionId}-${backupId}`, payload = `${staging}/payload`;
    let published = false;
    try {
        await ensureDirectory(staging); await ensureDirectory(payload); await syncDirectory(paths.admin);
        const backend = active ? releasePaths(paths, active.backend.releaseId).backend : paths.repo;
        await copyTree(backend, `${payload}/backend`, { skip: excludedBackend, normalizeFileModes: true, durable: true });
        await copyTree(paths.html, `${payload}/frontend`, { skip: name => name === 'istdbadmin', normalizeFileModes: true, durable: true });
        const entries = await inventory(`${payload}/backend`, 'backend'); await inventory(`${payload}/frontend`, 'frontend', entries);
        verifyPreparedCopy({entries: activeManifest.entries.filter(entry => entry.path === 'backend' || entry.path.startsWith('backend/'))}, entries.filter(entry => entry.path === 'backend' || entry.path.startsWith('backend/')));
        const manifest = { version: activeManifest.version, ...(activeManifest.version === 2 ? {storageContract: activeManifest.storageContract} : {}),
            ...(active?.homologation?.status === 'approved' ? {sourceApproval:active.homologation} : {}),
            backupId, sourceGeneration: active?.generation || 0, declaredCommitSha: active?.backend.commitSha || runtime.commitSha,
            runtime: { platform: process.platform, arch: process.arch, node: process.versions.node, abi: process.versions.modules }, entries };
        if (!validateBackupManifest(manifest, paths)) throw fail('BACKUP_MANIFEST_INVALID');
        const bytes = Buffer.from(JSON.stringify(manifest)); await writeDurable(`${staging}/manifest.json`, bytes);
        const seal = { version: 1, backupId, manifestSha256: sha256(bytes), transactionId };
        if (!validateBackupSeal(seal)) throw fail('BACKUP_SEAL_INVALID');
        await writeDurable(`${staging}/READY`, JSON.stringify(seal));
        const actual = await inventory(`${payload}/backend`, 'backend'); await inventory(`${payload}/frontend`, 'frontend', actual);
        if (JSON.stringify(actual) !== JSON.stringify(entries)) throw fail('BACKUP_INTEGRITY_FAILED');
        if (sha256(await fs.readFile(`${staging}/manifest.json`)) !== seal.manifestSha256
            || JSON.stringify(JSON.parse(await fs.readFile(`${staging}/READY`, 'utf8'))) !== JSON.stringify(seal)) throw fail('BACKUP_INTEGRITY_FAILED');
        await syncDirectory(staging);
        await publishNoReplace(paths, transactionId, backupId, staging, root);
        published = true;
        await syncDirectory(paths.backups); await syncDirectory(paths.admin);
        return { backupId, root, payload: `${root}/payload`, manifest, runtime, transactionId };
    } catch (error) {
        let stagingPresent, rootPresent;
        try { stagingPresent = await exists(staging); rootPresent = await exists(root); }
        catch (inspectionError) { secondaryFailure(error, inspectionError); throw error; }
        if (!published && !stagingPresent && rootPresent) published = true;
        if (!published && stagingPresent && !error.publicationUncertain) {
            try { await privateDirectory(staging); await fs.rm(staging, { recursive: true, force: false }); await syncDirectory(paths.admin); }
            catch (cleanupError) { secondaryFailure(error, cleanupError); }
        } else if (published || error.publicationUncertain) {
            secondaryFailure(error, fail('BACKUP_PUBLICATION_UNCERTAIN'));
        }
        throw error;
    }
}

async function installCandidate(paths, workspace, preparationId, prepared, selectedReleaseId = randomUUID()) {
    const releaseId = selectedReleaseId, release = releasePaths(paths, releaseId), candidate = `${workspace}/preparations/${preparationId}/release`;
    await fs.mkdir(release.root, {mode: 0o700}); const identity = await privateDirectory(release.root);
    await copyTree(`${candidate}/backend`, release.backend); await copyTree(`${candidate}/frontend`, release.frontend);
    await fs.symlink(paths.env, `${release.backend}/.env`); await fs.symlink(paths.private, `${release.backend}/istbrasil.private`);
    const entries = await inventory(release.backend, 'backend'); await inventory(release.frontend, 'frontend', entries);
    verifyPreparedCopy(prepared, entries);
    const manifest = { version: prepared.version, ...(prepared.version === 2 ? {storageContract: prepared.storageContract} : {}), releaseId, declaredCommitSha: prepared.commitSha,
        gitProvenance: prepared.sourceType === 'package' ? null : { commitSha: prepared.commitSha, treeSha: prepared.treeSha, verifiedAt: now() },
        runtime: { platform: process.platform, arch: process.arch, node: process.versions.node, abi: process.versions.modules }, entries };
    if (!validateManifest(manifest, paths)) throw fail('RELEASE_MANIFEST_INVALID');
    const bytes = Buffer.from(JSON.stringify(manifest)); await fs.writeFile(release.manifest, bytes, { flag: 'wx', mode: 0o600 });
    return { releaseId, release, manifest, manifestSha256: sha256(bytes), identity: {dev:identity.dev,ino:identity.ino} };
}

async function finalizePersistentCandidate(paths, materialized) {
    const { preparationId, release, manifest: prepared } = materialized;
    if (release.root !== releasePaths(paths, preparationId).root || (await fs.readdir(release.root)).sort().join('|') !== 'backend|frontend')
        throw fail('MATERIALIZED_PREPARATION_INVALID');
    await fs.symlink(paths.env, `${release.backend}/.env`); await fs.symlink(paths.private, `${release.backend}/istbrasil.private`);
    const entries = await inventory(release.backend, 'backend'); await inventory(release.frontend, 'frontend', entries);
    verifyPreparedCopy(prepared, entries);
    const manifest = { version: prepared.version, ...(prepared.version === 2 ? {storageContract: prepared.storageContract} : {}), releaseId: preparationId, declaredCommitSha: prepared.commitSha,
        gitProvenance: prepared.sourceType === 'package' ? null : { commitSha: prepared.commitSha, treeSha: prepared.treeSha, verifiedAt: now() },
        runtime: { platform: process.platform, arch: process.arch, node: process.versions.node, abi: process.versions.modules }, entries };
    if (!validateManifest(manifest, paths)) throw fail('RELEASE_MANIFEST_INVALID');
    const bytes = Buffer.from(JSON.stringify(manifest)); await writeDurable(release.manifest, bytes); await syncDirectory(release.root);
    return { releaseId: preparationId, release, manifest, manifestSha256: sha256(bytes) };
}

async function publishFrontend(paths, source, {institutional = false} = {}) {
    await clearPublished(paths.html); await copyTree(source, paths.html, { indexLast: true, preserveRoot:institutional, publicReadable:institutional });
    const index = await fs.readFile(`${paths.html}/index.html`);
    if (!index.length || !institutional && !(await fs.lstat(`${paths.html}/istdbadmin`)).isSymbolicLink()) throw fail('FRONTEND_HEALTH_FAILED');
    return fileHash(index);
}

async function restoreSnapshot(paths, snapshot, adapter, active) {
    const verified = await loadBackup(paths, snapshot.backupId, snapshot.transactionId, active, snapshot.runtime);
    if (verified.seal.transactionId !== snapshot.transactionId || JSON.stringify(verified.manifest) !== JSON.stringify(snapshot.manifest)) throw fail('RECOVERY_SNAPSHOT_CHANGED');
    await verificarArmazenamentoRelease({backend: `${verified.payload}/backend`, arquivoEnv: paths.env, base: paths.base, manifest: verified.manifest, kind: 'backup', paths});
    const previous = await verifiedActiveRelease(paths, active);
    verifyPreparedCopy({entries:verified.manifest.entries.filter(entry=>entry.path==='backend'||entry.path.startsWith('backend/'))},
        previous.manifest.entries.filter(entry=>entry.path==='backend'||entry.path.startsWith('backend/')));
    await verificarArmazenamentoRelease({backend: previous.release.backend, arquivoEnv: paths.env, base: paths.base, manifest: previous.manifest, kind: 'release', paths});
    await adapter.switchTo({ name: PM2_NAME, cwd: snapshot.runtime.cwd, script: snapshot.runtime.script });
    await publishFrontend(paths, `${snapshot.payload}/frontend`, {institutional:previous.manifest.storageContract === 'institutional-v1'});
    await adapter.health();
    const runtime = await adapter.describe();
    if (runtime.name !== PM2_NAME || runtime.cwd !== snapshot.runtime.cwd || runtime.script !== snapshot.runtime.script) throw fail('RECOVERY_PROCESS_DIVERGENCE');
    const institutional = previous.manifest.storageContract === 'institutional-v1';
    if (institutional) await adapter.inspectInstitutional({cwd:snapshot.runtime.cwd,script:snapshot.runtime.script});
    const actual = (await inventory(paths.html,'frontend')).filter(entry => institutional || entry.path !== 'frontend/istdbadmin');
    const expected = verified.manifest.entries.filter(entry=>entry.path==='frontend'||entry.path.startsWith('frontend/'))
        .map(entry=>entry.path==='frontend'?{...entry,mode:actual[0].mode}:institutional && entry.type==='directory'?{...entry,mode:0o755}
            :institutional && entry.type==='file'?{...entry,mode:entry.mode & 0o111 ? 0o755 : 0o644}:entry);
    verifyPreparedCopy({entries:expected},actual);
}

async function defaultHealth() {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 5000);
    try { const response = await fetch('http://127.0.0.1:3000/', { signal: controller.signal }); if (!response.ok) throw fail('BACKEND_HEALTH_FAILED'); }
    finally { clearTimeout(timer); }
}

export function createPm2Adapter({ base, pm2Home = '/home/admin/.pm2', name = PM2_NAME, health = defaultHealth, command = 'pm2', executeCommand = execute } = {}) {
    if (command !== 'pm2' && !path.isAbsolute(command)) throw fail('PM2_COMMAND_INVALID');
    // Storage is configured exclusively by the persistent .env, never by PM2.
    const env = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: path.dirname(pm2Home), PM2_HOME: pm2Home, LANG: 'C', LC_ALL: 'C' };
    const run = (args, maxBuffer = 4 * 1024 * 1024) => executeCommand(command, args, { env, encoding: 'utf8', maxBuffer });
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
        async assertInitialEmpty() {
            const processes = await inspectAuthorizedPm2({pm2Home, command, executeCommand});
            assertNoInstitutionalPm2Processes(processes, canonicalPaths(base));
        },
        async inspectInstitutional(expected) {
            const matches = (await inspectAuthorizedPm2({pm2Home,command,executeCommand})).filter(item=>item.name===name);
            if (matches.length !== 1 || matches[0].status !== 'online' || matches[0].cwd !== expected.cwd || matches[0].script !== expected.script
                || !Number.isInteger(matches[0].pid) || matches[0].pid <= 0) throw fail('HOMOLOGATION_PROCESS_INVALID');
            const proc = `/proc/${matches[0].pid}`;
            if ((await fs.stat(proc)).uid !== process.getuid() || await fs.realpath(`${proc}/cwd`) !== expected.cwd) throw fail('HOMOLOGATION_PROCESS_INVALID');
            const stat = await fs.readFile(`${proc}/stat`,'utf8'), startTicks = stat.slice(stat.lastIndexOf(')')+2).split(' ')[19];
            if (!/^\d+$/.test(startTicks)) throw fail('HOMOLOGATION_PROCESS_INVALID');
            return {pid:matches[0].pid,startTicks,cwd:matches[0].cwd,script:matches[0].script};
        },
        async startInitial(target) {
            await this.assertInitialEmpty();
            await run(['start', target.script, '--name', name, '--cwd', target.cwd, '--update-env']);
            const matches = (await inspectAuthorizedPm2({pm2Home,command,executeCommand})).filter(item => item.name === name);
            if (matches.length !== 1 || matches[0].status !== 'online' || matches[0].cwd !== target.cwd || matches[0].script !== target.script
                || !Number.isInteger(matches[0].pid) || matches[0].pid <= 0 || !Number.isInteger(matches[0].pmId)) throw fail('INITIAL_PROCESS_IDENTITY_UNPROVEN');
            const item = matches[0], stat = await fs.readFile(`/proc/${item.pid}/stat`, 'utf8');
            if ((await fs.stat(`/proc/${item.pid}`)).uid !== process.getuid()) throw fail('INITIAL_PROCESS_IDENTITY_UNPROVEN');
            const startTicks = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
            if (!/^\d+$/.test(startTicks)) throw fail('INITIAL_PROCESS_IDENTITY_UNPROVEN');
            return {pid:item.pid, pmId:item.pmId, startTicks, cwd:target.cwd, script:target.script};
        },
        async stopInitial(identity) {
            const matches = (await inspectAuthorizedPm2({pm2Home,command,executeCommand})).filter(item => item.name === name);
            if (matches.length !== 1 || matches[0].pid !== identity.pid || matches[0].pmId !== identity.pmId
                || matches[0].cwd !== identity.cwd || matches[0].script !== identity.script) throw fail('INITIAL_PROCESS_IDENTITY_CHANGED');
            const stat = await fs.readFile(`/proc/${identity.pid}/stat`, 'utf8');
            if ((await fs.stat(`/proc/${identity.pid}`)).uid !== process.getuid()) throw fail('INITIAL_PROCESS_IDENTITY_CHANGED');
            if (stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] !== identity.startTicks) throw fail('INITIAL_PROCESS_IDENTITY_CHANGED');
            await run(['delete', String(identity.pmId)]);
            const after = await inspectAuthorizedPm2({pm2Home,command,executeCommand});
            if (after.some(item => item.name === name || item.pid === identity.pid)) throw fail('INITIAL_PROCESS_NOT_STOPPED');
        },
        health: checkedHealth,
    };
}

export function assertNoInstitutionalPm2Processes(processes, paths) {
    if (!Array.isArray(processes)) throw fail('INITIAL_PM2_VISIBILITY_UNPROVEN');
    for (const item of processes) {
        if (!item || typeof item.name !== 'string' || typeof item.cwd !== 'string' || typeof item.script !== 'string') throw fail('INITIAL_PM2_VISIBILITY_UNPROVEN');
        if (item.name === PM2_NAME || item.cwd === paths.repo || item.cwd.startsWith(`${paths.releases}/`)
            || item.script === `${paths.repo}/server.js` || item.script.startsWith(`${paths.releases}/`)) throw fail('INITIAL_PM2_PROCESS_EXISTS');
    }
}

// Consulta somente o socket do daemon autorizado, sem Client.start() ou CLI
// que possam iniciar outro daemon durante uma inspeção.
export async function inspectAuthorizedPm2({pm2Home, command = 'pm2', executeCommand = execute}) {
    const homePresent = await exists(pm2Home), pidPath = `${pm2Home}/pm2.pid`, socketPath = `${pm2Home}/rpc.sock`, pubPath = `${pm2Home}/pub.sock`;
    if (homePresent) {
        const home = await fs.lstat(pm2Home);
        if (!home.isDirectory() || home.isSymbolicLink() || home.uid !== process.getuid() || home.mode & 0o022 || await fs.realpath(pm2Home) !== pm2Home) throw fail('INITIAL_PM2_VISIBILITY_UNPROVEN');
    }
    const pidPresent = await exists(pidPath), socketPresent = await exists(socketPath), pubPresent = await exists(pubPath);
    if (!pidPresent && !socketPresent && !pubPresent) return [];
    if (!homePresent || !pidPresent || !socketPresent || !pubPresent) throw fail('INITIAL_PM2_VISIBILITY_UNPROVEN');
    const pidFile = await fs.lstat(pidPath), socket = await fs.lstat(socketPath), pub = await fs.lstat(pubPath);
    if (!pidFile.isFile() || pidFile.isSymbolicLink() || pidFile.uid !== process.getuid() || pidFile.nlink !== 1 || pidFile.mode & 0o022
        || !socket.isSocket() || socket.uid !== process.getuid() || !pub.isSocket() || pub.uid !== process.getuid() || pidFile.size > 32) throw fail('INITIAL_PM2_VISIBILITY_UNPROVEN');
    const pidText = (await fs.readFile(pidPath,'utf8')).trim();
    if (!/^[1-9]\d*$/.test(pidText)) throw fail('INITIAL_PM2_VISIBILITY_UNPROVEN');
    const proc = `/proc/${pidText}`, stat = await fs.stat(proc), cmd = (await fs.readFile(`${proc}/cmdline`)).toString('utf8');
    const first = await fs.readFile(`${proc}/stat`,'utf8');
    if (stat.uid !== process.getuid() || !cmd.includes('God Daemon') || !cmd.includes(pm2Home)) throw fail('INITIAL_PM2_VISIBILITY_UNPROVEN');
    let bin;
    const candidates = path.isAbsolute(command) ? [command] : ['/usr/local/bin','/usr/bin','/bin'].map(dir=>`${dir}/${command}`);
    for (const candidate of candidates) try { await fs.access(candidate,fs.constants.X_OK); bin = await fs.realpath(candidate); break; } catch { /* próximo caminho */ }
    if (!bin) throw fail('INITIAL_PM2_VISIBILITY_UNPROVEN');
    const client = path.resolve(path.dirname(bin),'..','lib','Client.js'), clientStat = await fs.lstat(client);
    if (!clientStat.isFile() || clientStat.isSymbolicLink() || ![0,process.getuid()].includes(clientStat.uid) || clientStat.mode & 0o022 || await fs.realpath(client) !== client) throw fail('INITIAL_PM2_VISIBILITY_UNPROVEN');
    for (let dir = path.dirname(client); ; dir = path.dirname(dir)) {
        const parent = await fs.lstat(dir);
        if (!parent.isDirectory() || parent.isSymbolicLink() || ![0,process.getuid()].includes(parent.uid) || parent.mode & 0o022) throw fail('INITIAL_PM2_VISIBILITY_UNPROVEN');
        if (dir === '/') break;
    }
    const script = `const Client=require(process.argv[1]);const c=Object.create(Client.prototype);c.rpc_socket_file=process.argv[2];c.launchRPC(e=>{if(e)process.exit(2);c.executeRemote('getMonitorData',{},(err,items)=>{if(err||!Array.isArray(items))process.exit(3);process.stdout.write(JSON.stringify(items.map(x=>({name:x.name,cwd:x.pm2_env?.pm_cwd,script:x.pm2_env?.pm_exec_path,pid:x.pid,pmId:x.pm_id,status:x.pm2_env?.status}))));c.disconnectRPC(()=>process.exit(0));});});`;
    let result;
    try { result = await executeCommand(process.execPath,['-e',script,client,socketPath],{env:{PATH:'/usr/bin:/bin',HOME:path.dirname(pm2Home),PM2_HOME:pm2Home,LANG:'C'},encoding:'utf8',timeout:10000,maxBuffer:1024*1024}); }
    catch { throw fail('INITIAL_PM2_VISIBILITY_UNPROVEN'); }
    if (result.stderr || !result.stdout) throw fail('INITIAL_PM2_VISIBILITY_UNPROVEN');
    const second = await fs.readFile(`${proc}/stat`,'utf8'), afterSocket = await fs.lstat(socketPath), afterPid = await fs.lstat(pidPath), afterClient = await fs.lstat(client);
    if (first.slice(first.lastIndexOf(')')+2).split(' ')[19] !== second.slice(second.lastIndexOf(')')+2).split(' ')[19]
        || socket.dev !== afterSocket.dev || socket.ino !== afterSocket.ino || pidFile.dev !== afterPid.dev || pidFile.ino !== afterPid.ino
        || (await fs.readFile(pidPath,'utf8')).trim() !== pidText || clientStat.dev !== afterClient.dev || clientStat.ino !== afterClient.ino
        || clientStat.size !== afterClient.size || clientStat.mtimeMs !== afterClient.mtimeMs) throw fail('INITIAL_PM2_VISIBILITY_UNPROVEN');
    try { return JSON.parse(result.stdout); } catch { throw fail('INITIAL_PM2_VISIBILITY_UNPROVEN'); }
}

export function resolvedInitialJournal(envelope, name, recovering) {
    if (!validateJournal(envelope) || `${envelope.record.transactionId}.json` !== name || envelope.record.operation !== 'install') return false;
    const last = envelope.record.events.at(-1).phase;
    return last === 'recovered' || recovering === envelope.record.transactionId && last === 'failed';
}

export async function checkInitialEnvironment(paths, {recovering, transactionId} = {}) {
    for (const filename of [paths.base, paths.repo, paths.uploads, paths.private, paths.admin, paths.releases, paths.backups, paths.state, paths.transactions]) {
        const stat = await fs.lstat(filename);
        if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(filename) !== filename || stat.mode & 0o022) throw fail('INITIAL_PATH_UNSAFE');
    }
    for (const filename of [paths.admin, paths.releases, paths.backups, paths.state, paths.transactions]) await privateDirectory(filename);
    const config = await fs.lstat(paths.env);
    if (!config.isFile() || config.isSymbolicLink() || config.uid !== process.getuid() || config.mode & 0o077) throw fail('INITIAL_CONFIG_UNSAFE');
    if (await exists(paths.active)) throw fail('INITIAL_ACTIVE_EXISTS');
    if (await exists(paths.lock)) {
        const lock = JSON.parse(await fs.readFile(paths.lock,'utf8'));
        if (!transactionId || !validateLock(lock) || lock.transactionId !== transactionId || lock.pid !== process.pid) throw fail('INITIAL_LOCK_CONFLICT');
    } else if (transactionId) throw fail('INITIAL_LOCK_CONFLICT');
    if ((await fs.readdir(paths.state)).some(name => !['PRODUCTION_APPROVED','operation.lock'].includes(name))) throw fail('INITIAL_STATE_NOT_EMPTY');
    for (const name of await fs.readdir(paths.transactions)) {
        if (!/^[a-f0-9-]{36}\.json$/.test(name)) throw fail('INITIAL_STATE_NOT_EMPTY');
        const filename = `${paths.transactions}/${name}`, st = await fs.lstat(filename);
        if (!st.isFile() || st.isSymbolicLink() || st.uid !== process.getuid() || (st.mode & 0o7777) !== 0o600 || st.nlink !== 1) throw fail('INITIAL_STATE_NOT_EMPTY');
        const envelope = JSON.parse(await fs.readFile(filename,'utf8'));
        if (!resolvedInitialJournal(envelope,name,recovering)) throw fail('INITIAL_STATE_NOT_EMPTY');
    }
    if ((await fs.readdir(paths.releases)).length || (await fs.readdir(paths.backups)).length) throw fail('INITIAL_STATE_NOT_EMPTY');
    if (await exists(paths.preparations)) {
        await privateDirectory(paths.preparations);
        if (await fs.realpath(paths.preparations) !== paths.preparations || (await fs.readdir(paths.preparations)).length) throw fail('INITIAL_STATE_NOT_EMPTY');
    }
    if (await exists(paths.html)) {
        const stat = await fs.lstat(paths.html);
        if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(paths.html) !== paths.html || stat.mode & 0o022 || (stat.mode & 0o005) !== 0o005 || (await fs.readdir(paths.html)).length) throw fail('INITIAL_PUBLIC_NOT_EMPTY');
    }
    const capacity = await fs.statfs(paths.base, {bigint:true});
    if (capacity.bavail * capacity.bsize < 10n * 1024n ** 3n) throw fail('INITIAL_SPACE_INSUFFICIENT');
    const mounts = await fs.readFile('/proc/mounts', 'utf8');
    if (/hidepid=/.test(mounts)) throw fail('INITIAL_PROCESS_VISIBILITY_UNPROVEN');
    for (const pid of (await fs.readdir('/proc')).filter(name => /^\d+$/.test(name))) {
        try {
            const args = (await fs.readFile(`/proc/${pid}/cmdline`)).toString('utf8').split('\0');
            if (args.some(arg => arg === 'ist-api' || arg === 'pm2: ist-api')) throw fail('INITIAL_PROCESS_EXISTS');
            if (args.join(' ').includes('God Daemon') && args.join(' ').includes(paths.pm2Home)
                && (!await exists(`${paths.pm2Home}/pm2.pid`) || !await exists(`${paths.pm2Home}/rpc.sock`))) throw fail('INITIAL_PROCESS_VISIBILITY_UNPROVEN');
            if (args.some(Boolean)) {
                if (args.some(arg => arg === `${paths.repo}/server.js` || arg.startsWith(`${paths.releases}/`))) throw fail('INITIAL_PROCESS_EXISTS');
                if (args.some(arg => path.basename(arg) === 'server.js')) {
                    const cwd = await fs.readlink(`/proc/${pid}/cwd`);
                    if (cwd === paths.repo || cwd.startsWith(`${paths.releases}/`)) throw fail('INITIAL_PROCESS_EXISTS');
                }
                const environment = (await fs.readFile(`/proc/${pid}/environ`)).toString('utf8').split('\0');
                if (environment.some(value => value === 'name=ist-api')) throw fail('INITIAL_PROCESS_EXISTS');
                if (args.join(' ').includes('God Daemon') && environment.includes(`PM2_HOME=${paths.pm2Home}`)
                    && (!await exists(`${paths.pm2Home}/pm2.pid`) || !await exists(`${paths.pm2Home}/rpc.sock`))) throw fail('INITIAL_PROCESS_VISIBILITY_UNPROVEN');
            }
        } catch (error) {
            if (error.code === 'INITIAL_PROCESS_EXISTS') throw error;
            if (!['ENOENT', 'ESRCH'].includes(error.code)) throw fail('INITIAL_PROCESS_VISIBILITY_UNPROVEN');
        }
    }
    const sockets = await execute('ss', ['-H', '-ltn', 'sport = :3000'], {env:{PATH:'/usr/bin:/bin',LANG:'C'},encoding:'utf8',timeout:10000});
    if (sockets.stdout.trim()) throw fail('INITIAL_PORT_IN_USE');
    const store = `${paths.base}/lojavirtual`;
    if ([paths.repo,paths.html,paths.uploads,paths.admin].some(filename => filename === store || filename.startsWith(`${store}/`) || store.startsWith(`${filename}/`))) throw fail('INITIAL_PATH_UNSAFE');
    return {activeAbsent:true,operationStateClear:true,journalClear:true,processVisibilityProven:true,
        backendPortFree:true,publicDirectoryEmptyOrAbsent:true,pathsCanonicalSafe:true,accessSafe:true,spaceSufficient:true,wordpressIsolated:true};
}

export async function homologateInitialRelease({base, releaseId, manifestSha256, adapter, writeActive = writeAtomic}) {
    if (process.platform !== 'linux' || process.getuid?.() === 0 || !validId(releaseId) || !/^[a-f0-9]{64}$/.test(manifestSha256)) throw fail('HOMOLOGATION_ARGUMENT_INVALID');
    const paths = canonicalPaths(base), transactionId = randomUUID();
    await privateDirectory(paths.state); await privateDirectory(paths.transactions);
    const releaseLock = await acquire(paths,'homologate',transactionId);
    let retain = false, original, replacement, writing = false;
    try {
        const stateNames = await fs.readdir(paths.state);
        if (stateNames.some(name => !['active.json','operation.lock','PRODUCTION_APPROVED','transactions'].includes(name))
            || (await fs.readdir(paths.admin)).some(name => name.startsWith('.snapshot-') || name.startsWith('.pending-'))
            || (await fs.readdir(paths.backups)).length) throw fail('HOMOLOGATION_STATE_AMBIGUOUS');
        if (await exists(paths.preparations) && (await fs.readdir(paths.preparations)).length) throw fail('HOMOLOGATION_STATE_AMBIGUOUS');
        const st = await fs.lstat(paths.active);
        if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.uid !== process.getuid() || (st.mode & 0o7777) !== 0o600) throw fail('HOMOLOGATION_ACTIVE_UNSAFE');
        original = await fs.readFile(paths.active,'utf8');
        const active = JSON.parse(original);
        if (!validateActive(active,paths) || active.homologation !== 'pending' || active.generation !== 1) throw fail('HOMOLOGATION_ACTIVE_INVALID');
        if (active.backend.releaseId !== releaseId || active.frontend.releaseId !== releaseId
            || active.backend.manifestSha256 !== manifestSha256 || active.frontend.manifestSha256 !== manifestSha256) throw fail('HOMOLOGATION_IDENTITY_MISMATCH');
        if ((await fs.readdir(paths.releases)).some(name => name !== releaseId)) throw fail('HOMOLOGATION_STATE_AMBIGUOUS');
        let initialConfirmed = false;
        for (const name of await fs.readdir(paths.transactions)) {
            if (!/^[a-f0-9-]{36}\.json$/.test(name)) throw fail('HOMOLOGATION_JOURNAL_INVALID');
            const filename = `${paths.transactions}/${name}`, info = await fs.lstat(filename);
            if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== process.getuid() || (info.mode & 0o7777) !== 0o600) throw fail('HOMOLOGATION_JOURNAL_INVALID');
            const envelope = JSON.parse(await fs.readFile(filename,'utf8'));
            if (!validateJournal(envelope) || `${envelope.record.transactionId}.json` !== name) throw fail('HOMOLOGATION_JOURNAL_INVALID');
            const record = envelope.record, terminal = record.events.at(-1).phase;
            if (!['confirmed','recovered'].includes(terminal)) throw fail('HOMOLOGATION_TRANSACTION_INCOMPLETE');
            if (record.transactionId === active.transactionId) initialConfirmed = record.operation === 'install' && record.generation === 1 && record.releaseId === releaseId && terminal === 'confirmed';
            else if (terminal !== 'recovered' || record.operation !== 'install') throw fail('HOMOLOGATION_JOURNAL_INVALID');
        }
        if (!initialConfirmed) throw fail('HOMOLOGATION_INITIAL_JOURNAL_MISSING');
        const verified = await verifiedActiveRelease(paths,active,{allowPending:true});
        if (verified.digest !== manifestSha256 || verified.manifest.storageContract !== 'institutional-v1' || verified.manifest.version !== 2) throw fail('HOMOLOGATION_CONTRACT_INVALID');
        if (verified.manifest.runtime.platform !== process.platform || verified.manifest.runtime.arch !== process.arch
            || verified.manifest.runtime.node !== process.versions.node || verified.manifest.runtime.abi !== process.versions.modules) throw fail('HOMOLOGATION_RUNTIME_INCOMPATIBLE');
        await verifyPublishedInstitutional(paths,active,verified.manifest);
        await verificarArmazenamentoRelease({backend:verified.release.backend,manifest:verified.manifest,kind:'release',paths});
        const observed = await adapter.inspectInstitutional(active.pm2);
        if (!Number.isInteger(observed?.pid) || observed.pid <= 0 || typeof observed.startTicks !== 'string' || !/^\d+$/.test(observed.startTicks)) throw fail('HOMOLOGATION_PROCESS_INVALID');
        await adapter.health();
        if (await fs.readFile(paths.active,'utf8') !== original) throw fail('HOMOLOGATION_STATE_CHANGED');
        await verifiedActiveRelease(paths,active,{allowPending:true}); await verifyPublishedInstitutional(paths,active,verified.manifest);
        const after = await adapter.inspectInstitutional(active.pm2);
        if (after?.pid !== observed.pid || after?.startTicks !== observed.startTicks) throw fail('HOMOLOGATION_PROCESS_CHANGED');
        const operator = os.userInfo();
        const next = {...active,homologation:{status:'approved',releaseId,manifestSha256,approvedAt:now(),operator:{uid:process.getuid(),name:operator.username}}};
        if (!validateActive(next,paths)) throw fail('HOMOLOGATION_RECORD_INVALID');
        replacement = JSON.stringify(next); writing = true;
        await writeActive(paths.active,replacement);
        if (await fs.readFile(paths.active,'utf8') !== replacement) throw fail('HOMOLOGATION_WRITE_UNCONFIRMED');
        return next;
    } catch (error) {
        if (writing) try {
            const current = await fs.readFile(paths.active,'utf8');
            if (current !== original) {
                if (current !== replacement) throw fail('HOMOLOGATION_STATE_CHANGED');
                await writeAtomic(paths.active,original);
                if (await fs.readFile(paths.active,'utf8') !== original) throw fail('HOMOLOGATION_RESTORE_FAILED');
            }
        } catch (failure) { retain = true; secondaryFailure(error,failure); }
        throw error;
    } finally { await releaseLock(retain); }
}

export async function installInitialRelease({base, workspace, preparationId, adapter, verifyPrepared = verifyPreparedRelease, checkEnvironment = checkInitialEnvironment}) {
    if (process.platform !== 'linux' || process.getuid?.() === 0 || !validId(preparationId)) throw fail('INITIAL_ARGUMENT_INVALID');
    const paths = canonicalPaths(base), transactionId = randomUUID(), releaseId = randomUUID();
    // Diretórios administrativos são pré-requisitos reais, nunca criados aqui
    // para mascarar uma instalação anterior ou um estado parcial.
    await privateDirectory(paths.state); await privateDirectory(paths.transactions);
    const releaseLock = await acquire(paths, 'install', transactionId);
    let retain = false, journal, installed, processIdentity, publicIdentity, initialPublicStat, publicCreated = false, processStartAttempt = false, activeBytes;
    try {
        const evidence = await checkEnvironment(paths,{transactionId});
        initialPublicStat = await fs.lstat(paths.html).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
        const prepared = await verifyPrepared({workspace, preparationId});
        if (prepared.version !== 2 || prepared.storageContract !== 'institutional-v1') throw fail('INITIAL_CANDIDATE_CONTRACT_INVALID');
        journal = {version:1,transactionId,operation:'install',generation:1,releaseId,events:[{phase:'started',at:now()}]};
        await saveJournal(paths, journal);
        await adapter.assertInitialEmpty();
        if (!assessInitialInstallation({...evidence,institutionalProcessAbsent:true}).eligible) throw fail('INITIAL_ELIGIBILITY_UNPROVEN');
        installed = await installCandidate(paths, workspace, preparationId, prepared, releaseId);
        journal.releaseIdentity = installed.identity;
        await saveJournal(paths, journal);
        await verifyPrepared({workspace, preparationId});
        const manifest = await verifyInstalledRelease(paths, installed);
        await verificarArmazenamentoRelease({backend:installed.release.backend,manifest,kind:'release',paths});
        await phase(paths,journal,'prepared');
        processStartAttempt = true;
        processIdentity = await adapter.startInitial({name:PM2_NAME,cwd:installed.release.backend,script:`${installed.release.backend}/server.js`});
        journal.process = processIdentity;
        await phase(paths,journal,'backend_activated');
        if (!await exists(paths.html)) { await fs.mkdir(paths.html,{mode:0o755}); await fs.chmod(paths.html,0o755); publicCreated = true; }
        publicIdentity = await fs.lstat(paths.html);
        if (!publicIdentity.isDirectory() || publicIdentity.isSymbolicLink() || await fs.realpath(paths.html) !== paths.html || publicIdentity.mode & 0o022 || (publicIdentity.mode & 0o005) !== 0o005 || (await fs.readdir(paths.html)).length) throw fail('INITIAL_PUBLIC_NOT_EMPTY');
        journal.publicIdentity = {dev:publicIdentity.dev,ino:publicIdentity.ino,created:publicCreated};
        await saveJournal(paths,journal);
        await copyTree(installed.release.frontend,paths.html,{indexLast:true,preserveRoot:true,publicReadable:true});
        const publicEntries = await inventory(paths.html,'frontend');
        const expectedPublic = prepared.entries.filter(entry=>entry.path==='frontend'||entry.path.startsWith('frontend/'))
            .map(entry=>entry.path==='frontend'?{...entry,mode:publicEntries[0].mode}:entry.type==='directory'?{...entry,mode:0o755}:entry.type==='file'?{...entry,mode:entry.mode & 0o111 ? 0o755 : 0o644}:entry);
        verifyPreparedCopy({entries:expectedPublic},publicEntries);
        const index = await fs.readFile(`${paths.html}/index.html`);
        if (!index.length) throw fail('FRONTEND_HEALTH_FAILED');
        await phase(paths,journal,'frontend_published'); await adapter.health(); await phase(paths,journal,'health_verified');
        const active = {version:1,generation:1,transactionId,previousGeneration:null,confirmedAt:now(),homologation:'pending',
            backend:{kind:'release',releaseId,commitSha:manifest.declaredCommitSha,manifestSha256:installed.manifestSha256},
            frontend:{releaseId,manifestSha256:installed.manifestSha256,indexSha256:fileHash(index)},
            pm2:{name:PM2_NAME,user:'admin',home:paths.pm2Home,cwd:installed.release.backend,script:`${installed.release.backend}/server.js`,node:'20.19.6'}};
        if (!validateActive(active,paths) || await exists(paths.active)) throw fail('ACTIVE_STATE_INVALID');
        activeBytes = JSON.stringify(active); await writeDurable(paths.active,activeBytes); await syncDirectory(paths.state);
        await phase(paths,journal,'confirmed');
        return {active,transactionId,backupId:null};
    } catch (error) {
        // Falhas ou interrupções mantêm o lock e o journal: nova tentativa
        // exige revisão. Nunca remover algo cuja identidade não foi provada.
        retain = !!journal;
        try {
            if (processStartAttempt && !processIdentity) throw fail('INITIAL_PROCESS_IDENTITY_UNPROVEN');
            if (processIdentity) await adapter.stopInitial(processIdentity);
            if (activeBytes && await exists(paths.active)) {
                if (await fs.readFile(paths.active,'utf8') !== activeBytes) throw fail('INITIAL_ACTIVE_CHANGED');
                await fs.unlink(paths.active);
                await syncDirectory(paths.state);
            }
            if (publicIdentity) {
                const current = await fs.lstat(paths.html);
                if (current.dev !== publicIdentity.dev || current.ino !== publicIdentity.ino || await fs.realpath(paths.html) !== paths.html) throw fail('INITIAL_PUBLIC_CHANGED');
                if (installed) {
                    const currentEntries = await inventory(paths.html,'frontend');
                    const sourceEntries = await inventory(installed.release.frontend,'frontend');
                    for (const entry of sourceEntries) if (entry.path==='frontend') entry.mode = currentEntries[0].mode;
                    else if (entry.type==='directory') entry.mode=0o755;
                    else if (entry.type==='file') entry.mode=entry.mode & 0o111 ? 0o755 : 0o644;
                    verifyPreparedCopy({entries:sourceEntries},currentEntries);
                    for (const name of await fs.readdir(paths.html)) await fs.rm(`${paths.html}/${name}`,{recursive:true,force:false});
                    await syncDirectory(paths.html);
                }
                if (publicCreated) { await fs.rmdir(paths.html); await syncDirectory(path.dirname(paths.html)); }
            }
            if (installed) {
                const before = await privateDirectory(installed.release.root);
                if (before.dev !== installed.identity.dev || before.ino !== installed.identity.ino || await fs.realpath(installed.release.root) !== installed.release.root) throw fail('INITIAL_RELEASE_CHANGED');
                await verifyInstalledRelease(paths,installed);
                const after = await privateDirectory(installed.release.root);
                if (after.dev !== before.dev || after.ino !== before.ino) throw fail('INITIAL_RELEASE_CHANGED');
                await fs.rm(installed.release.root,{recursive:true,force:false});
                await syncDirectory(paths.releases);
            }
        } catch (failure) { secondaryFailure(error,failure); }
        const diagnostic = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(value) ? value : 'INITIAL_INSTALL_FAILED';
        if (journal && journal.events.at(-1).phase !== 'confirmed') try {
            journal.failureCode = diagnostic(error.code);
            if (error.rollbackError) journal.recoveryFailureCode = diagnostic(error.rollbackError.code);
            await phase(paths,journal,'failed');
        } catch (failure) { secondaryFailure(error,failure); }
        if (journal && !error.rollbackError && journal.events.at(-1).phase === 'failed') try {
            if (await exists(paths.active) || await exists(releasePaths(paths,releaseId).root)) throw fail('INITIAL_RECOVERY_INCOMPLETE');
            const current = await fs.lstat(paths.html).catch(failure => { if (failure.code === 'ENOENT') return null; throw failure; });
            if (initialPublicStat ? !current || current.dev !== initialPublicStat.dev || current.ino !== initialPublicStat.ino
                || current.mode !== initialPublicStat.mode || current.uid !== initialPublicStat.uid || current.gid !== initialPublicStat.gid
                || (await fs.readdir(paths.html)).length : !!current) throw fail('INITIAL_PUBLIC_CHANGED');
            const verified = await checkEnvironment(paths,{transactionId,recovering:transactionId});
            await adapter.assertInitialEmpty();
            if (!assessInitialInstallation({...verified,institutionalProcessAbsent:true}).eligible) throw fail('INITIAL_RECOVERY_INCOMPLETE');
            await phase(paths,journal,'recovered'); retain = false;
        } catch (failure) {
            secondaryFailure(error,failure);
            try { journal.recoveryFailureCode = diagnostic(failure.code); await saveJournal(paths,journal); }
            catch (saveFailure) { secondaryFailure(error,saveFailure); }
        }
        throw error;
    } finally { await releaseLock(retain); }
}

async function operation({ base, operation, workspace, preparationId, backupId, adapter, verifyPrepared = verifyPreparedRelease }) {
    if (process.platform !== 'linux' || process.getuid?.() === 0) throw fail('LINUX_NON_ROOT_REQUIRED');
    const paths = canonicalPaths(base), active = await readActive(paths);
    const initiallyVerified = active ? await verifiedActiveRelease(paths,active) : null;
    const institutional = initiallyVerified?.manifest.storageContract === 'institutional-v1';
    await privateDirectory(paths.state); await privateDirectory(paths.transactions);
    const transactionId = randomUUID(), releaseIdForJournal = operation === 'deploy' ? preparationId : randomUUID();
    const activeBytes = active ? await fs.readFile(paths.active) : null, generation = (active?.generation || 0) + 1;
    const journal = { version: 1, transactionId, operation, generation, releaseId: releaseIdForJournal, events: [{ phase: 'started', at: now() }] };
    const releaseLock = await acquire(paths, operation, transactionId); let retain = false, recoverySnapshot, activePublished = false, activationStarted = false, journalsChecked = false;
    try {
        await assertPriorJournalsResolved(paths,transactionId); journalsChecked = true;
        await prepareInfrastructure(paths,{institutional});
        if (activeBytes && await fs.readFile(paths.active,'utf8') !== activeBytes.toString('utf8')) throw fail('ACTIVE_STATE_CHANGED');
        const runtime = await adapter.describe();
        const expectedBackend = active ? releasePaths(paths, active.backend.releaseId).backend : paths.repo;
        if (runtime.name !== PM2_NAME || runtime.cwd !== expectedBackend || runtime.script !== `${expectedBackend}/server.js`
            || typeof runtime.commitSha !== 'string' || !/^[a-f0-9]{40}$/.test(runtime.commitSha)) throw fail('CURRENT_RUNTIME_DIVERGENT');
        // The automatic recovery target must also understand the official .env contract.
        const previous = await verifiedActiveRelease(paths, active);
        if (institutional) await verifyPublishedInstitutional(paths,active,previous.manifest);
        await verificarArmazenamentoRelease({backend:runtime.cwd,arquivoEnv:paths.env,base:paths.base,manifest:previous.manifest,kind:'release',paths});
        recoverySnapshot = await snapshotCurrent(paths, transactionId, active, runtime, previous.manifest);
        const recovery = await loadBackup(paths, recoverySnapshot.backupId, transactionId, active, runtime);
        if (recovery.seal.transactionId !== transactionId || JSON.stringify(recovery.manifest) !== JSON.stringify(recoverySnapshot.manifest)) throw fail('RECOVERY_SNAPSHOT_CHANGED');
        await verificarArmazenamentoRelease({backend:`${recovery.payload}/backend`,arquivoEnv:paths.env,base:paths.base,manifest:recovery.manifest,kind:'backup',paths});
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
        const targetManifest = await verifyInstalledRelease(paths, installed);
        await antesDeAtivar({backend:installed.release.backend,arquivoEnv:paths.env,base:paths.base,manifest:targetManifest,kind:'release',paths},async()=>{
            await phase(paths, journal, 'prepared');
            activationStarted = true;
            await adapter.switchTo({ name: PM2_NAME, cwd: installed.release.backend, script: `${installed.release.backend}/server.js` });
        });
        await phase(paths, journal, 'backend_activated');
        const indexSha256 = await publishFrontend(paths, installed.release.frontend,{institutional:targetManifest.storageContract === 'institutional-v1'});
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
        let rollbackError, restored = false, recovered = false;
        if (error.rollbackError) retain = true;
        if (recoverySnapshot && activationStarted) try { await restoreSnapshot(paths, recoverySnapshot, adapter, active); restored = true; } catch (failure) { rollbackError = failure; retain = true; }
        if (activePublished) try { if (activeBytes) await writeAtomic(paths.active, activeBytes); else await fs.unlink(paths.active); }
        catch (failure) { rollbackError ||= failure; retain = true; }
        if (restored && !rollbackError) try {
            if (!activeBytes || !(await fs.readFile(paths.active)).equals(activeBytes)) throw fail('RECOVERY_ACTIVE_DIVERGENCE');
            const checked = await verifiedActiveRelease(paths,active);
            if (institutional) await verifyPublishedInstitutional(paths,active,checked.manifest);
            await verificarArmazenamentoRelease({backend:checked.release.backend,arquivoEnv:paths.env,base:paths.base,manifest:checked.manifest,kind:'release',paths});
            recovered = true;
        } catch (failure) { rollbackError = failure; retain = true; }
        if (journalsChecked && journal.events.at(-1).phase !== 'confirmed') try {
            journal.failureCode = typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code) ? error.code : 'OPERATION_FAILED';
            if (rollbackError) journal.recoveryFailureCode = typeof rollbackError.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(rollbackError.code) ? rollbackError.code : 'RECOVERY_FAILED';
            await phase(paths, journal, 'failed');
            if (recovered && !rollbackError) await phase(paths, journal, 'recovered');
        } catch (failure) { rollbackError ||= failure; retain = true; }
        else if (journalsChecked && journal.events.at(-1).phase === 'confirmed') { rollbackError ||= fail('JOURNAL_COMMIT_UNCERTAIN'); retain = true; }
        if (rollbackError) { try { Object.defineProperty(error, 'rollbackError', { value: rollbackError }); } catch { /* original wins */ } }
        throw error;
    } finally { await releaseLock(retain); }
}

async function persistentOperation({ base, preparationId, adapter, verifyPersistent = verifyPersistentPreparation,
    materialize = materializePersistentPreparation, preflight = verificarArmazenamentoRelease, createSnapshot = snapshotCurrent }) {
    if (process.platform !== 'linux' || process.getuid?.() === 0) throw fail('LINUX_NON_ROOT_REQUIRED');
    if (!validId(preparationId)) throw fail('ACTIVATION_ARGUMENT_INVALID');
    const paths = canonicalPaths(base); await prepareInfrastructure(paths);
    const transactionId = randomUUID(), releaseLock = await acquire(paths, 'deploy', transactionId);
    let retain = false, recoverySnapshot, activePublished = false, activationStarted = false, active, activeBytes, journal;
    let candidateIdentity, installed;
    try {
        active = await readActive(paths); activeBytes = active ? await fs.readFile(paths.active) : null;
        const generation = (active?.generation || 0) + 1;
        journal = { version: 1, transactionId, operation: 'deploy', generation, releaseId: preparationId,
            events: [{ phase: 'started', at: now() }] };
        if (active?.backend.releaseId === preparationId || active?.frontend.releaseId === preparationId) throw fail('PREPARATION_ALREADY_ACTIVE');
        await verifyPersistent({ paths, preparationId });
        // O registro persistente prova integridade, mas não revalida os objetos
        // Git da fonte. Não promover com uma alegação de proveniência isolada.
        throw fail('PERSISTENT_SOURCE_PROVENANCE_UNVERIFIED');
        const materialized = await materialize({ paths, preparationId });
        candidateIdentity = await privateDirectory(materialized.release.root);
        installed = await finalizePersistentCandidate(paths, materialized);
        await verifyPersistent({ paths, preparationId });
        const targetManifest = await verifyInstalledRelease(paths, installed);
        await preflight({ backend: installed.release.backend, arquivoEnv: paths.env, base: paths.base, manifest: targetManifest, kind: 'release', paths });

        const runtime = await adapter.describe(), expectedBackend = active ? releasePaths(paths, active.backend.releaseId).backend : paths.repo;
        if (runtime.name !== PM2_NAME || runtime.cwd !== expectedBackend || runtime.script !== `${expectedBackend}/server.js`
            || typeof runtime.commitSha !== 'string' || !/^[a-f0-9]{40}$/.test(runtime.commitSha)) throw fail('CURRENT_RUNTIME_DIVERGENT');
        const previous = await verifiedActiveRelease(paths, active);
        await verificarArmazenamentoRelease({ backend: runtime.cwd, arquivoEnv: paths.env, base: paths.base, manifest: previous.manifest, kind: 'release', paths });
        recoverySnapshot = await createSnapshot(paths, transactionId, active, runtime, previous.manifest);
        const recovery = await loadBackup(paths, recoverySnapshot.backupId, transactionId, active, runtime);
        if (recovery.seal.transactionId !== transactionId || JSON.stringify(recovery.manifest) !== JSON.stringify(recoverySnapshot.manifest)) throw fail('RECOVERY_SNAPSHOT_CHANGED');
        await verificarArmazenamentoRelease({backend:`${recovery.payload}/backend`,arquivoEnv:paths.env,base:paths.base,manifest:recovery.manifest,kind:'backup',paths});
        await phase(paths, journal, 'prepared'); activationStarted = true;
        await adapter.switchTo({ name: PM2_NAME, cwd: installed.release.backend, script: `${installed.release.backend}/server.js` });
        await phase(paths, journal, 'backend_activated');
        const indexSha256 = await publishFrontend(paths, installed.release.frontend);
        await phase(paths, journal, 'frontend_published'); await adapter.health(); await phase(paths, journal, 'health_verified');
        const next = { version: 1, generation, transactionId, previousGeneration: active?.generation || null, confirmedAt: now(),
            backend: { kind: 'release', releaseId: preparationId, commitSha: installed.manifest.declaredCommitSha, manifestSha256: installed.manifestSha256 },
            frontend: { releaseId: preparationId, manifestSha256: installed.manifestSha256, indexSha256 },
            pm2: { name: PM2_NAME, user: 'admin', home: paths.pm2Home, cwd: installed.release.backend,
                script: `${installed.release.backend}/server.js`, node: '20.19.6' } };
        if (!validateActive(next, paths)) throw fail('ACTIVE_STATE_INVALID');
        await writeAtomic(paths.active, JSON.stringify(next)); activePublished = true; await phase(paths, journal, 'confirmed');
        return { active: next, backupId: recoverySnapshot.backupId, transactionId };
    } catch (error) {
        let rollbackError;
        if (error.rollbackError) retain = true;
        if (recoverySnapshot && activationStarted) try { await restoreSnapshot(paths, recoverySnapshot, adapter, active); }
        catch (failure) { rollbackError = failure; retain = true; }
        if (activePublished) try { if (activeBytes) await writeAtomic(paths.active, activeBytes); else await fs.unlink(paths.active); }
        catch (failure) { rollbackError ||= failure; retain = true; }
        if (journal && journal.events.at(-1).phase !== 'confirmed') try { await phase(paths, journal, 'failed'); }
        catch (failure) { rollbackError ||= failure; retain = true; }
        if (candidateIdentity && !activationStarted && !retain) try {
            const current = await privateDirectory(releasePaths(paths, preparationId).root);
            if (current.dev !== candidateIdentity.dev || current.ino !== candidateIdentity.ino) throw fail('CANDIDATE_CLEANUP_UNSAFE');
            await fs.rm(releasePaths(paths, preparationId).root, { recursive: true, force: false }); await syncDirectory(paths.releases);
        } catch (failure) { rollbackError ||= failure; retain = true; }
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
    if (manifest.sourceApproval) {
        const source = releasePaths(paths,manifest.sourceApproval.releaseId);
        await privateDirectory(source.root);
        const sourceStat = await fs.lstat(source.manifest);
        if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || sourceStat.nlink !== 1 || sourceStat.uid !== process.getuid() || (sourceStat.mode & 0o7777) !== 0o600) throw fail('BACKUP_SOURCE_APPROVAL_INVALID');
        const bytes = await fs.readFile(source.manifest), sourceManifest = JSON.parse(bytes);
        if (sha256(bytes) !== manifest.sourceApproval.manifestSha256 || !validateManifest(sourceManifest,paths)
            || sourceManifest.releaseId !== manifest.sourceApproval.releaseId || sourceManifest.declaredCommitSha !== manifest.declaredCommitSha
            || sourceManifest.storageContract !== 'institutional-v1') throw fail('BACKUP_SOURCE_APPROVAL_INVALID');
        const expected = sourceManifest.entries.map(entry => entry.path.startsWith('frontend/') && entry.type === 'directory' ? {...entry,mode:0o700}
            : entry.path.startsWith('frontend/') && entry.type === 'file' ? {...entry,mode:entry.mode & 0o111 ? 0o755 : 0o644} : entry);
        verifyPreparedCopy({entries:expected},actual);
    }
    return { backupId, root, payload: `${root}/payload`, manifest, seal, runtime, transactionId, active };
}

async function installBackupAsRelease(paths, snapshot) {
    const releaseId = randomUUID(), release = releasePaths(paths, releaseId);
    await ensureDirectory(release.root); await copyTree(`${snapshot.payload}/backend`, release.backend); await copyTree(`${snapshot.payload}/frontend`, release.frontend);
    await fs.symlink(paths.env, `${release.backend}/.env`); await fs.symlink(paths.private, `${release.backend}/istbrasil.private`);
    const entries = await inventory(release.backend, 'backend'); await inventory(release.frontend, 'frontend', entries);
    verifyPreparedCopy(snapshot.manifest, entries);
    const manifest = { version: snapshot.manifest.version, ...(snapshot.manifest.version === 2 ? {storageContract: snapshot.manifest.storageContract} : {}), releaseId, declaredCommitSha: snapshot.manifest.declaredCommitSha, gitProvenance: null,
        runtime: snapshot.manifest.runtime, entries };
    if (!validateManifest(manifest, paths)) throw fail('RESTORED_RELEASE_INVALID');
    const bytes = Buffer.from(JSON.stringify(manifest)); await fs.writeFile(release.manifest, bytes, { flag: 'wx', mode: 0o600 });
    return { releaseId, release, manifest, manifestSha256: sha256(bytes) };
}

export const activatePreparedRelease = input => operation({ ...input, operation: 'deploy' });
export const activatePersistentRelease = input => persistentOperation(input);
export const rollbackRelease = input => operation({ ...input, operation: 'rollback' });
export const materializePersistentCandidate = ({ base, preparationId, materialize = materializePersistentPreparation }) =>
    materialize({ paths: canonicalPaths(base), preparationId });
