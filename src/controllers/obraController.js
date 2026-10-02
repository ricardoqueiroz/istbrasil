// Relação de Obras Musicais do Patrono Sebastião Tapajós - Controller
import { pool as db } from '../config/db.js';
import { FESTIVAL_II } from '../config/festival.js';

const getAllObras = async (req, res) => {
    try {
        const page = parseInt(req.query.page, 10) || 1;
        const limit = parseInt(req.query.limit, 10) || 25;
        const offset = (page - 1) * limit;
        const search = req.query.search || '';
        const sortField = req.query.sortField;
        const sortOrder = req.query.sortOrder === '-1' ? 'DESC' : 'ASC';
        const allowedSortFields = ['titulo', 'data'];
        let orderByClause = 'ORDER BY titulo ASC';
        if (sortField && allowedSortFields.includes(sortField)) {
            orderByClause = `ORDER BY \`${sortField}\` ${sortOrder}`;
        }
        let whereClause = '';
        const searchParams = [];
        if (search) {
            whereClause = ' WHERE titulo LIKE ?';
            searchParams.push(`%${search}%`);
        }
        const countQuery = `SELECT COUNT(DISTINCT titulo) as total FROM ist_composicao ${whereClause}`;
        const [totalRows] = await db.execute(countQuery, searchParams);
        const total = totalRows[0].total;
        const dataQuery = `
            SELECT 
                DISTINCT titulo,
                iswc,
                DATE_FORMAT(data_inclusao, '%d-%m-%Y') AS \`data\`,
                partitura,
                link
            FROM ist_composicao
            ${whereClause}
            ${orderByClause}
            LIMIT ?
            OFFSET ?
        `;
        
        const dataParams = [...searchParams, String(limit), String(offset)];
        const [rows] = await db.execute(dataQuery, dataParams);

        res.status(200).json({
            total: total,
            page: page,
            limit: limit,
            data: rows
        });

    } catch (error) {
        console.error('Error in ObraController:', error);
        res.status(500).json({
            message: 'Error fetching obras.',
            error: error.message
        });
    }
};

const consultarObraPrincipal = async () => {
    const [rows] = await db.execute(
        `SELECT id_obra, titulo, partitura, propria
         FROM ist_composicao
         WHERE id_obra = ?`,
        [FESTIVAL_II.idObraPrincipal]
    );
    const obra = rows[0];

    if (!obra || Number(obra.id_obra) !== FESTIVAL_II.idObraPrincipal || Number(obra.propria) !== 1) {
        throw new Error('Obra principal do concorrente não encontrada ou inelegível.');
    }

    return {
        idObra: obra.id_obra,
        titulo: obra.titulo,
        partitura: obra.partitura
    };
};

const consultarComposicoesElegiveis = async () => {
    const [rows] = await db.execute(
                `SELECT c.id_obra, c.titulo, c.partitura
                 FROM ist_composicao c
                 INNER JOIN (
                         SELECT titulo, MIN(id_obra) AS id_obra
                         FROM ist_composicao
                         WHERE propria = 1
                             AND id_obra <> ?
                         GROUP BY titulo
                 ) escolhida ON escolhida.id_obra = c.id_obra
                 ORDER BY c.titulo`,
        [FESTIVAL_II.idObraPrincipal]
    );

    return rows.map((obra) => ({
        idObra: obra.id_obra,
        titulo: obra.titulo,
        partitura: obra.partitura
    }));
};

const getComposicoesElegiveis = async (_req, res) => {
    try {
        const obrasElegiveis = await consultarComposicoesElegiveis();

        return res.status(200).json(obrasElegiveis);
    } catch (error) {
        console.error('Error fetching eligible compositions:', error);
        return res.status(500).json({ error: 'Erro ao consultar composições elegíveis.' });
    }
};

const getParticipacaoConcorrente = async (_req, res) => {
    try {
        const [obraPrincipal, obrasElegiveis] = await Promise.all([
            consultarObraPrincipal(),
            consultarComposicoesElegiveis()
        ]);

        return res.status(200).json({ obraPrincipal, obrasElegiveis });
    } catch (error) {
        console.error('Error fetching competitor participation compositions:', error);
        return res.status(500).json({ error: 'Erro ao consultar obras da participação.' });
    }
};

export default {
    getAllObras,
    getComposicoesElegiveis,
    getParticipacaoConcorrente
};