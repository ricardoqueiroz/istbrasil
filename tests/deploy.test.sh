#!/usr/bin/env bash
# Isolated diagnostic tests; only a temporary copy can be executed.
set -Eeuo pipefail
SOURCE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf -- "$TMP"' EXIT
trap 'printf "Fixture failed: %s\n" "${SCENARIO:-setup}" >&2; if [[ -f ${FIXTURE:-}/output ]]; then sed "s/NEVER_LOG_THIS_SECRET/[redacted]/g" "$FIXTURE/output" >&2; fi' ERR
export REAL_NODE=$(command -v node) REAL_REALPATH=$(command -v realpath)
mkdir -p "$TMP/bin" "$TMP/phpmyadmin"
case "$(uname -s)" in MINGW*|MSYS*) export MSYS=winsymlinks:nativestrict ;; esac
cat > "$TMP/bin/mock" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
name=${0##*/}
printf '%s\n' "$name $*" >> "$CALLS"
case "$name" in
 id) case "$1" in -u) [[ $SCENARIO == root ]] && echo 0 || echo 1000 ;; -g) echo 1000 ;; -un) [[ $SCENARIO == wrong-user ]] && echo other || echo admin ;; esac ;;
 git)
  case "$*" in
   *--show-toplevel*) echo "$FIXTURE/backend-node/istbrasil" ;;
   *--show-current*) echo main ;;
   *'diff --quiet'*) [[ $SCENARIO != dirty ]] ;;
   *'diff --cached --quiet'*) true ;;
   *'ls-files --others'*)
    printf '.env\0.env.backup\0'
    case "$SCENARIO" in
     unknown|ignored-unknown) printf 'unknown.txt\0' ;;
     newline-unknown) printf 'unknown\nname.txt\0' ;;
     quoted-private) printf 'istbrasil.private/documents/with space\nname.pdf\0' ;;
     private-pdf|private-executable) printf 'istbrasil.private/documents/new.pdf\0' ;;
     private-script) printf 'istbrasil.private/new.sh\0' ;;
     private-symlink) printf 'istbrasil.private/documents/link.pdf\0' ;;
     ignored-generated|unignored-generated) printf 'dist/generated.js\0' ;;
     git-enumeration-error) exit 2 ;;
    esac ;;
   *check-ignore*) [[ $SCENARIO != unignored-generated ]] ;;
   *'ls-files --error-unmatch'*) [[ $SCENARIO == tracked-env ]] ;;
   *'rev-parse --verify'*) echo 09feb451efcc8b563fc408ee5efd3215b700a38e ;;
   *'merge-base --is-ancestor'*) true ;;
   *) exit 99 ;;
  esac ;;
 realpath)
  last=${!#}
  case "$last" in
   */html/istdbadmin) [[ $SCENARIO == bad-link ]] && echo /wrong || echo /usr/share/phpmyadmin ;;
   */proc/222/cwd) echo "$FIXTURE/backend-node/istbrasil" ;;
   *) "$REAL_REALPATH" "$@" ;;
  esac ;;
 stat)
  case "$2" in
   %u) case "$SCENARIO:$*" in wrong-owner:*.env*|pm2-owner:*/pm2/*|port-owner:*/proc/222*) echo 0 ;; *) echo 1000 ;; esac ;;
   %g) [[ $SCENARIO == wrong-group ]] && echo 2000 || echo 1000 ;;
   %a) case "$SCENARIO:$*" in
    perm640:*|backup640:*.env.backup) echo 640 ;;
    perm644:*) echo 644 ;; perm660:*) echo 660 ;; perm400:*) echo 400 ;; perm4600:*) echo 4600 ;;
    private-executable:*new.pdf) echo 700 ;; *) echo 600 ;;
   esac ;;
   *) exit 99 ;;
  esac ;;
 getent)
  if [[ $1 == group ]]; then
   [[ $SCENARIO == shared-group ]] && echo 'admin:x:1000:admin,other' || echo 'admin:x:1000:'
  else
   [[ $SCENARIO == missing-nss-admin ]] || echo 'admin:x:1000:1000::/home/admin:/bin/bash'
   [[ $SCENARIO != shared-primary ]] || echo 'other:x:1001:1000::/home/other:/bin/bash'
  fi ;;
 getfacl)
  [[ $SCENARIO != acl-inaccessible ]] || exit 1
  printf 'user::rw-\ngroup::r--\nother::---\n'
  [[ $SCENARIO != extended-acl ]] || echo 'user:other:r--' ;;
 ps) case "$SCENARIO" in
  root-pm2) echo '0 999 PM2' ;;
  root-node-pm2|root-node-hidden|root-node-unrelated|root-node-empty) printf '1000 111 PM2\n0 999 node\n' ;;
  *) echo '1000 111 PM2' ;;
 esac ;;
 ss) case "$SCENARIO" in
  port-conflict) printf 'users:((node,pid=222,fd=1))\nusers:((node,pid=333,fd=1))\n' ;;
  port-hidden) echo 'LISTEN 0 511 *:3000 *:*' ;;
  port-partly-hidden) printf 'users:((node,pid=222,fd=1))\nLISTEN 0 511 [::]:3000 [::]:*\n' ;;
  port-duplicate) printf 'users:((node,pid=222,fd=1))\nusers:((node,pid=222,fd=2))\n' ;;
  *) echo 'users:((node,pid=222,fd=1))' ;;
 esac ;;
 df) printf 'Filesystem 1024-blocks Used Available Capacity Mounted\nfake 50000000 1 46000000 1%% /\n' ;;
 node)
  input=$(cat)
  if [[ $input == *'// PM2 inspection:'* ]]; then
   # Exercise the actual PM2 Node code. Translate fixture paths only on Windows.
   { cat <<'ADAPTER'
const fixtureFs = require('node:fs'), fixturePath = require('node:path');
if (process.platform === 'win32') {
 const read=fixtureFs.readFileSync, real=fixtureFs.realpathSync, join=fixturePath.join;
 const map=p => typeof p === 'string' && p.startsWith(process.env.FIXTURE+'/')
   ? process.env.FIXTURE_NATIVE+p.slice(process.env.FIXTURE.length) : p;
 fixtureFs.readFileSync=function(p,...args) { return read.call(this,map(p),...args); };
 fixtureFs.realpathSync=function(p,...args) { return real.call(this,map(p),...args); };
 fixturePath.join=(...args) => typeof args[0] === 'string' && args[0].startsWith('/')
   ? fixturePath.posix.join(...args) : join(...args);
}
if (process.env.SCENARIO === 'root-node-hidden') {
 const read=fixtureFs.readFileSync;
 fixtureFs.readFileSync=function(p,...args) {
  if (String(p).endsWith('/999/cmdline')) { const e=new Error('hidden'); e.code='EACCES'; throw e; }
  return read.call(this,p,...args);
 };
}
ADAPTER
    printf '%s\n' "$input"
   } | MSYS2_ARG_CONV_EXCL='*' MSYS2_ENV_CONV_EXCL='FIXTURE' "$REAL_NODE" "$@"
   exit 0
  fi
  [[ $SCENARIO != missing-dependencies ]] || { echo '[IST deploy] ERROR: missing dependencies' >&2; exit 1; }
  [[ $SCENARIO != peer-conflict ]] || { echo '[IST deploy] ERROR: peer dependency conflict' >&2; exit 1; }
  echo '[IST deploy] selected runtime validated' ;;
 npm) [[ $* == --version ]] || exit 99; echo 11.7.0 ;;
 pm2|rsync|curl) echo 'Forbidden operation' >&2; exit 99 ;;
 flock) [[ $SCENARIO != lock-conflict ]] ;;
 *) exit 99 ;;
 esac
MOCK
chmod +x "$TMP/bin/mock"
for cmd in id git realpath stat ps ss df node npm pm2 rsync curl flock getent getfacl; do cp "$TMP/bin/mock" "$TMP/bin/$cmd"; done
COUNT=0
run_case() {
 local scenario=$1 operation=$2 expected=$3
 [[ -z ${DEPLOY_TEST_CASE:-} || $DEPLOY_TEST_CASE == "$scenario" ]] || return 0
 export SCENARIO=$scenario FIXTURE="$TMP/$scenario" CALLS="$TMP/$scenario.calls"
 mkdir -p "$FIXTURE/backend-node/istbrasil/istbrasil.private/documents" "$FIXTURE/html" "$FIXTURE/uploads" "$FIXTURE/pm2" "$FIXTURE/proc/111" "$FIXTURE/proc/222" "$FIXTURE/proc/999"
 printf 'NEVER_LOG_THIS_SECRET\n' > "$FIXTURE/backend-node/istbrasil/.env"
 cp "$FIXTURE/backend-node/istbrasil/.env" "$FIXTURE/backend-node/istbrasil/.env.backup"
 echo preserve > "$FIXTURE/uploads/sentinel"
 echo preserve > "$FIXTURE/backend-node/istbrasil/istbrasil.private/sentinel"
 ln -s "$TMP/phpmyadmin" "$FIXTURE/html/istdbadmin"
 printf 'PM2 v6.0.14: God Daemon (%s)\0' "$FIXTURE/pm2" > "$FIXTURE/proc/111/cmdline"
 [[ $scenario != daemon-stale ]] || printf 'unrelated node process\0' > "$FIXTURE/proc/111/cmdline"
 printf 'Uid:\t1000\t1000\t1000\t1000\nPPid:\t111\n' > "$FIXTURE/proc/222/status"
 printf 'Uid:\t1000\t1000\t1000\t1000\nPPid:\t1\n' > "$FIXTURE/proc/111/status"
 [[ $scenario != api-unrelated ]] || printf 'Uid:\t1000\t1000\t1000\t1000\nPPid:\t1\n' > "$FIXTURE/proc/222/status"
 printf 'name=ist-api\0pm_cwd=%s\0pm_exec_path=%s/server.js\0PM2_HOME=%s\0SECRET=NEVER_LOG_THIS_SECRET\0' \
  "$FIXTURE/backend-node/istbrasil" "$FIXTURE/backend-node/istbrasil" "$FIXTURE/pm2" > "$FIXTURE/proc/222/environ"
 [[ $scenario != api-hidden ]] || rm -- "$FIXTURE/proc/222/environ"
 printf 'node /unrelated/server.js\0' > "$FIXTURE/proc/999/cmdline"
 [[ $scenario != root-node-empty ]] || : > "$FIXTURE/proc/999/cmdline"
 [[ $scenario != root-node-pm2 ]] || printf 'node /usr/lib/node_modules/pm2/lib/Daemon.js\0' > "$FIXTURE/proc/999/cmdline"
 ln -s "$REAL_NODE" "$FIXTURE/proc/222/exe"
 printf data > "$FIXTURE/backend-node/istbrasil/istbrasil.private/documents/new.pdf"
 printf data > "$FIXTURE/backend-node/istbrasil/istbrasil.private/documents/with space
name.pdf"
 ln -s "$FIXTURE/backend-node/istbrasil/istbrasil.private/documents/new.pdf" "$FIXTURE/backend-node/istbrasil/istbrasil.private/documents/link.pdf"
 export FIXTURE_NATIVE="$FIXTURE"
 if command -v cygpath >/dev/null 2>&1; then FIXTURE_NATIVE=$(cygpath -m "$FIXTURE"); fi
 echo 111 > "$FIXTURE/pm2/pm2.pid"
 : > "$FIXTURE/pm2/rpc.sock"
 : > "$FIXTURE/.deploy.lock"
 # Test-only socket adapter; production still requires a Unix socket.
 sed -e "s|^BASE=.*|BASE='$FIXTURE'|" \
  -e "s|^EXPECTED_PM2_HOME=.*|EXPECTED_PM2_HOME='$FIXTURE/pm2'|" \
  -e "s|/proc/|$FIXTURE/proc/|g" \
  -e 's/-S $EXPECTED_PM2_HOME\/rpc.sock/-f $EXPECTED_PM2_HOME\/rpc.sock/' \
  "$SOURCE/deploy.sh" > "$FIXTURE/script.sh"
 local result=0
 PATH="$TMP/bin:$PATH" bash "$FIXTURE/script.sh" "$operation" > "$FIXTURE/output" 2>&1 || result=$?
 if [[ $expected == pass ]]; then
  if [[ $result != 0 ]]; then cat "$FIXTURE/output"; echo "Unexpected failure: $scenario" >&2; return 1; fi
 else
  [[ $result != 0 ]] || { echo "Unexpected success: $scenario" >&2; return 1; }
 fi
 ! grep -q NEVER_LOG_THIS_SECRET "$FIXTURE/output"
 [[ $(readlink "$FIXTURE/html/istdbadmin") == "$TMP/phpmyadmin" ]]
 grep -q preserve "$FIXTURE/uploads/sentinel"
 grep -q preserve "$FIXTURE/backend-node/istbrasil/istbrasil.private/sentinel"
 cmp "$FIXTURE/backend-node/istbrasil/.env" "$FIXTURE/backend-node/istbrasil/.env.backup"
 ! grep -Eq '^(pm2|rsync|curl) |npm (ci|install|run)|git .* (fetch|merge|pull|reset)' "$CALLS"
 if [[ $operation == --check ]]; then ! grep -q '^flock ' "$CALLS"; fi
 case "$scenario" in
  root) grep -q 'Root refused' "$FIXTURE/output" ;;
  wrong-user) grep -q 'must be admin' "$FIXTURE/output" ;;
  dirty) grep -q 'Tracked changes' "$FIXTURE/output" ;;
  unknown|ignored-unknown|newline-unknown) grep -q 'outside explicit allowlist' "$FIXTURE/output" ;;
  lock-conflict) grep -q 'Concurrent deploy' "$FIXTURE/output" ;;
  bad-link) grep -q 'Unexpected phpMyAdmin' "$FIXTURE/output" ;;
  root-pm2|root-node-pm2) grep -q 'Possible root PM2' "$FIXTURE/output" ;;
  port-conflict) grep -q 'Multiple/unknown owners' "$FIXTURE/output" ;;
  port-hidden|port-partly-hidden) grep -q 'Port owner hidden' "$FIXTURE/output" ;;
  root-node-hidden) grep -q 'inaccessible' "$FIXTURE/output" ;;
  missing-nss-admin) grep -q 'NSS enumeration' "$FIXTURE/output" ;;
  root-node-empty) grep -q 'command line empty' "$FIXTURE/output" ;;
  daemon-stale) grep -q 'title/home not proven' "$FIXTURE/output" ;;
  api-unrelated) grep -q 'not a descendant' "$FIXTURE/output" ;;
  api-hidden) grep -q 'Insufficient /proc visibility' "$FIXTURE/output" ;;
  missing-dependencies) grep -q 'missing dependencies' "$FIXTURE/output" ;;
  peer-conflict) grep -q 'peer dependency conflict' "$FIXTURE/output" ;;
  rollback) grep -q 'Rollback unavailable' "$FIXTURE/output" ;;
  build-failure|publication-failure|pm2-failure) grep -q 'DEPLOY DISABLED' "$FIXTURE/output" ;;
 esac
 COUNT=$((COUNT+1)); printf 'PASS %s (%s)\n' "$scenario" "$operation"
}
for scenario in root wrong-user dirty unknown bad-link root-pm2 port-conflict missing-dependencies peer-conflict; do run_case "$scenario" --check fail; done
run_case valid --check pass
run_case lock-conflict --deploy fail
for scenario in build-failure publication-failure pm2-failure; do run_case "$scenario" --deploy fail; done
run_case rollback --rollback fail
for scenario in perm640 backup640 quoted-private private-pdf ignored-generated root-node-unrelated port-duplicate; do run_case "$scenario" --check pass; done
for scenario in wrong-owner wrong-group shared-group shared-primary missing-nss-admin root-node-empty perm644 perm660 perm400 perm4600 extended-acl acl-inaccessible tracked-env ignored-unknown newline-unknown private-executable private-script private-symlink unignored-generated git-enumeration-error pm2-owner daemon-stale api-unrelated api-hidden root-node-pm2 root-node-hidden port-owner port-hidden port-partly-hidden; do run_case "$scenario" --check fail; done
"$REAL_NODE" --input-type=commonjs - "$SOURCE" <<'NODE'
const fs = require('node:fs'), path = require('node:path');
const {createRequire} = require('node:module');
const repo=process.argv[2];
const semver=createRequire(path.join(repo,'package.json'))('semver');
const p=JSON.parse(fs.readFileSync(path.join(repo,'package-lock.json'),'utf8')).packages;
if (semver.satisfies(p['node_modules/@angular/core'].version,p['node_modules/primeng'].peerDependencies['@angular/core'])) throw Error('Expected blocker no longer present; revisit deployment gate.');
console.log('PASS actual Angular/PrimeNG peer conflict');
NODE
printf '%s isolated diagnostic cases + 1 actual dependency check passed.\n' "$COUNT"
