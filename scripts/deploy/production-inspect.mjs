// Phase 2.1. Read operations only. Never imports the application or Phase 1.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { PATHS, releasePaths, parseAcl, checkMetadata, validateActive, validateManifest, validateBackupManifest, validateBackupSeal, validateJournal, validateLock, validId, approvedLink, sha256, classify, assessCapacity, PHASES } from './production-contract.mjs';

const execute = promisify(execFile);
const JSON_LIMIT = 32 * 1024 * 1024;
const meta = (stat, acl) => ({ type: stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'special',
    mode: stat.mode & 0o7777, uid: stat.uid, gid: stat.gid, nlink: stat.nlink, acl });
const same = (a, b) => ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'mode', 'uid', 'gid'].every(key => a[key] === b[key]);

// Only these read-only utilities are invoked; never pm2, sudo, Git or services.
async function readTool(command, args) {
    if (!['getfacl', 'getent', 'ss'].includes(command)) throw new Error('TOOL_NOT_ALLOWED');
    const { stdout } = await execute(command, args, { encoding: 'utf8', timeout: 5000, maxBuffer: 2 * 1024 * 1024 });
    return stdout;
}

export async function readAcl(filename) {
    try { return parseAcl(await readTool('getfacl', ['-cpn', '--', filename])); }
    catch { return 'unknown'; }
}

export async function operationalIdentity() {
    try {
        const rows = (await readTool('getent', ['passwd'])).trim().split('\n').map(row => row.split(':'));
        const admin = rows.find(row => row[0] === 'admin');
        if (!admin) return { uid: null, gid: null, exclusiveGroup: null, verified: false };
        const uid = Number(admin[2]), gid = Number(admin[3]);
        const groups = (await readTool('getent', ['group'])).trim().split('\n').map(row => row.split(':'));
        const group = groups.find(row => Number(row[2]) === gid);
        const exclusiveMembers = !!group && rows.filter(row => Number(row[3]) === gid).every(row => row[0] === 'admin')
            && group[3].split(',').filter(Boolean).every(member => member === 'admin');
        const nss = await fs.readFile('/etc/nsswitch.conf', 'utf8');
        const filesOnly = ['passwd', 'group'].every(name => new RegExp(`^${name}:\\s*files\\s*(?:#.*)?$`, 'm').test(nss));
        const exclusiveGroup = exclusiveMembers ? filesOnly ? true : null : false;
        // External NSS providers can prevent exhaustive group-membership proof.
        return { uid, gid, exclusiveGroup, verified: Number.isSafeInteger(uid) && uid > 0 && Number.isSafeInteger(gid) && process.getuid?.() === uid };
    } catch { return { uid: null, gid: null, exclusiveGroup: null, verified: false }; }
}

async function readJson(filename) {
    const stat = await fs.lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > JSON_LIMIT) throw new Error('METADATA_INVALID');
    const handle = await fs.open(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
        const before = await handle.stat();
        if (!same(stat, before)) throw new Error('METADATA_CHANGED');
        const bytes = await handle.readFile();
        if (!same(before, await handle.stat()) || !same(stat, await fs.lstat(filename))) throw new Error('METADATA_CHANGED');
        return { value: JSON.parse(bytes.toString('utf8')), digest: sha256(bytes) };
    } finally { await handle.close(); }
}

async function hashFile(filename, expectedStat) {
    const handle = await fs.open(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
        const before = await handle.stat();
        if (!same(before, expectedStat)) throw new Error('CONTENT_CHANGED');
        const hash = createHash('sha256');
        const buffer = Buffer.alloc(64 * 1024);
        for (;;) {
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
            if (!bytesRead) break;
            hash.update(buffer.subarray(0, bytesRead));
        }
        if (!same(before, await handle.stat()) || !same(before, await fs.lstat(filename))) throw new Error('CONTENT_CHANGED');
        return hash.digest('hex');
    } finally { await handle.close(); }
}

// Reject symlinks in every administrative ancestor. Never follows a private tree.
async function ancestors(filename, identity, aclReader, problems, boundary) {
    if (filename === boundary) return true;
    for (let parent = path.posix.dirname(filename); ; parent = path.posix.dirname(parent)) {
        const stat = await fs.lstat(parent);
        const result = checkMetadata(meta(stat, await aclReader(parent)), { type: 'directory', trusted: true }, identity);
        if (result !== 'safe') {
            problems(result === 'unsafe' ? 'invalid' : 'inconclusive', 'ANCESTOR_UNTRUSTED');
            return false;
        }
        if (parent === boundary || parent === '/') break;
    }
    return true;
}

async function inspectPath(filename, policy, identity, aclReader, problems, optional = false, boundary = '/') {
    try {
        if (!await ancestors(filename, identity, aclReader, problems, boundary)) return null;
        const stat = await fs.lstat(filename);
        const result = checkMetadata(meta(stat, await aclReader(filename)), policy, identity);
        if (result !== 'safe') {
            problems(result === 'unsafe' ? 'invalid' : 'inconclusive', 'PERMISSIONS_NOT_SAFE');
            return null;
        }
        return stat;
    } catch (error) {
        if (error.code === 'ENOENT') {
            if (!optional) problems('inconclusive', 'REQUIRED_PATH_MISSING');
            return null;
        }
        problems('inconclusive', 'PATH_NOT_READABLE');
        return null;
    }
}

async function inventory(root, entries, paths, release, identity, aclReader, published = false, archive = false) {
    const expected = new Map(entries.map(entry => [published ? entry.path.slice('frontend/'.length) : entry.path, entry]));
    if (published) expected.delete('');
    const found = new Set();
    const visit = async (directory, relative = '') => {
        for (const name of await fs.readdir(directory)) {
            const relativePath = relative ? `${relative}/${name}` : name;
            if (published && relativePath === 'istdbadmin') continue; // checked separately, never traversed
            const entry = expected.get(relativePath);
            if (!entry) throw new Error('UNEXPECTED_ENTRY');
            const filename = `${root}/${relativePath}`;
            const stat = await fs.lstat(filename);
            const metadata = meta(stat, stat.isSymbolicLink() ? 'basic' : await aclReader(filename));
            if (metadata.type !== entry.type || metadata.mode !== entry.mode || metadata.uid !== entry.uid || metadata.gid !== entry.gid) throw new Error('ENTRY_METADATA_MISMATCH');
            if (metadata.type !== 'symlink' && checkMetadata(metadata, { type: entry.type, trusted: true }, identity) !== 'safe') throw new Error(metadata.acl === 'unknown' ? 'ACL_UNKNOWN' : 'ENTRY_UNSAFE');
            if (stat.isFile() && (stat.nlink !== 1 || stat.size !== entry.size || await hashFile(filename, stat) !== entry.sha256)) throw new Error('ENTRY_HASH_MISMATCH');
            if (stat.isSymbolicLink()) {
                if (stat.uid !== identity.uid || stat.gid !== identity.gid) throw new Error('LINK_OWNER_UNSAFE');
                const target = await fs.readlink(filename);
                if (target !== entry.target || !approvedLink(paths, release, entry.path, target)) throw new Error('UNAPPROVED_LINK');
                if (entry.path.startsWith('backend/node_modules/')) {
                    const resolved = await fs.realpath(filename);
                    if (!resolved.startsWith(`${release.backend}/node_modules/`)) throw new Error('UNAPPROVED_LINK');
                }
                // Runtime config/private links: only read the link itself, not target content.
            }
            found.add(relativePath);
            if (stat.isDirectory()) await visit(filename, relativePath);
        }
    };
    if (!published) {
        // manifest.json is outside the inventory; any other release-root entry is unsafe.
        const rootNames = (await fs.readdir(root)).sort();
        if (rootNames.join('|') !== (archive ? ['backend', 'frontend'] : ['backend', 'frontend', 'manifest.json']).join('|')) throw new Error('UNEXPECTED_ENTRY');
        for (const name of ['backend', 'frontend']) {
            const entry = expected.get(name), stat = await fs.lstat(`${root}/${name}`);
            if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o7777) !== entry.mode || stat.uid !== entry.uid || stat.gid !== entry.gid || checkMetadata(meta(stat, await aclReader(`${root}/${name}`)), { type: 'directory', trusted: true }, identity) !== 'safe') throw new Error('ENTRY_UNSAFE');
            found.add(name);
            await visit(`${root}/${name}`, name);
        }
    } else await visit(root);
    if (expected.size !== found.size) throw new Error('ENTRY_MISSING');
}

async function procIdentity(pid) {
    const root = `/proc/${pid}`;
    const [stat, command, processStat, cwd, executable] = await Promise.all([fs.stat(root), fs.readFile(`${root}/cmdline`), fs.readFile(`${root}/stat`, 'utf8'), fs.readlink(`${root}/cwd`), fs.readlink(`${root}/exe`)]);
    const fields = processStat.slice(processStat.lastIndexOf(')') + 2).split(' ');
    return { uid: stat.uid, args: command.toString('utf8').split('\0').filter(Boolean), startTicks: fields[19], cwd, executable };
}

export async function inspectProcesses(paths, identity, lock) {
    const result = { proven: false, unknown: false, orphanLock: false, liveLock: false, pm2: null, runtimePathsProven: false };
    if (process.platform !== 'linux' || !identity.verified) return result;
    try {
        const home = await fs.lstat(paths.pm2Home);
        const pidFile = await fs.lstat(`${paths.pm2Home}/pm2.pid`);
        const socket = await fs.lstat(`${paths.pm2Home}/rpc.sock`);
        if (!home.isDirectory() || home.isSymbolicLink() || home.uid !== identity.uid || home.mode & 0o022 || !pidFile.isFile() || pidFile.isSymbolicLink() || pidFile.uid !== identity.uid || pidFile.nlink !== 1 || pidFile.mode & 0o022 || pidFile.size > 32 || !socket.isSocket() || socket.uid !== identity.uid) { result.unknown = true; return result; }
        const pidText = (await fs.readFile(`${paths.pm2Home}/pm2.pid`, 'utf8')).trim();
        if (!/^[1-9]\d*$/.test(pidText)) { result.unknown = true; return result; }
        const daemon = await procIdentity(Number(pidText));
        if (daemon.uid !== identity.uid || !daemon.args.some(arg => arg.includes('God Daemon') && arg.includes(paths.pm2Home))) { result.unknown = true; return result; }
        // Inspect listening ownership without starting a PM2 daemon.
        const rows = (await readTool('ss', ['-H', '-ltnp', 'sport = :3000'])).trim().split('\n').filter(Boolean);
        if (!rows.length) return result;
        const pids = new Set();
        for (const row of rows) {
            const matches = [...row.matchAll(/pid=(\d+)/g)];
            if (!matches.length) return result;
            for (const match of matches) pids.add(Number(match[1]));
        }
        if (pids.size !== 1) { result.unknown = true; return result; }
        const pid = [...pids][0], api = await procIdentity(pid);
        if (api.uid !== identity.uid || !path.posix.basename(api.executable).startsWith('node')) { result.unknown = true; return result; }
        // Environment is read only in memory. Never return it, log it or spawn an app.
        const selected = {};
        for (const item of (await fs.readFile(`/proc/${pid}/environ`)).toString('utf8').split('\0')) {
            const position = item.indexOf('=');
            const name = item.slice(0, position);
            if (['name', 'pm_cwd', 'pm_exec_path', 'PM2_HOME', 'PRODUCTS_PATH', 'DOTENV_CONFIG_PATH', 'DOTENV_CONFIG_OVERRIDE', 'DOTENV_KEY'].includes(name)) selected[name] = item.slice(position + 1);
        }
        if (selected.name !== 'ist-api' || selected.pm_cwd !== api.cwd || selected.pm_exec_path !== `${api.cwd}/server.js` || selected.PM2_HOME !== undefined && selected.PM2_HOME !== paths.pm2Home) { result.unknown = true; return result; }
        let parent = pid, linked = false;
        for (let depth = 0; depth < 32 && parent > 1; depth++) {
            const text = await fs.readFile(`/proc/${parent}/stat`, 'utf8');
            parent = Number(text.slice(text.lastIndexOf(')') + 2).split(' ')[1]);
            if (parent === Number(pidText)) { linked = true; break; }
        }
        if (!linked) { result.unknown = true; return result; }
        // Other PM2 daemons, unreadable /proc and mount visibility prevent certainty.
        let visible = true;
        for (const entry of (await fs.readdir('/proc')).filter(name => /^\d+$/.test(name))) {
            try {
                const args = (await fs.readFile(`/proc/${entry}/cmdline`)).toString('utf8');
                if (Number(entry) !== Number(pidText) && args.includes('God Daemon')) result.unknown = true;
            } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ESRCH') visible = false; }
        }
        const mounts = await fs.readFile('/proc/mounts', 'utf8');
        if (/hidepid=/.test(mounts)) visible = false;
        const unchanged = (await procIdentity(pid)).startTicks === api.startTicks && (await procIdentity(Number(pidText))).startTicks === daemon.startTicks;
        result.proven = visible && unchanged;
        result.pm2 = { name: 'ist-api', user: 'admin', home: paths.pm2Home, cwd: api.cwd, script: selected.pm_exec_path, executable: api.executable };
        const [apiExecutable, inspectorExecutable] = await Promise.all([fs.stat(`/proc/${pid}/exe`), fs.stat(process.execPath)]);
        if (apiExecutable.dev === inspectorExecutable.dev && apiExecutable.ino === inspectorExecutable.ino && process.version === 'v20.19.6') result.pm2.node = '20.19.6';
        else result.proven = false;
        // dotenv may alter values after /proc/environ's initial environment snapshot.
        // Do not infer effective configuration by reading credentials or guessing.
        result.runtimePathsProven = false;
    } catch { /* absence, races and permission failures remain INCONCLUSIVE */ }
    if (lock) {
        try {
            const processIdentity = await procIdentity(lock.pid);
            const bootId = (await fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
            result.liveLock = processIdentity.uid === identity.uid && processIdentity.startTicks === lock.startTicks && bootId === lock.bootId
                && processIdentity.args.includes(`${paths.repo}/scripts/deploy/production-operation.mjs`);
            result.orphanLock = !result.liveLock;
        } catch (error) {
            if (error.code === 'ENOENT' || error.code === 'ESRCH') result.orphanLock = true;
            else result.lockUnknown = true;
        }
    }
    return result;
}

/** Test adapters supply synthetic observations only. No adapter can enable actions.
 * The CLI always uses fixed production paths and real read-only collectors.
 */
export async function inspectProduction({ paths = PATHS, identityReader = operationalIdentity, aclReader = readAcl, processReader = inspectProcesses, budgets = null, ancestorBoundary = '/' } = {}) {
    const observation = { issues: [], activePresent: false };
    const problems = (kind, code) => { observation[kind] = true; observation.issues.push(code); };
    const identity = await identityReader();
    if (process.platform !== 'linux' || !identity.verified) problems('inconclusive', 'OPERATIONAL_IDENTITY_NOT_PROVEN');
    const directory = { type: 'directory', trusted: true };
    const privateDirectory = { type: 'directory', private: true, modes: [0o700] };
    const privateFile = { type: 'file', private: true, modes: [0o600] };
    const inspect = (filename, policy, optional = false) => inspectPath(filename, policy, identity, aclReader, problems, optional, ancestorBoundary);
    const present = async filename => {
        try { await fs.lstat(filename); return true; }
        catch (error) { return error.code === 'ENOENT' ? false : null; }
    };
    for (const filename of [paths.base, paths.repo, paths.html, paths.uploads, paths.backendPhp, paths.private]) await inspect(filename, directory);
    for (const filename of [paths.env, paths.envBackup, paths.envOld]) await inspect(filename, { type: 'file', private: true, config: true, modes: [0o600, 0o640] }, filename !== paths.env);
    try {
        const php = `${paths.html}/istdbadmin`, stat = await fs.lstat(php);
        if (!stat.isSymbolicLink() || await fs.readlink(php) !== paths.phpMyAdmin) problems('invalid', 'PHPMYADMIN_LINK_INVALID');
    } catch { problems('inconclusive', 'PHPMYADMIN_LINK_NOT_READABLE'); }

    const infrastructure = [];
    for (const filename of [paths.admin, paths.releases, paths.backups, paths.state, paths.transactions, paths.logs]) infrastructure.push(await inspect(filename, privateDirectory, true));
    const infrastructurePresence = await Promise.all([paths.admin, paths.releases, paths.backups, paths.state, paths.transactions, paths.logs].map(present));
    const partialInfrastructure = infrastructurePresence.includes(true) && infrastructurePresence.includes(false);
    if (partialInfrastructure) problems('recoveryRequired', 'PARTIAL_INFRASTRUCTURE');
    const backupSeals = [];
    if (infrastructure[2]) {
        for (const id of await fs.readdir(paths.backups)) {
            if (!validId(id)) { problems('invalid', 'BACKUP_UNEXPECTED_ENTRY'); continue; }
            const root = `${paths.backups}/${id}`;
            if (!await inspect(root, privateDirectory)) continue;
            try {
                if ((await fs.readdir(root)).sort().join('|') !== ['READY', 'manifest.json', 'payload'].join('|')) throw new Error('BACKUP_INCOMPLETE');
                if (!await inspect(`${root}/manifest.json`, privateFile) || !await inspect(`${root}/READY`, privateFile) || !await inspect(`${root}/payload`, privateDirectory)) continue;
                const manifest = await readJson(`${root}/manifest.json`), seal = (await readJson(`${root}/READY`)).value;
                if (!validateBackupManifest(manifest.value, paths) || manifest.value.backupId !== id || !validateBackupSeal(seal) || seal.backupId !== id || seal.manifestSha256 !== manifest.digest) throw new Error('BACKUP_INVALID');
                backupSeals.push(seal);
                const release = { root: `${root}/payload`, backend: `${root}/payload/backend` };
                await inventory(release.root, manifest.value.entries, paths, release, identity, aclReader, false, true);
            } catch (error) { problems(error.message === 'ACL_UNKNOWN' || ['EACCES', 'EPERM'].includes(error.code) ? 'inconclusive' : 'invalid', 'BACKUP_INTEGRITY_NOT_PROVEN'); }
        }
    }
    const flock = await inspect(paths.flock, privateFile, true);
    // Existence is not ownership of an advisory lock. No acquisition is attempted.
    if (flock) problems('inconclusive', 'FLOCK_OWNERSHIP_NOT_OBSERVED');
    let active = null, activeDigest = null, lock = null;
    const activePresence = await present(paths.active);
    observation.activePresent = activePresence !== false;
    const activeStat = await inspect(paths.active, privateFile, true);
    if (activeStat) {
        observation.activePresent = true;
        try {
            const metadata = await readJson(paths.active);
            active = metadata.value; activeDigest = metadata.digest;
            if (!validateActive(active, paths)) { active = null; problems('invalid', 'ACTIVE_SCHEMA_INVALID'); }
        } catch { problems('invalid', 'ACTIVE_UNREADABLE_OR_CHANGED'); }
    }
    const lockPresence = await present(paths.lock);
    const lockStat = await inspect(paths.lock, privateFile, true);
    if (lockStat) {
        try { lock = (await readJson(paths.lock)).value; if (!validateLock(lock)) { lock = null; problems('invalid', 'LOCK_SCHEMA_INVALID'); } }
        catch { problems('invalid', 'LOCK_UNREADABLE_OR_CHANGED'); }
    }
    const journals = [], journalDigests = new Map();
    if (infrastructure[4]) {
        for (const name of await fs.readdir(paths.transactions)) {
            if (!/^[a-f0-9-]{36}\.json$/.test(name)) { problems('invalid', 'JOURNAL_UNEXPECTED_ENTRY'); continue; }
            const filename = `${paths.transactions}/${name}`;
            const journalStat = await inspect(filename, privateFile);
            if (!journalStat || !journalStat.isFile() || journalStat.isSymbolicLink()) continue;
            try {
                const metadata = await readJson(filename), envelope = metadata.value;
                journalDigests.set(name, metadata.digest);
                if (!validateJournal(envelope) || `${envelope.record.transactionId}.json` !== name) problems('invalid', 'JOURNAL_SCHEMA_OR_HASH_INVALID');
                else journals.push(envelope.record);
            } catch { problems('invalid', 'JOURNAL_UNREADABLE_OR_CHANGED'); }
        }
    }
    for (const seal of backupSeals) if (!journals.some(record => record.transactionId === seal.transactionId)) problems('invalid', 'BACKUP_JOURNAL_REFERENCE_MISSING');
    let processes;
    try { processes = await processReader(paths, identity, lock); }
    catch { processes = { proven: false }; }
    if (processes.unknown) problems('unknownProcess', 'PROCESS_IDENTITY_UNKNOWN');
    if (processes.proven !== true) problems('inconclusive', 'PROCESS_VISIBILITY_NOT_PROVEN');
    if (processes.runtimePathsProven !== true) problems('inconclusive', 'EFFECTIVE_RUNTIME_PATHS_NOT_PROVEN');
    if (lockStat) {
        if (processes.orphanLock) problems('recoveryRequired', 'ABANDONED_LOCK_REQUIRES_REVIEW');
        else if (processes.liveLock === true && lock) {
            const journal = journals.find(record => record.transactionId === lock.transactionId);
            if (journal && journal.operation === lock.operation && (!active || journal.generation === active.generation + 1) && !['confirmed', 'failed', 'interrupted'].includes(journal.events.at(-1).phase)) observation.inProgress = true;
            else problems('recoveryRequired', 'LOCK_JOURNAL_DIVERGENCE');
        } else problems('inconclusive', 'LOCK_OWNER_NOT_PROVEN');
    }
    for (const journal of journals) {
        if (journal.events.at(-1).phase !== 'confirmed' && !(observation.inProgress && journal.transactionId === lock?.transactionId)) problems('recoveryRequired', 'TRANSACTION_REQUIRES_REVIEW');
    }
    if (!active && activePresence === false && processes.pm2) {
        observation.legacy = processes.pm2.cwd === paths.repo && processes.pm2.script === `${paths.repo}/server.js`;
        if (!observation.legacy) problems('recoveryRequired', 'UNADOPTED_RELEASE_PROCESS');
        if (journals.length || lockStat || infrastructurePresence.includes(true)) problems('recoveryRequired', 'UNINITIALIZED_WITH_OPERATIONAL_ARTIFACTS');
    }
    if (active) {
        const journal = journals.find(record => record.transactionId === active.transactionId);
        if (!journal || journal.events.at(-1).phase !== PHASES.at(-1) || journal.generation !== active.generation || journal.releaseId !== active.backend.releaseId) problems('recoveryRequired', 'ACTIVE_JOURNAL_NOT_CONFIRMED');
        const pm2 = processes.pm2;
        if (pm2 && ['name', 'user', 'home', 'cwd', 'script', 'node'].some(key => pm2[key] !== active.pm2[key])) problems('recoveryRequired', 'ACTIVE_PM2_DIVERGENCE');
        if (!pm2) problems('inconclusive', 'PM2_NOT_OBSERVED');
        const manifests = new Map();
        for (const [id, expectedDigest] of [[active.backend.releaseId, active.backend.manifestSha256], [active.frontend.releaseId, active.frontend.manifestSha256]]) {
            if (manifests.has(id)) { if (manifests.get(id).digest !== expectedDigest) problems('invalid', 'MANIFEST_REFERENCE_DIVERGENCE'); continue; }
            const release = releasePaths(paths, id);
            if (!await inspect(release.root, privateDirectory)) continue;
            const manifestStat = await inspect(release.manifest, privateFile);
            if (!manifestStat || !manifestStat.isFile() || manifestStat.isSymbolicLink()) continue;
            try {
                const manifest = await readJson(release.manifest);
                if (manifest.digest !== expectedDigest || !validateManifest(manifest.value, paths) || manifest.value.releaseId !== id) throw new Error('MANIFEST_INVALID');
                if (manifest.value.runtime.arch !== process.arch || manifest.value.runtime.abi !== process.versions.modules || process.version !== 'v20.19.6') problems('inconclusive', 'RUNTIME_COMPATIBILITY_NOT_PROVEN');
                await inventory(release.root, manifest.value.entries, paths, release, identity, aclReader);
                manifests.set(id, manifest);
            } catch (error) { problems(error.message === 'ACL_UNKNOWN' || ['EACCES', 'EPERM'].includes(error.code) ? 'inconclusive' : 'invalid', 'RELEASE_INTEGRITY_NOT_PROVEN'); }
        }
        const backendManifest = manifests.get(active.backend.releaseId)?.value;
        if (backendManifest) {
            observation.declaredSha = backendManifest.declaredCommitSha;
            observation.storedGitClaim = backendManifest.gitProvenance !== null;
            if (backendManifest.declaredCommitSha !== active.backend.commitSha) problems('invalid', 'DECLARED_SHA_DIVERGENCE');
        }
        const frontendManifest = manifests.get(active.frontend.releaseId)?.value;
        if (frontendManifest) {
            const entries = frontendManifest.entries.filter(entry => entry.path === 'frontend' || entry.path.startsWith('frontend/'));
            if (entries.find(entry => entry.path === 'frontend/index.html')?.sha256 !== active.frontend.indexSha256) problems('invalid', 'FRONTEND_INDEX_REFERENCE_INVALID');
            try { await inventory(paths.html, entries, paths, releasePaths(paths, active.frontend.releaseId), identity, aclReader, true); }
            catch (error) { problems(error.message === 'ACL_UNKNOWN' || ['EACCES', 'EPERM'].includes(error.code) ? 'inconclusive' : 'recoveryRequired', 'PUBLISHED_FRONTEND_DIVERGENCE'); }
        }
        observation.consistent = manifests.has(active.backend.releaseId) && manifests.has(active.frontend.releaseId);
    }
    // Detect metadata transitions during the read. This is not a filesystem snapshot.
    try {
        if (await present(paths.active) !== activePresence || await present(paths.lock) !== lockPresence
            || activeDigest && (await readJson(paths.active)).digest !== activeDigest) problems('inconclusive', 'INSPECTION_CHANGED');
        if (infrastructure[4]) {
            const names = await fs.readdir(paths.transactions);
            if (names.length !== journalDigests.size) problems('inconclusive', 'INSPECTION_CHANGED');
            for (const [name, digest] of journalDigests) if ((await readJson(`${paths.transactions}/${name}`)).digest !== digest) problems('inconclusive', 'INSPECTION_CHANGED');
        }
    } catch { problems('inconclusive', 'INSPECTION_CHANGED'); }
    // Available space is observed; future operation costs are not invented.
    const filesystems = [];
    for (const filename of [paths.base, paths.repo, paths.html, paths.releases, paths.backups, paths.state]) {
        try {
            const [stat, space] = await Promise.all([fs.stat(filename, { bigint: true }), fs.statfs(filename, { bigint: true })]);
            const device = stat.dev.toString();
            if (!filesystems.some(item => item.device === device)) filesystems.push({ device, availableBytes: (space.bavail * space.bsize).toString(), availableInodes: space.ffree.toString() });
        } catch { observation.issues.push('FILESYSTEM_CAPACITY_NOT_OBSERVED'); }
    }
    observation.capacity = assessCapacity(filesystems, budgets);
    if (observation.capacity.status === 'UNKNOWN') observation.issues.push('CAPACITY_PLAN_NOT_PROVEN');
    if (observation.capacity.status === 'INSUFFICIENT') problems('invalid', 'CAPACITY_INSUFFICIENT');
    observation.issues.push('GIT_PROVENANCE_NOT_INDEPENDENTLY_VERIFIED', 'NO_OPERATIONAL_AUTHORIZATION');
    return classify(observation);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        if (process.argv.length !== 2) throw new Error('NO_ARGUMENTS_ACCEPTED');
        const report = await inspectProduction();
        console.log(JSON.stringify(report, null, 2));
        process.exitCode = ['UNINITIALIZED', 'CONSISTENT'].includes(report.status) ? 0 : 2;
    } catch {
        // Never expose paths from exceptions, arbitrary JSON or raw tool stderr.
        console.log(JSON.stringify({ version: 1, status: 'INCONCLUSIVE', deployAuthorized: false, rollbackAuthorized: false, issues: ['INSPECTION_FAILED'] }));
        process.exitCode = 2;
    }
}
