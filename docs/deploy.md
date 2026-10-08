# Deploy seguro IST Brasil — diagnóstico, dependências e recuperação isolada

## Estado real desta versão

`--check` implementado. `--deploy` e `--rollback` são **bloqueados intencionalmente**. `deploy.sh` permanece inalterado e não faz backup, recuperação, publicação ou reinício. A Fase 1 acrescenta módulos independentes de backup e recuperação **somente em workspace temporário isolado**, sem conectar essas operações ao script de produção.

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

Rollback de produção não está comprovado. A restauração isolada descrita abaixo não troca releases, publica frontend ou reconfigura PM2. A arquitetura aprovada para a fase futura prepara cada backend com seus próprios node_modules, evitando npm ci no diretório ativo. Nenhuma implantação é permitida até testar também ativação e recuperação reais no PM2, publicação parcial, arquivos persistentes e saúde da aplicação.

`--deploy`/`--rollback`, após diagnóstico válido, exigem lock previamente provisionado em `/var/www/istbrasil.org.br/.deploy.lock`; não criam arquivos de infraestrutura. Usam flock exclusivo sem espera, depois recusam publicação/recuperação. Em ambiente com conflito de peers, abortam antes do lock porque nenhuma operação mutante é possível. Essa ordem deverá mudar quando operações reais forem autorizadas: adquirir lock antes de qualquer preparação/validação que proteja mutações e revalidar o estado.

## Fase 1 implementada — backup e recuperação isolada

Arquivos: `scripts/deploy/state.mjs`, `scripts/deploy/backup.mjs`, `tests/deploy-backup.test.mjs` e `tests/deploy.integration.test.sh`. Usam somente módulos nativos do Node; não executam Git, npm, shell, aplicação, PM2 ou consultas de banco. Os testes executam apenas um backend sintético para comprovar que os módulos restaurados são utilizáveis.

`createIsolation()` cria um diretório `ist-deploy-isolated-*` diretamente no diretório temporário canônico do sistema, com marcador exato `ISOLATED.json`. Os módulos recusam fontes externas: backend e frontend precisam estar sob `sources/` nesse workspace. Não existe CLI para operar sobre a VPS. Não copiar produção ou credenciais para esses testes.

API, utilizada pelas fixtures:

```javascript
const backup = await createBackup({ isolation, backend, frontend, commit: shaCompleto });
const manifest = await verifyBackup(isolation, backup.id);
const restored = await restoreBackup({ isolation, id: backup.id });
```

As fontes são árvores fictícias criadas pelo teste. O SHA deve ter 40 caracteres hexadecimais; nesta fase é metadado fornecido, não comprovação por Git de que a árvore corresponde ao commit.

Formato escolhido nesta fase: snapshot em diretório privado, sem TAR/compressão ou ferramentas adicionais:

```text
<workspace temporário>/
  ISOLATED.json
  WORKSPACE.lock                 # existe somente durante a operação ou enquanto exige revisão
  sources/                       # somente fixtures fictícias
  backups/<UUID>/
    payload/backend/             # código, sem node_modules/persistentes
    payload/modules/             # node_modules separados
    payload/frontend/
    manifest.json
    manifest.sha256
    READY
  journal/<UUID>.json
  restored/<UUID>/
    backend/node_modules/
    frontend/
    RESTORED.json
```

Em Linux, armazenamento administrativo é 700, arquivos regulares de payload/manifesto/journal/lock são 600 e precisam pertencer ao usuário operacional do teste. O manifesto registra caminhos relativos, tipos, tamanhos, SHA-256 de arquivos/destinos de links, modos originais, UID/GID, Node, plataforma, arquitetura e ABI. Conteúdo é lido/copiado em blocos de 64 KiB. A restauração reaplica modos; não faz chown. Windows não comprova permissões POSIX nem durabilidade por fsync de diretórios.

O backup exclui sem percorrer `.env*` (incluindo `.env`, `.env.backup` e `.env_old`), `istbrasil.private`, `uploads`, `backend-php` e `istdbadmin`, além de `.git`, `.npmrc`, `.ssh`, `.aws`, `.pm2`, `.deploy`, database/development, dist/cache Angular, chaves/certificados com extensões protegidas e sessões SQLTools. A lista exata integra o manifesto. Isso é exclusão por caminho, não um detector de segredos embutidos em código. Arquivos desses caminhos nunca são restaurados ou apagados; não se trata de backup de dados persistentes ou banco.

O link original `html/istdbadmin` permanece intocado e não é desreferenciado nem recriado no destino isolado. Os 119 documentos privados dos testes são gerados com conteúdo fictício. Nenhum documento real é utilizado. Links relativos internos de node_modules são preservados; links absolutos, externos, para caminhos protegidos, links no caminho administrativo e arquivos regulares com hardlinks são recusados. Tipos especiais e bits setuid/setgid/sticky também exigem revisão. Se um pacote precisar de um arquivo excluído, será necessário revisar a política antes da fase de produção.

Verificação exige manifesto válido, SHA-256 do manifesto, lista exata de entradas, hashes/tamanhos de payload, permissões privadas, selo READY e journal de backup completo. Mudanças na fonte durante a captura são verificadas por conteúdo/metadados e uma segunda varredura. Isso não substitui um snapshot atômico do filesystem; a fonte deve permanecer estável. SHA-256 detecta corrupção, mas não autentica um backup contra alguém capaz de substituir todos os arquivos e hashes.

Cada restauração cria um UUID novo em `restored/`, sem aceitar destino arbitrário ou sobrescrever uma recuperação anterior. Verifica o backup antes de criar o destino, compara plataforma/arquitetura/ABI e copia código/módulos/frontend. A integridade é conferida enquanto diretórios ainda são 700 e arquivos 600; o backup original também é verificado novamente. Somente depois aplica modos originais dos arquivos e dos diretórios, com diretórios filhos antes dos pais. Em Linux, os descritores são abertos antes de restringir permissões, e fstat/fsync confirmam os modos sem exigir nova leitura após um modo 000. Só então grava RESTORED.json e conclui/confere o journal. O destino externo da restauração permanece 700. A fixture `.node` comprova cópia binária, não carregamento real de bcrypt/sharp; esse teste continua exigido na fase futura.

Journal: envelope JSON com SHA-256, eventos e transições permitidas. Escritas usam arquivo exclusivo, fsync e publicação atômica; em Linux também sincronizam os diretórios. Transições de backup: started → copying → verifying → complete; de restauração: started → verifying → copying → checking → complete. Falhas tratáveis tentam registrar e conferir failed, preservando os artefatos parciais. Se isso também falhar, a exceção original é relançada intacta; a falha secundária fica em journalError quando o objeto permite esse diagnóstico. Erros de limpeza também não substituem a exceção original. Erros não extensíveis conservam sua identidade, mesmo sem receber a propriedade secundária.

`createBackup()` e `restoreBackup()` adquirem o mesmo WORKSPACE.lock por criação exclusiva, antes da inspeção do journal/fontes, e o mantêm durante toda a operação. Isso impede backup/backup, backup/restauração e restauração/restauração concorrentes, inclusive entre processos. O lock registra token, transação, operação, PID e instante; PID/idade nunca autorizam remoção automática. Um lock existente, mesmo inválido ou de processo encerrado, bloqueia a operação.

Somente a operação que criou o lock pode removê-lo, após confirmar seu resultado ou um failed verificável, conferindo inode/token antes da remoção. Se aquisição, journal ou confirmação final forem incertos, o lock permanece para revisão. Se um complete ficar visível após rename mas a gravação durável/confirmação falhar, não há retorno de sucesso: inspectTransactions sinaliza unconfirmed/incomplete e verifyBackup recusa aquele backup enquanto seu lock estiver presente. A ausência do lock é necessária para confirmar o resultado da operação, além do journal e dos selos.

`inspectTransactions()` identifica estados incompletos e bloqueia novas cópias/restaurações. O teste SIGKILL interrompe uma cópia real, verifica concorrência entre processos e comprova que registrar failed sozinho não remove o lock abandonado. A recuperação do backup anterior só acontece após revisão explícita da transação e remoção manual do lock da fixture cujo processo já terminou. Não há retomada automática, limpeza de locks abandonados, garbage collection, retenção automática ou coordenação de deploy. A exclusão mútua de operações de produção continua pertencendo ao flock do deploy e deverá ser implementada antes de conectar os módulos.

O diagnóstico existente continua com suas proteções originais: a presença de `.env_old` ainda pode bloquear a allowlist de `deploy.sh`. Sua preservação pelo novo módulo não amplia essa allowlist nem dispensa a revisão necessária antes da Fase 2.

Execução local sem dependências adicionais:

```bash
node --check scripts/deploy/state.mjs
node --check scripts/deploy/backup.mjs
node --test tests/deploy-backup.test.mjs
# Linux, usuário não root:
bash tests/deploy.integration.test.sh
```

Suíte Linux com fixtures reais de filesystem, dados sintéticos, links, permissões, corrupção, schema malicioso e SIGKILL durante uma cópia real parcialmente concluída. Regressões adicionais cobrem as quatro combinações concorrentes, locks antigos/inválidos, falhas de publicação e fsync do journal, preservação de erros e restauração com modos 000. Falhas I/O são injetadas exclusivamente nas chamadas nativas da fixture com mocks do runner Node; a cópia/hash/validação restantes continuam reais e os mocks são restaurados por teste. No Windows, os nove casos exclusivamente Linux são explicitamente marcados como skip; a falha após rename é injetada diretamente, pois fsync de diretório não é executado nessa plataforma. O runner Linux recusa Windows e root; não simula resultado PASS quando o ambiente necessário está ausente. O contêiner de validação usa Node 20.19.6, usuário 1000:1000, sem rede/capabilities, filesystem raiz somente leitura e apenas módulos/testes/deploy.sh montados como leitura; os dados são criados em /tmp e descartados ao fim.

Resultados após a revisão desta fase: 42 testes em Linux passaram, sem falhas ou skips; no Windows passaram 33, sem falhas, com os nove skips Linux esperados. São 12 casos adicionais, preservando os 30 existentes e ampliando o cenário SIGKILL. Na implementação inicial também passaram os 52 casos existentes de diagnóstico, as cinco verificações de dependências e a validação sintática Bash/Node. Essa suíte de diagnóstico não foi repetida na revisão, pois deploy.sh e seus testes permaneceram inalterados. Não foram repetidos testes Angular, build ou instalação de dependências, pois os módulos não são conectados à aplicação.

Para reproduzir o isolamento em um host Linux com Docker já disponível, a partir da raiz do projeto e com a imagem oficial previamente obtida:

```bash
docker run --rm --pull=never --network none --read-only \
  --cap-drop ALL --security-opt no-new-privileges --user 1000:1000 \
  --tmpfs /tmp:rw,nosuid,nodev,size=256m,mode=1777 \
  --mount "type=bind,source=$PWD/scripts/deploy,target=/work/scripts/deploy,readonly" \
  --mount "type=bind,source=$PWD/tests/deploy-backup.test.mjs,target=/work/tests/deploy-backup.test.mjs,readonly" \
  --mount "type=bind,source=$PWD/tests/deploy.integration.test.sh,target=/work/tests/deploy.integration.test.sh,readonly" \
  --mount "type=bind,source=$PWD/deploy.sh,target=/work/deploy.sh,readonly" \
  --workdir /work \
  node@sha256:b342de02eb4a57cd6986290a69833d20818508db8078dba0197a024193410aee \
  bash tests/deploy.integration.test.sh
```

A imagem validada é `node:20.19.6-bookworm-slim` (Debian Linux), fixada por digest. Não montar `.env`, node_modules do projeto, dados privados, o socket Docker ou a árvore inteira do repositório no contêiner.

Essa validação Linux não equivale a validação da VPS Ubuntu 20.04, das dependências reais ou dos serviços. Recuperação após perda do host, snapshots consistentes de banco, criptografia/cópia externa e persistência em reboot permanecem fora desta fase.

## Fase 2 planejada, não implementada

Antes de habilitar publicação: adaptar os módulos isolados a caminhos administrativos aprovados com validações de produção, baseline da versão ativa, metadados Git/PM2 restritos e dimensionamento de espaço/inodes. Nenhum env em área pública. Preparar backend em releases com dependências próprias, alvo publicado e SHA explícito, instalação/build antes de ativação; frontend por manifesto com índice por último; preservação de istdbadmin e arquivos desconhecidos; recuperação comprovada do backend/PM2 e publicação parcial. Permanecem pendentes coordenação/locks, janela de interrupção, health checks, política de retenção e configuração de reboot.

Traps de deploy.sh somente registram estágio e abortam. Não fazem rollback. O journal isolado não é integrado ao deploy; sua adoção em produção exige revisão e testes adicionais. Não alegar zero downtime. Não haverá SQL/migrations nem reload Nginx automático.

## Testes locais

`bash -n deploy.sh`; `bash -n tests/deploy.test.sh`; `bash tests/deploy.test.sh`.

Testes usam cópia do script com caminhos temporários, /proc fictício e marcador regular no lugar de socket Unix; ferramentas simuladas para NSS, ACLs, stat e ss. O código Node de identidade/ancestralidade PM2 é executado de verdade sobre as fixtures, incluindo pm2.pid sem LF final. No Windows, um adaptador exclusivo de teste traduz caminhos e fornece semântica de caminhos Linux; não altera deploy.sh. O restante do diagnóstico de dependências usa mock mais cinco verificações de dependências: manifesto/lock real compatível e versões Angular preservadas; sete conflitos Angular/PrimeNG isolados; hono obrigatório ausente; peer opcional ausente; peer opcional instalado incompatível. Esses casos executam o trecho real da proteção de peers de deploy.sh; as fixtures negativas existem somente em memória e não alteram o lock real. É possível focar um cenário com DEPLOY_TEST_CASE=<nome> bash tests/deploy.test.sh. Não executar a cópia contra caminhos produtivos. Os testes de build/publicação/PM2 verificam **que essas fases não são alcançadas**, não validam execução/rollback dessas fases. As verificações de dependências da suíte Bash não instalam pacotes nem usam rede.

## Antes de qualquer execução na VPS

Histórico da correção de dependências: 333 testes Angular completos, 131 testes focados do jurado, quatro testes de eventos com consultas simuladas, 52 cenários isolados de deploy e cinco verificações de dependências passaram. O build final de produção passou, com avisos CommonJS de page-flip e quill-delta; nenhum ajuste foi feito nesses pacotes. As instalações, testes e builds usam uma cópia temporária; node_modules e serviços do workspace ativo foram preservados. A suíte backend completa não foi executada; a divergência preexistente em festivalParticipation.test.js não foi corrigida nesta tarefa. Esses resultados de aplicação não foram repetidos na Fase 1 de backup.

A validação de dependências descrita acima foi realizada no Windows. Na Fase 1 de backup, Docker já estava disponível e foi utilizado para executar os testes isolados em Linux; nenhum serviço existente foi reiniciado. Isso não valida o build Angular ou os binários bcrypt/sharp reais em Ubuntu. A validação visual manual de Aura, modo escuro, overlays e formulários permanece pendente.

Revisão humana obrigatória. Conferir layout, admin/PM2_HOME, privilégios de leitura de /proc/ss, permissões e allowlist sem publicar segredos. O script não consegue comprovar ausência de processos que nem aparecem na visão de ps/ss de admin. Permissões reais de /proc, hidepid, containers/namespaces, formato do título PM2, ancestralidade fork/cluster e registros NSS precisam ser conferidos na VPS. Falhas nas leituras exigidas bloqueiam, mas uma enumeração aparentemente completa não é prova de visibilidade global. A enumeração getent passwd pode ser limitada por diretórios externos: antes de aceitar 640 é necessário confirmar exclusividade real do grupo. As inspeções não são um snapshot atômico; mudanças de processos durante a leitura podem causar aborto conservador. Não executar sudo pm2, reiniciar daemons ou matar processos para contornar falhas.

Validar a instalação e regressão também em Linux, incluindo aparência Aura/modo escuro, overlays, formulários e sincronização Slider/InputNumber dos jurados. PrimeNG 21 usa animações CSS e deixa showTransitionOptions/hideTransitionOptions sem efeito; essas propriedades não foram encontradas no código atual. Implementar/testar a Fase 2 e aprovar comando/commit/backup concretos antes de habilitar deploy. Nenhum deploy antigo foi encontrado para comparação linha a linha.
