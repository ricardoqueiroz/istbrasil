// Importe sua conexão com o banco de dados (ex: config/db.js)
// Estou assumindo o uso do mysql2 com promises, que é o padrão moderno.
const db = require('../config/db'); 

exports.getTimelineEvents = async (req, res) => {
    try {
        // 1. Recebe parâmetros de paginação (com valores padrão de segurança)
        // Se o usuário não enviar nada, assume página 1 e limite 10.
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        
        // 2. Calcula o OFFSET (quantos registros pular)
        const offset = (page - 1) * limit;

        // 3. Query Otimizada
        // A View 'ist_vw_timeline' já entrega o HTML do footer formatado e as datas tratadas.
        // O 'SQL_CALC_FOUND_ROWS' é opcional, mas útil se quiser saber o total de páginas no futuro.
        const query = `
            SELECT * FROM ist_vw_timeline 
            -- Reafirmamos a ordem para garantir estabilidade na paginação
            ORDER BY str_to_date(data_evento_original, '%Y-%m-%d') ASC 
            LIMIT ? OFFSET ?
        `;

        /**
         * NOTA TÉCNICA DO GUARDIÃO:
         * Como na View formatamos a data para exibição, a ordenação pode falhar se usarmos a string 'dd-mm-yyyy'.
         * Sugiro garantir que a View exporte também a data bruta (data_evento) para ordenação correta, 
         * ou confiar na ordem natural da inserção se a View já tiver 'ORDER BY'.
         * * Assumindo que a view ist_vw_timeline mantém a ordem definida na criação:
         */
        
        const finalQuery = `SELECT * FROM ist_vw_timeline LIMIT ? OFFSET ?`;

        // Executa a query passando os parâmetros (prevenção contra SQL Injection)
        const [rows] = await db.execute(finalQuery, [limit.toString(), offset.toString()]);
        
        // 4. Retorno Estruturado
        // Retornamos apenas o array de eventos, pois o 'infinite scroll' do front só precisa disso.
        res.status(200).json(rows);

    } catch (error) {
        console.error('Erro no TimelineController:', error);
        res.status(500).json({ 
            message: 'Erro ao buscar a linha do tempo do Patrono.',
            error: error.message 
        });
    }
};
