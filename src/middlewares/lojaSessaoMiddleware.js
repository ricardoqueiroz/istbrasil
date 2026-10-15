import { carregarConfiguracaoLojaSessao } from '../config/lojaSessao.js';
import { criarErroPedido } from '../services/lojaPedidoContratos.js';
import { criarLojaSessaoService, csrfValido } from '../services/lojaSessaoService.js';

export const lerCookieLoja = (req, nome) => {
    // O token usa apenas caracteres seguros de base64url, sem URI/JSON decoding.
    // Rejeitar cookies duplicados evita selecionar um valor de Path ambiguo.
    if (typeof req.headers.cookie !== 'string') return undefined;
    const valores = req.headers.cookie.split(';').map((parte) => parte.trim()).filter((parte) => parte.startsWith(nome + '='));
    return valores.length === 1 ? valores[0].slice(nome.length + 1) : undefined;
};

export const criarProtecaoLoja = ({ service = criarLojaSessaoService(), obterConfiguracao = carregarConfiguracaoLojaSessao } = {}) => {
    const validar = (req, res) => {
        res.set('Cache-Control', 'no-store');
        const config = obterConfiguracao();
        if (!config.origens.includes(req.get('Origin'))) throw criarErroPedido('ORIGEM_INVALIDA');
        if (req.get('X-IST-Loja') !== '1') throw criarErroPedido('CSRF_INVALIDO');
        if (!req.is('application/json') || Object.keys(req.query).length !== 0) throw criarErroPedido('SOLICITACAO_INVALIDA');
        return config;
    };
    return {
        validarRequisicaoLoja: (req, res, next) => { validar(req, res); next(); },
        protegerEscritaLoja: async (req, res, next) => {
            const config = validar(req, res);
            const token = lerCookieLoja(req, config.cookie.nome);
            const sessao = await service.obterSessao(token);
            if (!csrfValido(req.get('X-CSRF-Token'), token, config.segredoCsrf)) throw criarErroPedido('CSRF_INVALIDO');
            // Somente metadados internos; nenhum segredo no contexto publico.
            res.locals.sessaoLoja = sessao;
            next();
        }
    };
};
