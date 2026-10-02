import { listarEventosAutorizadosJurado } from '../services/juradoAccessService.js';

export const listarAcessosJurado = async (req, res) => {
    try {
        const eventos = await listarEventosAutorizadosJurado(req.usuario.id_usuario);
        return res.status(200).json({ eventos });
    } catch (error) {
        console.error('Erro ao consultar acessos de jurado:', error);
        return res.status(500).json({ message: 'Não foi possível consultar os acessos.' });
    }
};

export const obterEventoJurado = (req, res) => {
    return res.status(200).json({ evento: req.eventoJurado });
};