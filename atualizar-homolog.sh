#!/usr/bin/env bash
set -Eeuo pipefail

REPO=/home/ist_user/istbrasil-git
APP=/var/www/istbrasil.org.br/backend-node/istbrasil
WEB=/var/www/istbrasil.org.br/html
PM2_APP=ist-api-homolog
TMP=''

say() { printf '\n==> %s\n' "$*"; }
fail() { printf '\nERRO: etapa interrompida (linha %s): %s\n' "$1" "$2" >&2; exit 1; }
cleanup() { if [[ -n "$TMP" && -d "$TMP" ]]; then rm -rf -- "$TMP"; fi; }
trap 'fail "$LINENO" "$BASH_COMMAND"' ERR
trap cleanup EXIT

MODE=${1:-}
if [[ $# -gt 1 || ( -n "$MODE" && "$MODE" != '--deploy-only' ) ]]; then
  printf 'Uso: %s [--deploy-only]\n' "$0" >&2
  exit 2
fi

say 'Verificações prévias (sem modificar a instalação)'
for cmd in git tar rsync node pm2 ss curl; do
  command -v "$cmd" >/dev/null || { echo "Comando ausente: $cmd" >&2; exit 1; }
done
cd "$REPO"
[[ -d .git && -f angular.json && -f server.js ]] || { echo 'Repositório inválido.' >&2; exit 1; }
[[ -d "$APP" && -f "$APP/angular.json" && -f "$APP/server.js" && -d "$WEB" ]] || { echo 'Instalação não encontrada.' >&2; exit 1; }
[[ -d "$APP/node_modules" && -x "$APP/node_modules/.bin/ng" ]] || { echo 'Angular/node_modules ausente na instalação.' >&2; exit 1; }
[[ -d "$APP/src/assets" && -f "$APP/.env" ]] || { echo 'Assets ou .env ausente na instalação.' >&2; exit 1; }
[[ -f "$APP/proxy.conf.json" ]] || { echo 'Proxy da instalação ausente.' >&2; exit 1; }
node -e 'const fs=require("fs"); const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); for (const k of ["/api","/istbrasil.private/projetos","/assets/images/livros/**"]) {if(p[k]?.target!=="http://localhost:3001") {console.error("Proxy incorreto:",k);process.exit(1)}}' "$APP/proxy.conf.json"
pm2 describe "$PM2_APP" >/dev/null 2>&1 || { echo "Processo PM2 $PM2_APP não encontrado." >&2; exit 1; }
if git diff --name-only --diff-filter=U | grep -q . || git diff --cached --name-only --diff-filter=U | grep -q .; then
  echo 'Conflitos de merge no Git.' >&2; exit 1
fi

if [[ "$MODE" == '--deploy-only' ]]; then
  if [[ -n "$(git status --porcelain)" ]]; then
    echo 'Modo --deploy-only exige diretório Git limpo. Registre ou descarte as alterações antes de republicar.' >&2
    exit 1
  fi
  REV=$(git rev-parse HEAD)
  say "Republicando commit existente: $REV"
  printf 'Confirmar republicação deste commit na homologação? [s/N] '
  IFS= read -r CONFIRM
  [[ "$CONFIRM" == s || "$CONFIRM" == S ]] || { echo 'Cancelado sem publicar.'; exit 0; }
else
  printf '\nMensagem do commit: '
  IFS= read -r MESSAGE
  [[ -n "${MESSAGE//[[:space:]]/}" ]] || { echo 'Mensagem vazia.' >&2; exit 1; }

  say 'Preparando arquivos para revisão (sem incluir SQL locais)'
  git add -A -- . ':!*.sql' ':!*.sql:Zone.Identifier'
  if git diff --cached --quiet; then
    echo 'Nenhuma alteração preparada; não será feita publicação.' >&2; exit 1
  fi
  git diff --cached --check
  printf '\nResumo das alterações preparadas:\n'
  git diff --cached --stat | tail -30
  printf '\nArquivos adicionados ou modificados (revisar):\n'
  git -c core.quotePath=false diff --cached --name-status --diff-filter=AMRT
  printf '\nATENÇÃO: arquivos listados acima entrarão no commit.\n'
  printf 'Confirmar commit e publicação? [s/N] '
  IFS= read -r CONFIRM
  [[ "$CONFIRM" == s || "$CONFIRM" == S ]] || { echo 'Cancelado. O índice Git permanece preparado.'; exit 0; }

  git commit -m "$MESSAGE"
  REV=$(git rev-parse HEAD)
  say "Commit local criado: $REV"
fi

TMP=$(mktemp -d)
mkdir -p "$TMP/export"
git archive --format=tar "$REV" | tar -xf - -C "$TMP/export"

say 'Atualizando código versionado (sem excluir arquivos persistentes)'
rsync -a \
  --exclude='/.env' --exclude='/.env.*' \
  --exclude='/node_modules/' --exclude='/dist/' --exclude='/.angular/' \
  --exclude='/istbrasil.private/' --exclude='/html/' \
  --exclude='/src/assets/demo/' --exclude='/src/assets/flipbooks/' \
  --exclude='/src/assets/images/' --exclude='/src/assets/releases/' \
  --exclude='/src/assets/iconografia/' \
  --exclude='/proxy.conf.json' \
  "$TMP/export/" "$APP/"

say 'Compilando Angular'
(cd "$APP" && ./node_modules/.bin/ng build --configuration production)
[[ -f "$APP/dist/sakai-ng/browser/index.html" ]] || { echo 'Build sem index.html esperado.' >&2; exit 1; }

say 'Publicando frontend no Nginx (preservando istdbadmin)'
rsync -a --exclude='/istdbadmin/' "$APP/dist/sakai-ng/browser/" "$WEB/"

say 'Reiniciando backend PM2'
pm2 restart "$PM2_APP" --update-env

say 'Validando HTTPS após publicação'
for endpoint in / /api/releases; do
  ok=0
  for tentativa in 1 2 3 4 5; do
    status=$(curl --silent --show-error --insecure --output /dev/null --write-out '%{http_code}' --max-time 10 "https://localhost:8443${endpoint}") || status=000
    if [[ "$status" == 200 ]]; then ok=1; break; fi
    sleep 2
  done
  [[ "$ok" == 1 ]] || { echo "Falha HTTPS ${endpoint}: HTTP ${status}" >&2; exit 1; }
  printf 'HTTPS %s: HTTP %s\n' "$endpoint" "$status"
done

say 'Estado final'
pm2 status
ss -ltnp | grep -E ':(3001|8443)\b' || true
printf '\nCommit implantado: %s\n' "$REV"
printf 'Nginx: https://localhost:8443/\n'
printf 'Observação: arquivos removidos do Git não são apagados automaticamente da instalação.\n'
