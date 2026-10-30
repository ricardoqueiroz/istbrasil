# IST — Etapa 11.1: suporte Sandbox e Live

## Estado e limites

Implementacao local sobre `84ff8fa77efcf2263a0c507ed02a7b9f1a39b898`, sem commit,
publicacao ou mudanca do ambiente instalado. Nenhuma credencial real, pagamento,
e-mail ou banco persistente foi utilizado nos testes.

O mesmo fluxo financeiro atende Sandbox e Live. Contexto persistido, idempotencia,
reservas, valores, moeda, recebedor, direitos e autorizacao permanecem obrigatorios.
Nao reutiliza a integracao legada da Editora.

## Configuracao por instalacao

| Variavel | Sandbox | Live |
|---|---|---|
| LOJA_AMBIENTE | sandbox | live |
| IST_LOJA_PAYPAL_ENV | sandbox | live |
| IST_LOJA_PAYPAL_CLIENT_ID | ID publico da app Sandbox | ID publico da app Live |
| IST_LOJA_PAYPAL_CLIENT_SECRET | segredo da app Sandbox | segredo da app Live |
| IST_LOJA_PAYPAL_CONTA_RECEBEDORA | recebedor Sandbox | recebedor Live |
| IST_LOJA_PAYPAL_WEBHOOK_ID | webhook da app Sandbox | webhook da app Live |

As variaveis de credenciais sao as existentes. Cada processo tem sua configuracao,
seu host e seu cache OAuth; nao ha procura de credenciais alternativas nem fallback.
Um segredo nao informa seu ambiente de forma verificavel localmente: o responsavel
precisa provisionar as credenciais da app correta. O provedor valida-as em seu host.

REST: `https://api-m.sandbox.paypal.com` ou `https://api-m.paypal.com`.
SDK v6: `https://www.sandbox.paypal.com/web-sdk/v6/core` ou
`https://www.paypal.com/web-sdk/v6/core`.

O navegador nao envia selecao de ambiente financeiro. O contrato de configuracao
exige somente `ambiente` e `clientId`, tipos validos e correspondencia com o pedido.
O carregador recusa SDK global preexistente e mistura de ambientes na mesma pagina;
uma troca operacional de ambiente exige recarga em contexto limpo.

## Fluxos relacionados

- Recibos: scheduler, reserva SQL e compositor usam o mesmo ambiente. INCERTO nao
  e reenviado automaticamente; descricoes editoriais historicas continuam formatadas.
- Downloads: composicao aceita ambos os ambientes, mantendo sessao, CSRF e avaliacao.
- Webhooks: DECLINED e DENIED seguem assinatura obrigatoria e reconciliacao pelo
  provedor. Payload isolado nao confirma pagamento. Certificados de outro ambiente
  sao recusados. Reembolsos/disputas preservam a correlacao e revisao existentes.
- Adversos: worker aceita contexto Live; todos os filtros continuam incluindo
  provedor, ambiente e recebedor. Links de reembolso devem pertencer ao mesmo ambiente.
- Descoberta: implementacao parametrizada, mas ativacao Live depende da CHECK abaixo.

## Migration opcional da descoberta

As fundacoes de descoberta restringem `ck_ldc_contexto` a Sandbox. Preparada
`migrations/ist_loja_descoberta_contexto_live.sql`, que amplia somente essa CHECK,
sem DML, indices novos ou recriacao da tabela. Nao modifica as migrations antigas.

Exige destino explicito, autorizacao, MariaDB 10.3.39, InnoDB, autocommit e FK/CHECK
habilitadas. Aceita somente definicao canonica antiga ou nova; divergencia interrompe.
A segunda execucao sobre a definicao nova nao altera a tabela.

**Nao aplicada nem executada em SQL real nesta etapa.** Revisar e testar em instancia
descartavel antes de autorizar aplicacao. DDL tem commit implicito: backup primeiro,
sem retry automatico ou restauracao automatica do banco. Retornar a CHECK antiga
so e permitido se nao houver checkpoints Live. Preservar esses registros de auditoria.

Manter `IST_LOJA_DESCOBERTA_ATIVA=false` ate essa validacao e aplicacao especificas.
Essa migration nao e requisito para compra/captura, recuperacao, direitos ou recibos.
Nao habilitar rotinas automaticamente ao publicar esta implementacao.

## Validacao registrada

- Node, 15 arquivos focados: 413 aprovados; zero falhas; 7 ignorados (integracoes
  MariaDB sem instancia descartavel configurada). HTTP usa portas efemeras locais.
- Angular: 161 aprovados, zero falhas; checkout, SDK simulado, carrinho e biblioteca.
- TypeScript aplicacao/specs e compilador Angular: aprovados.
- Build production: aprovado em copia isolada de git archive HEAD com somente o
  patch desta etapa. Editora e proxy locais excluidos e preservados. Dependencias
  existentes; nenhuma instalacao/atualizacao de pacotes. Avisos CommonJS existentes.

SDK, OAuth, assinatura, captura e SMTP foram simulados. As primeiras falhas de
validacao foram de bind restrito do runner HTTP e expectativas antigas que
classificavam qualquer Live como invalido; rodadas finais passaram. Nenhum teste
financeiro foi executado contra PayPal ou banco ativo.

## Proximos passos e prontidao

Revisao do diff e autorizacao de commit/publicacao ainda necessarias. Homologacao
com app Live, webhook publico, SMTP externo, certificados, infraestrutura suportada
e backup/rollback da VPS continua pendente. Nao confundir mocks Live aprovados com
transacao real homologada. A auditoria anterior sobre suporte de Node/MariaDB segue
valida; nenhuma atualizacao de infraestrutura foi realizada nesta implementacao.

Referencias oficiais consultadas:
- https://developer.paypal.com/sdk/js/set-up/
- https://developer.paypal.com/api/rest/production/
- https://developer.paypal.com/api/rest/webhooks/event-names/

## Inventario do patch

- `src/app/pages/loja/loja-checkout.component.spec.ts`
- `src/app/pages/loja/loja-checkout.component.ts`
- `src/app/services/loja-checkout.service.spec.ts`
- `src/app/services/loja-checkout.service.ts`
- `src/routes/lojaCheckout.routes.js`
- `src/routes/lojaDownloads.routes.js`
- `src/services/lojaDescobertaContratos.js`
- `src/services/lojaDescobertaService.js`
- `src/services/lojaNotificacoesAgendador.js`
- `src/services/lojaNotificacoesWorker.js`
- `src/services/lojaPagamentoAdversoContratos.js`
- `src/services/lojaPagamentoAdversoWorker.js`
- `src/services/lojaPagamentoAgendador.js`
- `src/services/lojaPagamentoService.js`
- `src/services/lojaPaypalWebhook.js`
- `src/services/pagamentos/paypalProvider.js`
- `tests/lojaCheckout.test.js`
- `tests/lojaDownloadFinanceiroService.test.js`
- `tests/lojaDownloadsHttp.test.js`
- `tests/lojaNotificacoesMensagem.test.js`
- `tests/lojaNotificacoesWorker.test.js`
- `tests/lojaPagamentoAdverso.test.js`
- `tests/lojaPagamentoAgendador.test.js`
- `tests/lojaPagamentoService.integration.test.js`
- `tests/lojaPaypalWebhook.test.js`
- `tests/paypalProvider.test.js`
- `docs/loja-paypal-live-etapa111.md`
- `migrations/ist_loja_descoberta_contexto_live.sql`
