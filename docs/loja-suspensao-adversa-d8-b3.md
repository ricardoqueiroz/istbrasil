# D8-B3 — Suspensao transacional dos direitos

## Integracao

`lojaPagamentoAdversoService.aplicar` grava os fatos financeiros, atualiza o
pagamento/pedido e o evento original e chama
`suspenderDireitosFinanceirosNaConexao(c,pedidoId,contexto,instante)` antes do
mesmo COMMIT. Falha em qualquer UPDATE ou INSERT de historico reverte toda a
aplicacao. Nao ha novo pool, endpoint, timer, migration ou transacao aninhada.

O auxiliar interno foi extraido do servico D6 existente. Reutiliza a avaliacao
financeira real, a politica de transicoes e os locks de direitos/historicos.
Nao aceita decisao financeira fornecida por HTTP; exige transacao ativa e
avaliacao impeditiva. A interface publica da fachada D6 permanece igual.

Ordem: sessao original -> pedido -> pagamentos -> operacoes -> eventos financeiros
-> direitos por ID -> historico dos direitos. O auxiliar nao readquire os locks
financeiros anteriores. Sessao recuperada D7 continua anterior a cadeia original
na autorizacao HTTP; o processamento adverso nao adquire sessao recuperada.
GETs do provedor, preparacao e transmissao do PDF permanecem fora dos locks SQL.

## Politica

Todos os direitos do pedido sao considerados; nao se escolhem itens arbitrarios
no reembolso parcial. ATIVO e AGUARDANDO_CONFIRMACAO passam a SUSPENSO uma vez,
com incremento de versao e evento FINANCEIRO. SUSPENSO e REVOGADO nao mudam.
Arquivo adquirido, timestamps historicos, snapshots e operacao CAPTURAR permanecem.

Reembolso confirmado parcial/integral e risco de disputa suspendem. Disputa
encerrada, inclusive favoravel, nao reativa. Evidencia contraditoria ou incompleta
correlacionada que a B2 aplica como REVISAO segue o bloqueio conservador D6,
sem fabricar reembolso. Eventos sem correlacao e reversao sem recurso comprovado
nao escolhem pedidos nem suspendem por aproximacao.

## Idempotencia e COMMIT incerto

Duplicatas e reprocessamentos confirmam o fato financeiro e os estados/historicos
persistidos sob a mesma ordem de locks, sem consultas externas nem novas transicoes.
COMMIT incerto abre apenas uma transacao de confirmacao em nova conexao: confere
evento/fato/hash/contexto, direitos bloqueados e eventos das versoes esperadas.
Prova ausente ou erro de leitura retorna RESULTADO_DESCONHECIDO. Nao reaplica
UPDATE de saldo ou suspensao cegamente. Estado posterior REVOGADO e preservado.

Um evento concluido pela B2 antes desta integracao, cujos direitos ainda estejam
ativos, nao e reparado automaticamente: a confirmacao retorna
SUSPENSAO_NAO_CONFIRMADA. Uma eventual regularizacao historica exige operacao
explicitamente aprovada; nenhum backfill foi executado.

## Homologacao

MariaDB 13.0.2 real, instancia independente e descartavel. Compras, e-mails,
metadados e PDFs exclusivamente sinteticos. Provedor simulado; nenhuma chamada
PayPal externa. Servidores Express de teste usam somente loopback e porta zero.

Comando da rodada final (IST_LOJA_PAGAMENTOS_MARIADB_BIN aponta ao bin 13.0):

```powershell
node --test --test-reporter=spec tests/lojaPagamentoAdversoDireitos.integration.test.js tests/lojaPagamentoAdverso.integration.test.js tests/lojaDownloadDireitosService.test.js tests/lojaDownloadFinanceiroService.test.js
```

Resultado: 133 contabilizacoes, 132 aprovadas, zero falhas, uma ignorada, exit 0.
O ignorado e reversao/chargeback confirmados pelo provedor: a B1/B2 ainda nao
possui contrato de correlacao comprovado. Nao foi criada fixture ficticia.
MariaDB 10.3.39 permanece para D8-B4; nao houve tentativa de corrigir WSL.

Testados: quatro estados de direito, todos os itens do pedido, parcial/integral,
disputas, evidencias insuficientes, evento sem correlacao, duplicatas concorrentes,
rollback no segundo evento do direito, UPDATE sem sucesso, COMMIT perdido antes
e depois de efetivar e indisponibilidade da propria leitura de confirmacao.

HTTP D6 real: adversidade anterior nega antes de preparar; suspensao confirmada
durante preparacao nega na autorizacao final para COMPRA e RECUPERACAO, HTTP 409,
sem corpo PDF. Caso favoravel entrega PDF sintetico exato e nova tentativa apos
adversidade e negada. Autorizacao final concluida antes da adversidade nao permite
recolher bytes ja autorizados; essa fronteira permanece inalterada.

A primeira execucao do teste novo incluiu locks da ingestao na assercao da cadeia;
o teste agora separa o trecho da aplicacao. A composicao HTTP precisou do servico
de sessao real sobre o pool, e da expectativa HTTP 409 definida pelo middleware.
O sandbox Windows nega lstat de um ancestral de TEMP: o diretorio sintetico foi
criado no workspace, fora de todos os mounts publicos conhecidos, mantendo a
validacao real de raiz e arquivo. Nao houve relaxamento do codigo de entrega.

Instancias, datadirs, servidores HTTP e diretorios sinteticos foram descartados.
Banco principal, PDFs comerciais, processos preexistentes e arquivos protegidos
nao foram alterados. A regressao ampliada historica 249/251 nao foi repetida nem
reclassificada por esta rodada dirigida. Nao houve commit, push, deploy ou D8-B4.
