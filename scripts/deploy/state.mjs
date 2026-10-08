// Phase 1 only: private, temporary workspaces. No production paths or process actions.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const FORMAT = 'ist-isolated-backup-v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const digest = value => createHash('sha256').update(value).digest('hex');
export const validId = value => typeof value === 'string' && UUID.test(value);

function privateMode(stat, mode) {
    if (process.platform !== 'win32' && ((stat.mode & 0o7777) !== mode || stat.uid !== process.getuid())) {
        throw new Error('Unsafe private storage permissions/owner.');
    }
}

export function createIsolation() {
    const parent = fs.realpathSync(os.tmpdir());
    const root = fs.mkdtempSync(path.join(parent, 'ist-deploy-isolated-'));
    fs.chmodSync(root, 0o700);
    for (const name of ['backups', 'journal', 'restored']) fs.mkdirSync(path.join(root, name), { mode: 0o700 });
    fs.writeFileSync(path.join(root, 'ISOLATED.json'), JSON.stringify({ format: FORMAT }), { flag: 'wx', mode: 0o600 });
    return root;
}

export function requireIsolation(root) {
    if (typeof root !== 'string' || !path.isAbsolute(root) || path.resolve(root) !== root
        || path.dirname(root) !== fs.realpathSync(os.tmpdir()) || !/^ist-deploy-isolated-[A-Za-z0-9]+$/.test(path.basename(root))) {
        throw new Error('Only an isolated temporary workspace is accepted.');
    }
    const stat = fs.lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(root) !== root) throw new Error('Invalid isolation root.');
    privateMode(stat, 0o700);
    const marker = fs.lstatSync(path.join(root, 'ISOLATED.json'));
    if (!marker.isFile() || marker.isSymbolicLink() || marker.nlink !== 1) throw new Error('Invalid isolation marker.');
    privateMode(marker, 0o600);
    if (fs.readFileSync(path.join(root, 'ISOLATED.json'), 'utf8') !== JSON.stringify({ format: FORMAT })) {
        throw new Error('Invalid isolation marker.');
    }
    return root;
}

export function relativePath(value) {
    if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0') || value.includes(':')
        || value.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Unsafe relative path.');
    return value;
}

export function checkedPath(root, relative, allowMissing = false) {
    requireIsolation(root);
    const parts = relativePath(relative).split('/');
    let current = root;
    for (let i = 0; i < parts.length; i++) {
        current = path.join(current, parts[i]);
        let stat;
        try { stat = fs.lstatSync(current); } catch (error) {
            if (allowMissing && error.code === 'ENOENT') return path.join(root, ...parts);
            throw error;
        }
        if (stat.isSymbolicLink() || (i < parts.length - 1 && !stat.isDirectory())) throw new Error('Symlink/non-directory in storage path.');
    }
    return current;
}

export function syncDirectory(directory) {
    if (process.platform === 'win32') return; // POSIX durability is tested separately on Linux.
    const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

export function writePrivate(root, relative, contents, replace = false) {
    const destination = checkedPath(root, relative, true);
    const parent = path.dirname(destination);
    privateMode(fs.lstatSync(parent), 0o700);
    const temporary = path.join(parent, `.pending-${randomUUID()}`);
    const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    let writeError;
    try {
        fs.writeFileSync(fd, contents);
        fs.fsyncSync(fd);
    } catch (error) { writeError = error; }
    try { fs.closeSync(fd); } catch (error) {
        if (writeError) attachSecondary(writeError, 'closeError', error);
        else writeError = error;
    }
    if (writeError) {
        removePending(temporary, writeError);
        throw writeError;
    }
    try {
        if (replace) {
            readPrivate(root, relative); // Refuse a substituted link, hardlink or public file.
            fs.renameSync(temporary, destination);
        } else {
            fs.linkSync(temporary, destination); // Exclusive publication: never overwrite an existing file.
            fs.unlinkSync(temporary);
        }
        syncDirectory(parent);
    } catch (error) {
        removePending(temporary, error);
        throw error;
    }
}

function removePending(file, original) {
    try { fs.unlinkSync(file); } catch (error) {
        if (error.code !== 'ENOENT') attachSecondary(original, 'cleanupError', error);
    }
}

export function readPrivate(root, relative) {
    const file = checkedPath(root, relative);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error('Private metadata must be a regular, unshared file.');
    privateMode(stat, 0o600);
    if (stat.size > 16 * 1024 * 1024) throw new Error('Metadata too large.');
    return fs.readFileSync(file, 'utf8');
}

function attachSecondary(original, name, secondary) {
    // Keep the exact original exception, including when it is not extensible.
    if (original && (typeof original === 'object' || typeof original === 'function')) {
        try { Object.defineProperty(original, name, { value: secondary, configurable: true }); } catch { /* Original wins. */ }
    }
}

export function readWorkspaceLock(root) {
    requireIsolation(root);
    try { fs.lstatSync(path.join(root, 'WORKSPACE.lock')); } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
    }
    const record = JSON.parse(readPrivate(root, 'WORKSPACE.lock'));
    if (record.version !== 1 || !validId(record.transaction) || !validId(record.token)
        || !['backup', 'restore'].includes(record.operation) || !Number.isSafeInteger(record.pid) || record.pid < 1) {
        throw new Error('Invalid workspace lock; manual review required.');
    }
    return record;
}

export function transactionUnconfirmed(root, id) {
    return readWorkspaceLock(root)?.transaction === id;
}

export async function withWorkspaceLock(root, operation, work) {
    requireIsolation(root);
    if (!['backup', 'restore'].includes(operation)) throw new Error('Invalid workspace operation.');
    const file = checkedPath(root, 'WORKSPACE.lock', true);
    const record = { version: 1, token: randomUUID(), transaction: randomUUID(), operation,
        pid: process.pid, createdAt: new Date().toISOString() };
    let fd;
    try { fd = fs.openSync(file, 'wx', 0o600); } catch (error) {
        if (error.code === 'EEXIST') throw new Error('Workspace locked; active or abandoned lock requires review.', { cause: error });
        throw error;
    }
    const owned = fs.fstatSync(fd);
    let retained = false, failed = false, original, result;
    try {
        fs.writeFileSync(fd, JSON.stringify(record));
        fs.fsyncSync(fd);
        syncDirectory(root);
    } catch (error) {
        try { fs.closeSync(fd); } catch (closeError) { attachSecondary(error, 'closeError', closeError); }
        throw error; // Never automatically delete a lock whose acquisition was not confirmed.
    }
    const lease = { transaction: record.transaction, retain() { retained = true; } };
    try { result = await work(lease); } catch (error) { failed = true; original = error; }
    try {
        fs.closeSync(fd);
        if (!retained) {
            const current = fs.lstatSync(file);
            if (current.dev !== owned.dev || current.ino !== owned.ino
                || JSON.stringify(readWorkspaceLock(root)) !== JSON.stringify(record)) {
                throw new Error('Workspace lock ownership changed; manual review required.');
            }
            fs.unlinkSync(file);
            // A crash may leave a stale lock on disk. It is always rejected, never reaped by PID/age.
        }
    } catch (cleanupError) {
        if (!failed) throw cleanupError;
        attachSecondary(original, 'lockError', cleanupError);
    }
    if (failed) throw original;
    return result;
}

export function recordFailedTransaction(root, id, original, lease) {
    try {
        advanceTransaction(root, id, 'failed');
        if (readTransaction(root, id).events.at(-1).phase !== 'failed') throw new Error('Failed state not confirmed.');
    } catch (journalError) {
        lease.retain();
        attachSecondary(original, 'journalError', journalError);
    }
}

const transitions = {
    backup: { started: ['copying', 'failed'], copying: ['verifying', 'failed'], verifying: ['complete', 'failed'] },
    restore: { started: ['verifying', 'failed'], verifying: ['copying', 'failed'], copying: ['checking', 'failed'], checking: ['complete', 'failed'] }
};

export function startTransaction(root, operation, backupId, destination = null, id = randomUUID()) {
    if (!transitions[operation] || !validId(backupId)
        || !validId(id)
        || (operation === 'restore' ? !/^restored\/[0-9a-f-]{36}$/.test(destination || '') : destination !== null)) {
        throw new Error('Invalid transaction metadata.');
    }
    const record = { version: 1, id, operation, backupId, destination, events: [{ phase: 'started', at: new Date().toISOString() }] };
    saveTransaction(root, record, false);
    return id;
}

function saveTransaction(root, record, replace) {
    writePrivate(root, `journal/${record.id}.json`, JSON.stringify({ record, sha256: digest(JSON.stringify(record)) }), replace);
}

export function readTransaction(root, id) {
    if (!validId(id)) throw new Error('Invalid transaction ID.');
    const { record, sha256 } = JSON.parse(readPrivate(root, `journal/${id}.json`));
    if (!record || digest(JSON.stringify(record)) !== sha256 || record.version !== 1 || record.id !== id
        || !transitions[record.operation] || !validId(record.backupId) || !Array.isArray(record.events) || !record.events.length) {
        throw new Error('Invalid journal integrity/schema.');
    }
    if (record.operation === 'backup' ? record.destination !== null : !/^restored\/[0-9a-f-]{36}$/.test(record.destination || '')) {
        throw new Error('Invalid journal destination.');
    }
    let previous;
    for (const event of record.events) {
        if (typeof event.at !== 'string' || !Number.isFinite(Date.parse(event.at))
            || (previous ? !transitions[record.operation][previous]?.includes(event.phase) : event.phase !== 'started')) {
            throw new Error('Invalid journal transition.');
        }
        previous = event.phase;
    }
    return record;
}

export function advanceTransaction(root, id, phase) {
    if (!validId(id)) throw new Error('Invalid transaction ID.');
    const lock = checkedPath(root, `journal/${id}.lock`, true);
    const fd = fs.openSync(lock, 'wx', 0o600);
    let original;
    try {
        const record = readTransaction(root, id);
        const current = record.events.at(-1).phase;
        if (!transitions[record.operation][current]?.includes(phase)) throw new Error('Invalid journal transition.');
        record.events.push({ phase, at: new Date().toISOString() });
        saveTransaction(root, record, true);
    } catch (error) { original = error; }
    for (const cleanup of [() => fs.closeSync(fd), () => fs.unlinkSync(lock)]) {
        try { cleanup(); } catch (error) {
            if (original) attachSecondary(original, 'cleanupError', error);
            else original = error;
        }
    }
    if (original) throw original;
}

export function inspectTransactions(root) {
    const directory = checkedPath(root, 'journal');
    return fs.readdirSync(directory).filter(name => name.endsWith('.json')).sort().map(name => {
        const record = readTransaction(root, name.slice(0, -5));
        const phase = record.events.at(-1).phase;
        const unconfirmed = transactionUnconfirmed(root, record.id);
        return { ...record, unconfirmed, incomplete: unconfirmed || (phase !== 'complete' && phase !== 'failed') };
    });
}
