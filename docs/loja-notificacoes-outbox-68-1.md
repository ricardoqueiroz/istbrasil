# Etapa 68.1 — Outbox de confirmacao de compra

Fundacao somente. Nao envia SMTP, nao registra endpoints, workers, timers ou
reprocessamento. Nao altera direitos digitais nem dados historicos.

## Producao da notificacao

`lojaPagamentoService.aplicar` registra a notificacao imediatamente depois da
transicao validada de pedido nao pago para `PAGO`. Captura, reconciliacao e webhook
convergem nesse mesmo caminho. O evento financeiro chamado CAPTURADO isoladamente
nao e o gatilho: ele pode ser persistido antes das validacoes finais.

O produtor recebe a conexao transacional existente. O pedido ja esta bloqueado e
o `comprador_email` e lido pela persistencia financeira nesse mesmo lock. A
notificacao usa exatamente esse endereco e o ambiente do pedido, nunca dados do
PayPal. Nao ha commit, rollback, retry, release ou conexao propria no produtor.

Unicidade `(pedido_id,finalidade)` e lock existente protegem a identidade logica.
Repeticoes de resultados finais retornam sem produzir outra notificacao; pedidos
historicos pagos sem outbox permanecem assim. Colisao inesperada nao e mascarada
por INSERT IGNORE ou UPSERT; a transacao falha conservadoramente.

## Contrato persistido

Tabela `ist_loja_notificacoes`: `id`, `public_id` UUID, `pedido_id`, finalidade
`CONFIRMACAO_COMPRA`, ambiente `sandbox|live`, `destinatario` ASCII normalizado,
estado inicial `PENDENTE`, tentativas inicialmente zero. O suporte ao valor live
no schema nao habilita PayPal Live no sistema.

Campos reservados para 68.2: estados `PROCESSANDO`, `ENVIADO`, `FALHA`, `INCERTO`;
token opaco de reserva interna e validade, inicio de processamento, conclusao,
proxima tentativa, datas de criacao/atualizacao e codigo de erro sanitizado.
Nao guardar mensagem bruta de excecao, credenciais, cookies, tokens de download,
URLs privadas ou caminhos fisicos. Destinatario e dado pessoal: acesso restrito
e nenhuma inclusao em logs ou DTOs publicos existentes.

## Migration e implantacao

`migrations/ist_loja_notificacoes_fundacao.sql` cria somente a outbox InnoDB, com
FK RESTRICT para pedido, UNIQUE, indice de processamento e CHECKs. Exige schema
explicitamente confirmado na sessao, autorizacao DDL, modo estrito, autocommit,
FK/CHECK ativos, contrato do pedido e versao prevista (10.3.39 ou 13.0.2).
As variaveis SQL nao comprovam identidade ou isolamento; isso exige verificacao
externa. Nao ha aplicacao automatica nem autorizacao de execucao persistente.
Reaplicacao em tabela existente e rejeitada. DDL tem COMMIT implicito: parar e
inspecionar qualquer falha antes de uma nova tentativa; nao apagar dados para
contornar a verificacao.

Aplicar e verificar a migration ANTES de ativar o codigo financeiro novo, em
janela operacional separadamente autorizada. Sem a tabela, a confirmacao local
falha e entra no tratamento existente de resultado desconhecido/reconciliacao.
Isso nao desfaz uma captura externa ja realizada. Nao permitir novas capturas
durante uma implantacao em que codigo e schema estejam incompatíveis.

## Validacao e limites

Testes unitarios e integracao simulada do nucleo financeiro cobrem atomicidade,
rollback depois do INSERT, repeticoes, webhook, concorrencia simulada, destinatario,
ambiente e ausencia de backfill. SQL, FK/CHECK e locks reais ainda exigem
homologacao autorizada nas duas versoes; doubles nao substituem essa prova.
As suites SQL existentes que confirmam pagamentos precisarao preparar tambem
esta migration no schema descartavel antes de executar o novo codigo.

68.2 deve implementar reserva concorrente, SMTP fora da transacao, erros
sanitizados, recuperacao de reserva e tratamento conservador de envio incerto.
Um resultado SMTP aceito com ACK local perdido nao permite prometer exactly-once.
O e-mail deve identificar Sandbox, pedido e URL HTTPS da biblioteca autenticada,
sem anexos ou links diretos para PDFs. Esta etapa nao cria notificacoes retroativas.
