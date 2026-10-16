# Etapa 67.6-B3.3 — consulta direta de captura

Preparado para autorizacao e execucao posteriores. Nenhuma chamada real executada.

```powershell
node scripts/loja-paypal-reconciliacao-captura-manual.mjs --autorizar-consulta-sandbox --captura 9G418289UJ6071503 --ordem 92R75874BG9454744
```

Somente credenciais Sandbox no ambiente do processo: IST_LOJA_PAYPAL_ENV=sandbox,
IST_LOJA_PAYPAL_CLIENT_ID e IST_LOJA_PAYPAL_CLIENT_SECRET. Nao carregar variaveis
legadas nem registrar credenciais em arquivos versionados.

O metodo auxiliar consultarCaptura do adaptador reutiliza OAuth, cache em memoria,
single-flight e transporte HTTPS existentes. Os metodos financeiros criar,
consultar e capturar e seus contratos permanecem inalterados.

O script permite apenas POST /v1/oauth2/token e
GET /v2/payments/captures/{capture_id}, no host api-m.sandbox.paypal.com.
Nao consulta a ordem, nao cria, aprova, captura ou reembolsa. Sem retries,
polling, banco, servidor, navegador ou modificacao de estado financeiro IST.

statusFinanceiro e o estado oficial do recurso de captura, independentemente do
estado da ordem: COMPLETED, PENDING, DECLINED, REFUNDED, PARTIALLY_REFUNDED ou FAILED.
Estados ausentes ou nao reconhecidos sao DESCONHECIDO; nunca presumir sucesso.
O valor em centavos representa o amount do recurso, nao saldo liquido recebido.
REFUNDED/PARTIALLY_REFUNDED nao sao classificados como pagamento atual concluido.

A consulta valida Capture ID, moeda BRL e amount=100 centavos sem usar float.
A associacao a ordem so e CONFIRMADA se supplementary_data.related_ids.order_id
ou link up oficial indicar a ordem esperada sem contradicoes. Links nunca sao
seguidos. Se nao houver prova, associacaoOrdem=NAO_DEMONSTRADA e a limitacao e
explicitada; a ordem esperada nao preenche dados ausentes da resposta.

criadoEm e atualizadoEm sao timestamps oficiais do recurso. Para COMPLETED,
horarioReferenciaUTC utiliza update_time, ou create_time quando necessario,
com fonteHorario explicita. Isso nao comprova o instante exato de liquidacao
ou disponibilidade do dinheiro. Datas ausentes continuam null.

Codigo 0 significa consulta consistente (inclusive se PENDING/DECLINED), NAO
significa pagamento confirmado ou atualizacao de pedido. Codigo 1 indica falha,
divergencia, resposta parcial/desconhecida ou associacao nao demonstrada.
HTTP 404 indica recurso indisponivel para a consulta, nao prova ausencia de efeito.

Sem persistencia: guardar a evidencia sanitizada em local controlado e nao
versionar credenciais. A referencia e a chave idempotente da captura original
nao sao necessarias para este GET e nao sao utilizadas para enviar nova operacao.

Fontes oficiais:

- https://developer.paypal.com/api/payments/v2/captures-get
- https://github.com/paypal/paypal-rest-api-specifications/blob/main/openapi/payments_payment_v2.json
