# D9-B2 — Worker persistente de eventos adversos

## Ativacao e contrato

Flag independente IST_LOJA_ADVERSOS_ATIVA === 'true'. Ausencia, qualquer outro
valor e NODE_ENV=test nao iniciam timer nem compoem financeiro. Nenhum .env foi
alterado ou worker real ativado. O bootstrap reutiliza obterFinanceiroLoja,
pool e contexto Sandbox existentes. O agendador anterior permanece independente.

Interface interna da fachada financeira:

- processarEventosAdversos({limite:10,signal}): lote sequencial de ate dez.
- diagnosticarEventosAdversos(): contadores por contexto e ultimos erros.
- reconciliarEventoAdverso({eventoId,execucaoToken,signal}): token Buffer de 16
  bytes obrigatorio quando houver reserva PROCESSANDO; sem token, somente
  reconciliação explicita de evento nao reservado ou confirmacao de fato duravel.

Timer de 60 segundos, sem ciclo imediato, sem sobreposicao local. Reserva SQL
impede aplicacao duplicada entre processos. Prazo de reserva: 120 segundos.
Deadline de ciclo: 30 segundos; sinal abortado impede efeitos SQL posteriores.
parar() cancela novos ciclos e aguarda no maximo 35 segundos; ao atingir prazo,
aborta e retorna. Timers sao removidos; pool compartilhado nao e encerrado.
No encerramento do processo, trabalho abandonado fica recuperavel pelo lease.
Relogios dos processos devem estar sincronizados; datas do ledger sao UTC.

## Ledger e estados

Nenhuma migration. Reutiliza estado, tentativas, execucao_token, execucao_ate,
proxima_tentativa_em e codigo_erro, indices de pendencias e CHECKs existentes.
Somente eventos WEBHOOK autenticados dos cinco tipos adversos conhecidos,
no contexto exato, sao elegiveis. IGNORADO e REVISAO nao entram indiscriminadamente.

RECEBIDO elegivel -> PROCESSANDO com token aleatorio e tentativa incrementada.
Reserva vencida -> PROCESSANDO com outro token, ou REVISAO/D9_LIMITE na oitava.
PROCESSANDO -> PROCESSADO na transacao D8 que aplica financeiro, direitos e
historico. PROCESSANDO -> RECEBIDO com proxima tentativa, ou REVISAO.
Todas as saidas de PROCESSANDO limpam token e prazo conjuntamente.

Reservar usa SELECT FOR UPDATE e transacao curta, encerrada antes dos GETs.
Reconciliacao preserva sessao -> pedido -> pagamentos -> operacoes -> eventos
-> direitos -> historicos. Posse, prazo, contexto, evento, hash e JSON original
sao revalidados depois dos GETs e sob locks. Expiracao/cancelamento durante SQL
reverte a aplicacao completa antes do COMMIT. Executor antigo nao encerra lease
novo, mesmo em falha. DATE_FORMAT evita depender de dateStrings ou timezone de
conversao automatica de Date do driver. Nao se faz GET dentro da transacao.

## Erros e retomada

Timeout/rede/429/5xx, falha SQL e snapshot vencido: retentativa limitada.
Backoff base: 1, 5, 15, 60 e 360 minutos; jitter positivo de ate 20%, com teto
absoluto de seis horas. Ate oito tentativas. Reinicio nao zera contadores nem
antecipa proxima tentativa. Lote de dez evita drenagem ilimitada da fila.

401/403 sao classificados pelo adaptador como AUTENTICACAO. Evento vai para
REVISAO/D9_AUTENTICACAO e bloqueia novas reservas do contexto, inclusive apos
reinicio. Console emite alerta fixo e diagnostico agregado. Configuracao/permissao
precisa de revisao operacional; nao existe desbloqueio automatico, endpoint ou
painel novo. Uma retomada deve ser aprovada, conferir a causa e confirmar os
eventos envolvidos pelo fluxo interno, nunca alterar direitos diretamente.

404/contrato invalido, identidade divergente, correlacao ausente/ambigua ou
reversao insuficiente vao para revisao, sem repeticao infinita. Nao se utiliza
nome/email/valor aproximado para escolher pedido. Risco de disputa conserva a
politica D8/D9-B1; movimentacao sem identidade economica nao e contabilizada.

COMMIT incerto na reserva ou reagendamento: ler identidade/hash/token/estado
duraveis em nova conexao, sem repetir escrita cegamente. COMMIT financeiro usa
a confirmacao D8 de fato e direitos. Se continuar incerto, parar o lote e deixar
reserva expirar; nao reaplicar automaticamente dentro da mesma chamada. Evento
ja PROCESSADO exige confirmacao D8; nao duplica reembolso ou suspensao.

Diagnostico: pendentes, processando, leases vencidos, reagendados, esgotados,
revisao e codigos/horarios dos ultimos erros. Nao inclui IDs pessoais, tokens,
credenciais ou corpos brutos. Excecoes nao sao persistidas como mensagens.

## Homologacao

MariaDB 13.0.2 descartavel, transportes simulados. Regressao dirigida: 93
contabilizacoes Node, 92 aprovadas, zero falhas, uma ignorada, exit 0. Verificacao
final de worker/agendadores/composicao: 34 aprovadas, zero falhas/ignoradas, exit 0.
As rodadas se sobrepoem e nao devem ser somadas. A segunda inclui dois novos
casos de falha de conexao sanitizada e limites de jitter.

MariaDB 10.3.39 real descartavel, evidencia retornada pelo executor WSL:
worker 17/17; D8-B3 23 aprovados e um ignorado; D8-B2/B3 24/24.
Total dessa rodada: 64 aprovadas, zero falhas, um ignorado, exit 0.
Ignorado: reversao/chargeback confirmado sem contrato suficiente; nao foi
criada fixture ficticia. Docker/containerd parados; contêiner, volume e segredos
exclusivos removidos, sem remover imagens compartilhadas.

Testados dois processos Node distintos com pools sem dateStrings, reserva
exclusiva, reinicio, token vencido/antigo, expiracao durante GET, backoff,
limite oito, snapshot vencido, cancelamento, rollback e COMMIT incerto, reentrega,
reembolso parcial/integral e disputa. Captura, operacao CAPTURAR, snapshots e
historicos foram preservados; D6/D7 continuam negando PDF apos suspensao.

Uma rodada intermediaria falhou na assercao da porta no executor filho: a
fixture retorna BIGINT como string. A comparacao foi normalizada explicitamente
com Number nos dois lados; nao houve relaxamento da identidade do destino.

Nao houve acesso ao principal, PayPal financeiro externo, SMTP ou PDFs reais.
Instancias/datadirs Windows e servidores HTTP sinteticos descartados; processos
preexistentes preservados. Sem commit/push/deploy. D9-B1 preservada.

Limites: sem descoberta externa, checkpoint, Live, reativacao automatica ou
contabilizacao de reversoes/chargebacks sem contrato. Nenhuma D9-B3 iniciada.
