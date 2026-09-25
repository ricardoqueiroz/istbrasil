import jwt from 'jsonwebtoken';

const COOKIE_NAME = process.env.COOKIE_NAME || 'ist_session';
const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-insecure-secret';

export const autenticarUsuario = (req, res, next) => {
    const token = req.cookies?.[COOKIE_NAME];

    if (!token) {
        return res.status(401).json({ message: 'Não autenticado.' });
    }

    try {
        const payload = jwt.verify(token, JWT_SECRET);
        const idUsuario = Number(payload.id_usuario);
        const idTipoUsuario = Number(payload.id_tipo_usuario);

        if (!Number.isInteger(idUsuario) || idUsuario <= 0 || !Number.isInteger(idTipoUsuario) || idTipoUsuario <= 0) {
            return res.status(401).json({ message: 'Não autenticado.' });
        }

        req.usuario = {
            id_usuario: idUsuario,
            id_tipo_usuario: idTipoUsuario
        };

        return next();
    } catch {
        return res.status(401).json({ message: 'Não autenticado.' });
    }
};