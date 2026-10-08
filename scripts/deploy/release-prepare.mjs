// Phase 2.2-B/C/D: build a sealed, inactive release inside an isolated export workspace.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { requireExportWorkspace, verifyExport, safeGitPath } from './git-export.mjs';

const execFileAsync = promisify(execFile);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const FORMAT = 'ist-prepared-inactive-v1';
const MAX_FILES = 500000;
const MAX_MANIFEST = 128 * 1024 * 1024;
const digest = value => createHash('sha256').update(value).digest('hex');
const fail = code => Object.assign(new Error(code), { code });

async function privateDirectory(filename) {
    const stat = await fs.lstat(filename);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.mode & 0o022) throw fail('PREPARATION_WORKSPACE_UNSAFE');
}

async function writeExclusive(filename, value) {
    const handle = await fs.open(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(value); await handle.sync(); } finally { await handle.close(); }
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

async function inventory(root) {
    const entries = []; let count = 0;
    const visit = async (directory, relative = '') => {
        await privateDirectory(directory);
        for (const name of (await fs.readdir(directory)).sort()) {
            const current = relative ? `${relative}/${name}` : name;
            safeGitPath(current);
            const filename = `${root}/${current}`, stat = await fs.lstat(filename);
            if (++count > MAX_FILES) throw fail('PREPARATION_FILE_LIMIT');
            if (stat.isDirectory() && !stat.isSymbolicLink()) { entries.push({ path: current, type: 'directory', mode: stat.mode & 0o777 }); await visit(filename, current); }
            else if (stat.isFile() && !stat.isSymbolicLink()) {
                const bytes = await fs.readFile(filename);
                entries.push({ path: current, type: 'file', mode: stat.mode & 0o777, size: bytes.length, sha256: digest(bytes) });
            } else if (stat.isSymbolicLink()) {
                const target = await fs.readlink(filename), resolved = path.resolve(path.dirname(filename), target);
                if (path.relative(root, resolved).startsWith('..') || path.isAbsolute(target)) throw fail('PREPARATION_LINK_UNSAFE');
                entries.push({ path: current, type: 'symlink', target });
            } else throw fail('PREPARATION_TYPE_UNSAFE');
        }
    };
    await visit(root);
    return entries;
}

async function requireEssential(release) {
    for (const relative of ['backend/server.js', 'backend/package.json', 'backend/package-lock.json', 'backend/node_modules/bcrypt/package.json', 'backend/node_modules/sharp/package.json', 'frontend/index.html']) {
        const stat = await fs.lstat(`${release}/${relative}`).catch(() => null);
        if (!stat?.isFile()) throw fail('PREPARED_RELEASE_INCOMPLETE');
    }
}

export async function prepareRelease({ workspace, exportId, allowRegistry = false, runner = defaultRunner }) {
    await requireExportWorkspace(workspace);
    if (!UUID.test(exportId) || typeof runner !== 'function') throw fail('PREPARATION_ARGUMENT_INVALID');
    if (process.version !== 'v20.19.6') throw fail('NODE_VERSION_UNSUPPORTED');
    const record = await verifyExport({ workspace, exportId });
    const releaseLock = await acquireLock(workspace);
    const preparationId = randomUUID(), root = `${workspace}/preparations`, destination = `${root}/${preparationId}`;
    let completed = false;
    try {
        await fs.mkdir(root, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
        await privateDirectory(root);
        await fs.mkdir(destination, { mode: 0o700 });
        const release = `${destination}/release`, backend = `${release}/backend`;
        await fs.mkdir(release, { mode: 0o700 });
        await copyExport(record, `${workspace}/exports/${exportId}/source`, backend);
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
        const manifest = { version: 1, format: FORMAT, status: 'PREPARED_INACTIVE', preparationId, exportId,
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
    const source = await verifyExport({ workspace, exportId: manifest.exportId });
    if (manifest.commitSha !== source.commitSha || manifest.treeSha !== source.treeSha || manifest.node !== 'v20.19.6'
        || manifest.modulesAbi !== process.versions.modules || manifest.platform !== 'linux' || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(manifest.npm)) throw fail('PREPARATION_RECORD_INVALID');
    await requireEssential(release);
    if (JSON.stringify(await inventory(release)) !== JSON.stringify(manifest.entries)) throw fail('PREPARATION_INTEGRITY_FAILED');
    return manifest;
}
