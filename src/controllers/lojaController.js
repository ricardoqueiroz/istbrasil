import * as catalogo from '../services/lojaCatalogoService.js';

const validarQuery = (query, permitidas = []) => {
    if (Object.keys(query).some((chave) => !permitidas.includes(chave))) {
        throw new catalogo.ErroLoja(400, 'ENTRADA_INVALIDA', 'Parâmetros inválidos.');
    }
};

export const criarLojaController = (service = catalogo) => ({
    listarCategorias: async (req, res) => {
        validarQuery(req.query);
        res.json(await service.listarCategorias());
    },
    listarProdutos: async (req, res) => {
        validarQuery(req.query, ['categoria']);
        const categoria = catalogo.validarCategoria(req.query.categoria);
        res.json(await service.listarProdutos(categoria));
    },
    obterProduto: async (req, res) => {
        validarQuery(req.query);
        res.json(await service.obterProduto(catalogo.validarProdutoId(req.params.id)));
    },
    cotar: async (req, res) => {
        validarQuery(req.query);
        res.json(await service.cotar(req.body));
    }
});

export const { listarCategorias, listarProdutos, obterProduto, cotar } = criarLojaController();
