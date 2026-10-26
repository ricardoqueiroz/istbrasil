#!/usr/bin/env bash
# Derivado do executor PATCH homologado. Uma suite por instancia nova, sem instalacao.
set -Eeuo pipefail
[[ $EUID -eq 0 && ${SUDO_USER:-} == ist_user ]] || { echo 'Executar com sudo pessoal de ist_user.' >&2; exit 1; }
[[ $# == 1 ]] || { echo 'Uso: executor outbox|worker' >&2; exit 1; }
case "$1" in
  outbox) suite=lojaNotificacoes.integration.test.js ;;
  worker) suite=lojaNotificacoesWorker.integration.test.js ;;
  *) exit 1 ;;
esac
source /etc/os-release
[[ $ID == ubuntu && $VERSION_ID == 26.04 && $(uname -m) == x86_64 ]]
# Never inherit a remote Docker context/host.
[[ -S /var/run/docker.sock ]]
docker() { env -u DOCKER_HOST -u DOCKER_CONTEXT docker --host unix:///var/run/docker.sock "$@"; }
repo=/mnt/c/inetpub/wwwroot/istbrasil.org.br
nome=ist-notificacoes-mariadb10339
volume=ist-notificacoes-mariadb10339-data
dir=/home/ist_user/.local/state/ist-notificacoes-mariadb10339
node='/mnt/c/Program Files/nodejs/node.exe'
teste="C:\\inetpub\\wwwroot\\istbrasil.org.br\\tests\\$suite"
digest=sha256:a4b57b620852e26f2c306c79fd8a61e22c7cd6e55d0a55d5521854ed2c370102
imagem="docker.io/library/mariadb@$digest"
[[ ! -e $dir && ! -L $dir && -x $node ]]
[[ $(realpath -e "$(dirname "$dir")") == "$(dirname "$dir")" ]]
for arquivo in "tests/$suite" tests/fixtures/lojaCatalogoMariaDB10339.js tests/fixtures/lojaNotificacoesFixture.js; do
  [[ -f "$repo/$arquivo" && ! -L "$repo/$arquivo" ]]
done
for unidade in docker.service containerd.service; do
  systemctl is-active --quiet "$unidade" || { echo 'Servicos devem estar previamente ativos; interrompido.' >&2; exit 1; }
done
docker info >/dev/null 2>&1 || { echo 'Daemon Docker indisponivel.' >&2; exit 1; }
cid=''; porta=nao-atribuida
falha() {
  codigo=$?
  echo "NOTIFICACOES interrompida: codigo $codigo; sem repeticao ou limpeza manual." >&2
  echo "Container: $nome; ID: ${cid:-nao-criado}; volume: $volume; porta: $porta; diretorio: $dir" >&2
  echo 'Recursos proprios preservados para diagnostico; nunca publicar segredos. Servicos compartilhados preservados.' >&2
  exit "$codigo"
}
trap falha ERR
if docker container inspect "$nome" >/dev/null 2>&1 || docker volume inspect "$volume" >/dev/null 2>&1; then
  echo 'Recurso preexistente: nao reutilizar ou remover.' >&2; false
fi
# Nao instala/puxa imagem: exige a distribuicao por digest ja disponivel.
[[ $(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$imagem") == linux/amd64 ]]
runid=$(cat /proc/sys/kernel/random/uuid)
schema="ist_loja_67_3_$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')"
install -d -m 0700 -o ist_user -g ist_user "$dir"
umask 077
od -An -N32 -tx1 /dev/urandom | tr -d ' \n' > "$dir/root-password"
chown ist_user:ist_user "$dir/root-password"
[[ $(stat -c '%a' "$dir/root-password") == 600 ]]
docker volume create --label "ist.r2.run=$runid" "$volume" >/dev/null
cid=$(docker create --name "$nome" --label "ist.r2.run=$runid" --restart=no \
  --memory=1g --cpus=2 --pids-limit=256 -p 127.0.0.1::3306 \
  --mount "source=$volume,target=/var/lib/mysql" \
  --mount "type=bind,src=$dir/root-password,dst=/run/secrets/root-password,readonly" \
  -e MYSQL_ROOT_PASSWORD_FILE=/run/secrets/root-password -e MYSQL_ROOT_HOST=% "$imagem")
[[ $cid =~ ^[0-9a-f]{64}$ ]]
docker cp "$cid:/usr/local/bin/docker-entrypoint.sh" "$dir/entrypoint.sh"
grep -q 'file_env()' "$dir/entrypoint.sh"
grep -Eq "(file_env|_mariadb_file_env).*['\"]MYSQL_ROOT_PASSWORD['\"]" "$dir/entrypoint.sh"
grep -q 'fileVar' "$dir/entrypoint.sh"
[[ $(docker inspect --format '{{.HostConfig.RestartPolicy.Name}}' "$cid") == no ]]
docker start "$cid" >/dev/null
porta=$(docker inspect --format '{{(index .NetworkSettings.Ports "3306/tcp" 0).HostPort}}' "$cid")
[[ $porta =~ ^[0-9]{4,5}$ && $porta -gt 1024 && $porta -le 65535 ]]
case "$porta" in 3000|3001|3306|3307|4200|4201|8080|8443|13339) false ;; esac
[[ $(docker inspect --format '{{(index .NetworkSettings.Ports "3306/tcp" 0).HostIp}}' "$cid") == 127.0.0.1 ]]
printf '{"containerName":"%s","containerId":"%s","imageDigest":"%s","runId":"%s","volume":"%s","host":"127.0.0.1","port":%s,"schema":"%s"}\n' \
  "$nome" "$cid" "$digest" "$runid" "$volume" "$porta" "$schema" > "$dir/manifest.json"
chown ist_user:ist_user "$dir/manifest.json"
unset IST_LOJA_PAGAMENTOS_MARIADB_BIN
export IST_R2_10339_MANIFEST="$dir/manifest.json"
export IST_LOJA_NOTIFICACOES_MARIADB=10.3.39 NODE_ENV=test
export WSLENV="${WSLENV:+$WSLENV:}IST_R2_10339_MANIFEST:IST_LOJA_NOTIFICACOES_MARIADB:NODE_ENV"
"$node" --test --test-reporter=spec "$teste"
echo 'CODIGO_DE_SAIDA_TESTES=0'
[[ $(docker inspect --format '{{.Id}}' "$nome") == "$cid" ]]
[[ $(docker inspect --format '{{.Config.Image}}' "$cid") == "$imagem" ]]
[[ $(docker inspect --format '{{index .Config.Labels "ist.r2.run"}}' "$cid") == "$runid" ]]
[[ $(docker volume inspect --format '{{index .Labels "ist.r2.run"}}' "$volume") == "$runid" ]]
[[ $(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/var/lib/mysql"}}{{.Name}}{{end}}{{end}}' "$cid") == "$volume" ]]
[[ $(docker inspect --format '{{(index .NetworkSettings.Ports "3306/tcp" 0).HostPort}}' "$cid") == "$porta" ]]
docker stop --time 30 "$cid" >/dev/null
docker rm "$cid" >/dev/null
docker volume rm "$volume" >/dev/null
if docker container inspect "$nome" >/dev/null 2>&1 || docker volume inspect "$volume" >/dev/null 2>&1; then false; fi
[[ $(realpath "$dir") == "$dir" && ! -L $dir && $(stat -c '%U' "$dir") == ist_user && $(stat -c '%a' "$dir") == 700 ]]
for arquivo in root-password manifest.json entrypoint.sh; do
  [[ -f $dir/$arquivo && ! -L $dir/$arquivo ]]
  rm -- "$dir/$arquivo"
done
rmdir -- "$dir"
[[ ! -e $dir && ! -L $dir ]]
trap - ERR
echo 'SUCESSO: recursos identificados removidos. Docker/containerd preservados.'
