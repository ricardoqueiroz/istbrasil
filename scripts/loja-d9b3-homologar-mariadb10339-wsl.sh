#!/usr/bin/env bash
# D9-B3: ciclo descartavel da infraestrutura R2 existente, sem alterar seu executor.
# Sudo pessoal no terminal. Nenhuma instalacao; somente o teste novo e dados sinteticos.
set -Eeuo pipefail
[[ $EUID -eq 0 && ${SUDO_USER:-} == ist_user ]] || { echo 'Executar com sudo pessoal de ist_user no terminal.' >&2; exit 1; }
[[ $# == 0 ]] || exit 1
source /etc/os-release
[[ $ID == ubuntu && $VERSION_ID == 26.04 && $(uname -m) == x86_64 ]]
repo=/mnt/c/inetpub/wwwroot/istbrasil.org.br
nome=ist-r2-mariadb10339
volume=ist-r2-mariadb10339-data
dir=/home/ist_user/.local/state/ist-r2-mariadb10339
node='/mnt/c/Program Files/nodejs/node.exe'
teste='C:\inetpub\wwwroot\istbrasil.org.br\tests\lojaDescoberta.integration.test.js'
digest=sha256:a4b57b620852e26f2c306c79fd8a61e22c7cd6e55d0a55d5521854ed2c370102
imagem="docker.io/library/mariadb@$digest"
[[ ! -e $dir && ! -L $dir && -x $node ]]
[[ -f "$repo/tests/lojaDescoberta.integration.test.js" && ! -L "$repo/tests/lojaDescoberta.integration.test.js" ]]
[[ -f "$repo/migrations/ist_loja_download_recuperacao_fundacao.sql" && ! -L "$repo/migrations/ist_loja_download_recuperacao_fundacao.sql" ]]
if ss -H -ltn 'sport = :13339' | grep -q .; then echo 'Porta 13339 ocupada; interrompido.' >&2; exit 1; fi
for unidade in docker.service docker.socket containerd.service; do
  if systemctl is-enabled --quiet "$unidade" || systemctl is-active --quiet "$unidade"; then
    echo 'Docker/containerd preexistente ativo ou habilitado; interrompido.' >&2; exit 1
  fi
done
cid=''
falha() {
  codigo=$?
  echo "D9-B3 interrompida: codigo $codigo; ambiente preservado, sem nova tentativa." >&2
  echo "Container: $nome; ID: ${cid:-nao-criado}; volume: $volume; porta: 13339; diretorio: $dir" >&2
  echo 'Nao remover nem repetir; informar erro sanitizado, nunca os segredos.' >&2
  exit "$codigo"
}
trap falha ERR
systemctl start docker.service
if docker container inspect "$nome" >/dev/null 2>&1 || docker volume inspect "$volume" >/dev/null 2>&1; then
  echo 'Container/volume preexistente: nao reutilizar nem remover.' >&2; false
fi
docker pull --platform linux/amd64 "$imagem"
[[ $(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$imagem") == linux/amd64 ]]
echo "D9_B3_IMAGEM=$imagem"
runid=$(cat /proc/sys/kernel/random/uuid)
schema="ist_loja_67_3_$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')"
install -d -m 0700 -o ist_user -g ist_user "$dir"
umask 077
od -An -N32 -tx1 /dev/urandom | tr -d ' \n' > "$dir/root-password"
chown ist_user:ist_user "$dir/root-password"
[[ $(stat -c '%a' "$dir/root-password") == 600 ]]
docker volume create --label "ist.r2.run=$runid" "$volume" >/dev/null
cid=$(docker create --name "$nome" --label "ist.r2.run=$runid" --restart=no \
  --memory=1g --cpus=2 --pids-limit=256 -p 127.0.0.1:13339:3306 \
  --mount "source=$volume,target=/var/lib/mysql" \
  --mount "type=bind,src=$dir/root-password,dst=/run/secrets/root-password,readonly" \
  -e MYSQL_ROOT_PASSWORD_FILE=/run/secrets/root-password -e MYSQL_ROOT_HOST=% "$imagem")
[[ $cid =~ ^[0-9a-f]{64}$ ]]
docker cp "$cid:/usr/local/bin/docker-entrypoint.sh" "$dir/entrypoint.sh"
grep -q 'file_env()' "$dir/entrypoint.sh"
grep -Eq "(file_env|_mariadb_file_env).*['\"]MYSQL_ROOT_PASSWORD['\"]" "$dir/entrypoint.sh"
grep -q 'fileVar' "$dir/entrypoint.sh"
[[ $(docker inspect --format '{{(index .HostConfig.PortBindings "3306/tcp" 0).HostIp}}:{{(index .HostConfig.PortBindings "3306/tcp" 0).HostPort}}' "$cid") == 127.0.0.1:13339 ]]
[[ $(docker inspect --format '{{.HostConfig.RestartPolicy.Name}}' "$cid") == no ]]
printf '{"containerName":"%s","containerId":"%s","imageDigest":"%s","runId":"%s","volume":"%s","host":"127.0.0.1","port":13339,"schema":"%s"}\n' \
  "$nome" "$cid" "$digest" "$runid" "$volume" "$schema" > "$dir/manifest.json"
chown ist_user:ist_user "$dir/manifest.json"
[[ -f "$repo/migrations/ist_loja_descoberta_adversa.sql" && ! -L "$repo/migrations/ist_loja_descoberta_adversa.sql" ]]
docker start "$cid" >/dev/null
export IST_R2_10339_MANIFEST="$dir/manifest.json"
export WSLENV="${WSLENV:+$WSLENV:}IST_R2_10339_MANIFEST"
# A fixture verifica versao, hostname/ID, datadir, porta e autenticacao antes de SQL.
cd "$repo"
for caso in lojaDescoberta.integration.test.js lojaPagamentoAdversoDireitos.integration.test.js lojaPagamentoAdversoWorker.integration.test.js; do
  # Um schema sintetico novo por suite, no mesmo container identificado.
  anterior=$schema
  schema="ist_loja_67_3_$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')"
  sed -i "s/$anterior/$schema/g" "$dir/manifest.json"
  "$node" --test --test-reporter=spec "C:/inetpub/wwwroot/istbrasil.org.br/tests/$caso"
done
echo 'CODIGO_DE_SAIDA_TESTES=0'
[[ $(docker inspect --format '{{.Id}}' "$nome") == "$cid" ]]
[[ $(docker inspect --format '{{index .Config.Labels "ist.r2.run"}}' "$cid") == "$runid" ]]
[[ $(docker volume inspect --format '{{index .Labels "ist.r2.run"}}' "$volume") == "$runid" ]]
[[ $(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/var/lib/mysql"}}{{.Name}}{{end}}{{end}}' "$cid") == "$volume" ]]
docker stop --time 30 "$cid" >/dev/null
docker rm "$cid" >/dev/null
docker volume rm "$volume" >/dev/null
[[ $(realpath "$dir") == "$dir" && ! -L $dir ]]
for arquivo in root-password manifest.json entrypoint.sh; do
  [[ -f $dir/$arquivo && ! -L $dir/$arquivo ]]
  rm -- "$dir/$arquivo"
done
rmdir -- "$dir"
systemctl stop docker.service docker.socket containerd.service
trap - ERR
echo 'SUCESSO: testes aprovados; container, volume e segredos identificados removidos.'
echo 'Docker/containerd encerrados; inicializacao automatica permanece desativada.'
