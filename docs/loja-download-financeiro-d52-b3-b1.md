# D5.2-B3-B1 — avaliador financeiro local

`avaliarElegibilidadeFinanceiraNaConexao(conexao, pedidoId, contextoEsperado)`
recebe conexao e contexto interno `{ provedor: 'paypal', ambiente, contaRecebedora }`.
Nao importa pool, dotenv, HTTP ou adaptador; nao abre/encerra transacao/conexao.
Executa somente SELECTs parametrizados. Nao adquire locks e nao altera dados.

Transacao ativa e obrigatoria. O chamador deve garantir snapshot coerente de
leitura ou, na futura transicao, adquirir locks na ordem sessao -> pedido ->
pagamentos -> operacoes -> evidencias -> direitos. O avaliador sozinho nao
garante que a evidencia continue atual depois de retornar. READ COMMITTED sem
os locks necessarios nao e contrato suficiente para uma futura transicao.

## Resultado interno

Retorna classificacao (ELEGIVEL, PENDENTE, REVISAO, ADVERSO, INCONSISTENTE),
elegivel, motivos controlados, evidenciaAdversaPersistida, evidenciaInsuficiente,
evidenciaContraditoria, referencias e limiteEvidencia=SOMENTE_PERSISTENCIA_LOCAL.
Prioridade: adverso -> inconsistencia/insuficiencia -> revisao -> pendente -> elegivel.
PENDENTE significa quitacao ainda nao demonstrada, incluindo tentativa recusada
sem pagamento confirmador; nao afirma que existe operacao externa em andamento.

Referencias contem somente IDs/versoes internos de pedido, sessao, pagamentos,
operacoes, eventos e direitos, incluindo estado atual e versao de arquivo fixada.
Nao retorna e-mail, recebedor, valores individuais, IDs externos, JSON bruto ou
caminhos privados. E um contrato interno, nao um DTO HTTP nem prova de posse.

`elegivel` descreve exclusivamente a evidencia financeira. Direito REVOGADO
continua terminal; SUSPENSO exige politica de reativacao controlada. O avaliador
nao autoriza essas transicoes nem acesso ao PDF. A camada futura deve conferir
o estado retornado e a sessao proprietaria independentemente da avaliacao.

## Criterios

Exige pedido PAGO, confirmacao datada coerente, BRL, ambiente esperado, total
positivo e ausencia de revisao. Um unico pagamento confirmador CAPTURADO, com
provedor/ambiente/recebedor esperados, ordem/captura identificadas, valor e
capturado iguais ao total e reembolso zero. Nunca soma capturas distintas.

Exige operacao CAPTURAR SUCESSO, envio/conclusao datados e resultado normalizado
persistido, com referencia, ordem, captura, moeda, valor, ambiente, recebedor
observado e instante iguais aos fatos locais. A coluna conta_recebedora sozinha
nao prova o recebedor observado. Reutiliza os normalizadores financeiros reais.

Envelope de reconciliacao atual exige PRESENTE, CONFIRMADA, CONSISTENTE e
COMPLETED. Eventos antigos PENDING podem ser superados por resultado posterior
COMPLETED; evidencia adversa/contraditoria antiga nao e apagada automaticamente.
Reconcilicao sem envelope suficiente nao autoriza. Eventos WEBHOOK nao sao
interpretados como resultados financeiros: assinatura/processamento nao provam
captura; um webhook ainda pendente impede elegibilidade. Eventos internos nao
recebem tratamento de webhook apenas por possuirem autenticado_em.

Soma snapshots, exige quantidade 1 e itens digitais suportados (incluindo
snapshot historico E-Book). Confere direito/item/produto/versao. Arquivo adquirido
deve ter sido publicado ate a criacao do pedido; pode estar RETIRADO agora.
Nao consulta o arquivo fisico, nao troca a versao e nao reconstroi direitos.

Reembolso/estorno persistido bloqueia. Motivos normalizados BUYER_COMPLAINT,
CHARGEBACK e REFUNDED ou status REFUNDED/PARTIALLY_REFUNDED sao adversos locais.
Isso nao implementa ingestao de disputas ou reembolsos: os testes usam evidencia
sintetica representavel pelo contrato, sem afirmar cobertura operacional D8.
Ausencia de evento adverso local nao prova ausencia de fato externo.

Contexto Sandbox nao e aceito como Live. Nenhum pedido historico, inclusive os
dois Sandbox reais, e consultado ou modificado pelos testes. Ausencia de direito
nega elegibilidade, sem backfill. Nao envia e-mail e nao autentica por e-mail.

## Validacao

MariaDB 13.0.2: 58 testes aprovados, sem falhas/ignorados, incluindo SQL real em
transacao READ ONLY, repeticao sem mutacao e variantes em fixture descartavel.
Mocks cobrem vinculos invalidos que FKs impedem fabricar no banco real.
DDL apenas monta o schema sintetico homologado da fixture; nenhuma migration
ou escrita no banco principal. Nenhum PDF real ou pagamento externo utilizado.

MariaDB 10.3.39: responsavel informou sucesso do seletor d52b3b1 e remocao do
container, volume e segredos; Docker/containerd encerrados, sem autostart.
Resumo recebido sem TAP; nao foi repetida a execucao.

Proxima etapa, nao implementada: transicoes e eventos atomicos dos direitos,
controle otimista, autorizacao administrativa e recuperacao de COMMIT incerto.
