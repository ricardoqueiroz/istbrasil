import { pool } from '../config/db.js';
import sanitizeHtml from 'sanitize-html';
import { CONTRATO_PEDIDO, criarErroPedido } from './lojaPedidoContratos.js';

export class ErroLoja extends Error {
    constructor(status, codigo, mensagem) {
        super(mensagem);
        this.status = status;
        this.codigo = codigo;
    }
}

const invalido = () => new ErroLoja(400, 'ENTRADA_INVALIDA', 'Entrada inválida.');
const indisponivel = () => new ErroLoja(422, 'PRODUTO_INDISPONIVEL', 'Um ou mais produtos estão indisponíveis.');
const idValido = (id) => Number.isSafeInteger(id) && id > 0 && id <= 2147483647;
export const validarProdutoId = (valor) => {
    if (typeof valor !== 'string' || !/^[1-9]\d{0,9}$/.test(valor) || !idValido(Number(valor))) throw invalido();
    return Number(valor);
};
export const validarCategoria = (slug) => {
    if (slug !== undefined && (typeof slug !== 'string' || slug.length > 100 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug))) throw invalido();
    return slug;
};

// mysql2 devolve DECIMAL como string: nenhuma multiplicacao de ponto flutuante.
export const decimalParaCentavos = (valor) => {
    if (typeof valor !== 'string' || !/^\d+\.\d{2}$/.test(valor)) return null;
    const centavos = BigInt(valor.replace('.', ''));
    return centavos > 0n && centavos <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(centavos) : null;
};

const texto = (valor) => valor == null ? null : sanitizeHtml(String(valor), { allowedTags: [], allowedAttributes: {} });
const imagemPublica = (valor) => typeof valor === 'string'
    && /^\/?assets\/images\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.(?:png|jpe?g|webp|avif|gif)$/i.test(valor) ? valor : null;

// Mesmas regras para o snapshot consistente publico e a leitura interna bloqueante.
const criarContextoCategorias = (categorias) => {
    const mapa = new Map(categorias.map((c) => [c.id, c]));
    const caminho = (id) => {
        const vistos = new Set();
        while (id !== null) {
            const categoria = mapa.get(id);
            if (!categoria || categoria.ativo !== 1 || vistos.has(id)) return null;
            vistos.add(id);
            id = categoria.categoria_pai_id;
        }
        return vistos;
    };
    const categoriaPublica = (c) => ({ id: c.id, nome: texto(c.nome), slug: c.slug, categoriaPaiId: c.categoria_pai_id, ordem: c.ordem });
    return { mapa, caminho, categoriaPublica };
};

const precoElegivel = (p, caminho) => {
    const centavos = decimalParaCentavos(p.price);
    return p.ativo === 1 && caminho(p.categoria_id) && p.onsale === 1
        && p.format === 'E-Book' && p.currency === 'BRL' && centavos !== null
        && ['Em estoque', 'Poucas unidades'].includes(p.inventory) && p.arquivo_presente === 1 ? centavos : null;
};
const somarCentavos = (valores) => {
    const total = valores.reduce((soma, valor) => soma + valor, 0);
    if (!Number.isSafeInteger(total)) throw indisponivel();
    return total;
};

const textoArmazenavel = (valor, obrigatorio = false) => typeof valor === 'string'
    && (!obrigatorio || valor.trim().length > 0) && Buffer.byteLength(valor, 'utf8') <= 65535
    // Rejeitar UTF-16 malformado, sem substituicao silenciosa por U+FFFD.
    && Buffer.from(valor, 'utf8').toString('utf8') === valor;

const criarSnapshot = (p, precoCentavos) => {
    if (typeof p.sku !== 'string' || !p.sku.trim() || [...p.sku].length > 50
        || !textoArmazenavel(p.sku) || !textoArmazenavel(p.title, true)
        || (p.description !== null && !textoArmazenavel(p.description))) throw indisponivel();
    return { produto_id: p.id, sku_snapshot: p.sku, titulo_snapshot: p.title,
        descricao_snapshot: p.description, tipo_snapshot: 'E-Book', quantidade: 1,
        preco_unitario_centavos: precoCentavos, subtotal_centavos: precoCentavos };
};

/** Uso interno: conexao dedicada, em transacao READ WRITE ja iniciada pelo chamador.
 * Nao adquirir outros locks de catalogo antes desta operacao, nem atualizar catalogo
 * nesta transacao. Cada PK e lida em consulta propria: categorias -> produtos -> livros.
 * Em QUALQUER erro o chamador deve desfazer a transacao inteira antes de tentar de novo;
 * inclusive CONTENCAO_TEMPORARIA, deadlock ou lock timeout. Nenhuma retentativa interna.
 * Os snapshots preservam textos originais; consumidores devem usar saida segura.
 */
export const prepararItensNaConexao = async (conexao, produtoIds) => {
    if (!conexao || typeof conexao.query !== 'function') throw criarErroPedido('ERRO_INTERNO');
    if (!Array.isArray(produtoIds) || produtoIds.length < 1 || produtoIds.length > CONTRATO_PEDIDO.maxProdutos
        || Array.from(produtoIds).some((id) => !idValido(id)) || new Set(produtoIds).size !== produtoIds.length) {
        throw criarErroPedido('SELECAO_INVALIDA');
    }
    const ids = [...produtoIds].sort((a, b) => a - b);
    const [[estado]] = await conexao.query('SELECT @@in_transaction AS em_transacao');
    if (estado?.em_transacao !== 1) throw criarErroPedido('ERRO_INTERNO');

    // Descoberta sem locks. Estas linhas NUNCA determinam preco ou snapshot final.
    const descobertos = [];
    for (const id of ids) {
        const [[produto]] = await conexao.query('SELECT id, categoria_id, livro_id FROM ist_loja_produtos WHERE id = ?', [id]);
        if (!produto) throw indisponivel();
        descobertos.push(produto);
    }
    const [categorias] = await conexao.query('SELECT id, categoria_pai_id, ativo FROM ist_loja_categorias ORDER BY id');
    const inicial = criarContextoCategorias(categorias);
    const necessarias = new Set();
    for (const produto of descobertos) {
        const ancestrais = inicial.caminho(produto.categoria_id);
        if (!ancestrais) throw indisponivel();
        for (const id of ancestrais) necessarias.add(id);
    }

    const categoriasBloqueadas = [];
    for (const id of [...necessarias].sort((a, b) => a - b)) {
        const [[categoria]] = await conexao.query(`SELECT id, categoria_pai_id, ativo
            FROM ist_loja_categorias WHERE id = ? LOCK IN SHARE MODE`, [id]);
        if (!categoria || categoria.categoria_pai_id !== inicial.mapa.get(id).categoria_pai_id) {
            throw criarErroPedido('CONTENCAO_TEMPORARIA');
        }
        categoriasBloqueadas.push(categoria);
    }
    const atual = criarContextoCategorias(categoriasBloqueadas);
    for (const produto of descobertos) if (!atual.caminho(produto.categoria_id)) throw indisponivel();

    const produtos = [];
    for (const anterior of descobertos) {
        const [[produto]] = await conexao.query(`SELECT id, categoria_id, livro_id, sku, ativo
            FROM ist_loja_produtos WHERE id = ? LOCK IN SHARE MODE`, [anterior.id]);
        if (!produto) throw indisponivel();
        if (produto.categoria_id !== anterior.categoria_id || produto.livro_id !== anterior.livro_id) {
            throw criarErroPedido('CONTENCAO_TEMPORARIA');
        }
        produtos.push(produto);
    }
    const livros = new Map();
    const livroIds = [...new Set(produtos.map((p) => p.livro_id))].sort((a, b) => a - b);
    for (const id of livroIds) {
        const [[livro]] = await conexao.query(`SELECT id, title, description, price, currency, onsale, format, inventory,
            (file IS NOT NULL AND CHAR_LENGTH(TRIM(file)) > 0) AS arquivo_presente
            FROM ist_livros WHERE id = ? LOCK IN SHARE MODE`, [id]);
        if (!livro) throw indisponivel();
        livros.set(id, livro);
    }
    const itens = produtos.map((produto) => {
        const linha = { ...livros.get(produto.livro_id), ...produto };
        const preco = precoElegivel(linha, atual.caminho);
        if (preco === null) throw indisponivel();
        return criarSnapshot(linha, preco);
    });
    return { itens, moeda: 'BRL', totalCentavos: somarCentavos(itens.map((item) => item.subtotal_centavos)) };
};

const validarItens = (entrada) => {
    if (!entrada || typeof entrada !== 'object' || Array.isArray(entrada)
        || Object.keys(entrada).length !== 1 || !Object.hasOwn(entrada, 'itens')
        || !Array.isArray(entrada.itens) || entrada.itens.length > 100) throw invalido();
    const ids = new Set();
    for (const item of entrada.itens) {
        if (!item || typeof item !== 'object' || Array.isArray(item)
            || Object.keys(item).length !== 2 || !Object.hasOwn(item, 'produtoId')
            || !Object.hasOwn(item, 'quantidade') || !idValido(item.produtoId)
            || !Number.isInteger(item.quantidade)) throw invalido();
        if (item.quantidade !== 1 || ids.has(item.produtoId)) {
            throw new ErroLoja(422, 'ITENS_INVALIDOS', 'Cada título digital permite uma única unidade, sem duplicatas.');
        }
        ids.add(item.produtoId);
    }
    return entrada.itens;
};

export const criarLojaCatalogoService = ({ db = pool, agora = () => new Date() } = {}) => {
    const lerCatalogo = async (operacao) => {
        const conexao = await db.getConnection();
        try {
            await conexao.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
            await conexao.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
            const [categorias] = await conexao.query('SELECT id, nome, slug, categoria_pai_id, ativo, ordem FROM ist_loja_categorias ORDER BY ordem, id');
            const { mapa, caminho, categoriaPublica } = criarContextoCategorias(categorias);
            const carregarProdutos = async () => {
                const [linhas] = await conexao.query(`SELECT p.id, p.sku, p.categoria_id, p.ativo,
                    l.title, l.description, l.language, l.img, l.price, l.currency,
                    l.onsale, l.format, l.inventory,
                    (l.file IS NOT NULL AND CHAR_LENGTH(TRIM(l.file)) > 0) AS arquivo_presente
                    FROM ist_loja_produtos p JOIN ist_livros l ON l.id = p.livro_id
                    ORDER BY p.ordem, p.id`);
                return linhas.flatMap((p) => {
                    const precoCentavos = precoElegivel(p, caminho);
                    if (precoCentavos === null) return [];
                    return [{ id: p.id, sku: p.sku, titulo: texto(p.title), descricao: texto(p.description),
                        categoria: categoriaPublica(mapa.get(p.categoria_id)), idioma: texto(p.language),
                        imagemUrl: imagemPublica(p.img), precoCentavos, moeda: 'BRL', disponivel: true, quantidadeMaxima: 1 }];
                });
            };
            const resultado = await operacao({ categorias, caminho, categoriaPublica, carregarProdutos });
            await conexao.commit();
            return resultado;
        } catch (erro) {
            await conexao.rollback();
            throw erro;
        } finally {
            conexao.release();
        }
    };
    return {
        listarCategorias: () => lerCatalogo(async ({ categorias, caminho, categoriaPublica }) =>
            categorias.filter((c) => caminho(c.id)).map(categoriaPublica)),
        listarProdutos: (categoria) => {
            validarCategoria(categoria);
            return lerCatalogo(async ({ categorias, caminho, carregarProdutos }) => {
                const produtos = await carregarProdutos();
                if (categoria === undefined) return produtos;
                const filtro = categorias.find((c) => c.slug === categoria);
                return filtro ? produtos.filter((p) => caminho(p.categoria.id).has(filtro.id)) : [];
            });
        },
        obterProduto: (id) => {
            if (!idValido(id)) throw invalido();
            return lerCatalogo(async ({ carregarProdutos }) => {
                const produto = (await carregarProdutos()).find((p) => p.id === id);
                if (!produto) throw new ErroLoja(404, 'PRODUTO_NAO_ENCONTRADO', 'Produto não encontrado.');
                return produto;
            });
        },
        cotar: (entrada) => {
            const itens = validarItens(entrada);
            return lerCatalogo(async ({ carregarProdutos }) => {
                const produtos = new Map((await carregarProdutos()).map((p) => [p.id, p]));
                const cotados = itens.map(({ produtoId }) => {
                    const produto = produtos.get(produtoId);
                    if (!produto) throw indisponivel();
                    return { produtoId, quantidade: 1, produto, precoUnitarioCentavos: produto.precoCentavos, subtotalCentavos: produto.precoCentavos };
                });
                const totalCentavos = somarCentavos(cotados.map((item) => item.subtotalCentavos));
                return { itens: cotados, moeda: 'BRL', totalCentavos, geradaEm: agora().toISOString() };
            });
        }
    };
};

export const { listarCategorias, listarProdutos, obterProduto, cotar } = criarLojaCatalogoService();
