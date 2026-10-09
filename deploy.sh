#!/usr/bin/env bash
# IST Brasil deployment entrypoint. Runtime mutation requires an explicit approval marker.
set -Eeuo pipefail
export LC_ALL=C
export GIT_OPTIONAL_LOCKS=0
BASE=/var/www/istbrasil.org.br
REPO="$BASE/backend-node/istbrasil"
PUBLIC="$BASE/html"
EXPECTED_PM2_HOME=/home/admin/.pm2
STAGE=arguments
log() { printf '[IST deploy] %s\n' "$*"; }
fail() { log "ERROR [$STAGE]: $*" >&2; exit 1; }
trap 'printf "[IST deploy] ERROR [%s]: interrupted; sensitive details omitted.\n" "$STAGE" >&2' ERR
[[ $# -ge 1 && $# -le 2 ]] || fail 'Usage: deploy.sh --check | --deploy | --rollback BACKUP_UUID'
MODE=$1
case "$MODE" in --check|--deploy|--rollback) ;; *) fail 'Unknown operation.' ;; esac
[[ $MODE != --check || $# == 1 ]] || fail '--check does not accept arguments.'
[[ $MODE != --deploy || $# == 1 ]] || fail '--deploy does not accept arguments.'
[[ $MODE != --rollback || $# == 2 ]] || fail 'Rollback unavailable: explicit backup UUID required.'
STAGE=identity
ADMIN_UID=$(id -u)
ADMIN_GID=$(id -g)
[[ $ADMIN_UID != 0 ]] || fail 'Root refused; never use sudo pm2.'
[[ $(id -un) == admin ]] || fail 'Operational user must be admin.'
[[ -z ${PM2_HOME:-} || $PM2_HOME == "$EXPECTED_PM2_HOME" ]] || fail 'Unexpected PM2_HOME.'
STAGE=tools
for tool in git node npm pm2 flock rsync curl ss df realpath stat ps awk grep cut sort getent getfacl; do
    command -v "$tool" >/dev/null 2>&1 || fail "Missing tool: $tool"
done
STAGE=paths
for dir in "$BASE" "$REPO" "$PUBLIC" "$BASE/uploads" "$REPO/istbrasil.private"; do
    [[ -d $dir && ! -L $dir ]] || fail 'Required directory missing or replaced by symlink.'
    [[ $(realpath -e -- "$dir") == "$dir" ]] || fail 'Unexpected canonical path.'
done
[[ -L $PUBLIC/istdbadmin ]] || fail 'istdbadmin must be a symlink.'
[[ $(realpath -e -- "$PUBLIC/istdbadmin") == /usr/share/phpmyadmin ]] || fail 'Unexpected phpMyAdmin target.'
# Only admin's exclusive primary group is accepted, including for mode 600.
GROUP_RECORD=$(getent group "$ADMIN_GID") || fail 'Cannot validate admin primary group.'
[[ $(printf '%s' "$GROUP_RECORD" | awk -F: '{print $3}') == "$ADMIN_GID" ]] || fail 'Invalid primary group record.'
GROUP_MEMBERS=$(printf '%s' "$GROUP_RECORD" | awk -F: '{print $4}')
[[ -z $GROUP_MEMBERS || $GROUP_MEMBERS == admin ]] || fail 'Admin primary group has other explicit members.'
PASSWD_RECORDS=$(getent passwd) || fail 'Cannot inspect primary group membership.'
ADMIN_RECORD=$(printf '%s\n' "$PASSWD_RECORDS" | awk -F: '$1 == "admin" {print $3 ":" $4}')
[[ $ADMIN_RECORD == "$ADMIN_UID:$ADMIN_GID" ]] || fail 'Admin account missing/divergent in NSS enumeration.'
OTHER_MEMBERS=$(printf '%s\n' "$PASSWD_RECORDS" | awk -F: -v gid="$ADMIN_GID" '$4 == gid && $1 != "admin" {print "other"}')
[[ -z $OTHER_MEMBERS ]] || fail 'Admin primary group is shared with other accounts.'
for file in "$REPO/.env"; do
    [[ -f $file && ! -L $file ]] || fail 'Persistent configuration missing or not regular.'
    [[ $(stat -c %u -- "$file") == "$ADMIN_UID" ]] || fail 'Configuration owner is not admin.'
    [[ $(stat -c %g -- "$file") == "$ADMIN_GID" ]] || fail 'Configuration group is not admin exclusive primary group.'
    perms=$(stat -c %a -- "$file")
    [[ $perms == 600 || $perms == 640 ]] || fail 'Configuration permissions must be exactly 600 or 640.'
    ACL=$(getfacl -cp -- "$file" 2>/dev/null) || fail 'Cannot inspect configuration ACL.'
    if printf '%s\n' "$ACL" | grep -Eq '^(user|group):[^:]|^default:'; then
        fail 'Extended configuration ACL requires manual review.'
    fi
done
for file in "$REPO/.env.backup" "$REPO/.env_old"; do
    [[ ! -e $file ]] && continue
    [[ -f $file && ! -L $file ]] || fail 'Legacy configuration exists but is not regular.'
    [[ $(stat -c %u -- "$file") == "$ADMIN_UID" ]] || fail 'Legacy configuration owner is not admin.'
    [[ $(stat -c %g -- "$file") == "$ADMIN_GID" ]] || fail 'Legacy configuration group is not admin exclusive primary group.'
    perms=$(stat -c %a -- "$file")
    [[ $perms == 600 || $perms == 640 ]] || fail 'Legacy configuration permissions must be exactly 600 or 640.'
    ACL=$(getfacl -cp -- "$file" 2>/dev/null) || fail 'Cannot inspect legacy configuration ACL.'
    if printf '%s\n' "$ACL" | grep -Eq '^(user|group):[^:]|^default:'; then
        fail 'Extended legacy configuration ACL requires manual review.'
    fi
done
STAGE=git
[[ $(git -C "$REPO" rev-parse --show-toplevel) == "$REPO" ]] || fail 'Unexpected Git root.'
[[ $(git -C "$REPO" branch --show-current) == main ]] || fail 'Branch must be main.'
git -C "$REPO" diff --quiet || fail 'Tracked changes in working tree.'
git -C "$REPO" diff --cached --quiet || fail 'Staged changes.'
# NUL stream preserves spaces, newlines and quoted filenames. pipefail propagates Git errors.
git -C "$REPO" ls-files --others -z | while IFS= read -r -d '' file; do
    case "$file" in
        .env|.env.backup|.env_old) ;;
        node_modules/*|dist/*|.angular/cache/*)
            git -C "$REPO" check-ignore -q -- "$file" || fail 'Generated artifact is not ignored; manual review required.' ;;
        istbrasil.private/*)
            case "$file" in
                *.pdf|*.png|*.jpg|*.jpeg|*.webp|*.gif|*.mp4|*.webm|*.mp3|*.wav|*.ogg|*.m4a) ;;
                *) fail 'Unknown private file type; manual review required.' ;;
            esac
            [[ -f $REPO/$file && ! -L $REPO/$file ]] || fail 'Private data is not a regular file.'
            [[ $(realpath -e -- "$REPO/$file") == "$REPO/$file" ]] || fail 'Private data path contains a symlink.'
            data_mode=$(stat -c %a -- "$REPO/$file")
            (( (8#$data_mode & 0111) == 0 )) || fail 'Executable private file requires manual review.' ;;
        *) fail 'Untracked file outside explicit allowlist; manual review required.' ;;
    esac
done
for config in .env .env.backup .env_old; do
    if git -C "$REPO" ls-files --error-unmatch -- "$config" >/dev/null 2>&1; then
        fail 'Sensitive configuration is tracked by Git.'
    fi
done
PREVIOUS=$(git -C "$REPO" rev-parse --verify HEAD)
TARGET=$(git -C "$REPO" rev-parse --verify origin/main)
git -C "$REPO" merge-base --is-ancestor "$PREVIOUS" "$TARGET" || fail 'Cached target is not fast-forward.'
log "Current commit: $PREVIOUS; cached origin/main: $TARGET (no fetch)."
STAGE=space
AVAILABLE=$(df -Pk -- "$BASE" | awk 'END {print $4}')
[[ $AVAILABLE =~ ^[0-9]+$ ]] || fail 'Cannot measure space.'
(( AVAILABLE >= 10485760 )) || fail 'Less than 10 GiB available.'
log "Available: $AVAILABLE KiB; actual backup size still needs validation."
STAGE=pm2
RUNTIME_CWD=$REPO
RUNTIME_SCRIPT="$REPO/server.js"
RUNTIME_KIND=legacy
if [[ -e $BASE/.deploy/state/active.json ]]; then
    [[ -f $BASE/.deploy/state/active.json && ! -L $BASE/.deploy/state/active.json
       && $(stat -c %u -- "$BASE/.deploy/state/active.json") == "$ADMIN_UID"
       && $(stat -c %a -- "$BASE/.deploy/state/active.json") == 600 ]] || fail 'Active state metadata is unsafe.'
    RUNTIME_CWD=$(node --input-type=module - "$BASE" "$REPO/scripts/deploy/production-contract.mjs" <<'ACTIVE'
import fs from 'node:fs';
const [base,modulePath]=process.argv.slice(2);
const {canonicalPaths,validateActive,releasePaths}=await import('file://'+modulePath);
const paths=canonicalPaths(base), active=JSON.parse(fs.readFileSync(paths.active,'utf8'));
if (!validateActive(active,paths)) process.exit(2);
process.stdout.write(releasePaths(paths,active.backend.releaseId).backend);
ACTIVE
    ) || fail 'Active state metadata is invalid.'
    RUNTIME_SCRIPT="$RUNTIME_CWD/server.js"
    RUNTIME_KIND=release
fi
# Do not invoke PM2 CLI: even --version/jlist may start a missing daemon.
[[ -f $EXPECTED_PM2_HOME/pm2.pid && ! -L $EXPECTED_PM2_HOME/pm2.pid
   && -S $EXPECTED_PM2_HOME/rpc.sock && ! -L $EXPECTED_PM2_HOME/rpc.sock ]] || fail 'Existing admin PM2 daemon not proven.'
for pm2_file in "$EXPECTED_PM2_HOME/pm2.pid" "$EXPECTED_PM2_HOME/rpc.sock"; do
    [[ $(stat -c %u -- "$pm2_file") == "$ADMIN_UID" ]] || fail 'PM2 metadata/socket not owned by admin.'
done
DAEMON_PID=$(< "$EXPECTED_PM2_HOME/pm2.pid")
[[ $DAEMON_PID =~ ^[1-9][0-9]*$ && -d /proc/$DAEMON_PID ]] || fail 'Invalid/inactive PM2 PID.'
[[ $(stat -c %u -- /proc/"$DAEMON_PID") == "$ADMIN_UID" ]] || fail 'PM2 daemon not owned by admin.'
PROCESS_LIST=$(ps -eo uid=,pid=,comm=) || fail 'Cannot enumerate visible processes.'
ROOT_PM2=$(printf '%s\n' "$PROCESS_LIST" | awk '$1 == 0 && $3 ~ /^PM2/ {print "conflict"}')
[[ -z $ROOT_PM2 ]] || fail 'Possible root PM2 daemon: manual intervention required.'
ROOT_NODE_PIDS=$(printf '%s\n' "$PROCESS_LIST" | awk '$1 == 0 && $3 ~ /^(node|nodejs)$/ {print $2}')
SOCKETS=$(ss -H -ltnp 'sport = :3000') || fail 'Cannot inspect port 3000.'
[[ -n $SOCKETS ]] || fail 'Port 3000 is not listening.'
# Every listening socket must disclose exactly one owner; a hidden second socket is unsafe.
API_PID=''
while IFS= read -r socket; do
    pids=$(printf '%s\n' "$socket" | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u) || fail 'Port owner hidden; admin cannot prove ownership.'
    [[ $pids =~ ^[1-9][0-9]*$ ]] || fail 'Multiple/unknown owners of port 3000.'
    [[ -z $API_PID || $API_PID == "$pids" ]] || fail 'Multiple/unknown owners of port 3000.'
    API_PID=$pids
done <<< "$SOCKETS"
[[ $(stat -c %u -- /proc/"$API_PID") == "$ADMIN_UID" ]] || fail 'Port 3000 belongs to another user.'
[[ $(realpath -e -- /proc/"$API_PID"/cwd) == "$RUNTIME_CWD" ]] || fail 'Unexpected API cwd.'
node --input-type=commonjs - "$RUNTIME_CWD" "$RUNTIME_SCRIPT" "$API_PID" "$DAEMON_PID" "$EXPECTED_PM2_HOME" "$ROOT_NODE_PIDS" "$ADMIN_UID" <<'PM2CHECK'
// PM2 inspection: read /proc only, never load application or execute PM2.
const fs = require('node:fs'), path = require('node:path');
const [runtimeCwd, runtimeScript, pid, daemon, home, rootPids, uid] = process.argv.slice(2);
const reject = message => { console.error('[IST deploy] ERROR [pm2]: '+message); process.exit(1); };
const cmd = id => fs.readFileSync('/proc/'+id+'/cmdline','utf8').replaceAll('\0',' ').trim();
const environment = id => Object.fromEntries(fs.readFileSync('/proc/'+id+'/environ','utf8').split('\0').filter(Boolean).map(v => {
    const i=v.indexOf('='); return [v.slice(0,i), v.slice(i+1)];
}));
try {
    const title = cmd(daemon);
    if (!/^PM2 v[0-9]+(?:\.[0-9]+){1,2}: God Daemon \(.+\)$/.test(title)
        || !title.endsWith('('+home+')')) reject('PM2 daemon title/home not proven; PID may be stale.');
    for (const rootPid of rootPids.trim().split(/\s+/).filter(Boolean)) {
        if (!/^[1-9][0-9]*$/.test(rootPid)) reject('Invalid process snapshot.');
        let args;
        try { args=cmd(rootPid); } catch (e) {
            if (e.code === 'ENOENT' || e.code === 'ESRCH') continue; // Exited during inspection.
            reject('Root Node command line inaccessible; competing PM2 cannot be ruled out.');
        }
        if (!args) reject('Root Node command line empty; competing PM2 cannot be ruled out.');
        if (/\bPM2\b|(?:^|[ /])pm2(?:[ /]|$)/.test(args)) reject('Possible root PM2 behind Node command name; manual intervention required.');
    }
    const runtime = environment(pid);
    if (runtime.name !== 'ist-api' || runtime.pm_cwd !== runtimeCwd || runtime.pm_exec_path !== runtimeScript) reject('Unexpected PM2 API identity.');
    if (runtime.PM2_HOME && runtime.PM2_HOME !== home) reject('API uses another PM2_HOME.');
    // Fork/cluster both allowed, but ancestry must lead to the validated daemon.
    let current=pid, found=false;
    const seen=new Set();
    for (let i=0;i<32;i++) {
        if (seen.has(current)) break;
        seen.add(current);
        const status=fs.readFileSync('/proc/'+current+'/status','utf8');
        const owners=/^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/m.exec(status);
        if (!owners || owners.slice(1).some(v => v !== uid)) reject('Process ancestry owner differs from admin.');
        if (current === daemon) { found=true; break; }
        const parent=/^PPid:\s+(\d+)/m.exec(status)?.[1];
        if (!parent || parent === '0' || parent === '1') break;
        current=parent;
    }
    if (!found) reject('API is not a descendant of the validated admin PM2 daemon.');
    if (fs.realpathSync('/proc/'+pid+'/exe') !== fs.realpathSync(process.execPath)) reject('API uses another Node executable.');
    console.log('[IST deploy] Admin PM2 daemon, API identity and ancestry validated.');
} catch { reject('Insufficient /proc visibility or process changed during inspection; no process action taken.'); }
PM2CHECK
STAGE=runtime
node --input-type=commonjs - "$RUNTIME_CWD" "$RUNTIME_SCRIPT" "$RUNTIME_KIND" "$API_PID" "$DAEMON_PID" "$(command -v pm2)" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const [runtimeCwd, runtimeScript, runtimeKind, pid, daemon, pm2bin] = process.argv.slice(2);
const reject = message => { console.error('[IST deploy] ERROR [runtime]: '+message); process.exit(1); };
try {
    const req = createRequire(path.join(runtimeCwd,'package.json'));
    const semver = req('semver'), dotenv = req('dotenv');
    if (process.versions.node !== '20.19.6') reject('Node version differs from the homologated runtime.');
    if (!['legacy','release'].includes(runtimeKind)) reject('Unknown runtime kind.');
    for (const name of ['@angular/cli','@angular/core','primeng','express','sharp','bcrypt']) {
        const installed = JSON.parse(fs.readFileSync(path.join(runtimeCwd,'node_modules',name,'package.json'),'utf8'));
        if (!installed.version || !semver.satisfies(process.versions.node, installed.engines?.node || '*')) reject('Installed runtime dependency is invalid or incompatible with Node.');
    }
    const pkgs = runtimeKind === 'release'
        ? JSON.parse(fs.readFileSync(path.join(runtimeCwd,'package-lock.json'),'utf8')).packages || {}
        : null;
    if (runtimeKind === 'release') for (const name of ['@angular/cli','@angular/core','primeng','express','sharp','bcrypt']) {
        const info = pkgs['node_modules/'+name];
        const installed = JSON.parse(fs.readFileSync(path.join(runtimeCwd,'node_modules',name,'package.json'),'utf8'));
        if (!info || !semver.satisfies(process.versions.node, info.engines?.node || '*')) reject('Node incompatible or lock incomplete.');
        if (installed.version !== info.version) reject('Installed dependency differs from lockfile.');
    }
    const entries = fs.readFileSync('/proc/'+pid+'/environ','utf8').split('\0');
    const runtime = Object.fromEntries(entries.filter(Boolean).map(v => { const i=v.indexOf('='); return [v.slice(0,i),v.slice(i+1)]; }));
    if (runtime.name !== 'ist-api' || runtime.pm_cwd !== runtimeCwd || runtime.pm_exec_path !== runtimeScript) reject('Unexpected PM2 API identity.');
    if (runtime.PM2_HOME && runtime.PM2_HOME !== '/home/admin/.pm2') reject('API uses another PM2_HOME.');
    if (fs.realpathSync('/proc/'+pid+'/exe') !== fs.realpathSync(process.execPath)) reject('API uses another Node executable.');
    const config = { ...dotenv.parse(fs.readFileSync(path.join(runtimeCwd,'.env'))), ...runtime };
    if (config.NODE_ENV !== 'production' || config.FESTIVAL_II_ETAPA_INSCRICOES_ID !== '1') reject('Selected production variables are missing/invalid.');
    const pm2version = JSON.parse(fs.readFileSync(path.resolve(fs.realpathSync(pm2bin),'../../package.json'),'utf8')).version;
    console.log('[IST deploy] Node '+process.versions.node+'; PM2 '+pm2version+'; selected configuration validated.');
    if (runtimeKind === 'release') {
        for (const info of Object.values(pkgs)) {
            for (const [peer, range] of Object.entries(info.peerDependencies || {})) {
                const actual = pkgs['node_modules/'+peer];
                if (!actual && info.peerDependenciesMeta?.[peer]?.optional) continue;
                if (!actual || !semver.satisfies(actual.version, range)) reject('Peer dependency conflict: reproducible installation blocked.');
            }
        }
    }
} catch { reject('Cannot validate runtime/configuration/dependencies; sensitive details omitted.'); }
NODE
log "npm $(npm --version)"
STAGE=guard
if [[ $MODE == --check ]]; then
    log 'Diagnostics passed; no runtime change performed.'
    exit 0
fi
[[ -f $BASE/.deploy.lock && ! -L $BASE/.deploy.lock ]] || fail 'Administrative lock not provisioned.'
exec 9< "$BASE/.deploy.lock"
flock -n -x 9 || fail 'Concurrent deploy/rollback holds lock.'
if [[ $MODE == --rollback ]]; then
    ROLLBACK_ID=$2
    [[ $ROLLBACK_ID =~ ^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$ ]] || fail 'Rollback unavailable: invalid backup UUID.'
fi
APPROVAL="$BASE/.deploy/state/PRODUCTION_APPROVED"
[[ -f $APPROVAL && ! -L $APPROVAL && $(stat -c %u -- "$APPROVAL") == "$ADMIN_UID" && $(stat -c %a -- "$APPROVAL") == 600
   && $(< "$APPROVAL") == IST_DEPLOY_PRODUCTION_APPROVED_V1 ]] || {
    [[ $MODE == --rollback ]] && fail 'Rollback unavailable: production approval marker missing.'
    fail 'DEPLOY DISABLED: production approval marker missing. No runtime change performed.'
}
STAGE=operation
if [[ $MODE == --deploy ]]; then
    if OPERATION_OUTPUT=$(node "$REPO/scripts/deploy/deployment-runner.mjs" deploy "$TARGET" 2>&1); then OPERATION_STATUS=0; else OPERATION_STATUS=$?; fi
else
    if OPERATION_OUTPUT=$(node "$REPO/scripts/deploy/deployment-runner.mjs" rollback "$ROLLBACK_ID" 2>&1); then OPERATION_STATUS=0; else OPERATION_STATUS=$?; fi
fi
if (( OPERATION_STATUS != 0 )); then
    if (( OPERATION_STATUS == 3 )); then fail 'Operation failed; manual recovery required. Inspect operation.lock and transaction journal.'; fi
    fail 'Operation failed safely; runtime rollback was attempted. Review sanitized runner diagnostics.'
fi
log "$OPERATION_OUTPUT"
log "${MODE#--} completed successfully."
