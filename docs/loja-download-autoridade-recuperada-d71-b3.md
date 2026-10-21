# D7.1-B3 — duas autoridades nos downloads D6

Sem endpoints paralelos, SMTP, Angular, D8 ou alteracao de migrations. Sem banco
principal ou PDFs comerciais. Mesmo avaliador financeiro D6 e preparador de PDF.

## Selecao de autoridade

Objeto interno tipado (JSDoc): `{tipo:'COMPRA'|'RECUPERACAO',token}`. Nao vem de
body/query/header de selecao. Strings continuam aceitas internamente como COMPRA
para preservar consumidores existentes. O middleware decide exclusivamente pelos
cookies configurados para o ambiente.

Se houver cookie de recuperacao, ele prevalece, inclusive quando invalido,
expirado, revogado ou duplicado. Nao ocorre fallback para COMPRA nem uniao de
direitos. Sem esse cookie, permanece o fluxo original. Para voltar a COMPRA e
necessario remover/encerrar explicitamente a sessao recuperada no cliente.

COMPRA continua usando o servico original de sessao, hash e CSRF. RECUPERACAO
confere o hash com o dominio da B1, consumo, datas UTC, prazo absoluto <=24h e
revogacao em `ist_loja_download_recuperacoes`, sob FOR UPDATE. Nao precisa da
chave HMAC de email para ler uma sessao ja emitida. Nao renova nem cria sessao.

## Escopo e listagem

GET /api/loja/downloads/direitos reutiliza o DTO e a paginacao D6 (padrao 20,
maximo 50). RECUPERACAO faz JOIN pelo recuperacao_id, direito_id e versao adquirida
persistidos na B1. Sem busca posterior por email. Compras posteriores ficam fora.
Nenhuma listagem ativa direitos ou concede uma decisao financeira definitiva.

Localizacao, reavaliacao e arquivo usam o mesmo vinculo SQL restritivo. Direito
fora do escopo, inexistente ou com versao diferente da fixada retorna o mesmo
404, sem tentar outra autoridade e sem revelar dados financeiros/caminhos.

## POST de reavaliacao

Mesmo endpoint D6, JSON vazio, Origin explicito permitido e CSRF obrigatorio.
Para recuperacao reutiliza exatamente o bootstrap assinado B2 (15 minutos);
as funcoes foram extraidas para middleware compartilhado, mantendo seu contrato.
CSRF da compra nao substitui o recuperado.

O servico de transicoes recebe uma guarda interna opcional, nunca do navegador.
Ela e chamada apos BEGIN, antes dos locks existentes, depois desses locks e antes
do COMMIT. Revalida a recuperacao e o direito solicitado e retorna somente seu ID.
O mesmo mecanismo participa de retry/reconciliacao de COMMIT incerto. Nenhum novo
avaliador ou regra de transicao foi criado. Somente o direito solicitado dentro
do escopo pode sofrer transicao; outros itens do pedido ficam intactos.
Suspensos e revogados continuam sem reativacao automatica.

Sem guarda (COMPRA ou chamadas internas financeiras anteriores), preserva a
reavaliacao existente do pedido inteiro. A avaliacao financeira ainda considera
todo o pedido, mesmo quando o alvo de transicao e um unico direito recuperado.

## GET/HEAD e locks

Middleware valida a sessao; autorizacao interna revalida com locks antes da
preparacao e novamente depois dela. RECUPERACAO bloqueia sua linha PRIMEIRO,
depois sessao original -> pedido -> pagamentos -> operacoes -> evidencias ->
direitos. Nao exige que a sessao original ainda esteja vigente para recuperacao.
O fluxo COMPRA preserva sua exigencia original de validade.

Ambas as autoridades usam a MESMA funcao de autorizacao financeira final,
checagem ATIVO e metadados do PDF. Versao deve coincidir com direito e escopo;
nenhum fallback para publicacao nova. Recuperacao revogada confirmada antes da
autorizacao final nega a entrega. O lock da recuperacao serializa revogacao,
download e reavaliacao, sem manter locks durante leitura do PDF ou envio.

Preparacao mantem SHA-256, tamanho, caminhos privados, capacidade e cancelamento.
Controller mantem duas autorizacoes, igualdade de metadados e COMMIT antes dos
bytes, GET integral e HEAD sem corpo, no-store e ausencia de Range/ETag.
Rate/concurrency keys possuem namespace RECUPERACAO independente de COMPRA;
permanecem 2 entregas simultaneas, 10 GET/HEAD e 10 POST/minuto, lista 30/minuto.
Esses limites continuam em memoria por processo.

## Testes e limites

Teste novo `tests/lojaDownloadAutoridadeRecuperada.integration.test.js` usa apenas
fixture SQL existente, migration B1 intacta e PDFs gerados em TEMP. Sessao
recuperada e emitida pelo servico B1 real; bootstrap CSRF e obtido pelo HTTP B2.
Checkout e testado pelo router real com composicao sintetica; administracao pelo
middleware JWT real em rota sentinela, sem carregar funcoes administrativas.

Instrumentacao SQL de teste e por requisicao (AsyncLocalStorage): transacao de
outra requisicao concorrente nao implica lock mantido pela que esta lendo PDF.
Barreiras concorrentes possuem prazo e liberacao em finally.

## Resultados executados

MariaDB 13.0.2/Windows, somente instancias da fixture descartavel:

```powershell
$env:IST_LOJA_PAGAMENTOS_MARIADB_BIN='C:\Program Files\MariaDB 13.0\bin'
node --test --test-reporter=spec tests/lojaDownloadAutoridadeRecuperada.integration.test.js
node --test --test-reporter=spec tests/lojaDownloadAutorizacaoService.test.js tests/lojaDownloadDireitosService.test.js tests/lojaDownloadsHttp.integration.test.js tests/lojaDownloadRecuperacaoHttp.test.js
node --test --test-reporter=spec tests/lojaDownloadsHttp.test.js tests/lojaDownloadRecuperacaoService.test.js tests/serverComposicao.test.js
```

- B3 corrigida: 15 testes, 15 aprovados, 0 falhas, 0 cancelados/ignorados.
- Regressao de autorizacao, transicoes, HTTP SQL D6 e B2: 68 aprovados, 0 falhas,
  0 cancelados/ignorados.
- Regressao HTTP D6, B1 e composicao: 57 aprovados, 0 falhas, 0 cancelados/ignorados.
- Total dos conjuntos finais distintos: 140 contabilizacoes aprovadas.

A primeira execucao B3 terminou por timeout no teste concorrente: 12 aprovados,
1 falha de grupo e 2 cancelados. A assercao de teste usava contador global de
transacoes e confundia uma transacao de outra requisicao com a da leitura do PDF;
a barreira aguardava uma segunda leitura que nao chegava. Corrigidos somente a
instrumentacao do teste, usando AsyncLocalStorage, e seus prazos/liberacoes. A
fixture anterior confirmou shutdown e descarte antes da nova execucao. Nao foi
alterada politica de integridade/financeira nem retirado cenario para aprovar.

MariaDB 10.3.39 real no Docker/WSL, executado pelo usuario com sudo pessoal:

```bash
sudo bash /mnt/c/inetpub/wwwroot/istbrasil.org.br/scripts/loja-d71b3-homologar-mariadb10339-wsl.sh
```

Saida fornecida: 10.3.39-MariaDB-1:10.3.39+maria~ubu2004; externo
127.0.0.1:13339, interno 3306. D7_1_B3_D6_REAL: 15 testes, 15 aprovados,
0 falhas, 0 cancelados, 0 ignorados, CODIGO_DE_SAIDA_TESTES=0. Confirmados
autenticacao, identidade e descarte de container/volume/segredos; Docker e
containerd encerrados, sem habilitar autostart. Nao foram repetidas todas as
regressoes historicas nessa versao; o percurso B3 completo foi executado.

As fixtures Windows tambem confirmaram encerramento e remocao dos datadirs.
Sintaxe Node, sintaxe Bash do executor e git diff --check aprovados.

O endpoint de recuperacao B2 continua sem transporte real por padrao. Migrations
nao foram aplicadas ao principal. Nenhum mecanismo de limpeza/retencao adicional
foi ativado; a pendencia B1 permanece antes da ativacao publica. Nao ha UI para
alternar autoridades nesta etapa. O risco/intermitencia F2 previamente documentado
nao e declarado resolvido por estas regressoes.
