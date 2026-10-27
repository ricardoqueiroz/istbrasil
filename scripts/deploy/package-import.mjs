// Imports a sealed source package into the existing isolated export workspace.
// This module never activates a release or writes outside that workspace.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import * as tar from 'tar';
import { requireExportWorkspace, safeGitPath, exclusionReason } from './git-export.mjs';

const FORMAT = 'ist-release-package-v1';
const RECORD_FORMAT = 'ist-imported-package-v1';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_FILES = 250000;
const MAX_FILE = 64 * 1024 * 1024;
const MAX_TOTAL = 2 * 1024 * 1024 * 1024;
const MAX_MANIFEST = 16 * 1024 * 1024;
const MAX_ENTRIES = 10000;
const fail = code => Object.assign(new Error(code), { code });
const hash = value => createHash('sha256').update(value).digest('hex');
const binaryCompare = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const exactKeys = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('|') === [...keys].sort().join('|');

function safePackagePath(value) {
    if (typeof value !== 'string' || !value || value.endsWith('/') || path.posix.normalize(value) !== value
        || path.posix.isAbsolute(value) || /[\\\0\r\n]/.test(value)) throw fail('PACKAGE_PATH_UNSAFE');
    try { safeGitPath(value); } catch { throw fail('PACKAGE_PATH_UNSAFE'); }
    return value;
}

function validateManifest(value) {
    if (!exactKeys(value, ['version', 'format', 'releaseVersion', 'commitSha', 'treeSha', 'createdAt', 'directories', 'files'])
        || value.version !== 1 || value.format !== FORMAT || !VERSION.test(value.releaseVersion)
        || !SHA1.test(value.commitSha) || !SHA1.test(value.treeSha)
        || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))
        || new Date(value.createdAt).toISOString() !== value.createdAt
        || !Array.isArray(value.directories) || !Array.isArray(value.files)
        || value.files.length > MAX_FILES || value.directories.length > MAX_FILES) throw fail('PACKAGE_MANIFEST_INVALID');
    const seen = new Set(), collisions = new Set(); let total = 0;
    const register = relative => {
        safePackagePath(relative);
        if (exclusionReason(relative)) throw fail('PACKAGE_PROTECTED_ENTRY');
        const collision = relative.normalize('NFC').toLowerCase();
        if (seen.has(relative) || collisions.has(collision)) throw fail('PACKAGE_DUPLICATE_ENTRY');
        seen.add(relative); collisions.add(collision);
    };
    if (JSON.stringify([...value.directories].sort(binaryCompare)) !== JSON.stringify(value.directories)) throw fail('PACKAGE_MANIFEST_INVALID');
    for (const relative of value.directories) register(relative);
    if (JSON.stringify([...value.files].sort((a, b) => binaryCompare(String(a?.path), String(b?.path)))) !== JSON.stringify(value.files)) throw fail('PACKAGE_MANIFEST_INVALID');
    for (const file of value.files) {
        if (!exactKeys(file, ['path', 'mode', 'size', 'sha256']) || ![0o600, 0o644, 0o700, 0o755].includes(file.mode)
            || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_FILE || !SHA256.test(file.sha256)) throw fail('PACKAGE_MANIFEST_INVALID');
        register(file.path); total += file.size;
        if (total > MAX_TOTAL) throw fail('PACKAGE_SIZE_LIMIT');
        const parent = path.posix.dirname(file.path);
        if (parent !== '.' && !seen.has(parent)) throw fail('PACKAGE_PARENT_MISSING');
    }
    for (const directory of value.directories) {
        const parent = path.posix.dirname(directory);
        if (parent !== '.' && !seen.has(parent)) throw fail('PACKAGE_PARENT_MISSING');
    }
    for (const required of ['server.js', 'package.json', 'package-lock.json']) if (!value.files.some(file => file.path === required)) throw fail('PACKAGE_INCOMPLETE');
    return value;
}

async function copyStablePackage(source, destination) {
    if (typeof source !== 'string' || !path.isAbsolute(source) || path.resolve(source) !== source || await fs.realpath(source) !== source) throw fail('PACKAGE_SOURCE_UNSAFE');
    const input = await fs.open(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let output;
    try {
        const before = await input.stat({ bigint: true });
        if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.uid !== BigInt(process.getuid()) || before.mode & 0o022n
            || before.size <= 0n || before.size > BigInt(MAX_TOTAL + MAX_MANIFEST + 64 * 1024 * 1024)) throw fail('PACKAGE_SOURCE_UNSAFE');
        output = await fs.open(destination, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        const buffer = Buffer.allocUnsafe(1024 * 1024); let position = 0;
        while (position < Number(before.size)) {
            const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, Number(before.size) - position), position);
            if (!bytesRead) throw fail('PACKAGE_SOURCE_CHANGED');
            let written = 0;
            while (written < bytesRead) written += (await output.write(buffer, written, bytesRead - written, position + written)).bytesWritten;
            position += bytesRead;
        }
        await output.sync();
        const after = await input.stat({ bigint: true });
        if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs) throw fail('PACKAGE_SOURCE_CHANGED');
    } finally { await output?.close().catch(() => {}); await input.close().catch(() => {}); }
}

async function openRegular(filename, { mode, limit = Infinity, code = 'PACKAGE_CONTENT_UNSAFE' } = {}) {
    const before = await fs.lstat(filename);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.uid !== process.getuid() || before.gid !== process.getgid()
        || (mode === undefined ? before.mode & 0o022 : (before.mode & 0o7777) !== mode) || before.size > limit) throw fail(code);
    const handle = await fs.open(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
        if (!sameStat(before, await handle.stat())) throw fail(code);
        return { handle, before };
    } catch (error) { await handle.close(); throw error; }
}

async function fileDigest(filename, mode) {
    const digest = createHash('sha256'), { handle, before } = await openRegular(filename, { mode });
    try {
        for await (const chunk of handle.createReadStream({ autoClose: false })) digest.update(chunk);
        if (!sameStat(before, await handle.stat()) || !sameStat(before, await fs.lstat(filename))) throw fail('PACKAGE_CONTENT_CHANGED');
        return digest.digest('hex');
    }
    finally { await handle.close(); }
}

const sameStat = (a, b) => ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'mode', 'uid', 'gid', 'nlink'].every(key => a[key] === b[key]);

async function privateDirectory(filename, expectedParent) {
    const stat = await fs.lstat(filename);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.gid !== process.getgid()
        || (stat.mode & 0o7777) !== 0o700) throw fail('PACKAGE_DIRECTORY_UNSAFE');
    const real = await fs.realpath(filename);
    if (real !== filename || expectedParent && path.dirname(real) !== expectedParent) throw fail('PACKAGE_DIRECTORY_UNSAFE');
    return stat;
}

async function requirePackagesDirectory(workspace) {
    const parent = `${workspace}/packages`;
    try { await fs.mkdir(parent, { mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    await privateDirectory(parent, workspace);
    return parent;
}

async function readPrivateFile(filename, limit, code = 'PACKAGE_RECORD_INVALID') {
    const { handle, before } = await openRegular(filename, { mode: 0o600, limit, code });
    try {
        if (!sameStat(before, await handle.stat())) throw fail(code);
        const bytes = await handle.readFile();
        if (!sameStat(before, await handle.stat()) || !sameStat(before, await fs.lstat(filename))) throw fail(code);
        return bytes;
    } finally { await handle.close(); }
}

async function extractInspectedArchive(filename, destination, expectedSha256) {
    const extraction = `${destination}.extracting`;
    await fs.mkdir(extraction, { mode: 0o700 });
    const found = new Map(), archiveCollisions = new Set(), contexts = new WeakMap(), controller = new AbortController();
    const archiveDigest = createHash('sha256'), { handle, before } = await openRegular(filename, { mode: 0o600 });
    let manifestBytes, entries = 0, total = 0, streamError, after;
    const abort = (entry, error) => { streamError ||= error; entry.resume(); controller.abort(); };
    try {
        const extractor = tar.x({ cwd: extraction, strict: true, preservePaths: false, noChmod: true, signal: controller.signal, transform(entry) {
            const context = contexts.get(entry);
            if (!context) return undefined;
            const stream = new Transform({ transform(chunk, encoding, callback) {
                context.size += chunk.length; context.digest.update(chunk); if (context.relative === null) context.chunks.push(chunk);
                callback(null, chunk);
            }, flush(callback) {
                try {
                    if (context.size !== context.declared) throw fail('PACKAGE_ARCHIVE_ENTRY_UNSAFE');
                    if (context.relative === null) manifestBytes = Buffer.concat(context.chunks);
                    else found.set(context.relative, { type: 'file', mode: context.mode, size: context.size, sha256: context.digest.digest('hex') });
                    callback();
                } catch (error) { abort(entry, error); callback(error); }
            } });
            stream.on('error', error => abort(entry, error));
            return stream;
        }, onentry(entry) {
            try {
                const raw = entry.path, relative = raw === 'IST-RELEASE.json' ? null : raw === 'source/' || raw === 'source' ? ''
                    : raw.startsWith('source/') ? raw.slice(7).replace(/\/$/, '') : undefined;
                if (++entries > MAX_ENTRIES) throw fail('PACKAGE_ENTRY_LIMIT');
                if (relative === undefined || !['File', 'OldFile', 'Directory'].includes(entry.type)) throw fail('PACKAGE_ARCHIVE_ENTRY_UNSAFE');
                const declared = Number(entry.size);
                if (!Number.isSafeInteger(declared) || declared < 0 || declared > (raw === 'IST-RELEASE.json' ? MAX_MANIFEST : MAX_FILE)) throw fail('PACKAGE_SIZE_LIMIT');
                total += declared;
                if (total > MAX_TOTAL + MAX_MANIFEST) throw fail('PACKAGE_SIZE_LIMIT');
                if (raw === 'IST-RELEASE.json' && (!['File', 'OldFile'].includes(entry.type) || manifestBytes)) throw fail('PACKAGE_MANIFEST_INVALID');
                if (relative === '') {
                    if (entry.type !== 'Directory' || found.has('')) throw fail('PACKAGE_ARCHIVE_ENTRY_UNSAFE');
                    found.set('', { type: 'directory' }); return;
                }
                if (relative !== null) {
                    safePackagePath(relative);
                    const collision = relative.normalize('NFC').toLowerCase();
                    if (found.has(relative) || archiveCollisions.has(collision)) throw fail('PACKAGE_DUPLICATE_ENTRY');
                    archiveCollisions.add(collision);
                }
                if (entry.type === 'Directory') found.set(relative, { type: 'directory' });
                else contexts.set(entry, { relative, declared, mode: Number(entry.mode) & 0o777, digest: createHash('sha256'), chunks: [], size: 0 });
            } catch (error) { abort(entry, error); }
        } });
        const input = handle.createReadStream({ autoClose: false });
        input.on('data', chunk => archiveDigest.update(chunk));
        await pipeline(input, extractor);
        after = await handle.stat();
    } catch (error) { if (!streamError) streamError = error; }
    finally { await handle.close(); }
    if (streamError) throw streamError;
    if (!sameStat(before, after) || !sameStat(before, await fs.lstat(filename)) || archiveDigest.digest('hex') !== expectedSha256) throw fail('PACKAGE_CONTENT_CHANGED');
    if (!manifestBytes || !found.has('')) throw fail('PACKAGE_INCOMPLETE');
    let manifest; try { manifest = validateManifest(JSON.parse(manifestBytes.toString('utf8'))); } catch (error) { throw error.code ? error : fail('PACKAGE_MANIFEST_INVALID'); }
    const expected = new Map([['', { type: 'directory' }], ...manifest.directories.map(name => [name, { type: 'directory' }]), ...manifest.files.map(file => [file.path, { type: 'file', mode: file.mode, size: file.size, sha256: file.sha256 }])]);
    const ordered = value => [...value].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    if (JSON.stringify(ordered(found)) !== JSON.stringify(ordered(expected))) throw fail('PACKAGE_INVENTORY_MISMATCH');
    const extractedSource = `${extraction}/source`;
    for (const directory of manifest.directories) await fs.chmod(`${extractedSource}/${directory}`, 0o700);
    for (const file of manifest.files) await fs.chmod(`${extractedSource}/${file.path}`, file.mode);
    await verifySource(extractedSource, manifest);
    await fs.rename(extractedSource, destination);
    await fs.rm(extraction, { recursive: true });
    return manifest;
}

async function verifySource(root, manifest) {
    const directories = [], files = [];
    const visit = async (directory, relative = '') => {
        const stat = await fs.lstat(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.mode & 0o022) throw fail('PACKAGE_CONTENT_UNSAFE');
        for (const name of (await fs.readdir(directory)).sort(binaryCompare)) {
            const current = relative ? `${relative}/${name}` : name;
            safePackagePath(current);
            const filename = `${root}/${current}`, item = await fs.lstat(filename);
            if (item.isDirectory() && !item.isSymbolicLink()) { directories.push(current); await visit(filename, current); }
            else if (item.isFile() && !item.isSymbolicLink() && item.nlink === 1) files.push({ path: current, mode: item.mode & 0o777, size: item.size, sha256: await fileDigest(filename) });
            else throw fail('PACKAGE_CONTENT_UNSAFE');
        }
    };
    await visit(root);
    if (JSON.stringify(directories) !== JSON.stringify(manifest.directories) || JSON.stringify(files) !== JSON.stringify(manifest.files)) throw fail('PACKAGE_CONTENT_MISMATCH');
}

export async function importPackage({ workspace, packagePath, expectedSha256 }) {
    await requireExportWorkspace(workspace);
    if (!SHA256.test(expectedSha256 || '')) throw fail('PACKAGE_ARGUMENT_INVALID');
    const parent = await requirePackagesDirectory(workspace), packageId = randomUUID(), destination = `${parent}/${packageId}`;
    await fs.mkdir(destination, { mode: 0o700 });
    const identity = await privateDirectory(destination, parent), archive = `${destination}/archive.tar`, source = `${destination}/source`;
    try {
        await copyStablePackage(packagePath, archive);
        if (await fileDigest(archive, 0o600) !== expectedSha256) throw fail('PACKAGE_DIGEST_MISMATCH');
        const manifest = await extractInspectedArchive(archive, source, expectedSha256);
        await verifySource(source, manifest);
        const record = { version: 1, format: RECORD_FORMAT, packageId, packageSha256: expectedSha256, releaseVersion: manifest.releaseVersion,
            commitSha: manifest.commitSha, treeSha: manifest.treeSha, createdAt: manifest.createdAt, directories: manifest.directories, files: manifest.files };
        const bytes = Buffer.from(JSON.stringify(record));
        await fs.writeFile(`${destination}/record.json`, bytes, { flag: 'wx', mode: 0o600 });
        await fs.writeFile(`${destination}/COMPLETE.json`, JSON.stringify({ version: 1, packageId, recordSha256: hash(bytes) }), { flag: 'wx', mode: 0o600 });
        return { record, source };
    } catch (error) {
        try {
            await privateDirectory(parent, workspace);
            const current = await privateDirectory(destination, parent);
            if (current.dev !== identity.dev || current.ino !== identity.ino) throw fail('PACKAGE_CLEANUP_UNSAFE');
            await fs.rm(destination, { recursive: true });
        } catch (cleanupError) { error.cleanupCode = cleanupError.code || 'PACKAGE_CLEANUP_UNSAFE'; }
        throw error;
    }
}

export async function verifyPackage({ workspace, packageId }) {
    await requireExportWorkspace(workspace);
    if (!UUID.test(packageId)) throw fail('PACKAGE_ARGUMENT_INVALID');
    const parent = await requirePackagesDirectory(workspace), destination = `${parent}/${packageId}`;
    await privateDirectory(destination, parent);
    if ((await fs.readdir(destination)).sort().join('|') !== 'COMPLETE.json|archive.tar|record.json|source') throw fail('PACKAGE_INCOMPLETE');
    const bytes = await readPrivateFile(`${destination}/record.json`, MAX_MANIFEST), record = JSON.parse(bytes);
    const complete = JSON.parse((await readPrivateFile(`${destination}/COMPLETE.json`, 4096)).toString('utf8'));
    if (!exactKeys(record, ['version', 'format', 'packageId', 'packageSha256', 'releaseVersion', 'commitSha', 'treeSha', 'createdAt', 'directories', 'files'])
        || record.version !== 1 || record.format !== RECORD_FORMAT || record.packageId !== packageId || !SHA256.test(record.packageSha256)
        || !exactKeys(complete, ['version', 'packageId', 'recordSha256']) || complete.version !== 1 || complete.packageId !== packageId || complete.recordSha256 !== hash(bytes)) throw fail('PACKAGE_RECORD_INVALID');
    validateManifest({ version: 1, format: FORMAT, releaseVersion: record.releaseVersion, commitSha: record.commitSha, treeSha: record.treeSha,
        createdAt: record.createdAt, directories: record.directories, files: record.files });
    if (await fileDigest(`${destination}/archive.tar`, 0o600) !== record.packageSha256) throw fail('PACKAGE_DIGEST_MISMATCH');
    await verifySource(`${destination}/source`, record);
    return record;
}
