import sanitizeHtml from 'sanitize-html';
import { obterCatalogo, CHAVE_RECUPERACAO_BIBLIOTECA_CODIGO, CHAVE_CONFIRMACAO_COMPRA } from '../config/emailPlaceholders.js';
import { sanitizeEmailHtml } from './emailHtmlSanitizer.js';

const REGEX_PLACEHOLDER = /\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g;
const REGEX_HREF = /(href\s*=\s*")([^"]*)(")/gi;
const CHAVES_PROIBIDAS = new Set(['__proto__', 'constructor', 'prototype']);
const LIMITE_URL = 2048;
const LIMITE_VALOR = 5000;
const LIMITE_ITENS_RECIBO = 200000;
const SEPARADOR_ASSINATURA = '<div style="margin-top: 24px"></div>';
// Composicao pura nao importa pool/configuracao; carregadores mantem o banco padrao.
const obterBanco = async (banco) => banco ?? (await import('../config/db.js')).pool;

export class EmailComposicaoError extends Error {
    constructor(codigo, message, detalhes = null) {
        super(message);
        this.name = 'EmailComposicaoError';
        this.codigo = codigo;
        this.detalhes = detalhes;
    }
}

const escaparHtml = (valor) =>
    valor
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

const extrairPlaceholders = (texto) => {
    const encontrados = new Set();
    for (const [, nome] of texto.matchAll(REGEX_PLACEHOLDER)) {
        encontrados.add(nome);
    }
    return encontrados;
};

const validarUrl = (nome, valor) => {
    if (valor.length > LIMITE_URL) {
        throw new EmailComposicaoError('URL_INVALIDA', `A URL de "${nome}" excede o comprimento permitido.`, { nome });
    }

    let url;
    try {
        url = new URL(valor);
    } catch {
        throw new EmailComposicaoError('URL_INVALIDA', `O valor de "${nome}" não é uma URL absoluta válida.`, { nome });
    }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new EmailComposicaoError('URL_INVALIDA', `A URL de "${nome}" deve usar http ou https.`, { nome });
    }

    return url.toString();
};

const substituirNoHref = (html, catalogo, variaveis) =>
    html.replace(REGEX_HREF, (trecho, abertura, valor, fechamento) => {
        const usados = extrairPlaceholders(valor);
        if (usados.size === 0) {
            return trecho;
        }

        const exclusivo = valor.trim().match(/^\{\{\s*([a-z][a-z0-9_]*)\s*\}\}$/);
        if (!exclusivo) {
            throw new EmailComposicaoError(
                'URL_CONTEXTO_INVALIDO',
                'Um href com placeholder deve conter exclusivamente o placeholder, sem texto adicional.'
            );
        }

        const nome = exclusivo[1];
        if (catalogo[nome]?.tipo !== 'url') {
            throw new EmailComposicaoError(
                'URL_CONTEXTO_INVALIDO',
                `O placeholder "${nome}" não é do tipo URL e não pode ser usado em href.`,
                { nome }
            );
        }

        return abertura + escaparHtml(validarUrl(nome, variaveis[nome])) + fechamento;
    });

const substituirNoConteudo = (html, catalogo, variaveis, recibo = false) =>
    html.replace(REGEX_PLACEHOLDER, (trecho, nome) => {
        if (catalogo[nome]?.tipo === 'url') {
            throw new EmailComposicaoError(
                'URL_CONTEXTO_INVALIDO',
                `O placeholder "${nome}" é do tipo URL e só pode ser usado dentro de href.`,
                { nome }
            );
        }
        const texto = escaparHtml(variaveis[nome]);
        // Unica expansao especial: texto de itens escapado, nunca HTML fornecido.
        return recibo && nome === 'itens_compra' ? texto.replace(/\r\n?|\n/g, '<br>') : texto;
    });

const substituirNoAssunto = (assunto, catalogo, variaveis) =>
    assunto.replace(REGEX_PLACEHOLDER, (trecho, nome) => {
        const valor = variaveis[nome];
        if (/[\r\n\u0000-\u001f\u007f]/.test(valor)) {
            throw new EmailComposicaoError(
                'VARIAVEL_INVALIDA',
                `O valor de "${nome}" contém quebras de linha ou caracteres de controle e não pode ser usado no assunto.`,
                { nome }
            );
        }
        return catalogo[nome]?.tipo === 'url' ? validarUrl(nome, valor) : valor;
    });

// Converte HTML sanitizado em texto legível; sanitize-html faz a remoção estrutural das tags.
const gerarTexto = (html, incluirLinks = false) => {
    const conteudo = incluirLinks
        ? html.replace(/<a\b[^>]*\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_trecho, href, rotulo) => `${rotulo} (${href})`)
        : html;
    const comQuebras = conteudo
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
        .replace(/<\/(table|ul|ol)>/gi, '\n');

    return sanitizeHtml(comQuebras, { allowedTags: [], allowedAttributes: {} })
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/[ \t]+/g, ' ')
        .replace(/ *\n */g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
};

const validarContratoRecuperacao = (modelo, html, assunto, catalogo) => {
    if (modelo.chave !== CHAVE_RECUPERACAO_BIBLIOTECA_CODIGO) return;
    const marcadores = /\{\{([\s\S]*?)\}\}/g;
    for (const conteudo of [html, assunto]) {
        if ([...conteudo.matchAll(marcadores)].some(([, nome]) => !Object.hasOwn(catalogo, nome.trim()))) {
            throw new EmailComposicaoError('PLACEHOLDER_DESCONHECIDO', 'O modelo contém placeholders fora do catálogo permitido.');
        }
        if (/\{\{|\}\}/.test(conteudo.replace(marcadores, ''))) {
            throw new EmailComposicaoError('MODELO_RECUPERACAO_INVALIDO', 'O modelo contém um marcador incompleto.');
        }
    }
    if (typeof modelo.assunto !== 'string' || !assunto.trim() || /[\r\n\x00-\x1f\x7f]/.test(assunto)
        || extrairPlaceholders(assunto).has('codigo')) {
        throw new EmailComposicaoError('ASSUNTO_RECUPERACAO_INVALIDO', 'O assunto deve ser válido e não pode conter o código de acesso.');
    }
    const corpo = extrairPlaceholders(html);
    const visiveis = extrairPlaceholders(sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} }));
    const ausentes = Object.keys(catalogo).filter(nome => !corpo.has(nome)
        || (catalogo[nome].tipo === 'texto' && !visiveis.has(nome)));
    if (ausentes.length) {
        throw new EmailComposicaoError('PLACEHOLDER_OBRIGATORIO_NO_MODELO', 'O corpo do modelo não contém todos os placeholders obrigatórios.', { placeholders: ausentes });
    }
};

const validarVariaveis = (variaveis, recibo = false) => {
    if (!variaveis || typeof variaveis !== 'object' || Array.isArray(variaveis)) {
        throw new EmailComposicaoError('VARIAVEL_INVALIDA', 'As variáveis devem ser um objeto simples.');
    }

    const seguras = Object.create(null);
    for (const nome of Object.keys(variaveis)) {
        if (CHAVES_PROIBIDAS.has(nome)) {
            throw new EmailComposicaoError('VARIAVEL_INVALIDA', 'Nome de variável não permitido.', { nome });
        }
        const valor = variaveis[nome];
        if (typeof valor !== 'string') {
            throw new EmailComposicaoError('VARIAVEL_INVALIDA', `O valor de "${nome}" deve ser texto.`, { nome });
        }
        if (valor.length > (recibo && nome === 'itens_compra' ? LIMITE_ITENS_RECIBO : LIMITE_VALOR)) {
            throw new EmailComposicaoError('VARIAVEL_INVALIDA', `O valor de "${nome}" excede o tamanho permitido.`, { nome });
        }
        seguras[nome] = valor;
    }
    return seguras;
};

export const comporEmail = ({ modelo, assinatura = null, variaveis = {}, permitirInativo = false }) => {
    if (!modelo || typeof modelo !== 'object') {
        throw new EmailComposicaoError('MODELO_INEXISTENTE', 'Modelo não encontrado.');
    }

    const avisos = [];
    if (!modelo.ativo) {
        if (!permitirInativo) {
            throw new EmailComposicaoError('MODELO_INATIVO', 'O modelo está inativo.');
        }
        avisos.push({ codigo: 'modelo_inativo', mensagem: 'Este modelo está inativo e não seria utilizado em um envio real.' });
    }

    const catalogo = obterCatalogo(modelo.chave);
    if (!catalogo) {
        throw new EmailComposicaoError('SEM_CATALOGO', `Não há catálogo de placeholders para a chave "${modelo.chave}".`);
    }

    // Normaliza aspas e estrutura, garantindo que a detecção de href opere sobre HTML previsível.
    const htmlModelo = sanitizeEmailHtml(String(modelo.conteudoHtml || ''));
    const assuntoModelo = String(modelo.assunto || '');
    validarContratoRecuperacao(modelo, htmlModelo, assuntoModelo, catalogo);

    const usados = new Set([...extrairPlaceholders(htmlModelo), ...extrairPlaceholders(assuntoModelo)]);
    const desconhecidos = [...usados].filter((nome) => !Object.prototype.hasOwnProperty.call(catalogo, nome));
    if (desconhecidos.length) {
        throw new EmailComposicaoError(
            'PLACEHOLDER_DESCONHECIDO',
            `O modelo utiliza placeholders que não pertencem ao catálogo: ${desconhecidos.join(', ')}.`,
            { placeholders: desconhecidos }
        );
    }

    const recibo = modelo.chave === CHAVE_CONFIRMACAO_COMPRA;
    if (recibo) {
        const corpo = extrairPlaceholders(htmlModelo);
        const visiveis = extrairPlaceholders(sanitizeHtml(htmlModelo, { allowedTags: [], allowedAttributes: {} }));
        if (/\{\{|\}\}/.test((htmlModelo + assuntoModelo).replace(REGEX_PLACEHOLDER, '')))
            throw new EmailComposicaoError('MODELO_RECIBO_INVALIDO', 'Marcador inválido no recibo.');
        if (Object.keys(catalogo).some(nome => !corpo.has(nome) || (catalogo[nome].tipo === 'texto' && !visiveis.has(nome))))
            throw new EmailComposicaoError('PLACEHOLDER_OBRIGATORIO_NO_MODELO', 'O recibo exige todos os placeholders no corpo.');
        if (!assuntoModelo.trim() || /[\r\n\x00-\x1f\x7f]/.test(assuntoModelo))
            throw new EmailComposicaoError('ASSUNTO_RECIBO_INVALIDO', 'Assunto inválido.');
        if (!assinatura?.ativo || !sanitizeHtml(String(assinatura.conteudoHtml || ''), { allowedTags: [], allowedAttributes: {} }).trim())
            throw new EmailComposicaoError('ASSINATURA_RECIBO_INVALIDA', 'O recibo exige assinatura administrativa ativa.');
    }
    const fornecidas = validarVariaveis(variaveis, recibo);
    const ausentes = [...usados].filter((nome) => !Object.prototype.hasOwnProperty.call(fornecidas, nome));
    if (ausentes.length) {
        throw new EmailComposicaoError(
            'PLACEHOLDER_AUSENTE',
            `Faltam valores para: ${ausentes.join(', ')}.`,
            { placeholders: ausentes }
        );
    }

    const excedentes = Object.keys(fornecidas).filter((nome) => !usados.has(nome));
    if (excedentes.length) {
        throw new EmailComposicaoError(
            'VARIAVEL_EXCEDENTE',
            `Variáveis não utilizadas por este modelo: ${excedentes.join(', ')}.`,
            { placeholders: excedentes }
        );
    }

    const recuperacaoCodigo = modelo.chave === CHAVE_RECUPERACAO_BIBLIOTECA_CODIGO;
    if ((recuperacaoCodigo || recibo) && Object.values(fornecidas).some(valor => !valor.trim())) {
        throw new EmailComposicaoError('VARIAVEL_INVALIDA', 'Os placeholders obrigatórios precisam de valores não vazios.');
    }
    const assunto = substituirNoAssunto(assuntoModelo, catalogo, fornecidas);
    if (recuperacaoCodigo && assunto.includes(fornecidas.codigo)) {
        throw new EmailComposicaoError('ASSUNTO_RECUPERACAO_INVALIDO', 'O assunto não pode conter o código de acesso.');
    }
    let html = substituirNoConteudo(substituirNoHref(htmlModelo, catalogo, fornecidas), catalogo, fornecidas, recibo);

    if (assinatura) {
        if (assinatura.ativo) {
            const htmlAssinatura = sanitizeEmailHtml(String(assinatura.conteudoHtml || ''));
            if ((recuperacaoCodigo || recibo) && /\{\{|\}\}/.test(htmlAssinatura)) {
                throw new EmailComposicaoError('PLACEHOLDER_NA_ASSINATURA', 'Os placeholders devem estar no modelo, não na assinatura.');
            }
            html += SEPARADOR_ASSINATURA + htmlAssinatura;
        } else {
            avisos.push({ codigo: 'assinatura_inativa', mensagem: 'A assinatura associada está inativa e não foi incluída.' });
        }
    }

    html = sanitizeEmailHtml(html).trim();
    if (!html) {
        throw new EmailComposicaoError('CONTEUDO_FINAL_VAZIO', 'O conteúdo final ficou vazio após a sanitização.');
    }

    return { assunto, html, text: gerarTexto(html, recuperacaoCodigo || recibo), avisos };
};

const mapearModelo = (linha) => ({
    idModelo: linha.id_modelo,
    chave: linha.chave,
    assunto: linha.assunto,
    conteudoHtml: linha.conteudo_html,
    idAssinatura: linha.id_assinatura,
    ativo: Boolean(linha.ativo)
});

const carregarAssinatura = async (idAssinatura, db) => {
    if (idAssinatura === null || idAssinatura === undefined) {
        return null;
    }
    const [rows] = await db.query(
        'SELECT id_assinatura, conteudo_html, ativo FROM ist_email_assinaturas WHERE id_assinatura = ?',
        [idAssinatura]
    );
    const linha = rows[0];
    return linha ? { conteudoHtml: linha.conteudo_html, ativo: Boolean(linha.ativo) } : null;
};

const SELECT_MODELO = `SELECT id_modelo, chave, assunto, conteudo_html, id_assinatura, ativo
     FROM ist_email_modelos`;

// Snapshot administrativo por operacao; composicao posterior e pura, sem recarregar o modelo.
export const prepararEmailPorChave = async (chave, { db: banco } = {}) => {
    const db = await obterBanco(banco);
    const [rows] = await db.query(`${SELECT_MODELO} WHERE chave = ?`, [chave]);
    if (!rows.length) {
        throw new EmailComposicaoError('CHAVE_INEXISTENTE', 'Modelo não encontrado para a chave informada.');
    }
    const modelo = mapearModelo(rows[0]);
    const assinatura = await carregarAssinatura(modelo.idAssinatura, db);
    return variaveis => comporEmail({ modelo, assinatura, variaveis, permitirInativo: false });
};

export const comporEmailPorChave = async (chave, variaveis = {}, opcoes = {}) =>
    (await prepararEmailPorChave(chave, opcoes))(variaveis);

export const comporEmailPorId = async (idModelo, variaveis = {}, { permitirInativo = false, db: banco } = {}) => {
    const db = await obterBanco(banco);
    const [rows] = await db.query(`${SELECT_MODELO} WHERE id_modelo = ?`, [idModelo]);
    if (!rows.length) {
        throw new EmailComposicaoError('MODELO_INEXISTENTE', 'Modelo não encontrado.');
    }

    const modelo = mapearModelo(rows[0]);
    const assinatura = await carregarAssinatura(modelo.idAssinatura, db);
    const resultado = comporEmail({ modelo, assinatura, variaveis, permitirInativo });

    if (modelo.idAssinatura !== null && assinatura === null) {
        resultado.avisos.push({
            codigo: 'assinatura_inexistente',
            mensagem: 'A assinatura associada não foi encontrada e não foi incluída.'
        });
    }

    return resultado;
};

export const obterPlaceholdersDoModelo = async (idModelo, { db: banco } = {}) => {
    const db = await obterBanco(banco);
    const [rows] = await db.query(`${SELECT_MODELO} WHERE id_modelo = ?`, [idModelo]);
    if (!rows.length) {
        throw new EmailComposicaoError('MODELO_INEXISTENTE', 'Modelo não encontrado.');
    }

    const modelo = mapearModelo(rows[0]);
    const catalogo = obterCatalogo(modelo.chave);
    if (!catalogo) {
        throw new EmailComposicaoError('SEM_CATALOGO', `Não há catálogo de placeholders para a chave "${modelo.chave}".`);
    }

    validarContratoRecuperacao(modelo, sanitizeEmailHtml(String(modelo.conteudoHtml || '')), String(modelo.assunto || ''), catalogo);

    const usados = [
        ...new Set([
            ...extrairPlaceholders(sanitizeEmailHtml(String(modelo.conteudoHtml || ''))),
            ...extrairPlaceholders(String(modelo.assunto || ''))
        ])
    ];

    const desconhecidos = usados.filter((nome) => !Object.prototype.hasOwnProperty.call(catalogo, nome));
    if (desconhecidos.length) {
        throw new EmailComposicaoError(
            'PLACEHOLDER_DESCONHECIDO',
            `O modelo utiliza placeholders que não pertencem ao catálogo: ${desconhecidos.join(', ')}.`,
            { placeholders: desconhecidos }
        );
    }

    return {
        chave: modelo.chave,
        ativo: modelo.ativo,
        placeholders: usados.map((nome) => ({
            nome,
            tipo: catalogo[nome].tipo,
            obrigatorio: catalogo[nome].obrigatorio,
            descricao: catalogo[nome].descricao
        }))
    };
};
