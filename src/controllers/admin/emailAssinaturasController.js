import { pool as db } from '../../config/db.js';
import { sanitizeEmailHtml } from '../../services/emailHtmlSanitizer.js';

const CAMPOS_PERMITIDOS = new Set(['nome', 'conteudo_html', 'ativo']);
const LIMITE_HTML_BYTES = 100 * 1024;

const respostaAssinatura = (assinatura) => ({
    idAssinatura: assinatura.id_assinatura,
    nome: assinatura.nome,
    conteudoHtml: assinatura.conteudo_html,
    ativo: Boolean(assinatura.ativo),
    criadoPor: assinatura.criado_por,
    atualizadoPor: assinatura.atualizado_por,
    dataCadastro: assinatura.data_cadastro,
    dataAtualizacao: assinatura.data_atualizacao
});

const validarId = (valor) => {
    const id = Number(valor);
    return Number.isInteger(id) && id > 0 ? id : null;
};

const normalizarAtivo = (valor) => {
    if (valor === true || valor === 1) {
        return 1;
    }
    if (valor === false || valor === 0) {
        return 0;
    }
    return null;
};

const prepararPayload = (body) => {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return { error: 'Payload de assinatura inválido.' };
    }

    if (Object.keys(body).some((campo) => !CAMPOS_PERMITIDOS.has(campo))) {
        return { error: 'Payload de assinatura inválido.' };
    }

    if (typeof body.nome !== 'string' || typeof body.conteudo_html !== 'string' || !Object.prototype.hasOwnProperty.call(body, 'ativo')) {
        return { error: 'Nome, conteúdo HTML e status são obrigatórios.' };
    }

    const nome = body.nome.trim();
    const htmlOriginal = body.conteudo_html.trim();
    const ativo = normalizarAtivo(body.ativo);

    if (!nome || nome.length > 150) {
        return { error: 'O nome deve ter entre 1 e 150 caracteres.' };
    }

    if (!htmlOriginal || Buffer.byteLength(htmlOriginal, 'utf8') > LIMITE_HTML_BYTES) {
        return { error: 'O conteúdo HTML deve ter entre 1 e 100 KB.' };
    }

    if (ativo === null) {
        return { error: 'O campo ativo deve ser booleano ou 0/1.' };
    }

    const conteudoHtml = sanitizeEmailHtml(htmlOriginal).trim();
    if (!conteudoHtml) {
        return { error: 'O conteúdo HTML não possui conteúdo permitido.' };
    }

    return { data: { nome, conteudoHtml, ativo } };
};

const buscarPorId = async (idModelo) => {
    const [rows] = await db.query(
        `SELECT id_assinatura, nome, conteudo_html, ativo, criado_por, atualizado_por,
                data_cadastro, data_atualizacao
         FROM ist_email_assinaturas
         WHERE id_assinatura = ?`,
        [idModelo]
    );
    return rows[0] || null;
};

export const listarAssinaturas = async (_req, res) => {
    try {
        const [rows] = await db.query(
            `SELECT id_assinatura, nome, conteudo_html, ativo, criado_por, atualizado_por,
                    data_cadastro, data_atualizacao
             FROM ist_email_assinaturas
             ORDER BY nome ASC, id_assinatura ASC`
        );

        return res.status(200).json(rows.map(respostaAssinatura));
    } catch (error) {
        console.error('Erro ao listar assinaturas de e-mail:', error);
        return res.status(500).json({ message: 'Erro ao carregar assinaturas.' });
    }
};

export const obterAssinatura = async (req, res) => {
    const idAssinatura = validarId(req.params.id);
    if (!idAssinatura) {
        return res.status(400).json({ message: 'ID de assinatura inválido.' });
    }

    try {
        const assinatura = await buscarPorId(idAssinatura);
        if (!assinatura) {
            return res.status(404).json({ message: 'Assinatura não encontrada.' });
        }

        return res.status(200).json(respostaAssinatura(assinatura));
    } catch (error) {
        console.error('Erro ao obter assinatura de e-mail:', error);
        return res.status(500).json({ message: 'Erro ao carregar assinatura.' });
    }
};

export const criarAssinatura = async (req, res) => {
    const payload = prepararPayload(req.body);
    if (payload.error) {
        return res.status(400).json({ message: payload.error });
    }

    try {
        const [result] = await db.query(
            `INSERT INTO ist_email_assinaturas
                (nome, conteudo_html, ativo, criado_por, atualizado_por)
             VALUES (?, ?, ?, ?, NULL)`,
            [payload.data.nome, payload.data.conteudoHtml, payload.data.ativo, req.usuario.id_usuario]
        );

        const assinatura = await buscarPorId(result.insertId);
        return res.status(201).json(respostaAssinatura(assinatura));
    } catch (error) {
        console.error('Erro ao criar assinatura de e-mail:', error);
        return res.status(500).json({ message: 'Erro ao criar assinatura.' });
    }
};

export const atualizarAssinatura = async (req, res) => {
    const idAssinatura = validarId(req.params.id);
    if (!idAssinatura) {
        return res.status(400).json({ message: 'ID de assinatura inválido.' });
    }

    const payload = prepararPayload(req.body);
    if (payload.error) {
        return res.status(400).json({ message: payload.error });
    }

    try {
        const assinaturaAtual = await buscarPorId(idAssinatura);
        if (!assinaturaAtual) {
            return res.status(404).json({ message: 'Assinatura não encontrada.' });
        }

        await db.query(
            `UPDATE ist_email_assinaturas
             SET nome = ?, conteudo_html = ?, ativo = ?, atualizado_por = ?
             WHERE id_assinatura = ?`,
            [payload.data.nome, payload.data.conteudoHtml, payload.data.ativo, req.usuario.id_usuario, idAssinatura]
        );

        const assinatura = await buscarPorId(idAssinatura);
        return res.status(200).json(respostaAssinatura(assinatura));
    } catch (error) {
        console.error('Erro ao atualizar assinatura de e-mail:', error);
        return res.status(500).json({ message: 'Erro ao atualizar assinatura.' });
    }
};
