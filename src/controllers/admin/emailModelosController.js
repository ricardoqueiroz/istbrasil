import { pool as db } from '../../config/db.js';
import { sanitizeEmailHtml } from '../../services/emailHtmlSanitizer.js';

const CAMPOS_POST = new Set(['chave', 'nome', 'assunto', 'conteudo_html', 'id_assinatura', 'ativo']);
const CAMPOS_PUT = new Set(['nome', 'assunto', 'conteudo_html', 'id_assinatura', 'ativo']);
const REGEX_CHAVE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const LIMITE_HTML_BYTES = 100 * 1024;

const validarId = (valor) => {
    const id = Number(valor);
    return Number.isInteger(id) && id > 0 ? id : null;
};

const normalizarAtivo = (valor) => {
    if (valor === true || valor === 1) return 1;
    if (valor === false || valor === 0) return 0;
    return null;
};

const normalizarIdAssinatura = (valor) => {
    if (valor === null || valor === undefined) return { data: null };
    const id = validarId(valor);
    return id ? { data: id } : { error: 'O ID da assinatura deve ser nulo ou um inteiro positivo.' };
};

const prepararPayload = (body, permitirChave) => {
    const camposPermitidos = permitirChave ? CAMPOS_POST : CAMPOS_PUT;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return { error: 'Payload de modelo inválido.' };
    }

    if (Object.keys(body).some((campo) => !camposPermitidos.has(campo))) {
        return { error: 'Payload de modelo inválido.' };
    }

    const obrigatorios = permitirChave
        ? ['chave', 'nome', 'assunto', 'conteudo_html', 'ativo']
        : ['nome', 'assunto', 'conteudo_html', 'ativo'];
    if (obrigatorios.some((campo) => !Object.prototype.hasOwnProperty.call(body, campo))) {
        return { error: 'Chave, nome, assunto, conteúdo HTML e status são obrigatórios.' };
    }

    if ((permitirChave && typeof body.chave !== 'string') || typeof body.nome !== 'string' || typeof body.assunto !== 'string' || typeof body.conteudo_html !== 'string') {
        return { error: 'Chave, nome, assunto e conteúdo HTML devem ser textos.' };
    }

    const chave = permitirChave ? body.chave.trim().toLowerCase() : undefined;
    const nome = body.nome.trim();
    const assunto = body.assunto.trim();
    const htmlOriginal = body.conteudo_html;
    const htmlParaSanitizar = htmlOriginal.trim();
    const ativo = normalizarAtivo(body.ativo);
    const assinatura = normalizarIdAssinatura(body.id_assinatura);

    if (permitirChave && (!chave || chave.length > 100 || !REGEX_CHAVE.test(chave))) {
        return { error: 'A chave deve seguir o formato técnico permitido e ter no máximo 100 caracteres.' };
    }
    if (!nome || nome.length > 150) return { error: 'O nome deve ter entre 1 e 150 caracteres.' };
    if (!assunto || assunto.length > 255) return { error: 'O assunto deve ter entre 1 e 255 caracteres.' };
    if (!htmlParaSanitizar || Buffer.byteLength(htmlOriginal, 'utf8') > LIMITE_HTML_BYTES) {
        return { error: 'O conteúdo HTML deve ter entre 1 e 100 KB.' };
    }
    if (ativo === null) return { error: 'O campo ativo deve ser booleano ou 0/1.' };
    if (assinatura.error) return assinatura;

    const conteudoHtml = sanitizeEmailHtml(htmlParaSanitizar).trim();
    if (!conteudoHtml) return { error: 'O conteúdo HTML não possui conteúdo permitido.' };

    return {
        data: {
            ...(permitirChave ? { chave } : {}),
            nome,
            assunto,
            conteudoHtml,
            idAssinatura: assinatura.data,
            ativo
        }
    };
};

const buscarPorId = async (idModelo) => {
    const [rows] = await db.query(
        `SELECT m.id_modelo, m.chave, m.nome, m.assunto, m.conteudo_html,
                m.id_assinatura, m.ativo, m.criado_por, m.atualizado_por,
                m.data_cadastro, m.data_atualizacao,
                a.nome AS nome_assinatura, a.ativo AS assinatura_ativa
         FROM ist_email_modelos m
         LEFT JOIN ist_email_assinaturas a ON a.id_assinatura = m.id_assinatura
         WHERE m.id_modelo = ?`,
        [idModelo]
    );
    return rows[0] || null;
};

const respostaModelo = (modelo) => ({
    idModelo: modelo.id_modelo,
    chave: modelo.chave,
    nome: modelo.nome,
    assunto: modelo.assunto,
    conteudoHtml: modelo.conteudo_html,
    idAssinatura: modelo.id_assinatura,
    nomeAssinatura: modelo.nome_assinatura || null,
    assinaturaAtiva: modelo.assinatura_ativa === null || modelo.assinatura_ativa === undefined ? null : Boolean(modelo.assinatura_ativa),
    ativo: Boolean(modelo.ativo),
    criadoPor: modelo.criado_por,
    atualizadoPor: modelo.atualizado_por,
    dataCadastro: modelo.data_cadastro,
    dataAtualizacao: modelo.data_atualizacao
});

const assinaturaExiste = async (idAssinatura) => {
    if (idAssinatura === null) return true;
    const [rows] = await db.query('SELECT id_assinatura FROM ist_email_assinaturas WHERE id_assinatura = ?', [idAssinatura]);
    return rows.length > 0;
};

const tratarErroBanco = (error, res, acao) => {
    console.error(`Erro ao ${acao} modelo de e-mail:`, error);
    if (error?.code === 'ER_DUP_ENTRY') return res.status(409).json({ message: 'Já existe um modelo com esta chave.' });
    return res.status(500).json({ message: `Erro ao ${acao} modelo.` });
};

export const listarModelos = async (_req, res) => {
    try {
        const [rows] = await db.query(
            `SELECT m.id_modelo, m.chave, m.nome, m.assunto, m.conteudo_html,
                    m.id_assinatura, m.ativo, m.criado_por, m.atualizado_por,
                    m.data_cadastro, m.data_atualizacao,
                    a.nome AS nome_assinatura, a.ativo AS assinatura_ativa
             FROM ist_email_modelos m
             LEFT JOIN ist_email_assinaturas a ON a.id_assinatura = m.id_assinatura
             ORDER BY m.nome ASC, m.id_modelo ASC`
        );
        return res.status(200).json(rows.map(respostaModelo));
    } catch (error) {
        return tratarErroBanco(error, res, 'listar');
    }
};

export const obterModelo = async (req, res) => {
    const idModelo = validarId(req.params.id);
    if (!idModelo) return res.status(400).json({ message: 'ID de modelo inválido.' });

    try {
        const modelo = await buscarPorId(idModelo);
        if (!modelo) return res.status(404).json({ message: 'Modelo não encontrado.' });
        return res.status(200).json(respostaModelo(modelo));
    } catch (error) {
        return tratarErroBanco(error, res, 'carregar');
    }
};

export const criarModelo = async (req, res) => {
    const payload = prepararPayload(req.body, true);
    if (payload.error) return res.status(400).json({ message: payload.error });

    try {
        if (!(await assinaturaExiste(payload.data.idAssinatura))) {
            return res.status(400).json({ message: 'Assinatura não encontrada.' });
        }

        const [result] = await db.query(
            `INSERT INTO ist_email_modelos
                (chave, nome, assunto, conteudo_html, id_assinatura, ativo, criado_por, atualizado_por)
             VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
            [payload.data.chave, payload.data.nome, payload.data.assunto, payload.data.conteudoHtml, payload.data.idAssinatura, payload.data.ativo, req.usuario.id_usuario]
        );
        const modelo = await buscarPorId(result.insertId);
        return res.status(201).json(respostaModelo(modelo));
    } catch (error) {
        return tratarErroBanco(error, res, 'criar');
    }
};

export const atualizarModelo = async (req, res) => {
    const idModelo = validarId(req.params.id);
    if (!idModelo) return res.status(400).json({ message: 'ID de modelo inválido.' });

    const payload = prepararPayload(req.body, false);
    if (payload.error) return res.status(400).json({ message: payload.error });

    try {
        const modeloAtual = await buscarPorId(idModelo);
        if (!modeloAtual) return res.status(404).json({ message: 'Modelo não encontrado.' });
        if (!(await assinaturaExiste(payload.data.idAssinatura))) {
            return res.status(400).json({ message: 'Assinatura não encontrada.' });
        }

        await db.query(
            `UPDATE ist_email_modelos
             SET nome = ?, assunto = ?, conteudo_html = ?, id_assinatura = ?, ativo = ?, atualizado_por = ?
             WHERE id_modelo = ?`,
            [payload.data.nome, payload.data.assunto, payload.data.conteudoHtml, payload.data.idAssinatura, payload.data.ativo, req.usuario.id_usuario, idModelo]
        );
        const modelo = await buscarPorId(idModelo);
        return res.status(200).json(respostaModelo(modelo));
    } catch (error) {
        return tratarErroBanco(error, res, 'atualizar');
    }
};
