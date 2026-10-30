# B7-E2 — Recibo completo de compra

> Registro histórico preservado. Consulte a seção “Estado atual para consolidação Git” ao final.

Implementação local. Não publicada; nenhum envio, alteração MariaDB/.env, migration ou ativação de agendador.

## Fluxo preservado

`lojaPagamentoService` continua registrando `CONFIRMACAO_COMPRA` na outbox na mesma transação que
persiste CAPTURADO/PAGO. Produtor, unicidade `(pedido_id,finalidade)`, captura, webhook e reconciliação
não foram modificados. Nenhum backfill ou reenvio de INCERTO.

O worker reserva e confirma essa reserva como antes. Depois abre snapshot REPEATABLE READ / READ ONLY,
carrega recibo/modelo/assinatura, compõe HTML/texto e encerra a transação. Reconfere posse/validade
da reserva antes de SMTP. Envio permanece fora de transações e não toca o núcleo financeiro.
Uma segunda conexão/worker vê a reserva em andamento; ENVIADO não é novamente selecionado.
Falha de composição vira FALHA sem SMTP. Falha comprovadamente anterior ao aceite pode repetir
até cinco tentativas com backoff existente; resultado indeterminado/timeout continua INCERTO.
Não há garantia de entrega postal/exatamente uma vez: perda de ACK após aceite continua conservadora.

## Dados históricos

`criarCompositorConfirmacaoCompra` recebe apenas origem/ambiente internos, notificação persistida
e conexão fornecida pelo worker. Nenhum pool padrão, SMTP, timer ou log é iniciado por esse módulo.
Consulta pedido, pagamentos e itens por pedido_id, nunca catálogo atual ou usuário por e-mail.

Exige associação de UUID/e-mail/ambiente da outbox ao pedido, pedido PAGO, confirmação datada,
uma única captura positiva CAPTURADA PayPal, ambiente/moeda/valor iguais ao pedido,
captura integral, sem reembolso e mesma data de confirmação. Recusa estados incertos ou contraditórios.
Itens vêm de `titulo_snapshot`, `descricao_snapshot`, `quantidade`, `preco_unitario_centavos`,
`subtotal_centavos`, ordenados por posição; confere posições únicas, quantidade inteira positiva,
subtotal = quantidade × preço e soma exata do total. Usa BigInt para centavos, sem ponto flutuante.

O esquema vigente só permite quantidade 1 por item; o formatador respeita o valor persistido,
sem mudar esse contrato. Testes puros também exercitam quantidades maiores para verificar a aritmética.
Datas são lidas como UTC e apresentadas em America/Sao_Paulo explicitamente. Data do pedido e
confirmação financeira são identificadas separadamente. Referência do pagamento é UUID público,
não a resposta bruta do PayPal. Nome não existe no pedido atual: saudação neutra “Olá,”.
Não há consulta de nome por correspondência de e-mail, nem criação de campo novo.

A validação reflete o snapshot de dados confirmado antes do envio. Não bloqueia uma alteração
financeira concorrente posterior durante a operação externa SMTP e não a desfaz.

## Contrato administrativo

Chave: `confirmacao_compra`. Assunto sugerido:

```text
IST — Recibo da compra {{pedido_public_id}}
```

Todos os 14 placeholders são obrigatórios no corpo:

| Placeholder | Origem |
| --- | --- |
| `saudacao` | Saudação neutra, sem inventar nome |
| `comprador_email` | E-mail persistido e associado à notificação |
| `pedido_public_id` | UUID público do pedido |
| `pedido_estado` | PAGO |
| `data_compra` | Criação do pedido, com fuso explícito |
| `data_pagamento` | Confirmação da captura, com fuso explícito |
| `pagamento_referencia` | UUID público do pagamento |
| `pagamento_estado` | CAPTURADO — PayPal |
| `ambiente` | Sandbox sem cobrança real ou Produção |
| `itens_compra` | Lista textual histórica, escapada e multilinha |
| `total` | Total exato, vírgula decimal |
| `moeda` | Moeda persistida; atualmente BRL pelo contrato da loja |
| `link_biblioteca` | URL absoluta HTTPS da biblioteca |
| `link_recuperacao` | URL absoluta HTTPS da recuperação |

Links são derivados de `IST_LOJA_RECUPERACAO_ORIGEM_PUBLICA`, já existente. Não há domínio de produção
fixado no compositor. A fábrica aceita sandbox/live para composição e links, mas **worker e agendador
continuam restritos a Sandbox**, preservando a barreira existente. Não se habilita execução Live nesta fase.

Os placeholders de texto devem estar visíveis no corpo, URLs exclusivamente em href. Itens são
escapados primeiro e só então suas quebras de linha viram `<br>`, exclusivamente para essa chave/campo.
Nenhum HTML de produto é confiável, e nenhum mecanismo de repetição/template paralelo foi criado.
O limite de itens_compra é 200.000 caracteres (sem truncamento); demais campos/modelos mantêm 5.000.
Pedidos além desse limite falham em composição e não enviam recibo parcial. Manter esse limite sob
revisão se surgirem snapshots descritivos excepcionalmente grandes.
Assinatura administrativa ativa e textual é obrigatória; placeholders na assinatura são recusados.
Modelo ausente, inativo, incompleto ou inválido não tem fallback e não altera PAGO.

HTML sugerido para cadastro pela interface administrativa:

```html
<p><strong>Instituto Sebastião Tapajós — IST</strong></p>
<p>{{saudacao}} {{comprador_email}}</p>
<p>Seu pagamento foi confirmado. Pedido: {{pedido_estado}}.</p>
<p><strong>Código público do pedido: {{pedido_public_id}}</strong></p>
<p>Guarde esse código. Ele é necessário para recuperar a biblioteca usando o e-mail da compra.</p>
<p>Data da compra: {{data_compra}}</p>
<p>Pagamento confirmado em: {{data_pagamento}}</p>
<p>Situação: {{pagamento_estado}}. Referência: {{pagamento_referencia}}.</p>
<p>{{ambiente}}</p>
<p><strong>Produtos adquiridos</strong></p>
<p>{{itens_compra}}</p>
<p><strong>Total: {{moeda}} {{total}}</strong></p>
<p><a href="{{link_biblioteca}}">Acessar minha biblioteca digital</a></p>
<p>Para recuperar o acesso, informe seu e-mail de compra e o código público do pedido.</p>
<p><a href="{{link_recuperacao}}">Recuperar acesso à biblioteca</a></p>
```

Selecionar a assinatura institucional ativa no cadastro; não duplicá-la no HTML.
A interface é `/admin/emails/modelos`; nenhum modelo foi cadastrado nesta etapa.

Texto legível esperado, **gerado automaticamente pelo compositor**, sem segundo modelo persistido:

```text
Instituto Sebastião Tapajós — IST
{{saudacao}} {{comprador_email}}
Seu pagamento foi confirmado. Pedido: {{pedido_estado}}.
Código público do pedido: {{pedido_public_id}}
Guarde esse código. Ele é necessário para recuperar a biblioteca usando o e-mail da compra.
Data da compra: {{data_compra}}
Pagamento confirmado em: {{data_pagamento}}
Situação: {{pagamento_estado}}. Referência: {{pagamento_referencia}}.
{{ambiente}}
Produtos adquiridos
{{itens_compra}}
Total: {{moeda}} {{total}}
Acessar minha biblioteca digital ({{link_biblioteca}})
Para recuperar o acesso, informe seu e-mail de compra e o código público do pedido.
Recuperar acesso à biblioteca ({{link_recuperacao}})
[Assinatura administrativa selecionada]
```

No editor rico, digitar o conteúdo/formatar parágrafos e preencher o destino dos links com o
placeholder exato, sem prefixo extra. Gerar preview com valores sintéticos e conferir ambos os links
completos no texto. O texto acima é uma referência de resultado, não conteúdo HTML para colar literalmente.

## Validação e publicação futura

Testes unitários usam somente fixtures em memória e envio simulado. Nada é enviado a SMTP/Mailpit.
Integrações MariaDB não são executadas na B7-E2 devido à restrição de não alterar MariaDB.
O teste SQL do worker foi adaptado para injetar mensagem sintética, mantendo seus cenários de
reserva/concorrência isolados da composição. O recibo e a integração worker/compositor têm testes
específicos com mocks que recusam escrita fora da outbox e exigem READ ONLY para os dados históricos.

Antes da B7-E3: revisar contrato/modelo e limite de tamanho, publicar somente arquivos aprovados,
cadastrar e validar modelo/assinatura, reconfirmar SMTP local e só então autorizar processamento.
Não basta ativar o flag antes disso. As três notificações INCERTO da homologação não são reabertas;
qualquer decisão sobre elas exige avaliação e autorização separadas.
Nenhuma migration/dependência/alteração de checkout, Angular, pagamento ou direito foi necessária.

## Resultado da B7-E2

269 testes aprovados, zero falhas; duas integrações MariaDB explicitamente ignoradas.
Nenhuma conexão TCP tentada (bloqueada no processo dos testes). Regressões incluem produtor/outbox,
financeiro simulado, configuração SMTP simulada, templates antigos/OTP, fixtures e worker.
Sintaxe dos arquivos alterados e `git diff --check` aprovados.

Comando utilizado, a partir do repositório:

```bash
node --input-type=module <<'JS'
import net from 'node:net';
let tentativas = 0;
net.Socket.prototype.connect = function () {
    tentativas++;
    throw Error('REDE_PROIBIDA_NESTES_TESTES');
};
for (const k of ['IST_LOJA_PAGAMENTOS_MARIADB_BIN', 'IST_R2_10339_MANIFEST', 'IST_LOJA_MARIADB_NATIVO_10339']) delete process.env[k];
for (const file of ['lojaNotificacoesMensagem.test.js', 'lojaNotificacoesWorker.test.js', 'lojaNotificacoesService.test.js', 'lojaNotificacoesFixture.test.js', 'emailTemplateService.test.js', 'lojaDownloadOperacaoSmtp.test.js', 'lojaPagamentoService.integration.test.js']) await import('./tests/' + file);
process.on('exit', () => {
    console.log('TENTATIVAS_TCP=' + tentativas);
    if (tentativas) process.exitCode = 1;
});
JS
```

## Estado atual para consolidação Git — 30/10/2026

O relato anterior descreve a B7-E2 no momento da implementação. As indicações de “não publicada” e
as duas integrações ignoradas não representam, isoladamente, o estado posterior registrado abaixo.

- **Implementação:** o recibo completo está integrado à outbox, ao worker e ao modelo administrativo
  `confirmacao_compra`, com 14 placeholders, assinatura, HTML/texto, snapshots históricos e aritmética
  exata em centavos. Pagamento `PAGO` e captura integral `CAPTURADO` coerentes são pré-condições.
  Falha de composição ou SMTP não desfaz a compra. Resultado SMTP incerto não autoriza reenvio cego.
- **B7-E2:** o registro inicial informa 269 testes aprovados e duas integrações ignoradas.
- **B7-E3-A:** os registros posteriores informam 179 testes aprovados no arquivo financeiro e 43 no
  arquivo do recibo, incluindo SQL real descartável, composição pelo worker e rejeição de captura
  inconsistente. Os dois grupos anteriormente ignorados eram financeiros; foram acrescentados
  cenários específicos do leitor de recibos. Não somar esses números aos 269 como se fossem uma
  única suíte independente.
- **Publicação WSL2 B7-E3-B:** foram publicados somente `emailPlaceholders.js`, `emailTemplateService.js`,
  `lojaNotificacoesMensagem.js`, `lojaNotificacoesWorker.js` e `lojaNotificacoesAgendador.js`.
  O agendador não foi ativado por essa publicação.
- **Homologação funcional B7-E3-D:** uma notificação sintética em MariaDB 10.3.39 descartável foi
  processada pelo worker publicado com SMTP real restrito ao Mailpit. Houve uma chamada de envio,
  estado `ENVIADO` com uma tentativa e incremento de quatro para cinco mensagens. Modelo e assinatura
  administrativos foram copiados para a fixture. Foram conferidos conteúdo, valores históricos,
  links e assinatura; isso não foi uma nova compra PayPal nem um teste de entrega à internet.
- **Pendência visual:** o código público estava presente no assunto/corpo, mas sem destaque em
  negrito no modelo cadastrado. Não há confirmação de sua correção nesta preparação; o ajuste é
  administrativo, não uma alteração automática do compositor.
- **Limitação live:** compositor e links admitem identificação live, porém worker e agendador
  permanecem restritos a sandbox. Não habilitar recibos live apenas alterando flags. Exige revisão,
  autorização e validação próprias; alinhamento estrutural dos bancos não elimina essa limitação.

As contagens e resultados acima são evidências históricas, não testes reexecutados nesta consolidação.
Não ativar processamento permanente nem reabrir notificações `INCERTO` para validar o commit.
A referência anterior a três notificações incertas é histórica e não deve ser tomada como inventário
atual do banco sem nova consulta autorizada. Nenhum envio foi realizado nesta preparação.

A restauração das seis CHECKs da recuperação é correção estrutural separada do recibo, confirmada pelo
responsável nos dois bancos em 30/10/2026. Não há migration nova ou reaplicação automática nesta etapa.
