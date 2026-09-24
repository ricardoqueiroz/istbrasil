import { pool as db } from '../config/db.js';

/**
 * Lista todos os eventos cadastrados para exibição na página de cards.
 * Ordena por eventos em destaque primeiro, e depois pela data de início mais recente.
 */
const listarEventos = async (req, res) => {
    try {
        const query = `
            SELECT 
                id,
                slug,
                nome,
                subtitulo,
                categoria,
                status,
                modalidade,
                resumo,
                imagem_card_url,
                banner_capa_url,
                data_inicio,
                data_fim,
                local_nome,
                cidade,
                estado,
                valor_inscricao,
                link_cta,
                texto_cta,
                destaque,
                criado_em
            FROM ist_eventos
            WHERE status != 'Rascunho'
            ORDER BY destaque DESC, data_inicio DESC
        `;

        const [eventos] = await db.query(query);

        return res.status(200).json(eventos);
    } catch (error) {
        console.error('Erro ao listar eventos:', error);
        return res.status(500).json({ 
            message: 'Erro ao carregar a lista de eventos.', 
            error: error.message 
        });
    }
};

/**
 * Obtém os detalhes completos de um evento pelo seu Slug.
 * Agrega as informações das tabelas filhas (etapas, documentos e programação).
 */
const obterEventoPorSlug = async (req, res) => {
    const slug = (req.params.slug || '').toString().trim();

    if (!slug) {
        return res.status(400).json({ message: 'Slug do evento não informado.' });
    }

    try {
        // 1. Busca os dados principais do evento
        const [eventos] = await db.query(
            'SELECT * FROM ist_eventos WHERE slug = ? AND status != "Rascunho"',
            [slug]
        );

        if (eventos.length === 0) {
            return res.status(404).json({ message: 'Evento não encontrado.' });
        }

        const evento = eventos[0];

        // 2. Busca as tabelas filhas em paralelo para otimizar o tempo de resposta
        const [
            [etapas],
            [documentos],
            [programacao]
        ] = await Promise.all([
            db.query(
                'SELECT * FROM ist_eventos_etapas WHERE evento_id = ? ORDER BY ordem ASC, data_inicio ASC', 
                [evento.id]
            ),
            db.query(
                'SELECT * FROM ist_eventos_documentos WHERE evento_id = ? ORDER BY ordem ASC', 
                [evento.id]
            ),
            db.query(
                'SELECT * FROM ist_eventos_programacao WHERE evento_id = ? ORDER BY ordem ASC, data_horario ASC', 
                [evento.id]
            )
        ]);

        // 3. Monta o objeto completo
        const eventoCompleto = {
            ...evento,
            etapas,
            documentos,
            programacao
        };

        return res.status(200).json(eventoCompleto);
    } catch (error) {
        console.error(`Erro ao obter evento (${slug}):`, error);
        return res.status(500).json({ 
            message: 'Erro ao carregar detalhes do evento.', 
            error: error.message 
        });
    }
};

export default {
    listarEventos,
    obterEventoPorSlug
};