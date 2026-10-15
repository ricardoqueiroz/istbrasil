import { carregarConfiguracaoLojaSessao } from '../config/lojaSessao.js';
import { CONTRATO_PEDIDO, criarErroPedido } from '../services/lojaPedidoContratos.js';
import { criarLojaSessaoService, criarTokenCsrf } from '../services/lojaSessaoService.js';
import { lerCookieLoja } from '../middlewares/lojaSessaoMiddleware.js';

export const criarLojaSessaoController = ({ service = criarLojaSessaoService(), obterConfiguracao = carregarConfiguracaoLojaSessao,
    agora = () => new Date() } = {}) => async (req, res) => {
    if (req.body === null || typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).length !== 0) {
        throw criarErroPedido('SOLICITACAO_INVALIDA');
    }
    const config = obterConfiguracao();
    const resultado = await service.estabelecerSessao(lerCookieLoja(req, config.cookie.nome));
    const csrf = criarTokenCsrf(resultado.token, config.segredoCsrf);
    if (resultado.nova) {
        const restante = Date.parse(resultado.sessao.expiraEm) - agora().getTime();
        const maxAge = Math.floor(Math.min(restante, CONTRATO_PEDIDO.sessaoDuracaoSegundos * 1000) / 1000) * 1000;
        if (!(maxAge > 0)) throw criarErroPedido('SESSAO_INVALIDA');
        const { nome, ...opcoes } = config.cookie;
        res.cookie(nome, resultado.token, { ...opcoes, maxAge });
    }
    // Reutilizacao NAO envia Set-Cookie nem renova Max-Age/expira_em.
    res.set('X-CSRF-Token', csrf);
    res.set('Cache-Control', 'no-store');
    res.status(resultado.nova ? 201 : 200).json({ sessao: { expiraEm: resultado.sessao.expiraEm } });
};
