#!/usr/bin/env bash
# Somente homologacao: build real, SMTP simulado, banco e TLS sinteticos.
set -Eeuo pipefail
[[ $EUID == 0 && ${SUDO_USER:-} == ist_user && $# == 1 ]]
versao=$1
[[ $versao == 13 || $versao == 10339 ]]
repo=/mnt/c/inetpub/wwwroot/istbrasil.org.br
node='/mnt/c/Program Files/nodejs/node.exe'
dbnome=ist-r2-mariadb10339
volume=ist-r2-mariadb10339-data
nginxnome=ist-d74a-nginx
dir=/home/ist_user/.local/state/ist-d74a-13
[[ $versao != 10339 ]] || dir=/home/ist_user/.local/state/ist-r2-mariadb10339
[[ ! -e $dir && ! -L $dir && -f $repo/dist/sakai-ng/browser/index.html ]]
for unidade in docker.service docker.socket containerd.service; do
  if systemctl is-active --quiet "$unidade"; then echo 'Docker preexistente ativo; interromper sem alterar.' >&2; exit 1; fi
done
for porta in 13339 13381; do if ss -H -ltn "sport = :$porta" | grep -q .; then echo "Porta $porta ocupada." >&2; exit 1; fi; done
export IST_D74_BACKEND_HOST
IST_D74_BACKEND_HOST=$(ip route show default | awk '{print $3}')
[[ $IST_D74_BACKEND_HOST =~ ^172\.(1[6-9]|2[0-9]|3[01])\.[0-9]+\.1$ ]]
export WSLENV="${WSLENV:+$WSLENV:}IST_D74_BACKEND_HOST"
"$node" -e 'const n=require("net");const s=n.createServer();s.on("error",()=>{console.error("PORTA_BACKEND_TESTE_INDISPONIVEL");process.exit(1)});s.listen(13382,process.env.IST_D74_BACKEND_HOST,()=>s.close());'
runid=$(cat /proc/sys/kernel/random/uuid)
cid='';nginxid='';criouvolume=false;criouDir=false;iniciou=false
limpar(){
  codigo=$?
  trap - EXIT
  set -e
  for id in "$nginxid" "$cid"; do
    if [[ -n $id ]]; then
      [[ $(docker inspect --format '{{.Id}}' "$id") == "$id" ]]
      [[ $(docker inspect --format '{{index .Config.Labels "ist.d74.run"}}' "$id") == "$runid" ]]
      docker stop --time 15 "$id" >/dev/null
      docker rm "$id" >/dev/null
    fi
  done
  if [[ $criouvolume == true ]]; then
    [[ $(docker volume inspect --format '{{index .Labels "ist.d74.run"}}' "$volume") == "$runid" ]]
    [[ -z $(docker ps -aq --filter "volume=$volume") ]]
    docker volume rm "$volume" >/dev/null
  fi
  if [[ $criouDir == true ]]; then
    [[ $(realpath "$dir") == "$dir" && ! -L $dir ]]
    for arquivo in root-password manifest.json entrypoint.sh nginx.conf cert.pem key.pem; do
      if [[ -e $dir/$arquivo ]]; then [[ -f $dir/$arquivo && ! -L $dir/$arquivo ]];rm -- "$dir/$arquivo";fi
    done
    rmdir -- "$dir"
  fi
  if [[ $iniciou == true && -z $(docker ps -q) ]]; then systemctl stop docker.service docker.socket containerd.service;fi
  echo "D74_DESCARTE: recursos exclusivos removidos; imagens preservadas; resultado=$codigo."
  exit "$codigo"
}
trap limpar EXIT
systemctl start docker.service;iniciou=true
for nome in "$dbnome" "$nginxnome"; do if docker container inspect "$nome" >/dev/null 2>&1;then echo 'Container preexistente; interromper.' >&2;exit 1;fi;done
if docker volume inspect "$volume" >/dev/null 2>&1;then echo 'Volume preexistente; interromper.' >&2;exit 1;fi
install -d -m 0700 -o ist_user -g ist_user "$dir";criouDir=true
umask 077
if [[ $versao == 10339 ]]; then
  digest=sha256:a4b57b620852e26f2c306c79fd8a61e22c7cd6e55d0a55d5521854ed2c370102
  imagem="docker.io/library/mariadb@$digest";docker pull "$imagem"
  schema="ist_loja_67_3_$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')"
  od -An -N32 -tx1 /dev/urandom | tr -d ' \n' > "$dir/root-password"
  chown ist_user:ist_user "$dir/root-password"
  docker volume create --label "ist.d74.run=$runid" "$volume" >/dev/null;criouvolume=true
  cid=$(docker create --name "$dbnome" --label "ist.d74.run=$runid" --restart=no --memory=1g --cpus=2 --pids-limit=256 \
    -p 127.0.0.1:13339:3306 --mount "source=$volume,target=/var/lib/mysql" \
    --mount "type=bind,src=$dir/root-password,dst=/run/secrets/root-password,readonly" \
    -e MYSQL_ROOT_PASSWORD_FILE=/run/secrets/root-password -e MYSQL_ROOT_HOST=% "$imagem")
  docker cp "$cid:/usr/local/bin/docker-entrypoint.sh" "$dir/entrypoint.sh"
  grep -Eq "(file_env|_mariadb_file_env).*['\"]MYSQL_ROOT_PASSWORD['\"]" "$dir/entrypoint.sh"
  [[ $(docker inspect --format '{{(index .HostConfig.PortBindings "3306/tcp" 0).HostIp}}:{{(index .HostConfig.PortBindings "3306/tcp" 0).HostPort}}' "$cid") == 127.0.0.1:13339 ]]
  printf '{"containerName":"%s","containerId":"%s","imageDigest":"%s","runId":"%s","volume":"%s","host":"127.0.0.1","port":13339,"schema":"%s"}\n' \
    "$dbnome" "$cid" "$digest" "$runid" "$volume" "$schema" > "$dir/manifest.json"
  chown ist_user:ist_user "$dir/manifest.json"
  docker start "$cid" >/dev/null
  export IST_R2_10339_MANIFEST="$dir/manifest.json"
  export WSLENV="$WSLENV:IST_R2_10339_MANIFEST"
else
  export IST_LOJA_PAGAMENTOS_MARIADB_BIN='C:\Program Files\MariaDB 13.0\bin'
  export WSLENV="$WSLENV:IST_LOJA_PAGAMENTOS_MARIADB_BIN"
fi
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=localhost -addext subjectAltName=DNS:localhost \
  -keyout "$dir/key.pem" -out "$dir/cert.pem" >/dev/null 2>&1
"$node" 'C:\inetpub\wwwroot\istbrasil.org.br\scripts\loja-d74a-nginx-config.mjs' > "$dir/nginx.conf"
nginximagem=docker.io/library/nginx@sha256:970364228b1e4f932abc22d321932816782cca8a20b85a77552a7cfe9acfb3b5
docker pull "$nginximagem"
nginxid=$(docker create --name "$nginxnome" --label "ist.d74.run=$runid" --restart=no --read-only --memory=256m --cpus=2 --pids-limit=128 \
  --tmpfs /tmp --tmpfs /var/cache/nginx -p 127.0.0.1:13381:8080 \
  --mount "type=bind,src=$dir/nginx.conf,dst=/etc/nginx/nginx.conf,readonly" \
  --mount "type=bind,src=$dir/cert.pem,dst=/run/test/cert.pem,readonly" \
  --mount "type=bind,src=$dir/key.pem,dst=/run/test/key.pem,readonly" \
  --mount "type=bind,src=$repo/dist/sakai-ng/browser,dst=/usr/share/nginx/html,readonly" \
  --entrypoint nginx "$nginximagem" -g 'daemon off;')
[[ $(docker inspect --format '{{(index .HostConfig.PortBindings "8080/tcp" 0).HostIp}}:{{(index .HostConfig.PortBindings "8080/tcp" 0).HostPort}}' "$nginxid") == 127.0.0.1:13381 ]]
docker start "$nginxid" >/dev/null;docker exec "$nginxid" nginx -t
echo "D74_AMBIENTE: rodada $versao; Nginx $nginxid; backend virtual isolado; nenhuma chamada SMTP/PayPal externa."
"$node" --test --test-reporter=spec 'C:\inetpub\wwwroot\istbrasil.org.br\tests\lojaRecuperacaoAngularReal.integration.test.js'
echo 'D74_EXIT_CODE=0'
