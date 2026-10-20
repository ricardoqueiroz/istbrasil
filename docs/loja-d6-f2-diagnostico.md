# D6-B4-F2 — diagnóstico da falha intermitente

## Conclusão

Investigação inconclusiva. A falha anterior ERRO_PERSISTENCIA não foi reproduzida em oito execuções do cenário de disputa nesta etapa. Não foi aplicada correção funcional nem se considera o problema resolvido por várias rodadas aprovadas.

Não há código MariaDB/SQLSTATE original capturado para a ocorrência anterior. Deadlock, lock wait timeout, conexão interrompida, falha de infraestrutura e exceção JavaScript fora da camada SQL permanecem hipóteses, não causas comprovadas. Não há evidência suficiente para escolher uma correção de serviço.

## Localização e inspeção

O caso está em `tests/lojaDownloadHomologacao.integration.test.js`, no laço “direito ATIVO diante de disputa fica bloqueado”. A evidência sintética de disputa é persistida em evento RECONCILIACAO, estado PROCESSADO, com motivo BUYER_COMPLAINT. A falha anterior foi observada ao chamar `reavaliarDireitosDoPedido`, após essa preparação. O serviço `src/services/lojaDownloadDireitosService.js` sanitiza exceções não classificadas como ERRO_PERSISTENCIA no catch da fachada.

Foram inspecionados teste, fixtures de catálogo/banco, mysql2/pool, avaliador financeiro, fachada de transições, autorização D6-B1, testes de rollback/concorrência e o conjunto original de 30 arquivos. Não havia executor versionado desse comando amplo; foi criado um executor de diagnóstico que fixa exatamente essa lista e varia somente a concorrência de arquivos.

Cada arquivo de integração usa uma instância MariaDB Windows descartável com datadir exclusivo, schema de nome aleatório, credencial sintética e porta dinâmica fora de 3306/3307. A fixture verifica versão, datadir e porta antes de SQL. Não se compartilham schemas, tabelas ou conexões de banco entre os arquivos desses cenários. Existem recursos físicos compartilhados: executável MariaDB instalado, CPU/memória, disco, diretório-pai TEMP, alocação de portas e filesystem do projeto lido pelos testes. Ausência de compartilhamento lógico não elimina pressão de recursos ou falha transitória do sistema.

Dentro do conjunto afetado, os subtestes são aguardados sequencialmente. Cada compra usa sessão, pedido, chaves e IDs sintéticos próprios. A fachada bloqueia sessão → pedido → pagamentos → operações → eventos financeiros → direitos/eventos de direitos. Ela limita retry de deadlock/timeout a três tentativas, com rollback antes da repetição. Após COMMIT incerto, usa reconciliação em outra conexão, sem reaplicar efeitos cegamente. Não foram alterados esses mecanismos.

## Instrumentação restrita aos testes

`tests/fixtures/lojaFinanceiroDiagnostico.js` envolve apenas o pool injetado na fachada pelo teste e observa aquisição, configuração de isolamento, BEGIN, SELECT/locks, UPDATE do direito, INSERT do evento, COMMIT e rollback. Repassa argumentos/retornos e relança o mesmo objeto de erro; não adiciona retry, reparo, mudança de estado financeiro ou timeout.

Em falha, registra nome do caso, etapa controlada, tipo de erro, código público quando presente, código do driver, errno, SQLSTATE, indicadores de deadlock/timeout/conexão encerrada, identificadores lógicos O/C/T e contagem de BEGINs da operação. A contagem representa tentativas transacionais observadas e pode incluir reconciliação; não é prova isolada de retry por deadlock.

Quando a conexão não aparenta estar encerrada/fatal, tenta uma consulta apenas de variáveis da própria conexão para informar @@in_transaction, @@autocommit e @@tx_isolation. Essa consulta diagnóstica só ocorre após erro; não modifica dados. Caso falhe, o estado fica indisponível e o erro original continua sendo relançado. O indicador observado de transação no wrapper é distinguido do estado SQL. Não são registrados message, SQL, parâmetros, stack bruto, senha, token, cookie, e-mail ou configuração completa do pool.

Dois testes unitários comprovam que o erro original é preservado por identidade e que conteúdo sensível/SQL sintético não aparece no log. Passaram ambos. A primeira asserção de sanitização confundia o rótulo controlado UPDATE_DIREITO com SQL bruto; foi corrigida apenas no teste, sem retirar a verificação de segredos ou SQL com parâmetros.

## Matriz executada

Node 20.19.6/Windows; MariaDB efetivo 13.0.2-MariaDB. Não houve indício demonstrado de comportamento específico da versão; não foi iniciado MariaDB 10.3.39 nesta investigação.

| Cenário | Arquivos/condição | Testes | Aprovados | Falhas | Ignorados | Exit | Duração |
|---|---|---:|---:|---:|---:|---:|---:|
| A | Conjunto afetado isolado; cinco compras/casos de disputa na mesma instância | 21 | 21 | 0 | 0 | 0 | 3,434 s |
| B | Lista ampla original; concorrência de arquivos 1 | 1.029 | 1.028 | 0 | 1 | 0 | 45,963 s |
| C | Mesma lista; concorrência habitual 2 | 1.029 | 1.028 | 0 | 1 | 0 | 25,220 s |
| D | Homologação financeira, transições, autorização e percurso HTTP; concorrência 2 | 67 | 67 | 0 | 0 | 0 | 6,426 s |

As contagens de conjuntos se sobrepõem; não devem ser somadas como testes distintos. O ignorado de B/C é o FIFO exclusivo de Linux. A teve cinco execuções do caso focal na mesma instância (não cinco reconstruções completas do schema). B, C e D tiveram uma execução de disputa cada. Frequência observada: 0 falhas em 8 casos focais. A ocorrência histórica da D6-B4-R continua sendo uma falha real não explicada.

As 1.029 contabilizações atuais incluem cinco casos que não chegaram a ser executados na rodada anterior de 1.024 contabilizações, cujo grupo foi interrompido na disputa. Não houve redução de cobertura para obter aprovação.

Comandos, sempre com IST_LOJA_PAGAMENTOS_MARIADB_BIN apontando à instalação de testes MariaDB 13:

```powershell
$env:IST_D6_F2_REPETICOES='5'
node --test --test-reporter=spec tests/lojaDownloadHomologacao.integration.test.js
node scripts/loja-d6-f2-diagnostico.mjs b
node scripts/loja-d6-f2-diagnostico.mjs c
node scripts/loja-d6-f2-diagnostico.mjs d
```

O executor força NODE_ENV=test e repetição focal 1 em B/C/D. Usa processos filhos com limite de arquivos simultâneos 1 ou 2, captura a saída somente em memória e grava apenas resumos sanitizados em `loja-d6-f2-resultado-b.json`, `-c.json` e `-d.json`. Não preserva saída SQL bruta e não contém credenciais.

## Conexões, isolamento e erros

Nas rodadas B/C/D, o servidor informou max_connections=151 e innodb_lock_wait_timeout=50 segundos; pool do cenário afetado com limite 8. Isolamento padrão de sessão REPEATABLE-READ; a fachada estabelece READ COMMITTED para cada próxima transação com SET TRANSACTION. Não se interpreta @@tx_isolation da sessão como prova do override efetivo por transação.

Na rodada A foram observadas 40 aquisições/BEGINs pela fachada; em B/C/D, 28 em cada. São aquisições lógicas, não número de conexões físicas diferentes. Máximo de transações observadas simultâneas na fachada desse conjunto: 1; ativas ao final: 0. Nenhum erro original foi capturado pelo wrapper; nenhum retry motivado por erro foi observado no caso focal. Não há SQLSTATE para reportar como causa da falha anterior.

Os testes próprios de transições, rollback, concorrência entre processos, COMMIT incerto e deadlock foram executados nas regressões. O deadlock InnoDB deliberadamente induzido pelo teste específico e os erros sintéticos injetados para validar retry não são ocorrências espontâneas do problema investigado. Os resultados aprovados confirmam esses controles no teste, sem excluir uma falha rara fora da amostra.

## Integridade financeira preservada

Não foram removidas ou flexibilizadas asserções. No caso de disputa foram acrescentadas verificações de estado ATIVO antes da evidência adversa, classificação adversa persistida, estado/evento SUSPENSO de origem FINANCEIRO, negação real pela autorização D6-B1 e estabilidade em nova reavaliação.

A negação de autorização usa token criptográfico sintético vinculado temporariamente à sessão já existente da fixture; o hash anterior é restaurado em finally. Não muda proprietário do pedido nem versões/valores financeiros. As comparações históricas e de idempotência existentes permanecem. Nenhum byte PDF é lido pela autorização e nenhum PayPal externo é acessado.

## Hipóteses e próximo passo

Permanecem possíveis: erro transitório de conexão/driver/servidor; pressão de CPU/disco/memória durante execução simultânea com outro trabalho; exceção JavaScript fora das chamadas SQL; estado raro não reproduzido no pool. Nenhuma foi comprovada. Os testes atuais não reproduziram a execução simultânea com a compilação Angular que estava ativa durante a rodada histórica; isso é uma diferença observada, não evidência de causalidade.

Recomenda-se uma próxima rodada limitada reproduzindo explicitamente essa sobreposição de carga, com a instrumentação sanitizada mantida, somente após autorização. Se ocorrer nova falha sem erro capturado na fronteira SQL/conexão, pode ser necessário um hook diagnóstico restrito no catch do serviço para obter tipo/local da exceção interna. Isso requer autorização específica e não foi implementado. Não há fundamento para aumentar timeout, remover asserção ou alterar política financeira.

A retomada da homologação D6 deve considerar o diagnóstico inconclusivo; não recomendar declarar a falha resolvida ou conceder aprovação definitiva com base apenas nessas rodadas verdes.

## Preservação

Nenhum serviço de produção, contrato, schema, migration ou configuração global foi modificado. Banco principal e pedidos históricos não foram acessados; somente dados sintéticos em instâncias descartáveis. Datadirs, conexões e processos das fixtures foram descartados ao fim das rodadas. Backend e Angular existentes não foram reiniciados. Arquivos protegidos e alterações Git preexistentes foram preservados. Sem commit/push/deploy; sem D7/D8.
