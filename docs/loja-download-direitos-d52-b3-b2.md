# D5.2-B3-B2 — transicoes financeiras dos direitos

`criarLojaDownloadDireitosService({ db, agora? })` exige pool injetado, sem pool
padrao, dotenv, timer, HTTP ou efeitos de importacao. Retorna somente
`reavaliarDireitosDoPedido(pedidoId, contextoEsperado)`; contexto interno segue
o avaliador B1: provedor paypal, ambiente sandbox/live e contaRecebedora.
Nao recebe decisao financeira do comprador nem exige login/sessao nao expirada.
Nao concede autorizacao HTTP de download e nao foi integrado a nenhuma rota.

`aplicarTransicoesNaConexao(conexao, avaliacao, contexto)` e auxiliar privado,
chamado somente pela fachada com avaliacao real B1 e direitos bloqueados. Nao
abre transacao ou confirma operacoes. A fachada nao aceita avaliacao injetada.

## Matriz efetiva

- AGUARDANDO_CONFIRMACAO -> ATIVO: B1 ELEGIVEL e elegivel=true;
  origem FINANCEIRO, motivo CAPTURA_CONFIRMADA.
- AGUARDANDO_CONFIRMACAO ou ATIVO -> SUSPENSO: evidencia adversa persistida,
  contradicao ou revisao financeira; motivos controlados EVIDENCIA_ADVERSA,
  EVIDENCIA_CONTRADITORIA e REVISAO_FINANCEIRA.
- ATIVO -> SUSPENSO: evidencia anteriormente suficiente deixa de ser demonstravel
  em avaliacao concluida; motivo EVIDENCIA_INSUFICIENTE.
- AGUARDANDO_CONFIRMACAO permanece quando ha somente pendencia ou insuficiencia.
- ATIVO ja elegivel permanece, sem atualizar datas/versao ou criar evento.
- SUSPENSO e REVOGADO permanecem. Nao ha reativacao ou revogacao automatica.

Reembolso parcial sem atribuicao confiavel suspende todos os direitos do pedido.
Mesmo reembolso total local causa suspensao, pois falta fluxo estruturado definitivo
para revogacao automatica. Nao inventa ingestao de disputas/reembolsos externos.
Falha SQL durante avaliacao provoca rollback, nunca suspensao por falha de rede.
Ausencia de fato adverso local nao prova ausencia de fato externo.

## Transacao e concorrencia

Conexao limpa, autocommit 1, READ COMMITTED, uma transacao propria. Conexao
com transacao preexistente e descartada; nao ha transacao aninhada.
Descoberta de sessao por pedido e leitura sem lock, depois revalidada.

Locks: sessao -> pedido -> pagamentos por ID -> operacoes por ID -> eventos
financeiros por ID -> direitos por ID -> eventos de direitos por versao.
Pedido deve corresponder a sessao descoberta e ao ambiente esperado. Todos
os writers financeiros envolvidos devem seguir o contrato existente de locks.
Nao adquire locks de produto ou publicacao depois dos direitos. Itens e dados
imutaveis da versao sao apenas lidos. Versao adquirida pode estar RETIRADA.

O avaliador B1 e executado sob esses locks. Seus IDs/versoes/estados dos direitos
sao comparados com as linhas bloqueadas. Exige evento correspondente a versao
e estado atuais; historico ausente/incompativel nao e reparado automaticamente.

UPDATE condicional por id, versao, estado anterior e arquivo_versao_id, com
affectedRows=1. Incrementa versao uma vez e insere evento da mesma versao na
mesma transacao, origem FINANCEIRO e motivo controlado. Nao altera arquivo,
pagamento, pedido ou snapshots. Preserva ativado_em/suspenso_em anteriores
conforme CHECKs. Relogio regressivo e overflow de versao sao bloqueados.

Falha entre UPDATE e evento desfaz toda a tentativa, inclusive outros direitos.
Deadlock/lock timeout: rollback completo e ate tres tentativas totais. Falha de
rollback descarta conexao e retorna RESULTADO_DESCONHECIDO, sem retry.
Erros SQL capturados pelo avaliador sao reconhecidos pela fachada para abortar
e preservar a categoria de retry; nao foi necessario modificar o B1.

## COMMIT incerto

Descarta conexao original. Nova transacao, mesma ordem de locks, apenas SELECTs
de aplicacao: confere evento de cada efeito esperado e versao/arquivo atuais.
Nao repete UPDATE/INSERT. Evento esperado ausente -> RESULTADO_DESCONHECIDO.
Versao atual maior e aceita se evento da tentativa existir e arquivo permanecer
igual; nao sobrescreve suspensao posterior. Reavalia financeiramente por leitura
e retorna observacao atual. COMMIT incerto da propria reconciliacao tambem
descarta conexao; nao ha recursao/reconciliacao ilimitada.

Retorno interno: avaliacao, transicoes, direitos atuais (id/estado/versao),
reconciliado. Em reconciliacao, transicoes descreve os efeitos comprovados da
tentativa original; direitos e avaliacao refletem a leitura atual. Nenhum dos
campos e autorizacao de download: futura D6 deve reavaliar antes de autorizar.

## Historicos e validacao

Historicos sem direitos retornam sem insercoes, inclusive pedidos Sandbox sem
conteudo. Contexto Live nao pode usar pedido Sandbox. Nao acessa banco principal,
nao publica PDFs, nao chama PayPal e nao modifica os dois pedidos historicos.

MariaDB 13.0.2: 23 testes especificos aprovados. Regressao conjunta: 121 testes
aprovados, zero falhas/ignorados (transicoes, avaliador B1, criacao B2, contratos).
Inclui dois processos Node independentes e alteracao financeira concorrente.
Credenciais exclusivas da fixture sao fornecidas aos workers somente por stdin,
sem argumentos, variaveis de ambiente ou logs. Instancias/datadirs descartaveis
foram encerrados/removidos pela fixture, sem limpeza generica.

Executor WSL recebe somente seletor d52b3b2 para homologacao no MariaDB 10.3.39.
Responsavel confirmou sucesso e descarte de container, volume e segredos;
Docker/containerd encerrados e inicializacao automatica desativada. Resumo
recebido sem detalhamento TAP; nao se atribui a essa versao o total de 121.

Pendente B3-B3: homologacao integrada adicional e revisao da composicao futura.
Nao implementados: ativacao por webhook/scheduler, endpoints, downloads,
reativacao administrativa, revogacao definitiva ou recuperacao por e-mail.
