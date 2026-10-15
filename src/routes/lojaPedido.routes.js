import express from 'express';
import { rateLimit } from 'express-rate-limit';
import { criarProtecaoLoja } from '../middlewares/lojaSessaoMiddleware.js';
import { criarLojaPedidoController } from '../controllers/lojaPedidoController.js';
import { validarChaveIdempotencia, ERROS_PEDIDO, erroPedidoPublico } from '../services/lojaPedidoContratos.js';

export const tratarErroPedidoLoja = (erro, req, res, next) => {
    if (res.headersSent) return next(erro);
    res.set('Cache-Control', 'no-store');
    if (erro?.type === 'entity.parse.failed') return res.status(400).json({ erro: { codigo: 'JSON_INVALIDO', mensagem: 'JSON inválido.' } });
    if (erro?.type === 'entity.too.large') return res.status(413).json({ erro: { codigo: 'CORPO_MUITO_GRANDE', mensagem: 'Requisição muito grande.' } });
    if (['charset.unsupported', 'encoding.unsupported'].includes(erro?.type)) {
        return res.status(400).json({ erro: { codigo: 'CONTEUDO_INVALIDO', mensagem: 'Formato de conteúdo não suportado.' } });
    }
    const publico = erroPedidoPublico(erro);
    return res.status(ERROS_PEDIDO[publico.erro.codigo].status).json(publico);
};

export const criarLojaPedidoRouter = ({ service, sessaoService, obterConfiguracaoSessao, obterConfiguracaoPedido } = {}) => {
    const router = express.Router();
    const protecao = criarProtecaoLoja({ service: sessaoService, obterConfiguracao: obterConfiguracaoSessao });
    router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
    router.post('/', rateLimit({
        windowMs: 60_000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false,
        handler: (req, res) => res.status(429).json({ erro: { codigo: 'LIMITE_REQUISICOES', mensagem: 'Muitas requisições. Tente novamente em um minuto.' } })
    }), protecao.protegerEscritaLoja,
    (req, res, next) => {
        res.locals.chaveIdempotenciaLoja = validarChaveIdempotencia(req.get('Idempotency-Key'));
        next();
    }, express.json({ limit: '8kb' }), criarLojaPedidoController({ service, obterConfiguracao: obterConfiguracaoPedido }));
    router.use(tratarErroPedidoLoja);
    return router;
};
