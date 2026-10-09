# Deploy seguro IST Brasil — diagnóstico, dependências e recuperação isolada

## Estado real desta versão

`--check` preserva o diagnóstico somente leitura. `--deploy` e `--rollback` estão integrados aos módulos operacionais, mas continuam **bloqueados por padrão**: exigem um marcador de aprovação criado manualmente após a homologação e o lock externo já provisionado. Sem o marcador, nenhuma preparação, publicação ou troca do PM2 ocorre.

O backend continua em `/var/www/istbrasil.org.br/backend-node/istbrasil`; não existe mudança no PM2, Nginx ou dados. O alvo é apenas `origin/main` já disponível localmente; nenhum modo executa fetch nesta versão.

## Diagnóstico

Executar futuramente como `admin`: `bash deploy.sh --check`. Root e outro usuário são recusados. PM2_HOME esperado: `/home/admin/.pm2`. O diagnóstico exige daemon já existente e não chama a CLI PM2 (nem --version/jlist), que poderia inicializá-lo. Confere pm2.pid regular, rpc.sock como socket, ambos sem symlink e com UID de admin; PID ativo; título exato compatível com "PM2 vX.Y.Z: God Daemon (/home/admin/.pm2)". O título sozinho não prova o processo: a API deve possuir os campos esperados name/pm_cwd/pm_exec_path e ancestralidade com UIDs de admin até esse daemon, em até 32 processos, além do cwd e executável Node esperados.

A enumeração de processos usa UIDs numéricos e nomes de comando, sem publicar argumentos completos. PM2 de root identificado pelo nome aborta. Processos de root com nome node/nodejs também têm cmdline lido em memória para detectar PM2; um Node de root comprovadamente não relacionado não bloqueia. Leitura negada ou cmdline vazio de um candidato bloqueia como diagnóstico inconclusivo. Processo que desapareceu durante essa inspeção é ignorado; falhas nos processos admin exigidos abortam.

Cada linha de socket em ss para a porta 3000 precisa revelar exatamente um PID. IPv4/IPv6 com o mesmo PID são aceitos. Qualquer linha oculta, múltiplos PIDs, dono diferente de admin ou identidade/ancestralidade divergente aborta. Não há sudo, início de daemon ou tentativa de encerrar conflitos.

Confere ferramentas, Git main sem mudanças rastreadas/staged, allowlist explícita de não rastreados (inclusive ignorados), diretórios canônicos, symlink phpMyAdmin, configurações privadas, espaço mínimo de 10 GiB e identidade do runtime. Na primeira implantação, reconhecida pela ausência de `active.json`, valida Node 20.19.6 e os módulos essenciais instalados no runtime legado, mas não compara esse `node_modules` com o lockfile novo do checkout. Releases gerenciadas continuam exigindo correspondência exata entre dependências instaladas, seu próprio lockfile e peers. Esse limiar não comprova capacidade de backup: a versão executora mede os tamanhos reais.

Somente `.env` é obrigatório e contém a configuração real. Deve ser arquivo regular sem symlink, com UID/GID de admin e modo 600 ou 640. `.env.backup` e `.env_old` são legados opcionais: podem estar ausentes e, se existirem, recebem as mesmas validações sem serem sobrescritos, copiados ou recriados. O grupo primário de admin não pode ter outros membros explícitos nem ser grupo primário de outra conta enumerada por getent passwd. getfacl é obrigatório e ACLs nomeadas/default ou leitura inacessível bloqueiam. O diagnóstico lê somente os valores necessários em memória e nunca imprime conteúdo ou variáveis completas.

Git ls-files --others -z enumera não rastreados incluindo ignorados, sem dividir nomes com espaços/quebras de linha. Falha de Git é propagada por pipefail. As configurações exatas `.env`, `.env.backup` e `.env_old` são aceitas depois das validações anteriores; se qualquer uma estiver rastreada, o diagnóstico aborta. node_modules/, dist/ e .angular/cache/ só são admitidos quando cada entrada também passa git check-ignore.

Dados não rastreados em istbrasil.private/ são admitidos exclusivamente com extensão minúscula pdf, png, jpg, jpeg, webp, gif, mp4, webm, mp3, wav, ogg ou m4a, como arquivos regulares não executáveis e com caminho canônico idêntico (sem symlinks no caminho). A extensão é uma classificação operacional, não validação do conteúdo. Scripts, formatos desconhecidos, symlinks e executáveis exigem revisão manual. Arquivos rastreados privados continuam sujeitos à verificação de working tree limpo. uploads/ externo ao repositório não é percorrido nem modificado. Nunca executar git clean ou ampliar a allowlist para todo arquivo ignorado.

## Dependências e instalação reproduzível

O manifesto fixa PrimeNG 21.0.0 e @primeuix/themes 2.0.2. O lock preserva Angular/CLI/compiler-cli/build-angular 21.1.1 e CDK 21.2.14. PrimeNG 21 aceita Angular/CDK ^21 e exige styles ^2.0.2, styled ^0.7.4, utils ^0.6.3 e motion ^0.0.10. As versões resolvidas são styles 2.0.3, styled 0.7.4, utils 0.6.4 e motion 0.0.10. Aura continua configurado via @primeuix/themes/aura; não remover as animações Angular próprias do menu.

O npm resolveu hono 4.13.13 como peer transitivo de desenvolvimento de @hono/node-server, pela cadeia @angular/cli → @modelcontextprotocol/sdk. Não existe dependência direta de hono no manifesto nem mudança no backend. O lock também registra dependências opcionais bundled de oxide-wasm32-wasi que estavam ausentes, sem atualizar Tailwind 4.1.11. Fora de PrimeNG/PrimeUIX, nenhuma versão de pacote já existente foi atualizada; PayPal foi preservado.

Node 20.19.6 atende aos engines declarados da árvore. TypeScript 5.9.3, RxJS 7.8.2 e Zone.js 0.15.1 permanecem. Para releases já gerenciadas, o diagnóstico aborta ao detectar versões instaladas divergentes, peers incompatíveis ou obrigatórios ausentes. No baseline legado da primeira implantação, ele valida os módulos instalados e seus engines sem aplicar o lockfile novo sobre o processo antigo. A candidata sempre passa por `npm ci --include=dev --strict-peer-deps`, sem `--legacy-peer-deps`, `--force` ou mudança automática do lock. Semver e dotenv locais também são necessários para o diagnóstico e não são instalados pelo script.

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

O rollback operacional está implementado e validado apenas em Linux isolado; ainda não foi homologado na VPS. A restauração da Fase 1 descrita abaixo continua sem trocar releases, publicar frontend ou reconfigurar PM2. Releases usam seus próprios node_modules, evitando npm ci no diretório ativo. Nenhuma implantação é permitida enquanto `deploy.sh` permanecer bloqueado e até a homologação específica no ambiente Ubuntu 20.04 do usuário `admin`.

`--deploy`/`--rollback`, após diagnóstico válido, exigem lock previamente provisionado em `/var/www/istbrasil.org.br/.deploy.lock`; não criam esse arquivo. Usam `flock` exclusivo sem espera e, adicionalmente, o lock transacional do módulo operacional. Conflitos de Git, runtime, peers, espaço, PM2 ou configuração abortam antes da mutação. O marcador `/var/www/istbrasil.org.br/.deploy/state/PRODUCTION_APPROVED` precisa ser regular, pertencente a `admin`, modo 600 e conter exatamente `IST_DEPLOY_PRODUCTION_APPROVED_V1` seguido de LF.

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

O diagnóstico aceita `.env.backup` e `.env_old` como legados opcionais na allowlist explícita. Quando presentes, continuam sujeitos às mesmas verificações de tipo, propriedade, modo e ACL de `.env`; sua ausência é válida.

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

## Fase 2.1: contrato de produção e diagnóstico somente leitura

`production-contract.mjs` define caminhos, schemas, política de metadados, capacidade e classificação. `production-inspect.mjs` coleta evidências somente por leitura. Os dois módulos são independentes da Fase 1: não importam `backup.mjs`, `state.mjs`, `server.js` ou `db.js`. As APIs e o isolamento da Fase 1 permanecem intactos. `deploy.sh` não importa nem executa os módulos novos; `--deploy` e `--rollback` continuam bloqueados. Não há preparação, publicação, restauração, adoção de instalação legacy ou mudança de serviços nesta fase.

### Caminhos e permissões

Base fixa do CLI: `/var/www/istbrasil.org.br`. Repositório original: `backend-node/istbrasil`. SHA do repositório não implica identidade da aplicação em execução.

| Caminho sob a base | Contrato |
| --- | --- |
| `.deploy`, `releases`, `backups`, `state`, `state/transactions`, `logs` | Diretórios reais 700, UID/GID operacional de admin; ACL básica |
| `.deploy/releases/<UUID>` | Diretório real 700; `manifest.json` 600; subárvores `backend/` e `frontend/` inventariadas |
| `.deploy/backups/<UUID>` | Diretório real 700; `manifest.json` e `READY` 600; `payload/` 700 |
| `.deploy/state/active.json` | Arquivo regular 600, um único hardlink; existência não é confirmação de publicação |
| `.deploy/state/transactions/<UUID>.json` | Arquivo regular 600, envelope com hash e transições válidas |
| `.deploy/state/operation.lock` e `.deploy.lock` | Arquivos regulares 600; nenhum lock é criado, adquirido ou removido pelo diagnóstico |
| `backend-node/istbrasil/.env` | Obrigatório, regular, sem symlink/hardlink; 600 ou 640 com propriedade/grupo compatíveis com admin |
| `backend-node/istbrasil/.env.backup` e `.env_old` | Opcionais; se existirem, mesma proteção de `.env`; nunca criados ou sobrescritos pelo deploy |
| `html`, `uploads`, `backend-php`, `backend-node/istbrasil/istbrasil.private` | Diretórios originais preservados; diagnóstico não percorre conteúdo privado/persistente |
| `html/istdbadmin` | Symlink preservado para `/usr/share/phpmyadmin`, lido sem seguir seu conteúdo |

Arquivos/diretórios administrativos não podem ser symlinks. Ancestrais precisam ser diretórios reais de root/admin, sem escrita de grupo/outros e sem bits especiais. Modos de payload são registrados no manifesto, recusando escrita de grupo/outros e bits especiais. Proprietários precisam ser root/admin; symlinks de runtime e de pacotes pertencem ao UID/GID de admin. Metadados reais devem coincidir com o manifesto. Nenhuma permissão é corrigida automaticamente.

ACLs são consultadas com `getfacl -cpn`: apenas user/group/other básicos são aceitos; entradas nomeadas, mask e default são recusadas. Falta da ferramenta ou leitura insuficiente gera incerteza. `getent passwd/group` identifica admin. Para aceitar 640, o grupo deve ser exclusivamente de admin e NSS de passwd/group deve ser apenas `files`; provedores externos ou composição não comprovada impedem assumir exclusividade. Isso pode bloquear conservadoramente configurações que exigem revisão humana. A enumeração de produção e ACLs reais precisam de homologação posterior.

### Schemas versão 1

Todos os schemas recusam campos desconhecidos, IDs inválidos, traversal, tipos indevidos e referências incoerentes. IDs são UUIDs em hexadecimal minúsculo; commits são SHA Git de 40 caracteres e hashes SHA-256 têm 64. Datas são UTC canônicas. Arquivos JSON têm leitura limitada a 32 MiB, sem seguir symlink final, com conferência de inode/metadados antes e depois.

`active.json`: `version`, `generation` monotônica a partir de 1, `transactionId`, `previousGeneration`, `confirmedAt`, `backend`, `frontend`, `pm2`. Backend contém `kind: release`, `releaseId`, `commitSha`, `manifestSha256`. Frontend contém seu próprio `releaseId`, `manifestSha256`, `indexSha256`, permitindo registrar gerações diferentes sem presumir compatibilidade funcional. PM2 contém `name: ist-api`, `user: admin`, `home: /home/admin/.pm2`, `cwd` canônico da release, `script` igual a seu `server.js` e `node: 20.19.6`. Não persistir PID como identidade durável nem ambientes/credenciais. Legacy é reconhecido pela ausência de active e execução no repositório original, sem gerar active automaticamente.

Manifesto de release: `version`, `releaseId`, `declaredCommitSha`, `gitProvenance`, `runtime`, `entries`. Runtime registra Linux, arquitetura, Node 20.19.6 e ABI. Entradas possuem `path`, `type`, `mode`, `uid`, `gid`; arquivos acrescentam `size`, `sha256`, symlinks acrescentam `target`. Lista exata, hierarquia de diretórios e arquivos obrigatórios são conferidos. O diretório da release contém exclusivamente backend, frontend e manifesto. Arquivos têm hash calculado em blocos de 64 KiB. O frontend publicado deve corresponder exatamente à subárvore frontend do manifesto, exceto o symlink istdbadmin. Arquivos públicos desconhecidos são divergência; o diagnóstico nunca os apaga.

`gitProvenance` pode ser nulo ou uma alegação armazenada com `commitSha`, `treeSha`, `verifiedAt`. **Uma alegação armazenada não é proveniência Git comprovada.** O relatório sempre apresenta `independentlyVerified: false` nesta fase, mesmo com todos os hashes válidos; verificação independente de Git/build pertence à preparação de releases futura. SHA-256 confere integridade, não autentica contra quem puder substituir payload e manifesto.

O schema proposto de backup de produção é separado do formato isolado da Fase 1: `version`, `backupId`, `sourceGeneration` (0 admite baseline legacy), `declaredCommitSha`, `runtime`, `entries`, com as mesmas raízes backend/frontend, incluindo node_modules em backend. Credenciais, privados e vínculos de runtime não entram no payload. `READY` é JSON com `version`, `backupId`, `manifestSha256`, `transactionId`; exige referência a journal existente. O diagnóstico valida estrutura/hash/inventário se esses artefatos existirem. Isso não cria backups nem comprova restauração operacional, retenção ou durabilidade de publicação.

Journal: envelope `{record, sha256}`, hash de `JSON.stringify(record)`. Record contém `version`, `transactionId`, `operation` (deploy/rollback), `generation`, `releaseId`, `events`. Eventos possuem `phase`, `at`, com ordem started → prepared → backend_activated → frontend_published → health_verified → confirmed; failed/interrupted só podem terminar uma sequência ainda não confirmada. Active deve referenciar journal confirmed da mesma geração/release. Transações não confirmadas exigem revisão, inclusive failed.

Lock: `version`, `transactionId`, `token`, `operation`, `pid`, `startTicks`, `bootId`, `createdAt`. PID e idade isoladamente nunca provam propriedade ou abandono seguro. Um lock válido, ligado a processo admin com início/boot compatíveis e comando canônico de `production-operation.mjs`, mais journal pendente da geração seguinte, pode ser IN_PROGRESS. Processo encerrado, identidade divergente, journal terminal ou proprietário ilegível não autorizam remover lock. Existência de `.deploy.lock` gera incerteza: o diagnóstico não tenta observar/adquirir seu flock.

### Vínculos de runtime e dependências do diretório de execução

Somente estes vínculos de runtime são aprovados, sem criá-los:

- `<release>/backend/.env` → `<repositório original>/.env`;
- `<release>/backend/istbrasil.private` → `<repositório original>/istbrasil.private`.

Links relativos internos de node_modules são uma categoria separada: destino declarado e realpath precisam permanecer dentro do próprio node_modules e não podem ser dangling. Não são permitidos vínculos extras para `.env.backup`, `.env_old`, uploads ou backend-php. Arquivos protegidos não são copiados para payload. Links aprovados são lidos como links; conteúdo de configs/privados não é lido.

`server.js` e `db.js` carregam dotenv/config, cujo padrão depende de cwd; overrides e ambiente já definido podem mudar a origem efetiva. Caminhos estáticos de livros/documentos e `profilePhotoService.js` usam localização dos módulos, exigindo o vínculo privado ao mudar para releases. `bookController.js` usa `PRODUCTS_PATH`, com default `/var/www/istbrasil_private/products/livros/`, distinto da árvore estática; valor relativo dependeria de cwd. Não há autorização para escolher outro destino ou reescrever essa variável.

O coletor não importa a aplicação, não lê `.env` e não trata `/proc/environ` como prova do ambiente efetivo após dotenv. Seleciona internamente campos de identidade PM2; nunca retorna/imprime ambiente completo. A confirmação da origem efetiva de dotenv/PRODUCTS_PATH continua pendente e gera `EFFECTIVE_RUNTIME_PATHS_NOT_PROVEN`/INCONCLUSIVE no coletor real. Os testes que comprovam classificação CONSISTENT usam evidência fictícia explícita, sem simular validação da configuração real.

### Estados e capacidade

| Estado | Significado diagnóstico |
| --- | --- |
| UNINITIALIZED | Active ausente, instalação legacy reconhecida, sem artefatos operacionais ou incertezas impeditivas |
| CONSISTENT | Active, journals, hashes, publicação e observações de processo concordam; nunca autoriza deploy |
| IN_PROGRESS | Lock/processo/journal pendente comprovadamente vinculados; nenhum outro bloqueio |
| RECOVERY_REQUIRED | Divergência operacional conhecida, transação interrompida/não confirmada, lock abandonado ou publicação parcial |
| UNKNOWN_PROCESS | Processo/daemon/listener visível com identidade incompatível ou concorrente |
| INCONCLUSIVE | Evidência insuficiente, ACL/processo/lock/caminho ilegível ou alteração durante leitura |
| INVALID | Schema, referência, integridade, propriedade/permissão insegura ou capacidade declarada insuficiente |

Precedência conservadora: INVALID → UNKNOWN_PROCESS → RECOVERY_REQUIRED → INCONCLUSIVE → IN_PROGRESS → UNINITIALIZED/CONSISTENT. Não se transforma ausência de leitura em ausência de estado. O relatório só inclui códigos de diagnóstico, SHA declarado e resumo de capacidade; não inclui conteúdo arbitrário de JSON, erros de ferramentas ou dados privados. `deployAuthorized` e `rollbackAuthorized` são sempre false.

Coleta PM2 não usa CLI PM2/sudo: lê metadados de pm2.pid/rpc.sock, /proc e `ss -H -ltnp 'sport = :3000'`. PID sem LF final é aceito. Confere owner, título God Daemon, vínculo por ancestralidade, cwd/script, exclusividade do listener e evidência do executável Node igual ao do diagnóstico Node 20.19.6. Outros daemons visíveis e processos desconhecidos bloqueiam; falhas de leitura/hidepid impedem certeza. Isso não prova visibilidade fora do namespace atual nem substitui testes reais de PM2 fork/cluster/reboot.

Capacidade é observada com stat/statfs, agrupada por device, sem criar arquivos. Orçamento exige candidate + backup + restore + temporary/cache e inodes por filesystem, somando a reserva operacional de **10 GiB por filesystem**. Custos ausentes, filesystem não observado ou contagem desconhecida resultam UNKNOWN; orçamento suficiente resulta SUFFICIENT_FOR_DECLARED_PLAN, nunca autorização. Nenhum custo futuro é inventado pelo CLI; os 46 GB históricos não são usados como evidência. Espaço/inodes não são reservados e quotas/concorrência podem mudar; revalidação antes de futuras mutações será obrigatória. CONSISTENT pode ter capacidade UNKNOWN porque consistência de uma instalação existente não prova capacidade para outra operação.

### Execução e validação isolada

O CLI aceita somente `node scripts/deploy/production-inspect.mjs`, sem argumentos de caminhos/overrides. Imprime JSON e retorna 0 para UNINITIALIZED/CONSISTENT, 2 para os demais estados. Exit 0 não autoriza implantação. Não executar contra produção sem autorização de inspeção específica.

O export `inspectProduction()` aceita coletores/caminhos/orçamentos fictícios para testes. `ancestorBoundary` limita exclusivamente a fixture ao seu diretório temporário; o CLI usa `/` e caminhos fixos. Esses adaptadores nunca concedem capacidade de mutação. Não há criação de diretórios, arquivos, locks, logs, journal ou active. Conteúdo, modos, inodes, mtime e symlinks das fixtures são comparados antes/depois; leituras podem afetar atime conforme o filesystem. Metadados e arquivos são conferidos durante a leitura, e mudanças de active/lock/journals entre início/fim impedem consistência. Não se promete snapshot atômico de toda a instalação.

```bash
node --check scripts/deploy/production-contract.mjs
node --check scripts/deploy/production-inspect.mjs
node --check tests/deploy-production-contract.test.mjs
node --test tests/deploy-production-contract.test.mjs
# Regressão Fase 1, Linux, não root:
bash tests/deploy.integration.test.sh
```

Novos testes usam somente fixtures geradas, labels fictícios de configuração, placeholders privados e arquivos de código não executados. Exercitam sete estados, todos os vínculos aprovados/recusados, permissões POSIX, exclusividade de grupo, parser ACL, hashes/arquivos desconhecidos, identidade/processo incerta, locks abandonados/ilegíveis, journals corrompidos/não confirmados, mudanças durante leitura, backup de produção fictício e ausência de escrita. ACLs e identidades positivas são coletores sintéticos explícitos; não equivalem a testar ACLs estendidas reais, NSS ou daemon PM2 na VPS. O cenário SIGKILL real continua na suíte intacta da Fase 1.

Validação local da Fase 2.1: 55 testes novos aprovados em Linux, zero falhas/skips, junto aos 42 testes intactos da Fase 1 (também zero falhas/skips), com Node 20.19.6 e UID 1000. No Windows, a suíte nova aprovou 26 testes, com 29 skips POSIX explícitos e zero falhas. Sintaxe dos módulos/testes Node e dos scripts Bash conferida; `git diff --check` sem erros. Os hashes dos módulos/testes da Fase 1 e de deploy.sh permaneceram iguais. A suíte antiga de diagnóstico/dependências, Angular, build e instalação não foi repetida nesta fase; aplicação, dependências e deploy.sh não foram alterados. Não houve inspeção da VPS nem validação de PM2/NSS/ACLs de produção.

Para Linux isolado, usar a imagem/digest e isolamento descritos na Fase 1, acrescentando mount somente leitura de `tests/deploy-production-contract.test.mjs`. Executar esse arquivo com Node 20.19.6/não root e também o runner original, mantendo `/work/deploy.sh` disponível. Não montar configurações, arquivos privados ou a árvore completa do projeto. Windows executa os testes puros; fixtures POSIX ficam explicitamente skip.

### Próximas fases dependem de aprovação

Permanecem pendentes: proveniência Git independente e build, origem efetiva de dotenv/PRODUCTS_PATH, custos medidos da operação, execução PM2 real como admin, módulos nativos bcrypt/sharp em Linux, compatibilidade funcional entre frontend/backend de gerações diferentes, health checks operacionais, recuperação comprovada após reinício/perda de energia, retenção, publicação/ativação e homologação Ubuntu 20.04. Decisões sobre esses pontos devem ser aprovadas antes de integrar um executor. Nenhum módulo novo adapta ou amplia os caminhos aceitos pela Fase 1.

Traps de deploy.sh somente registram estágio e abortam. Não fazem rollback. O journal isolado não é integrado ao deploy; sua adoção em produção exige revisão e testes adicionais. Não alegar zero downtime. Não haverá SQL/migrations nem reload Nginx automático.

## Fase 2.2-A: exportador Git em workspace temporário

`scripts/deploy/git-export.mjs` exporta uma projeção explícita de um commit Git local. Não prepara dependências ou releases operacionais, não executa aplicação/npm/build, não cria vínculos de runtime e não importa os módulos das Fases 1/2.1. `deploy.sh` permanece desconectado e deploy/rollback bloqueados.

APIs: `createExportWorkspace()`, `requireExportWorkspace(root)`, `exportCommit({workspace, commitSha, approvedMainSha})`, `verifyExport({workspace, exportId})`. Somente Linux com UID não zero é aceito para criação/exportação/verificação. O workspace precisa ser filho direto do diretório temporário canônico (/tmp ou /var/tmp seguros), ter prefixo `ist-git-export-`, owner/grupo do usuário atual e modo 700, com marcador privado exato. TMPDIR não pode redirecionar criação para um caminho de produção/arbitrário. A origem é fixa em `repository/.git`; destinos são UUIDs novos em `exports/`. Não há opção de origem/destino arbitrário, flag para produção ou CLI operacional. Os testes constroem somente repositórios fictícios nesse workspace.

```text
<tmp>/ist-git-export-XXXXXX/       700
  ISOLATED.json                  600
  repository/.git/               origem fictícia, somente lida pelo exportador
  EXPORT.lock                    600, somente durante a operação ou incerteza
  exports/<UUID>/               700
    source/                     diretórios 700; arquivos 600/executáveis 700
    source.json                 600
    COMPLETE.json               600, selo de exportação isolada
```

### Proveniência e seleção

Exigir SHA-1 completo com 40 caracteres hexadecimais minúsculos para o commit e o snapshot esperado de main. Confirmar tipo commit, conteúdo Git tipado, árvore e ancestralidade: selecionado deve ser igual ou ancestral da main aprovada. HEAD precisa apontar diretamente para refs/heads/main; refs empacotadas são aceitas. O snapshot aprovado precisa corresponder à referência real, e é conferido em múltiplos pontos antes/durante/depois da cópia. Mudar main aborta a operação; nunca altera o SHA selecionado para seguir a branch. Checkpoints não detectam necessariamente mudanças transitórias que voltam ao mesmo SHA entre leituras, mas todos os objetos exportados permanecem fixados por seus IDs.

A leitura de objetos soltos é feita com módulos nativos Node: zlib, validação de header/tamanho/tipo, ausência de bytes comprimidos extras e recomputação do ID Git sobre `tipo tamanho\0conteúdo`. Árvores são interpretadas em formato binário com nomes delimitados por NUL e IDs de 20 bytes. Mensagens de commit e identidades de autores não são registradas. `verified-local-git-objects` comprova a correspondência da projeção exportada aos objetos locais; não autentica autoria, aprovação humana ou publicação no GitHub. `approvedMainSha` é uma expectativa fornecida pelo chamador e conferida contra main, não uma autorização operacional.

Objetos soltos continuam sendo lidos e verificados diretamente. Quando o objeto solicitado existe somente em pack, o exportador chama `git cat-file --batch` sem shell, com diretório Git fixo, ambiente reduzido, configurações global/system desabilitadas, replace objects desabilitados, protocolos vazios e sem operação de rede. A política de caminhos é aplicada antes de solicitar qualquer blob: somente commits, trees e blobs autorizados são pedidos. O Git pode descomprimir internamente bases de delta, inclusive bytes compartilhados com um objeto excluído, mas o conteúdo excluído nunca é emitido nem materializado pelo exportador. Tipo, tamanho e SHA-1 tipado de cada resposta são verificados independentemente.

O exportador não executa filtros, textconv, hooks, fetch ou comandos de aplicação. Repositórios parciais/shallow, alternates, commondir, configurações de inclusão/extensions/promisor e links/hardlinks no armazenamento Git continuam recusados. A fonte deve permanecer estável e pertencer ao usuário do workspace; não há promessa de isolamento contra um processo hostil com o mesmo UID capaz de substituir diretórios. Git CLI local compatível passa a ser requisito quando algum objeto necessário estiver empacotado.

### Política antes da leitura

`EXPORT_POLICY` e seu SHA-256 integram o registro. A allowlist inclui server.js, package.json/lock, configurações Angular/TypeScript/PostCSS necessárias, .gitattributes, README/LICENSE e as áreas de código/assets permitidas em src e public. A lista exata está no módulo e é independente de `.gitignore` e do working tree.

Antes de solicitar um blob, excluir componentes html, .env*, istbrasil.private, uploads, backend-php, database/development, dumps/backups, credentials/secrets, .git/.npmrc/.ssh/.aws/.pm2/.deploy, node_modules, caches e builds anteriores. SQL/sessões SQLTools, dumps/bancos locais, backups e chaves/certificados sensíveis por extensão/nome também são excluídos. Diretórios inteiros excluídos não são percorridos: registra-se somente caminho raiz, tipo, ID Git e motivo, sem nomes internos ou conteúdo privado. Hash SHA-256 do conteúdo protegido não é calculado, pois exigiria sua leitura. A exclusão e a materialização são decididas por caminho; arquivos distintos com bytes idênticos podem compartilhar o mesmo blob Git sem materializar o caminho excluído.

Arquivos não pertencentes à allowlist ficam em exclusões NOT_BUILD_INPUT. A política é uma proteção por caminho/tipo, não um detector completo de credenciais embutidas em código permitido. Revisão humana do commit continua necessária. A verificação cobre a projeção autorizada; objetos de blobs/subárvores excluídos não são lidos nem têm sua integridade testada. Ausência/corrupção deles não invalida a cópia autorizada.

Recusar traversal, absolutos, componentes vazios/dot/dotdot, backslashes, colon, controles/newlines, UTF-8 inválido, nomes reservados/trailing dot-space, tipos especiais, submódulos e todos os symlinks Git. Espaços internos, Unicode, aspas e metacaracteres de shell são tratados como nomes, sem interpretação por shell. Colisões case-insensitive/NFC são recusadas conservadoramente. Nenhum link de configuração/dados é criado. Executáveis Git são copiados em modo 700, sem executar seu conteúdo.

### Registro, verificação e falhas

`source.json` registra commit/tree/main aprovados, versão/hash da política, UID/GID, diretórios, arquivos com caminho/ID do blob/modo/tamanho/SHA-256 e exclusões. Não registra conteúdo protegido, mensagens de commits ou saídas completas de ferramentas. `verifyExport()` confere selo e schema, revalida Git/main/ancestralidade, reenumera os metadados da árvore e exige inventário exato com bytes correspondentes ao ID Git e ao SHA-256. Recalcular um receipt não permite substituir payload por conteúdo que não pertence à árvore aprovada. Registros arbitrários, extras, links e alterações de modos/conteúdo são recusados.

Exportações usam UUID exclusivo e nunca sobrescrevem uma anterior. EXPORT.lock por criação exclusiva coordena operações nesse workspace; não é journal ou lock operacional de produção. Lock existente/abandonado nunca é removido automaticamente. Erros anteriores ao selo deixam a cópia parcial sem conclusão; falhas durante a confirmação final retêm o lock, e verifyExport recusa enquanto ele existir. Somente o dono que adquiriu o lock tenta liberá-lo, conferindo token/inode. Erros de limpeza não substituem o erro original. Dados parciais ficam preservados para revisão; não há retomada automática, garbage collection ou integração com active/journals de produção.

Arquivos são abertos sem seguir symlink final, com verificação de ancestrais e de metadados antes/depois da leitura. Escritas são exclusivas no workspace; arquivos e diretórios têm fsync na conclusão. Limites conservadores: 64 MiB por objeto/registro, 2 GiB de blobs exportados, 250 mil entradas, 10 mil commits visitados e profundidade de árvore 64. Ao exceder, bloquear; não alterar limites automaticamente. Não se trata de snapshot atômico nem de reserva de capacidade para instalar/buildar uma release. A reserva operacional da Fase 2.1 não foi modificada.

environment.ts e environment.prod.ts são exportados somente quando rastreados no commit. Nenhum arquivo de environment é gerado e nenhum valor PayPal é alterado. Instalação, build e testes dos módulos nativos pertencem à preparação; journal e ativação pertencem ao módulo operacional desconectado descrito abaixo.

### Testes da Fase 2.2-A

```bash
node --check scripts/deploy/git-export.mjs
node --check tests/deploy-git-export.test.mjs
node --test tests/deploy-git-export.test.mjs
node --test tests/deploy-production-contract.test.mjs
bash tests/deploy.integration.test.sh
```

Fixtures contêm objetos Git reais em formato loose e PACK/idx v2, criados com dados fictícios por Node, sem CLI simulada. A compatibilidade dos formatos também é conferida pelo Git nativo quando disponível. Testes cobrem commit inválido/inexistente/tipo incorreto/fora de main; objetos ausentes/corrompidos; exclusão antes de abrir blobs; árvores maliciosas; nomes especiais; links/submódulos; main mudando durante leitura; worktree/gitignore divergentes; corrupção e receipts recalculados; concorrência/locks; erros de cópia/selo e ausência de escrita fora do workspace. Snapshot do repositório fictício e sentinela externa permanecem iguais; leituras podem afetar atime.

Validação em Linux Debian isolado, Node 20.19.6 e UID 1000: 60 aprovados, zero falhas e três skips nos 63 testes do exportador; os skips são exclusivamente os cenários que requerem Git CLI, ausente na imagem local. Os seis testes da preparação, os 55 da Fase 2.1 e os 42 da Fase 1 passaram sem falhas/skips. No Windows, os testes puros e a conferência independente dos packs pelo Git nativo passaram; as APIs POSIX são ignoradas explicitamente. Uma instalação limpa real e descartável do commit aprovado instalou 1.297 pacotes com peers estritos, concluiu o build Angular de produção e carregou bcrypt/sharp em Node 20.19.6. Permanecem os avisos CommonJS conhecidos de page-flip e quill-delta. O caminho completo do exportador sobre packs ainda precisa ser exercitado em Linux com Git disponível; não foi instalada ferramenta adicional apenas para remover esse skip.

### Fases 2.2-B/C/D: preparação isolada de release

`scripts/deploy/release-prepare.mjs` consome exclusivamente uma exportação completa e novamente verificada. A API `prepareRelease({ workspace, exportId, allowRegistry, runner })` não aceita caminho de origem ou destino arbitrário. O workspace Linux temporário permanece privado e a operação usa `PREPARE.lock`; lock preexistente, inclusive abandonado, bloqueia e requer descarte manual do workspace. Não há recuperação automática.

O preparador copia os arquivos autorizados para `preparations/<UUID>/release/backend`, recusa scripts de lifecycle do pacote raiz, executa exatamente `npm ci --include=dev --strict-peer-deps` e `npm run build -- --configuration production`, e testa o carregamento de bcrypt e sharp. O ambiente encaminhado contém somente PATH e valores operacionais controlados; não inclui variáveis da aplicação, banco ou credenciais. O registry fica disponível somente quando `allowRegistry: true`; build e probes são marcados sem rede. Dependências executam seus scripts normais de instalação, necessários aos módulos nativos, portanto o commit e o lockfile continuam sujeitos a revisão humana.

O resultado possui `release/backend` com código e `node_modules`, e `release/frontend` com o conteúdo de `dist/sakai-ng/browser`. São obrigatórios server.js, manifestos npm, pacotes bcrypt/sharp e index.html. Node precisa ser exatamente 20.19.6. O manifesto registra commit/tree, versões de Node e npm, ABI, plataforma, arquitetura, comandos e SHA-256/modo/tamanho de todos os arquivos; links só podem ser relativos e permanecer dentro da release. `PREPARED_INACTIVE.json` é escrito por último. `verifyPreparedRelease()` revalida a exportação de origem, selo, arquivos essenciais e inventário integral. Falhas geram `FAILED.json` sem conteúdo de stderr e nunca geram selo de release válida.

Esse estado é deliberadamente inativo: não cria active.json, não altera PM2/Nginx, não publica frontend e não vincula `.env`, privados, uploads ou diretórios de produção. `deploy.sh --deploy` e `--rollback` continuam bloqueados. Workspaces incompletos devem ser revisados e removidos manualmente fora deste módulo.

Testes isolados cobrem packs via Git, fluxo normal, falhas de instalação/build, lock, integridade e ausência de ambiente secreto. O runner injetável usa apenas fixtures; a aceitação final também exige uma preparação real descartável com Node 20.19.6, npm e registry, seguida de probes reais de bcrypt/sharp e build Angular.

O formato de workspace/teste não aceita caminhos da VPS. Não são executados serviços, SQL/migrations, operações Git remotas, deploy ou rollback. Fases 1/2.1 e deploy.sh permanecem inalterados.

## Fase 2.3: ativação e rollback operacional

`scripts/deploy/production-operation.mjs` implementa `activatePreparedRelease()` e `rollbackRelease()`. `scripts/deploy/deployment-runner.mjs` faz somente a orquestração: clona localmente o repositório já presente, exporta o SHA fixado em `origin/main`, prepara a release e chama o módulo operacional. O entrypoint não executa fetch, migration, SQL, Nginx ou PayPal.

Cada operação usa o contrato canônico da Fase 2.1. Cria `operation.lock` por exclusividade com PID, boot ID, start ticks e token; lock preexistente nunca é removido automaticamente. Journals seguem `started → prepared → backend_activated → frontend_published → health_verified → confirmed`, ou terminam em `failed`. Falha de rollback automático ou de confirmação do estado retém o lock para revisão manual.

Antes de trocar processos ou publicação, o runtime atual é copiado para `.deploy/backups/<UUID>/payload`: backend executável com seus `node_modules` e frontend sem `istdbadmin`. `.env`, seus backups, `istbrasil.private`, `.git` e artefatos de build não entram no payload. Manifesto, SHA-256 dos arquivos, runtime/ABI e selo READY usam o schema já validado pelo diagnóstico. A cada rollback explícito também é criado um novo backup da versão que estava ativa, permitindo recuperação da tentativa de rollback.

A candidata preparada é verificada antes e depois da promoção para `.deploy/releases/<UUID>`. A release recebe somente dois vínculos absolutos aprovados: `backend/.env` e `backend/istbrasil.private`. O backend usa os `node_modules` da própria release; não há instalação no caminho ativo. O adaptador PM2 exclui e recria exclusivamente `ist-api` com cwd/script da release. Como essa troca possui um pequeno intervalo sem processo, esta fase não promete zero downtime.

Na publicação, todo conteúdo gerenciado de `html` é substituído, preservando `html/istdbadmin`; `index.html` é copiado por último. Uploads e `backend-php` ficam fora da árvore modificada. O health check do backend aceita somente resposta HTTP bem-sucedida em `127.0.0.1:3000`, com até doze tentativas separadas por 250 ms para acomodar o início assíncrono do PM2. O frontend exige index não vazio e o vínculo `istdbadmin` ainda presente.

Se PM2, frontend, health check, active.json ou journal falhar depois do início da ativação, o adaptador volta ao cwd/script anterior, o frontend é reconstruído a partir do backup e a saúde antiga é testada. `active.json` só é publicado depois dos dois health checks; se sua confirmação no journal falhar, o active anterior é restaurado ou removido. Uma falha nessa recuperação é risco alto: o erro original é preservado, `rollbackError` é anexado quando possível e o lock permanece.

O rollback explícito valida novamente hashes e inventário do backup, converte o payload em uma nova release imutável com novos vínculos persistentes, ativa essa release e grava uma nova geração. O backend não é executado diretamente do diretório de backup.

Os testes usam árvores fictícias e cobrem sucesso, falha de ativação do backend, falha de publicação, rollback explícito, persistência, integridade e lock. A integração instala PM2 6.0.14 apenas em ambiente descartável e comprova a troca real entre dois servidores HTTP como usuário não root. A prova local não substitui a conferência de permissões/ACLs e visibilidade `/proc` na VPS.

## Integração final e primeira implantação controlada

`deploy.sh --deploy` usa exclusivamente o SHA completo da referência local `origin/main`, já verificada como avanço rápido de `HEAD`. A cópia Git é local, sem hardlinks e com configuração controlada; não há fetch implícito. Instalação e build ocorrem no workspace temporário privado. Em sucesso, a saída informa `transactionId`, `backupId`, `releaseId` e geração. Em falha recuperável, o módulo tenta restaurar PM2 e frontend. Se a recuperação ou a confirmação do estado falhar, mantém o lock transacional e informa que é necessária recuperação manual.

O rollback exige o UUID explícito de um backup selado: `bash deploy.sh --rollback <backupId>`. Ele valida novamente manifesto, SHA-256 e payload, cria uma nova release imutável, restaura PM2 e frontend e registra uma nova geração. `.env`, `.env.backup`, `.env_old`, `istbrasil.private`, uploads, backend-php, banco e `html/istdbadmin` permanecem fora da substituição.

Para a primeira implantação, após publicar e inspecionar o commit na VPS, executar `bash deploy.sh --check`. Somente após aprovação humana da homologação, provisionar como `admin` os diretórios administrativos privados e o lock, criar o marcador exato com modo 600, repetir `--check` e então executar `bash deploy.sh --deploy`. Guardar o `backupId` retornado. Se a validação funcional falhar, executar `bash deploy.sh --rollback <backupId>`. A criação do marcador é uma habilitação operacional deliberada e não é feita pelo script.

## Testes locais

`bash -n deploy.sh`; `bash -n tests/deploy.test.sh`; `bash tests/deploy.test.sh`.

Testes usam cópia do script com caminhos temporários, /proc fictício e marcador regular no lugar de socket Unix; ferramentas simuladas para NSS, ACLs, stat e ss. O código Node de identidade/ancestralidade PM2 é executado de verdade sobre as fixtures, incluindo pm2.pid sem LF final. No Windows, um adaptador exclusivo de teste traduz caminhos e fornece semântica de caminhos Linux; não altera deploy.sh. O restante do diagnóstico de dependências usa mock mais cinco verificações de dependências: manifesto/lock real compatível e versões Angular preservadas; sete conflitos Angular/PrimeNG isolados; hono obrigatório ausente; peer opcional ausente; peer opcional instalado incompatível. Esses casos executam o trecho real da proteção de peers de deploy.sh; as fixtures negativas existem somente em memória e não alteram o lock real. É possível focar um cenário com DEPLOY_TEST_CASE=<nome> bash tests/deploy.test.sh. Não executar a cópia contra caminhos produtivos. Os testes de build/publicação/PM2 verificam **que essas fases não são alcançadas**, não validam execução/rollback dessas fases. As verificações de dependências da suíte Bash não instalam pacotes nem usam rede.

## Antes de qualquer execução na VPS

Histórico da correção de dependências: 333 testes Angular completos, 131 testes focados do jurado, quatro testes de eventos com consultas simuladas, 52 cenários isolados de deploy e cinco verificações de dependências passaram. O build final de produção passou, com avisos CommonJS de page-flip e quill-delta; nenhum ajuste foi feito nesses pacotes. As instalações, testes e builds usam uma cópia temporária; node_modules e serviços do workspace ativo foram preservados. A suíte backend completa não foi executada; a divergência preexistente em festivalParticipation.test.js não foi corrigida nesta tarefa. Esses resultados de aplicação não foram repetidos na Fase 1 de backup.

A validação de dependências descrita acima foi realizada no Windows. Na Fase 1 de backup, Docker já estava disponível e foi utilizado para executar os testes isolados em Linux; nenhum serviço existente foi reiniciado. Isso não valida o build Angular ou os binários bcrypt/sharp reais em Ubuntu. A validação visual manual de Aura, modo escuro, overlays e formulários permanece pendente.

Revisão humana obrigatória. Conferir layout, admin/PM2_HOME, privilégios de leitura de /proc/ss, permissões e allowlist sem publicar segredos. O script não consegue comprovar ausência de processos que nem aparecem na visão de ps/ss de admin. Permissões reais de /proc, hidepid, containers/namespaces, formato do título PM2, ancestralidade fork/cluster e registros NSS precisam ser conferidos na VPS. Falhas nas leituras exigidas bloqueiam, mas uma enumeração aparentemente completa não é prova de visibilidade global. A enumeração getent passwd pode ser limitada por diretórios externos: antes de aceitar 640 é necessário confirmar exclusividade real do grupo. As inspeções não são um snapshot atômico; mudanças de processos durante a leitura podem causar aborto conservador. Não executar sudo pm2, reiniciar daemons ou matar processos para contornar falhas.

Validar a instalação e regressão também em Linux, incluindo aparência Aura/modo escuro, overlays, formulários e sincronização Slider/InputNumber dos jurados. PrimeNG 21 usa animações CSS e deixa showTransitionOptions/hideTransitionOptions sem efeito; essas propriedades não foram encontradas no código atual. Implementar/testar a Fase 2 e aprovar comando/commit/backup concretos antes de habilitar deploy. Nenhum deploy antigo foi encontrado para comparação linha a linha.
