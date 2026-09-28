import {
    EmailComposicaoError,
    comporEmailPorId,
    obterPlaceholdersDoModelo
} from '../../services/emailTemplateService.js';

const LIMITE_TOTAL_VARIAVEIS = 20 * 1024;

const validarId = (valor) => {
    const id = Number(valor);
    return Number.isInteger(id) && id > 0 ? id : null;
};

const STATUS_POR_CODIGO = {
    MODELO_INEXISTENTE: 404,
    CHAVE_INEXISTENTE: 404
};

const responderErro = (error, res, acao) => {
    if (error instanceof EmailComposicaoError) {
        return res.status(STATUS_POR_CODIGO[error.codigo] || 400).json({ message: error.message, codigo: error.codigo });
    }
    console.error(`Erro ao ${acao} preview de e-mail:`, error);
    return res.status(500).json({ message: `Erro ao ${acao} preview.` });
};

export const listarPlaceholdersDoModelo = async (req, res) => {
    const idModelo = validarId(req.params.id);
    if (!idModelo) {
        return res.status(400).json({ message: 'ID de modelo inválido.' });
    }

    try {
        return res.status(200).json(await obterPlaceholdersDoModelo(idModelo));
    } catch (error) {
        return responderErro(error, res, 'carregar');
    }
};

export const gerarPreviewDoModelo = async (req, res) => {
    const idModelo = validarId(req.params.id);
    if (!idModelo) {
        return res.status(400).json({ message: 'ID de modelo inválido.' });
    }

    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((campo) => campo !== 'variaveis')) {
        return res.status(400).json({ message: 'Payload de preview inválido.' });
    }

    const variaveis = body.variaveis ?? {};
    if (typeof variaveis !== 'object' || variaveis === null || Array.isArray(variaveis)) {
        return res.status(400).json({ message: 'O campo variaveis deve ser um objeto simples.' });
    }

    if (Buffer.byteLength(JSON.stringify(variaveis), 'utf8') > LIMITE_TOTAL_VARIAVEIS) {
        return res.status(400).json({ message: 'O conjunto de variáveis excede o tamanho permitido.' });
    }

    try {
        const resultado = await comporEmailPorId(idModelo, variaveis, { permitirInativo: true });
        return res.status(200).json(resultado);
    } catch (error) {
        return responderErro(error, res, 'gerar');
    }
};
