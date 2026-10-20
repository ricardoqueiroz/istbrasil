# D6-B4-F1 — separação da raiz privada

## Causa e correção

O controller aceitava um PRODUCTS_PATH absoluto e a D6-B2 verificava integridade/confinamento, mas nenhum componente de composição verificava a sobreposição com diretórios públicos. O teste de auditoria manteve uma rota estática sintética funcional, sem sessão, servindo o mesmo PDF da raiz de downloads.

A validação agora pertence a `src/config/lojaArquivos.js`. `criarConfiguracaoArquivosLoja({ raizPrivada, raizProjeto?, raizesPublicas? })` captura configuração confiável; não lê dotenv/cwd ou parâmetros HTTP. Por padrão, o router captura `env.PRODUCTS_PATH`. Pode receber uma instância compartilhada da configuração pela composição interna. A construção não acessa arquivos nem impede a inicialização da API quando a configuração está ausente; a utilização falha com CONFIGURACAO_INVALIDA e HTTP 503 sanitizado.

O controller aguarda `obterRaizValidada()` antes da primeira autorização de arquivo e de qualquer abertura de PDF. Revalida a configuração após preparar o buffer e antes da autorização financeira final. Um erro não devolve caminho físico, hash ou bytes PDF.

## Diretórios públicos conhecidos

As raízes são relativas à localização do código, não ao cwd nem a um caminho fixo presumido de produção:

- `istbrasil.private/documents`: mounts públicos de documentos/Transparência do Express.
- `istbrasil.private/projetos`: documentos públicos de projetos.
- `istbrasil.private/usuarios/fotos`: fotos disponibilizadas pelas rotas autorizadas existentes.
- `src/assets` e `public`: entradas públicas do build Angular, incluindo imagens/capas.
- `dist/sakai-ng`: saída do build Angular, incluindo browser.
- `html`: árvore pública representada no layout do repositório e na configuração versionada do Nginx.

`raizesPublicas` acrescenta diretórios absolutos confiáveis da composição, sem substituir os padrões. O teste bloqueador declara explicitamente a raiz efetivamente publicada pelo servidor sintético; não remove nem simula a exposição pública. Os mounts públicos reais não são alterados ou bloqueados.

Não se considera todo o projeto público: um armazenamento legítimo em diretório irmão dos webroots, ou em área não publicada do projeto, continua elegível. O indicador de nome `private` não constitui prova de privacidade.

## Caminhos canônicos e falha segura

Exige raiz privada existente e diretório regular, rejeita raiz de volume e symlink/junction em qualquer ancestral privado. Resolve com realpath e compara igualdade/ancestralidade nas duas direções com path.relative e separadores nativos, sem startsWith de prefixos de diretório. Assim `html-privado` não é confundido com `html`, mas um webroot contido na raiz privada é bloqueado.

Para raízes públicas existentes, resolve também os links conhecidos e compara o destino físico. Para diretórios públicos ainda não criados, resolve o ancestral existente e projeta os segmentos ausentes. Link quebrado, permissão insuficiente ou outro erro de resolução falha fechado; não se presume separação. Não há cache da validação: um link público introduzido depois é detectado na próxima verificação se fizer parte das raízes conhecidas.

## Configuração única de publicação/download

`const arquivos = criarConfiguracaoArquivosLoja({ raizPrivada: env.PRODUCTS_PATH, raizesPublicas: [...] })` deve ser a mesma instância usada em `criarLojaDownloadsRouter({ ..., configuracaoArquivos: arquivos })` e em `arquivos.criarPublicacao({ db })`. Não há segundo parâmetro de raiz na composição de publicação; overrides são rejeitados. A composição só chama as fábricas e métodos existentes, sem alterar publicação, autorização, preparação, SQL, direitos ou finanças.

Isso garante correspondência dentro desta composição; não impede um código interno autorizado de chamar diretamente a fábrica antiga com configuração diferente. Essa chamada não deve ser usada na composição operacional. A ausência anterior de publicação operacional não foi resolvida com um novo endpoint, nem foi inferida a raiz a partir de PDFs reais.

## Limites da garantia

A validação cobre as raízes públicas conhecidas declaradas na aplicação/configuração versionada e as adicionadas pela composição. Não consulta o Nginx efetivo, não descobre aliases externos nem percorre recursivamente todos os links dentro de cada árvore pública. Um alias externo desconhecido, bind mount, publicação por outro serviço ou link não declarado pode expor uma pasta sem conhecimento do Node.

A configuração versionada do Nginx usa root `/var/www/istbrasil.org.br/html` e try_files; a correspondência física com a árvore `html` da aplicação precisa ser confirmada no deploy. Layout diferente ou alias adicional exige declarar a raiz pública real e auditar a configuração efetiva. Não há garantia universal contra mudanças privilegiadas concorrentes entre a validação e o uso; armazenamento privado imutável e auditoria Nginx continuam obrigatórios. Esta correção não comprova inexistência de exposição em produção.

## Testes e escopo

O teste bloqueador passou primeiro: rota pública sintética 200, endpoint protegido 503, zero chamadas fs.open pelo fluxo protegido e nenhuma autorização financeira iniciada. O PDF permanece realmente público no servidor sintético para não mascarar a condição original.

Vinte testes de configuração cobrem sobreposição nas duas direções/igualdade, canonização, ausência/inexistência, irmãos com prefixo semelhante, separadores nativos, links privados/públicos/quebrados, mudança posterior de link e rejeição de raiz divergente na publicação. Regressão Windows: 138 testes, 137 aprovados, zero falhas, um ignorado (FIFO Linux), incluindo HTTP D6-B3, MariaDB 13.0.2 descartável, D6-B1/B2, publicação e composição.

Linux: execução real pelo seletor `f1`, Node 20.19.6, linux/amd64, UID/GID 1000; vinte testes aprovados, zero falhas/ignorados, código 0. Imagem oficial `node:20.19.6-bookworm-slim`, digest `sha256:b342de02eb4a57cd6986290a69833d20818508db8078dba0197a024193410aee`. O contêiner não teve rede durante testes, fontes foram montadas somente leitura e o filesystem temporário foi descartado. Contêiner e imagem exclusiva foram removidos; Docker/containerd encerrados, sem instalação de Node no WSL.

Banco principal, PDFs comerciais, servidores preexistentes, schema/migrations e serviços homologados não são modificados. Nenhuma alteração de Nginx ou ambiente real foi realizada. A D6-B4 completa deve ser retomada somente após revisão/autorização; D7/D8 não foram iniciadas.
