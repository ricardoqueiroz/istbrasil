# Deploy seguro IST Brasil — Fase 1.1

## Estado real desta versão

`--check` implementado. `--deploy` e `--rollback` são **bloqueados intencionalmente**. Não há implantação, backup, recuperação ou reinício implementados. Isso atende à alternativa de segurança autorizada: não simular garantia de rollback in-place.

O backend continua em `/var/www/istbrasil.org.br/backend-node/istbrasil`; não existe mudança no PM2, Nginx ou dados. O alvo é apenas `origin/main` já disponível localmente; nenhum modo executa fetch nesta versão.

## Diagnóstico

Executar futuramente como `admin`: `bash deploy.sh --check`. Root e outro usuário são recusados. PM2_HOME esperado: `/home/admin/.pm2`. O diagnóstico exige daemon já existente e não chama a CLI PM2 (nem --version/jlist), que poderia inicializá-lo. Confere pm2.pid regular, rpc.sock como socket, ambos sem symlink e com UID de admin; PID ativo; título exato compatível com "PM2 vX.Y.Z: God Daemon (/home/admin/.pm2)". O título sozinho não prova o processo: a API deve possuir os campos esperados name/pm_cwd/pm_exec_path e ancestralidade com UIDs de admin até esse daemon, em até 32 processos, além do cwd e executável Node esperados.

A enumeração de processos usa UIDs numéricos e nomes de comando, sem publicar argumentos completos. PM2 de root identificado pelo nome aborta. Processos de root com nome node/nodejs também têm cmdline lido em memória para detectar PM2; um Node de root comprovadamente não relacionado não bloqueia. Leitura negada ou cmdline vazio de um candidato bloqueia como diagnóstico inconclusivo. Processo que desapareceu durante essa inspeção é ignorado; falhas nos processos admin exigidos abortam.

Cada linha de socket em ss para a porta 3000 precisa revelar exatamente um PID. IPv4/IPv6 com o mesmo PID são aceitos. Qualquer linha oculta, múltiplos PIDs, dono diferente de admin ou identidade/ancestralidade divergente aborta. Não há sudo, início de daemon ou tentativa de encerrar conflitos.

Confere ferramentas, Git main sem mudanças rastreadas/staged, allowlist explícita de não rastreados (inclusive ignorados), diretórios canônicos, symlink phpMyAdmin, configurações privadas, espaço mínimo de 10 GiB, dependências instaladas e peers. Esse limiar não comprova capacidade de backup: a versão executora deverá medir os tamanhos reais.

`.env` e `.env.backup` devem existir como arquivos regulares sem symlink e ter UID de admin. São aceitos exclusivamente modos 600 e 640. Em ambos, o GID deve coincidir com o grupo primário de admin, que não pode ter outros membros explícitos nem ser grupo primário de outra conta enumerada por getent passwd. A enumeração NSS também precisa conter admin com o UID/GID efetivos. Grupos compartilhados, grupo diferente, bits especiais e qualquer outro modo são recusados. getfacl é obrigatório: ACLs nomeadas de usuário/grupo, ACLs default ou leitura inacessível bloqueiam; não há alteração de permissões ou ACLs. Valida apenas `NODE_ENV=production` e `FESTIVAL_II_ETAPA_INSCRICOES_ID=1` na combinação do arquivo dotenv com o ambiente do processo. Lê dados em memória sem imprimir conteúdo, erros brutos ou variáveis completas. Não usa `source .env` nem importa `server.js`.

Git ls-files --others -z enumera não rastreados incluindo ignorados, sem dividir nomes com espaços/quebras de linha. Falha de Git é propagada por pipefail. Configurações exatas .env/.env.backup são aceitas depois das validações anteriores; se rastreadas pelo Git, o diagnóstico aborta. node_modules/, dist/ e .angular/cache/ só são admitidos quando cada entrada também passa git check-ignore. Um arquivo ignorado fora dessas áreas não é automaticamente seguro.

Dados não rastreados em istbrasil.private/ são admitidos exclusivamente com extensão minúscula pdf, png, jpg, jpeg, webp, gif, mp4, webm, mp3, wav, ogg ou m4a, como arquivos regulares não executáveis e com caminho canônico idêntico (sem symlinks no caminho). A extensão é uma classificação operacional, não validação do conteúdo. Scripts, formatos desconhecidos, symlinks e executáveis exigem revisão manual. Arquivos rastreados privados continuam sujeitos à verificação de working tree limpo. uploads/ externo ao repositório não é percorrido nem modificado. Nunca executar git clean ou ampliar a allowlist para todo arquivo ignorado.

## Bloqueadores

O lock local registra Angular 21.1.1 e PrimeNG 20.0.1, que declara Angular ^20. Uma instalação limpa pode falhar. O diagnóstico aborta ao detectar peers incompatíveis; sem `--legacy-peer-deps`, `--force` ou mudança automática de lock/dependências. Semver e dotenv locais também são necessários para diagnóstico; não são instalados pelo script.

Rollback não está comprovado: npm ci substituiria node_modules no diretório ativo, arquivos rastreados privados precisam ser protegidos, e rollback de Git sem reset/merge não pode descartar dados. Nenhuma mudança é permitida até definir e testar restauração de código, dependências nativas (bcrypt/sharp), frontend, configurações e Git sem perder alterações ou persistentes.

`--deploy`/`--rollback`, após diagnóstico válido, exigem lock previamente provisionado em `/var/www/istbrasil.org.br/.deploy.lock`; não criam arquivos de infraestrutura. Usam flock exclusivo sem espera, depois recusam publicação/recuperação. Em ambiente com conflito de peers, abortam antes do lock porque nenhuma operação mutante é possível. Essa ordem deverá mudar quando operações reais forem autorizadas: adquirir lock antes de qualquer preparação/validação que proteja mutações e revalidar o estado.

## Recuperação planejada, não implementada

Antes de habilitar publicação: baseline da versão ativa com código, node_modules, manifest frontend e metadados Git/PM2 restritos; hashes e validação de recuperação. Nenhum env em área pública. Atualização somente fast-forward para SHA explícito; instalação/build antes de publicação; índice por último; gerenciamento exclusivo de arquivos do manifest, preservando istdbadmin e arquivos desconhecidos; restauração comprovada do backend incluindo dependências. Necessária decisão sobre pausa controlada da API durante substituição in-place, para evitar arquivos/dependências inconsistentes.

Traps atuais somente registram estágio e abortam. Não fazem rollback. SIGKILL/quedas exigirão journal de recuperação na versão futura. Não alegar zero downtime. Não haverá SQL/migrations nem reload Nginx automático.

## Testes locais

`bash -n deploy.sh`; `bash -n tests/deploy.test.sh`; `bash tests/deploy.test.sh`.

Testes usam cópia do script com caminhos temporários, /proc fictício e marcador regular no lugar de socket Unix; ferramentas simuladas para NSS, ACLs, stat e ss. O código Node de identidade/ancestralidade PM2 é executado de verdade sobre as fixtures. No Windows, um adaptador exclusivo de teste traduz caminhos e fornece semântica de caminhos Linux; não altera deploy.sh. O restante do diagnóstico de dependências usa mock mais a verificação real do conflito de peers. É possível focar um cenário com DEPLOY_TEST_CASE=<nome> bash tests/deploy.test.sh. Não executar a cópia contra caminhos produtivos. Os testes de build/publicação/PM2 verificam **que essas fases não são alcançadas**, não validam execução/rollback dessas fases. A incompatibilidade real do lock também é conferida com Node/semver local, sem instalação ou rede.

## Antes de qualquer execução na VPS

Revisão humana obrigatória. Conferir layout, admin/PM2_HOME, privilégios de leitura de /proc/ss, permissões e allowlist sem publicar segredos. O script não consegue comprovar ausência de processos que nem aparecem na visão de ps/ss de admin. Permissões reais de /proc, hidepid, containers/namespaces, formato do título PM2, ancestralidade fork/cluster e registros NSS precisam ser conferidos na VPS. Falhas nas leituras exigidas bloqueiam, mas uma enumeração aparentemente completa não é prova de visibilidade global. A enumeração getent passwd pode ser limitada por diretórios externos: antes de aceitar 640 é necessário confirmar exclusividade real do grupo. As inspeções não são um snapshot atômico; mudanças de processos durante a leitura podem causar aborto conservador. Não executar sudo pm2, reiniciar daemons ou matar processos para contornar falhas.

Resolver peers com autorização separada; definir rollback in-place, escrever testes de falha real e aprovar comando/commit/backup concretos antes de habilitar deploy. Nenhum deploy antigo foi encontrado para comparação linha a linha.
