import { pool as db } from '../config/db.js';
import { listarEventosAutorizadosJurado } from './juradoAccessService.js';
import {
    JULGAMENTO_ERROS, JulgamentoContextError, resolverContextoJulgamento,
    resolverJuradoCiclo, resolverConcorrenteCiclo
} from './julgamentoContextService.js';

export const NAVEGACAO_ERROS = Object.freeze({
    ENTRADA_INVALIDA: 'ENTRADA_INVALIDA',
    ACESSO_OPERACIONAL_NEGADO: 'ACESSO_OPERACIONAL_NEGADO',
    CONCORRENTE_AUSENTE: 'CONCORRENTE_AUSENTE'
});
const mensagens = {
    ENTRADA_INVALIDA: 'Entrada invalida.',
    ACESSO_OPERACIONAL_NEGADO: 'Acesso operacional negado.',
    CONCORRENTE_AUSENTE: 'Participacao nao encontrada.'
};
export class JuradoNavegacaoError extends Error {
    constructor(code) {
        super(mensagens[code]);
        this.name = 'JuradoNavegacaoError';
        this.code = code;
    }
}

const idValido = (id, max = 4294967295) => Number.isSafeInteger(id) && id > 0 && id <= max;
const textoValido = value => typeof value === 'string' && value.trim().length > 0
    && Array.from(value).length <= 255;
const entrada = condition => {
    if (!condition) throw new JuradoNavegacaoError(NAVEGACAO_ERROS.ENTRADA_INVALIDA);
};
const exigir = condition => {
    if (!condition) throw new JulgamentoContextError(JULGAMENTO_ERROS.CONTEXTO_INCONSISTENTE);
};
const validarUsuario = id => entrada(idValido(id, 2147483647));
const validarSlug = slug => entrada(textoValido(slug) && slug === slug.trim());
const logCleanup = etapa => {
    try { console.error('Falha de cleanup de navegacao cycle-aware.', { etapa }); }
    catch { /* Logging nao pode substituir o resultado da operacao. */ }
};

// Uma falha de SET/START/COMMIT deixa o estado da conexao incerto.
const executarLeituraNavegacao = async (poolExecutor, operacao) => {
    let connection;
    let started = false;
    let reusable = false;
    let commitAttempted = false;
    let destroyed = false;
    const destruir = () => {
        reusable = false;
        if (destroyed) return;
        destroyed = true;
        try { connection.destroy(); } catch { logCleanup('destroy'); }
    };
    try {
        connection = await poolExecutor.getConnection();
        await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
        await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
        started = true;
        reusable = true;
        const dto = await operacao(connection);
        commitAttempted = true;
        reusable = false;
        await connection.commit();
        started = false;
        reusable = true;
        return dto;
    } catch (error) {
        if (connection && started) {
            try {
                await connection.rollback();
                reusable = !commitAttempted;
            } catch {
                reusable = false;
                logCleanup('rollback');
            }
        }
        throw error;
    } finally {
        if (connection) {
            if (!reusable) destruir();
            else {
                try { connection.release(); }
                catch {
                    logCleanup('release');
                    destruir();
                }
            }
        }
    }
};

const validarEvento = evento => exigir(evento && idValido(evento.id)
    && textoValido(evento.slug) && textoValido(evento.nome));
const listarLive = async (idUsuario, idEvento, connection) => {
    const eventos = await listarEventosAutorizadosJurado(idUsuario, idEvento, connection);
    const vistos = new Set();
    for (const evento of eventos) {
        validarEvento(evento);
        exigir(!vistos.has(evento.id) && (idEvento === undefined || evento.id === idEvento));
        vistos.add(evento.id);
    }
    return eventos;
};
const rosterNegado = error => error instanceof JulgamentoContextError
    && [JULGAMENTO_ERROS.JURADO_FORA_ROSTER, JULGAMENTO_ERROS.JURADO_NAO_INCLUIDO].includes(error.code);
const carregarContexto = async (evento, idUsuario, connection) => {
    const contexto = await resolverContextoJulgamento(evento, connection);
    await resolverJuradoCiclo(contexto, idUsuario, connection, { exigirIncluido: true });
    return contexto;
};
const autorizarEvento = async (slug, idUsuario, connection) => {
    const [rows] = await connection.query('SELECT id, slug, nome FROM ist_eventos WHERE slug = ?', [slug]);
    if (rows.length === 0) throw new JulgamentoContextError(JULGAMENTO_ERROS.EVENTO_INEXISTENTE);
    exigir(rows.length === 1);
    const evento = rows[0];
    validarEvento(evento);
    const live = await listarLive(idUsuario, evento.id, connection);
    if (live.length === 0) throw new JuradoNavegacaoError(NAVEGACAO_ERROS.ACESSO_OPERACIONAL_NEGADO);
    exigir(live.length === 1 && live[0].slug === evento.slug && live[0].nome === evento.nome);
    const contexto = await carregarContexto(evento, idUsuario, connection);
    return { evento: { id: evento.id, slug: evento.slug, nome: evento.nome }, contexto };
};
const projetarContexto = contexto => ({
    idCiclo: contexto.id_ciclo_atual, numeroCiclo: contexto.numero_ciclo,
    estadoCiclo: contexto.estado_ciclo, versaoJulgamento: contexto.versao
});
const projetarParticipante = p => ({
    idParticipacao: p.id_concorrente, idSnapshot: p.id_ciclo_concorrente,
    numeroConcorrente: p.numero_concorrente, nome: p.nome_publico,
    obraPrincipal: { id: p.id_obra_1, titulo: p.obra_1_publica },
    linkVideoPrincipal: p.link_video_1,
    obraOpcional: p.id_obra_2 === null ? null : { id: p.id_obra_2, titulo: p.obra_2_publica },
    linkVideoOpcional: p.link_video_2
});
const carregarParticipante = async (contexto, idParticipacao, connection) => {
    try {
        return await resolverConcorrenteCiclo(contexto, idParticipacao, connection, { exigirIncluido: true });
    } catch (error) {
        if (error instanceof JulgamentoContextError
            && [JULGAMENTO_ERROS.CONCORRENTE_AUSENTE, JULGAMENTO_ERROS.CONCORRENTE_NAO_INCLUIDO].includes(error.code)) {
            throw new JulgamentoContextError(JULGAMENTO_ERROS.CONTEXTO_INCONSISTENTE);
        }
        throw error;
    }
};

// Inclusao precede validacao material; exclusao nao revela material incompleto.
const verificarParticipanteDetalhe = async (contexto, idParticipacao, connection) => {
    const [rows] = await connection.query(
        `SELECT id_ciclo_concorrente, id_evento, id_ciclo, id_concorrente, estado_participacao
         FROM ist_eventos_ciclos_concorrentes WHERE id_ciclo = ? AND id_concorrente = ?`,
        [contexto.id_ciclo_atual, idParticipacao]
    );
    exigir(Array.isArray(rows));
    if (rows.length === 0) throw new JuradoNavegacaoError(NAVEGACAO_ERROS.CONCORRENTE_AUSENTE);
    exigir(rows.length === 1);
    const row = rows[0];
    exigir(row && typeof row === 'object' && !Array.isArray(row)
        && idValido(row.id_ciclo_concorrente) && row.id_evento === contexto.id_evento
        && row.id_ciclo === contexto.id_ciclo_atual && row.id_concorrente === idParticipacao
        && ['incluido', 'desistente', 'desclassificado', 'inelegivel'].includes(row.estado_participacao));
    if (row.estado_participacao !== 'incluido') {
        throw new JuradoNavegacaoError(NAVEGACAO_ERROS.CONCORRENTE_AUSENTE);
    }
    return row.id_ciclo_concorrente;
};

export const listarAcessosJuradoCycleAware = async (idUsuarioAutenticado, poolExecutor = db) => {
    validarUsuario(idUsuarioAutenticado);
    return executarLeituraNavegacao(poolExecutor, async connection => {
        const candidatos = await listarLive(idUsuarioAutenticado, undefined, connection);
        const eventos = [];
        for (const evento of candidatos) {
            let contexto;
            try { contexto = await carregarContexto(evento, idUsuarioAutenticado, connection); }
            catch (error) {
                if (rosterNegado(error)) continue;
                throw error;
            }
            eventos.push({ ...evento, contexto: projetarContexto(contexto) });
        }
        return { eventos };
    });
};

export const obterEventoJuradoCycleAware = async (slug, idUsuarioAutenticado, poolExecutor = db) => {
    validarSlug(slug);
    validarUsuario(idUsuarioAutenticado);
    return executarLeituraNavegacao(poolExecutor, async connection => {
        const { evento, contexto } = await autorizarEvento(slug, idUsuarioAutenticado, connection);
        return { evento, contexto: projetarContexto(contexto) };
    });
};

const ordenarPor = { numeroConcorrente: 'numero_concorrente', nome: 'nome_publico' };
const validarParametros = parametros => {
    entrada(parametros !== null && typeof parametros === 'object' && !Array.isArray(parametros));
    entrada(Reflect.ownKeys(parametros).every(key => ['page', 'limit', 'sort', 'order'].includes(key)));
    const { page = 1, limit = 25, sort = 'numeroConcorrente', order = 'asc' } = parametros;
    entrada(Number.isSafeInteger(page) && page > 0 && Number.isInteger(limit) && limit > 0 && limit <= 100);
    entrada(['numeroConcorrente', 'nome'].includes(sort) && ['asc', 'desc'].includes(order));
    const offset = (page - 1) * limit;
    entrada(Number.isSafeInteger(offset));
    return { page, limit, sort, order, offset };
};

export const listarConcorrentesJuradoCycleAware = async (slug, idUsuarioAutenticado, parametros = {}, poolExecutor = db) => {
    validarSlug(slug);
    validarUsuario(idUsuarioAutenticado);
    const { page, limit, sort, order, offset } = validarParametros(parametros);
    return executarLeituraNavegacao(poolExecutor, async connection => {
        const { evento, contexto } = await autorizarEvento(slug, idUsuarioAutenticado, connection);
        const params = [evento.id, contexto.id_ciclo_atual, 'incluido'];
        const [counts] = await connection.query(
            `SELECT COUNT(*) AS total FROM ist_eventos_ciclos_concorrentes
             WHERE id_evento = ? AND id_ciclo = ? AND estado_participacao = ?`, params
        );
        exigir(counts.length === 1 && Number.isSafeInteger(counts[0].total) && counts[0].total >= 0);
        const total = counts[0].total;
        const [rows] = await connection.query(
            `SELECT id_evento, id_ciclo, id_concorrente FROM ist_eventos_ciclos_concorrentes
             WHERE id_evento = ? AND id_ciclo = ? AND estado_participacao = ?
             ORDER BY ${ordenarPor[sort]} ${order.toUpperCase()}, id_concorrente ASC LIMIT ? OFFSET ?`,
            [...params, limit, offset]
        );
        exigir(rows.length === Math.min(limit, Math.max(total - offset, 0)));
        const vistos = new Set();
        for (const row of rows) {
            exigir(row.id_evento === evento.id && row.id_ciclo === contexto.id_ciclo_atual
                && idValido(row.id_concorrente) && !vistos.has(row.id_concorrente));
            vistos.add(row.id_concorrente);
        }
        const concorrentes = [];
        for (const row of rows) {
            const participante = await carregarParticipante(contexto, row.id_concorrente, connection);
            concorrentes.push(projetarParticipante(participante));
        }
        return {
            evento, contexto: projetarContexto(contexto), concorrentes,
            pagination: { page, limit, total, totalPages: total === 0 ? 0 : Math.ceil(total / limit) }
        };
    });
};

export const obterConcorrenteJuradoCycleAware = async (slug, idParticipacao, idUsuarioAutenticado, poolExecutor = db) => {
    validarSlug(slug);
    entrada(idValido(idParticipacao));
    validarUsuario(idUsuarioAutenticado);
    return executarLeituraNavegacao(poolExecutor, async connection => {
        const { evento, contexto } = await autorizarEvento(slug, idUsuarioAutenticado, connection);
        const idSnapshot = await verificarParticipanteDetalhe(contexto, idParticipacao, connection);
        const participante = await carregarParticipante(contexto, idParticipacao, connection);
        exigir(participante.id_ciclo_concorrente === idSnapshot);
        return { evento, contexto: projetarContexto(contexto), concorrente: projetarParticipante(participante) };
    });
};
