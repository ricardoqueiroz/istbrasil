import express from 'express';
import { criarProcessadorWebhookPayPal } from '../services/lojaPaypalWebhook.js';

export const criarLojaPaypalWebhookRouter = opcoes => {
    const router = express.Router();
    const processar = criarProcessadorWebhookPayPal(opcoes);
    router.post('/', express.raw({ type: 'application/json', limit: '64kb', inflate: false }), async (req, res) => {
        res.set('Cache-Control', 'no-store');
        try { await processar({ corpo: req.body, cabecalhos: req.headers }); res.status(204).end(); }
        catch (e) { res.status(e.status ?? 503).json({ erro: { codigo: e.codigoWebhook ?? 'WEBHOOK_INDISPONIVEL' } }); }
    });
    router.use((e, req, res, next) => {
        if (res.headersSent) return next(e);
        res.set('Cache-Control', 'no-store').status(e.type === 'entity.too.large' ? 413 : 400).json({ erro: { codigo: 'WEBHOOK_INVALIDO' } });
    });
    return router;
};
