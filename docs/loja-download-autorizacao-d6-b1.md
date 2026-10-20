# D6-B1 — autorização interna de direitos digitais

`criarLojaDownloadAutorizacaoService({ db, contextoEsperado, agora? })` recebe o pool existente e o contexto confiável `{ provedor: 'paypal', ambiente: 'sandbox' | 'live', contaRecebedora }`. O contexto é copiado na composição e não é argumento das operações do comprador. A composição não inicia consultas, timers ou conexões.

## Contratos internos

- `listarDireitosDaSessao(token, { limite = 20, apos = null }?)`: máximo 50; cursor UUID público exclusivo, ordem crescente por UUID. Retorna `{ direitos: [{ publicId, titulo, estado, podeSolicitarArquivo }], proximoCursor }`. Título vem do snapshot e tem HTML removido. O indicador é informativo, derivado de `ATIVO`; não substitui a autorização financeira atual.
- `localizarDireitoDaSessao(token, publicId)`: referência interna do direito, pedido, item, produto e versão adquirida. Não retorna caminho nem hash. Não é DTO público nem autorização de arquivo.
- `autorizarArquivoNaConexao(conexao, token, publicId)`: exige transação já aberta e isolamento de sessão `READ COMMITTED`. O chamador deve configurar uma conexão limpa com `SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED` **antes** de iniciar a transação, sem override de isolamento por transação; deve encerrar a transação e restaurar a configuração antes de devolver a conexão ao pool. Não abre transação aninhada, não faz commit/rollback e não realiza retry. Em erro, o chamador deve abortar a transação.

Listagem e localização usam uma transação curta própria, restauram o isolamento anterior da conexão e descartam conexões sujas ou cujo commit/rollback/restauração falhe. Nenhuma operação executa DML. O token é validado pelo serviço de sessão existente, sem estabelecer ou renovar sessão. Duplicidade de cookies permanece responsabilidade do leitor de cookies existente, que rejeita a duplicidade; este serviço recebe somente seu token validável.

## Propriedade e concorrência

Todas as buscas do direito incluem `p.sessao_id = ? AND s.token_hash = ?`, através dos joins sessão → pedido → item → direito → versão. Item, direito e versão precisam corresponder ao mesmo produto. UUID de outra sessão e UUID inexistente retornam o mesmo erro.

A autorização adquire locks na ordem sessão → pedido → pagamentos → operações → evidências financeiras → direitos, com IDs ordenados. Não adquire locks de produto ou publicação. Autentica novamente após obter o lock da sessão e antes de retornar, verificando a validade absoluta, expiração e revogação pelo contrato existente. Leituras em `READ COMMITTED` evitam reutilizar um snapshot anterior à espera dos locks.

Exige direito `ATIVO` e nova avaliação `ELEGIVEL` por `avaliarElegibilidadeFinanceiraNaConexao`, na mesma conexão e transação. Compara a referência do avaliador com estado, versão otimista e versão de arquivo adquirida. Estado ativo isoladamente não basta. Versão retirada depois da aquisição pode continuar válida conforme a política financeira existente. Direito pendente, suspenso ou revogado nunca autoriza e não sofre transição aqui.

O retorno da autorização é exclusivamente interno: referências do direito/pedido/versão, caminho relativo validado, tamanho em string decimal segura, SHA-256 binário e MIME PDF. Não autoriza URL pública, não é token reutilizável e não deve ser serializado ao comprador. A transação deve terminar antes de qualquer futura leitura ou transmissão de arquivo.

## Erros e limites

Erros controlados: `SESSAO_INVALIDA`, `ENTRADA_INVALIDA`, `DIREITO_NAO_ENCONTRADO`, `DIREITO_INDISPONIVEL`, `FINANCEIRO_INDISPONIVEL`, `ARQUIVO_INDISPONIVEL`, `TRANSACAO_INVALIDA` e `AUTORIZACAO_INDISPONIVEL`. Erros SQL não propagam mensagens, parâmetros ou credenciais.

A avaliação utiliza somente evidência financeira local persistida; não descobre eventos externos ainda não recebidos. Nenhum histórico sem direito é reconstruído, incluindo compras Sandbox sem arquivo. Não há endpoints, ativação implícita, leitura de PDF, streaming ou chamadas PayPal.

D6-B2 deverá validar a raiz privada, confinamento e identidade do arquivo, tamanho e hash dos bytes efetivamente entregues, sem manter locks SQL durante I/O. A ativação explícita continua reservada à D6-B3.

## Validação

`node --test tests/lojaDownloadAutorizacaoService.test.js` usa somente as fixtures descartáveis existentes. No Windows, habilitar a fixture com `IST_LOJA_PAGAMENTOS_MARIADB_BIN`. No WSL, o executor existente aceita `d6b1` para a imagem fixada MariaDB 10.3.39. Não utilizar o banco principal para esses testes.
