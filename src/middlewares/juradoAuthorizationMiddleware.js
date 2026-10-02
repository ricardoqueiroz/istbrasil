import {
    listarEventosAutorizadosJurado,
    obterEventoJuradoPorSlug
} from '../services/juradoAccessService.js';

export const autorizarJuradoEvento = async (req, res, next) => {
    const idUsuario = req.usuario?.id_usuario;
    if (!Number.isInteger(idUsuario) || idUsuario <= 0) {
        return res.status(401).json({ message: 'Não autenticado.' });
    }

    try {
        const evento = await obterEventoJuradoPorSlug(req.params.slug);
        if (!evento) {
            return res.status(404).json({ message: 'Evento não encontrado.' });
        }

        const acessos = await listarEventosAutorizadosJurado(idUsuario, evento.id);
        if (acessos.length === 0) {
            return res.status(403).json({ message: 'Acesso ao evento não autorizado.' });
        }

        req.eventoJurado = acessos[0];
        return next();
    } catch (error) {
        console.error('Erro ao autorizar jurado do evento:', error);
        return res.status(500).json({ message: 'Não foi possível validar o acesso ao evento.' });
    }
};