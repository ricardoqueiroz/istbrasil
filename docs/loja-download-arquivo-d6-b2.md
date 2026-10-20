# D6-B2 — preparação interna de PDFs

## Contrato

`prepararArquivoValidado(metadadosVersao, { raizPrivada, signal? })` retorna `{ buffer, tamanho, mime: 'application/pdf', nomeDownload: 'livro.pdf' }`. Não retorna caminhos, SHA-256, IDs financeiros ou informações pessoais. Não abre conexões SQL, não importa configuração da aplicação e não registra logs ou rotas.

Recebe os campos reais retornados pela D6-B1: `arquivoVersaoId` (inteiro positivo), `caminhoRelativo` (ASCII com `/` e extensão `.pdf`), `tamanhoBytes` (string decimal positiva), `sha256` (Buffer de 32 bytes) e `mime`. Campos adicionais da autorização não são devolvidos. A função copia o hash e os valores usados antes do primeiro await. O estado da versão já foi avaliado na D6-B1; o contrato dela não retorna `estado`, portanto este serviço não o presume nem faz nova consulta. Uma versão retirada após aquisição pode ser autorizada pela política já existente.

A composição futura deve injetar exatamente a mesma raiz privada absoluta utilizada por `criarLojaArquivoService({ raizPrivada })`. Não existe uso operacional de `PRODUCTS_PATH` nestes dois serviços; referências antigas na documentação não configuram o runtime. Não há leitura de `.env`, fallback para cwd, Angular ou TEMP. Os testes usam TEMP explicitamente apenas para arquivos sintéticos. A identidade da raiz operacional real ainda deverá ser conferida na composição da D6-B3, sem mover PDFs ou mudar ACLs.

O serviço de publicação permite até 256 MiB por padrão; esta preparação limita a entrega inicial a 32 MiB, conforme D6-B2. Uma publicação maior não contorna esse limite. Nenhum contrato de publicação ou schema foi alterado.

## Resolução e integridade

O caminho deve obedecer ao mesmo alfabeto do schema/publicação. São rejeitados caminhos absolutos, traversal, backslash, nul, encoding, query e caracteres inesperados. A raiz deve ser absoluta, não pode ser a raiz do volume e não pode conter links. Todos os segmentos são examinados por lstat, com conferência de realpath e confinamento pela raiz. Symlinks/junctions, arquivos especiais e múltiplos hardlinks são rejeitados.

Antes de abrir, verifica arquivo regular; abre uma única vez em leitura, com `O_NOFOLLOW` e `O_NONBLOCK` onde disponíveis. Confere identidade dev/ino, tamanho, mtime/ctime em nanossegundos e número de links antes e depois da leitura, tanto no descritor quanto no caminho. Revalida também a cadeia de links e os caminhos canônicos. Não utiliza sendFile, stream por caminho ou uma segunda abertura para entrega.

Aloca um único Buffer final do tamanho esperado, apenas depois de conferir o limite real e declarado. Lê blocos de até 64 KiB diretamente nesse buffer; SHA-256 é calculado sobre esses mesmos bytes. Verifica EOF com leitura adicional de um byte, compara o digest binário e exige assinatura inicial exata PDF 1.0–1.7 ou 2.0 e MIME PDF. Não é um parser completo de PDF nem scanner de malware. O buffer retornado é independente de alterações posteriores no arquivo original; o chamador não deve alterá-lo antes de entregar.

Não há garantia atômica universal entre nomes de arquivo, diretórios e descritores: realpath e O_NOFOLLOW isolados não eliminam corridas. Node não oferece aqui resolução openat por descritor de cada diretório; Windows e Linux têm proteções diferentes. Processos locais privilegiados, montagens ou manipulação simultânea de diretórios continuam riscos residuais. Armazenamento privado operacionalmente imutável é necessário. As checagens detectam alterações observadas e o hash persistido vincula os bytes retornados ao conteúdo autorizado.

## Recursos, cancelamento e erros

Máximo fixo de 32 MiB por PDF e quatro preparações simultâneas no módulo do processo, sem fila. A quinta é recusada imediatamente. O teto dos buffers em preparação é 128 MiB, além do overhead; buffers já retornados pertencem ao chamador e não são abrangidos por esse contador. A D6-B3 deve controlar entregas e liberação desses buffers e não multiplicar o módulo em workers para contornar o limite.

`AbortSignal` é conferido antes de abrir, entre leituras e antes do retorno. Uma chamada nativa já em andamento não é cancelada à força; termina e então o serviço aborta. O descritor fecha e o slot é liberado também em cancelamento, exceção, truncamento, divergência de hash e erro de fechamento. Falha de close impede retorno bem-sucedido.

Erros controlados sem caminho, causa original ou conteúdo: `CONFIGURACAO_INVALIDA`, `VERSAO_INVALIDA`, `ARQUIVO_AUSENTE`, `CAMINHO_INSEGURO`, `ARQUIVO_ESPECIAL`, `TAMANHO_EXCEDIDO`, `TAMANHO_DIVERGENTE`, `ARQUIVO_TRUNCADO`, `HASH_DIVERGENTE`, `PDF_INVALIDO`, `CAPACIDADE_ESGOTADA`, `OPERACAO_CANCELADA`, `ARQUIVO_ALTERADO` e `FALHA_LEITURA`.

## Uso futuro e testes

D6-B1 deve autorizar em transação curta, que termina antes desta preparação. Esta função não substitui autorização de sessão/propriedade ou financeira. D6-B3 deverá compor as duas etapas, limitar entregas por sessão, tratar HTTP/cabeçalhos e cancelamento por desconexão, mantendo caminhos e metadados internos fora da resposta. Nenhuma dessas integrações foi iniciada.

`node --test tests/lojaDownloadArquivoService.test.js` usa apenas arquivos sintéticos descartáveis. Os testes interceptam operações nativas para reproduzir truncamento, troca de identidade, falha e concorrência; os bytes, links, diretórios e descritores são reais. FIFO é testado somente em Linux. Symlink de arquivo no Windows é ignorado somente se o sistema negar sua criação; nenhuma permissão é alterada.
