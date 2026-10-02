import { pool as db } from '../config/db.js';

export const resolverEventoPorSlug = async (slug, executor = db) => {
    const [eventos] = await executor.query(
        'SELECT id, slug, status FROM ist_eventos WHERE slug = ?',
        [slug]
    );
    const evento = eventos[0];
    if (!evento || !Number.isInteger(Number(evento.id)) || Number(evento.id) <= 0
        || evento.slug !== slug || ['Rascunho', 'Cancelado'].includes(evento.status)) {
        throw new Error(`Evento indisponível para participação: ${slug}`);
    }
    return evento;
};