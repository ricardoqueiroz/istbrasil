# D9-B3 — Descoberta operacional adversa

## Contratos oficiais e limites

Consultados em 2026-10-21, exclusivamente documentacao publica:

- https://developer.paypal.com/api/webhooks/v1/schema.json
  GET /v1/notifications/webhooks-events por start_time/end_time, page_size=10.
  Eventos e links de continuacao; scope applications/webhooks. Nao se criou
  reenvio automatico. Retencao e limite maximo de intervalo desse endpoint nao
  ficaram comprovados nas fontes consultadas: nao prometer recuperacao integral
  de notificacoes antigas a partir de uma resposta vazia.
- https://github.com/paypal/paypal-rest-api-specifications/blob/main/openapi/customer_disputes_v1.json
  GET /v1/customer/disputes, update_time_after/before dentro dos ultimos 180 dias;
  page_size ate 50. Detalhar cada ID com GET /v1/customer/disputes/{id}, pois a
  listagem e resumida. Scope disputes/read-seller, dependente de habilitacao.
  seller_transaction_id nao e assumido universalmente Capture ID. Fund movements
  seguem D9-B1, sem criar identidade economica ou presumir debito liquidado.
- https://developer.paypal.com/api/transaction-search/v1/schema.json
  GET /v1/reporting/transactions; scope reporting/search/read; intervalo ate
  31 dias, page/page_size (maximo documentado 500; implementado 100), total_pages.
  Historico dos tres anos anteriores e atraso documentado de ate tres horas.
  Consulta em nome de terceiros exige enquadramento de parceiro; nao foi criada.
- https://developer.paypal.com/reports/reference/t-codes
  Projecao de T1106/T1107/T1110/T1111/T1201 e registros com status V. Nenhum
  codigo vira perda de pedido automaticamente. Outros tipos nao sao cobertos.

O adaptador continua exclusivamente Sandbox. Permissoes documentadas nao provam
que a conta as possui; nenhuma credencial real ou chamada financeira foi usada.
403/401 interrompem a fonte em revisao. Limites numericos universais de chamadas
e precos nao foram presumidos. Ambiente Live continua bloqueado.

## Configuracao e ciclo de vida

Desligado por padrao. Exige os tres parametros novos e independentes:

- IST_LOJA_DESCOBERTA_ATIVA=true, valor literal.
- IST_LOJA_DESCOBERTA_FONTES: lista explicita de NOTIFICACOES,DISPUTAS,TRANSACOES,
  separada por virgula, sem espacos ou repeticoes. Somente fontes autorizadas.
- IST_LOJA_DESCOBERTA_DESDE: instante inicial ISO UTC explicito.

NODE_ENV=test impede inicio automatico. Nenhum .env foi alterado. Reutiliza a
instancia financeira, pool e contexto confiavel existentes, sem nova rota.
Timer consulta checkpoints a cada 60 segundos, sem ciclo imediato ou sobreposicao
local. Cada fonte tem proxima execucao persistente: hora para notificacoes/disputas,
dia para relatorio. Um lote faz ate uma janela por fonte, sequencialmente.
Prazo de ciclo 90s; encerramento limitado a 95s com AbortSignal. Nao fecha pool
compartilhado nem altera os outros dois agendadores. Relogios UTC sincronizados
sao requisito operacional; nao se alterou infraestrutura global.

## Checkpoint e migration

O ledger controla eventos individuais, mas nao mantinha fonte, cobertura de janela
ou retomada de paginacao. Criada somente ist_loja_descoberta_checkpoints, UNIQUE
por provedor/ambiente/recebedor/fonte, sem ALTER ou FK para tabelas historicas.
Campos: inicio configurado, ultima janela concluida, janela em andamento, estado,
token/prazo, proxima execucao, tentativas, erro sanitizado e atualizacao.

migrations/ist_loja_descoberta_adversa.sql foi aplicada somente nas instancias
descartaveis reais 13.0.2 e 10.3.39. Guard bloqueia istbrasil e qualquer schema
fora do padrao de homologacao, exige versao/configuracao apropriadas. O nome do
schema nao prova identidade do servidor: as fixtures validam separadamente
host/porta/versao/datadir e autenticacao antes de SQL. Aplicacao futura no
principal e revisao do guard exigem autorizacao separada; nao foram executadas.

Checks preservam combinacoes de estado/lease/janelas, exigem prazo nao nulo ao
executar e limitam tentativas a oito. Reaplicacao falha sem sobrescrever tabela.
Testados destino nao autorizado, FK desabilitada e rejeicao de reserva invalida.

Reservar e gravar paginas usam transacoes curtas. SELECT FOR UPDATE protege
checkpoint; token, contexto, janela e prazo sao conferidos antes/depois da pagina.
GETs ocorrem entre transacoes. Executor antigo nao persiste nem conclui janela
reservada por outro. Nenhum lock de checkpoint e adquirido pela aplicacao D8.

## Paginacao e retomada

Janelas avancam ate um dia por rodada. Sobreposicao: uma hora em notificacoes e
disputas, um dia em relatorios; inicio nunca precede o configurado. Relatorio
termina pelo menos tres horas antes do relogio atual. Resposta que declare
end_date ou last_refreshed_datetime anteriores ao fim pedido impede conclusao.
Janela antiga fora da retencao comprovada vai para revisao, sem pular datas.

HATEOAS next somente HTTPS no host Sandbox, mesmo endpoint e mesma janela; sem
redirects, credenciais, fragmento ou mudanca de contexto. Relatorios usam pagina
numerica documentada. Pagina repetida e limite de 20 paginas falham fechado.
Fonte que nao ofereca continuacao compativel exige revisao; nao inventar cursor.

Cada pagina e duravel e repetivel. Checkpoint avanca apenas depois da ultima.
Falha intermediaria preserva a janela original e repete desde a primeira pagina
na retomada, deduplicando observacoes ja gravadas. Transitorios/429/5xx esperam
cinco minutos, ate oito tentativas por janela; depois revisao. Permissao, contrato
ou limite invalido nao geram loop. Reinicio nao depende de memoria do processo.
COMMIT incerto nao e reportado como sucesso: a janela permanece recuperavel por
estado/lease duraveis, sem reaplicacao cega na mesma chamada.

## Observacoes, ledger e integracao financeira

PAYPAL_OBSERVACAO_API_V1 identifica a projecao GET; seu hash deterministico inclui
fonte, recurso, atualizacao e campos permitidos. PAYPAL_OBSERVACAO_POS_CAPTURA_V1
identifica a entrada no ledger: origem API, tipo REVISAO_FINANCEIRA, D9-OBS-SHA256.
Hash e da projecao API local, nunca do corpo assinado de um webhook. autenticado_em
registra autenticacao da consulta, nao verificacao de assinatura. Nao ha webhook
ficticio, nem persistencia de notas, emails, nomes, OAuth ou corpo bruto.

Notificacao ja presente em origem WEBHOOK nao e reinserida pela descoberta.
Observacoes repetidas na mesma fonte/janelas se deduplicam; fontes diferentes
preservam evidencias distintas. transaction_id isolado nunca e chave universal:
referencia/tipo/estado/atualizacao participam da projecao. Identidade da observacao,
ID do recurso e identidade economica sao conceitos distintos.

Observacoes trataveis de reembolso/disputa entram RECEBIDO para o worker D9-B2,
com origem API explicitamente passada e token obrigatorio ao reservar. D8 consulta
recurso/captura novamente e aplica financeiro/suspensao na mesma transacao.
A identidade canonica de refund D8 e reutilizada entre fontes; nao soma outra vez.
Payloads e fatos antigos permanecem validos, sem backfill ou reescrita.

O tipo REVISAO_FINANCEIRA reutiliza o bloqueio conservador do avaliador existente
quando ha pagamento correlacionado; nao foi alterada a autorizacao D6/D7.
Paginas ja persistidas podem ser reconciliadas enquanto outra pagina aguarda
retomada; repetir a janela nao duplica seus efeitos economicos.

Transaction Search, reversao sem contrato e demais observacoes insuficientes
ficam REVISAO, sem pagamento escolhido por aproximacao e sem alterar valores ou
direitos. Mesmo uma referencia textual igual a captura nao prova por si recurso,
contexto e identidade economica do debito. A resolucao dessa revisao e operacional;
nao existe painel ou desbloqueio publico novo. Nao se reativam direitos.

## Homologacao e limites

Rodada final 13.0.2: 228 contabilizacoes Node, 227 aprovadas, zero falhas,
uma ignorada, exit 0. Ignorado preexistente: reversao/chargeback confirmado sem
contrato comprovado. A primeira execucao da nova assercao CHECK esperava um nome
simbolico de erro nao fornecido pelo driver; foi corrigida para exigir errno 4025
e o nome exato ck_ldc_reserva. A constraint havia rejeitado corretamente o INSERT.

Rodada WSL 10.3.39 real: descoberta 17/17; D8-B3 23 aprovadas e uma ignorada;
worker D9-B2 17/17. Total 57 aprovadas, zero falhas, uma ignorada, exit 0.
Todas as respostas externas e os dados/PDFs sao sinteticos. Datadirs Windows e
contêiner/volume/segredos WSL foram descartados; imagens compartilhadas preservadas.

Permanecem pendentes de operacao autorizada: permissoes efetivas da conta, API
Sandbox real, migration no principal, revisao de notificacoes antigas e das
observacoes sem identidade economica. Checkpoint concluido significa janela
consultada/persistida, nao garantia de cobertura integral do PayPal ou resolucao
financeira de cada observacao. Nenhuma declaracao de prontidao Live.

Banco principal, registros Sandbox historicos, PDFs comerciais, servidores e os
14 protegidos foram preservados. Sem commit, push, deploy ou D9-B4.
