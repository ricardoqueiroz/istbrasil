# Etapa 67.6-B3.1 — preparacao manual

Scripts preparados; nenhuma consulta, aprovacao ou captura real foi executada
nesta subetapa. Os comandos abaixo exigem autorizacao posterior do responsavel.

Somente variaveis do processo (nao carregar nem modificar .env):

- IST_LOJA_PAYPAL_ENV=sandbox
- IST_LOJA_PAYPAL_CLIENT_ID
- IST_LOJA_PAYPAL_CLIENT_SECRET

Merchant ID e referencia UUID devem ser os MESMOS utilizados na criacao da
ordem 92R75874BG9454744. Valor esperado fixo: BRL 1,00. Nao inventar referencia
nem substituir credenciais por variaveis legadas. Placeholders nao sao valores reais.

## Consulta e link

```powershell
node scripts/loja-paypal-aprovacao-manual.mjs --autorizar-consulta-sandbox --ordem 92R75874BG9454744 --recebedor <MERCHANT_ID_SANDBOX> --referencia <UUID_ORIGINAL>
```

O adaptador faz OAuth e GET da ordem existente. Um observador no transporte
injetado extrai apenas estado oficial e link HATEOAS da MESMA resposta GET.
Nao ha outra implementacao de OAuth ou Orders API. Nao modifica o DTO financeiro.

O link so e exibido para ordem aguardando aprovacao, com contexto/valor verificados.
Aceita rel approve ou payer-action, method GET, HTTPS, hosts exatos
www.sandbox.paypal.com ou sandbox.paypal.com, caminho /checkoutnow e token igual
ao Order ID. Rejeita credenciais na URL, portas alternativas, fragmentos,
parametros adicionais, links ambiguos ou externos. Nunca fabrica um link ausente.

Abertura do link e eventual aprovacao sao MANUAIS e exigem autorizacao posterior.
O script nao abre navegador, nao aprova, nao cria ordens e nao captura.
Reexecutar somente a consulta permite observar o estado apos aprovacao manual.
VOIDED/404/ausencia de link/resposta parcial nao autorizam recriar a ordem.

## Captura posterior

```powershell
node scripts/loja-paypal-captura-manual.mjs --autorizar-captura-sandbox --ordem 92R75874BG9454744 --recebedor <MERCHANT_ID_SANDBOX> --referencia <UUID_ORIGINAL> --request-id <UUID_V4_EXCLUSIVO_CAPTURA>
```

Somente apos autorizacao expressa. Registrar a chave ANTES de executar; nao
reutilizar a chave da criacao. O script nao gera UUIDs nem novas chaves.
Consulta estado e confere ordem, referencia, recebedor, BRL e 100 centavos.
Somente APROVADO sem captura identificada segue para provider.capturar.
O adaptador revalida aprovacao com outra consulta antes de seu unico POST.
O transporte permite apenas OAuth, GET desta ordem e no maximo um POST de captura;
POST de criacao ou outros endpoints sao bloqueados.

Saida JSON permitida: estados, IDs, chave de captura, moeda, centavos e instante.
valorOperacaoCentavos nao significa dinheiro recebido em PENDENTE ou RECUSADO.
Captura pendente/recusada/desconhecida, divergencia ou falha encerra com codigo 1.
Captura integral consistente encerra com codigo 0. Sem retry, polling ou fallback.

## Limites da homologacao sem banco

Nao ha gravacao de pedidos IST, reserva transacional, lock entre processos ou
historico duravel. Nao executar capturas concorrentes. Guardar a saida em local
controlado; nao versionar evidencias ou credenciais. O link contem o identificador
da ordem de aprovacao e tambem deve ser tratado como evidencia controlada.

Em timeout/resposta perdida, nao executar novamente com outra chave. Registrar
ordem/chave/IDs recebidos e consultar o estado; se inconclusivo, parar para analise.
A consulta previa e a idempotencia do provedor nao substituem a orquestracao
transacional. Nao ha garantia de exactly-once ou idempotencia eterna do PayPal.
Nenhum desses scripts oferece scheduler, webhook ou recuperacao financeira automatica.

Documentacao oficial consultada:

- https://developer.paypal.com/sdk/orders/v2/orders-get/
- https://developer.paypal.com/sdk/orders/v2/orders-capture/
- https://developer.paypal.com/api/orders/v2
- https://developer.paypal.com/api/rest/integration/orders-api
