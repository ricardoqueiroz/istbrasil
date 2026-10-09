// Final orchestrator. CLI uses fixed production paths and requires an external approval marker.
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createExportWorkspace, exportCommit } from './git-export.mjs';
import { prepareRelease } from './release-prepare.mjs';
import { activatePreparedRelease, rollbackRelease, createPm2Adapter } from './production-operation.mjs';
import { canonicalPaths, validId, validSha } from './production-contract.mjs';

const execute = promisify(execFile);
const APPROVAL = 'IST_DEPLOY_PRODUCTION_APPROVED_V1\n';
const fail = code => Object.assign(new Error(code), { code });

async function requireApproval(paths) {
    try {
        const filename = `${paths.state}/PRODUCTION_APPROVED`, stat = await fs.lstat(filename);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o7777) !== 0o600
            || await fs.readFile(filename, 'utf8') !== APPROVAL) throw fail('PRODUCTION_APPROVAL_MISSING');
    } catch (error) {
        if (error.code === 'PRODUCTION_APPROVAL_MISSING') throw error;
        throw fail('PRODUCTION_APPROVAL_MISSING');
    }
}

async function cloneLocalGit(repo, workspace, targetSha) {
    const destination = `${workspace}/repository/.git`;
    const env = { PATH: '/usr/bin:/bin', HOME: workspace, LANG: 'C', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'file' };
    try {
        const sourceTarget = (await execute('git', ['-C', repo, 'rev-parse', '--verify', 'refs/remotes/origin/main'], { env, encoding: 'utf8' })).stdout.trim();
        if (sourceTarget !== targetSha) throw fail('TARGET_REFERENCE_CHANGED');
        await execute('git', ['clone', '--mirror', '--no-hardlinks', '--', repo, destination], { env, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
        await execute('git', [`--git-dir=${destination}`, 'update-ref', 'refs/heads/main', targetSha], { env, encoding: 'utf8' });
    }
    catch (error) { throw Object.assign(fail('LOCAL_GIT_CLONE_FAILED'), { cause: error }); }
}

export async function prepareAndActivate({ base, repo, targetSha, adapter = createPm2Adapter(), allowRegistry = true,
    createWorkspace = createExportWorkspace, cloneRepository = cloneLocalGit, exporter = exportCommit,
    preparer = prepareRelease, activator = activatePreparedRelease }) {
    if (!validSha(targetSha) || path.resolve(repo) !== repo) throw fail('DEPLOY_ARGUMENT_INVALID');
    const paths = canonicalPaths(base); await requireApproval(paths);
    const workspace = await createWorkspace(); let completed = false;
    try {
        await cloneRepository(repo, workspace, targetSha);
        const exported = await exporter({ workspace, commitSha: targetSha, approvedMainSha: targetSha });
        const prepared = await preparer({ workspace, exportId: exported.record.exportId, allowRegistry });
        const result = await activator({ base, workspace, preparationId: prepared.manifest.preparationId, adapter });
        completed = true; return result;
    } catch (error) {
        try { Object.defineProperty(error, 'workspace', { value: workspace }); } catch { /* original error wins */ }
        throw error;
    } finally {
        if (completed) await fs.rm(workspace, { recursive: true, force: true });
    }
}

export async function executeRollback({ base, backupId, adapter = createPm2Adapter(), rollback = rollbackRelease }) {
    if (!validId(backupId)) throw fail('ROLLBACK_ARGUMENT_INVALID');
    const paths = canonicalPaths(base); await requireApproval(paths);
    return rollback({ base, backupId, adapter });
}

async function cli() {
    const [mode, value] = process.argv.slice(2), base = '/var/www/istbrasil.org.br', paths = canonicalPaths(base);
    let result;
    if (mode === 'deploy' && validSha(value) && process.argv.length === 4) result = await prepareAndActivate({ base, repo: paths.repo, targetSha: value });
    else if (mode === 'rollback' && validId(value) && process.argv.length === 4) result = await executeRollback({ base, backupId: value });
    else throw fail('USAGE_INVALID');
    process.stdout.write(JSON.stringify({ status: 'SUCCESS', operation: mode, transactionId: result.transactionId, backupId: result.backupId,
        releaseId: result.active.backend.releaseId, generation: result.active.generation }) + '\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    cli().catch(error => {
        const manual = error.rollbackError || error.code === 'OPERATION_LOCK_EXISTS';
        process.stderr.write(JSON.stringify({ status: 'FAILED', code: error.code || 'DEPLOYMENT_FAILED', manualRecoveryRequired: !!manual,
            workspaceRetained: typeof error.workspace === 'string' }) + '\n');
        process.exitCode = manual ? 3 : 2;
    });
}
