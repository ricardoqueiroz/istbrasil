# Etapa 68.3 — Experiência Sandbox hospedada

O checkout aceita somente o ambiente Sandbox validado pelo backend. A consulta
de estado retorna `ambiente` do pedido persistido, confrontado com o ambiente
operacional pelo serviço financeiro. Configuração SDK divergente impede o fluxo.
A interface não infere o ambiente pelo domínio nem pela conta PayPal.

Checkout e confirmação identificam: **Homologação — PayPal Sandbox — sem cobrança
real** após receber esse estado. O endereço real informado no carrinho continua
sendo o endereço persistido do comprador, independentemente da conta Sandbox.

## Confirmação e biblioteca

A interface distingue pedido criado, espera por aprovação, aprovação recebida,
captura em processamento, recusa e pendência de reconciliação. Somente pedido
PAGO, pagamento CAPTURADO do mesmo pedido e confirmação financeira persistida
permitem mostrar sucesso. O callback de aprovação não confirma a compra.
Consultas são manuais e limitadas por ação, sem polling automático.

Após confirmação, o link leva a `/loja/biblioteca`. A sessão de compra existente
autoriza a consulta; em outro navegador ou após expiração, utiliza-se a recuperação
por e-mail já existente. A posse do link público não autentica, não cria usuário
e não concede direito digital. Downloads continuam sujeitos aos direitos e à
autorização existentes. Não são incluídos PDFs nem links privados no e-mail.

O worker obtém o identificador público do pedido ao reservar a notificação, sem
modificar registros financeiros. A mensagem identifica Sandbox, o UUID público
do pedido e `https://istbrasil.org.br/loja/biblioteca`. O destinatário é o persistido
na outbox. A confirmação da interface não afirma que o e-mail já foi entregue.

## Inspeção operacional protegida (não executada nesta etapa)

O agendador permanece desligado, sem criar transporte ou timer, salvo quando
`IST_LOJA_NOTIFICACOES_ATIVAS` é exatamente `true`; em `NODE_ENV=test` fica desligado
mesmo com a flag. Nenhuma variável é ativada automaticamente.

Um operador autorizado deve primeiro conferir host, schema e ambiente no acesso
administrativo restrito. A consulta abaixo é apenas proposta para inspeção,
nunca exposta por endpoint público, e não seleciona destinatário ou token:

```sql
SELECT public_id, pedido_id, ambiente, estado, tentativas, reserva_ate,
       proxima_tentativa_em, ultimo_erro_codigo, atualizado_em
FROM ist_loja_notificacoes
WHERE ambiente = 'sandbox' AND finalidade = 'CONFIRMACAO_COMPRA'
  AND (estado = 'INCERTO'
       OR (estado = 'FALHA' AND tentativas >= 5)
       OR (estado = 'PROCESSANDO' AND reserva_ate <= UTC_TIMESTAMP(3)))
ORDER BY id;
```

- INCERTO: investigar a aceitação no relay por canal restrito. Não reenviar
  automaticamente, nem resetar o estado presumindo ausência de entrega.
- FALHA esgotada: corrigir primeiro a causa operacional. Reprocessamento requer
  autorização e procedimento específico posterior; esta etapa não cria reset.
- PROCESSANDO expirada: o worker habilitado trata conservadoramente como INCERTO,
  sem reenviar. Não modificar a reserva de um processo em execução.

Não publicar resultados, destinatários, respostas SMTP brutas ou dados financeiros
em logs públicos. ENVIADO comprova aceitação pelo transporte, não caixa postal.

## Limites antes da homologação hospedada

Esta entrega não executa SMTP, PayPal, migrations ou deploy. Antes de ativar no
VPS, ainda são necessárias autorização operacional, conferência da migration
68.1, compatibilidade SQL do worker no MariaDB 10.3.39, configuração do relay e
validação real de entrega, HTTPS/cookies/Origin, webhook Sandbox autenticado e
isolamento dos pedidos de teste. PayPal Live continua fora do escopo.

O produto especial Sandbox sem conteúdo possui exceção somente em development/test.
Com `NODE_ENV=production`, a homologação deve utilizar produto DIGITAL elegível
com versão PUBLICADA; esta entrega não amplia aquela exceção nem publica PDFs.

Validação local desta etapa: regressões Node com banco/transporte/provedor
simulados e compilação Angular de aplicação e specs com `--noEmit`. Os novos
testes Angular foram compilados, sem execução em navegador. O percurso hospedado
e a entrega efetiva de e-mail continuam dependentes de autorização específica.
