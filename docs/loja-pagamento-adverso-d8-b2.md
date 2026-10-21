# D8-B2 — Reconciliacao adversa explicita

## Entrada e limites

`criarLojaPagamentoService(...).reconciliarEventoAdverso({eventoId})` e uma
entrada exclusivamente interna. Le eventos autenticados B1 no contexto fixo
do backend. Nao acrescenta endpoint, polling, timer ou processamento automatico
ao webhook B1. Nao deve ser exposta aceitando contexto do comprador.

O contrato `IST_EVIDENCIA_ADVERSA_V1` distingue reembolso confirmado, risco de
disputa, disputa encerrada, evidencia incompleta e contraditoria. Inclui recurso,
captura, valor/moeda, contexto, identificador/hash do evento de origem e desfecho.

Fontes oficiais consultadas, sem chamadas a API financeira:

- https://developer.paypal.com/api/payments/v2/refunds-get
- https://developer.paypal.com/api/payments/v2/schema.json
- https://developer.paypal.com/api/customer-disputes/v1/disputes-get
- https://developer.paypal.com/api/customer-disputes/v1/schema.json
- https://developer.paypal.com/api/rest/webhooks/event-names/

O adaptador adiciona `consultarEvidenciaAdversa({tipo,recursoId,ambiente,signal})`:
REEMBOLSO -> GET /v2/payments/refunds/{id}; DISPUTA -> GET
/v1/customer/disputes/{id}; CAPTURA -> GET /v2/payments/captures/{id}.
OAuth/cache, timeouts, limite de resposta e bloqueio de redirects sao reutilizados.
URLs externas do payload nunca sao seguidas. Configuracao continua Sandbox.

Refund deve ter ID, status COMPLETED, montante BRL positivo e captura associada
por link oficial validado. A captura consultada deve confirmar ID, ordem,
recebedor, moeda e valor historicos. Ausencias nao viram zero. Disputa deve ter
uma unica transacao de vendedor; so pode ser vinculada quando coincide exatamente
com captura local cujo contexto e confirmado pelo GET de captura. Multiplas
transacoes e vinculos ausentes/divergentes ficam em revisao, sem escolher pedido.

## Ledger, transacao e idempotencia

Nao ha migration. A UNIQUE existente por contexto/origem/evento_id fornece duas
identidades internas distintas:

- D8-REFUND-SHA256(refund_id): fato imutavel REEMBOLSO_COMPROVADO, uma vez por
  recurso/contexto, incluindo protecao contra vinculacao a dois pagamentos.
- D8-B2-SHA256(webhook_id): EVIDENCIA_ADVERSA da avaliacao daquele evento.

Ambas usam origem RECONCILIACAO e mantem hash/evidencia limitada. O evento
original preserva hash e JSON; muda apenas vinculacao comprovada, estado e
metadados de processamento. A captura e a operacao CAPTURAR nunca sao reescritas.

A soma usa BigInt e apenas fatos de recursos distintos confirmados. Confere
contador anterior contra fatos, moeda, captura e teto capturado. Contradicoes
nao alteram o contador. Parcial/integral dependem da soma, nunca do nome do evento.
REVISAO preexistente nao retorna automaticamente ao estado financeiro favoravel.

GETs ocorrem antes da transacao. Locks: sessao original, pedido, pagamentos,
operacoes, eventos. Versoes e contexto sao revalidados; snapshot vencido retorna
EVIDENCIA_DESATUALIZADA e exige nova chamada explicita. Direitos nao sao escritos.
Fato, contador/estados e finalizacao do evento fazem COMMIT juntos. Falha anterior
reverte tudo. COMMIT incerto consulta fato duravel em nova conexao sem reaplicar.

Disputas abertas, atualizadas ou encerradas vao para REVISAO; o desfecho e
preservado, sem presumir perda definitiva ou chargeback. Resolucao favoravel nao
remove evidencias anteriores nem reativa direitos. Falha GET deixa evento em
REVISAO, sem fabricar reembolso, e permite nova consulta explicita.

## Avaliador e B3

D6 interpreta os novos fatos: reembolso confirmado -> ADVERSO; risco, encerramento
e evidencia incompleta -> REVISAO; contradicao -> INCONSISTENTE. Estados financeiros
pos-captura nao invalidam por si a captura historica; continuam bloqueando acesso.
RECEBIDO indica pendencia, nao perda confirmada. Nao ha transicao de direito.

Teste com autorizacao D6 real confirma acesso permitido antes e negado depois de
refund/disputa, embora o direito continue ATIVO. Operacoes, snapshots, direitos,
eventos dos direitos e campos historicos da captura permanecem identicos.

Limites: REVERSED B1 nao tem recurso/captura comprovados. Fica em revisao; nao ha
extrator ou teste de reversao confirmada fabricado. Sem correlacao nao e possivel
bloquear com seguranca um pedido especifico. Captura sem payee/order_id suficientes
na resposta GET fica incompleta. A descoberta automatica e a suspensao B3 nao
foram implementadas.

## Homologacao e pendencias

MariaDB 13.0.2 real descartavel, GETs/OAuth/assinatura simulados e metadados de PDF
sinteticos; nenhum PDF aberto. Rodada focal final: 22 testes, todos aprovados.
Revisao SQL usa recursos existentes em 10.3, sem SKIP LOCKED ou DDL novo.
WSL respondeu E_ACCESSDENIED; MariaDB 10.3.39 nao foi executado.

Na regressao ampliada (oito arquivos): 251 testes, 249 aprovados, dois falhos,
zero ignorados, exit 1. Uma falha e o caso preexistente de direitos
`idempotencia e ausencia de reativacao automatica: ATIVO` com ERRO_PERSISTENCIA;
a outra e seu grupo pai. Nao houve alteracao nesse servico ou teste.
Reproducao pontual instrumentada em outra instancia passou (um teste, uma
transacao, zero falhas capturadas). Causa da ocorrencia ampla permanece
indeterminada; a reproducao nao apaga a falha nem comprova preexistencia.
Nao declarar a regressao integral aprovada.

Falhas intermediarias corrigidas: D6 confundia REVISAO pos-captura com captura
historica invalida; o teste de GET fora de SQL observava transacoes de outras
chamadas concorrentes (agora usa contexto assincrono por chamada); teste de
autorizacao precisava isolamento SESSION READ COMMITTED, como o controller D6.
