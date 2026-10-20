# D6-B3 — HTTP protegido de e-books

## Composição e configuração

O router `/api/loja/downloads` é montado antes do CORS global em `server.js`, com o pool compartilhado. Não cria pool, timer ou consulta na importação/inicialização. Compõe os serviços homologados de sessão, autorização D6-B1 e transições D5.2-B3; a preparação utiliza D6-B2 sem alterar suas regras.

Configuração confiável existente: `LOJA_ORIGENS_PERMITIDAS`, `LOJA_CSRF_SECRET`, política de cookie de `carregarConfiguracaoLojaSessao`, `LOJA_AMBIENTE`, `IST_LOJA_PAYPAL_ENV`, `IST_LOJA_PAYPAL_CONTA_RECEBEDORA` e `PRODUCTS_PATH`. O contexto financeiro é fixado na composição e não é aceito do corpo/query/headers. A composição operacional preserva a restrição atual a Sandbox, ambiente do pedido correspondente e Merchant ID válido. Não exige nem instancia adaptador OAuth/PayPal para downloads. Ausência/incompatibilidade retorna erro sanitizado e não derruba a API.

`PRODUCTS_PATH` é capturado pela configuração compartilhada `criarConfiguracaoArquivosLoja`, em `src/config/lojaArquivos.js`. Exige diretório absoluto existente, sem links na cadeia privada, e valida separação canônica dos diretórios públicos conhecidos antes de abrir o PDF e novamente após a preparação. Não há fallback, alteração de `.env`, movimentação de arquivos ou configuração automática de produção. A configuração operacional real não foi exercitada sobre PDFs comerciais.

A mesma instância deve ser injetada no router pelo parâmetro interno `configuracaoArquivos` e usada em `configuracaoArquivos.criarPublicacao({ db, agora?, maxBytes? })`. Esta composição chama o serviço de publicação existente sem modificar suas regras e não aceita `raizPrivada` como override. A publicação também valida a raiz antes de cada operação. A fábrica antiga permanece intacta para seus consumidores internos; quem compõe o fluxo deve usar esta configuração única, não construir uma segunda configuração independente. Não foi criado endpoint administrativo de publicação.

## Rotas e proteção

- `GET /direitos?limite=20&apos=<uuid>`: paginação por UUID público, máximo 50, somente direitos da sessão. Retorno público da D6-B1; não ativa/suspende direitos.
- `POST /itens/:direitoPublicId/reavaliar`: corpo JSON vazio `{}`; exige proteção CSRF existente (`X-CSRF-Token`), Origin autorizado e `X-IST-Loja: 1`. Localiza o pedido pela sessão e direito antes de chamar `reavaliarDireitosDoPedido(pedidoId, contextoConfiavel)`. Retorna somente `{ publicId, estado }`. A fachada mantém idempotência, suspensão e ausência de reativação automática; nenhum backfill é criado.
- `GET/HEAD /itens/:direitoPublicId/arquivo`: exige `X-IST-Loja: 1` e Origin permitido; sem Origin, aceita Referer cujo origin esteja na mesma lista explícita. `Sec-Fetch-Site: cross-site` é rejeitado. Host não é autoridade. Sessão é consultada pelo serviço atual e cookies duplicados são rejeitados pelo leitor existente.

O router responde OPTIONS localmente com origens explícitas e credenciais, métodos GET/HEAD/POST e headers Content-Type/X-IST-Loja/X-CSRF-Token. Não combina credenciais com `*`, não cai no CORS global e não altera cookies do checkout. GET/HEAD não exigem token CSRF de escrita nem corpo JSON; usam a política de leitura autenticada acima. Requisições sem origem identificável ou cabeçalho próprio são recusadas.

## Entrega e autorização final

1. D6-B1 autoriza sessão/propriedade/direito/finanças na primeira transação curta.
2. Commit e devolução da conexão antes de qualquer leitura de PDF.
3. D6-B2 prepara uma única cópia validada em buffer, com limite de 32 MiB e quatro preparações por processo.
4. Nova transação curta D6-B1 revalida sessão, propriedade, estado ativo e evidência financeira.
5. Compara direito, versão otimista, versão adquirida, caminho interno, tamanho, hash e MIME com a primeira autorização.
6. Commit e restauração do isolamento antes de headers/bytes. Envia somente o buffer preparado, sem reabrir o arquivo.

As conexões dedicadas são configuradas em READ COMMITTED; isolamento anterior é restaurado antes de devolução ao pool. Conexões sujas, commits incertos ou falhas de restauração são descartados. Não há retry HTTP nem transação aninhada. Falha SQL observada dentro do avaliador é tratada como indisponibilidade técnica mesmo que o avaliador a sanitize.

GET/HEAD não alteram direitos ou estados financeiros. Não há lock SQL durante preparação ou envio. Não existe atomicidade entre a última avaliação financeira e toda a duração da transmissão: mudanças posteriores ao commit não recolhem bytes já enviados. A evidência é somente a persistida localmente; eventos PayPal ainda não recebidos não são descobertos por esses endpoints.

## Headers e erros

Sucesso: 200, `application/pdf`, `attachment; filename="ebook.pdf"`, Content-Length exato, `Cache-Control: private, no-store`, `Accept-Ranges: none`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Vary: Cookie, Origin`. HEAD realiza as mesmas verificações e não envia corpo. Range/If-Range e condicionais são ignorados: não produz 206, 416 ou 304. Usa `res.end(buffer)` e não `res.send`, sendFile ou stream por caminho; não gera ETag/Last-Modified.

Erros sanitizados: 401 sessão inválida/expirada/revogada; 404 direito inexistente/alheio ou identificador malformado; 409 direito indisponível, evidência financeira insuficiente/adversa ou versão divergente; 429 limites; 503 avaliação/preparação/configuração indisponível. Origem/CSRF inválidos são 403 e parâmetros/corpo inválidos são 400. HEAD preserva o status sem corpo. Após headers enviados, falha encerra a conexão e não tenta responder JSON.

## Limites e cancelamento

Por processo: listagem 30/min por sessão; GET e HEAD de arquivo compartilham 10/min por sessão; POST 10/min por sessão; no máximo duas entregas simultâneas por sessão. Tentativas de sessão inválida têm limite adicional de 30/min por IP, com bloqueio antes de novas consultas quando a janela se esgota. Chaves de sessão nos contadores são hashes, não tokens; mapas de rate limit têm teto de 10.000 entradas e limpeza oportunista sem timer. Não há fila ilimitada ou limite distribuído.

Capacidade da sessão é liberada em finish, erro e close/aborted. Desconexão aciona AbortSignal da preparação; consultas SQL já iniciadas terminam normalmente e encerram suas transações. Buffers preparados pertencem à entrega até o término; o contador global da D6-B2 cobre preparações, não buffers já retornados. Limites em múltiplos processos não são somados globalmente.

## Homologação

- HTTP isolado: 36 testes aprovados, sessões/transições simuladas e preparação real sobre PDFs sintéticos.
- Regressão Windows/Node 20.19.6 com MariaDB 13.0.2 descartável: 484 testes, 483 aprovados, zero falhas, um ignorado (FIFO exclusivo Linux). Inclui sessão/CSRF, checkout/pedidos, publicação, D6-B1/B2, avaliação/transições, percurso financeiro, PayPal simulado e composição HTTP.
- MariaDB 10.3.39 real descartável: nove testes aprovados, zero falhas/ignorados; schema `ist_loja_67_3_b7e8c022b15f`, externo 127.0.0.1:13339, interno 3306. Autenticação correta aceita e incorreta rejeitada; contêiner/volume/segredos descartados, Docker/containerd parados.

O percurso real cobre propriedade SQL, ativação POST idempotente, GET/HEAD, sessão expirada/revogada, evidência adversa ou revogação surgida durante preparação e falha SQL sanitizada. Os hashes dos snapshots/registros financeiros e direitos são comparados nas operações de leitura. O teste de composição carrega server.js sem escuta real ou consulta ao banco e valida as três rotas comerciais antigas bloqueadas. As montagens institucionais são verificadas com resposta estática sintética, sem leitura de PDFs reais.

Pendências D6-B4: composição operacional da raiz privada/publicação, uso pelo frontend via fetch autenticado/Blob, homologação integrada com acesso supervisionado e revisão dos limites operacionais. Nenhuma interface Angular, recuperação por e-mail ou liberação para uso real foi implementada aqui.
