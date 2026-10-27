// Phase 2.2-B/C/D: build a sealed, inactive release inside an isolated export workspace.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { requireExportWorkspace, verifyExport, safeGitPath } from './git-export.mjs';
import { verifyPackage } from './package-import.mjs';
import { preparationPaths, releasePaths, validatePreparedManifest, validatePreparedSeal } from './production-contract.mjs';

const execFileAsync = promisify(execFile);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const FORMAT = 'ist-prepared-inactive-v1';
const MAX_FILES = 500000;
const MAX_MANIFEST = 128 * 1024 * 1024;
const digest = value => createHash('sha256').update(value).digest('hex');
const fail = code => Object.assign(new Error(code), { code });

async function privateDirectory(filename) {
    const stat = await fs.lstat(filename);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.gid !== process.getgid() || stat.mode & 0o022) throw fail('PREPARATION_WORKSPACE_UNSAFE');
    return stat;
}

async function persistentDirectory(filename) {
    const stat = await fs.lstat(filename);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.gid !== process.getgid()
        || (stat.mode & 0o7777) !== 0o700 || await fs.realpath(filename) !== filename) throw fail('PERSISTENT_PREPARATION_DIRECTORY_UNSAFE');
    return stat;
}

function requirePersistentPaths(paths) {
    if (!paths || paths.admin !== `${paths.base}/.deploy` || paths.preparations !== `${paths.admin}/preparations`
        || paths.releases !== `${paths.admin}/releases` || !path.isAbsolute(paths.preparations) || path.normalize(paths.preparations) !== paths.preparations
        || !path.isAbsolute(paths.releases) || path.normalize(paths.releases) !== paths.releases) throw fail('PERSISTENT_PREPARATION_PATH_INVALID');
}

async function writeExclusive(filename, value) {
    const handle = await fs.open(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(value); await handle.sync(); } finally { await handle.close(); }
}

const sameStat = (a, b) => ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'mode', 'uid', 'gid', 'nlink'].every(key => a[key] === b[key]);

async function readPrivate(filename, limit = MAX_MANIFEST) {
    const before = await fs.lstat(filename);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.uid !== process.getuid() || before.gid !== process.getgid()
        || (before.mode & 0o7777) !== 0o600 || before.size > limit) throw fail('PERSISTENT_PREPARATION_METADATA_UNSAFE');
    const handle = await fs.open(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
        if (!sameStat(before, await handle.stat())) throw fail('PERSISTENT_PREPARATION_CHANGED');
        const bytes = await handle.readFile();
        if (!sameStat(before, await handle.stat()) || !sameStat(before, await fs.lstat(filename))) throw fail('PERSISTENT_PREPARATION_CHANGED');
        return bytes;
    } finally { await handle.close(); }
}

async function syncDirectory(filename) {
    const handle = await fs.open(filename, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0) | (fs.constants.O_NOFOLLOW || 0));
    try { await handle.sync(); } finally { await handle.close(); }
}

async function copyPreparedTree(source, destination, boundary = source) {
    const sourceDirectory = await privateDirectory(source), directoryMode = sourceDirectory.mode & 0o777;
    await fs.mkdir(destination, { mode: directoryMode }); await fs.chmod(destination, directoryMode);
    for (const name of (await fs.readdir(source)).sort()) {
        safeGitPath(name);
        const from = `${source}/${name}`, to = `${destination}/${name}`, stat = await fs.lstat(from);
        if (stat.uid !== process.getuid() || stat.gid !== process.getgid() || !stat.isSymbolicLink() && stat.mode & 0o022) throw fail('PREPARATION_CONTENT_UNSAFE');
        if (stat.isDirectory() && !stat.isSymbolicLink()) await copyPreparedTree(from, to, boundary);
        else if (stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1) {
            await fs.copyFile(from, to, fs.constants.COPYFILE_EXCL); await fs.chmod(to, stat.mode & 0o777);
        } else if (stat.isSymbolicLink()) {
            const target = await fs.readlink(from), resolved = path.resolve(path.dirname(from), target), relative = path.relative(boundary, resolved);
            if (path.isAbsolute(target) || relative.startsWith('..') || path.isAbsolute(relative)) throw fail('PREPARATION_LINK_UNSAFE');
            await fs.symlink(target, to);
        } else throw fail('PREPARATION_TYPE_UNSAFE');
    }
}

async function acquireLock(workspace) {
    const filename = `${workspace}/PREPARE.lock`, token = randomUUID();
    try { await writeExclusive(filename, JSON.stringify({ version: 1, token, pid: process.pid })); }
    catch (error) { if (error.code === 'EEXIST') throw fail('PREPARATION_LOCK_EXISTS'); throw error; }
    return async () => {
        const current = JSON.parse(await fs.readFile(filename, 'utf8'));
        if (current.token !== token) throw fail('PREPARATION_LOCK_CHANGED');
        await fs.unlink(filename);
    };
}

async function copyExport(record, source, destination) {
    await fs.mkdir(destination, { mode: 0o700 });
    for (const relative of record.directories) await fs.mkdir(`${destination}/${relative}`, { mode: 0o700 });
    for (const file of record.files) {
        safeGitPath(file.path);
        await fs.copyFile(`${source}/${file.path}`, `${destination}/${file.path}`, fs.constants.COPYFILE_EXCL);
        await fs.chmod(`${destination}/${file.path}`, file.mode);
    }
}

function cleanEnvironment(workspace, allowNetwork) {
    return {
        PATH: '/usr/local/bin:/usr/bin:/bin', HOME: workspace, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8',
        npm_config_cache: `${workspace}/npm-cache`, npm_config_userconfig: '/dev/null', npm_config_update_notifier: 'false',
        npm_config_audit: 'false', npm_config_fund: 'false', npm_config_offline: allowNetwork ? 'false' : 'true',
        NODE_ENV: 'development',
    };
}

async function defaultRunner(command, args, options) {
    try {
        return await execFileAsync(command, args, { cwd: options.cwd, env: options.env, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    } catch (error) {
        const wrapped = fail(options.stage === 'metadata' ? 'NPM_VERSION_UNAVAILABLE' : options.stage === 'install' ? 'DEPENDENCY_INSTALL_FAILED' : options.stage === 'build' ? 'ANGULAR_BUILD_FAILED' : 'NATIVE_MODULE_PROBE_FAILED');
        wrapped.cause = error;
        throw wrapped;
    }
}

async function inventory(root, ignoredRootEntries = new Set()) {
    const entries = []; let count = 0;
    const visit = async (directory, relative = '') => {
        await privateDirectory(directory);
        for (const name of (await fs.readdir(directory)).sort()) {
            if (!relative && ignoredRootEntries.has(name)) continue;
            const current = relative ? `${relative}/${name}` : name;
            safeGitPath(current);
            const filename = `${root}/${current}`, stat = await fs.lstat(filename);
            if (++count > MAX_FILES) throw fail('PREPARATION_FILE_LIMIT');
            if (stat.isDirectory() && !stat.isSymbolicLink()) { entries.push({ path: current, type: 'directory', mode: stat.mode & 0o777 }); await visit(filename, current); }
            else if (stat.isFile() && !stat.isSymbolicLink()) {
                if (stat.nlink !== 1 || stat.uid !== process.getuid() || stat.gid !== process.getgid() || stat.mode & 0o022) throw fail('PREPARATION_CONTENT_UNSAFE');
                const handle = await fs.open(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
                let bytes;
                try { if (!sameStat(stat, await handle.stat())) throw fail('PREPARATION_CONTENT_CHANGED'); bytes = await handle.readFile(); if (!sameStat(stat, await handle.stat()) || !sameStat(stat, await fs.lstat(filename))) throw fail('PREPARATION_CONTENT_CHANGED'); }
                finally { await handle.close(); }
                entries.push({ path: current, type: 'file', mode: stat.mode & 0o777, size: bytes.length, sha256: digest(bytes) });
            } else if (stat.isSymbolicLink()) {
                const target = await fs.readlink(filename), resolved = path.resolve(path.dirname(filename), target);
                if (stat.uid !== process.getuid() || stat.gid !== process.getgid() || path.relative(root, resolved).startsWith('..') || path.isAbsolute(target)) throw fail('PREPARATION_LINK_UNSAFE');
                entries.push({ path: current, type: 'symlink', target });
            } else throw fail('PREPARATION_TYPE_UNSAFE');
        }
    };
    await visit(root);
    return entries;
}

export async function verifyPreparedContent({ release, manifest }) {
    if (!validatePreparedManifest(manifest) || typeof release !== 'string' || !path.isAbsolute(release)) throw fail('PREPARED_CONTENT_ARGUMENT_INVALID');
    await privateDirectory(release);
    if (JSON.stringify(await inventory(release)) !== JSON.stringify(manifest.entries)) throw fail('PREPARED_CONTENT_INTEGRITY_FAILED');
    return manifest;
}

async function requireEssential(release) {
    for (const relative of ['backend/server.js', 'backend/package.json', 'backend/package-lock.json', 'backend/node_modules/bcrypt/package.json', 'backend/node_modules/sharp/package.json', 'frontend/index.html']) {
        const stat = await fs.lstat(`${release}/${relative}`).catch(() => null);
        if (!stat?.isFile()) throw fail('PREPARED_RELEASE_INCOMPLETE');
    }
}

async function resolveSource(workspace, exportId, packageId) {
    if (Boolean(exportId) === Boolean(packageId)) throw fail('PREPARATION_ARGUMENT_INVALID');
    if (exportId) {
        if (!UUID.test(exportId)) throw fail('PREPARATION_ARGUMENT_INVALID');
        const record = await verifyExport({ workspace, exportId });
        return { record, directory: `${workspace}/exports/${exportId}/source`, reference: { exportId } };
    }
    if (!UUID.test(packageId)) throw fail('PREPARATION_ARGUMENT_INVALID');
    const record = await verifyPackage({ workspace, packageId });
    return { record, directory: `${workspace}/packages/${packageId}/source`, reference: {
        sourceType: 'package', packageId, packageSha256: record.packageSha256, releaseVersion: record.releaseVersion,
    } };
}

export async function prepareRelease({ workspace, exportId, packageId, allowRegistry = false, runner = defaultRunner }) {
    await requireExportWorkspace(workspace);
    if (typeof runner !== 'function') throw fail('PREPARATION_ARGUMENT_INVALID');
    if (process.version !== 'v20.19.6') throw fail('NODE_VERSION_UNSUPPORTED');
    const source = await resolveSource(workspace, exportId, packageId), record = source.record;
    const releaseLock = await acquireLock(workspace);
    const preparationId = randomUUID(), root = `${workspace}/preparations`, destination = `${root}/${preparationId}`;
    let completed = false;
    try {
        await fs.mkdir(root, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
        await privateDirectory(root);
        await fs.mkdir(destination, { mode: 0o700 });
        const release = `${destination}/release`, backend = `${release}/backend`;
        await fs.mkdir(release, { mode: 0o700 });
        await copyExport(record, source.directory, backend);
        const packageJson = JSON.parse(await fs.readFile(`${backend}/package.json`, 'utf8'));
        for (const name of ['preinstall', 'install', 'postinstall', 'prepare']) if (packageJson.scripts?.[name]) throw fail('APPLICATION_LIFECYCLE_SCRIPT_UNAPPROVED');
        const env = cleanEnvironment(workspace, allowRegistry);
        const npmVersionResult = await runner('npm', ['--version'], { cwd: backend, env, stage: 'metadata', network: false });
        const npmVersion = String(npmVersionResult?.stdout || '').trim();
        if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(npmVersion)) throw fail('NPM_VERSION_INVALID');
        await runner('npm', ['ci', '--include=dev', '--strict-peer-deps'], { cwd: backend, env, stage: 'install', network: allowRegistry });
        await runner('npm', ['run', 'build', '--', '--configuration', 'production'], { cwd: backend, env, stage: 'build', network: false });
        await runner('node', ['-e', "require('bcrypt'); const sharp=require('sharp'); if (!sharp.versions?.sharp) process.exit(2)"], { cwd: backend, env, stage: 'native-probe', network: false });
        const built = `${backend}/dist/sakai-ng/browser`, frontend = `${release}/frontend`;
        await privateDirectory(built);
        await fs.rename(built, frontend);
        await fs.rm(`${backend}/dist`, { recursive: true, force: true });
        await requireEssential(release);
        const entries = await inventory(release);
        const manifest = { version: 1, format: FORMAT, status: 'PREPARED_INACTIVE', preparationId, ...source.reference,
            commitSha: record.commitSha, treeSha: record.treeSha, node: process.version, npm: npmVersion, modulesAbi: process.versions.modules,
            platform: process.platform, architecture: process.arch, commands: {
                install: ['npm', 'ci', '--include=dev', '--strict-peer-deps'], build: ['npm', 'run', 'build', '--', '--configuration', 'production'],
                nativeProbe: ['node', '-e', "require('bcrypt'); require('sharp')"],
            }, entries };
        const bytes = Buffer.from(JSON.stringify(manifest));
        if (bytes.length > MAX_MANIFEST) throw fail('PREPARATION_MANIFEST_LIMIT');
        await writeExclusive(`${destination}/manifest.json`, bytes);
        await writeExclusive(`${destination}/PREPARED_INACTIVE.json`, JSON.stringify({ version: 1, preparationId, manifestSha256: digest(bytes) }));
        completed = true;
        return { destination, release, manifest };
    } catch (error) {
        try { await writeExclusive(`${destination}/FAILED.json`, JSON.stringify({ version: 1, preparationId, code: error.code || 'PREPARATION_FAILED' })); }
        catch { /* the original failure remains authoritative */ }
        throw error;
    } finally {
        if (completed || await fs.lstat(`${destination}/FAILED.json`).then(() => true, () => false)) await releaseLock();
    }
}

export async function verifyPreparedRelease({ workspace, preparationId }) {
    await requireExportWorkspace(workspace);
    if (!UUID.test(preparationId)) throw fail('PREPARATION_ARGUMENT_INVALID');
    try { await fs.lstat(`${workspace}/PREPARE.lock`); throw fail('PREPARATION_UNCONFIRMED'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const destination = `${workspace}/preparations/${preparationId}`, release = `${destination}/release`;
    await privateDirectory(destination); await privateDirectory(release);
    const bytes = await fs.readFile(`${destination}/manifest.json`), manifest = JSON.parse(bytes);
    const seal = JSON.parse(await fs.readFile(`${destination}/PREPARED_INACTIVE.json`, 'utf8'));
    if (manifest.format !== FORMAT || manifest.status !== 'PREPARED_INACTIVE' || manifest.preparationId !== preparationId
        || seal.preparationId !== preparationId || seal.manifestSha256 !== digest(bytes)) throw fail('PREPARATION_RECORD_INVALID');
    const source = manifest.sourceType === 'package'
        ? await verifyPackage({ workspace, packageId: manifest.packageId })
        : await verifyExport({ workspace, exportId: manifest.exportId });
    if (manifest.commitSha !== source.commitSha || manifest.treeSha !== source.treeSha || manifest.node !== 'v20.19.6'
        || manifest.sourceType === 'package' && (manifest.packageSha256 !== source.packageSha256 || manifest.releaseVersion !== source.releaseVersion)
        || manifest.modulesAbi !== process.versions.modules || manifest.platform !== 'linux' || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(manifest.npm)) throw fail('PREPARATION_RECORD_INVALID');
    await requireEssential(release);
    if (JSON.stringify(await inventory(release)) !== JSON.stringify(manifest.entries)) throw fail('PREPARATION_INTEGRITY_FAILED');
    return manifest;
}

export async function publishPersistentPreparation({ workspace, preparationId, paths }) {
    requirePersistentPaths(paths);
    const manifest = await verifyPreparedRelease({ workspace, preparationId });
    if (!validatePreparedManifest(manifest)) throw fail('PERSISTENT_PREPARATION_MANIFEST_INVALID');
    const source = `${workspace}/preparations/${preparationId}/release`, target = preparationPaths(paths, preparationId);
    await persistentDirectory(paths.admin);
    try { await fs.mkdir(paths.preparations, { mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    await persistentDirectory(paths.preparations);
    await fs.mkdir(target.root, { mode: 0o700 });
    const identity = await persistentDirectory(target.root); let complete = false;
    try {
        await fs.mkdir(target.release, { mode: 0o700 });
        await copyPreparedTree(`${source}/backend`, target.backend);
        await copyPreparedTree(`${source}/frontend`, target.frontend);
        if (JSON.stringify(await inventory(target.release)) !== JSON.stringify(manifest.entries)) throw fail('PERSISTENT_PREPARATION_INTEGRITY_FAILED');
        const bytes = Buffer.from(JSON.stringify(manifest));
        await writeExclusive(target.manifest, bytes); await syncDirectory(target.root);
        const seal = { version: 1, preparationId, manifestSha256: digest(bytes) };
        if (!validatePreparedSeal(seal)) throw fail('PERSISTENT_PREPARATION_SEAL_INVALID');
        await writeExclusive(target.seal, JSON.stringify(seal)); await syncDirectory(target.root); await syncDirectory(paths.preparations);
        await verifyPersistentPreparation({ paths, preparationId }); complete = true;
        return { preparationId, root: target.root, manifest };
    } catch (error) {
        if (!complete) try {
            const current = await persistentDirectory(target.root);
            if (current.dev !== identity.dev || current.ino !== identity.ino) throw fail('PERSISTENT_PREPARATION_CLEANUP_UNSAFE');
            await fs.rm(target.root, { recursive: true, force: false }); await syncDirectory(paths.preparations);
        } catch (cleanupError) { error.cleanupCode = cleanupError.code || 'PERSISTENT_PREPARATION_CLEANUP_UNSAFE'; }
        throw error;
    }
}

export async function verifyPersistentPreparation({ paths, preparationId }) {
    if (!UUID.test(preparationId)) throw fail('PREPARATION_ARGUMENT_INVALID');
    requirePersistentPaths(paths);
    const target = preparationPaths(paths, preparationId);
    await persistentDirectory(paths.admin); await persistentDirectory(paths.preparations); await persistentDirectory(target.root); await persistentDirectory(target.release);
    if ((await fs.readdir(target.root)).sort().join('|') !== 'PREPARED_INACTIVE.json|manifest.json|release') throw fail('PERSISTENT_PREPARATION_INCOMPLETE');
    if ((await fs.readdir(target.release)).sort().join('|') !== 'backend|frontend') throw fail('PERSISTENT_PREPARATION_INCOMPLETE');
    const bytes = await readPrivate(target.manifest), sealBytes = await readPrivate(target.seal, 4096);
    let manifest, seal;
    try { manifest = JSON.parse(bytes); seal = JSON.parse(sealBytes); } catch { throw fail('PERSISTENT_PREPARATION_METADATA_INVALID'); }
    if (!validatePreparedManifest(manifest) || manifest.preparationId !== preparationId || !validatePreparedSeal(seal)
        || seal.preparationId !== preparationId || seal.manifestSha256 !== digest(bytes)) throw fail('PERSISTENT_PREPARATION_METADATA_INVALID');
    if (JSON.stringify(await inventory(target.release)) !== JSON.stringify(manifest.entries)) throw fail('PERSISTENT_PREPARATION_INTEGRITY_FAILED');
    return manifest;
}

export async function materializePersistentPreparation({ paths, preparationId }) {
    requirePersistentPaths(paths);
    const manifest = await verifyPersistentPreparation({ paths, preparationId });
    const source = preparationPaths(paths, preparationId), target = releasePaths(paths, preparationId);
    await persistentDirectory(paths.releases);
    try { await fs.mkdir(target.root, { mode: 0o700 }); }
    catch (error) { if (error.code === 'EEXIST') throw fail('PERSISTENT_RELEASE_EXISTS'); throw error; }
    const identity = await persistentDirectory(target.root), cleanupToken = randomUUID(), cleanupMarker = `${target.root}/.MATERIALIZING`;
    let complete = false;
    try {
        await writeExclusive(cleanupMarker, cleanupToken);
        await copyPreparedTree(source.backend, target.backend);
        await copyPreparedTree(source.frontend, target.frontend);
        if (JSON.stringify(await inventory(target.root, new Set(['.MATERIALIZING']))) !== JSON.stringify(manifest.entries))
            throw fail('PREPARED_CONTENT_INTEGRITY_FAILED');
        await verifyPersistentPreparation({ paths, preparationId });
        await syncDirectory(target.root); await fs.unlink(cleanupMarker); complete = true;
        await syncDirectory(target.root); await syncDirectory(paths.releases);
        await verifyMaterializedPreparation({ paths, preparationId });
        return { preparationId, release: target, manifest };
    } catch (error) {
        if (!complete) try {
            const current = await persistentDirectory(target.root);
            const marker = await readPrivate(cleanupMarker, 4096).catch(() => null);
            if (current.dev !== identity.dev || current.ino !== identity.ino || marker?.toString() !== cleanupToken) throw fail('PERSISTENT_RELEASE_CLEANUP_UNSAFE');
            await fs.rm(target.root, { recursive: true, force: false }); await syncDirectory(paths.releases);
        } catch (cleanupError) { error.cleanupCode = cleanupError.code || 'PERSISTENT_RELEASE_CLEANUP_UNSAFE'; }
        throw error;
    }
}

export async function verifyMaterializedPreparation({ paths, preparationId }) {
    requirePersistentPaths(paths);
    const manifest = await verifyPersistentPreparation({ paths, preparationId }), target = releasePaths(paths, preparationId);
    await persistentDirectory(paths.releases); await persistentDirectory(target.root);
    if ((await fs.readdir(target.root)).sort().join('|') !== 'backend|frontend') throw fail('MATERIALIZED_PREPARATION_INCOMPLETE');
    await verifyPreparedContent({ release: target.root, manifest });
    await verifyPersistentPreparation({ paths, preparationId });
    return { preparationId, release: target, manifest };
}
