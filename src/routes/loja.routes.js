import express from 'express';
import { rateLimit } from 'express-rate-limit';
import { criarLojaController } from '../controllers/lojaController.js';
import { ErroLoja } from '../services/lojaCatalogoService.js';
import { criarLojaSessaoRouter } from './lojaSessao.routes.js';
import { criarLojaPedidoRouter } from './lojaPedido.routes.js';

export const tratarErroLoja = (erro, req, res, next) => {
    if (res.headersSent) return next(erro);
    if (req.path === '/cotacao') res.set('Cache-Control', 'no-store');
    if (erro.type === 'entity.parse.failed') {
        return res.status(400).json({ erro: { codigo: 'JSON_INVALIDO', mensagem: 'JSON inválido.' } });
    }
    if (erro.type === 'entity.too.large') {
        return res.status(413).json({ erro: { codigo: 'CORPO_MUITO_GRANDE', mensagem: 'Requisição muito grande.' } });
    }
    const conhecido = erro instanceof ErroLoja;
    return res.status(conhecido ? erro.status : 500).json({ erro: {
        codigo: conhecido ? erro.codigo : 'ERRO_INTERNO',
        mensagem: conhecido ? erro.message : 'Não foi possível consultar a Loja.'
    } });
};

export const criarLojaRouter = ({ service, sessaoService, obterConfiguracaoSessao, agoraSessao,
    pedidoService, obterConfiguracaoPedido } = {}) => {
    const router = express.Router();
    const controller = criarLojaController(service);
    router.use('/cotacao', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
    router.use('/sessao', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
    router.use('/pedidos', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
    router.use(rateLimit({
        windowMs: 60_000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false,
        handler: (req, res) => res.status(429).json({ erro: { codigo: 'LIMITE_REQUISICOES', mensagem: 'Muitas requisições. Tente novamente em um minuto.' } })
    }));
    router.use('/sessao', criarLojaSessaoRouter({ service: sessaoService, obterConfiguracao: obterConfiguracaoSessao, agora: agoraSessao }));
    router.use('/pedidos', criarLojaPedidoRouter({ service: pedidoService, sessaoService, obterConfiguracaoSessao, obterConfiguracaoPedido }));
    router.use(express.json({ limit: '32kb' }));
    router.get('/categorias', controller.listarCategorias);
    router.get('/produtos', controller.listarProdutos);
    router.get('/produtos/:id', controller.obterProduto);
    router.post('/cotacao', controller.cotar);
    return router;
};

export default criarLojaRouter();
