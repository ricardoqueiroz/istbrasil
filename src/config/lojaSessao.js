import { criarErroPedido } from '../services/lojaPedidoContratos.js';

// Usado somente pelos endpoints novos. Nunca derivar cookies/origens de Host,
// X-Forwarded-Proto, Origin ou outros valores recebidos do navegador.
export const criarConfiguracaoLojaSessao = ({ producao = false, origens, segredoCsrf } = {}) => {
    if (typeof producao !== 'boolean' || !Array.isArray(origens) || origens.length === 0
        || !Buffer.isBuffer(segredoCsrf) || segredoCsrf.length !== 32) throw criarErroPedido('ERRO_INTERNO');
    for (const origem of origens) {
        let url;
        try { url = new URL(origem); } catch { throw criarErroPedido('ERRO_INTERNO'); }
        if (typeof origem !== 'string' || url.origin !== origem || url.username || url.password
            || !['http:', 'https:'].includes(url.protocol)
            || (producao && url.protocol !== 'https:')
            || (!producao && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
            throw criarErroPedido('ERRO_INTERNO');
        }
    }
    return Object.freeze({
        origens: Object.freeze([...new Set(origens)]),
        segredoCsrf: Buffer.from(segredoCsrf),
        cookie: Object.freeze({ nome: producao ? '__Host-ist-loja' : 'ist-loja-dev',
            httpOnly: true, secure: producao, sameSite: 'lax', path: '/' })
    });
};

export const carregarConfiguracaoLojaSessao = (env = process.env) => {
    if (env.NODE_ENV !== undefined && !['development', 'test', 'production'].includes(env.NODE_ENV)) {
        throw criarErroPedido('ERRO_INTERNO');
    }
    const producao = env.NODE_ENV === 'production';
    const origemTexto = env.LOJA_ORIGENS_PERMITIDAS ?? (producao ? '' : 'http://localhost:4200');
    const segredoTexto = env.LOJA_CSRF_SECRET;
    if (typeof segredoTexto !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(segredoTexto)) throw criarErroPedido('ERRO_INTERNO');
    const segredoCsrf = Buffer.from(segredoTexto, 'base64url');
    if (segredoCsrf.toString('base64url') !== segredoTexto || typeof origemTexto !== 'string') throw criarErroPedido('ERRO_INTERNO');
    return criarConfiguracaoLojaSessao({ producao, origens: origemTexto.split(',').map((s) => s.trim()), segredoCsrf });
};
