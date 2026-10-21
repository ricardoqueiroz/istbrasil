# D9-B1 — Contratos e correlacao conservadora

## Fontes oficiais consultadas

- https://developer.paypal.com/api/rest/webhooks/event-names/
- https://developer.paypal.com/api/payments/v2/schema.json
- https://github.com/paypal/paypal-rest-api-specifications/blob/main/openapi/customer_disputes_v1.json

Payments v2: GET captures/{capture_id} confirma id, amount, payee.merchant_id
e supplementary_data.related_ids.order_id quando presentes. GET refunds/{refund_id}
e callback capture_refunded identificam recurso de reembolso; link up oficial
permite extrair a captura. Nenhum link recebido e requisitado. Contexto ambiente/
recebedor vem do backend; ausencia nao e substituida por email ou valor aproximado.
Reembolsos mantem integralmente a identidade canonica D8 por recurso/contexto.

Disputes v1: transaction_info.seller_transaction_id e o ID visto pelo vendedor,
nao uma equivalencia universal com Capture ID. A unica transacao candidata precisa
coincidir com captura local e ser confirmada pelo GET dessa captura, incluindo
ordem, recebedor, moeda e montante historico. Mais de uma transacao e ambiguo.
seller.merchant_id, quando informado no webhook ou GET, deve ser valido e igual
ao recebedor confiavel. Ausencia desse campo nao inventa identidade: a prova
continua dependendo do GET da captura. Divergencia/malformacao impede aplicar
efeitos e preserva o evento em revisao. Eventos antigos sem o campo adicional
continuam aceitos sob as verificacoes D8 existentes.

## Observacoes de disputa, sem segunda contabilizacao

Projecao permitida compartilhada entre normalizador B1 e GET:

- dispute_life_cycle_stage e dispute_channel: contexto administrativo.
- transaction_status, inclusive HELD: retencao/estado da transacao, distinto
  do status administrativo da disputa e de uma perda definitivamente liquidada.
- fund_movements: party, type, reason, amount e initiated_time.

Partes documentadas: SELLER, BUYER, PAYMENT_PROCESSOR. Direcoes: DEBIT e CREDIT.
Motivos: DISPUTE_SETTLEMENT, DISPUTE_FEE, CHARGEBACK_FEE,
REVERSED_TRANSACTION_FEE. Taxa e principal nao sao confundidos. Valor disputado,
desfecho administrativo, debito relatado e credito permanecem campos distintos.
O campo antigo money_movements esta depreciado e nao foi adotado.

O schema fund_movement nao fornece identificador economico estavel nem um status
de liquidacao individual. Nao ha prova suficiente para deduplicar economicamente
esse movimento contra um reembolso ja contabilizado. Logo, toda lista e marcada
identidadeEconomica=NAO_COMPROVADA: nao incrementa reembolsado_centavos nem cria
fato REEMBOLSO_COMPROVADO. Nao gerar ID por montante/data/hash para simular essa
prova. Duas observacoes iguais podem permanecer no historico, sem somar valores.

Lista limitada a 50 conforme schema, sem truncamento silencioso. Excesso ou
formato invalido bloqueia aplicacao; campos desconhecidos/ausentes sao null, nao
zero. Projecao exclui emails, nomes, notas, itens e campos nao necessarios.
Evidencia derivada usa o limite JSON D8 e a mesma transacao financeira/suspensao.

Disputa correlacionada continua RISCO_DISPUTA ou DISPUTA_ENCERRADA (REVISAO), sem
reativacao automatica. Dados contraditorios permanecem conservadores. Nenhum
estado financeiro, contador de chargeback ou mecanismo de entrega foi criado.

## Reversoes e impedimento da contabilizacao adicional

PAYMENT.CAPTURE.REVERSED tem nome/semantica documentados, mas as fontes consultadas
nao comprovaram payload suficiente para um extrator com recurso original,
captura, recebedor e estado financeiro. Preservar envelope autenticado/hash,
REVERSAO_NOTIFICADA_SEM_EXTRATOR e revisao sem associacao hipotetica.
CHECKOUT.PAYMENT-APPROVAL.REVERSED ocorre antes da captura: nao prova perda de
captura liquidada, permanece evento desconhecido explicito sem extrator.

A contabilizacao de debito efetivo de disputa esta interrompida para revisao:
exige contrato de identidade economica e correlacao entre fontes suficientemente
comprovados antes de qualquer alteracao funcional na persistencia. Nenhuma
migration, mudanca de persistencia ou fixture de liquidacao foi criada.

## Homologacao

Rodada dirigida: 104 contabilizacoes Node (incluindo grupos), 103 aprovadas,
zero falhas e um ignorado, exit 0. O ignorado e o contrato de reversao/chargeback
confirmado ainda nao comprovado. Doze casos unitarios D9 e dois casos de
integracao D9 novos, somados as regressoes diretamente pertinentes D8.

MariaDB 13.0.2 independente/descartavel; provedor e PDFs sinteticos. Verificados
reembolso parcial/integral e duplicatas, estados de disputa, ausencia/ambiguidade,
divergencias de contexto e captura, repeticao entre fontes, rollback, COMMIT
incerto, suspensao atomica e negacao D6/D7. Instancias/datadirs descartados.
Nenhum SQL novo; MariaDB 10.3.39 nao foi reexecutado nesta etapa. A homologacao
D8 anterior nessa versao nao e apresentada como execucao das mudancas D9.

Sem worker, agendamento, reserva, backoff, descoberta, ativacao Live ou nova rota.
Banco principal, historicos Sandbox, PDFs comerciais e arquivos protegidos nao
foram acessados para fabricar cenarios. Sem commit, push ou deploy.
