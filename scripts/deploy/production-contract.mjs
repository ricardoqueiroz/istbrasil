// Phase 2.1: data contracts and read-only decisions. No operational authorization.
import path from 'node:path';
import { createHash } from 'node:crypto';
import {BASE_IMPLANTACAO_IST,PHPMYADMIN_PUBLICO_IST,limitesArmazenamentoImplantacao} from '../../src/config/lojaImplantacao.js';

export const VERSION = 1;
export const RESERVE_BYTES = 10n * 1024n ** 3n;
export const STATES = Object.freeze(['UNINITIALIZED', 'CONSISTENT', 'IN_PROGRESS', 'RECOVERY_REQUIRED', 'UNKNOWN_PROCESS', 'INCONCLUSIVE', 'INVALID']);
export const sha256 = data => createHash('sha256').update(data).digest('hex');
export const validSha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
export const validDigest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const validId = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const date = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, required) => object(value) && Object.keys(value).sort().join('|') === [...required].sort().join('|');
const within = (parent, child) => child.startsWith(`${parent}/`);

export function canonicalPaths(base = BASE_IMPLANTACAO_IST) {
    if (typeof base !== 'string' || !base.startsWith('/') || base.endsWith('/') || path.posix.normalize(base) !== base || /[\0\\\r\n]/.test(base)) throw new Error('INVALID_BASE');
    const repo = `${base}/backend-node/istbrasil`;
    const admin = `${base}/.deploy`;
    const limites=limitesArmazenamentoImplantacao(base);
    return Object.freeze({ base, repo, html: limites.raizesPublicas[0], uploads: `${base}/uploads`, backendPhp: limites.raizesPublicas[1],
        private: `${repo}/istbrasil.private`, env: `${repo}/.env`, envBackup: `${repo}/.env.backup`, envOld: `${repo}/.env_old`,
        admin, releases: `${admin}/releases`, preparations: `${admin}/preparations`, backups: `${admin}/backups`, state: `${admin}/state`,
        active: `${admin}/state/active.json`, transactions: `${admin}/state/transactions`,
        lock: `${admin}/state/operation.lock`, flock: `${base}/.deploy.lock`, logs: `${admin}/logs`,
        pm2Home: '/home/admin/.pm2', phpMyAdmin: PHPMYADMIN_PUBLICO_IST });
}
export const PATHS = canonicalPaths();

export function releasePaths(paths, id) {
    if (!validId(id)) throw new Error('INVALID_RELEASE_ID');
    const root = `${paths.releases}/${id}`;
    return Object.freeze({ root, backend: `${root}/backend`, frontend: `${root}/frontend`, manifest: `${root}/manifest.json` });
}

export function preparationPaths(paths, id) {
    if (!validId(id)) throw new Error('INVALID_PREPARATION_ID');
    const root = `${paths.preparations}/${id}`;
    return Object.freeze({ root, release: `${root}/release`, backend: `${root}/release/backend`, frontend: `${root}/release/frontend`,
        manifest: `${root}/manifest.json`, seal: `${root}/PREPARED_INACTIVE.json` });
}

export function validatePreparedManifest(value) {
    const common = ['version', 'format', 'status', 'preparationId', 'commitSha', 'treeSha', 'node', 'npm', 'modulesAbi', 'platform', 'architecture', 'commands', 'entries'];
    const git = [...common, 'exportId'], packaged = [...common, 'sourceType', 'packageId', 'packageSha256', 'releaseVersion'];
    const packageSource = value?.sourceType === 'package';
    if (!keys(value, packageSource ? packaged : git) || value.version !== 1 || value.format !== 'ist-prepared-inactive-v1'
        || value.status !== 'PREPARED_INACTIVE' || !validId(value.preparationId) || !validSha(value.commitSha) || !validSha(value.treeSha)
        || value.node !== 'v20.19.6' || value.platform !== 'linux' || !['x64', 'arm64'].includes(value.architecture)
        || typeof value.modulesAbi !== 'string' || !/^\d+$/.test(value.modulesAbi) || typeof value.npm !== 'string'
        || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value.npm)) return false;
    if (packageSource ? !validId(value.packageId) || !validDigest(value.packageSha256) || typeof value.releaseVersion !== 'string'
        || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value.releaseVersion) : !validId(value.exportId)) return false;
    if (!keys(value.commands, ['install', 'build', 'nativeProbe'])
        || JSON.stringify(value.commands.install) !== JSON.stringify(['npm', 'ci', '--include=dev', '--strict-peer-deps'])
        || JSON.stringify(value.commands.build) !== JSON.stringify(['npm', 'run', 'build', '--', '--configuration', 'production'])
        || JSON.stringify(value.commands.nativeProbe) !== JSON.stringify(['node', '-e', "require('bcrypt'); require('sharp')"])) return false;
    if (!Array.isArray(value.entries) || value.entries.length === 0 || value.entries.length > 500000) return false;
    const seen = new Map();
    for (const entry of value.entries) {
        const fields = entry?.type === 'file' ? ['path', 'type', 'mode', 'size', 'sha256'] : entry?.type === 'directory' ? ['path', 'type', 'mode'] : ['path', 'type', 'target'];
        if (!keys(entry, fields) || !['file', 'directory', 'symlink'].includes(entry.type) || !relativeEntry(entry.path) || seen.has(entry.path)) return false;
        if (entry.type !== 'symlink' && (!integer(entry.mode) || entry.mode > 0o777 || entry.mode & 0o022)) return false;
        if (entry.type === 'file' && (!integer(entry.size) || !validDigest(entry.sha256))) return false;
        if (entry.type === 'symlink' && (typeof entry.target !== 'string' || !entry.target || path.posix.isAbsolute(entry.target) || /[\0\\\r\n]/.test(entry.target))) return false;
        if (protectedEntry(entry.path)) return false;
        seen.set(entry.path, entry);
    }
    for (const entry of seen.values()) {
        const parent = path.posix.dirname(entry.path);
        if (parent !== '.' && seen.get(parent)?.type !== 'directory') return false;
    }
    return ['backend', 'frontend'].every(name => seen.get(name)?.type === 'directory')
        && ['backend/server.js', 'backend/package.json', 'backend/package-lock.json', 'frontend/index.html'].every(name => seen.get(name)?.type === 'file');
}

export function validatePreparedSeal(value) {
    return keys(value, ['version', 'preparationId', 'manifestSha256']) && value.version === 1
        && validId(value.preparationId) && validDigest(value.manifestSha256);
}

export function relativeEntry(value) {
    return typeof value === 'string' && value.length <= 4096 && !/[\0\\:\r\n]/.test(value)
        && value.split('/').every(part => part && part !== '.' && part !== '..')
        && /^(backend|frontend)(\/|$)/.test(value);
}

export function approvedLink(paths, release, relative, target) {
    if (relative === 'backend/.env') return target === paths.env;
    if (relative === 'backend/istbrasil.private') return target === paths.private;
    // Package-manager links are separate from runtime bindings: internal, relative,
    // non-dangling node_modules links only; the inspector also checks realpath.
    if (!relative.startsWith('backend/node_modules/') || typeof target !== 'string' || !target || /[\0\\\r\n]/.test(target) || path.posix.isAbsolute(target)) return false;
    const modules = `${release.backend}/node_modules`;
    const resolved = path.posix.resolve(path.posix.dirname(`${release.root}/${relative}`), target);
    return within(modules, resolved);
}

export function protectedEntry(relative) {
    if (typeof relative !== 'string') return true;
    return relative.split('/').some(part => /^\.env/.test(part) || ['.git', '.npmrc', '.ssh', '.aws', '.pm2', 'istbrasil.private', 'uploads', 'backend-php', 'istdbadmin', 'database'].includes(part)
        || /\.(pem|key|p12|pfx|session\.sql)$/i.test(part));
}

// Extended/default ACLs are never accepted. Missing ACL information is not safe.
export function parseAcl(text) {
    if (typeof text !== 'string') return 'unknown';
    const lines = text.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
    if (lines.length !== 3 || !['user::', 'group::', 'other::'].every(prefix => lines.filter(line => line.startsWith(prefix)).length === 1)
        || lines.some(line => !/^(user|group|other)::[r-][w-][x-]$/.test(line))) return 'extended';
    return 'basic';
}

export function checkMetadata(meta, policy, identity) {
    if (!meta) return 'unknown';
    if (meta.type !== policy.type || meta.nlink > 1 && meta.type === 'file') return 'unsafe';
    if (!integer(meta.mode) || meta.mode & 0o7000) return 'unsafe';
    if (policy.private && (meta.uid !== identity.uid || meta.gid !== identity.gid)) return 'unsafe';
    if (policy.modes && !policy.modes.includes(meta.mode)) return 'unsafe';
    if (policy.config && meta.mode === 0o640 && identity.exclusiveGroup !== true) return identity.exclusiveGroup === false ? 'unsafe' : 'unknown';
    if (policy.trusted && (![0, identity.uid].includes(meta.uid) || meta.mode & 0o022)) return 'unsafe';
    if (meta.acl === 'extended') return 'unsafe';
    if (meta.acl !== 'basic') return 'unknown';
    return 'safe';
}

export function validateActive(value, paths = PATHS) {
    const fields = ['version', 'generation', 'transactionId', 'previousGeneration', 'confirmedAt', 'backend', 'frontend', 'pm2'];
    if (!keys(value, fields) || value.version !== VERSION || !integer(value.generation) || value.generation < 1 || !validId(value.transactionId) || !date(value.confirmedAt)
        || !(value.previousGeneration === null && value.generation === 1 || integer(value.previousGeneration) && value.previousGeneration === value.generation - 1)) return false;
    if (!keys(value.backend, ['kind', 'releaseId', 'commitSha', 'manifestSha256']) || value.backend.kind !== 'release' || !validId(value.backend.releaseId) || !validSha(value.backend.commitSha) || !validDigest(value.backend.manifestSha256)) return false;
    if (!keys(value.frontend, ['releaseId', 'manifestSha256', 'indexSha256']) || !validId(value.frontend.releaseId) || !validDigest(value.frontend.manifestSha256) || !validDigest(value.frontend.indexSha256)) return false;
    const backend = releasePaths(paths, value.backend.releaseId).backend;
    return keys(value.pm2, ['name', 'user', 'home', 'cwd', 'script', 'node']) && value.pm2.name === 'ist-api' && value.pm2.user === 'admin'
        && value.pm2.home === paths.pm2Home && value.pm2.cwd === backend && value.pm2.script === `${backend}/server.js` && value.pm2.node === '20.19.6';
}

export function validateManifest(value, paths = PATHS) {
    if (!keys(value, ['version', 'releaseId', 'declaredCommitSha', 'gitProvenance', 'runtime', 'entries']) || value.version !== VERSION || !validId(value.releaseId) || !validSha(value.declaredCommitSha)) return false;
    // A stored provenance claim is not an independently verified Git attestation.
    if (value.gitProvenance !== null && (!keys(value.gitProvenance, ['commitSha', 'treeSha', 'verifiedAt']) || value.gitProvenance.commitSha !== value.declaredCommitSha || !validSha(value.gitProvenance.treeSha) || !date(value.gitProvenance.verifiedAt))) return false;
    if (!keys(value.runtime, ['platform', 'arch', 'node', 'abi']) || value.runtime.platform !== 'linux' || !['x64', 'arm64'].includes(value.runtime.arch) || value.runtime.node !== '20.19.6' || typeof value.runtime.abi !== 'string' || !/^\d+$/.test(value.runtime.abi)) return false;
    if (!Array.isArray(value.entries) || value.entries.length === 0 || value.entries.length > 250000) return false;
    const seen = new Map();
    const release = releasePaths(paths, value.releaseId);
    for (const entry of value.entries) {
        const fields = entry?.type === 'file' ? ['path', 'type', 'mode', 'uid', 'gid', 'size', 'sha256'] : entry?.type === 'directory' ? ['path', 'type', 'mode', 'uid', 'gid'] : ['path', 'type', 'mode', 'uid', 'gid', 'target'];
        if (!keys(entry, fields) || !['file', 'directory', 'symlink'].includes(entry.type) || !relativeEntry(entry.path) || seen.has(entry.path) || !integer(entry.mode) || entry.mode > 0o777 || entry.type !== 'symlink' && entry.mode & 0o022 || !integer(entry.uid) || !integer(entry.gid)) return false;
        if (entry.type === 'file' && (!integer(entry.size) || !validDigest(entry.sha256))) return false;
        const binding = ['backend/.env', 'backend/istbrasil.private'].includes(entry.path);
        if (protectedEntry(entry.path) && !(binding && entry.type === 'symlink')) return false;
        if (entry.type === 'symlink' && !approvedLink(paths, release, entry.path, entry.target)) return false;
        seen.set(entry.path, entry);
    }
    for (const entry of seen.values()) {
        const parent = path.posix.dirname(entry.path);
        if (parent !== '.' && seen.get(parent)?.type !== 'directory') return false;
    }
    return ['backend', 'frontend'].every(name => seen.get(name)?.type === 'directory')
        && ['backend/server.js', 'backend/package.json', 'backend/package-lock.json', 'frontend/index.html'].every(name => seen.get(name)?.type === 'file')
        && ['backend/.env', 'backend/istbrasil.private'].every(name => seen.get(name)?.type === 'symlink');
}

// Proposed production archive schema; separate from Phase 1's isolated format.
// This validator neither creates archives nor changes the Phase 1 APIs.
export function validateBackupManifest(value, paths = PATHS) {
    if (!keys(value, ['version', 'backupId', 'sourceGeneration', 'declaredCommitSha', 'runtime', 'entries']) || !validId(value.backupId) || !integer(value.sourceGeneration) || !Array.isArray(value.entries) || value.entries.some(entry => protectedEntry(entry?.path))) return false;
    const backend = value.entries?.find(entry => entry.path === 'backend');
    if (!backend) return false;
    const bindings = [['backend/.env', paths.env], ['backend/istbrasil.private', paths.private]].map(([name, target]) => ({ path: name, type: 'symlink', mode: 0o777, uid: backend.uid, gid: backend.gid, target }));
    return validateManifest({ version: value.version, releaseId: value.backupId, declaredCommitSha: value.declaredCommitSha, gitProvenance: null, runtime: value.runtime, entries: [...value.entries, ...bindings] }, paths);
}

export function validateBackupSeal(value) {
    return keys(value, ['version', 'backupId', 'manifestSha256', 'transactionId']) && value.version === VERSION && validId(value.backupId) && validDigest(value.manifestSha256) && validId(value.transactionId);
}

export const PHASES = Object.freeze(['started', 'prepared', 'backend_activated', 'frontend_published', 'health_verified', 'confirmed']);
export function validateJournal(envelope) {
    if (!keys(envelope, ['record', 'sha256']) || !validDigest(envelope.sha256) || sha256(JSON.stringify(envelope.record)) !== envelope.sha256) return false;
    const record = envelope.record;
    if (!keys(record, ['version', 'transactionId', 'operation', 'generation', 'releaseId', 'events']) || record.version !== VERSION || !validId(record.transactionId) || !validId(record.releaseId) || !['deploy', 'rollback'].includes(record.operation) || !integer(record.generation) || record.generation < 1 || !Array.isArray(record.events) || record.events.length === 0 || record.events.length > 7) return false;
    let previous = -1;
    for (let i = 0; i < record.events.length; i++) {
        const event = record.events[i];
        if (!keys(event, ['phase', 'at']) || !date(event.at) || i > 0 && event.at < record.events[i - 1].at) return false;
        if (['failed', 'interrupted'].includes(event.phase)) return i === record.events.length - 1 && previous >= 0 && previous < PHASES.length - 1;
        const phase = PHASES.indexOf(event.phase);
        if (phase !== previous + 1) return false;
        previous = phase;
    }
    return true;
}

export function validateLock(value) {
    return keys(value, ['version', 'transactionId', 'token', 'operation', 'pid', 'startTicks', 'bootId', 'createdAt']) && value.version === VERSION
        && validId(value.transactionId) && validId(value.token) && ['deploy', 'rollback'].includes(value.operation) && integer(value.pid) && value.pid > 0
        && typeof value.startTicks === 'string' && /^\d+$/.test(value.startTicks) && validId(value.bootId) && date(value.createdAt);
}

const amount = value => typeof value === 'string' && /^\d+$/.test(value) ? BigInt(value) : typeof value === 'bigint' && value >= 0n ? value : null;
export function assessCapacity(filesystems, budgets) {
    const result = { status: 'UNKNOWN', reserveBytes: RESERVE_BYTES.toString(), filesystems: [], sufficient: false };
    if (!Array.isArray(filesystems) || !Array.isArray(budgets) || budgets.length === 0) return result;
    const grouped = new Map();
    for (const budget of budgets) {
        if (!keys(budget, ['device', 'candidate', 'backup', 'restore', 'temporary', 'inodes'])) return result;
        const values = ['candidate', 'backup', 'restore', 'temporary', 'inodes'].map(name => amount(budget[name]));
        if (values.includes(null)) return result;
        const existing = grouped.get(budget.device) || { bytes: 0n, inodes: 0n };
        existing.bytes += values.slice(0, 4).reduce((a, b) => a + b, 0n);
        existing.inodes += values[4];
        grouped.set(budget.device, existing);
    }
    for (const [device, costs] of grouped) {
        const fs = filesystems.find(item => item.device === device);
        const available = amount(fs?.availableBytes), inodes = amount(fs?.availableInodes);
        if (available === null || inodes === null) return result;
        const required = costs.bytes + RESERVE_BYTES;
        result.filesystems.push({ device, requiredBytes: required.toString(), availableBytes: available.toString(), requiredInodes: costs.inodes.toString(), availableInodes: inodes.toString(), sufficient: available >= required && inodes >= costs.inodes });
    }
    result.sufficient = result.filesystems.length > 0 && result.filesystems.every(item => item.sufficient);
    result.status = result.sufficient ? 'SUFFICIENT_FOR_DECLARED_PLAN' : 'INSUFFICIENT';
    return result;
}

// Observations are evidence for a diagnostic only, never a mutation capability.
export function classify(observation) {
    const issues = [...new Set(observation.issues || [])].sort();
    let status;
    if (observation.invalid) status = 'INVALID';
    else if (observation.unknownProcess) status = 'UNKNOWN_PROCESS';
    else if (observation.recoveryRequired) status = 'RECOVERY_REQUIRED';
    else if (observation.inconclusive) status = 'INCONCLUSIVE';
    else if (observation.inProgress) status = 'IN_PROGRESS';
    else if (observation.activePresent === false && observation.legacy === true) status = 'UNINITIALIZED';
    else if (observation.activePresent === true && observation.consistent === true) status = 'CONSISTENT';
    else { status = 'INCONCLUSIVE'; issues.push('CONSISTENCY_NOT_PROVEN'); }
    return Object.freeze({ version: VERSION, status, deployAuthorized: false, rollbackAuthorized: false, issues,
        provenance: { declaredSha: observation.declaredSha || null, storedGitClaim: observation.storedGitClaim === true, independentlyVerified: false },
        capacity: observation.capacity || assessCapacity([], []), legacy: observation.legacy === true });
}
