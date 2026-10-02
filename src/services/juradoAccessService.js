import { pool as db } from '../config/db.js';

export const obterEventoJuradoPorSlug = async (slug, executor = db) => {
    const [rows] = await executor.query(
        'SELECT id, slug, nome FROM ist_eventos WHERE slug = ?',
        [slug]
    );
    return rows[0] || null;
};

export const listarEventosAutorizadosJurado = async (idUsuario, idEvento, executor = db) => {
    const filtroEvento = idEvento === undefined ? '' : 'AND e.id = ?';
    const params = [idUsuario, 4, 8, 11, 1];
    if (idEvento !== undefined) params.push(idEvento);

    const [rows] = await executor.query(
        `SELECT e.id, e.slug, e.nome
         FROM ist_usuarios u
         INNER JOIN ist_eventos_jurados j ON j.id_usuario = u.id_usuario
         INNER JOIN ist_eventos e ON e.id = j.id_evento
         WHERE u.id_usuario = ?
           AND u.id_tipo_usuario = ?
           AND u.id_situacao = ?
           AND u.id_cargo = ?
           AND j.ativo = ?
           ${filtroEvento}
         ORDER BY e.nome, e.id`,
        params
    );

    return rows.map((evento) => ({ id: evento.id, slug: evento.slug, nome: evento.nome }));
};