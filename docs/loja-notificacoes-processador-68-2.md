# Etapa 68.2 — Processador duravel de notificacoes

## Composicao

O produtor 68.1 continua exclusivamente financeiro/transacional. O worker
`lojaNotificacoesWorker.js` usa somente a outbox, sem alterar pedidos, pagamentos,
eventos ou direitos digitais. A mensagem e composta em
`lojaNotificacoesMensagem.js`. O transporte reutiliza a configuracao SMTP estrita
existente de `mailService.js`, com classificacao opcional de nao aceitacao. A
interface de recuperacao anterior mantem seu comportamento por padrao.

O processador opera apenas em Sandbox. Recebe conexao/pool explicitamente e nunca
importa o pool padrao ou usa DB_* como fallback. Nao existe API publica para
escolher ambiente, destinatario, template ou resetar notificacoes.

## Reserva e estados

READ COMMITTED, SELECT FOR UPDATE e UPDATE na mesma transacao reservam uma linha.
Nao usa SKIP LOCKED ou recursos posteriores ao MariaDB 10.3.39. A reserva usa
token aleatorio de 32 bytes e dura 60 segundos; o SMTP tem prazo de 20 segundos.
Antes de invocar o transporte, outra transacao curta confirma token e validade.
Cada transacao termina antes do SMTP. COMMIT de reserva incerto impede o envio.
COMMIT de finalizacao incerto nao autoriza repeticao automatica.

As atualizacoes de resultado exigem token, ambiente, PROCESSANDO e reserva ainda
valida. Uma operacao antiga nao encerra reserva alheia. Nao ha locks financeiros.
Consultas tem timeout de 5 segundos; aquisicao de conexao tambem e limitada, com
liberacao de conexao entregue tardiamente. Conexao suja ou com COMMIT incerto e
descartada. Nenhum retry SQL automatico e feito pelo worker.

- PENDENTE/FALHA: elegiveis somente com proxima tentativa vencida e menos de cinco
  tentativas. Cada reserva incrementa o contador uma vez.
- ENVIADO: transporte confirmou aceitacao; nao significa entrega na caixa postal.
- FALHA: erro comprovadamente anterior a aceitacao, cancelamento anterior a
  invocacao ou mensagem invalida. Backoff de 60, 120, 240 e 480 segundos; apos a
  quinta tentativa a proxima data fica NULL e exige intervencao operacional.
- INCERTO: timeout, cancelamento durante transporte ou falha sem prova de nao
  aceitacao. Nao tem reenvio automatico.
- PROCESSANDO expirada: passa a INCERTO, sem envio. A 68.1 nao possui marcador de
  inicio SMTP; por isso toda reserva expirada e tratada conservadoramente, mesmo
  quando o processo pode ter morrido antes de enviar.

Falhas SMTP de DNS/autenticacao, conexao antes do DATA e rejeicoes explicitas
4xx/5xx em comandos conhecidos podem gerar FALHA. Desconexao/timeout durante DATA
ou erro em QUIT nao provam que a mensagem nao foi aceita. O adaptador nao preserva
mensagem bruta, resposta SMTP, destinatario ou credenciais no erro persistido.

SMTP nao oferece exactly-once. A promise do transporte pode terminar depois do
timeout/cancelamento do worker; ela permanece observada, mas nao permite nova
tentativa da mesma notificacao. Fechar um processo tambem nao desfaz uma mensagem
ja aceita. Revisao/reprocessamento manual de INCERTO ou tentativas esgotadas exige
procedimento operacional posterior; nao foi criado endpoint de reset.

## Mensagem

Texto simples, sem anexos: "Homologacao — PayPal Sandbox — sem cobranca real",
numero do pedido e https://istbrasil.org.br/loja/biblioteca. O destinatario e
exatamente o persistido na outbox. O link nao autentica nem concede direitos.
Nao ha links privados ou tokens de download. A mensagem nao promete que os
direitos continuem ativos apos eventual evento financeiro adverso posterior.

## Ativacao explicitamente desabilitada por padrao

`server.js` compoe o agendador com o pool existente. So inicia com:

- IST_LOJA_NOTIFICACOES_ATIVAS=true;
- NODE_ENV=production ou development (test sempre desativa o agendador);
- LOJA_AMBIENTE=sandbox e IST_LOJA_PAYPAL_ENV=sandbox;
- configuracao SMTP estrita valida, usando SMTP_HOST, SMTP_PORT (465/587),
  SMTP_SECURE, SMTP_REJECT_UNAUTHORIZED=true, MAIL_FROM_NAME, MAIL_FROM_ADDRESS,
  IST_LOJA_RECUPERACAO_SMTP_AUTENTICACAO=relay ou login; SMTP_USER/SMTP_PASS apenas
  para login. Nenhum valor e definido automaticamente nesta etapa.

O primeiro ciclo ocorre somente apos 60 segundos, com lote maximo de dez. Nao ha
sobreposicao de ciclos no processo, e chamadas repetidas com o mesmo pool recebem
o mesmo handle. Processos PM2 distintos compartilham a exclusividade SQL, sem
depender do WeakMap local. Logs contem somente codigos e contadores fechados.
Na parada, cancela o timer, sinaliza cancelamento e aguarda o ciclo encerrar; nao
fecha pool compartilhado. Confirmacoes financeiras nao aguardam SMTP.

## Validacao e pendencias 68.3

Testes locais usam SMTP simulado, incluindo aceitacao, rejeicao, timeout, duas
instancias do worker, expiracao, token adulterado, limite/backoff e desligamento.
Teste SQL usa exclusivamente a fixture MariaDB 13.0.2 ja autorizada. Nenhuma
migration adicional e necessaria: sao utilizados os campos e CHECKs da 68.1.

Antes de ativar no VPS: homologar MariaDB 10.3.39, conferir migration 68.1 e schema,
validar relay Google Workspace e recebimento real, rever permissao de acesso aos
destinatarios e preparar procedimento de revisao das notificacoes INCERTO/FALHA
esgotadas. Nao habilitar a flag antes dessas verificacoes autorizadas. Nao houve
envio SMTP real, acesso ao VPS, pagamentos ou ativacao operacional nesta etapa.
