// Relação de Obras Musicais do Patrono Sebastião Tapajós - Controller
const { pool: db } = require('../config/db');

exports.getAllObras = async (req, res) => {
    try {
        const page = parseInt(req.query.page, 10) || 1;
        const limit = parseInt(req.query.limit, 10) || 25;
        const offset = (page - 1) * limit;
        const search = req.query.search || '';
        
        // Parâmetros de ordenação com validação
        const sortField = req.query.sortField;
        const sortOrder = req.query.sortOrder === '-1' ? 'DESC' : 'ASC';
        const allowedSortFields = ['titulo', 'data'];
        let orderByClause = 'ORDER BY titulo ASC'; // Ordenação padrão

        // Constrói a cláusula ORDER BY de forma segura
        if (sortField && allowedSortFields.includes(sortField)) {
            orderByClause = `ORDER BY \`${sortField}\` ${sortOrder}`;
        }

        let whereClause = '';
        const searchParams = [];
        if (search) {
            whereClause = ' WHERE titulo LIKE ?';
            searchParams.push(`%${search}%`);
        }

        // Query para contagem total de registros
        const countQuery = `SELECT COUNT(DISTINCT titulo) as total FROM ist_composicao ${whereClause}`;
        const [totalRows] = await db.execute(countQuery, searchParams);
        const total = totalRows[0].total;

        // Query para buscar os dados com paginação
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