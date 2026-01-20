// Biografia do Patrono Sebastião Tapajós - Linha do Tempo - Controller 
import { pool as db } from '../config/db.js';

const getTimelineEvents = async (req, res) => {
    try {
        const page = parseInt(req.query.page, 10) || 1;
        const limit = parseInt(req.query.limit, 10) || 10;
        const offset = (page - 1) * limit;
        const finalQuery = `SELECT * FROM ist_vw_timeline LIMIT ? OFFSET ?`;
        const [rows] = await db.execute(finalQuery, [limit.toString(), offset.toString()]);
        res.status(200).json(rows);
    } catch (error) {
        console.error('Erro no TimelineController:', error);
        res.status(500).json({ 
            message: 'Erro ao buscar a linha do tempo do Patrono.',
            error: error.message 
        });
    }
};

export default {
    getTimelineEvents
};
