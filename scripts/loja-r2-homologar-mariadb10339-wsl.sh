#!/usr/bin/env bash
# Iniciar manualmente com sudo no Ubuntu. Senha somente no terminal.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo 'Executar com sudo no terminal.' >&2; exit 1; }
[[ ${SUDO_USER:-} == ist_user ]] || { echo 'Usuario sudo esperado: ist_user.' >&2; exit 1; }
source /etc/os-release
[[ $ID == ubuntu && $VERSION_ID == 26.04 && $(uname -m) == x86_64 ]]
nome=ist-r2-mariadb10339
volume=ist-r2-mariadb10339-data
dir=/home/ist_user/.local/state/ist-r2-mariadb10339
sql=/mnt/c/inetpub/wwwroot/istbrasil.org.br/migrations/ist_loja_catalogo_expansao_r2.sql
teste='C:\inetpub\wwwroot\istbrasil.org.br\tests\lojaCatalogoExpansaoR2.mariadb10339.test.js'
case ${1:-r2} in
  r2) ;;
  r3) teste='C:\inetpub\wwwroot\istbrasil.org.br\tests\lojaCatalogoR3.mariadb10339.test.js' ;;
  d51) teste='C:\inetpub\wwwroot\istbrasil.org.br\tests\lojaDownloadsSchema.integration.test.js' ;;
  d52b1) teste='C:\inetpub\wwwroot\istbrasil.org.br\tests\lojaArquivoService.test.js' ;;
  d52b2) teste='C:\inetpub\wwwroot\istbrasil.org.br\tests\lojaPedidoDireitos.integration.test.js' ;;
  d52b3b1) teste='C:\inetpub\wwwroot\istbrasil.org.br\tests\lojaDownloadFinanceiroService.test.js' ;;
  d52b3b2) teste='C:\inetpub\wwwroot\istbrasil.org.br\tests\lojaDownloadDireitosService.test.js' ;;
  d52b3b3) teste='C:\inetpub\wwwroot\istbrasil.org.br\tests\lojaDownloadHomologacao.integration.test.js' ;;
  d6b1) teste='C:\inetpub\wwwroot\istbrasil.org.br\tests\lojaDownloadAutorizacaoService.test.js' ;;
  d6b3) teste='C:\inetpub\wwwroot\istbrasil.org.br\tests\lojaDownloadsHttp.integration.test.js' ;;
  d6b4) teste='C:\inetpub\wwwroot\istbrasil.org.br\tests\lojaDownloadPercursoHttp.integration.test.js' ;;
  *) echo 'Selecionar exclusivamente r2, r3, d51, d52b1, d52b2, d52b3b1, d52b3b2, d52b3b3, d6b1, d6b3 ou d6b4.' >&2; exit 1 ;;
esac
node='/mnt/c/Program Files/nodejs/node.exe'
digest=sha256:a4b57b620852e26f2c306c79fd8a61e22c7cd6e55d0a55d5521854ed2c370102
imagem="docker.io/library/mariadb@$digest"
[[ ! -e $dir && ! -L $dir ]]
[[ $(sha256sum "$sql" | cut -d' ' -f1) == d93e85e4660179372cd47ed2329cbec7f51c67baeb580733fd97c4257938a5d5 ]]
[[ -x $node ]]
if ss -H -ltn 'sport = :13339' | grep -q .; then echo 'Porta 13339 ocupada.' >&2; exit 1; fi
for unidade in docker.service docker.socket containerd.service; do
  if systemctl is-enabled --quiet "$unidade"; then echo "Unidade habilitada inesperada: $unidade" >&2; exit 1; fi
  if systemctl is-active --quiet "$unidade"; then echo "Servico preexistente ativo: $unidade; solicitar revisao." >&2; exit 1; fi
done
cid=''
falha() {
  codigo=$?
  echo "Homologacao interrompida (codigo $codigo). Ambiente preservado, sem limpeza automatica." >&2
  echo "Container: $nome; ID: ${cid:-nao-criado}; volume: $volume; porta: 13339; diretorio: $dir" >&2
  echo 'Nao repetir o executor. Informar o diagnostico ao responsavel; nao enviar segredos.' >&2
  exit "$codigo"
}
trap falha ERR
systemctl start docker.service
if docker container inspect "$nome" >/dev/null 2>&1 || docker volume inspect "$volume" >/dev/null 2>&1; then
  echo 'Nome de container/volume ja existe; nao reutilizar.' >&2; false
fi
docker pull --platform linux/amd64 "$imagem"
[[ $(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$imagem") == linux/amd64 ]]
echo "Imagem fixada: $imagem"
runid=$(cat /proc/sys/kernel/random/uuid)
schema="ist_loja_67_3_$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')"
install -d -m 0700 -o ist_user -g ist_user "$dir"
umask 077
od -An -N32 -tx1 /dev/urandom | tr -d ' \n' > "$dir/root-password"
chown ist_user:ist_user "$dir/root-password"
[[ $(stat -c '%a' "$dir/root-password") == 600 ]]
docker volume create --label "ist.r2.run=$runid" "$volume" >/dev/null
cid=$(docker create --name "$nome" --label "ist.r2.run=$runid" --restart=no \
  --memory=1g --cpus=2 --pids-limit=256 \
  -p 127.0.0.1:13339:3306 \
  --mount "source=$volume,target=/var/lib/mysql" \
  --mount "type=bind,src=$dir/root-password,dst=/run/secrets/root-password,readonly" \
  -e MYSQL_ROOT_PASSWORD_FILE=/run/secrets/root-password \
  -e MYSQL_ROOT_HOST=% "$imagem")
[[ $cid =~ ^[0-9a-f]{64}$ ]]
# Inspecionar entrypoint DA IMAGEM EXATA antes de iniciar qualquer servidor.
docker cp "$cid:/usr/local/bin/docker-entrypoint.sh" "$dir/entrypoint.sh"
grep -q 'file_env()' "$dir/entrypoint.sh"
grep -Eq "(file_env|_mariadb_file_env).*['\"]MYSQL_ROOT_PASSWORD['\"]" "$dir/entrypoint.sh"
grep -q 'fileVar' "$dir/entrypoint.sh"
echo 'Mecanismo MYSQL_ROOT_PASSWORD_FILE confirmado no entrypoint extraido.'
[[ $(docker inspect --format '{{(index .HostConfig.PortBindings "3306/tcp" 0).HostIp}}:{{(index .HostConfig.PortBindings "3306/tcp" 0).HostPort}}' "$cid") == 127.0.0.1:13339 ]]
[[ $(docker inspect --format '{{.HostConfig.RestartPolicy.Name}}' "$cid") == no ]]
printf '{"containerName":"%s","containerId":"%s","imageDigest":"%s","runId":"%s","volume":"%s","host":"127.0.0.1","port":13339,"schema":"%s"}\n' \
  "$nome" "$cid" "$digest" "$runid" "$volume" "$schema" > "$dir/manifest.json"
chown ist_user:ist_user "$dir/manifest.json"
docker start "$cid" >/dev/null
export IST_R2_10339_MANIFEST="$dir/manifest.json"
export WSLENV="${WSLENV:+$WSLENV:}IST_R2_10339_MANIFEST"
"$node" --test "$teste"
if [[ ${1:-r2} == d52b3b3 || ${1:-r2} == d6b1 || ${1:-r2} == d6b3 || ${1:-r2} == d6b4 ]]; then echo 'CODIGO_DE_SAIDA_TESTES=0'; fi
# Somente sucesso permite descarte; validar identidade novamente, inclusive volume.
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
