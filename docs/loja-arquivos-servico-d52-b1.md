# D5.2-B1 — servico interno de versoes

## Contratos e limites

`criarLojaArquivoService({ db, raizPrivada, agora?, maxBytes? })` exige pool e raiz
absoluta explicitamente injetados. Nao importa dotenv/pool da aplicacao, nao
abre conexao ao importar, nao registra rotas e nao escreve arquivos. Limite
padrao de leitura: 256 MiB, configuravel por inteiro seguro. Sem dependencias novas.

- `registrarRascunho({ registroPublicId, produtoId, caminhoRelativo, arquivoLogicoId })`
- `publicar({ produtoId, versaoPublicId, publicacaoAtualEsperada })`

UUIDs canonicos minusculos, versoes 1-5 (randomUUID v4 recomendado), fornecidos
por chamador interno confiavel. Campos extras e omissoes sao rejeitados.
`publicacaoAtualEsperada` e obrigatoria: UUID da versao vigente ou NULL.
O retorno e interno: versaoPublicId, produtoId, arquivoLogicoId, numeroVersao
e estado; nao contem caminho fisico. Nao e DTO HTTP nem credencial de download.

Registro nao exige produto atualmente a venda. Exige tipo DIGITAL, livro
associado e formato E-Book, preservando o suporte operacional existente.
Nao consulta nem utiliza `ist_livros.file`. Nao implementa excecao Sandbox.
Nenhum produto real foi publicado ou associado a arquivo nesta etapa.

## Arquivo e imutabilidade

Raiz explicita sem fallback; segmentos ancestrais e caminho sao verificados
com lstat/realpath. Rejeita symlink/junction, hardlink, arquivo nao regular,
caminho absoluto, traversal, URL, encoding, query e caracteres fora da politica
do schema. Extensao deve ser `.pdf`. Assinatura inicial exata PDF 1.0-1.7 ou 2.0;
nao e parser completo, verificacao de EOF ou scanner de conteudo malicioso.

SHA-256 e tamanho sao calculados por streaming ANTES de abrir transacao SQL.
O descritor permanece aberto ate o fim da operacao. Identidade (dev/ino), tamanho,
mtime e ctime sao comparados no descritor e no caminho apos hash, antes de SQL
e imediatamente antes de COMMIT; a cadeia de caminhos e revalidada.

Isso detecta substituicoes observadas entre essas etapas, mas nao fornece uma
operacao atomica entre filesystem e SQL. Processo externo com escrita pode
alterar o arquivo depois da ultima verificacao ou do COMMIT. Armazenamento
operacionalmente imutavel e obrigatorio; se nao comprovado, D6 deve revalidar
integridade antes da entrega. O servico nao altera ACL, move ou sobrescreve PDFs.

Produto, identidade logica, numero, caminho, tamanho, SHA e MIME nao possuem
operacao de edicao. Nova versao exige novo registro e caminho para o produto.
Entre produtos, caminho compartilhado explicitamente so e aceito com hash,
tamanho e MIME iguais. Caminhos com diferenca apenas de caixa sao tratados
conservadoramente como equivalentes, inclusive em Linux.

## SQL e locks

Cada operacao usa conexao limpa, READ COMMITTED, autocommit 1 e uma transacao
propria curta. Conexao recebida com transacao pendente e descartada; nao se
suportam transacoes aninhadas. Nao existe retry automatico.

Ordem: lock nomeado GET_LOCK por caminho normalizado -> produto FOR UPDATE ->
livro LOCK IN SHARE MODE -> versoes por ID, uma consulta FOR UPDATE por ID.
O lock de caminho (nome de 64 caracteres, hash, espera maxima 5 segundos)
serializa registros do mesmo caminho entre produtos/processos. Nao e fila,
servico externo ou tabela nova. Todos os escritores deste recurso devem seguir
o mesmo contrato; SQL direto pode contornar as garantias do servico.

Sob lock do produto sao conferidas identidade logica, unicidade de registro e
proximo numero de versao. Publicacao confere a expectativa, retira a anterior e
publica o rascunho no mesmo COMMIT. Uma versao RETIRADA nao e republicada.
PUBLICADA ja vigente e repeticao idempotente, sem modificar datas.

Somente INSERT de versao e UPDATE dos quatro campos de estado/publicacao/data
sao utilizados. Nao modifica schema, pedidos, direitos, eventos ou financeiro.
RELEASE_LOCK e fechamento do arquivo ocorrem ao finalizar; conexao incerta ou
com falha de liberacao e destruida em vez de devolvida ao pool.

## Falhas e idempotencia

Registro repetido pelo mesmo registroPublicId devolve o registro existente se
produto, identidade, caminho e conteudo coincidirem; divergencia e conflito.
Repeticao deve reutilizar os identificadores originais, nunca gerar novo UUID
para contornar um erro. Falha SQL antes de COMMIT causa rollback integral.
Erros retornam somente codigos controlados, sem SQL, caminhos ou segredos.

COMMIT incerto destroi a conexao e faz uma reconciliacao em nova conexao sob os
mesmos locks, sem novo INSERT nem outra publicacao. Registro ausente ou estado
nao demonstravel resulta em RESULTADO_DESCONHECIDO. Se uma publicacao ja tiver
sido substituida, nao a reativa para tentar produzir uma resposta de sucesso.
Deadlock/lock timeout retornam CONTENCAO_TEMPORARIA; nenhuma repeticao interna.

## Testes e execucao

```powershell
$env:IST_LOJA_PAGAMENTOS_MARIADB_BIN='C:\Program Files\MariaDB 13.0\bin'
node --test --test-reporter=spec tests/lojaArquivoService.test.js
```

```bash
sudo bash /mnt/c/inetpub/wwwroot/istbrasil.org.br/scripts/loja-r2-homologar-mariadb10339-wsl.sh d52b1
```

O executor WSL recebeu apenas o seletor d52b1. Mesma imagem 10.3.39 fixada e
mesma identificacao externa ja homologada. Fixture monta somente o DDL da
tabela de versoes e dados sinteticos necessarios; nao aplica a migration de
downloads nem escreve no principal. Nao cria direitos ou eventos de download.

Cobertura: assinatura PDF inclusive bytes altos invalidos, limite, tamanho/SHA,
arquivo ausente, caminhos, junction/symlink/hardlink, produto, identidade,
idempotencia, compartilhamento controlado, numeracao concorrente, publicacao
concorrente, rollback, COMMIT perdido (registro e publicacao), COMMIT nao
efetivado e troca/mutacao do arquivo durante a operacao.

MariaDB 13.0.2: 21 testes aprovados, zero falhas e ignorados na suite final.
MariaDB 10.3.39: responsavel informou sucesso do executor e descarte completo,
com Docker/containerd encerrados. Resumo recebido sem detalhamento TAP; nao
foi executado novamente pelo agente. Houve ajuste de um teste sintetico para
usar a identidade logica correta ao testar divergencia de caminho/conteudo.

## Proxima fase

D5.2-B2 ainda precisa selecionar e fixar versoes na transacao de pedidos,
substituir a prova operacional baseada em `ist_livros.file`, criar direitos e
evento inicial e implementar a politica Sandbox especificamente autorizada.
Este servico nao foi conectado a rotas, checkout, agendador ou inicializacao.
