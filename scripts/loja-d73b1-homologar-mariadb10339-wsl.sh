#!/usr/bin/env bash
# D7.3-B1: ciclo descartavel da infraestrutura R2 existente, sem alterar seu executor.
# Sudo pessoal no terminal. Nenhuma instalacao; somente o teste novo e dados sinteticos.
set -Eeuo pipefail
[[ $EUID -eq 0 && ${SUDO_USER:-} == ist_user ]] || { echo 'Executar com sudo pessoal de ist_user no terminal.' >&2; exit 1; }
[[ $# == 0 || ( $# == 1 && $1 == --concluir-nginx ) ]] || exit 1
source /etc/os-release
[[ $ID == ubuntu && $VERSION_ID == 26.04 && $(uname -m) == x86_64 ]]
repo=/mnt/c/inetpub/wwwroot/istbrasil.org.br
nome=ist-r2-mariadb10339
volume=ist-r2-mariadb10339-data
dir=/home/ist_user/.local/state/ist-r2-mariadb10339
node='/mnt/c/Program Files/nodejs/node.exe'
teste='C:\inetpub\wwwroot\istbrasil.org.br\tests\lojaDownloadRecuperacaoOperacional.integration.test.js'
digest=sha256:a4b57b620852e26f2c306c79fd8a61e22c7cd6e55d0a55d5521854ed2c370102
imagem="docker.io/library/mariadb@$digest"
if [[ ${1:-} == --concluir-nginx ]]; then
  # F1: retoma SOMENTE os recursos identificados. Nenhum SQL ou nova instancia.
  cid=021c657da1155a16fc65dced5540bc0128cb7711c3c44ae416530d2d7e35b002
  nginxid=b4d0063bbb9cbefdd911e47f718a71705ed2d19f1ff57c7bd0cd698310e20aea
  [[ -x $node && -d $dir && ! -L $dir && $(realpath "$dir") == "$dir" ]]
  [[ $(stat -c %U "$dir") == ist_user ]]
  [[ -f $dir/manifest.json && ! -L $dir/manifest.json ]]
  runid=$(sed -nE 's/.*"runId":"([a-f0-9-]{36})".*/\1/p' "$dir/manifest.json")
  [[ $runid =~ ^[a-f0-9-]{36}$ ]]
  grep -Fq "\"containerId\":\"$cid\"" "$dir/manifest.json"
  grep -Fq "\"imageDigest\":\"$digest\"" "$dir/manifest.json"
  grep -Fq '"schema":"ist_loja_67_3_7b7078d27dbc"' "$dir/manifest.json"
  identificar() {
    [[ $(realpath "$dir") == "$dir" && ! -L $dir ]]
    [[ $(docker inspect --format '{{.Id}}' "$nome") == "$cid" ]]
    [[ $(docker inspect --format '{{.Id}}' ist-d73b1-nginx) == "$nginxid" ]]
    for alvo in "$cid" "$nginxid"; do
      [[ $(docker inspect --format '{{index .Config.Labels "ist.r2.run"}}' "$alvo") == "$runid" ]]
      [[ $(docker inspect --format '{{.HostConfig.RestartPolicy.Name}}' "$alvo") == no ]]
    done
    [[ $(docker inspect --format '{{.Config.Image}}' "$cid") == "$imagem" ]]
    [[ $(docker image inspect --format '{{json .RepoDigests}}' "$(docker inspect --format '{{.Image}}' "$nginxid")") == *nginx@sha256:970364228b1e4f932abc22d321932816782cca8a20b85a77552a7cfe9acfb3b5* ]]
    [[ $(docker inspect --format '{{(index .HostConfig.PortBindings "3306/tcp" 0).HostIp}}:{{(index .HostConfig.PortBindings "3306/tcp" 0).HostPort}}' "$cid") == 127.0.0.1:13339 ]]
    [[ $(docker inspect --format '{{(index .HostConfig.PortBindings "8080/tcp" 0).HostIp}}:{{(index .HostConfig.PortBindings "8080/tcp" 0).HostPort}}' "$nginxid") == 127.0.0.1:13380 ]]
    [[ $(docker volume inspect --format '{{index .Labels "ist.r2.run"}}' "$volume") == "$runid" ]]
    [[ $(docker volume inspect --format '{{.Driver}}:{{json .Options}}' "$volume") == local:null ]]
    [[ $(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/var/lib/mysql"}}{{.Name}}{{end}}{{end}}' "$cid") == "$volume" ]]
    [[ $(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/run/secrets/root-password"}}{{.Source}}{{end}}{{end}}' "$cid") == "$dir/root-password" ]]
    [[ $(docker inspect --format '{{range .Mounts}}{{if eq .Type "bind"}}{{.Source}}:{{.Destination}}:{{.RW}}{{end}}{{end}}' "$nginxid") == "$dir/nginx.conf:/etc/nginx/nginx.conf:false" ]]
    [[ $(docker inspect --format '{{.HostConfig.ReadonlyRootfs}}' "$nginxid") == true ]]
    [[ $(docker ps -aq --no-trunc --filter "volume=$volume") == "$cid" ]]
    [[ $(find "$dir" -mindepth 1 -maxdepth 1 -printf '%f\n' | sort) == $'entrypoint.sh\nmanifest.json\nnginx.conf\nroot-password' ]]
    for arquivo in root-password manifest.json entrypoint.sh nginx.conf; do [[ -f $dir/$arquivo && ! -L $dir/$arquivo ]]; done
  }
  identificar
  echo 'IDENTIDADE_F1: IDs, imagens, labels, mounts, volume exclusivo e diretorio confirmados; nenhum banco principal montado no Nginx.'
  resultado=0
  if ! docker exec "$nginxid" nginx -t; then resultado=1; fi
  pronto=false
  fim=$((SECONDS+30))
  while (( SECONDS < fim )); do
    if timeout 2 docker exec "$nginxid" wget -T 1 -q -O /dev/null http://127.0.0.1:8080/; then pronto=true; break; fi
    sleep 1
  done
  if [[ $pronto == true && $resultado == 0 ]]; then
    if "$node" 'C:\inetpub\wwwroot\istbrasil.org.br\scripts\loja-d73b1-validar-nginx.mjs' --test; then resultado=0; else resultado=$?; fi
  else echo 'NGINX_PRONTIDAO_INTERNA_TIMEOUT_OU_CONFIG_INVALIDA' >&2; resultado=1; fi
  echo "CODIGO_DE_SAIDA_HTTP=$resultado"
  # Mesmo com falha HTTP, descartar exclusivamente os recursos comprovados.
  identificar
  docker stop --time 10 "$nginxid" >/dev/null
  docker rm "$nginxid" >/dev/null
  docker stop --time 30 "$cid" >/dev/null
  docker rm "$cid" >/dev/null
  [[ $(docker volume inspect --format '{{index .Labels "ist.r2.run"}}' "$volume") == "$runid" ]]
  [[ -z $(docker ps -aq --filter "volume=$volume") ]]
  docker volume rm "$volume" >/dev/null
  [[ $(realpath "$dir") == "$dir" && ! -L $dir ]]
  for arquivo in root-password manifest.json entrypoint.sh nginx.conf; do
    [[ -f $dir/$arquivo && ! -L $dir/$arquivo ]]; rm -- "$dir/$arquivo"
  done
  rmdir -- "$dir"
  if ss -H -ltn | grep -Eq '127[.]0[.]0[.]1:(13339|13380)[[:space:]]'; then echo 'Portas ainda ocupadas; verificar.' >&2; exit 1; fi
  echo 'DESCARTE_F1: dois containers, volume e diretorio exclusivos removidos; portas WSL 13339 e 13380 livres. Imagens preservadas.'
  if [[ -z $(docker ps -q) ]]; then
    systemctl stop docker.service docker.socket containerd.service
    echo 'Docker/containerd encerrados: nenhum outro container ativo.'
  else echo 'Docker mantido: existem outros containers ativos.'; fi
  exit "$resultado"
fi
[[ ! -e $dir && ! -L $dir && -x $node ]]
[[ -f "$repo/tests/lojaDownloadRecuperacaoOperacional.integration.test.js" && ! -L "$repo/tests/lojaDownloadRecuperacaoOperacional.integration.test.js" ]]
[[ -f "$repo/migrations/ist_loja_download_recuperacao_fundacao.sql" && ! -L "$repo/migrations/ist_loja_download_recuperacao_fundacao.sql" ]]
if ss -H -ltn 'sport = :13339' | grep -q .; then echo 'Porta 13339 ocupada; interrompido.' >&2; exit 1; fi
if ss -H -ltn 'sport = :13380' | grep -q .; then echo 'Porta 13380 ocupada; interrompido.' >&2; exit 1; fi
for unidade in docker.service docker.socket containerd.service; do
  if systemctl is-enabled --quiet "$unidade" || systemctl is-active --quiet "$unidade"; then
    echo 'Docker/containerd preexistente ativo ou habilitado; interrompido.' >&2; exit 1
  fi
done
cid=''
nginxid=''
falha() {
  codigo=$?
  echo "D7.3 interrompida: codigo $codigo; ambiente preservado, sem nova tentativa." >&2
  echo "Container: $nome; ID: ${cid:-nao-criado}; volume: $volume; porta: 13339; diretorio: $dir" >&2
  echo "Nginx descartavel: ${nginxid:-nao-criado}; porta 13380. Preservar para diagnostico." >&2
  echo 'Nao remover nem repetir; informar erro sanitizado, nunca os segredos.' >&2
  exit "$codigo"
}
trap falha ERR
systemctl start docker.service
if docker container inspect "$nome" >/dev/null 2>&1 || docker volume inspect "$volume" >/dev/null 2>&1; then
  echo 'Container/volume preexistente: nao reutilizar nem remover.' >&2; false
fi
if docker container inspect ist-d73b1-nginx >/dev/null 2>&1; then echo 'Nginx de teste preexistente; interrompido.' >&2; false; fi
docker pull --platform linux/amd64 "$imagem"
[[ $(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$imagem") == linux/amd64 ]]
echo "D7_3_B1_IMAGEM=$imagem"
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
docker start "$cid" >/dev/null
export IST_R2_10339_MANIFEST="$dir/manifest.json"
export WSLENV="${WSLENV:+$WSLENV:}IST_R2_10339_MANIFEST"
# A fixture verifica versao, hostname/ID, datadir, porta e autenticacao antes de SQL.
"$node" --test --test-reporter=spec "$teste"
echo 'CODIGO_DE_SAIDA_TESTES=0'

# Valida apenas os dois blocos reais de locations, em HTTP sintetico isolado.
# Nao carrega certificados, logs, configuracao efetiva ou arquivos de producao.
nginx_novo=false
if ! docker image inspect nginx:stable-alpine >/dev/null 2>&1; then
  docker pull nginx:stable-alpine
  nginx_novo=true
fi
nginx_imagem=$(docker image inspect --format '{{.Id}}' nginx:stable-alpine)
echo "D7_3_B1_NGINX_IMAGEM=$(docker image inspect --format '{{json .RepoDigests}}' "$nginx_imagem")"
"$node" 'C:\inetpub\wwwroot\istbrasil.org.br\scripts\loja-d73b1-validar-nginx.mjs' --config > "$dir/nginx.conf"
[[ -s $dir/nginx.conf && ! -L $dir/nginx.conf ]]
nginxid=$(docker create --name ist-d73b1-nginx --label "ist.r2.run=$runid" --restart=no \
  --memory=128m --cpus=1 --pids-limit=64 --read-only --tmpfs /tmp --tmpfs /var/cache/nginx \
  -p 127.0.0.1:13380:8080 --mount "type=bind,src=$dir/nginx.conf,dst=/etc/nginx/nginx.conf,readonly" \
  --entrypoint nginx "$nginx_imagem" -g 'daemon off;')
[[ $nginxid =~ ^[0-9a-f]{64}$ ]]
[[ $(docker inspect --format '{{(index .HostConfig.PortBindings "8080/tcp" 0).HostIp}}:{{(index .HostConfig.PortBindings "8080/tcp" 0).HostPort}}' "$nginxid") == 127.0.0.1:13380 ]]
docker start "$nginxid" >/dev/null
docker exec "$nginxid" nginx -t
pronto=false
for tentativa in $(seq 1 30); do
  if docker exec "$nginxid" wget -q -O /dev/null http://127.0.0.1:8080/; then pronto=true; break; fi
  sleep 1
done
[[ $pronto == true ]]
"$node" 'C:\inetpub\wwwroot\istbrasil.org.br\scripts\loja-d73b1-validar-nginx.mjs' --test
[[ $(docker inspect --format '{{.Id}}' ist-d73b1-nginx) == "$nginxid" ]]
[[ $(docker inspect --format '{{index .Config.Labels "ist.r2.run"}}' "$nginxid") == "$runid" ]]
docker stop --time 10 "$nginxid" >/dev/null
docker rm "$nginxid" >/dev/null
if [[ $nginx_novo == true ]] && [[ -z $(docker ps -a --filter "ancestor=$nginx_imagem" --format '{{.ID}}') ]]; then
  docker image rm "$nginx_imagem" >/dev/null
fi
[[ $(docker inspect --format '{{.Id}}' "$nome") == "$cid" ]]
[[ $(docker inspect --format '{{index .Config.Labels "ist.r2.run"}}' "$cid") == "$runid" ]]
[[ $(docker volume inspect --format '{{index .Labels "ist.r2.run"}}' "$volume") == "$runid" ]]
[[ $(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/var/lib/mysql"}}{{.Name}}{{end}}{{end}}' "$cid") == "$volume" ]]
docker stop --time 30 "$cid" >/dev/null
docker rm "$cid" >/dev/null
docker volume rm "$volume" >/dev/null
[[ $(realpath "$dir") == "$dir" && ! -L $dir ]]
for arquivo in root-password manifest.json entrypoint.sh nginx.conf; do
  [[ -f $dir/$arquivo && ! -L $dir/$arquivo ]]
  rm -- "$dir/$arquivo"
done
rmdir -- "$dir"
systemctl stop docker.service docker.socket containerd.service
trap - ERR
echo 'SUCESSO: testes aprovados; container, volume e segredos identificados removidos.'
echo 'Docker/containerd encerrados; inicializacao automatica permanece desativada.'
