# D9-B4 — Homologacao integrada local

Data: 2026-10-21. Baseline main/ddd1557df41a8e731b163aea19f38abef26ee2e7,
40 caminhos pendentes e staging vazio. Nenhum teste usa istbrasil ou PayPal externo.

## Matriz de evidencias

| Percurso ou falha | Evidencia automatizada reutilizada ou acrescentada |
| --- | --- |
| Descoberta -> observacao API -> worker -> D8 -> HTTP D6/D7 | lojaIntegridadeFinanceiraD9.integration.test.js: compra e captura simulada pelos servicos, direito ativo, recuperacao real, observacao API, worker, suspensao e GET/HEAD negados nas duas autoridades |
| Webhook autenticado -> persistencia -> worker; convivencia API | Mesmo percurso: verificacao de assinatura simulada pelo adaptador, webhook posterior e reentrega, duas origens no ledger sem dupla contabilizacao; lojaDescoberta.integration.test.js cobre webhook anterior a descoberta |
| Disputa descoberta, correlacao e resolucao favoravel | lojaDescoberta.integration.test.js: OPEN e RESOLVED preservam suspensao; sem correlacao permanece REVISAO sem escolher pagamento |
| Refund perdido, parcial e integral | Descoberta recupera notificacao ausente; lojaPagamentoAdversoWorker.integration.test.js e lojaPagamentoAdverso.integration.test.js cobrem parcial/integral e refund canonico entre fontes |
| Repeticao de janela, pagina interrompida e reinicio | lojaDescoberta.integration.test.js: mesma janela retomada desde pagina inicial; observacoes persistidas deduplicadas; checkpoint apenas apos ultima pagina |
| Checkpoint e COMMIT incerto | Seis casos novos: antes/depois do COMMIT de reserva, pagina e conclusao; conexao destruida, leitura duravel, retomada limitada, uma observacao e um efeito financeiro |
| Reservas vencidas e executor antigo | Descoberta revalida token/janela/prazo; worker revalida token apos GET; executor antigo nao persiste nem encerra reserva nova |
| Concorrencia entre processos | Worker existente testa dois processos Node distintos e pools sem dateStrings; descoberta testa instancias/conexoes concorrentes sob SELECT FOR UPDATE |
| Indisponibilidade, 429/5xx, permissao | Provider simulado classifica 401/403/429/500; agendadores testam deadline/cancelamento; SQL testa backoff, oito tentativas, contexto pausado e diagnostico de esgotados |
| Falha SQL e suspensao atomica | lojaPagamentoAdversoDireitos.integration.test.js e worker: falha no historico/UPDATE/COMMIT, rollback e confirmacao duravel; nenhuma suspensao parcial |
| ATIVO e AGUARDANDO_CONFIRMACAO | Reembolso parcial suspende ambos; SUSPENSO nao duplica historico e REVOGADO nao reativa |
| Download e corrida com PDF | D6/D7 HTTP real com PDF sintetico; suspensao durante preparacao bloqueia todos os bytes na autorizacao final; entrega ja autorizada permanece correta, proxima e negada |
| Captura e historicos | Snapshot de itens, operacoes CAPTURAR, identificadores/valor/data de captura e evidencia CAPTURADO permanece identico no novo percurso |
| Sem correlacao/reversao insuficiente | Revisao conservadora; nenhuma identidade economica inventada ou pagamento escolhido por aproximacao |
| Flags independentes | Quatro combinacoes de descoberta/worker testadas; nenhum ciclo imediato; descoberta ativa/worker desligado persiste RECEBIDO sem reembolso ou transicao de direito |
| Assinatura invalida e bootstrap | lojaPaypalWebhook.test.js nega antes de persistir; serverComposicao.test.js preserva rotas atuais sem abrir portas nem acessar servicos |

Nao se confunde assinatura simulada em teste com verificacao PayPal real.
Nao se afirma teste de dois processos de descoberta: essa concorrencia e coberta
por duas instancias com conexoes SQL independentes; dois processos reais sao do worker.

## MariaDB 13.0.2

Rodada dirigida unica apos os testes novos, incluindo onze arquivos:

```powershell
$env:IST_LOJA_PAGAMENTOS_MARIADB_BIN='C:\Program Files\MariaDB 13.0\bin'
node --test --test-reporter=spec tests/lojaIntegridadeFinanceiraD9.integration.test.js tests/lojaDescoberta.integration.test.js tests/lojaPagamentoAdversoWorker.integration.test.js tests/lojaPagamentoAdversoDireitos.integration.test.js tests/lojaPagamentoAdverso.integration.test.js tests/lojaDescobertaProvider.test.js tests/lojaDescobertaAgendador.test.js tests/lojaPagamentoAdversoAgendador.test.js tests/lojaDisputaContratoD9.test.js tests/lojaPaypalWebhook.test.js tests/serverComposicao.test.js
```

143 contabilizacoes Node (incluem grupos), 142 aprovadas, zero falhas,
uma ignorada, zero canceladas, exit 0. Nao somar o ensaio focal anterior.
Instancias 13.0.2 reais, portas/datadirs temporarios validados pelas fixtures e
removidos. O ignorado e o caso anterior de reversao/chargeback sem contrato de
correlacao suficiente; nao representa aprovacao dessa funcionalidade.

## MariaDB 10.3.39

Executor: scripts/loja-d9b4-homologar-mariadb10339-wsl.sh.
Imagem oficial fixada em
sha256:a4b57b620852e26f2c306c79fd8a61e22c7cd6e55d0a55d5521854ed2c370102.
Autenticacao sudo pessoal, credencial temporaria por arquivo, identidade e
autenticacao positiva/negativa verificadas; schema sintetico separado por suite.
Nao modifica os executores anteriores nem instala software.

Execucao pessoal no WSL concluida, com saida sanitizada fornecida pelo usuario:
versao efetiva 10.3.39-MariaDB-1:10.3.39+maria~ubu2004,
127.0.0.1:13339 externo / 3306 interno.

| Suite | Tests | Pass | Fail | Skipped |
| --- | ---: | ---: | ---: | ---: |
| Percurso D9-B4 e flags | 5 | 5 | 0 | 0 |
| Descoberta/checkpoint, incluindo seis COMMITs incertos | 23 | 23 | 0 | 0 |
| Suspensao D8 e HTTP D6/D7 | 24 | 23 | 0 | 1 |
| Worker D9-B2 | 17 | 17 | 0 | 0 |
| Reconciliacao adversa | 24 | 24 | 0 | 0 |
| Total da rodada | 93 | 92 | 0 | 1 |

Zero canceladas. CODIGO_DE_SAIDA_TESTES=0. O ignorado e o mesmo contrato
insuficiente de reversao/chargeback, sem fixture ficticia.
Schemas sinteticos separados: ist_loja_67_3_a058080dbd92 (percurso),
ist_loja_67_3_4e8ec07492a1 (descoberta), ist_loja_67_3_e3809eab31a3 (D8),
ist_loja_67_3_0651838f5c91 (worker), ist_loja_67_3_57e91c61d4cb (reconciliacao).
Executor confirmou remocao do container, volume e segredos exclusivos, com imagens
compartilhadas preservadas. Docker/containerd encerrados e inicializacao automatica
permaneceu desativada. Nenhum teste foi repetido apos essa evidencia suficiente.

## Configuracoes, migration e limites

Worker e descoberta continuam desligados por padrao, por flags literais e
independentes. NODE_ENV=test bloqueia inicio automatico. Os testes de flags usam
env injetado e timers controlados, sem alterar .env ou ativar tarefas operacionais.

Migration original: migrations/ist_loja_descoberta_adversa.sql, sem alteracao
nesta etapa. Apenas schemas descartaveis autorizados. UNIQUE por contexto/fonte,
CHECKs e rejeicao de configuracao/destino invalidos testados; nao existe FK nova
para historicos. Nao aplicada no principal; guard continua bloqueando istbrasil.

Nenhum defeito funcional demonstrado; nenhuma correcao de producao realizada.
Alteracoes desta etapa: novo teste integrado, seis casos adicionais no teste de
descoberta, executor WSL especifico e este relatorio.

Continuam fora da homologacao: reversoes/chargebacks sem identidade economica e
correlacao comprovadas, permissoes reais da conta, descoberta real no PayPal,
Live, aplicacao da migration no principal e ativacao operacional. Uma janela
concluida nao garante cobertura historica integral de todas as fontes PayPal.

Sem novas funcionalidades, frontend, checkout, PDFs comerciais, migrations ou
autorizacao D6/D7 modificados. Sem commit, push, deploy ou ativacao operacional.

## Fechamento

Sintaxe JavaScript dos testes e Bash do executor aprovada; git diff --check sem
erros. Os 14 caminhos protegidos foram comparados por SHA-256 e preservados.
Banco principal e dois pedidos Sandbox historicos nao foram acessados; servidores
preexistentes nao foram reiniciados ou encerrados. Portas 3000/3001/4200/4201 livres
na verificacao local. Git permanece main no HEAD da baseline, 43 caminhos pendentes
e staging vazio, incluindo as alteracoes preexistentes D9-B1/B2/B3.

Parecer: D9-B4 APROVADA PARA HOMOLOGACAO LOCAL, com as limitacoes acima.
Isto nao declara prontidao para producao nem autoriza ativacao dos agendadores.
