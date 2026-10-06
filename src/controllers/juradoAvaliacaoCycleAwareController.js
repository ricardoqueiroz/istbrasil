import {
    salvarAvaliacaoJuradoCycleAware, JuradoAvaliacaoGravacaoError, GRAVACAO_ERROS
} from '../services/juradoAvaliacaoGravacaoService.js';
import { JulgamentoContextError, JULGAMENTO_ERROS } from '../services/julgamentoContextService.js';

const UINT_MAX = 4294967295;
const respostaInterna = { message: 'N\u00e3o foi poss\u00edvel concluir a opera\u00e7\u00e3o de avalia\u00e7\u00e3o.' };
const errosWriter = new Map([
    [GRAVACAO_ERROS.PAYLOAD_INVALIDO, [400, 'Dados de avalia\u00e7\u00e3o inv\u00e1lidos.']],
    [GRAVACAO_ERROS.ACESSO_OPERACIONAL_NEGADO, [403, 'Acesso ao evento n\u00e3o autorizado.']],
    [GRAVACAO_ERROS.CICLO_DESATUALIZADO, [409, 'Ciclo alterado. Consulte novamente.']],
    [GRAVACAO_ERROS.TENTATIVA_DESATUALIZADA, [409, 'Tentativa alterada. Consulte novamente.']],
    [GRAVACAO_ERROS.VERSAO_DESATUALIZADA, [409, 'A avalia\u00e7\u00e3o foi alterada. Consulte novamente.']],
    [GRAVACAO_ERROS.AVALIACAO_CONCLUIDA, [409, 'Avalia\u00e7\u00e3o conclu\u00edda n\u00e3o pode ser alterada.']],
    [GRAVACAO_ERROS.CONTEXTO_NAO_GRAVAVEL, [409, 'Contexto n\u00e3o permite grava\u00e7\u00e3o. Consulte novamente.']],
    [GRAVACAO_ERROS.CONFLITO_CONCORRENCIA, [409, 'Conflito de avalia\u00e7\u00e3o. Consulte novamente.']]
]);
const errosContexto = new Map([
    [JULGAMENTO_ERROS.EVENTO_INEXISTENTE, [404, 'Evento n\u00e3o encontrado.']],
    [JULGAMENTO_ERROS.CONCORRENTE_AUSENTE, [404, 'Participa\u00e7\u00e3o indispon\u00edvel neste contexto.']],
    [JULGAMENTO_ERROS.JURADO_FORA_ROSTER, [403, 'Acesso ao evento n\u00e3o autorizado.']],
    [JULGAMENTO_ERROS.JURADO_NAO_INCLUIDO, [403, 'Acesso ao evento n\u00e3o autorizado.']],
    [JULGAMENTO_ERROS.CONCORRENTE_NAO_INCLUIDO, [409, 'Participa\u00e7\u00e3o n\u00e3o permite grava\u00e7\u00e3o. Consulte novamente.']]
]);

const responderErro = (res, error) => {
    let resposta;
    if (error instanceof JuradoAvaliacaoGravacaoError) {
        resposta = errosWriter.get(error.code);
        if (error.code === GRAVACAO_ERROS.CONTEXTO_NAO_GRAVAVEL
            && error.details?.motivo === JULGAMENTO_ERROS.JURADO_NAO_INCLUIDO) {
            resposta = [403, 'Acesso ao evento n\u00e3o autorizado.'];
        }
    } else if (error instanceof JulgamentoContextError) {
        resposta = errosContexto.get(error.code);
    }
    if (resposta) {
        const [status, message] = resposta;
        return res.status(status).json({ code: error.code, message });
    }
    // Uma falha do logger nao deve substituir a resposta neutra de infraestrutura.
    try { console.error('Erro na operacao HTTP preparada de avaliacao cycle-aware.'); } catch {}
    return res.status(500).json(respostaInterna);
};

// Preparado, nao roteado. Autenticacao e resolucao do evento pertencem aos middlewares.
export const criarSalvarAvaliacaoJuradoCycleAwareController = ({
    salvarAvaliacao = salvarAvaliacaoJuradoCycleAware
} = {}) => async (req, res) => {
    const valor = req.params.idParticipacao;
    const idParticipacao = typeof valor === 'string' && /^[1-9]\d*$/.test(valor) ? Number(valor) : NaN;
    if (!Number.isSafeInteger(idParticipacao) || idParticipacao > UINT_MAX) {
        return res.status(400).json({ message: 'Participa\u00e7\u00e3o inv\u00e1lida.' });
    }
    try {
        const dto = await salvarAvaliacao(req.eventoJurado, idParticipacao, req.usuario.id_usuario, req.body);
        return res.status(200).json(dto);
    } catch (error) {
        return responderErro(res, error);
    }
};

export const salvarAvaliacaoJuradoCycleAwareController = criarSalvarAvaliacaoJuradoCycleAwareController();
