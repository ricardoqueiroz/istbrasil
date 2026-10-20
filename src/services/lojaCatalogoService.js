import { pool } from '../config/db.js';
import sanitizeHtml from 'sanitize-html';
import { CONTRATO_PEDIDO, criarErroPedido } from './lojaPedidoContratos.js';
import { selecionarVersoesNaConexao } from './lojaArquivoService.js';

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
export const imagemPublica = (valor) => typeof valor === 'string'
    && /^\/?assets\/images\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.(?:png|jpe?g|webp|avif|gif)$/i.test(valor) ? valor : null;

// Hierarquia compartilhada entre leitura publica e preparacao transacional.
export const criarContextoCategorias = (categorias) => {
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

// R3.2: politica reutilizavel; nao consulta o banco nem gerencia transacoes.
export const contextoComercialBackend = () => ({ ambienteBackend: process.env.NODE_ENV,
    ambientePaypal: process.env.IST_LOJA_PAYPAL_ENV });
export const avaliarPoliticaComercial = (p, caminho, contexto = contextoComercialBackend()) => {
    const valor = p.preco_centavos;
    const centavos = typeof valor === 'number' && Number.isSafeInteger(valor) && valor > 0 ? valor
        : typeof valor === 'string' && /^[1-9]\d{0,15}$/.test(valor)
            && BigInt(valor) <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(valor) : null;
    const visivel = p.ativo === 1 && p.em_venda === 1 && Boolean(caminho(p.categoria_id))
        && ['MERCADORIA', 'SERVICO', 'DIGITAL'].includes(p.tipo) && p.moeda === 'BRL' && centavos !== null
        && textoArmazenavel(p.sku, true) && [...p.sku].length <= 50
        && textoArmazenavel(p.titulo, true) && (p.descricao === null || typeof p.descricao === 'string');
    // Ainda nao ha entrega operacional para mercadorias/servicos/digitais sem livro.
    const sandboxSemConteudo = ['development','test'].includes(contexto.ambienteBackend)
        && contexto.ambientePaypal === 'sandbox' && (contexto.ambientePedido === undefined || contexto.ambientePedido === 'sandbox')
        && p.id === 6 && p.livro_id === 3 && p.sku === 'IST-SANDBOX-CHECKOUT-001'
        && centavos === 100 && p.moeda === 'BRL';
    const elegivel = visivel && p.disponivel === 1 && p.tipo === 'DIGITAL'
        && idValido(p.livro_id) && p.formato_editorial === 'E-Book' && (p.versao_publicada === 1 || sandboxSemConteudo)
        && (p.descricao === null || textoArmazenavel(p.descricao));
    return { visivel, elegivel, precoCentavos: centavos };
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
    // Chamado somente apos a politica compartilhada validar os limites de armazenamento.
    return { produto_id: p.id, sku_snapshot: p.sku, titulo_snapshot: p.titulo,
        descricao_snapshot: p.descricao, tipo_snapshot: p.tipo, quantidade: 1,
        preco_unitario_centavos: precoCentavos, subtotal_centavos: precoCentavos };
};

/** Uso interno: conexao dedicada, em transacao READ WRITE ja iniciada pelo chamador.
 * Nao adquirir outros locks de catalogo antes desta operacao, nem atualizar catalogo
 * nesta transacao. Cada PK e lida em consulta propria: categorias -> produtos -> livros.
 * Em QUALQUER erro o chamador deve desfazer a transacao inteira antes de tentar de novo;
 * inclusive CONTENCAO_TEMPORARIA, deadlock ou lock timeout. Nenhuma retentativa interna.
 * Os snapshots preservam textos originais; consumidores devem usar saida segura.
 */
export const prepararItensNaConexao = async (conexao, produtoIds, contexto = contextoComercialBackend()) => {
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
        const [[produto]] = await conexao.query(`SELECT id, categoria_id, livro_id, sku, ativo,
            titulo, descricao, CAST(preco_centavos AS CHAR) AS preco_centavos, moeda, tipo, em_venda, disponivel
            FROM ist_loja_produtos WHERE id = ? LOCK IN SHARE MODE`, [anterior.id]);
        if (!produto) throw indisponivel();
        if (produto.categoria_id !== anterior.categoria_id || produto.livro_id !== anterior.livro_id) {
            throw criarErroPedido('CONTENCAO_TEMPORARIA');
        }
        produtos.push(produto);
    }
    const livros = new Map();
    const livroIds = [...new Set(produtos.map((p) => p.livro_id).filter(id => id !== null))].sort((a, b) => a - b);
    for (const id of livroIds) {
        const [[livro]] = await conexao.query(`SELECT id, format
            FROM ist_livros WHERE id = ? LOCK IN SHARE MODE`, [id]);
        if (!livro) throw indisponivel();
        livros.set(id, livro);
    }
    const versoes = await selecionarVersoesNaConexao(conexao, produtos.filter(p => p.tipo === 'DIGITAL').map(p => p.id));
    const itens = produtos.map((produto) => {
        const livro = livros.get(produto.livro_id);
        const linha = { ...produto, formato_editorial: livro?.format ?? null, versao_publicada: versoes.get(produto.id) ? 1 : 0 };
        const politica = avaliarPoliticaComercial(linha, atual.caminho, contexto);
        if (!politica.elegivel) throw indisponivel();
        return criarSnapshot(produto, politica.precoCentavos);
    });
    return { itens, versoes, moeda: 'BRL', totalCentavos: somarCentavos(itens.map((item) => item.subtotal_centavos)) };
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

export const criarLojaCatalogoService = ({ db = pool, agora = () => new Date(), contextoComercial = contextoComercialBackend() } = {}) => {
    const lerCatalogo = async (operacao) => {
        const conexao = await db.getConnection();
        try {
            await conexao.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
            await conexao.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
            const [categorias] = await conexao.query('SELECT id, nome, slug, categoria_pai_id, ativo, ordem FROM ist_loja_categorias ORDER BY ordem, id');
            const { mapa, caminho, categoriaPublica } = criarContextoCategorias(categorias);
            const carregarProdutos = async () => {
                const [linhas] = await conexao.query(`SELECT p.id, p.sku, p.categoria_id, p.ativo,
                    p.titulo, p.descricao, CAST(p.preco_centavos AS CHAR) AS preco_centavos,
                    p.moeda, p.imagem_url, p.tipo, p.em_venda, p.disponivel, p.livro_id,
                    l.language, l.format AS formato_editorial,
                    EXISTS(SELECT 1 FROM ist_loja_arquivo_versoes v WHERE v.produto_id=p.id
                        AND v.estado='PUBLICADA' AND v.publicacao_atual=1) AS versao_publicada
                    FROM ist_loja_produtos p LEFT JOIN ist_livros l ON l.id = p.livro_id
                    ORDER BY p.ordem, p.id`);
                return linhas.flatMap((p) => {
                    const politica = avaliarPoliticaComercial(p, caminho, contextoComercial);
                    if (!politica.visivel) return [];
                    return [{ id: p.id, sku: p.sku, titulo: texto(p.titulo), descricao: texto(p.descricao),
                        categoria: categoriaPublica(mapa.get(p.categoria_id)), idioma: texto(p.language),
                        imagemUrl: imagemPublica(p.imagem_url), precoCentavos: politica.precoCentavos, moeda: 'BRL',
                        tipo: p.tipo, livroId: p.livro_id ?? null, formatoEditorial: texto(p.formato_editorial),
                        disponivel: politica.elegivel, quantidadeMaxima: 1 }];
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
                    if (!produto || !produto.disponivel) throw indisponivel();
                    return { produtoId, quantidade: 1, produto, precoUnitarioCentavos: produto.precoCentavos, subtotalCentavos: produto.precoCentavos };
                });
                const totalCentavos = somarCentavos(cotados.map((item) => item.subtotalCentavos));
                return { itens: cotados, moeda: 'BRL', totalCentavos, geradaEm: agora().toISOString() };
            });
        }
    };
};

export const { listarCategorias, listarProdutos, obterProduto, cotar } = criarLojaCatalogoService();
