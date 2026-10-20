# D5.2-B2 — direitos iniciais na transacao do pedido

`selecionarVersoesNaConexao(conexao, produtoIds)` exige transacao ativa e
locks de categorias/produtos/livros previamente adquiridos. Consulta cada
produto em ordem crescente, somente estado PUBLICADA e publicacao_atual=1,
com LOCK IN SHARE MODE. Retorna Map<produtoId, versaoId|null>, sem caminhos.
Nao abre conexao/transacao, nao faz COMMIT e nao acessa arquivos fisicos.

`prepararItensNaConexao(conexao, produtoIds, contextoComercial?)` retorna
`{ itens, versoes, moeda, totalCentavos }`. `versoes` e metadado interno;
nao altera os campos dos snapshots nem os DTOs HTTP. Ordem efetiva:
sessao exclusiva -> categorias -> produtos -> livros -> versoes, com locks
compartilhados nas quatro ultimas etapas. IDs ordenados em cada grupo.
Nao adquire GET_LOCK. Publicacao continua usando caminho -> produto exclusivo
-> livro compartilhado -> versoes exclusivas, sem alteracao desse fluxo.

Catalogo e API editorial usam EXISTS de versao vigente no mesmo snapshot de
leitura dos dados comerciais. Preparacao usa leitura bloqueante atual, e
revalida disponibilidade. A cotacao nao reserva versao nem preco. Publicacao
concorrente espera pelo produto bloqueado pelo pedido, ou termina antes de
o pedido adquirir seu lock. Uma versao retirada posteriormente permanece
fixada nos direitos ja criados; nao e substituida automaticamente.

A politica compartilhada nao usa ist_livros.file. Mantem preco/SKU oficiais,
categorias ativas, BRL, disponibilidade, tipo DIGITAL, livro associado e formato
E-Book. Mercadorias/servicos/digitais sem suporte continuam bloqueados.

## Sandbox

Contexto padrao confiavel vem exclusivamente de NODE_ENV e IST_LOJA_PAYPAL_ENV
no processo backend. Fabricas internas podem receber contextoComercial para
composicao/testes; nenhum parametro HTTP e usado. Todos os requisitos:

- ambienteBackend development ou test; ambientePaypal sandbox;
- ambiente do pedido sandbox (quando informado);
- produto 6, livro 3, SKU IST-SANDBOX-CHECKOUT-001, BRL, 100 centavos;
- demais criterios comerciais satisfeitos.

Configuracao ausente/invalida desativa a excecao. Sem versao, esse produto
nao recebe direito nem evento. Se tiver versao publicada valida, segue o fluxo
normal. Nenhuma outra identidade pode usar a excecao.

## Persistencia e falhas

Depois de inserir cada item, criarPedidoComResultado valida insertId e usa o
mapa previamente fixado. Insere direito AGUARDANDO_CONFIRMACAO, versao 1, e
evento com anterior NULL, novo AGUARDANDO_CONFIRMACAO, origem PEDIDO,
motivo DIREITO_CRIADO e direito_versao=1. Tudo antes do COMMIT existente.
Nao ativa direitos, altera pagamento ou oferece download HTTP.

UNIQUE por pedido_item_id e por (direito_id,direito_versao) e FKs compostas
existentes protegem unicidade e correspondencia entre produto/item/arquivo.
Falha no direito/evento desfaz pedido, itens e demais registros da tentativa.
Retries transitorios existentes permanecem limitados a tres, apos rollback.

Replay por sessao/chave retorna o persistido: nao recota, nao seleciona nova
versao, nao cria direitos ou eventos ausentes. Historicos sem direitos ficam
intactos; nao ha backfill. Ausencia isolada nao distingue historico de corrupcao
posterior e nunca autoriza download.

COMMIT incerto descarta a conexao e reconcilia em outra, sob lock da sessao.
Confere pedido/itens e cada direito esperado (public_id, item, produto, versao)
com seu evento inicial. Nao exige que o estado atual permaneca pendente, pois
etapas futuras podem processa-lo. Divergencia/ausencia devolve erro temporario,
sem INSERT de recuperacao. Nao ha nova captura nem chamada financeira.

## Homologacao

Testes de escrita usam exclusivamente fixtures descartaveis com identidade
validada e dados/PDFs sinteticos. DDLs homologados sao montados somente como
schema de teste; nenhuma migration e aplicada no principal.

MariaDB 13.0.2: regressao de 382 testes aprovados, zero falhas/ignorados,
incluindo checkout/PayPal simulados, catalogo, editorial, pedidos, publicacao,
concorrencia, rollback, deadlock/retry e COMMIT incerto.

MariaDB 10.3.39: executor existente recebe seletor d52b2 para executar
tests/lojaPedidoDireitos.integration.test.js; requer sudo pessoal no WSL.
Responsavel confirmou sucesso e descarte de container, volume e segredos;
Docker/containerd encerrados e inicializacao automatica desativada. Saida
recebida sem detalhamento TAP; nao se atribui a essa versao o total de 382.

Comparacao somente de leitura antes/depois confirmou estrutura e conteudo do
banco principal identicos, inclusive pedidos historicos. Arquivos protegidos
mantiveram SHA-256. Servidores existentes nao foram reiniciados.

Pendente D5.2-B3: ativacao/suspensao/revogacao financeira dos direitos e seus
eventos. Entrega HTTP, integridade fisica antes da entrega e recuperacao por
email permanecem fora desta etapa.
