import { pool as db } from '../config/db.js';
import sanitizeHtml from 'sanitize-html';
const publicar = p => ({ ...p, destaque: Number(p.destaque) === 1, resumo: sanitizeHtml(p.resumo || '', { allowedTags: [], allowedAttributes: {} }) });

/**
 * Lista todos os projetos cadastrados para exibição na página de cards.
 * Ordena por projetos em destaque primeiro, e depois pela data de início mais recente.
 */
const listarProjetos = async (req, res) => {
    try {
        const query = `
			SELECT
				p.id,
                p.id_tipicidade, p.id_tipologia,
				tc.tipicidade,
				tp.tipologia,
				p.slug,
				p.nome,
				p.subtitulo,
				p.status,
				p.resumo,
				p.imagem_card_url,
				p.banner_capa_url,
				p.data_inicio,
				p.data_fim,
				p.local_nome,
				p.cidade,
				p.estado,
				p.mecanismo,
				p.link_cta,
				p.texto_cta,
				p.destaque,
				p.criado_em
			FROM ist_projetos p
			INNER JOIN ist_projetos_tipicidade tc ON p.id_tipicidade = tc.id
			INNER JOIN ist_projetos_tipologia tp ON p.id_tipologia = tp.id AND tp.id_tipicidade = p.id_tipicidade
			WHERE p.status != 'Cancelado'
			ORDER BY p.destaque DESC, p.data_inicio DESC, p.id DESC
        `;

        const [projetos] = await db.query({ sql: query, dateStrings: true });

        return res.status(200).json(projetos.map(publicar));
    } catch (error) {
        console.error('Erro ao listar projetos:', error);
        return res.status(500).json({
            message: 'Erro ao carregar a lista de projetos.'
        });
    }
};

/**
 * Obtém os detalhes completos de um projeto pelo seu Slug.
 * Agrega as informações das tabelas filhas (etapas, documentos e programação).
 */
const obterProjetoPorSlug = async (req, res) => {
    const slug = req.params.slug;

    if (typeof slug !== 'string' || !slug.trim() || slug.length > 255 || /[\s/\\\u0000-\u001f\u007f]/u.test(slug)) {
        return res.status(400).json({ message: 'Slug do projeto não informado.' });
    }

    try {
        // 1. Busca os dados principais do projeto
        const [projetos] = await db.query(
            { dateStrings: true, sql: `SELECT p.*, tc.tipicidade, tp.tipologia FROM ist_projetos p
			 INNER JOIN ist_projetos_tipicidade tc ON p.id_tipicidade = tc.id
			 INNER JOIN ist_projetos_tipologia tp ON p.id_tipologia = tp.id AND tp.id_tipicidade = p.id_tipicidade
			 WHERE p.slug = ? AND p.status != 'Cancelado' ORDER BY p.id LIMIT 2` },
            [slug]
        );

        if (projetos.length === 0) {
            return res.status(404).json({ message: 'Projeto não encontrado.' });
        }

        if (projetos.length > 1) throw new Error('Slug duplicado no cadastro de projetos');
        const projeto = projetos[0];

        const [documentos] = await db.query({
            sql: 'SELECT * FROM ist_projetos_documentos WHERE projeto_id = ? ORDER BY ordem ASC, id ASC',
            dateStrings: true
        }, [projeto.id]);

        // 3. Monta o objeto completo
        const projetoCompleto = {
            ...publicar(projeto),
            documentos
        };

        return res.status(200).json(projetoCompleto);
    } catch (error) {
        console.error(`Erro ao obter projeto (${slug}):`, error);
        return res.status(500).json({
            message: 'Erro ao carregar detalhes do projeto.'
        });
    }
};

export default {
    listarProjetos,
    obterProjetoPorSlug
};
