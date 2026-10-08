// Filesystem-only recovery building blocks; deliberately not connected to deploy.sh.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
    requireIsolation, checkedPath, relativePath, digest, validId, writePrivate, readPrivate,
    startTransaction, advanceTransaction, readTransaction, inspectTransactions, syncDirectory,
    withWorkspaceLock, recordFailedTransaction, transactionUnconfirmed
} from './state.mjs';

const FORMAT = 'ist-backup-directory-v1';
const COMPONENTS = ['backend', 'modules', 'frontend'];
// Never descend into these entries, even if they are tracked or symbolic links.
const EXCLUDED = ['.env*', '.git', '.npmrc', '.ssh', '.aws', '.pm2', '.deploy', 'istbrasil.private',
    'uploads', 'backend-php', 'istdbadmin', 'database', 'development', 'dist', '.angular',
    '*.pem', '*.key', '*.p12', '*.pfx', '*.session.sql', 'id_rsa', 'id_ed25519'];
const names = new Set(EXCLUDED.filter(name => !name.includes('*')));
function excluded(name) {
    return names.has(name) || name.startsWith('.env') || /\.(pem|key|p12|pfx|session\.sql)$/i.test(name);
}
function allowedEntry(relative) {
    relativePath(relative);
    const parts = relative.split('/');
    if (!COMPONENTS.includes(parts[0]) || parts.slice(1).some(excluded)
        || (parts[0] === 'backend' && parts[1] === 'node_modules')) throw new Error('Protected/invalid manifest path.');
}

function sourcePath(root, source) {
    requireIsolation(root);
    if (typeof source !== 'string' || path.resolve(source) !== source) throw new Error('Source must be canonical and isolated.');
    const relative = path.relative(root, source).split(path.sep).join('/');
    if (relative.split('/')[0] !== 'sources') throw new Error('Sources must be under the isolated sources directory.');
    const resolved = checkedPath(root, relative);
    if (!fs.lstatSync(resolved).isDirectory()) throw new Error('Source directory missing.');
    return resolved;
}

function fingerprint(stat) {
    return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, stat.mode].join(':');
}

async function streamFile(source, destination = null) {
    const before = fs.lstatSync(source);
    if (!before.isFile() || before.nlink !== 1) throw new Error('Expected a regular, unshared file.');
    const input = await fs.promises.open(source, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    let output;
    try {
        if (fingerprint(await input.stat()) !== fingerprint(before)) throw new Error('Source changed during capture.');
        const hash = createHash('sha256');
        if (destination) output = await fs.promises.open(destination, 'wx', 0o600);
        const buffer = Buffer.allocUnsafe(64 * 1024);
        while (true) {
            const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
            if (!bytesRead) break;
            hash.update(buffer.subarray(0, bytesRead));
            if (output) {
                let offset = 0;
                while (offset < bytesRead) {
                    const { bytesWritten } = await output.write(buffer, offset, bytesRead - offset, null);
                    if (!bytesWritten) throw new Error('Short write during capture.');
                    offset += bytesWritten;
                }
            }
        }
        if (output) await output.sync();
        if (fingerprint(await input.stat()) !== fingerprint(before) || fingerprint(fs.lstatSync(source)) !== fingerprint(before)) {
            throw new Error('Source changed during capture.');
        }
        return hash.digest('hex');
    } finally {
        if (output) await output.close();
        await input.close();
    }
}

function validateLink(base, relative, target) {
    if (typeof target !== 'string' || !target || target.includes('\\') || target.includes('\0')
        || path.posix.isAbsolute(target) || target.includes(':')) throw new Error('Unsafe symlink target.');
    const destination = path.resolve(base, path.dirname(relative), target);
    const lexical = path.relative(base, destination).split(path.sep).join('/');
    relativePath(lexical);
    if (lexical.split('/').some(excluded)) throw new Error('Symlink targets protected data.');
    const resolved = fs.realpathSync(destination);
    const resolvedRelative = path.relative(base, resolved).split(path.sep).join('/');
    relativePath(resolvedRelative);
    if (resolvedRelative.split('/').some(excluded)) throw new Error('Symlink resolves to protected data.');
    return target;
}

async function inventory(base, component) {
    const entries = [];
    async function visit(relative) {
        const file = relative ? path.join(base, ...relative.split('/')) : base;
        const stat = fs.lstatSync(file);
        if (stat.mode & 0o7000) throw new Error('Special permission bits require manual review.');
        const entry = { path: component + (relative ? '/' + relative : ''), mode: stat.mode & 0o777, uid: stat.uid, gid: stat.gid };
        if (stat.isSymbolicLink()) {
            const target = validateLink(base, relative, fs.readlinkSync(file));
            entries.push({ ...entry, type: 'symlink', target, sha256: digest(target) });
        } else if (stat.isDirectory()) {
            entries.push({ ...entry, type: 'directory' });
            for (const child of fs.readdirSync(file).sort()) {
                if (excluded(child) || (component === 'backend' && !relative && child === 'node_modules')) continue;
                await visit(relative ? `${relative}/${child}` : child);
            }
        } else if (stat.isFile()) {
            entries.push({ ...entry, type: 'file', bytes: stat.size, sha256: await streamFile(file) });
        } else throw new Error('Unsupported filesystem entry.');
    }
    await visit('');
    return entries;
}

function validateManifest(manifest, id) {
    if (manifest.format !== FORMAT || manifest.id !== id || !validId(manifest.transaction)
        || !/^[0-9a-f]{40}$/.test(manifest.commit) || !Array.isArray(manifest.entries)
        || JSON.stringify(manifest.excluded) !== JSON.stringify(EXCLUDED)
        || !manifest.runtime || typeof manifest.runtime.abi !== 'string' || typeof manifest.runtime.platform !== 'string'
        || typeof manifest.runtime.arch !== 'string') throw new Error('Invalid backup manifest.');
    const seen = new Map();
    for (const entry of manifest.entries) {
        allowedEntry(entry.path);
        if (seen.has(entry.path) || !Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777
            || !Number.isInteger(entry.uid) || !Number.isInteger(entry.gid)) throw new Error('Invalid manifest entry.');
        if (entry.type === 'file') {
            if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || !/^[0-9a-f]{64}$/.test(entry.sha256)) throw new Error('Invalid file integrity record.');
        } else if (entry.type === 'symlink') {
            if (typeof entry.target !== 'string' || digest(entry.target) !== entry.sha256) throw new Error('Invalid symlink integrity record.');
            const component = entry.path.split('/')[0];
            const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(entry.path), entry.target));
            allowedEntry(resolved);
            if (entry.target.includes('\\') || entry.target.includes(':') || path.posix.isAbsolute(entry.target)
                || !resolved.startsWith(component + '/')) throw new Error('Unsafe manifest symlink.');
        } else if (entry.type !== 'directory') throw new Error('Invalid manifest type.');
        if (!COMPONENTS.includes(entry.path) && seen.get(path.posix.dirname(entry.path))?.type !== 'directory') {
            throw new Error('Missing parent directory or symlink ancestor.');
        }
        seen.set(entry.path, entry);
    }
    for (const component of COMPONENTS) {
        if (seen.get(component)?.type !== 'directory') throw new Error('Missing backup component.');
    }
    for (const file of ['backend/server.js', 'backend/package.json', 'backend/package-lock.json', 'frontend/index.html']) {
        if (seen.get(file)?.type !== 'file') throw new Error('Incomplete application snapshot.');
    }
}

async function verifyPayload(root, id, requireComplete) {
    if (!validId(id)) throw new Error('Invalid backup ID.');
    const backup = checkedPath(root, `backups/${id}`);
    const stat = fs.lstatSync(backup);
    if (!stat.isDirectory() || (process.platform !== 'win32' && ((stat.mode & 0o7777) !== 0o700 || stat.uid !== process.getuid()))) {
        throw new Error('Unsafe backup storage.');
    }
    const raw = readPrivate(root, `backups/${id}/manifest.json`);
    if (readPrivate(root, `backups/${id}/manifest.sha256`) !== digest(raw) + '\n') throw new Error('Manifest SHA-256 mismatch.');
    const manifest = JSON.parse(raw);
    validateManifest(manifest, id);
    const journal = readTransaction(root, manifest.transaction);
    if (journal.operation !== 'backup' || journal.backupId !== id
        || journal.events.at(-1).phase !== (requireComplete ? 'complete' : 'verifying')
        || (requireComplete && transactionUnconfirmed(root, journal.id))) throw new Error('Backup transaction incomplete or unconfirmed.');
    const expectedNames = ['manifest.json', 'manifest.sha256', 'payload', ...(requireComplete ? ['READY'] : [])].sort();
    if (JSON.stringify(fs.readdirSync(backup).sort()) !== JSON.stringify(expectedNames)) throw new Error('Unexpected/incomplete backup contents.');
    if (requireComplete && readPrivate(root, `backups/${id}/READY`) !== digest(raw) + '\n') throw new Error('Invalid backup completion seal.');
    const payload = checkedPath(root, `backups/${id}/payload`);
    const payloadStat = fs.lstatSync(payload);
    if (!payloadStat.isDirectory() || (process.platform !== 'win32' && ((payloadStat.mode & 0o7777) !== 0o700 || payloadStat.uid !== process.getuid()))) {
        throw new Error('Unsafe payload directory.');
    }
    const found = [];
    async function walk(relative) {
        allowedEntry(relative);
        const file = path.join(payload, ...relative.split('/'));
        const info = fs.lstatSync(file);
        if (info.isSymbolicLink()) {
            const component = relative.split('/')[0];
            validateLink(path.join(payload, component), relative.slice(component.length + 1), fs.readlinkSync(file));
            found.push({ path: relative, type: 'symlink', target: fs.readlinkSync(file), sha256: digest(fs.readlinkSync(file)) });
        } else if (info.isDirectory()) {
            if (process.platform !== 'win32' && ((info.mode & 0o7777) !== 0o700 || info.uid !== process.getuid())) throw new Error('Unsafe payload directory.');
            found.push({ path: relative, type: 'directory' });
            for (const child of fs.readdirSync(file).sort()) await walk(`${relative}/${child}`);
        } else if (info.isFile()) {
            if (process.platform !== 'win32' && ((info.mode & 0o7777) !== 0o600 || info.uid !== process.getuid())) throw new Error('Unsafe payload file.');
            found.push({ path: relative, type: 'file', bytes: info.size, sha256: await streamFile(file) });
        } else throw new Error('Unsupported payload entry.');
    }
    if (JSON.stringify(fs.readdirSync(payload).sort()) !== JSON.stringify([...COMPONENTS].sort())) throw new Error('Unexpected payload component.');
    for (const component of COMPONENTS) await walk(component);
    const content = entries => entries.map(({ mode, uid, gid, ...entry }) => entry);
    if (JSON.stringify(found) !== JSON.stringify(content(manifest.entries))) throw new Error('Payload integrity mismatch.');
    return manifest;
}

export async function verifyBackup(root, id) {
    return verifyPayload(root, id, true);
}

export async function createBackup(input) {
    return withWorkspaceLock(input.isolation, 'backup', lease => createBackupLocked(input, lease));
}

async function createBackupLocked({ isolation, backend, frontend, commit }, lease) {
    requireIsolation(isolation);
    if (!/^[0-9a-f]{40}$/.test(commit || '')) throw new Error('A full source commit is required.');
    if (inspectTransactions(isolation).some(transaction => transaction.incomplete)) throw new Error('Incomplete transaction requires review.');
    const sources = { backend: sourcePath(isolation, backend), modules: sourcePath(isolation, path.join(backend, 'node_modules')),
        frontend: sourcePath(isolation, frontend) };
    if (backend === frontend || frontend.startsWith(backend + path.sep) || backend.startsWith(frontend + path.sep)) throw new Error('Overlapping sources.');
    const id = randomUUID();
    const transaction = lease.transaction;
    try {
        startTransaction(isolation, 'backup', id, null, transaction);
        const directory = checkedPath(isolation, `backups/${id}`, true);
        fs.mkdirSync(directory, { mode: 0o700 });
        fs.mkdirSync(path.join(directory, 'payload'), { mode: 0o700 });
        advanceTransaction(isolation, transaction, 'copying');
        const entries = [];
        for (const component of COMPONENTS) entries.push(...await inventory(sources[component], component));
        const manifest = { format: FORMAT, id, transaction, commit, createdAt: new Date().toISOString(),
            runtime: { node: process.versions.node, abi: process.versions.modules, platform: process.platform, arch: process.arch },
            excluded: EXCLUDED, entries };
        validateManifest(manifest, id);
        for (const entry of entries) {
            const [component, ...parts] = entry.path.split('/');
            const destination = path.join(directory, 'payload', ...entry.path.split('/'));
            const source = path.join(sources[component], ...parts);
            if (entry.type === 'directory') fs.mkdirSync(destination, { mode: 0o700 });
            else if (entry.type === 'symlink') fs.symlinkSync(entry.target, destination);
            else if (await streamFile(source, destination) !== entry.sha256) throw new Error('Source changed during capture.');
        }
        // Detect additions, removals and metadata/content changes during capture.
        const after = [];
        for (const component of COMPONENTS) after.push(...await inventory(sources[component], component));
        if (JSON.stringify(after) !== JSON.stringify(entries)) throw new Error('Source tree changed during capture.');
        const raw = JSON.stringify(manifest, null, 2) + '\n';
        writePrivate(isolation, `backups/${id}/manifest.json`, raw);
        writePrivate(isolation, `backups/${id}/manifest.sha256`, digest(raw) + '\n');
        advanceTransaction(isolation, transaction, 'verifying');
        await verifyPayload(isolation, id, false);
        for (const entry of [...entries].reverse().filter(entry => entry.type === 'directory')) {
            syncDirectory(path.join(directory, 'payload', ...entry.path.split('/')));
        }
        syncDirectory(path.join(directory, 'payload'));
        writePrivate(isolation, `backups/${id}/READY`, digest(raw) + '\n');
        syncDirectory(path.dirname(directory));
        advanceTransaction(isolation, transaction, 'complete');
        if (readTransaction(isolation, transaction).events.at(-1).phase !== 'complete') throw new Error('Completion not confirmed.');
        return { id, transaction, directory };
    } catch (error) {
        // No paths are deleted on failure; incomplete copies remain available for diagnosis.
        recordFailedTransaction(isolation, transaction, error, lease);
        throw error;
    }
}

function restoredRelative(entry) {
    const [component, ...parts] = entry.path.split('/');
    return [...(component === 'modules' ? ['backend', 'node_modules'] : [component]), ...parts].join('/');
}

export async function restoreBackup(input) {
    return withWorkspaceLock(input.isolation, 'restore', lease => restoreBackupLocked(input, lease));
}

function applyRestoredMode(file, entry) {
    if (process.platform === 'win32') { fs.chmodSync(file, entry.mode); return; }
    // Open while the directory is still 700/file 600; fsync works even after mode 000.
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
        | (entry.type === 'directory' ? fs.constants.O_DIRECTORY : 0);
    const fd = fs.openSync(file, flags);
    try {
        fs.fchmodSync(fd, entry.mode);
        if ((fs.fstatSync(fd).mode & 0o7777) !== entry.mode) throw new Error('Restored permissions mismatch.');
        fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
}

async function restoreBackupLocked({ isolation, id }, lease) {
    requireIsolation(isolation);
    if (!validId(id)) throw new Error('Invalid backup ID.');
    if (inspectTransactions(isolation).some(transaction => transaction.incomplete)) throw new Error('Incomplete transaction requires review.');
    const relative = `restored/${randomUUID()}`; // No caller-supplied destination, overwrites or production restore.
    const transaction = lease.transaction;
    try {
        startTransaction(isolation, 'restore', id, relative, transaction);
        advanceTransaction(isolation, transaction, 'verifying');
        const manifest = await verifyBackup(isolation, id);
        if (manifest.runtime.platform !== process.platform || manifest.runtime.arch !== process.arch
            || manifest.runtime.abi !== process.versions.modules) throw new Error('Snapshot runtime/ABI differs; native modules cannot be reused.');
        const destination = checkedPath(isolation, relative, true);
        fs.mkdirSync(destination, { mode: 0o700 });
        advanceTransaction(isolation, transaction, 'copying');
        for (const entry of manifest.entries) {
            const file = path.join(destination, ...restoredRelative(entry).split('/'));
            const source = path.join(isolation, 'backups', id, 'payload', ...entry.path.split('/'));
            if (entry.type === 'directory') fs.mkdirSync(file, { mode: 0o700 });
            else if (entry.type === 'symlink') fs.symlinkSync(entry.target, file);
            else if (await streamFile(source, file) !== entry.sha256) throw new Error('Backup changed during restoration.');
        }
        advanceTransaction(isolation, transaction, 'checking');
        const restored = [];
        for (const component of COMPONENTS) {
            restored.push(...await inventory(path.join(destination, ...(component === 'modules' ? ['backend', 'node_modules'] : [component])), component));
        }
        // Verify content before permissions. Modes are checked separately when applied below.
        const content = list => list.map(({ mode, uid, gid, ...entry }) => entry);
        if (JSON.stringify(content(restored)) !== JSON.stringify(content(manifest.entries))) throw new Error('Restoration integrity mismatch.');
        // Recheck the complete backup to detect substitutions while restoring.
        await verifyBackup(isolation, id);
        for (const entry of [...manifest.entries].reverse().filter(entry => entry.type === 'directory')) {
            syncDirectory(path.join(destination, ...restoredRelative(entry).split('/')));
        }
        syncDirectory(destination);
        syncDirectory(path.dirname(destination));
        for (const entry of manifest.entries.filter(entry => entry.type === 'file')) {
            applyRestoredMode(path.join(destination, ...restoredRelative(entry).split('/')), entry);
        }
        // Children first; a non-searchable parent must never obstruct its descendants.
        for (const entry of [...manifest.entries].reverse().filter(entry => entry.type === 'directory')) {
            applyRestoredMode(path.join(destination, ...restoredRelative(entry).split('/')), entry);
        }
        writePrivate(isolation, `${relative}/RESTORED.json`, JSON.stringify({ backup: id, transaction, manifestSha256: digest(readPrivate(isolation, `backups/${id}/manifest.json`)) }));
        advanceTransaction(isolation, transaction, 'complete');
        if (readTransaction(isolation, transaction).events.at(-1).phase !== 'complete') throw new Error('Completion not confirmed.');
        return { directory: destination, transaction, backup: id };
    } catch (error) {
        recordFailedTransaction(isolation, transaction, error, lease);
        throw error;
    }
}
