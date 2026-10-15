# Etapa 65.5 — Auditoria de idempotência e conexões

Commit local da Etapa 65.4: `adc01e88e5244a5bf1e2c156b7c000a20b75809d`.

Resultado: mecanismos de criação/idempotência preservados. Encontrada e corrigida
uma falha localizada no descarte de conexões durante a configuração inicial. Não
foi necessária alteração arquitetural. Nenhum endpoint foi implementado.

## Evidências e matriz de garantias

Referências dos testes:

- **C**: [lojaPedidoContratos.test.js](../tests/lojaPedidoContratos.test.js).
- **U**: [lojaPedidoService.test.js](../tests/lojaPedidoService.test.js), 66 testes anteriores, intactos.
- **I**: [lojaPedidoService.integration.test.js](../tests/lojaPedidoService.integration.test.js), MariaDB temporário, 18 cenários (8 anteriores e 10 adicionados).
- **T**: [lojaCatalogoTransacional.test.js](../tests/lojaCatalogoTransacional.test.js).
- **S**: [lojaSessaoService.test.js](../tests/lojaSessaoService.test.js).

| Garantia auditada | Implementação / evidência | Testes correspondentes e limite da evidência |
| --- | --- | --- |
| Escopo da chave | UNIQUE `uq_loja_pedidos_sessao_idempotencia (sessao_id, idempotencia_criacao)`; consulta pelos dois campos | U: mesma chave em outra sessão; I: concorrência real; DDL real aplicado na instância isolada |
| Hash canônico | SHA-256 binário de versão do contrato, e-mail normalizado, IDs ordenados e ambiente confiável; comparação timingSafeEqual | C: vetor conhecido, normalização, ordem e ambiente; U: chave/payload divergente |
| Repetição idêntica sem novas gravações | Pedido procurado antes do catálogo; somente consulta e projeção dos snapshots | U: repetição normalizada, contagem de INSERTs e preparações; I: replay após COMMIT incerto |
| Ausência de recálculo | Não chama prepararItensNaConexao no replay | U: preço e disponibilidade alterados após a primeira criação; mesma resposta |
| Validade não renovada | Replay devolve criado_em/expira_em persistidos, inclusive após a validade original do pedido, desde que sessão continue válida | U: relógio avançado 40 minutos e resposta idêntica; I: replay com igualdade da resposta |
| Payload divergente | Hash diferente resulta em CONFLITO_IDEMPOTENCIA | U: seleção, e-mail e ambiente; I: duas conexões independentes, mesma chave e payloads divergentes; um sucesso e um conflito |
| Serialização por sessão | SELECT da sessão FOR UPDATE antes da consulta de idempotência | U: dez chamadas com mesma chave; I: mesma chave, chaves diferentes, payloads divergentes e timeout real no lock da sessão |
| Ordem dos locks do catálogo | Categorias, produtos e livros em consultas separadas, PKs crescentes | T: ordem exata das consultas; I: usa a operação real do catálogo; escritores externos devem respeitar a ordem |
| Locks até término | Transação externa mantém os locks; helpers do catálogo não fazem COMMIT/ROLLBACK | T: ausência de gestão interna; I: bloqueador independente, rollback e continuação posterior; não foi feito teste físico de todos os interleavings |
| UNIQUE distintos | Somente índice exato de sessão/idempotência aciona reconciliação; public_id, PRIMARY e índices desconhecidos retornam erro interno | U: cada índice distinto e fallback com pedido existente/divergente; I: colisão real de public_id. PRIMARY/índice desconhecido/fallback de idempotência permanecem testados por injeção |
| Falha antes do COMMIT | Rollback completo; nunca confirma pedido parcial | U: falhas na inserção/releitura; I: falha no segundo item e perda real da conexão no segundo item, seguidas de nova criação segura |
| COMMIT com persistência e confirmação perdida | Descarta conexão original; reconcilia em nova conexão pela mesma sessão/chave/hash | U e I: COMMIT real seguido de erro de confirmação injetado; exatamente um pedido |
| COMMIT sem persistência | Fecha conexão original; reconciliação somente de leitura retorna CONTENCAO_TEMPORARIA quando não há pedido | U e I: erro injetado antes de enviar COMMIT; nenhuma recriação interna |
| Repetição após resultado incerto | Cliente reutiliza a mesma chave; retorna pedido persistido ou cria uma vez se a criação anterior não persistiu | U e I: ambos os desfechos, contagem de pedidos e ausência de INSERT na reconciliação |
| Resultado persistentemente incerto | Reconciliação única e limitada, sem recursão/criação; erro temporário sanitizado se leitura ou COMMIT de reconciliação falha | U: falha de reconciliação e replay posterior; I: conexão encerrada na reconciliação e dois COMMITs com confirmação perdida, sem terceira transação |
| Deadlock | ER_LOCK_DEADLOCK/errno 1213: rollback completo e nova tentativa de criação | U: falha após primeiro item, sucesso na tentativa seguinte e esgotamento. Deadlock real não foi provocado nesta auditoria |
| Lock wait timeout | ER_LOCK_WAIT_TIMEOUT/errno 1205: rollback completo e nova tentativa | U e I: timeout real seguido de sucesso; três timeouts reais com contagem exata de aquisições, rollbacks e liberações |
| Limite de tentativas | Até três tentativas de criação; reconciliação é uma consulta transacional separada, sem INSERT | U: três tentativas totais para cada erro transitório; I: três timeouts e nenhuma quarta tentativa de criação |
| Erros permanentes | Sem retry de criação; erro público sanitizado | U: falhas não transitórias, UNIQUE distintos, rollback que falha; I: UNIQUE de public_id e falhas de transporte |
| Liberação após sucesso/rollback | Release apenas após encerramento confirmado; rollback que falha provoca destroy | U: eventos de release/destroy; I: @@in_transaction=0 após COMMIT e após rollback, antes de release |
| Conexão inicialmente comprometida | Configuração inicial protegida: qualquer falha de SET TRANSACTION descarta a conexão | I novo: transação suja devolvida por consumidor anterior, descarte e thread física diferente na próxima aquisição; repetido na reconciliação |
| Nenhuma reutilização após COMMIT incerto | destroy remove a conexão do pool, sem presumir rollback; nova aquisição para reconciliação | U: conexão original marcada destruída, sem rollback/release; I: confirmação perdida, recuperação e conexão encerrada |
| Total e snapshots | Soma de inteiros seguros, quantidade 1, IDs distintos; releitura e comparação de todos os campos dos snapshots e dados do pedido antes do COMMIT | U: totais, truncamento/corrupção simulados, snapshots imutáveis; T: limites TEXT UTF-8/SKU/título/DECIMAL; I: soma persistida COUNT/SUM |
| Estado e versão | CRIADO e versão 1 na criação; replay pode devolver estado/versão atuais | U: estado inicial, versão e replay de EXPIRADO; C: nove estados do esquema |
| UTC e validade temporal | DATETIME(3) escrito como UTC explícito; DATE_FORMAT lido e validado sem conversão do fuso do driver; validade do pedido limitada à sessão | U: precisão em milissegundos, limites e sessão que expira aguardando lock; C/S: datas inválidas e duração absoluta; I: execução SQL real |
| Resposta pública | Projeção whitelist pedidoPublico; exclui sessão, hashes, tokens, e-mail, descrição, caminhos PDF, dados de pagamento e erros SQL | C/U: whitelist, erros seguros e ausência de dados privados; nenhum endpoint criado |

## Defeito reproduzido e correção

Antes da correção, SET TRANSACTION falhava quando o pool entregava uma conexão
com transação anterior aberta. Como o serviço ainda não marcara sua própria
transação como iniciada, o finally executava release sem rollback nem destroy.
O teste real observou `@@in_transaction = 1` na aquisição seguinte.

No mysql2 instalado, release apenas devolve a conexão ao pool; não faz reset ou
rollback automático (`node_modules/mysql2/lib/base/pool_connection.js`). A
[documentação do erro 1568](https://mariadb.com/docs/server/reference/error-codes/mariadb-error-codes-1500-to-1599/e1568)
confirma a rejeição da alteração de isolamento durante uma transação ativa.

Foi extraído obterConexaoConfigurada: adquire a conexão e configura isolamento;
se a configuração falhar, destrói a conexão e propaga o erro para sanitização.
Criação e reconciliação usam esse mesmo helper. Não inicia transação adicional,
não altera configurações globais e não devolve uma conexão de estado desconhecido.

O novo teste falhou antes da correção e passou depois, verificando transação
encerrada e thread física diferente. A variante da reconciliação também passou.
Não foram alteradas as expectativas dos testes anteriores para esconder a falha.

## Recuperação e ciclo de vida das conexões

1. Parâmetros inválidos falham antes do pool.
2. Conexão adquirida: SET TRANSACTION ISOLATION LEVEL READ COMMITTED aplica-se à próxima transação. Falha nesta fase implica destroy.
3. Sucesso normal: COMMIT confirmado, seguido de release.
4. Falha antes do COMMIT: rollback confirmado e release. Se rollback falha, destroy e erro sanitizado, sem retry nessa conexão.
5. Falha no COMMIT: destroy, sem presumir rollback ou duplicar INSERT. Nova conexão bloqueia a sessão, consulta a mesma chave e compara o hash.
6. Pedido encontrado e consistente: retorna projeção dos snapshots. Pedido ausente ou reconciliação indisponível: erro temporário. Sessão inválida e conflito de hash mantêm seus erros de domínio.
7. A reconciliação não chama o catálogo, não muda a chave e não insere pedido/itens. Não renova a sessão ou o pedido.

O limite de três tentativas refere-se ao fluxo de criação por deadlock/timeout.
Depois de COMMIT incerto pode haver uma transação adicional de reconciliação,
exclusivamente de leitura. Ela não reinicia o laço de criação. Se a própria
reconciliação continua incerta, encerra com erro temporário.

## Compatibilidade

- **Analisada para MariaDB 10.3.39:** SET TRANSACTION READ COMMITTED; transações InnoDB; SELECT FOR UPDATE/LOCK IN SHARE MODE; DATE_FORMAT/DATETIME(3); placeholders; INSERTs simples; índices e FKs já existentes. Nenhum recurso exclusivo do MariaDB 13 foi introduzido.
- **Testada:** MariaDB 13.0.2, instância temporária em loopback/porta distinta de 3306, diretório validado dentro de TEMP. DDL das migrations existentes aplicado apenas nessa instância.
- **Não comprovada:** execução real no MariaDB 10.3.39, inclusive formato exato de mensagens de UNIQUE nessa versão. Não declarar homologação nessa versão.

Referências: [SET TRANSACTION](https://mariadb.com/docs/server/reference/sql-statements/administrative-sql-statements/set-commands/set-transaction),
[LOCK IN SHARE MODE](https://mariadb.com/docs/server/reference/sql-statements/data-manipulation/selecting-data/lock-in-share-mode),
[FOR UPDATE](https://mariadb.com/docs/server/reference/sql-statements/data-manipulation/selecting-data/for-update).

## Execução e resultados

- 366 testes anteriores sem banco real: 300 das etapas anteriores + 66 unitários de pedidos, todos aprovados, zero falhas.
- Integração: 18 cenários aprovados, incluindo os dez novos; o executor Node contabiliza 19 testes incluindo o grupo pai. Zero falhas na execução final.
- O teste novo de conexão suja reproduziu uma falha antes da correção. Não é falha preexistente ocultada nem falha pendente após a correção.
- Sintaxe Node e git diff --check: aprovados.
- A instância temporária foi encerrada após verificar seu datadir; todos os dados artificiais e o diretório temporário foram removidos.

Os testes de integração exigem IST_LOJA_TEST_PORT e IST_LOJA_TEST_DATADIR no
processo de teste. Recusam porta 3306 e diretório fora de TEMP ou sem o prefixo
esperado; antes de criar estruturas, conferem @@datadir do servidor conectado.
Não utilizam DB_* nem abrem conexões pelo pool do banco recuperado.

## Riscos e limites remanescentes

- Deadlock real não provocado; a recuperação está coberta por injeção unitária. Timeout de lock foi reproduzido em conexões reais.
- Perda da confirmação de COMMIT foi injetada antes/depois de COMMIT real. Não equivale a teste físico de partição de rede, queda do processo MariaDB ou falha de disco.
- Resultado de COMMIT persistentemente incerto continua exigindo repetição pelo chamador com a MESMA chave. Não há tentativa cega de recriação.
- Os limites de tempo do pool/rede/locks continuam os existentes; três tentativas limitam sua quantidade, não uma duração total de resposta.
- Serialização por sessão reduz concorrência dentro da mesma sessão; é uma decisão preservada. Outros escritores precisam respeitar a ordem de locks.
- Sessão recebida pelo serviço deve ser contexto confiável do mecanismo 65.2. Não expor id interno vindo diretamente de JSON/URL num futuro adapter HTTP.
- Falha de configuração de conexão provoca descarte conservador, mesmo quando seria possível reutilizar o socket. Prioriza não reter transações desconhecidas.

## Escopo preservado

Alterados somente src/services/lojaPedidoService.js e seu teste de integração;
criado este relatório. Banco recuperado, migrations, rotas, controllers,
server.js, Angular, Editora, PayPal, downloads e .env não foram modificados.
npm-audit-local.json permaneceu não rastreado. Produção não foi acessada.
Não houve commit da Etapa 65.5, push, pull ou deploy.

Aguardar aprovação antes do commit e da Etapa 65.6.
