import express from 'express';
import { criarLojaSessaoService } from '../services/lojaSessaoService.js';
import { criarLojaSessaoController } from '../controllers/lojaSessaoController.js';
import { criarProtecaoLoja } from '../middlewares/lojaSessaoMiddleware.js';
import { ERROS_PEDIDO, erroPedidoPublico } from '../services/lojaPedidoContratos.js';

export const tratarErroSessaoLoja = (erro, req, res, next) => {
    if (res.headersSent) return next(erro);
    res.set('Cache-Control', 'no-store');
    if (erro.type === 'entity.parse.failed') return res.status(400).json({ erro: { codigo: 'JSON_INVALIDO', mensagem: 'JSON inválido.' } });
    if (erro.type === 'entity.too.large') return res.status(413).json({ erro: { codigo: 'CORPO_MUITO_GRANDE', mensagem: 'Requisição muito grande.' } });
    if (['charset.unsupported', 'encoding.unsupported'].includes(erro.type)) {
        return res.status(415).json({ erro: { codigo: 'CONTEUDO_INVALIDO', mensagem: 'Formato de conteúdo não suportado.' } });
    }
    const publico = erroPedidoPublico(erro);
    return res.status(ERROS_PEDIDO[publico.erro.codigo].status).json(publico);
};

export const criarLojaSessaoRouter = ({ service = criarLojaSessaoService(), obterConfiguracao, agora } = {}) => {
    const router = express.Router();
    const protecao = criarProtecaoLoja({ service, obterConfiguracao });
    router.post('/', protecao.validarRequisicaoLoja, express.json({ limit: '4kb' }),
        criarLojaSessaoController({ service, obterConfiguracao, agora }));
    router.use(tratarErroSessaoLoja);
    return router;
};
