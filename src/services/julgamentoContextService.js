import { pool as db } from '../config/db.js';

const UINT_MAX = 4294967295;
const INT_MAX = 2147483647;
const idValido = (valor, maximo = UINT_MAX) => Number.isSafeInteger(valor) && valor > 0 && valor <= maximo;
const textoValido = (valor, maximo) => typeof valor === 'string' && valor.trim().length > 0 && Array.from(valor).length <= maximo;
const dataValida = (valor) => valor instanceof Date ? Number.isFinite(valor.getTime())
    : typeof valor === 'string' && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(valor) && Number.isFinite(Date.parse(valor));

export const JULGAMENTO_ERROS = Object.freeze({
    EVENTO_INEXISTENTE: 'EVENTO_INEXISTENTE',
    JULGAMENTO_NAO_CONFIGURADO: 'JULGAMENTO_NAO_CONFIGURADO',
    CICLO_ATUAL_AUSENTE: 'CICLO_ATUAL_AUSENTE',
    CONTEXTO_INCONSISTENTE: 'CONTEXTO_INCONSISTENTE',
    JURADO_FORA_ROSTER: 'JURADO_FORA_ROSTER',
    JURADO_NAO_INCLUIDO: 'JURADO_NAO_INCLUIDO',
    CONCORRENTE_AUSENTE: 'CONCORRENTE_AUSENTE',
    CONCORRENTE_NAO_INCLUIDO: 'CONCORRENTE_NAO_INCLUIDO',
    CRITERIOS_INVALIDOS: 'CRITERIOS_INVALIDOS',
    TENTATIVAS_INVALIDAS: 'TENTATIVAS_INVALIDAS'
});

const MENSAGENS = Object.freeze({
    EVENTO_INEXISTENTE: 'Evento inexistente.',
    JULGAMENTO_NAO_CONFIGURADO: 'Julgamento nao configurado.',
    CICLO_ATUAL_AUSENTE: 'Ciclo atual ausente.',
    CONTEXTO_INCONSISTENTE: 'Contexto de julgamento inconsistente.',
    JURADO_FORA_ROSTER: 'Jurado fora do roster do ciclo.',
    JURADO_NAO_INCLUIDO: 'Jurado nao incluido no ciclo.',
    CONCORRENTE_AUSENTE: 'Concorrente ausente do ciclo.',
    CONCORRENTE_NAO_INCLUIDO: 'Concorrente nao incluido no ciclo.',
    CRITERIOS_INVALIDOS: 'Configuracao de criterios do ciclo invalida.',
    TENTATIVAS_INVALIDAS: 'Sequencia de tentativas invalida.'
});

export class JulgamentoContextError extends Error {
    constructor(code, details = {}) {
        super(MENSAGENS[code]);
        this.name = 'JulgamentoContextError';
        this.code = code;
        this.details = details;
    }
}

const falhar = (code, details) => { throw new JulgamentoContextError(code, details); };
const exigir = (condicao, code = JULGAMENTO_ERROS.CONTEXTO_INCONSISTENTE) => {
    if (!condicao) falhar(code);
};
const validarContexto = (contexto) => {
    exigir(contexto && idValido(contexto.id_evento) && idValido(contexto.id_ciclo_atual));
};
const validarVinculo = (row, contexto, code = JULGAMENTO_ERROS.CONTEXTO_INCONSISTENTE) => {
    exigir(row.id_evento === contexto.id_evento && row.id_ciclo === contexto.id_ciclo_atual, code);
};
const validarEstadoCiclo = (ciclo) => {
    exigir(idValido(ciclo.id_ciclo) && idValido(ciclo.id_evento) && idValido(ciclo.numero_ciclo));
    exigir((ciclo.estado === 'aberto' && ciclo.publicado_em === null)
        || (ciclo.estado === 'selado' && dataValida(ciclo.publicado_em)));
    if (ciclo.numero_ciclo === 1) {
        exigir(ciclo.id_ciclo_origem === null && ciclo.id_publicacao_origem === null && ciclo.motivo_reabertura === null);
    } else {
        exigir(idValido(ciclo.id_ciclo_origem) && ciclo.id_ciclo_origem !== ciclo.id_ciclo
            && idValido(ciclo.id_publicacao_origem) && textoValido(ciclo.motivo_reabertura, 2000));
    }
};

const carregarCiclo = async (idCiclo, executor) => {
    const [rows] = await executor.query(
        `SELECT id_ciclo, id_evento, numero_ciclo, estado, id_ciclo_origem,
                id_publicacao_origem, publicado_em, motivo_reabertura
         FROM ist_eventos_ciclos WHERE id_ciclo = ?`, [idCiclo]
    );
    exigir(rows.length === 1);
    validarEstadoCiclo(rows[0]);
    return rows[0];
};

const carregarPublicacao = async (idPublicacao, idEvento, executor) => {
    const [rows] = await executor.query(
        `SELECT p.id_publicacao, p.id_evento, p.id_ciclo, p.versao, p.publicado_em,
                c.id_evento AS ciclo_evento, c.numero_ciclo, c.estado AS estado_ciclo,
                c.publicado_em AS ciclo_publicado_em
         FROM ist_eventos_publicacoes p
         LEFT JOIN ist_eventos_ciclos c ON c.id_ciclo = p.id_ciclo
         WHERE p.id_publicacao = ?`, [idPublicacao]
    );
    exigir(rows.length === 1);
    const p = rows[0];
    exigir(p.id_publicacao === idPublicacao && p.id_evento === idEvento
        && p.ciclo_evento === idEvento && idValido(p.id_ciclo) && idValido(p.numero_ciclo)
        && idValido(p.versao) && p.estado_ciclo === 'selado'
        && dataValida(p.publicado_em) && dataValida(p.ciclo_publicado_em));
    return p;
};

// O chamador controla transacao, isolamento e locks; o resolver apenas le.
// Uma visao consistente exige conexao transacional; pool nao garante snapshot.
// Evento identificado: { id, slug, nome }; um ID numerico permite busca local.
// permite_escrita indica apenas lifecycle aberto, nao autorizacao final de PUT.
export const resolverContextoJulgamento = async (entrada, executor = db) => {
    let evento;
    if (typeof entrada === 'number') {
        exigir(idValido(entrada));
        const [rows] = await executor.query('SELECT id, slug, nome FROM ist_eventos WHERE id = ?', [entrada]);
        if (rows.length === 0) falhar(JULGAMENTO_ERROS.EVENTO_INEXISTENTE);
        exigir(rows.length === 1 && rows[0].id === entrada);
        evento = rows[0];
    } else {
        evento = entrada;
    }
    exigir(evento && idValido(evento.id) && textoValido(evento.slug, 255) && textoValido(evento.nome, 255));
    const [rows] = await executor.query(
        `SELECT id_evento, id_ciclo_atual, id_publicacao_vigente, quantidade_classificados, versao
         FROM ist_eventos_julgamentos WHERE id_evento = ?`, [evento.id]
    );
    if (rows.length === 0) falhar(JULGAMENTO_ERROS.JULGAMENTO_NAO_CONFIGURADO);
    exigir(rows.length === 1);
    const julgamento = rows[0];
    exigir(julgamento.id_evento === evento.id && idValido(julgamento.versao)
        && (julgamento.quantidade_classificados === null || idValido(julgamento.quantidade_classificados)));
    if (julgamento.id_ciclo_atual === null) falhar(JULGAMENTO_ERROS.CICLO_ATUAL_AUSENTE);
    exigir(idValido(julgamento.id_ciclo_atual));
    const ciclo = await carregarCiclo(julgamento.id_ciclo_atual, executor);
    exigir(ciclo.id_ciclo === julgamento.id_ciclo_atual && ciclo.id_evento === evento.id);
    const publicacoes = new Map();
    const publicacao = async (id) => {
        exigir(idValido(id));
        if (!publicacoes.has(id)) publicacoes.set(id, await carregarPublicacao(id, evento.id, executor));
        return publicacoes.get(id);
    };
    if (ciclo.numero_ciclo > 1) {
        const origem = await carregarCiclo(ciclo.id_ciclo_origem, executor);
        exigir(origem.id_ciclo === ciclo.id_ciclo_origem && origem.id_evento === evento.id
            && origem.numero_ciclo < ciclo.numero_ciclo && origem.estado === 'selado');
        const p = await publicacao(ciclo.id_publicacao_origem);
        exigir(p.id_ciclo === origem.id_ciclo);
    }
    if (julgamento.id_publicacao_vigente !== null) {
        const vigente = await publicacao(julgamento.id_publicacao_vigente);
        exigir(vigente.numero_ciclo <= ciclo.numero_ciclo);
    }
    const [publicadas] = await executor.query(
        'SELECT id_publicacao FROM ist_eventos_publicacoes WHERE id_evento = ? AND id_ciclo = ?',
        [evento.id, ciclo.id_ciclo]
    );
    if (ciclo.estado === 'selado') {
        exigir(publicadas.length === 1);
        const p = await publicacao(publicadas[0].id_publicacao);
        exigir(p.id_ciclo === ciclo.id_ciclo);
    } else {
        exigir(publicadas.length === 0);
    }
    return {
        id_evento: evento.id, slug: evento.slug, nome: evento.nome,
        // Julgamento usa id_evento como PK; nao existe coluna id_julgamento.
        id_julgamento: julgamento.id_evento,
        id_ciclo_atual: ciclo.id_ciclo, numero_ciclo: ciclo.numero_ciclo, estado_ciclo: ciclo.estado,
        id_ciclo_origem: ciclo.id_ciclo_origem, id_publicacao_origem: ciclo.id_publicacao_origem,
        id_publicacao_vigente: julgamento.id_publicacao_vigente,
        versao: julgamento.versao, quantidade_classificados: julgamento.quantidade_classificados,
        permite_escrita: ciclo.estado === 'aberto'
    };
};

// Resolver um membro, especialmente com exigirIncluido=false, nao concede autorizacao.
export const resolverJuradoCiclo = async (contexto, idUsuario, executor = db, { exigirIncluido = false } = {}) => {
    validarContexto(contexto);
    exigir(idValido(idUsuario, INT_MAX));
    const [rows] = await executor.query(
        `SELECT id_ciclo, id_evento, id_usuario, nome_publico, estado_participacao
         FROM ist_eventos_ciclos_jurados WHERE id_ciclo = ? AND id_usuario = ?`,
        [contexto.id_ciclo_atual, idUsuario]
    );
    if (rows.length === 0) falhar(JULGAMENTO_ERROS.JURADO_FORA_ROSTER);
    exigir(rows.length === 1);
    const jurado = rows[0];
    validarVinculo(jurado, contexto);
    exigir(jurado.id_usuario === idUsuario && textoValido(jurado.nome_publico, 255)
        && ['incluido', 'inelegivel', 'retirado'].includes(jurado.estado_participacao));
    if (exigirIncluido && jurado.estado_participacao !== 'incluido') {
        falhar(JULGAMENTO_ERROS.JURADO_NAO_INCLUIDO, { estado_participacao: jurado.estado_participacao });
    }
    return jurado;
};

export const resolverConcorrenteCiclo = async (contexto, idConcorrente, executor = db, { exigirIncluido = false } = {}) => {
    validarContexto(contexto);
    exigir(idValido(idConcorrente));
    const [rows] = await executor.query(
        `SELECT id_ciclo_concorrente, id_ciclo, id_evento, id_concorrente, id_usuario,
                numero_concorrente, nome_publico, id_obra_1, obra_1_publica, link_video_1,
                id_obra_2, obra_2_publica, link_video_2, fingerprint, estado_participacao
         FROM ist_eventos_ciclos_concorrentes WHERE id_ciclo = ? AND id_concorrente = ?`,
        [contexto.id_ciclo_atual, idConcorrente]
    );
    if (rows.length === 0) falhar(JULGAMENTO_ERROS.CONCORRENTE_AUSENTE);
    exigir(rows.length === 1);
    const p = rows[0];
    validarVinculo(p, contexto);
    exigir(p.id_concorrente === idConcorrente && idValido(p.id_ciclo_concorrente)
        && idValido(p.id_usuario, INT_MAX) && textoValido(p.nome_publico, 255)
        && ['incluido', 'desistente', 'desclassificado', 'inelegivel'].includes(p.estado_participacao));
    // Snapshots excluidos podem nao possuir material; negar membership antes de exigir esse material.
    if (exigirIncluido && p.estado_participacao !== 'incluido') {
        falhar(JULGAMENTO_ERROS.CONCORRENTE_NAO_INCLUIDO, { estado_participacao: p.estado_participacao });
    }
    exigir(
        textoValido(p.numero_concorrente, 50) && idValido(p.id_obra_1)
        && typeof p.obra_1_publica === 'string' && Array.from(p.obra_1_publica).length <= 255
        && textoValido(p.link_video_1, 500)
        && typeof p.fingerprint === 'string' && /^[a-fA-F0-9]{64}$/.test(p.fingerprint)
        && ['incluido', 'desistente', 'desclassificado', 'inelegivel'].includes(p.estado_participacao));
    exigir(p.id_obra_2 === null || idValido(p.id_obra_2));
    exigir(p.obra_2_publica === null || (typeof p.obra_2_publica === 'string' && Array.from(p.obra_2_publica).length <= 255));
    exigir(p.link_video_2 === null || (typeof p.link_video_2 === 'string' && Array.from(p.link_video_2).length <= 500));
    return p;
};

export const validarCriteriosCiclo = (rows, contexto) => {
    validarContexto(contexto);
    const code = JULGAMENTO_ERROS.CRITERIOS_INVALIDOS;
    exigir(Array.isArray(rows) && rows.length > 0, code);
    const snapshots = new Set(), origens = new Set(), ordens = new Set();
    let total = 0n;
    for (const row of rows) {
        validarVinculo(row, contexto, code);
        exigir(idValido(row.id_criterio_ciclo) && idValido(row.id_criterio_origem)
            && !snapshots.has(row.id_criterio_ciclo) && !origens.has(row.id_criterio_origem)
            && idValido(row.ordem, 255) && !ordens.has(row.ordem)
            && textoValido(row.nome, 150)
            && (row.descricao === null || (typeof row.descricao === 'string' && Array.from(row.descricao).length <= 1000))
            && typeof row.peso === 'string' && /^\d{1,3}(?:\.\d{1,2})?$/.test(row.peso), code);
        const [inteiro, fracao = ''] = row.peso.split('.');
        const peso = BigInt(inteiro) * 100n + BigInt(fracao.padEnd(2, '0'));
        exigir(peso > 0n && peso <= 10000n, code);
        total += peso;
        snapshots.add(row.id_criterio_ciclo); origens.add(row.id_criterio_origem); ordens.add(row.ordem);
    }
    exigir(total === 10000n, code);
    return [...rows].sort((a, b) => a.ordem - b.ordem);
};

export const carregarCriteriosCiclo = async (contexto, executor = db) => {
    validarContexto(contexto);
    const [rows] = await executor.query(
        `SELECT id_criterio_ciclo, id_criterio_origem, id_ciclo, id_evento, nome, descricao, ordem, peso
         FROM ist_eventos_ciclos_criterios WHERE id_ciclo = ? ORDER BY ordem, id_criterio_ciclo`,
        [contexto.id_ciclo_atual]
    );
    return validarCriteriosCiclo(rows, contexto);
};

// Interpreta o historico completo de um par em um unico ciclo, admitindo lacunas.
// O retorno nao autoriza criar tentativa, revisao ou carry-forward.
// Origem externa permanece nao resolvida: autorizacao e compatibilidade material
// entre ciclos exigem validacao futura fora deste helper.
export const interpretarTentativasCiclo = (rows, par) => {
    const code = JULGAMENTO_ERROS.TENTATIVAS_INVALIDAS;
    exigir(par && typeof par === 'object' && !Array.isArray(par), code);
    const { id_evento, id_ciclo, id_jurado, id_concorrente } = par;
    exigir(Array.isArray(rows) && idValido(id_evento) && idValido(id_ciclo)
        && idValido(id_jurado, INT_MAX) && idValido(id_concorrente), code);
    for (const row of rows) {
        exigir(row && typeof row === 'object' && !Array.isArray(row)
            && idValido(row.numero_tentativa), code);
    }
    const ordenadas = [...rows].sort((a, b) => a.numero_tentativa - b.numero_tentativa);
    const avaliacoes = new Map();
    const numeros = new Set();
    for (let i = 0; i < ordenadas.length; i++) {
        const a = ordenadas[i];
        exigir(a.id_evento === id_evento && a.id_ciclo === id_ciclo
            && a.id_jurado === id_jurado && a.id_concorrente === id_concorrente
            && idValido(a.id_avaliacao) && !avaliacoes.has(a.id_avaliacao)
            && !numeros.has(a.numero_tentativa) && idValido(a.versao)
            && ['rascunho', 'concluida'].includes(a.estado)
            && (a.estado === 'concluida' || i === ordenadas.length - 1), code);
        exigir(a.id_avaliacao_origem === null || (idValido(a.id_avaliacao_origem)
            && a.id_avaliacao_origem !== a.id_avaliacao), code);
        avaliacoes.set(a.id_avaliacao, a);
        numeros.add(a.numero_tentativa);
    }
    for (const a of ordenadas) {
        const origem = avaliacoes.get(a.id_avaliacao_origem);
        if (origem) exigir(origem.numero_tentativa < a.numero_tentativa, code);
    }
    return ordenadas.at(-1) || null;
};
