import { pool as db } from '../config/db.js';

export const autorizarTiposUsuario = (...tiposPermitidos) => async (req, res, next) => {
    const idUsuario = req.usuario?.id_usuario;

    if (!Number.isInteger(idUsuario) || idUsuario <= 0) {
        return res.status(401).json({ message: 'Não autenticado.' });
    }

    try {
        const [rows] = await db.query(
            'SELECT id_tipo_usuario FROM ist_usuarios WHERE id_usuario = ?',
            [idUsuario]
        );

        if (rows.length === 0) {
            return res.status(401).json({ message: 'Sessão inválida.' });
        }

        if (!tiposPermitidos.includes(Number(rows[0].id_tipo_usuario))) {
            return res.status(403).json({ message: 'Acesso administrativo não autorizado.' });
        }

        return next();
    } catch (error) {
        console.error('Erro ao autorizar tipo de usuário:', error);
        return res.status(500).json({ message: 'Não foi possível validar a autorização.' });
    }
};
