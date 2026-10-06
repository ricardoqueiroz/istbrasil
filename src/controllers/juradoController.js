import { criarJuradoNavegacaoControllers } from './juradoNavegacaoCycleAwareController.js';
import { JuradoAvaliacaoError, obterAvaliacaoJurado as consultarAvaliacao, salvarAvaliacaoJurado as persistirAvaliacao } from '../services/juradoAvaliacaoService.js';

export const {
    listarAcessosJurado, obterEventoJurado, listarConcorrentesJurado, obterConcorrenteJurado
} = criarJuradoNavegacaoControllers();

const inteiroPositivo = (valor, padrao) => {
    if (valor === undefined) return padrao;
    if (typeof valor !== 'string' || !/^[1-9]\d*$/.test(valor)) return null;
    const numero = Number(valor);
    return Number.isSafeInteger(numero) ? numero : null;
};

const responderErroAvaliacao = (res, error) => {
    if (error instanceof JuradoAvaliacaoError) return res.status(error.status).json({ message: error.message });
    console.error('Erro na avalia\u00e7\u00e3o de jurado:', error);
    return res.status(500).json({ message: 'N\u00e3o foi poss\u00edvel concluir a opera\u00e7\u00e3o de avalia\u00e7\u00e3o.' });
};

export const obterAvaliacaoJurado = async (req, res) => {
    const idParticipacao = inteiroPositivo(req.params.idParticipacao);
    if (!idParticipacao) return res.status(400).json({ message: 'Participa\u00e7\u00e3o inv\u00e1lida.' });
    try {
        return res.status(200).json(await consultarAvaliacao(req.eventoJurado, idParticipacao, req.usuario.id_usuario));
    } catch (error) {
        return responderErroAvaliacao(res, error);
    }
};

export const salvarAvaliacaoJurado = async (req, res) => {
    const idParticipacao = inteiroPositivo(req.params.idParticipacao);
    if (!idParticipacao) return res.status(400).json({ message: 'Participa\u00e7\u00e3o inv\u00e1lida.' });
    try {
        return res.status(200).json(await persistirAvaliacao(req.eventoJurado, idParticipacao, req.usuario.id_usuario, req.body));
    } catch (error) {
        return responderErroAvaliacao(res, error);
    }
};