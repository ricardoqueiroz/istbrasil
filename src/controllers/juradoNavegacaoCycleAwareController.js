import {
    listarAcessosJuradoCycleAware, obterEventoJuradoCycleAware,
    listarConcorrentesJuradoCycleAware, obterConcorrenteJuradoCycleAware,
    JuradoNavegacaoError, NAVEGACAO_ERROS
} from '../services/juradoNavegacaoCycleAwareService.js';
import { JulgamentoContextError, JULGAMENTO_ERROS } from '../services/julgamentoContextService.js';

const respostaInterna = { message: 'N\u00e3o foi poss\u00edvel consultar a navega\u00e7\u00e3o do jurado.' };
const errosNavegacao = new Map([
    [NAVEGACAO_ERROS.ENTRADA_INVALIDA, 400],
    [NAVEGACAO_ERROS.ACESSO_OPERACIONAL_NEGADO, 403],
    [NAVEGACAO_ERROS.CONCORRENTE_AUSENTE, 404]
]);
const errosContexto = new Map([
    [JULGAMENTO_ERROS.EVENTO_INEXISTENTE, 404],
    [JULGAMENTO_ERROS.JULGAMENTO_NAO_CONFIGURADO, 404],
    [JULGAMENTO_ERROS.CICLO_ATUAL_AUSENTE, 404],
    [JULGAMENTO_ERROS.CONCORRENTE_AUSENTE, 404],
    [JULGAMENTO_ERROS.CONCORRENTE_NAO_INCLUIDO, 404],
    [JULGAMENTO_ERROS.JURADO_FORA_ROSTER, 403],
    [JULGAMENTO_ERROS.JURADO_NAO_INCLUIDO, 403]
]);
const responderErro = (res, error) => {
    let status;
    if (error instanceof JuradoNavegacaoError) {
        status = errosNavegacao.get(error.code);
    } else if (error instanceof JulgamentoContextError) status = errosContexto.get(error.code);
    if (status) {
        const message = status === 400 ? 'Par\u00e2metros inv\u00e1lidos.'
            : status === 403 ? 'Acesso ao evento n\u00e3o autorizado.'
                : 'Recurso indispon\u00edvel neste contexto.';
        return res.status(status).json({ code: error.code, message });
    }
    console.error('Erro na navegacao HTTP cycle-aware do jurado.');
    return res.status(500).json(respostaInterna);
};
const inteiro = (value, padrao) => {
    if (value === undefined) return padrao;
    if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return null;
    const number = Number(value);
    return Number.isSafeInteger(number) ? number : null;
};

export const criarJuradoNavegacaoControllers = ({
    acessos = listarAcessosJuradoCycleAware,
    evento = obterEventoJuradoCycleAware,
    fila = listarConcorrentesJuradoCycleAware,
    detalhe = obterConcorrenteJuradoCycleAware
} = {}) => {
    const executar = operation => async (req, res) => {
        try { return res.status(200).json(await operation(req)); }
        catch (error) { return responderErro(res, error); }
    };
    // Slug vem do evento autorizado; o service revalida live + snapshot em sua propria transacao.
    // Cidade/UF/dataInscricao nao sao snapshots: nao completar DTO nem ordenar por dados live.
    return {
        listarAcessosJurado: executar(req => acessos(req.usuario.id_usuario)),
        obterEventoJurado: executar(req => evento(req.eventoJurado.slug, req.usuario.id_usuario)),
        listarConcorrentesJurado: async (req, res) => {
            const page = inteiro(req.query.page, 1), limit = inteiro(req.query.limit, 25);
            const sort = req.query.sort ?? 'numeroConcorrente', order = req.query.order ?? 'asc';
            if (!page || !limit || limit > 100 || !Number.isSafeInteger((page - 1) * limit)
                || !['numeroConcorrente', 'nome'].includes(sort) || !['asc', 'desc'].includes(order)) {
                return res.status(400).json({ message: 'Par\u00e2metros de fila inv\u00e1lidos.' });
            }
            try {
                return res.status(200).json(await fila(req.eventoJurado.slug, req.usuario.id_usuario, { page, limit, sort, order }));
            } catch (error) { return responderErro(res, error); }
        },
        obterConcorrenteJurado: async (req, res) => {
            const id = inteiro(req.params.idParticipacao);
            if (!id || id > 4294967295) return res.status(400).json({ message: 'Participa\u00e7\u00e3o inv\u00e1lida.' });
            try { return res.status(200).json(await detalhe(req.eventoJurado.slug, id, req.usuario.id_usuario)); }
            catch (error) { return responderErro(res, error); }
        }
    };
};
