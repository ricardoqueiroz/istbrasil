# D6-B4-R — resultados da retomada local

## Parecer

Homologação parcial; não recomendar aprovação final da D6 enquanto não for esclarecida a falha intermitente da regressão financeira existente. Nenhum serviço de produção foi modificado nesta etapa. D7/D8 não foram iniciadas.

## Percurso novo e ambientes

`tests/lojaDownloadPercursoHttp.integration.test.js`, com `tests/fixtures/lojaDownloadPercursoFixture.js`, usa somente MariaDB descartável e PDF sintético. A configuração F1 é a mesma instância em `criarPublicacao` e no router HTTP. Publicação/versão, sessão de convidado, pedido e captura financeira usam as fábricas reais; exclusivamente o provedor de pagamento é simulado.

A primeira execução parou porque a nova fixture não havia definido NODE_ENV=test, exigência do simulador. A configuração foi corrigida apenas na fixture; o banco e os arquivos temporários daquela execução foram descartados.

Execução específica Windows:

```powershell
$env:IST_LOJA_PAGAMENTOS_MARIADB_BIN='C:\Program Files\MariaDB 13.0\bin'
node --test --test-reporter=spec tests/lojaDownloadPercursoHttp.integration.test.js
```

MariaDB efetivo 13.0.2-MariaDB, schema `ist_loja_67_3_1e1fcd8e05d9`, porta temporária 62354. Nove testes aprovados, zero falhas/ignorados, exit code 0. Processo encerrado e datadir descartado pela fixture.

Execução específica 10.3.39:

```bash
sudo bash /mnt/c/inetpub/wwwroot/istbrasil.org.br/scripts/loja-r2-homologar-mariadb10339-wsl.sh d6b4
```

MariaDB efetivo `10.3.39-MariaDB-1:10.3.39+maria~ubu2004`, schema `ist_loja_67_3_5c34e799e20a`, externo 127.0.0.1:13339, interno 3306. Nove testes aprovados, zero falhas/ignorados, exit code 0. Autenticação correta aceita/incorreta rejeitada e descarte de contêiner/volume/segredos confirmados. Docker/containerd encerrados, sem inicialização automática.

## Evidências do percurso nas duas versões

- Sessão real de convidado; produto digital e versão sintética publicados pela composição F1; pedido criado pela lógica comercial atual.
- Direito inicial AGUARDANDO_CONFIRMACAO e evento de origem PEDIDO; captura simulada consistente persistida pelo núcleo financeiro, sem PayPal externo.
- POST com sessão/origem/CSRF reais ativa e gera um evento FINANCEIRO. Repetição não duplica eventos.
- GET 200 integral, igualdade byte a byte e SHA-256 do buffer recebido; HEAD 200 sem corpo, com headers aplicáveis equivalentes.
- GET repetido e Range/If-Range/If-None-Match não alteram direitos/eventos nem produzem respostas parciais/304.
- Hooks observacionais no teste verificam: preparação sem transação SQL → autorização final → COMMIT → envio sem transação SQL. Nenhuma regra de produção foi substituída.
- Outro pedido/sessão e token falsificado são recusados sem PDF. Dois POSTs concorrentes convergem para versão 2 e dois eventos totais.
- Falha SQL injetada no evento do POST reverte o UPDATE integralmente; tentativa posterior válida ativa sem duplicar.
- Reembolso sintético e suspensão real confirmados enquanto o buffer aguarda impedem entrega pela autorização final.

## HTTP, recursos e limites

A suíte HTTP existente foi ampliada com cookies malformados/contexto Live incompatível, falha após preparação, falha após iniciar resposta e quatro preparações simultâneas entre sessões. A quinta preparação foi recusada; após sucesso/erro/desconexão a capacidade voltou a ficar disponível. O erro durante envio encerrou a conexão sem JSON posterior. Quarenta testes HTTP e dois de composição passaram na rodada específica (42/42).

As suítes D6-B1/B2/F1 e HTTP cobrem sessão ausente/expirada/revogada/falsificada/duplicada, direitos pendentes/suspensos/revogados, adversidade, contexto financeiro, CSRF/origem/cabeçalho, preflight, GET/HEAD negados, caminhos inválidos, traversal, links, arquivos ausentes/alterados, hash e tamanho/32 MiB. A validação das matrizes é distribuída entre testes de serviço, HTTP simulado e percurso real; não se apresenta cada caso como teste SQL real.

Headers verificados: PDF, comprimento exato, attachment seguro, private/no-store, Accept-Ranges none, nosniff, no-referrer e Vary Cookie/Origin, sem ETag/Last-Modified. O controller usa o buffer validado, sem segunda abertura para transmissão.

As três rotas comerciais antigas continuam bloqueadas na composição real de server.js carregada em processo isolado. Documentos de Transparência e projetos são verificados com conteúdo estático sintético injetado no teste. Imagens/capas são verificadas em Express isolado com bytes sintéticos, além da conferência dos assets configurados no Angular. Isso não equivale a inspeção visual ou teste do Nginx em produção.

Suspensão posterior ao início da resposta não recolhe bytes já enviados. Limites são por processo; o contador D6-B2 cobre preparações e não os buffers já devolvidos. Eventos financeiros externos ainda não persistidos não são descobertos por uma consulta local de autorização.

## Regressões e falha remanescente

Regressão Node ampla (30 arquivos, `--test-concurrency=2`, MariaDB 13.0.2 descartável): 1.024 testes contabilizados, 1.021 aprovados, duas falhas, um ignorado (FIFO Linux), exit code 1. As duas falhas representam um cenário e seu grupo pai:

`tests/lojaDownloadHomologacao.integration.test.js`: “direito ATIVO diante de disputa fica bloqueado”. A fachada `reavaliarDireitosDoPedido` retornou ERRO_PERSISTENCIA, sanitizado em `src/services/lojaDownloadDireitosService.js`, sem revelar a causa SQL original.

Foi acrescentado somente ao teste um wrapper de diagnóstico com código SQL/errno, sem query, parâmetros, credenciais ou mensagens brutas. Reexecução isolada desse arquivo: 17 aprovados, zero falhas/ignorados, exit code 0, MariaDB 13.0.2 descartável. A falha não se reproduziu e nenhum código SQL de erro foi capturado. Não é possível afirmar se decorre do ambiente, infraestrutura de teste ou serviço; a causa permanece não comprovada. Uma aprovação isolada não elimina a falha da regressão ampla. Não houve correção de produção ou repetição automática da suíte inteira.

Regressão Angular pertinente, comando ng test --watch=false --browsers=ChromeHeadless com includes Loja/Editora/services: 190 testes aprovados, exit code 0, sem reiniciar a instância Angular existente.

## Nginx e configuração operacional

Somente nginx.conf versionado foi lido. Webroot declarado `/var/www/istbrasil.org.br/html`; proxy `/api/` para Node; proxy específico dos documentos de projetos; `location /` com `try_files $uri $uri/ /index.html`. Não há alias declarado nem bloqueios explícitos dos prefixos comerciais privados. Arquivo colocado sob o webroot pode ser servido sem passar pelo Node.

Antes de deploy: auditar configuração efetiva/includes/root/alias/links/montagens, confirmar raiz privada fora de qualquer árvore publicada e declarar raízes adicionais conhecidas à F1. Avaliar bloqueios explícitos dos prefixos `/istbrasil.private/products/livros/` e `/api/istbrasil.private/products/livros/`, sem bloquear documentos públicos de Transparência/projetos, capas ou imagens. Um alias externo desconhecido continua fora da garantia do Node. Nenhuma configuração de Nginx foi alterada ou produção acessada.

## Preservação e próximo passo

Banco principal não foi acessado; todos os SQLs operacionais desta etapa foram direcionados às fixtures descartáveis. Nenhum PDF comercial foi lido. Backend PID 23300 e Angular PID 4348 permaneceram ativos, sem reinício. Os servidores efêmeros, bancos e arquivos sintéticos foram encerrados/removidos pelas fixtures.

Os hashes dos módulos de produção e dos arquivos protegidos devem permanecer iguais ao início da etapa. As alterações limitam-se aos testes/fixtures acima, ao seletor d6b4 no executor existente e a este relatório. Sem commit/push/deploy.

Recomendação: investigar a falha intermitente de ERRO_PERSISTENCIA sob as condições da regressão ampla, capturando código/errno e fase de falha no ambiente descartável, antes de propor qualquer correção funcional. Não há evidência suficiente para escolher uma alteração de produção nesta etapa.
