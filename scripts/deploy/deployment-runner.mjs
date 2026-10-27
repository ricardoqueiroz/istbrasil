// Final orchestrator. CLI uses fixed production paths and requires an external approval marker.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createExportWorkspace, exportCommit, requireExportWorkspace } from './git-export.mjs';
import { importPackage } from './package-import.mjs';
import { prepareRelease, verifyPreparedRelease, publishPersistentPreparation, verifyPersistentPreparation } from './release-prepare.mjs';
import { activatePreparedRelease, activatePersistentRelease, rollbackRelease, createPm2Adapter } from './production-operation.mjs';
import { canonicalPaths, validId, validSha } from './production-contract.mjs';

const execute = promisify(execFile);
const APPROVAL = 'IST_DEPLOY_PRODUCTION_APPROVED_V1\n';
const SHA256 = /^[a-f0-9]{64}$/;
const fail = code => Object.assign(new Error(code), { code });
const digest = value => createHash('sha256').update(value).digest('hex');

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

async function removePreparationWorkspace(workspace) {
    await requireExportWorkspace(workspace);
    await fs.rm(workspace, { recursive: true, force: false });
}

export async function prepareDeployment({ base, repo, targetSha, packagePath, expectedSha256, allowRegistry = true,
    createWorkspace = createExportWorkspace, cloneRepository = cloneLocalGit, exporter = exportCommit, importer = importPackage,
    preparer = prepareRelease, verifyPrepared = verifyPreparedRelease, publishPrepared = publishPersistentPreparation,
    verifyPersistent = verifyPersistentPreparation, cleanupWorkspace = removePreparationWorkspace }) {
    const gitSelected = repo !== undefined || targetSha !== undefined;
    const packageSelected = packagePath !== undefined || expectedSha256 !== undefined;
    const validGit = typeof repo === 'string' && path.isAbsolute(repo) && validSha(targetSha);
    const validPackage = typeof packagePath === 'string' && path.isAbsolute(packagePath) && SHA256.test(expectedSha256 || '');
    if (gitSelected === packageSelected || gitSelected && !validGit || packageSelected && !validPackage) throw fail('PREPARATION_ARGUMENT_INVALID');

    const paths = canonicalPaths(base);
    let workspace, result, originalError;
    try {
        workspace = await createWorkspace();
        let prepared;
        if (gitSelected) {
            await cloneRepository(repo, workspace, targetSha);
            const exported = await exporter({ workspace, commitSha: targetSha, approvedMainSha: targetSha });
            prepared = await preparer({ workspace, exportId: exported.record.exportId, allowRegistry });
        } else {
            const imported = await importer({ workspace, packagePath, expectedSha256 });
            prepared = await preparer({ workspace, packageId: imported.record.packageId, allowRegistry });
        }
        await verifyPrepared({ workspace, preparationId: prepared.manifest.preparationId });
        await publishPrepared({ workspace, preparationId: prepared.manifest.preparationId, paths });
        const manifest = await verifyPersistent({ paths, preparationId: prepared.manifest.preparationId });
        const source = manifest.sourceType === 'package'
            ? { type: 'package', packageId: manifest.packageId, packageSha256: manifest.packageSha256, releaseVersion: manifest.releaseVersion,
                declaredCommitSha: manifest.commitSha, declaredTreeSha: manifest.treeSha }
            : { type: 'git', exportId: manifest.exportId, commitSha: manifest.commitSha, treeSha: manifest.treeSha };
        result = { preparationId: manifest.preparationId, source,
            integrity: { manifestSha256: digest(JSON.stringify(manifest)), entries: manifest.entries.length } };
    } catch (error) {
        originalError = error;
    } finally {
        if (workspace !== undefined) try { await cleanupWorkspace(workspace); }
        catch (cleanupError) {
            if (originalError) originalError.cleanupCode = cleanupError.code || 'WORKSPACE_CLEANUP_FAILED';
            else originalError = Object.assign(fail('WORKSPACE_CLEANUP_FAILED'), { cause: cleanupError });
        }
    }
    if (originalError) throw originalError;
    return result;
}

export async function activateDeployment({ base, preparationId, adapter = createPm2Adapter({ base }),
    verifyPersistent = verifyPersistentPreparation, activator = activatePersistentRelease }) {
    if (!validId(preparationId)) throw fail('ACTIVATION_ARGUMENT_INVALID');
    const paths = canonicalPaths(base); await requireApproval(paths);
    await verifyPersistent({ paths, preparationId });
    return activator({ base, preparationId, adapter });
}

export async function prepareAndActivate({ base, repo, targetSha, adapter = createPm2Adapter({base}), allowRegistry = true,
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

export async function executeRollback({ base, backupId, adapter = createPm2Adapter({base}), rollback = rollbackRelease }) {
    if (!validId(backupId)) throw fail('ROLLBACK_ARGUMENT_INVALID');
    const paths = canonicalPaths(base); await requireApproval(paths);
    return rollback({ base, backupId, adapter });
}

export async function dispatchCli(args, { base = '/var/www/istbrasil.org.br', prepare = prepareDeployment,
    activate = activateDeployment, deploy = prepareAndActivate, rollback = executeRollback } = {}) {
    const [mode, ...values] = args, paths = canonicalPaths(base);
    let result;
    if (mode === 'prepare-git' && values.length === 1 && validSha(values[0])) {
        result = await prepare({ base, repo: paths.repo, targetSha: values[0] });
        return { status: 'SUCCESS', operation: 'prepare', preparationId: result.preparationId, source: result.source, integrity: result.integrity };
    } else if (mode === 'prepare-package' && values.length === 2 && path.isAbsolute(values[0]) && SHA256.test(values[1])) {
        result = await prepare({ base, packagePath: values[0], expectedSha256: values[1] });
        return { status: 'SUCCESS', operation: 'prepare', preparationId: result.preparationId, source: result.source, integrity: result.integrity };
    } else if (mode === 'activate' && values.length === 1 && validId(values[0])) result = await activate({ base, preparationId: values[0] });
    else if (mode === 'deploy' && values.length === 1 && validSha(values[0])) result = await deploy({ base, repo: paths.repo, targetSha: values[0] });
    else if (mode === 'rollback' && values.length === 1 && validId(values[0])) result = await rollback({ base, backupId: values[0] });
    else throw fail('USAGE_INVALID');
    return { status: 'SUCCESS', operation: mode, transactionId: result.transactionId, backupId: result.backupId,
        releaseId: result.active.backend.releaseId, generation: result.active.generation };
}

async function cli() {
    process.stdout.write(JSON.stringify(await dispatchCli(process.argv.slice(2))) + '\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    cli().catch(error => {
        const manual = error.rollbackError || error.code === 'OPERATION_LOCK_EXISTS';
        process.stderr.write(JSON.stringify({ status: 'FAILED', code: error.code || 'DEPLOYMENT_FAILED', manualRecoveryRequired: !!manual,
            workspaceRetained: typeof error.workspace === 'string' }) + '\n');
        process.exitCode = manual ? 3 : 2;
    });
}
