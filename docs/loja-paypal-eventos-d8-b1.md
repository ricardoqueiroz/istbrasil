# D8-B1 — Ingestao de eventos pos-captura

## Contratos verificados

Fontes oficiais consultadas em 2026-10-20, somente documentacao publica:

- https://developer.paypal.com/api/rest/webhooks/event-names/
  confirma PAYMENT.CAPTURE.REFUNDED, PAYMENT.CAPTURE.REVERSED e
  CUSTOMER.DISPUTE.CREATED/UPDATED/RESOLVED.
- https://developer.paypal.com/api/payments/v2/schema.json
  callback capture_refunded: resource_type=refund, resource_version=2.0,
  resource.id identifica o reembolso; amount.value/currency_code e status
  descrevem esse recurso. O exemplo oficial liga a captura por links rel=up,
  method=GET, /v2/payments/captures/{id}. O link e apenas analisado, nunca seguido.
- https://developer.paypal.com/api/customer-disputes/v1/schema.json
  dispute_id, disputed_transactions[].seller_transaction_id, dispute_amount,
  status e dispute_outcome.outcome_code. Transacao do vendedor nao e assumida
  como Capture ID; disputas ficam sem pagamento vinculado nesta etapa.

O nome REVERSED esta confirmado; seu payload nao foi confirmado suficientemente.
Receber o envelope com REVERSAO_NOTIFICADA_SEM_EXTRATOR, sem inferir recurso,
captura, valor ou efeito. REFUNDED de outra versao/tipo de recurso tambem fica
explicitamente sem extrator. Nao foi inventado evento de chargeback.

## Contrato e persistencia

PAYPAL_EVENTO_POS_CAPTURA_V1 separa evento, recurso, reembolso, disputa,
captura, transacoes candidatas, contexto interno, montante decimal exato,
classificacao, correlacao e efeitoFinanceiroAplicado=false. Ausencia/invalidez
nao vira zero. Nao classifica reembolso como parcial/integral pelo valor isolado.

Evidencia original e uma projecao permitida, limitada, sem dados pessoais ou
notas. SHA-256 cobre os bytes originais completos autenticados; o corpo bruto
nao e persistido. Evidencia JSON nao pode exceder 16 KiB.

Reutiliza ist_loja_pagamento_eventos, sem migration. UNIQUE por provedor,
ambiente, recebedor, origem WEBHOOK e evento_id deduplica reentregas; mesmo ID
com hash diferente falha sem sobrescrever. Nenhum efeito depende da ordem de
chegada. Correlacao somente por captura extraida do link oficial e encontrada
exatamente no contexto confiavel. Hosts Live/Sandbox nao sao intercambiaveis.
Links conflitantes, invalidos ou excessivos impedem correlacao.

Reconhecidos ficam RECEBIDO; desconhecidos ficam IGNORADO. processado_em
permanece NULL. Correlacao e registrada separadamente no JSON, e pagamento_id
e NULL quando nao demonstrada. Resposta HTTP 204 exige persistencia concluida;
falha devolve 503 sanitizado. COMMIT incerto consulta identidade/hash em outra
conexao, sem repetir INSERT automaticamente quando resultado continua incerto.

COMPLETED/PENDING/DENIED preservam a reconciliacao anterior. A nova entrada
interna somente pode ser chamada depois da verificacao de assinatura.

## Limites operacionais

Somente INSERT de eventos; nao muda saldos, pedidos, operacoes de captura ou
direitos. Um evento RECEBIDO ja correlacionado pode bloquear autorizacao pela
regra conservadora D6 existente de webhook pendente; nao implica transicao do
direito. Aplicacao financeira e suspensao persistida ficam para B2/B3.

Validacao final: 32 testes aprovados, zero falhos/ignorados. MariaDB 13.0.2 real
descartavel; dados sinteticos, nenhuma chamada financeira externa. A primeira
rodada integrada revelou somente uma expectativa COUNT(*) numerica no teste:
a fixture retorna BIGINT como string; corrigida conversao explicita na assercao.
Unidades tambem detectaram conversao dos novos erros para ERRO_INTERNO pelo
catalogo antigo; ingestao agora emite codigos proprios sanitizados.

MariaDB 10.3.39 nao executado nesta etapa. SQL usa transacoes InnoDB, UNIQUE,
SELECT FOR UPDATE e consultas parametrizadas existentes nessa versao; revisao
estatica nao equivale a homologacao real. Instancia 13 e datadir descartados.
