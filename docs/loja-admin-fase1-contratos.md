# Administracao da Loja IST — Fase 1

## Contrato vigente consolidado — Etapa 24.9

Esta secao descreve o codigo local atualmente implementado. Prevalece sobre as
listas de campos, bloqueios e propostas das etapas historicas abaixo. Nao comprova
aplicacao de migrations, configuracao ou funcionamento na homologacao WSL2
IST-HOMOLOG-2004 ou na VPS. Nao houve testes ou acesso a esses ambientes nesta revisao.

### Rotas efetivamente montadas

Todas as rotas administrativas abaixo usam o prefixo `/api/admin/loja`:

| Metodo e caminho | Sucesso |
|---|---|
| GET /livros | 200, `{itens,paginacao}` |
| GET /livros/:id | 200, `{item}` |
| POST /livros | 201, `{item}` apos COMMIT |
| PATCH /livros/:id | 200, `{item}` apos COMMIT |
| DELETE /livros/:id | 204, sem corpo, apos COMMIT |
| POST /livros/capa | 201, `{item:{img}}` |
| POST /livros/:id/pdf | 201, `{item:{versaoPublicId,produtoId,numeroVersao,estado}}` |
| POST /livros/:id/versoes-pdf/:versaoPublicId/publicar | 200, `{item:{versaoPublicId,numeroVersao,estado}}` |
| GET /produtos | 200, `{itens,paginacao}` |
| GET /produtos/:id | 200, `{item}` |
| GET /categorias | 200, `{itens,paginacao}` |

As declaracoes POST/PATCH de produtos em `CONTRATOS_LOJA_ADMIN` nao equivalem a
endpoints disponiveis: nao estao montadas no router atual. Alteracoes comerciais
implementadas passam pelo PATCH do livro associado. Nao ha escrita de categorias.

### Leituras: campos, filtros e revisoes

Livro retorna `id,title,author,currency,description,language,format,category,img,
pertenceEditoraIst,sku,price,onsale,inventory,produtoId,produtoTipo,revisao`.
A listagem acrescenta `versoesPdf`; o detalhe acrescenta `versoesPdf` e `comercial`.
`comercial` e null sem produto; caso contrario contem `id,livroId,categoriaId,sku,
titulo,autor,descricao,tipo,precoCentavos,moeda,imagemUrl,ativo,emVenda,disponivel,revisao`.
`versoesPdf` contem exclusivamente `versaoPublicId,numeroVersao,estado`, ordenados
por numero decrescente; pode mostrar varios rascunhos historicos. E lista vazia
quando nao houver versoes aplicaveis a produto DIGITAL.

Produto retorna `id,livroId,categoriaId,sku,titulo,autor,descricao,tipo,precoCentavos,
moeda,imagemUrl,ativo,emVenda,disponivel,formatoEditorial,temVersaoPublicada,
podeComprar,revisao`. `author` pertence a ist_livros; `autor` a ist_loja_produtos.
O preco oficial de compra e `precoCentavos`: inteiro positivo seguro JavaScript,
ate 9007199254740991; valores persistidos NULL permanecem NULL. `price` e decimal
legado, retornado na representacao do driver (string decimal no contrato mysql2
atual), sem substituir o preco comercial. Flags comerciais nullable permanecem
null ou booleanos; `onsale` editorial e normalizado para numero ou null.
Imagens nao publicas sao sanitizadas para null, sem alterar o valor persistido.
Leitura de dados legados nao aplica os validadores de escrita.

Categoria retorna `id,nome,slug,categoriaPaiId,ativo,ordem`, em lista plana,
preservando hierarquia e categorias inativas. `ativo` e booleano.

Todas as listagens aceitam `pagina` (padrao 1, maximo 1000000), `limite` (padrao
20, maximo 100) e `busca` (ate 200 bytes UTF-8). Livros acrescentam
`pertenceEditoraIst=true|false|null`; produtos, `categoriaId`, `ativo`, `emVenda`,
`disponivel`; categorias, `ativo`. Flags de filtro usam `true|false`. Parametros
desconhecidos, repetidos/nao escalares ou invalidos sao rejeitados. Nao ha parametro
de ordenacao: livros/produtos usam id crescente; categorias, ordem e id crescentes.
Busca literal parametrizada usa titulo do livro, titulo/SKU do produto ou
nome/slug da categoria; `%`, `_` e `!` sao escapados. Paginacao retorna
`{pagina,limite,total}`; contagem e pagina compartilham snapshot READ ONLY,
REPEATABLE READ. A elegibilidade usa categorias/ancestrais completos e politica
comercial compartilhada, inclusive publicacao atual e contexto operacional.

`revisao` e uma string opaca com aspas duplas (SHA-256), usada em If-Match;
nao e revisao de todo o envelope. Livro considera todos os campos editoriais
listados para escrita abaixo, com valores persistidos originais, inclusive imagem
nao sanitizada e NULL. Produto considera sua projecao comercial editavel, sem
campos derivados de elegibilidade/publicacao. Nao ha coluna nova de revisao.

### Escrita de livros: entrada efetiva

POST exige `title`, `format`, `pertenceEditoraIst` e dados suficientes para criar
o produto. PATCH e parcial; campos omitidos permanecem persistidos. Campos
desconhecidos e corpos vazios sao rejeitados. Campos editoriais aceitos:

| Campo | Validacao de entrada |
|---|---|
| title | Texto nao vazio, ate 255 caracteres representaveis em cp1252 |
| author | Mesmo criterio textual, ate 100 caracteres, ou null |
| currency | Somente BRL |
| language | null, duas letras minusculas, opcionalmente sufixo de duas letras minusculas/maiusculas, ou es-419 |
| format | E-Book ou Livro Físico |
| category | Texto nao vazio cp1252, ate 50 caracteres; sujeito a coerencia com categoriaId |
| description | null ou string JSON de objeto, ate 65535 bytes UTF-8 |
| img | null ou referencia publica autorizada assets/images/... com extensao de imagem |
| pertenceEditoraIst | Booleano ou null |
| sku | Texto nao vazio cp1252, ate 50 caracteres, ou null na validacao editorial; sincronizacao comercial exige string nao vazia |
| price | null ou string de 0.00 a 999.99 com ponto e duas casas; sincronizacao comercial exige valor positivo nao nulo |
| onsale | Inteiro 0 ou 1 |
| inventory | Em estoque, Poucas unidades ou Esgotado |

Nao confundir aceitacao isolada pelo validador com aceitacao pela operacao conjunta.
POST aceita `comercial:{categoriaId,sku,precoCentavos}` exclusivamente com essas
tres propriedades obrigatorias; SKU comercial nao vazio ate 50 caracteres e preco
inteiro positivo seguro. Alternativamente aceita `categoriaId`, SKU editorial e
price positivo para derivar o comando comercial. A categoria identificada deve
ser valida/ativa; seu nome alimenta `category`, rejeitando texto divergente.
Com `comercial`, se categoriaId superior nao for informado, `category` deve ser
enviado e coincidir com o nome consultado. Nao ha preco ficticio ou DDL automatico.

POST consulta INFORMATION_SCHEMA: price precisa ser DECIMAL(5,2), com nulabilidade
reconhecida. Valor informado valido permite coluna NOT NULL. Omitido/null exige
coluna anulavel; em NOT NULL retorna 400 `ADMIN_PRECO_OBRIGATORIO`. Tipo/precisao/
escala incompatível retorna 503. Mesmo em coluna anulavel, price=null explicitamente
enviado e rejeitado pelo sincronizador comercial; omissao pode inserir NULL quando
o comando comercial explicito fornece o preco. Precos divergentes entre os dois
comandos sao rejeitados, sem arredondamento.

Livro e produto sao inseridos na mesma transacao/conexao. Produto inicia ativo=1,
em_venda=0, ordem=0, perfil_fiscal_id=NULL, BRL, tipo DIGITAL para E-Book ou
MERCADORIA para Livro Físico. Recebe titulo, autor, descricao e imagem iniciais.
Disponibilidade depende do fluxo: com campos sincronizados/inventory, Esgotado
produz 0 e os demais estados 1; sem essa informacao no fluxo comercial explicito,
inicia 0. A resposta inclui produtoId/produtoTipo e a revisao em `item.comercial`.

PATCH aceita tambem `categoriaId` e `comercial` parcial com `categoriaId,sku,
precoCentavos,autor,titulo,imagemUrl,descricao,ativo,emVenda,disponivel`.
O sincronizador atual propaga campos enviados: title→titulo, author→autor,
sku→sku, description→descricao, img→imagemUrl, currency→moeda,
categoriaId→categoriaId, price→precoCentavos e inventory→disponivel.
Comandos explicitos conflitantes retornam 400. `onsale` nao altera em_venda.
A descricao JSON pode ser ajustada para a chave `Autor:` quando description/author
forem enviados. Nao ha preservacao incondicional do produto diante de edicao desses
campos compartilhados; campos comerciais omitidos do comando resultante permanecem.

PATCH exige If-Match editorial sob lock; quando ha comando comercial resultante,
exige tambem If-Match-Produto. Sem produto, comando comercial retorna 409. Mudanca
de formato com produto associado retorna 409. Categorias/produto sao tratados antes
do lock do livro; alteracoes e releituras compartilham a transacao. UPDATE inclui
somente campos efetivamente diferentes. No-op com revisao valida retorna 200,
sem UPDATE e mantendo revisao. COMMIT e confirmado antes do sucesso; falhas
anteriores provocam rollback. COMMIT incerto descarta a conexao, sem repeticao
automatica nem presuncao de ausencia de gravacao.

DELETE nao aceita corpo ou parametros extras. Exige revisao editorial e, havendo
produto, revisao comercial. Bloqueia a exclusao se houver pedido_itens ou
arquivo_versoes referenciando o produto. Sem impedimentos, exclui produto e depois
livro na mesma transacao. Nao ha cascade; conflito FK concorrente retorna 409.
Nao altera pedidos, pagamentos, direitos ou historicos financeiros.

### Seguranca, capas e PDFs

Todas as rotas administrativas exigem JWT administrativo valido/configuracao
segura e tipo atual 1 consultado no banco. GET emite `X-CSRF-Token`, sem exigir
Origin/CSRF de escrita. Escritas exigem Origin permitido e CSRF vinculado ao JWT
exato; PATCH/DELETE e operacoes PDF exigem If-Match editorial. JSON de escritas
usa application/json, charset UTF-8, limite 144 KiB e sem inflacao. Os parsers
globais sao contornados apenas nas rotas administrativas correspondentes.
Respostas administrativas usam no-store; leituras protegidas usam nosniff.

Erros usam `{erro:{codigo,mensagem}}`, sem SQL, stack, credenciais ou caminhos.
Status implementados incluem 400, 401, 403, 404, 409, 412 (revisao obsoleta),
413, 415, 428 (If-Match ausente) e 503. Conflitos especificos incluem
ADMIN_SKU_DUPLICADO, ADMIN_CONFLITO_COMERCIAL, ADMIN_RASCUNHO_EXISTENTE e
ADMIN_PUBLICACAO_CONFLITO. Falhas de publicacao nao classificadas como conflito
retornam 503 generico, nao uma confirmacao de que nada foi gravado.

Capa: multipart campo `capa`, ate 5 MiB; JPEG/PNG/WebP, conteudo validado,
dimensoes minimas 186×260, uma pagina. Converte para WebP, nome UUID, escrita
exclusiva no armazenamento persistente. URL permanece `/assets/images/livros/`.
GET/HEAD publicos servem somente imagens validadas; diretorio legado e fallback
de leitura apenas apos validar a raiz persistente e encontrar arquivo ausente.
Symlinks, hardlinks e traversal continuam bloqueados. Upload nao altera o livro
automaticamente; a referencia precisa ser salva pelo comando administrativo.

PDF: multipart campo `pdf`, application/pdf, ate 32 MiB e cabecalho PDF validado.
Somente livro E-Book com produto DIGITAL persistido; verifica vinculo e revisao.
Grava UUID privado com criacao exclusiva, registra RASCUNHO pelo servico existente
e nao preenche ist_livros.file. Idempotencia precede a regra transacional de
rascunho unico sob lock do produto. Qualquer rascunho existente bloqueia novo
upload com 409 ADMIN_RASCUNHO_EXISTENTE, inclusive duplicidades historicas.
Nao ha substituicao, descarte ou exclusao de arquivos. Em falha de registro,
arquivo pode ser preservado para conciliacao, sem exclusao automatica.

Publicacao e operacao explicita: corpo exclusivo `{publicacaoAtualEsperada:null}`
ou UUID da publicacao observada. O servico de versoes confirma o vinculo sob lock,
publica a versao e controla a publicacao anterior; nao libera em_venda por si so.
Liberacao comercial usa PATCH do livro com `comercial.emVenda` e ambas as revisoes.
Estar em venda nao substitui a politica de elegibilidade, entrega e publicacao.
GETs administrativos nunca expoem caminho fisico, hash ou conteudo privado do PDF.

### Pre-requisitos de schema e implantacao

Conferir ist_livros com todos os campos selecionados, inclusive author VARCHAR(100)
nullable, currency, sku, price DECIMAL(5,2), onsale, inventory, language com capacidade
para es-419 (seis caracteres) e pertence_editora_ist. Conferir autor VARCHAR(100)
nullable em produtos e colunas comerciais R2, categorias, perfis fiscais e FKs.
As migrations de referencia sao ist_loja_catalogo.sql,
ist_loja_catalogo_expansao_r2.sql, ist_loja_pedidos_fundacao.sql e
ist_loja_downloads_fundacao.sql. Elas nao comprovam sozinhas a presenca das
ampliacoes manuais posteriores author/autor/language; nao ha aplicacao implicita.
ist_livros_price_nullable.sql e independente e restrita aos destinos de teste
previstos no proprio SQL; nao e autorizacao de mudanca persistente no WSL.

PRODUCTS_LIVROS_PATH e CAPAS_LIVROS_STORAGE_PATH devem constar no .env oficial,
como caminhos absolutos existentes, acessiveis e sem sobreposicao com raizes
publicas/releases. Nao ha fallback para nomes antigos. Capas persistem fora das
releases; PDFs privados permanecem sujeitos a autorizacao de download. Nginx,
permissoes, schema e runtime precisam ser conferidos separadamente no destino.
Nao se afirma que qualquer migration ou alteracao manual esteja aplicada no WSL2.

## Historico de implementacao e decisoes anteriores

As secoes seguintes preservam o registro das etapas. Expressoes como "futuro",
"bloqueado", "somente cinco campos", "preco sempre NULL" ou "sem sincronizacao"
descrevem seu momento historico, nao substituem o contrato consolidado acima.

## Mensagens administrativas e estados da consulta PDF

Administracao reutiliza p-message (PrimeNG), ja usado nas paginas da Loja.
Nao existe interceptor global de notificacoes nesta composicao; o servico converte
o erro e o componente apresenta uma unica mensagem inline. Erro de gravacao fica
junto ao Salvar; carregamento inicial usa a mensagem no topo com recarga. Respostas
ADMIN_* com mensagens curtas e seguras tem prioridade; HTML, SQL, stack e caminhos
sao descartados. SKU duplicado usa a mensagem canonica com acento. Escritas 503
continuam alertando sobre resultado possivelmente incerto, sem repeticao automatica.

PDF usa estados CARREGANDO, SEM_RASCUNHO, COM_RASCUNHO e ERRO. Ausencia de
versoesPdf em resposta de detalhe e erro de contrato, nunca uma lista vazia nem
consulta pendente eterna. GET de detalhe tem prazo de 15 segundos. Falha mostra
mensagem e botao de nova consulta, mantendo upload bloqueado. Consulta apenas de
versoes preserva campos editoriais nao salvos. O backend em execucao deve retornar
item.versoesPdf; codigo antigo carregado precisa ser atualizado operacionalmente.

A mensagem publica Indisponivel para compra vem da pagina editorial e utiliza
comercial.podeComprar, calculado pela politica compartilhada no bookController.
O catalogo da Loja tambem usa politica.elegivel, exposta como disponivel. Nao foi
identificada divergencia entre esses contratos. Novos produtos iniciam em_venda=0;
PDF RASCUNHO nao satisfaz PUBLICADA/publicacao_atual=1. Ativo/categoria/ancestrais,
preco positivo, BRL, disponibilidade, tipo DIGITAL e formato E-Book tambem precisam
ser elegiveis. Estoque ou upload isolado nao liberam compra. Nenhuma regra ou dado
comercial foi alterado nesta correcao; estado persistido nao foi consultado.

Proxima unidade proposta: acao administrativa explicita de publicar um rascunho,
reutilizando lojaArquivoService.publicar e sua expectativa de publicacao atual,
com autenticacao/Origin/CSRF e vinculo ao livro/produto. Depois, botao separado de
liberar venda usando o PATCH comercial ja existente (emVenda=true, revisoes
editorial/comercial). Nao implementar publicacao ou liberacao implicitas.


## PDF - rascunho unico por produto

GET /api/admin/loja/livros/:id inclui item.versoesPdf, array de objetos com apenas
versaoPublicId, numeroVersao e estado. Retorna todas as versoes do DIGITAL associado,
inclusive duplicidades historicas; sem produto DIGITAL retorna []. Listagem de
livros nao muda. Nenhum caminho, hash, nome interno ou link de download e exposto.

POST /api/admin/loja/livros/:id/pdf faz verificacao antecipada de RASCUNHO antes
do multipart. O servico existente confirma a regra dentro da transacao, apos
bloquear produto/versoes e reconhecer repeticao idempotente. Novo registro com
qualquer RASCUNHO existente retorna HTTP 409, envelope erro com codigo
ADMIN_RASCUNHO_EXISTENTE e mensagem fixa sanitizada. Idempotencia interna do mesmo
registro e preservada; numero de versao e INSERT so ocorrem sem rascunho pendente.

O formulario exibe todos os rascunhos e bloqueia selecao/envio, inclusive durante
consulta incerta. Atualiza metadados depois de sucesso ou conflito, sem substituir
campos editoriais nao salvos. Nao oferece substituicao, descarte ou publicacao.

Locks existentes serializam registros concorrentes no mesmo produto. Nenhuma
migration ou constraint nova e criada. Duplicidades historicas nao sao corrigidas
ou removidas automaticamente. ist_livros.file e versoes PUBLICADAS/RETIRADAS nao
sao alterados pela regra. Arquivo gravado antes de um conflito transacional pode
permanecer privado sem registro; nao ha limpeza automatica, inclusive em COMMIT
incerto. Essa limitacao e distinta da garantia de um novo rascunho por produto.

Validacao desta unidade: HTTP e servico com SQL simulado, arquivos exclusivamente
sinteticos em diretorios temporarios proprios, tipos Angular e sintaxe/diff.
Suite SQL-real nao executada. Cenarios SQL existentes foram adaptados para a nova
regra e duplicidades historicas sinteticas, mas aguardam homologacao autorizada.


## Formulario unificado e campos compartilhados - contrato vigente

Esta secao substitui as regras anteriores de independencia/sincronizacao manual
no formulario de livros. POST admite campos diretos title, author, categoriaId,
sku, price, currency, format, description, img, inventory e os demais campos
editoriais existentes. Categoria por ID, SKU nao vazio e price decimal positivo
ate 999.99 sao obrigatorios na criacao sem comercial. O objeto comercial anterior
continua aceito para outros consumidores; valores conflitantes entre comandos
compartilhados e explicitos retornam 400. Nenhum schema e alterado.

As colunas author/autor VARCHAR(100) NULL foram informadas como existentes pelo
usuario. GETs e revisoes editoriais/comerciais agora incluem author/autor;
clientes devem obter novas revisoes. Author usa a representabilidade latin1 do
livro. Currency aceita BRL; preco decimal e convertido com centavos inteiros.
Categoria e ancestrais sao validados e bloqueados antes de produto/livro.
O nome real da categoria (ate 50 caracteres representaveis) e persistido em
ist_livros.category; o ID fica em ist_loja_produtos.categoria_id.

PATCH sincroniza somente campos compartilhados enviados: title/titulo,
author/autor, sku/sku, description/descricao, currency/moeda, price/preco_centavos,
img/imagem_url e categoriaId/categoria_id (e category textual). Inventory atualiza
disponivel: Esgotado=0; Em estoque/Poucas unidades=1. Produto novo do formulario
segue essa disponibilidade e inicia em_venda=0. Nao ha ativacao automatica da venda
nem alteracao da politica de publicacao; DIGITAL sem versao publicada continua
sujeito a politica compartilhada. Ativo, ordem, perfil fiscal e flags omitidas
sao preservados. Formato de livro com produto continua bloqueado, inclusive inativo.
If-Match-Produto e exigido para sincronizacao comercial, alem de If-Match editorial.

JSON bibliografico usa somente a chave canonica "Autor:" para autoria. Aliases
Autor, Author e Author: sao substituidos por essa chave; outras propriedades sao
preservadas. Alteracao de autor atualiza JSON objeto existente, ou cria o objeto
quando a descricao era NULL. Texto legado nao JSON continua preservado, exigindo
confirmacao no formulario antes da conversao. Autor bibliografico e desabilitado.

Angular remove a secao Produto Comercial e envia categoriaId sem comercial.
Na edicao utiliza a categoria do produto persistido; sem produto, so resolve nome
legado quando existe uma unica correspondencia. Duplicidade exige escolha explicita.
Enviar capa abre o seletor nativo e a imagem selecionada e validada/enviada pelo
fluxo existente; a previa permanece ate confirmacao da URL publica. PDF aparece
somente para E-Book e orienta salvar primeiro se nao houver DIGITAL persistido.
Envio e registro continuam RASCUNHO, sem publicar ou preencher ist_livros.file.

Validacao: testes HTTP/contratos com bancos simulados e verificacoes estaticas.
Nenhum SQL-real, migration, servidor ou recurso de producao foi utilizado.


## Integracao transacional livro/produto - contrato atual

Esta secao prevalece sobre regras historicas de cadastro e exclusao abaixo.
POST /api/admin/loja/livros exige objeto comercial separado com categoriaId,
sku e precoCentavos inteiro positivo seguro. Categoria e ancestrais devem estar
ativos; SKU e unico. Nenhum preco/SKU legado e convertido automaticamente.
Uma conexao e uma transacao inserem livro e produto; somente COMMIT confirmado
permite 201 {item}. Produto inicia ativo=1, em_venda=0, disponivel=0, ordem=0,
perfil_fiscal_id=NULL, moeda=BRL. E-Book gera DIGITAL; Livro Fisico gera MERCADORIA.
Titulo, descricao e imagem iniciais sao copiados do cadastro. A politica comercial
existente permanece: produto fisico nao ganha checkout por esta integracao.

GET de detalhe, POST e PATCH retornam item.comercial (ou NULL para livro legado
sem produto), incluindo id, categoriaId, sku, precoCentavos, tipo, titulo, descricao,
imagemUrl, ativo, emVenda, disponivel e revisao comercial. Imagem e sanitizada;
a revisao considera os valores persistidos originais e equivale ao GET de produtos.
Listagem preserva o contrato anterior; a confirmacao de exclusao carrega o detalhe.

PATCH aceita comercial parcial: categoriaId, sku, precoCentavos, titulo, descricao,
imagemUrl, ativo, emVenda e disponivel. Nenhuma mudanca editorial sincroniza esses
campos implicitamente. If-Match editorial sempre obrigatorio; comando comercial
exige tambem If-Match-Produto. Ambos sao comparados sob locks. Tipo nao e editavel;
formato com produto associado permanece bloqueado. Livro legado sem produto nao
ganha produto por PATCH. Campos omitidos e valores legados NULL sao preservados.

DELETE exige If-Match editorial e, se houver produto, If-Match-Produto. Qualquer
pedido_item ou arquivo_versao referenciando o produto impede exclusao (409),
inclusive registros historicos e rascunhos. Sem referencias, exclui produto antes
do livro na mesma transacao. FKs concorrentes tambem retornam 409 com rollback;
nao existe cascade nem remocao de arquivos, pedidos, pagamentos ou direitos.

Locks seguem categorias/ancestrais em ordem de ID, depois produto, depois livro.
Vinculos descobertos sao revalidados sob lock. COMMIT incerto descarta a conexao,
retorna erro sanitizado e nunca provoca retry automatico. SKU duplicado e conflito
comercial; revisao obsoleta retorna 412 e revisao ausente 428.

Angular separa categoria editorial/comercial, SKU e preco comerciais dos legados.
Novo cadastro abre a edicao do registro persistido, exibindo produto ID/tipo e
permitindo PDF apenas para E-Book com DIGITAL. Enviar capa sem selecao apresenta
orientacao local, sem requisicao. Upload PDF continua somente rascunho.

Validacao desta unidade usa testes direcionados com banco simulado, TypeScript,
sintaxe JavaScript e diff; nao equivale a homologacao SQL-real ou deploy. Nenhuma
migration e necessaria pelo DDL disponivel; schema persistente nao foi consultado.


Atualizacao: a secao "Ampliacao bibliografica e PDF rascunho" abaixo prevalece
sobre as listas historicas de campos editaveis e limites de corpo anteriores.

## Ampliacao bibliografica e PDF rascunho

GET, POST e PATCH de livros agora incluem `sku`, `format`, `description`,
`price`, `onsale` e `inventory`, alem dos campos editoriais anteriores. GET
tambem informa `produtoTipo`, derivado e excluido da revisao. A revisao inclui
todos os campos editaveis; clientes devem recarregar o GET antes de escrever.

- `sku`: string latin1/cp1252 de ate 50 caracteres ou NULL.
- `format`: E-Book ou Livro Fisico (com acento no valor persistido). Alteracao
  efetiva retorna 409 se existir qualquer produto associado, inclusive inativo.
- `language`: aceita `es-419`. Requer a coluna VARCHAR(6) informada pelo usuario;
  o dump ainda possui VARCHAR(5). Nenhum schema persistente foi consultado.
- `description`: objeto JSON serializado, ate 65.535 bytes UTF-8, ou NULL.
- `price`: string decimal canonica `0.00` a `999.99`, ou NULL. O formulario
  apresenta virgula e converte por centavos inteiros, sem parseFloat.
- `onsale`: inteiro 0 ou 1. `inventory`: Em estoque, Poucas unidades ou Esgotado.

Os campos comerciais acima sao legados de ist_livros e nao atualizam produtos.
O preco comercial continua sendo ist_loja_produtos.preco_centavos. POST mantem
a verificacao da coluna price DECIMAL(5,2) nullable e falha com 503 quando o
schema nao e compativel. Nenhuma migration e aplicada automaticamente.

As dez chaves bibliograficas sao: `Título`, `Conteúdo`, `Formato`,
`Dimensões (cm)`, `Dimensões (pol)`, `Editor`, `Idioma`, `Prefixo Ed.`,
`ISBN-10`, `ISBN-13`. Titulo e idioma acompanham os campos principais; os cinco
textos livres permitem 50 caracteres; prefixo/ISBN usam strings numericas de
8/10/13 digitos, preservando zeros. ISBN-13 apresenta separador apos 3 digitos,
sem validar digito verificador. Aliases portugueses/ingleses sao reconhecidos;
propriedades desconhecidas sao preservadas. Texto legado nao objeto exige
confirmacao de conversao e e preservado na propriedade `Descrição legada original`.
Sem alteracao bibliografica, PATCH omite description.

POST/PATCH JSON administrativo possuem limite local de 144 KiB, para acomodar
o JSON serializado dentro do envelope JSON. Autenticacao, autorizacao, Origin e
CSRF continuam anteriores ao parser. Limites de cada campo permanecem ativos.
If-Match e comparado sob lock nas alteracoes; COMMIT deve ser confirmado antes
do sucesso. Campos omitidos, inclusive NULL e imagem original, sao preservados.

### POST /api/admin/loja/livros/:id/pdf

Exige autenticacao administrativa, Origin, CSRF e If-Match vigente. Aceita um
campo multipart `pdf`, MIME application/pdf e cabecalho PDF valido, ate 32 MiB.
Somente livro existente E-Book com produto DIGITAL associado. A relacao entre
livro e produto e conferida novamente sob o lock do servico de versoes.

Usa a mesma configuracao privada PRODUCTS_LIVROS_PATH da entrega D6, com raiz existente
validada, nome UUID, criacao exclusiva sem sobrescrita e registro pelo servico
lojaArquivoService. Retorna 201 `{item:{versaoPublicId,produtoId,numeroVersao,estado}}`,
com estado RASCUNHO. Nao retorna caminhos, hashes ou conteudo; nao altera file,
publicacao atual, precos comerciais, pedidos ou direitos. Publicacao exige uma
operacao separada futura, nao disponibilizada nesta interface.

Falha de registro retorna erro sanitizado; arquivo proprio permanece privado
para reconciliacao, pois o registro pode ter COMMIT incerto. Nao ha repeticao
automatica nem remocao de arquivos anteriores. O envio verifica formato e
integridade pelos servicos existentes; nao constitui antivirus de conteudo.

Verificacoes desta ampliacao: testes HTTP/contratos com banco simulado,
verificacao Angular sem emissao, sintaxe JavaScript e diff. SQL-real e validacao
manual de formulario/upload permanecem pendentes. Homologacoes historicas nao
comprovam os novos campos, a nova revisao ou o upload; as suites SQL existentes
precisam ter seus dados/projecoes atualizados antes de nova homologacao.

## Historico anterior

Estado atual: POST, PATCH e DELETE editorial e interface Angular implementados
localmente; ver "CRUD editorial local" ao final. As secoes anteriores sobre
bloqueio declarativo do POST e ausencia de cadastro/exclusao descrevem fases
historicas e sao substituidas pelo contrato final abaixo. Nao houve aplicacao
de migration ou homologacao funcional deste CRUD nesta rodada.

Fundacao administrativa com dois GETs operacionais de Livros (ver secao final).
PATCH editorial restrito operacional (ver secao final). Demais escritas continuam
declarativas, sem handlers de cadastro, upload ou publicacao.
Nao se alteraram Angular, checkout, catalogo publico, PayPal, migrations, dados
ou configuracoes de ambiente nesta entrega de leitura.

## Diagnostico editorial e bloqueio

Inspecionado somente o CREATE TABLE de ist_livros do export local nao rastreado
ist_loja_export.sql, preservado. Nao se consultou banco nem registros individuais.
O export nao comprova o schema efetivo de producao.

- id INT signed PK; title TINYTEXT nullable; description LONGTEXT utf8mb4;
  language VARCHAR(5); format ENUM E-Book/Livro Fisico; img TINYTEXT.
- category VARCHAR(50) NOT NULL sem default, em latin1_general_ci: metadado
  editorial legitimamente usado pelo bookController, BookService e dois pontos
  de apresentacao em editora.component.html. Nao confundir com categoriaId comercial.
- price DECIMAL(5,2) NOT NULL sem default: campo legado. Nao e lido como preco
  comercial pelo runtime atual. Migrations historicas R2 e fixtures ainda o usam.
- onsale, sku, currency, tax, inventory e file permanecem legados, sem exposicao
  como campos editaveis deste modulo. pertence_editora_ist aceita NULL/0/1.

Nao ha insercao editorial correta sem decidir price: omitir falha em modo estrito;
zero, preco copiado do produto ou valor ficticio nao foram autorizados. O contrato
Na fundacao original, POST /livros era bloqueado pelo validador com 503.
Atualmente a compatibilidade de price e verificada pelo handler antes do INSERT;
PATCH possui handler transacional homologado nas etapas anteriores.

Migration evolutiva ist_livros_price_nullable.sql criada e homologada em ambientes
descartaveis, tornando somente price anulavel e preservando valores historicos.
Sua aplicacao em banco persistente permanece SEM AUTORIZACAO; o guard atual
aceita somente destinos descartaveis. category continua
obrigatoria e fornecida explicitamente pelo operador. Nao criar sincronizacao de
precos, defaults ficticios ou alterar migrations historicas.

Desativar livro significa desativar sua oferta em ist_loja_produtos. Nao remover
classificacao editorial, pagina ou arquivo, e nao revogar direitos adquiridos.

## Composicao futura de seguranca

criarProtecaoLojaAdmin({env,db}) fornece entrada, emitirCsrf e protegerEscrita.
Usar cookie-parser e entrada antes de qualquer parser de escrita/upload. As
factories novas dos middlewares existentes permitem configuracao e DB explicitos;
exports antigos e seu comportamento padrao permanecem preservados.

entrada exige NODE_ENV explicito, JWT_SECRET configurado com pelo menos 32 bytes,
nao composto somente de espacos e sem marcadores conhecidos de exemplo/fallback.
Nao ha teste de diversidade nem estimativa de entropia. Comprimento nao comprova
aleatoriedade. Gerar o segredo com CSPRNG (por exemplo 32 bytes aleatorios,
representados em base64url), armazenar fora do repositorio e protege-lo. Exige
cookie administrativo unico, JWT HS256 valido com expiracao e identidade positiva.
Authorization, cookie de compra e sessao D7 nao concedem autoridade administrativa.
O mecanismo autorizarTiposUsuario existente reconsulta ist_usuarios e exige tipo 1;
nao confia no papel do JWT para decidir permissao. A consulta usa a mesma politica
existente, sem inventar regras de situacao do usuario.

Configuracao reutilizada: COOKIE_NAME (default ist_session), JWT_SECRET,
NODE_ENV, LOJA_ORIGENS_PERMITIDAS, LOJA_CSRF_SECRET. Nenhuma variavel nova.
Em production COOKIE_SECURE deve ser true; COOKIE_HTTPONLY=false e rejeitado.
Configuracao JWT de outras areas nao e endurecida globalmente nesta etapa.

emitirCsrf(req) somente funciona apos entrada autorizada. Um futuro GET protegido
de listagem/detalhe pode devolver o token no header X-CSRF-Token. Nao foi criado
endpoint de bootstrap. Token HMAC SHA-256 com dominio exclusivo admin, ligado ao
JWT exato, nonce aleatorio e validade maxima de 15 minutos. Usa a chave CSRF
existente sem compartilhar tokens/autorizacao de compra. Nao registrar o token.
Cliente deve obter novo token apos renovar o JWT; tokens nao sao de uso unico.

protegerEscrita exige POST/PATCH/PUT/DELETE, Origin exata configurada, rejeita
Sec-Fetch-Site cross-site e confere assinatura/prazo do token. Nao aceitar origem
por Host/Referer. Futuro router adicionara parser e Content-Type apropriados por
rota (JSON nesta fase contratual; multipart somente em fase posterior).

Erros: {erro:{codigo,mensagem}}, sem biblioteca, SQL, token, stack ou configuracao.
401 nao autenticado; 403 nao autorizado/CSRF/origem; 400 entrada; 404 registro
nao encontrado; 428 If-Match
ausente; 412 revisao divergente; 503 configuracao/infraestrutura/bloqueio.
entrada e respostas de erro definem Cache-Control: no-store. HTTP futuro deve
usar tratarErroAdmin por ultimo; nao refletir mensagens arbitrarias de excecao.

## Contratos futuros

Todos sob /api/admin/loja, permissao tipo 1; sem DELETE.

| Metodo/rota | Entrada/resultado |
| --- | --- |
| GET /livros | pagina, limite, busca, pertenceEditoraIst; lista editorial administrativa |
| GET /livros/:id | ID decimal positivo; detalhe editorial |
| POST /livros | title, format, category, pertenceEditoraIst obrigatorios; bloqueado por price legado |
| PATCH /livros/:id | subconjunto editorial nao vazio, If-Match |
| GET /produtos | pagina, limite, busca, categoriaId, ativo, emVenda, disponivel |
| GET /produtos/:id | ID decimal positivo; detalhe comercial |
| POST /produtos | livroId, categoriaId, sku, titulo, tipo, precoCentavos, moeda, ativo, emVenda, disponivel obrigatorios |
| PATCH /produtos/:id | subconjunto comercial nao vazio, If-Match |
| PATCH /produtos/:id/situacao | ativo/emVenda/disponivel booleanos, subconjunto nao vazio, If-Match |
| GET /categorias | pagina, limite, busca, ativo; sem CRUD de categorias |

Editaveis do livro: title, description, language, format, category, img,
pertenceEditoraIst. Editaveis do produto: livroId, categoriaId, sku, titulo,
descricao, tipo (somente DIGITAL nesta entrega planejada), precoCentavos, moeda
(BRL), imagemUrl, ativo, emVenda, disponivel. Nenhum dado financeiro/arquivo ou
podeComprar e aceito como escrita. Categoria comercial e FK; category e editorial.

IDs ate INT signed positivo, preco inteiro seguro positivo, pagina >=1 (maximo
1.000.000), limite 1..100/default20; pagina default1. Filtros booleanos sao strings
true/false; classificacao admite tambem null. Sem ordenacao SQL livre.
Validacao rejeita tipos/coercoes implicitas, campos desconhecidos, UTF-16 invalido
e controles. Textos comerciais de snapshot ate 65.535 bytes. Limites editoriais
para colunas latin1/cp1252: title ate 255 bytes armazenados (TINYTEXT), category
ate 50 caracteres de um byte (VARCHAR(50)). Repertorio ASCII/ocidental e os 27
caracteres imprimiveis estendidos cp1252, incluindo euro/aspas curvas/oe. Controles
C1 e caracteres nao representaveis sao rejeitados, nunca convertidos para '?'.
Nao depende de aliases TextDecoder/ICU; tabela explicita e testes de fronteira.
Descricao editorial limitada inicialmente a 65.535 bytes.
Imagens apenas referencias assets/images controladas ja suportadas.
SKU usa exatamente os criterios da politica comercial: texto nao vazio, UTF-16
integro, ate 50 caracteres e 65.535 bytes; aceita sinais/espacos/Unicode admitidos
pela politica. Nao normalizar, truncar ou aplicar uma nova whitelist ASCII.

Sucesso futuro: lista {itens:[],paginacao:{pagina,limite,total}}; detalhe/escrita
{item:{...}}. Livro retorna os campos editoriais acima, id e produtoId opcional.
Produto retorna seus campos comerciais, id e podeComprar calculado exclusivamente
pela politica existente. Nunca retornar file/caminho privado, credenciais ou
dados financeiros. Criacao futura 201; leitura/edicao 200. Ausencia de entidade
devera receber contrato 404 na fase de handlers, sem confundir com entrada invalida.

## Concorrencia e limites da fundacao

Revisao SHA-256 forte de recurso + ID + projecao editavel canonica. Os campos
sao definidos por CAMPOS_REVISAO_ADMIN, usando os editaveis listados acima.
projetarRevisaoAdmin exige todos os campos presentes (inclusive nullable), ignora
extras e nao inclui podeComprar, versaoPublicadaId, comercial ou campos legados.
O chamador deve normalizar tipos persistidos de modo consistente, incluindo
BIGINT e booleanos; nao passar DTO parcial do cliente ou SELECT * para definir
o contrato. Valores persistidos legados nulos continuam representaveis.
Campos derivados podem acompanhar outro envelope, mas essa revisao nao e um
ETag forte daquela representacao inteira. O futuro GET deve identificar a
representacao editavel a que o ETag/If-Match se aplica, sem usar esse token para
cache/304 de uma resposta que contenha campos derivados independentes.
PATCH exige um unico If-Match forte; * e listas/tags fracas rejeitados. Na mesma
transacao, bloquear registro, reler DTO, conferirIfMatchAdmin e somente entao
atualizar. A nova resposta emite revisao atual. Nao confiar no DTO enviado pelo
cliente para calcular a revisao e nao criar coluna artificial no banco.
ETag e precondicao de escrita, nao autorizacao e nao habilita cache.

FKs, unicidade, restricoes de mudanca de vinculo/tipo apos uso e locks de catalogo
devem ser verificados pelos handlers futuros, nao simulados pelos validadores.
Comprabilidade continua decidida pela politica comercial existente. Upload futuro
limitado a 32 MiB; registro/publicacao permanecem em lojaArquivoService e
lojaArquivos. Nada disso foi implementado como handler nesta etapa.

## Validacao

11 testes novos isolados. Regressao com adminUsuariosApi e serverComposicao:
65 aprovados, zero falhas/ignorados, exit0. DB simulado; nenhum acesso a banco.
Primeira rodada: 63 aprovados/2 falhas por COOKIE_NAME local diferente do nome
fixo ist_session usado nos testes existentes. Diagnostico confirmou a causa;
rodada final definiu COOKIE_NAME e JWT_SECRET sinteticos somente no processo,
restaurando valores anteriores. Nao se alteraram .env nem assertions existentes.
Sem endpoints novos, CRUD, upload, publicacao, migration, commit/push/deploy ou
inicio da Fase 2. Criacao editorial aguarda decisao especifica.

## Revisao Fase 1.1

Corrigidos SKU, repertorio/tamanho latin1, configuracao JWT sem alegacao de
entropia, erro 404 e projecoes especificas de revisao. Sem alterar autenticacao
das demais areas. Bloqueio de POST /livros permanece ate decisao sobre price.

17 testes unitarios de fundacao e um teste HTTP real sintetico em loopback/porta
efemera, com Express/cookie-parser, JWT real, DB simulado e rotas /__teste-admin
exclusivas do teste. Nenhum CRUD/endpoint de aplicacao registrado. CSRF cobre
MAC adulterado, expiracao de token bem formado, limite exato de 15 minutos e
prazo excessivo com MAC correto. Testes de revisao percorrem cada campo editavel,
rejeitam projecao incompleta e demonstram que campos derivados nao alteram tag.

Primeira rodada focada: 17 aprovados/1 falha, ao detectar dependencia indevida
do mapeamento TextDecoder no runtime. Corrigida com tabela cp1252 explicita;
rodada focada final: 18 aprovados, zero falhas/ignorados. Nao houve mudanca nos
criterios dos testes para ocultar a falha. Conversao SQL real nao foi exercitada
nesta fase; permanece verificacao futura em banco descartavel, nunca no principal.

Regressao final Fase 1.1: lojaAdminFundacao, lojaAdminHttp.integration,
adminUsuariosApi e serverComposicao, 72 aprovados, zero falhas/cancelados/ignorados,
exit0. COOKIE_NAME/JWT_SECRET sinteticos usados somente no processo e restaurados.
Verificacao de sintaxe e git diff --check aprovados. AuthMiddleware e
authorizationMiddleware nao sofreram novas alteracoes nesta revisao.

Fonte do charset: documentacao MariaDB SHOW CHARACTER SET identifica latin1 como
cp1252 West European:
https://mariadb.com/docs/server/reference/sql-statements/administrative-sql-statements/show/show-character-set

## Leitura administrativa operacional de Livros

Router /loja montado em admin.routes.js, sob /api/admin existente. Somente
GET /api/admin/loja/livros e GET /api/admin/loja/livros/:id implementados.
criarLojaAdminRouter({db,env}) e criarLojaLivrosAdminController({db}) permitem
injetar banco/configuracao sinteticos. Nenhuma conexao e aberta na composicao.

Ambos usam entrada, no-store e nosniff. X-CSRF-Token e emitido somente apos
autorizacao; os GETs nao exigem CSRF de escrita. Nao emitem cookies nem sessoes.
Sem novos handlers POST/PATCH/DELETE; POST de livros continua bloqueado.

Lista: {itens:[],paginacao:{pagina,limite,total}}. Filtros existentes pagina,
limite,busca,pertenceEditoraIst; sem filtro inclui NULL/0/1 e livros sem produto.
Busca literal por titulo, LIKE parametrizado com ESCAPE '!' para !/%/_. Ordem
fixa id ASC; pagina vazia responde 200. Contagem e pagina no mesmo snapshot
REPEATABLE READ, READ ONLY, sem locks de escrita, com release em finally.

Detalhe: {item:{id,title,description,language,format,category,img,
pertenceEditoraIst,produtoId,revisao}}. Lista usa o mesmo DTO. Classificacao
convertida para null/boolean e produtoId para null/numero. Campos editoriais
legados nulos preservados. img somente referencia assets/images permitida;
referencia insegura retorna null, nunca caminho privado. Revisao calculada a
partir da projecao editorial persistida (inclusive img original), sem produtoId;
nao emitir ETag forte do envelope ou respostas 304. Revisao e token opaco para
futuro If-Match, nao representa o envelope com a imagem sanitizada.

ID malformado ou query invalida: 400; ID valido inexistente: 404; infraestrutura
ou configuracao insegura: 503. Detalhe rejeita query parameters. Erros seguem
envelope administrativo existente sem SQL/stack. SELECT explicito nao le price,
file, sku ou precos comerciais. LEFT JOIN usa o vinculo unico livro_id.

Validacao desta entrega: 28 testes aprovados, zero falhas/ignorados, com Express
real em loopback/porta efemera, JWT e cookie-parser reais, banco exclusivamente
simulado, incluindo composicao do servidor com acesso SQL/rede bloqueado.
Primeira rodada detectou JWT sintetico sem id_tipo_usuario; corrigida a fixture
local do teste, sem mudar autenticacao. Posteriormente, os testes SQL reais
destas consultas foram aprovados: 8/8 em 13.0.2 e 8/8 em 10.3.39 descartaveis.
Nao depende da aplicacao da migration price para operar os GETs.

## Homologacao SQL real de Livros concluida localmente

tests/lojaAdminLivros.integration.test.js reutiliza as fixtures 13.0.2 e 10.3.39.
Seleciona 10.3.39 somente com IST_R2_10339_MANIFEST; sem manifesto, exige os
binarios 13.0.2 na fixture Windows. Nenhum fallback para DB_* ou pool padrao.
O teste bloqueia query/execute/getConnection do pool padrao e injeta outro pool
obtido exclusivamente da conexao validada. Schema/porta/datadir desse pool sao
reconferidos antes da carga propria. Nenhum dump ou PDF e importado.

Carga sintetica com IDs explicitos, titulo/category e demais campos latin1 com
collation editorial explicita; description utf8mb4_bin. Nao modifica id apos FK
nem aplica migration price. price continua NOT NULL com valor sintetico explicito.
Usuario minimo sintetico permite autorizacao SQL real, sem duplicar autenticacao.

Sete subcenarios: autenticacao/autorizacao SQL; DTO/nulos/imagem/vinculo e ausencia
de escritas pelos GETs; contagem/paginacao/filtros; LIKE literal; validacao/404;
revisao editorial independente da associacao; snapshot com COMMIT independente
entre contagem e pagina, usando barreira no adaptador e sem sleeps.

Executor scripts/loja-admin-livros-homologar-mariadb10339-wsl.sh derivado da
Fase 1.4, preservando digest, manifesto, labels, credenciais, porta e descarte
identificado. Exige Docker/containerd ativos; nao inicia nem encerra os servicos.
Falha no teste 10.3.39 preserva container/volume/segredos para diagnostico.
Limitacao herdada: a fixture Windows 13.0.2 SEMPRE encerra o processo e remove
seu datadir, inclusive em falha. Esta entrega nao altera essa fixture compartilhada;
retencao fisica em falha no Windows exigiria decisao/alteracao separada. Saida do
teste deve ser preservada. Nao declarar retencao fisica equivalente nas duas versoes.

Comandos de referencia para reproducao; novas execucoes exigem autorizacao:

```powershell
$env:IST_LOJA_PAGAMENTOS_MARIADB_BIN='C:\Program Files\MariaDB 13.0\bin'
# Confirmar IST_R2_10339_MANIFEST ausente antes da rodada Windows.
node --test --test-reporter=spec tests/lojaAdminLivros.integration.test.js
```

```bash
sudo bash /mnt/c/inetpub/wwwroot/istbrasil.org.br/scripts/loja-admin-livros-homologar-mariadb10339-wsl.sh
```

Estado final: Livros aprovado com 8/8 em cada versao, sem falhas ou ignorados.
Fixtures verificaram a identidade das instancias descartaveis e o pool exclusivo;
nome de schema isoladamente nao prova isolamento. Resultados registrados em
ADMIN_LIVROS_SQL_HTTP e resumo dos testes. Isso nao comprova schema, dados ou
configuracao de nenhum banco persistente, nem autoriza implantacao.

## Leitura administrativa operacional de Produtos e Categorias

Adicionados exclusivamente GET /api/admin/loja/produtos, /produtos/:id e
/categorias no mesmo router, mantendo Livros e a protecao administrativa.
Factories criarLojaProdutosAdminController({db,env}) e
criarLojaCategoriasAdminController({db}); sem repository ou dependencia nova.

Produtos: lista {itens,paginacao:{pagina,limite,total}}, detalhe {item}.
DTO: id,livroId,categoriaId,sku,titulo,descricao,tipo,precoCentavos,moeda,
imagemUrl,ativo,emVenda,disponivel,formatoEditorial,temVersaoPublicada,
podeComprar,revisao. Campos nullable preservados, sem validacao de comando
na leitura: MERCADORIA/SERVICO/DIGITAL continuam representaveis. Preco NULL
permanece NULL; inteiro positivo seguro retorna numero em centavos; valor
inseguro/invalido causa 503 sanitizado, nunca arredondamento ou fallback.

disponivel e o cadastro, podeComprar e exclusivamente a elegibilidade retornada
por avaliarPoliticaComercial. Todas as categorias/ancestrais sao lidas no mesmo
snapshot e entregues a criarContextoCategorias; categorias nao sao filtradas
antes da avaliacao. Contexto explicito NODE_ENV/IST_LOJA_PAYPAL_ENV do router,
sem nova excecao Sandbox. Sem filtrar produtos pela visibilidade publica:
inativos, fora de venda, sem livro e sem versao permanecem consultaveis.
EXISTS usa estado PUBLICADA/publicacao_atual=1 sem selecionar caminho/hash.

Busca literal em titulo OU sku, com ESCAPE '!' e escape de !/%/_. Categoria
exata por categoriaId; filtros ativo/emVenda/disponivel representam o cadastro.
Ordem fixa id ASC; contagem/pagina/categorias em REPEATABLE READ READ ONLY,
sem locks de escrita e com release em finally. Detalhe rejeita query parameters.

Categorias: lista plana {itens,paginacao:{pagina,limite,total}}; item
{id,nome,slug,categoriaPaiId,ativo,ordem}. Busca literal nome OU slug, filtro
ativo opcional, ordem ordem ASC/id ASC, incluindo inativas sem filtro.
Nao usa listagem publica que excluiria categorias administrativas necessarias.

Revisao dos produtos usa exclusivamente projetarRevisaoAdmin/criarEtagAdmin,
normalizando booleanos/centavos. Exclui formatoEditorial, publicacao, categorias
derivadas e podeComprar. Imagem usa imagemPublica; hash preserva o campo
persistido original, sem expor caminhos privados. Nao emitir ETag do envelope.
Configuracao/auth/autorizacao/CSRF/no-store/erros seguem a fundacao existente.

Validacao: 37 testes aprovados, zero falhas/ignorados nas suites HTTP simuladas
de Produtos/Categorias e Livros, fundacao, CSRF e composicao. Cobre politica
compartilhada, limite seguro, NULL, ancestrais inativos, tipos, Sandbox existente,
revisao sem derivados, queries parametrizadas, erros SQL simulados e release.
Posteriormente, SQL real dos tres novos GETs aprovado com 12/12 em 13.0.2 e
12/12 em 10.3.39, exclusivamente descartaveis. Nao houve alteracao de servicos
comerciais compartilhados, Angular, checkout, PayPal, schema ou dados persistentes.

## Homologacao SQL de Produtos/Categorias concluida localmente

Criados tests/lojaAdminProdutos.integration.test.js e
scripts/loja-admin-produtos-homologar-mariadb10339-wsl.sh. Nao alteram a suite,
executor ou fixtures de Livros. Sintaxe JS/Bash e revisao estatica aprovadas;
homologacoes SQL reais concluidas: 12/12 em cada uma das duas versoes.

A suite reutiliza a selecao de fixtures, verificacao de identidade, portas TCP
normalizadas/validadas e bloqueio do pool padrao de Livros. Pool novo deriva
apenas da conexao descartavel identificada; banco/porta/datadir reconferidos.
Dados e usuarios sinteticos, IDs explicitos, sem MODIFY da PK referenciada.
Usa expandirCatalogoSintetico existente para construir DDL homologado de catalogo
e downloads no schema isolado; nao importa dump nem executa migrations no principal.
Nao aplica migration price. Nenhum PDF e criado/lido; versoes possuem apenas
metadados sinteticos. Nenhum dado de pedido e incluido nas respostas.

Onze grupos homologados: auth/SQL e configuracao; contrato/nulos/vinculos; tipos,
situacoes e centavos seguros; paginacao/filtros; busca literal adversa;
categorias/hierarquia; versoes/politica por ambiente; validacao e ausencia de
escritas pelos GETs; revisao sem derivados; snapshot de produtos; snapshot de
categorias. Compara hashes das cinco tabelas de carga antes/depois dos GETs,
antes das escritas sinteticas explicitas usadas para testar revisao/concorrencia.
Revisao e testada sem mudar ao retirar versao, editar livro ou categoria e muda
ao editar preco comercial. Testa Sandbox existente e bloqueio em contexto production
sintetico (somente env injetado, sem credenciais ou chamadas externas).

Executor deriva do de Livros: mesmas identidades, digest, labels, mounts,
segredos, exclusividade e descarte apos sucesso; exige servicos Docker/containerd
ativos e nao altera seus estados. Falha preserva recursos 10.3.39. A limitacao
herdada da fixture Windows permanece: ela descarta seu processo/datadir mesmo em
falha. Resultados finais confirmados pelo percurso executado em cada versao;
nao extrapolar a comprovacao para outros ambientes ou bancos persistentes.

As rodadas foram separadas: 13.0.2 descartavel sem IST_R2_10339_MANIFEST e
10.3.39 pelo executor proprio, preservando Docker/containerd compartilhados.
A referencia da politica no teste recebeu adaptacao validada de tipos numericos,
preservando NULL e valores monetarios exatos, sem alterar a politica ou expectativas comerciais.
Evidencias: ADMIN_PRODUTOS_SQL_HTTP, versao/schema/porta, resumo de testes e
confirmacao de limpeza. Novas execucoes continuam dependendo de autorizacao.

## Encerramento local dos cinco endpoints GET (historico anterior ao PATCH)

| Suite | MariaDB 13.0.2 | MariaDB 10.3.39 |
| --- | --- | --- |
| Livros HTTP + SQL | 8/8 | 8/8 |
| Produtos/Categorias HTTP + SQL | 12/12 | 12/12 |
| Total por versao | 20/20 | 20/20 |

Total: 40 testes SQL-real contabilizados (incluindo os testes agregadores),
aprovados nas rodadas finais, sem falhas ou ignorados. Homologacoes 10.3.39
confirmadas pelo usuario; 13.0.2 executadas no ambiente descartavel local.
Preserva-se o historico das falhas de preparacao anteriores; os resultados finais
nao significam que essas falhas nunca ocorreram.

Encerrada a implementacao local de GET /api/admin/loja/livros, /livros/:id,
/produtos, /produtos/:id e /categorias. Os testes usaram somente instancias,
schemas, usuarios e dados sinteticos descartaveis. Nao comprovam o estado de
bancos persistentes de desenvolvimento ou producao. Nao houve autorizacao de
implantacao nem de aplicacao persistente de ist_livros_price_nullable.sql.
Os GETs nao dependem da nulabilidade de price; POST /livros continua bloqueado.

Controles de leitura efetivos: autenticacao JWT administrativa, autorizacao tipo
1 consultada no banco, validacao de entradas, consultas parametrizadas, projecoes
explicitas, erros sanitizados, no-store/nosniff e snapshots somente leitura.
CSRF e emitido apos autorizacao; GETs nao exigem token CSRF de escrita nem Origin
como condicao de leitura. Revisao editorial/comercial exclui campos derivados.

No encerramento original dos GETs, os controles de escrita estavam apenas
preparados. Esse planejamento foi executado posteriormente para o PATCH editorial
restrito descrito abaixo: Origin/CSRF, If-Match, lock/releitura e transacao estao
integrados e homologados nesse endpoint. POST, demais PATCHs e DELETE nao foram
implementados; contratos futuros nao equivalem a operacoes disponiveis.

Proxima unidade funcional proposta: integracao Angular dos livros existentes no
painel /admin, utilizando os GETs e o PATCH editorial ja homologados. Ainda requer
autorizacao especifica de implementacao; nao inclui cadastro ou gestao comercial.
Cadastro de novos livros e aplicacao persistente da migration exigem etapas e
autorizacoes separadas. Nenhuma mudanca de frontend, checkout ou PayPal implicita.

## PATCH editorial restrito: contrato efetivo e encerramento tecnico local

Implementado PATCH /api/admin/loja/livros/:id exclusivamente para title, language,
category, img e pertenceEditoraIst. format/description permanecem na revisao,
mas sao proibidos no corpo, assim como campos comerciais, arquivos e desconhecidos.
Demais propriedades omitidas ficam intactas, inclusive imagens legadas sanitizadas
no GET. Valida limites/repertorio existentes, sem trim ou normalizacao silenciosa.
language/img/classificacao aceitam NULL; title/category nao. Corpo vazio rejeitado.
O nome de entrada da classificacao e pertenceEditoraIst. Autenticacao por cookie
JWT administrativo seguro e autorizacao pelo tipo atual 1 consultado no banco;
sessao de compra nao concede essa autoridade. CSRF e vinculado ao JWT exato usado
no GET administrativo que o emite, e a escrita exige Origin permitido.
Revisao editorial e opaca: usar o valor revisao retornado pelo GET em If-Match,
sem recalcular a partir do DTO sanitizado. Abrange title, description, language,
format, category, img persistida original e pertenceEditoraIst; exclui produtoId.

server.js marca o PATCH pela correspondencia do proprio Express e dispensa somente
nele os dois parsers globais. Outras rotas continuam com parsing anterior. Ordem
efetiva: cookie-parser -> entrada (config/JWT/tipo no banco) -> protegerEscrita
(Origin/CSRF) -> Content-Type application/json e charset UTF-8 -> parser 8 KiB
(inflate false) -> validacoes/If-Match -> transacao. JSON invalido 400, tamanho
excessivo 413, midia/charset/encoding inadequados 415; envelopes sanitizados.
Nao aceitar JSON ja processado por parser global como prova dessa ordem.

Transacao READ WRITE com FOR UPDATE apenas em ist_livros pela PK. Revisao dos
sete campos persistidos e comparada sob lock; somente os cinco campos enviados
e diferentes entram no UPDATE parametrizado. No-op valido nao gera UPDATE e
mantem revisao. If-Match ausente 428, malformado 400, obsoleto 412; livro ausente
404. Releitura editorial e SELECT simples de produtoId, sem locks de produtos ou
versoes. Preparar DTO sanitizado e responder 200 somente apos COMMIT confirmado.
Rollback em falhas anteriores; COMMIT incerto nao causa retry/rollback presumido.
Conexao de estado incerto (COMMIT/rollback falho) e destruida, nao devolvida ao pool;
conexao de estado conhecido sempre liberada. Nenhuma alteracao financeira ou DDL.
COMMIT incerto resulta em erro sanitizado de indisponibilidade (503), sem afirmar
que a alteracao foi revertida. O consumidor deve consultar novamente antes de
decidir uma nova tentativa. Nao ha retry automatico. No-op com revisao valida
retorna 200; propriedades omitidas, inclusive NULL e valores legados, nao sao
reescritas. Precos, SKU, produtos, versoes, arquivos e registros financeiros
permanecem fora do escopo de escrita.

tests/lojaAdminLivroPatchHttp.test.js importa composicao real de server.js com
app.listen interceptado (sem backend IST), conexoes mockadas obrigatorias e HTTP
sintetico em porta efemera encerrada ao final. Testa caixa/barra final do bypass,
JSON invalido negado antes dos parsers quando sem auth/CSRF, UTF-8, compressao,
8 KiB exatos e excesso, whitelist, NULL/omissao, revisoes, no-op, concorrencia
simulada, rollback/COMMIT incerto e preservacao dos parsers das outras rotas.
Primeira rodada detectou mock incompleto para a transacao READ ONLY do GET de
bootstrap; corrigido o mock, sem alterar os GETs. Naquela etapa a homologacao
SQL-real ainda estava pendente; foi concluida posteriormente nas duas versoes,
conforme o registro consolidado abaixo.
Migration price nao aplicada e cadastro continua bloqueado. Nenhuma implantacao.
Regressao final local: 45 testes aprovados, zero falhas/cancelados/ignorados,
incluindo PATCH, GETs Livros/Produtos/Categorias, fundacao, CSRF e composicao.
Sintaxe dos arquivos afetados e git diff --check aprovados naquele historico.
A rodada de implementacao HTTP simulada nao acessou SQL real, Docker ou banco
persistente; as homologacoes SQL-real posteriores usaram somente descartaveis.

## Infraestrutura SQL-real do PATCH e homologacoes concluidas

Criados tests/lojaAdminLivroPatch.integration.test.js e
scripts/loja-admin-livro-patch-homologar-mariadb10339-wsl.sh, sem alterar fixtures,
testes de Livros homologados ou producao. Selecionar exatamente uma configuracao:
IST_LOJA_PAGAMENTOS_MARIADB_BIN para 13.0.2, ou IST_R2_10339_MANIFEST para 10.3.39.
Ausencia/ambiguidade rejeitada; nao ha fallback DB_*. O executor novo remove
somente a variavel de binarios do proprio processo, nao configuracao persistente.
Identidades, porta TCP valida, host, versao, schema e datadir conferidos antes da
carga propria. Pool padrao bloqueado. Pool novo deriva da conexao autenticada da
fixture. IDs explicitos; PK referenciada nao e modificada. Apenas dados sinteticos.

Cinco grupos implementados e homologados: PATCH parcial/preservacao; NULL/livro sem produto/no-op;
rejeicoes e revisoes; rollback real; concorrencia com prova InnoDB. A carga possui
produto, versao PUBLICADA, pedido/item/pagamento/operacao/evento financeiros
sinteticos. Hashes verificam produtos, categorias, versoes, financeiro e tabelas
de direitos (estas inicialmente vazias). Nenhuma chamada PayPal ou PDF real.

Concorrencia: duas conexoes distintas identificadas por CONNECTION_ID(); A
mantida em barreira depois de FOR UPDATE retornar; B envia o mesmo locking read.
Terceira conexao confirma em INNODB_LOCK_WAITS/INNODB_TRX B aguardando A, antes
de liberar A. Entao exige COMMIT/200 de A, 412 sem UPDATE de B e estado final
igual ao de A. Sem metadados/privilegios ou sem evidencia no prazo: falha explicita.
Polling limitado serve somente para obter evidencia, nao inferir lock por tempo.
Relogio monotonico assegura pelo menos 200 ms sem leituras do cache InnoDB antes
da primeira observacao apos B e entre ciclos, contando o fim da consulta de
diagnostico como ultima leitura. O intervalo nao substitui a relacao B -> A.
Identidade efetiva, privilegio global PROCESS e correspondencia de instancia das
conexoes sao exigidos. JWT sintetico e estavel por identidade entre GET e PATCH.
Barreiras liberadas em finally/abort e conexoes fechadas na limpeza.

Rollback: apos UPDATE real, SELECT na mesma conexao confirma novo titulo; uma
consulta a coluna deliberadamente inexistente gera ER_BAD_FIELD_ERROR antes de
COMMIT. Exige rollback confirmado, HTTP 503 sanitizado, linha/revisao originais e
hashes externos intactos. Nao altera triggers/constraints para injetar falha.

Executor preserva digest/labels/manifesto/segredos e recursos em falha, descarta
somente recursos identificados apos sucesso e nao inicia/para Docker/containerd.
A fixture Windows continua descartando processo/datadir inclusive em falha.
Disponibilidade e visibilidade dos metadados InnoDB foram verificadas nas rodadas
finais aprovadas, sem skips silenciosos. Limites de tempo permanecem protecao
contra travamento, nao prova de concorrencia. Falhas anteriores de preparacao,
JWT/CSRF e observacao do cache fazem parte do historico; nao invalidam nem sao
apagadas pelos resultados finais.

### Evidencias consolidadas de encerramento

| Homologacao PATCH editorial | Aprovados | Falhos | Ignorados |
| --- | --- | --- | --- |
| MariaDB 13.0.2 descartavel | 6/6 | 0 | 0 |
| MariaDB 10.3.39 descartavel | 6/6 | 0 | 0 |

Cada total inclui os cinco grupos e o teste agregador. Nas duas versoes houve
comprovacao InnoDB de B aguardando A, COMMIT/HTTP 200 de A, HTTP 412 de B sem
UPDATE e estado final correspondente somente a A. Rollback apos UPDATE real
confirmado, revisao/estado restaurados e integridade comercial e financeira
preservada pelos hashes. Recursos descartaveis foram removidos apos sucesso.

Historico reportado e consolidado: 45 testes HTTP simulados/regressoes pertinentes
aprovados; 40 testes SQL-real dos GETs aprovados nas duas versoes (Livros 8/8 e
Produtos/Categorias 12/12 em cada versao). Os resultados de homologacao acima sao
evidencias de rodadas anteriores, incluindo a confirmacao fornecida para 10.3.39;
nao foram reproduzidos nesta atualizacao documental. Nesta rodada houve somente
conferencia do contrato implementado, revisao documental e git diff --check.

Encerramento tecnico local do PATCH editorial registrado. Homologacao nao equivale
a deploy nem comprova o estado dos bancos persistentes. A migration
ist_livros_price_nullable.sql permanece independente e sem autorizacao de
aplicacao em schema persistente. Cadastro, upload/publicacao de PDFs e gestao
comercial nao integram este PATCH. Proxima unidade funcional: integracao Angular
dos livros existentes, mediante autorizacao; sem avancar automaticamente.

## CRUD editorial local

Implementacao local autorizada: POST /api/admin/loja/livros (201 com {item}),
PATCH /api/admin/loja/livros/:id (200 com {item}) e
DELETE /api/admin/loja/livros/:id (204 sem corpo). GETs existentes preservados.
POST aceita title, format, category, pertenceEditoraIst (obrigatorios), language,
img e description (opcionais), conforme o contrato editorial existente.
PATCH continua aceitando somente title, language, category, img e pertenceEditoraIst.
Nao ha escrita comercial, upload, publicacao ou exclusao em cascata.

POST exige price DECIMAL(5,2) anulavel no schema conectado, verificado em
INFORMATION_SCHEMA antes de inserir price=NULL. Schema incompatível causa 503
sanitizado; nao ha cache dessa verificacao, DDL, valor artificial nem aplicacao
automatica de migration. A migration permanece independente, sem autorizacao
de aplicacao persistente. A interface nao solicita preco legado ou comercial.

Decisao atual substitui a vedacao anterior de exclusao fisica exclusivamente para
livro sem qualquer produto associado (inclusive inativo). DELETE exige If-Match,
lock do livro e comparacao da revisao sob lock, recusa vinculo com 409 e preserva
as FKs como barreira final concorrente. Nao desvincula produtos nem altera pedidos,
pagamentos, versoes ou direitos. FK impeditiva tambem retorna 409 sanitizado.

As tres escritas exigem JWT administrativo, perfil 1, Origin permitido e CSRF.
POST/PATCH usam parser JSON UTF-8 limitado a 8 KiB apos essas protecoes;
DELETE nao aceita corpo. A composicao Express exclui somente esses metodos e
caminhos dos dois parsers globais. Sucesso somente apos COMMIT confirmado;
COMMIT incerto descarta a conexao e retorna 503, sem repeticao automatica.
Demais respostas: 400 entrada, 401 sessao, 403 permissao/CSRF/origem, 404 ausencia,
412 revisao obsoleta, 428 revisao ausente, 413 tamanho e 415 midia invalidos.

Angular: listagem com Novo/Editar/Excluir, confirmacao de exclusao e formulario
compartilhado. Cadastro inclui format; edicao exibe format somente para leitura.
description nao integra o formulario desta unidade. Campos omitidos/NULL e
imagens legadas sao preservados; PATCH contem somente alteracoes explicitas.
CSRF e revisoes ficam somente em memoria; um GET protegido fornece CSRF antes
de cada escrita. Falha potencialmente incerta orienta conferir o estado antes
de repetir; formulario bloqueia nova gravacao ate recarga ou saida.

Validacao desta rodada somente estatica. Testes funcionais, HTTP e SQL-real do
POST/DELETE e da interface ficam pendentes de autorizacao separada. Resultados
historicos dos GETs/PATCH nao constituem homologacao destas novas operacoes.
# Publicação explícita de PDF e situação comercial

`POST /api/admin/loja/livros/:id/versoes-pdf/:versaoPublicId/publicar` exige sessão administrativa, autorização, Origin, CSRF vinculado ao JWT, JSON UTF-8 e `If-Match` editorial. Corpo exclusivo: `{ "publicacaoAtualEsperada": null }` para primeira publicação ou UUID da publicação atual observada. Retorna HTTP 200 com `{item: {versaoPublicId, numeroVersao, estado: "PUBLICADA"}}` após confirmação pelo serviço existente de arquivos.

O serviço existente valida o arquivo privado, a associação produto/livro DIGITAL/E-Book, bloqueia produto e versões e compara a publicação esperada dentro de sua transação. Uma publicação substituída torna-se RETIRADA; direitos históricos não são alterados. Repetição da mesma publicação já atual mantém a idempotência existente. Conflitos retornam 409 `ADMIN_PUBLICACAO_CONFLITO`; falhas não confirmadas retornam 503, sem repetição automática pela interface. A publicação não altera preço, SKU, `em_venda`, `disponivel` ou `onsale`.

A listagem administrativa passa a incluir `versoesPdf` com somente `versaoPublicId`, `numeroVersao` e `estado`, consultados em lote no snapshot da página. O detalhe mantém esses mesmos metadados; PUBLICADA identifica a publicação atual conforme as constraints existentes. Nenhum caminho privado ou hash é retornado. O ícone de publicação requer seleção explícita do rascunho e confirmação, inclusive diante de duplicidades históricas.

O formulário de edição reutiliza `PATCH /api/admin/loja/livros/:id` com `{comercial: {emVenda: true|false}}`, `If-Match` e `If-Match-Produto`. Quando essa é a única alteração, nenhum campo editorial ou outro campo comercial é enviado. Novos produtos continuam fora de venda. A elegibilidade exibida é obtida do GET administrativo de produto, calculada pela política compartilhada do backend. Em venda não garante compra; a publicação permanece independente. Retirar de venda não retira PDF nem revoga direitos adquiridos.

Nesta implementação foram utilizados testes HTTP/SQL simulados e verificações estáticas, sem homologação SQL real ou aplicação em ambiente persistente.
