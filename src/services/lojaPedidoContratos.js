import { createHash } from 'node:crypto';

// Contratos puros: nenhuma dependencia de Express, pool, ambiente ou relogio.
export const CONTRATO_PEDIDO = Object.freeze({
    versaoContrato: 1,
    estadoInicial: 'CRIADO',
    versaoInicial: 1,
    ambienteInicial: 'sandbox',
    moeda: 'BRL',
    maxProdutos: 100,
    sessaoDuracaoSegundos: 86400,
    pedidoValidadeSegundos: 1800,
    cotacaoAtualizacaoSegundos: 300
});

export const ESTADOS_PEDIDO = Object.freeze([
    'CRIADO', 'AGUARDANDO_PAGAMENTO', 'PAGO', 'CANCELADO', 'EXPIRADO',
    'PARCIALMENTE_REEMBOLSADO', 'REEMBOLSADO', 'ESTORNADO', 'REVISAO'
]);

export const ERROS_PEDIDO = Object.freeze(Object.fromEntries(Object.entries({
    SOLICITACAO_INVALIDA: { status: 400, mensagem: 'Solicitação de pedido inválida.' },
    EMAIL_INVALIDO: { status: 422, mensagem: 'Informe um endereço de e-mail válido.' },
    SELECAO_INVALIDA: { status: 422, mensagem: 'Selecione de 1 a 100 produtos distintos e válidos.' },
    IDEMPOTENCIA_INVALIDA: { status: 400, mensagem: 'Chave de idempotência inválida.' },
    SESSAO_INVALIDA: { status: 401, mensagem: 'A sessão de compra está ausente, inválida ou expirada.' },
    ORIGEM_INVALIDA: { status: 403, mensagem: 'Origem da solicitação não permitida.' },
    CSRF_INVALIDO: { status: 403, mensagem: 'Não foi possível validar a proteção da solicitação.' },
    PRODUTO_INDISPONIVEL: { status: 422, mensagem: 'Um ou mais produtos estão indisponíveis.' },
    CONFLITO_IDEMPOTENCIA: { status: 409, mensagem: 'Esta chave de idempotência já foi usada com outra solicitação.' },
    CONTENCAO_TEMPORARIA: { status: 503, mensagem: 'Pedido temporariamente indisponível. Tente novamente com a mesma chave.' },
    ERRO_INTERNO: { status: 500, mensagem: 'Não foi possível processar o pedido.' }
}).map(([codigo, definicao]) => [codigo, Object.freeze(definicao)])));

const codigoSeguro = (codigo) => typeof codigo === 'string' && Object.hasOwn(ERROS_PEDIDO, codigo) ? codigo : 'ERRO_INTERNO';

export const criarErroPedido = (codigo) => {
    codigo = codigoSeguro(codigo);
    return Object.assign(new Error(ERROS_PEDIDO[codigo].mensagem), { name: 'ErroPedido', codigo, status: ERROS_PEDIDO[codigo].status });
};

// O futuro adapter HTTP devera usar este envelope, nunca serializar o Error inteiro.
export const erroPedidoPublico = (erro) => {
    const codigo = codigoSeguro(erro && typeof erro === 'object' ? Object.getOwnPropertyDescriptor(erro, 'codigo')?.value : undefined);
    return { erro: { codigo, mensagem: ERROS_PEDIDO[codigo].mensagem } };
};

const objetoSimples = (valor) => valor !== null && typeof valor === 'object'
    && Object.getPrototypeOf(valor) === Object.prototype;
const idProdutoValido = (id) => Number.isSafeInteger(id) && id > 0 && id <= 2147483647;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Subconjunto suportado: local-part ASCII dot-atom (ate 64) e dominio DNS ASCII.
 * Nao aceita nomes de apresentacao, quoted local-parts, literais IP ou SMTPUTF8/IDN
 * Unicode. Dominios ja codificados em punycode sao aceitos. Nao consulta DNS.
 */
export const normalizarEmailComprador = (valor) => {
    if (typeof valor !== 'string' || /[\u0000-\u001f\u007f-\u009f]/u.test(valor)) throw criarErroPedido('EMAIL_INVALIDO');
    const email = valor.trim();
    if (email.length > 254 || !/^[\x21-\x7e]+$/.test(email)) throw criarErroPedido('EMAIL_INVALIDO');
    const partes = email.split('@');
    if (partes.length !== 2) throw criarErroPedido('EMAIL_INVALIDO');
    const [local, dominio] = partes;
    if (local.length > 64 || !/^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/i.test(local)) {
        throw criarErroPedido('EMAIL_INVALIDO');
    }
    const labels = dominio.split('.');
    if (labels.length < 2 || dominio.length > 253 || labels.some((label) => label.length > 63
        || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label))) throw criarErroPedido('EMAIL_INVALIDO');
    return `${local}@${dominio.toLowerCase()}`;
};

export const validarSolicitacaoPedido = (entrada) => {
    if (!objetoSimples(entrada)) throw criarErroPedido('SOLICITACAO_INVALIDA');
    const chaves = Reflect.ownKeys(entrada);
    if (chaves.length !== 2 || !chaves.includes('produtoIds') || !chaves.includes('compradorEmail')
        || chaves.some((chave) => {
            const campo = Object.getOwnPropertyDescriptor(entrada, chave);
            return !campo.enumerable || !Object.hasOwn(campo, 'value');
        })) throw criarErroPedido('SOLICITACAO_INVALIDA');
    const ids = entrada.produtoIds;
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > CONTRATO_PEDIDO.maxProdutos) throw criarErroPedido('SELECAO_INVALIDA');
    const unicos = new Set();
    for (let indice = 0; indice < ids.length; indice++) {
        const id = Object.getOwnPropertyDescriptor(ids, indice)?.value;
        if (!idProdutoValido(id) || unicos.has(id)) throw criarErroPedido('SELECAO_INVALIDA');
        unicos.add(id);
    }
    if (Reflect.ownKeys(ids).length !== ids.length + 1) throw criarErroPedido('SELECAO_INVALIDA');
    return { produtoIds: [...unicos].sort((a, b) => a - b), compradorEmail: normalizarEmailComprador(entrada.compradorEmail) };
};

export const validarChaveIdempotencia = (valor) => {
    if (typeof valor !== 'string' || valor.length !== 36
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(valor)) {
        throw criarErroPedido('IDEMPOTENCIA_INVALIDA');
    }
    return valor.toLowerCase();
};

/** O ambiente e argumento confiavel do servidor, nunca um campo do comprador.
 * live e reconhecido para delimitar hashes; isto nao habilita operacoes live.
 * Nao registrar esta representacao em logs, pois inclui o e-mail do comprador.
 */
export const canonicalizarSolicitacaoPedido = (entrada, ambiente) => {
    if (ambiente !== 'sandbox' && ambiente !== 'live') throw criarErroPedido('ERRO_INTERNO');
    const { produtoIds, compradorEmail } = validarSolicitacaoPedido(entrada);
    return JSON.stringify({ versaoContrato: CONTRATO_PEDIDO.versaoContrato, compradorEmail, produtoIds, ambiente });
};

/** Retorna Buffer de 32 bytes, compativel com solicitacao_hash BINARY(32). */
export const gerarHashSolicitacaoPedido = (entrada, ambiente) =>
    createHash('sha256').update(canonicalizarSolicitacaoPedido(entrada, ambiente), 'utf8').digest();

const falhaInterna = () => { throw criarErroPedido('ERRO_INTERNO'); };
const centavosPublicos = (valor) => {
    if (typeof valor === 'number') {
        if (Number.isSafeInteger(valor) && valor > 0) return valor;
    } else if (typeof valor === 'bigint' || (typeof valor === 'string' && /^\d+$/.test(valor))) {
        const inteiro = BigInt(valor);
        if (inteiro > 0n && inteiro <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(inteiro);
    }
    return falhaInterna();
};

const dataUtcPublica = (valor) => {
    // O futuro repositorio deve ler DATETIME como UTC explicito, sem assumir
    // que o Date produzido pelo timezone local do driver representa UTC.
    if (typeof valor !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(valor)
        || !Number.isFinite(Date.parse(valor)) || new Date(valor).toISOString() !== valor) return falhaInterna();
    return valor;
};

/** Projeta linhas internas com os nomes reais da Etapa 64 em DTO publico.
 * Datas de entrada: strings ISO UTC com milissegundos. Sem defaults inventados.
 * Usa somente snapshots; nao consulta catalogo nem recalcula o total do pedido.
 */
export const pedidoPublico = (pedido, itens) => {
    if (!objetoSimples(pedido) || typeof pedido.public_id !== 'string' || pedido.public_id.length !== 36 || !uuid.test(pedido.public_id)
        || !ESTADOS_PEDIDO.includes(pedido.estado) || !Number.isInteger(pedido.versao)
        || pedido.versao < 1 || pedido.versao > 4294967295 || pedido.moeda !== 'BRL'
        || !Array.isArray(itens) || itens.length < 1 || itens.length > CONTRATO_PEDIDO.maxProdutos) return falhaInterna();
    const criadoEm = dataUtcPublica(pedido.criado_em);
    const expiraEm = dataUtcPublica(pedido.expira_em);
    if (expiraEm <= criadoEm) return falhaInterna();
    const produtos = new Set();
    const posicoes = new Set();
    for (const item of itens) {
        if (!objetoSimples(item) || !idProdutoValido(item.produto_id) || produtos.has(item.produto_id)
            || !Number.isInteger(item.posicao) || item.posicao < 1 || item.posicao > 65535 || posicoes.has(item.posicao)
            || typeof item.sku_snapshot !== 'string' || typeof item.titulo_snapshot !== 'string'
            || typeof item.tipo_snapshot !== 'string' || item.quantidade !== 1) return falhaInterna();
        produtos.add(item.produto_id);
        posicoes.add(item.posicao);
    }
    return {
        publicId: pedido.public_id, estado: pedido.estado, versao: pedido.versao, moeda: pedido.moeda,
        totalCentavos: centavosPublicos(pedido.total_centavos), criadoEm, expiraEm,
        itens: [...itens].sort((a, b) => a.posicao - b.posicao).map((item) => {
            const precoUnitarioCentavos = centavosPublicos(item.preco_unitario_centavos);
            const subtotalCentavos = centavosPublicos(item.subtotal_centavos);
            if (subtotalCentavos !== precoUnitarioCentavos) return falhaInterna();
            return { produtoId: item.produto_id, sku: item.sku_snapshot, titulo: item.titulo_snapshot,
                tipo: item.tipo_snapshot, quantidade: item.quantidade, precoUnitarioCentavos, subtotalCentavos };
        })
    };
};
