# Deploy seguro IST Brasil — diagnóstico e dependências

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

## Dependências e instalação reproduzível

O manifesto fixa PrimeNG 21.0.0 e @primeuix/themes 2.0.2. O lock preserva Angular/CLI/compiler-cli/build-angular 21.1.1 e CDK 21.2.14. PrimeNG 21 aceita Angular/CDK ^21 e exige styles ^2.0.2, styled ^0.7.4, utils ^0.6.3 e motion ^0.0.10. As versões resolvidas são styles 2.0.3, styled 0.7.4, utils 0.6.4 e motion 0.0.10. Aura continua configurado via @primeuix/themes/aura; não remover as animações Angular próprias do menu.

O npm resolveu hono 4.13.13 como peer transitivo de desenvolvimento de @hono/node-server, pela cadeia @angular/cli → @modelcontextprotocol/sdk. Não existe dependência direta de hono no manifesto nem mudança no backend. O lock também registra dependências opcionais bundled de oxide-wasm32-wasi que estavam ausentes, sem atualizar Tailwind 4.1.11. Fora de PrimeNG/PrimeUIX, nenhuma versão de pacote já existente foi atualizada; PayPal foi preservado.

Node 20.19.6 atende aos engines declarados da árvore. TypeScript 5.9.3, RxJS 7.8.2 e Zone.js 0.15.1 permanecem. O diagnóstico aborta ao detectar peers incompatíveis ou obrigatórios ausentes; sem `--legacy-peer-deps`, `--force` ou mudança automática de lock/dependências. Semver e dotenv locais também são necessários para diagnóstico; não são instalados pelo script. A verificação de peers do deploy consulta as entradas na raiz do lock; árvores futuras com peers resolvidos em caminhos aninhados precisam de revisão dessa verificação.

A validação deve ocorrer em uma cópia isolada, nunca no backend ativo: npm ci substitui node_modules. Mesmo com NODE_ENV=production, incluir ferramentas de desenvolvimento para compilar:

```bash
npm ci --include=dev --strict-peer-deps
npm ls --all
npm test -- --watch=false --browsers=ChromeHeadless
npm run build -- --configuration production
bash tests/deploy.test.sh
```

Confirmar que npm ci não modifica manifesto/lock, que não há peers inválidos/ausentes e que o build gera dist/sakai-ng/browser. A resolução local usou Node 20.19.6/npm 10.8.2. Instalações limpas Windows isoladas foram executadas com npm 10.8.2 e npm 11.7.0 (ferramenta temporária, sem atualizar o npm global), ambas com peers estritos e sem alterar manifesto/lock. Sharp e bcrypt também foram exercitados em memória no Windows; isso não valida seus binários Linux. Nenhum modo deste script instala pacotes ou executa build.

npm 11.7.0 ls --all retornou código zero, sem peers inválidos ou obrigatórios ausentes, mas apontou duas entradas extraneous: @img/sharp-wasm32 0.35.4 e @emnapi/runtime 1.11.3. Ambas já constavam, com os mesmos metadados, no lock anterior e pertencem aos wrappers opcionais de sharp para FreeBSD/WebContainers, não ativos no Windows. Não foram removidas nem ocultadas; verificar a árvore efetiva também em Linux antes da produção.

A regressão encontrou ObjectUnsubscribedError ao clicar novamente no aceite da confirmação do jurado. PrimeNG 21 encerra o emissor no primeiro aceite e mantém a confirmação durante o fechamento. O componente agora vincula acceptVisible a confirmando, removendo o controle de aceite depois da confirmação, sem alterar payloads ou regras de gravação. O teste aplica a renderização Angular entre os dois cliques, verifica que o controle foi removido e mantém todas as assertions de um único PUT e do estado concluído.

## Bloqueadores de publicação

Rollback não está comprovado: npm ci substituiria node_modules no diretório ativo, arquivos rastreados privados precisam ser protegidos, e rollback de Git sem reset/merge não pode descartar dados. Nenhuma implantação é permitida até definir e testar restauração de código, dependências nativas (bcrypt/sharp), frontend, configurações e Git sem perder alterações ou persistentes.

`--deploy`/`--rollback`, após diagnóstico válido, exigem lock previamente provisionado em `/var/www/istbrasil.org.br/.deploy.lock`; não criam arquivos de infraestrutura. Usam flock exclusivo sem espera, depois recusam publicação/recuperação. Em ambiente com conflito de peers, abortam antes do lock porque nenhuma operação mutante é possível. Essa ordem deverá mudar quando operações reais forem autorizadas: adquirir lock antes de qualquer preparação/validação que proteja mutações e revalidar o estado.

## Recuperação planejada, não implementada

Antes de habilitar publicação: baseline da versão ativa com código, node_modules, manifest frontend e metadados Git/PM2 restritos; hashes e validação de recuperação. Nenhum env em área pública. Atualização somente fast-forward para SHA explícito; instalação/build antes de publicação; índice por último; gerenciamento exclusivo de arquivos do manifest, preservando istdbadmin e arquivos desconhecidos; restauração comprovada do backend incluindo dependências. Necessária decisão sobre pausa controlada da API durante substituição in-place, para evitar arquivos/dependências inconsistentes.

Traps atuais somente registram estágio e abortam. Não fazem rollback. SIGKILL/quedas exigirão journal de recuperação na versão futura. Não alegar zero downtime. Não haverá SQL/migrations nem reload Nginx automático.

## Testes locais

`bash -n deploy.sh`; `bash -n tests/deploy.test.sh`; `bash tests/deploy.test.sh`.

Testes usam cópia do script com caminhos temporários, /proc fictício e marcador regular no lugar de socket Unix; ferramentas simuladas para NSS, ACLs, stat e ss. O código Node de identidade/ancestralidade PM2 é executado de verdade sobre as fixtures, incluindo pm2.pid sem LF final. No Windows, um adaptador exclusivo de teste traduz caminhos e fornece semântica de caminhos Linux; não altera deploy.sh. O restante do diagnóstico de dependências usa mock mais cinco verificações de dependências: manifesto/lock real compatível e versões Angular preservadas; sete conflitos Angular/PrimeNG isolados; hono obrigatório ausente; peer opcional ausente; peer opcional instalado incompatível. Esses casos executam o trecho real da proteção de peers de deploy.sh; as fixtures negativas existem somente em memória e não alteram o lock real. É possível focar um cenário com DEPLOY_TEST_CASE=<nome> bash tests/deploy.test.sh. Não executar a cópia contra caminhos produtivos. Os testes de build/publicação/PM2 verificam **que essas fases não são alcançadas**, não validam execução/rollback dessas fases. As verificações de dependências da suíte Bash não instalam pacotes nem usam rede.

## Antes de qualquer execução na VPS

Validação local desta correção: 333 testes Angular completos, 131 testes focados do jurado, quatro testes de eventos com consultas simuladas, 52 cenários isolados de deploy e cinco verificações de dependências passaram. O build final de produção passou, com avisos CommonJS de page-flip e quill-delta; nenhum ajuste foi feito nesses pacotes. As instalações, testes e builds usam uma cópia temporária; node_modules e serviços do workspace ativo foram preservados. A suíte backend completa não foi executada; a divergência preexistente em festivalParticipation.test.js não foi corrigida nesta tarefa.

Não foi executada validação Linux: o único WSL disponível é docker-desktop parado, sem daemon Docker acessível. Nenhum serviço foi iniciado para contornar essa limitação. A validação visual manual de Aura, modo escuro, overlays e formulários permanece pendente.

Revisão humana obrigatória. Conferir layout, admin/PM2_HOME, privilégios de leitura de /proc/ss, permissões e allowlist sem publicar segredos. O script não consegue comprovar ausência de processos que nem aparecem na visão de ps/ss de admin. Permissões reais de /proc, hidepid, containers/namespaces, formato do título PM2, ancestralidade fork/cluster e registros NSS precisam ser conferidos na VPS. Falhas nas leituras exigidas bloqueiam, mas uma enumeração aparentemente completa não é prova de visibilidade global. A enumeração getent passwd pode ser limitada por diretórios externos: antes de aceitar 640 é necessário confirmar exclusividade real do grupo. As inspeções não são um snapshot atômico; mudanças de processos durante a leitura podem causar aborto conservador. Não executar sudo pm2, reiniciar daemons ou matar processos para contornar falhas.

Validar a instalação e regressão também em Linux, incluindo aparência Aura/modo escuro, overlays, formulários e sincronização Slider/InputNumber dos jurados. PrimeNG 21 usa animações CSS e deixa showTransitionOptions/hideTransitionOptions sem efeito; essas propriedades não foram encontradas no código atual. Definir rollback in-place, escrever testes de falha real e aprovar comando/commit/backup concretos antes de habilitar deploy. Nenhum deploy antigo foi encontrado para comparação linha a linha.
