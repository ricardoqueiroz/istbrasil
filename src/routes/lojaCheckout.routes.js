import express from 'express';
import { rateLimit } from 'express-rate-limit';
import { criarProtecaoLoja } from '../middlewares/lojaSessaoMiddleware.js';
import { camposExatos, erroPagamento, erroPagamentoPublico, uuidPagamento } from '../services/lojaPagamentoContratos.js';
import { erroPedidoPublico, ERROS_PEDIDO } from '../services/lojaPedidoContratos.js';

// A unica autoridade do comprador e a sessao validada pelo middleware da Loja.
export const criarLojaCheckoutRouter = ({ obterFinanceiro, env = process.env, sessaoService, obterConfiguracaoSessao } = {}) => {
    const router = express.Router();
    const protecao = criarProtecaoLoja({ service: sessaoService, obterConfiguracao: obterConfiguracaoSessao });
    router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
    router.use(rateLimit({ windowMs: 60000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false,
        handler: (req, res) => res.status(429).json({ erro: { codigo: 'LIMITE_REQUISICOES', mensagem: 'Aguarde um minuto antes de tentar novamente.' } }) }));
    router.use(protecao.protegerEscritaLoja, express.json({ limit: '8kb' }));
    router.post('/configuracao', (req, res) => {
        if (!req.body || Object.keys(req.body).length || Array.isArray(req.body)) throw erroPagamento('SOLICITACAO_INVALIDA');
        if (env.IST_LOJA_PAYPAL_ENV !== 'sandbox' || !/^[A-Za-z0-9_-]{1,2048}$/.test(env.IST_LOJA_PAYPAL_CLIENT_ID ?? '')) {
            throw erroPagamento('CONFIGURACAO_INVALIDA');
        }
        obterFinanceiro(); // Falhar antes de oferecer checkout se a composicao nao estiver configurada.
        // Identificador PUBLICO do SDK, nunca o Client Secret ou o token OAuth.
        res.json({ ambiente: 'sandbox', clientId: env.IST_LOJA_PAYPAL_CLIENT_ID });
    });
    router.post('/iniciar', async (req, res) => {
        const entrada = camposExatos(req.body, ['pedidoPublicId']);
        const chave = uuidPagamento(req.get('Idempotency-Key'));
        const { service } = obterFinanceiro();
        await service.criarTentativa(res.locals.sessaoLoja, entrada, chave);
        res.json(await service.consultarCheckout(res.locals.sessaoLoja, entrada));
    });
    router.post('/estado', async (req, res) => {
        const entrada = camposExatos(req.body, ['pedidoPublicId']);
        res.json(await obterFinanceiro().service.consultarCheckout(res.locals.sessaoLoja, entrada));
    });
    for (const acao of ['capturar', 'reconciliar']) router.post(`/${acao}`, async (req, res) => {
        const entrada = camposExatos(req.body, ['pagamentoPublicId']);
        const chave = acao === 'capturar' ? uuidPagamento(req.get('Idempotency-Key')) : undefined;
        res.json(await obterFinanceiro().service[acao](res.locals.sessaoLoja, entrada, chave));
    });
    router.use((e, req, res, next) => {
        if (res.headersSent) return next(e);
        if (e.type) return res.status(e.type === 'entity.too.large' ? 413 : 400).json({ erro: { codigo: 'SOLICITACAO_INVALIDA', mensagem: 'Requisicao invalida.' } });
        if (e.name === 'ErroPedido' && Object.hasOwn(ERROS_PEDIDO, e.codigo)) {
            const publico = erroPedidoPublico(e); return res.status(ERROS_PEDIDO[publico.erro.codigo].status).json(publico);
        }
        const publico = erroPagamentoPublico(e);
        res.status(erroPagamento(publico.erro.codigo).status).json(publico);
    });
    return router;
};
