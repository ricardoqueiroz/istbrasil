import { isDeepStrictEqual } from 'node:util';
import { pool as db } from '../config/db.js';
import {
    JULGAMENTO_ERROS, JulgamentoContextError, resolverContextoJulgamento,
    resolverJuradoCiclo, resolverConcorrenteCiclo, carregarCriteriosCiclo,
    interpretarTentativasCiclo
} from './julgamentoContextService.js';
import { obterAvaliacaoJuradoCycleAware } from './juradoAvaliacaoLeituraService.js';
import {
    AUTORIZACAO_ERROS, avaliarAutorizacaoGravacao, carregarElegibilidadeLiveGravacao
} from './juradoAvaliacaoAutorizacaoService.js';

const UINT_MAX = 4294967295;
const idValido = (valor, maximo = UINT_MAX) => Number.isSafeInteger(valor) && valor > 0 && valor <= maximo;
const objeto = valor => valor !== null && typeof valor === 'object' && !Array.isArray(valor);
const camposExatos = (valor, campos) => objeto(valor) && Object.keys(valor).length === campos.length
    && campos.every(campo => Object.prototype.hasOwnProperty.call(valor, campo));
const textoValido = (valor, limite) => typeof valor === 'string' && valor.trim().length > 0 && Array.from(valor).length <= limite;

export const GRAVACAO_ERROS = Object.freeze({
    PAYLOAD_INVALIDO: 'PAYLOAD_INVALIDO',
    ACESSO_OPERACIONAL_NEGADO: AUTORIZACAO_ERROS.ACESSO_OPERACIONAL_NEGADO,
    CICLO_DESATUALIZADO: 'CICLO_DESATUALIZADO',
    TENTATIVA_DESATUALIZADA: 'TENTATIVA_DESATUALIZADA',
    VERSAO_DESATUALIZADA: 'VERSAO_DESATUALIZADA',
    AVALIACAO_CONCLUIDA: AUTORIZACAO_ERROS.AVALIACAO_CONCLUIDA,
    CONTEXTO_NAO_GRAVAVEL: AUTORIZACAO_ERROS.CONTEXTO_NAO_GRAVAVEL,
    CONFLITO_CONCORRENCIA: 'CONFLITO_CONCORRENCIA'
});
const MENSAGENS = Object.freeze({
    PAYLOAD_INVALIDO: 'Dados de gravacao invalidos.',
    ACESSO_OPERACIONAL_NEGADO: 'Acesso operacional negado.',
    CICLO_DESATUALIZADO: 'Ciclo desatualizado. Consulte novamente.',
    TENTATIVA_DESATUALIZADA: 'Tentativa desatualizada. Consulte novamente.',
    VERSAO_DESATUALIZADA: 'Versao desatualizada. Consulte novamente.',
    AVALIACAO_CONCLUIDA: 'Avaliacao concluida nao pode ser alterada.',
    CONTEXTO_NAO_GRAVAVEL: 'Contexto nao permite gravacao.',
    CONFLITO_CONCORRENCIA: 'Conflito de concorrencia. Consulte novamente.'
});
export class JuradoAvaliacaoGravacaoError extends Error {
    constructor(code, details = {}) {
        super(MENSAGENS[code]);
        this.name = 'JuradoAvaliacaoGravacaoError';
        this.code = code;
        this.details = details;
    }
}
const falhar = (code, details) => { throw new JuradoAvaliacaoGravacaoError(code, details); };
const exigir = (condicao, etapa) => {
    if (!condicao) throw new JulgamentoContextError(JULGAMENTO_ERROS.CONTEXTO_INCONSISTENTE, { etapa });
};

const validarEntrada = (evento, idParticipacao, idUsuario, payload) => {
    const valido = camposExatos(payload, ['contexto', 'versao', 'estado', 'notas', 'possivelDesclassificacao', 'motivoDesclassificacao'])
        && camposExatos(payload.contexto, ['idCiclo', 'numeroTentativa'])
        && idValido(payload.contexto.idCiclo)
        && (payload.contexto.numeroTentativa === null || idValido(payload.contexto.numeroTentativa))
        && Number.isSafeInteger(payload.versao) && payload.versao >= 0 && payload.versao <= UINT_MAX
        && (payload.contexto.numeroTentativa === null ? payload.versao === 0 : payload.versao > 0)
        && ['rascunho', 'concluida'].includes(payload.estado) && Array.isArray(payload.notas)
        && typeof payload.possivelDesclassificacao === 'boolean';
    if (!idValido(idParticipacao) || !idValido(idUsuario, 2147483647) || !valido) falhar(GRAVACAO_ERROS.PAYLOAD_INVALIDO);
    const motivo = payload.motivoDesclassificacao;
    if (payload.possivelDesclassificacao
        ? typeof motivo !== 'string' || !textoValido(motivo.trim(), 2000)
        : motivo !== null) falhar(GRAVACAO_ERROS.PAYLOAD_INVALIDO);
    const vistos = new Set();
    const notas = [];
    for (const item of payload.notas) {
        if (!camposExatos(item, ['idCriterioCiclo', 'nota']) || !idValido(item.idCriterioCiclo)
            || vistos.has(item.idCriterioCiclo) || !Number.isInteger(item.nota) || item.nota < 0 || item.nota > 100) {
            falhar(GRAVACAO_ERROS.PAYLOAD_INVALIDO);
        }
        vistos.add(item.idCriterioCiclo);
        notas.push({ idCriterioCiclo: item.idCriterioCiclo, nota: item.nota });
    }
    exigir(typeof evento === 'number' ? idValido(evento)
        : objeto(evento) && idValido(evento.id) && textoValido(evento.slug, 255) && textoValido(evento.nome, 255), 'entrada');
    return {
        evento: typeof evento === 'number' ? evento : { id: evento.id, slug: evento.slug, nome: evento.nome },
        contexto: { ...payload.contexto }, versao: payload.versao, estado: payload.estado,
        notas: notas.sort((a, b) => a.idCriterioCiclo - b.idCriterioCiclo),
        sinal: payload.possivelDesclassificacao ? 1 : 0,
        motivo: payload.possivelDesclassificacao ? motivo.trim() : null
    };
};

const COLUNAS_JULGAMENTO = 'id_evento, id_ciclo_atual, id_publicacao_vigente, quantidade_classificados, versao';
const COLUNAS_CICLO = `id_ciclo, id_evento, numero_ciclo, estado, id_ciclo_origem,
    id_publicacao_origem, publicado_em, motivo_reabertura`;
const COLUNAS_JURADO = 'id_ciclo, id_evento, id_usuario, nome_publico, estado_participacao';
const COLUNAS_PARTICIPANTE = `id_ciclo_concorrente, id_ciclo, id_evento, id_concorrente, id_usuario,
    numero_concorrente, nome_publico, id_obra_1, obra_1_publica, link_video_1,
    id_obra_2, obra_2_publica, link_video_2, fingerprint, estado_participacao`;
const COLUNAS_CRITERIOS = 'id_criterio_ciclo, id_criterio_origem, id_ciclo, id_evento, nome, descricao, ordem, peso';
const COLUNAS_AVALIACAO = `id_avaliacao, id_evento, id_ciclo, id_jurado, id_concorrente,
    numero_tentativa, id_avaliacao_origem, estado, versao, possivel_desclassificacao,
    motivo_desclassificacao, data_inclusao, data_atualizacao, data_conclusao`;

const exigirAutorizacao = decisao => {
    if (decisao.podeGravar) return;
    if (decisao.code === JULGAMENTO_ERROS.JURADO_FORA_ROSTER) falhar(GRAVACAO_ERROS.ACESSO_OPERACIONAL_NEGADO);
    if ([JULGAMENTO_ERROS.JURADO_NAO_INCLUIDO, JULGAMENTO_ERROS.CONCORRENTE_NAO_INCLUIDO].includes(decisao.code)) {
        falhar(GRAVACAO_ERROS.CONTEXTO_NAO_GRAVAVEL, { motivo: decisao.code });
    }
    if (Object.values(AUTORIZACAO_ERROS).includes(decisao.code)) {
        falhar(decisao.code, decisao.motivo === 'limite_versao' ? { motivo: decisao.motivo } : {});
    }
    throw new JulgamentoContextError(decisao.code);
};

const validarNotasExistentes = (rows, avaliacao, criterios) => {
    const porId = new Map(criterios.map(c => [c.id_criterio_ciclo, c]));
    const vistos = new Set();
    for (const row of rows) {
        const criterio = row && porId.get(row.id_criterio_ciclo);
        exigir(criterio && row.id_avaliacao === avaliacao.id_avaliacao && row.id_evento === avaliacao.id_evento
            && row.id_ciclo === avaliacao.id_ciclo && row.id_criterio === criterio.id_criterio_origem
            && !vistos.has(row.id_criterio_ciclo) && Number.isInteger(row.nota) && row.nota >= 0 && row.nota <= 100, 'notas_existentes');
        vistos.add(row.id_criterio_ciclo);
    }
};

// mysql2 nao fornece o nome do indice como campo estruturado. Formatos desconhecidos permanecem erros SQL.
export const duplicidadeTentativa = error => {
    if (error?.code !== 'ER_DUP_ENTRY' || error.errno !== 1062 || typeof error.sqlMessage !== 'string') return false;
    return /^Duplicate entry '[^\r\n]*' for key '(?:ist_eventos_avaliacoes\.)?uq_avaliacao_tentativa'$/.test(error.sqlMessage);
};
const concorrencia = error => (error?.code === 'ER_LOCK_DEADLOCK' && error.errno === 1213)
    || (error?.code === 'ER_LOCK_WAIT_TIMEOUT' && error.errno === 1205);
const logSeguro = (...args) => {
    try {
        console.error(...args);
    } catch {
        // Logging nao pode alterar o resultado transacional ou impedir cleanup.
    }
};
const logCleanup = (etapa, commitConfirmed) => logSeguro('Falha de cleanup de avaliacao cycle-aware.', { etapa, commitConfirmed });

// Todas as operacoes institucionais do evento devem bloquear julgamento antes de ciclo/snapshots/historico.
export const salvarAvaliacaoJuradoCycleAware = async (evento, idParticipacao, idUsuarioAutenticado, payload, poolExecutor = db) => {
    const dados = validarEntrada(evento, idParticipacao, idUsuarioAutenticado, payload);
    let connection;
    let transactionStarted = false;
    let commitConfirmed = false;
    let commitAttempted = false;
    let reusable = false;
    let primaryError;
    let destroyed = false;
    const destruir = () => {
        reusable = false;
        if (destroyed) return;
        destroyed = true;
        try { connection.destroy(); } catch { logCleanup('destroy', commitConfirmed); }
    };
    try {
        connection = await poolExecutor.getConnection();
        await connection.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
        await connection.beginTransaction();
        transactionStarted = true;
        reusable = true;
        let identificado = dados.evento;
        if (typeof identificado === 'number') {
            // Identificacao minima apos BEGIN; nao seleciona ciclo ou tentativa.
            const [eventos] = await connection.query('SELECT id, slug, nome FROM ist_eventos WHERE id = ?', [identificado]);
            if (eventos.length === 0) throw new JulgamentoContextError(JULGAMENTO_ERROS.EVENTO_INEXISTENTE);
            exigir(eventos.length === 1 && eventos[0].id === identificado, 'evento');
            identificado = eventos[0];
        }
        const [julgamentos] = await connection.query(
            `SELECT ${COLUNAS_JULGAMENTO} FROM ist_eventos_julgamentos WHERE id_evento = ? FOR UPDATE`, [identificado.id]
        );
        if (julgamentos.length === 0) throw new JulgamentoContextError(JULGAMENTO_ERROS.JULGAMENTO_NAO_CONFIGURADO);
        exigir(julgamentos.length === 1 && julgamentos[0].id_evento === identificado.id, 'julgamento');
        const julgamento = julgamentos[0];
        if (julgamento.id_ciclo_atual === null) throw new JulgamentoContextError(JULGAMENTO_ERROS.CICLO_ATUAL_AUSENTE);
        exigir(idValido(julgamento.id_ciclo_atual), 'julgamento');
        const [ciclos] = await connection.query(
            `SELECT ${COLUNAS_CICLO} FROM ist_eventos_ciclos WHERE id_ciclo = ? FOR UPDATE`, [julgamento.id_ciclo_atual]
        );
        exigir(ciclos.length === 1 && ciclos[0].id_ciclo === julgamento.id_ciclo_atual
            && ciclos[0].id_evento === identificado.id, 'ciclo');
        const ciclo = ciclos[0];
        const contexto = await resolverContextoJulgamento(identificado, connection);
        exigir(contexto.id_evento === julgamento.id_evento && contexto.id_ciclo_atual === ciclo.id_ciclo
            && contexto.id_publicacao_vigente === julgamento.id_publicacao_vigente
            && contexto.quantidade_classificados === julgamento.quantidade_classificados && contexto.versao === julgamento.versao
            && contexto.numero_ciclo === ciclo.numero_ciclo && contexto.estado_ciclo === ciclo.estado
            && contexto.id_ciclo_origem === ciclo.id_ciclo_origem && contexto.id_publicacao_origem === ciclo.id_publicacao_origem, 'contexto_bloqueado');
        if (dados.contexto.idCiclo !== contexto.id_ciclo_atual) falhar(GRAVACAO_ERROS.CICLO_DESATUALIZADO);
        const par = { id_evento: identificado.id, id_ciclo: ciclo.id_ciclo, id_jurado: idUsuarioAutenticado, id_concorrente: idParticipacao };
        let criterios, notas, efetiva;
        const autorizacao = await avaliarAutorizacaoGravacao({
            contexto, idUsuario: idUsuarioAutenticado, idParticipacao,
            live: () => carregarElegibilidadeLiveGravacao(connection, identificado.id, idUsuarioAutenticado, { bloquear: true }),
            jurado: async () => {
                const [jurados] = await connection.query(
                    `SELECT ${COLUNAS_JURADO} FROM ist_eventos_ciclos_jurados
                     WHERE id_ciclo = ? AND id_usuario = ? LOCK IN SHARE MODE`, [ciclo.id_ciclo, idUsuarioAutenticado]
                );
                const jurado = await resolverJuradoCiclo(contexto, idUsuarioAutenticado, connection, { exigirIncluido: true });
                exigir(jurados.length === 1 && isDeepStrictEqual(jurados[0], jurado), 'roster_bloqueado');
                return jurado;
            },
            participante: async () => {
                const [participantes] = await connection.query(
                    `SELECT ${COLUNAS_PARTICIPANTE} FROM ist_eventos_ciclos_concorrentes
                     WHERE id_ciclo = ? AND id_concorrente = ? LOCK IN SHARE MODE`, [ciclo.id_ciclo, idParticipacao]
                );
                const participante = await resolverConcorrenteCiclo(contexto, idParticipacao, connection, { exigirIncluido: true });
                exigir(participantes.length === 1 && isDeepStrictEqual(participantes[0], participante), 'participante_bloqueado');
                return participante;
            },
            criterios: async () => {
                const [bloqueados] = await connection.query(
                    `SELECT ${COLUNAS_CRITERIOS} FROM ist_eventos_ciclos_criterios
                     WHERE id_ciclo = ? ORDER BY id_criterio_ciclo LOCK IN SHARE MODE`, [ciclo.id_ciclo]
                );
                criterios = await carregarCriteriosCiclo(contexto, connection);
                const porId = rows => [...rows].sort((a, b) => a.id_criterio_ciclo - b.id_criterio_ciclo);
                exigir(isDeepStrictEqual(porId(bloqueados), porId(criterios)), 'criterios_bloqueados');
                return criterios;
            },
            efetiva: async () => {
                // Payload continua responsabilidade do writer, antes do lock de historico como anteriormente.
                const mapa = new Map(criterios.map(c => [c.id_criterio_ciclo, c]));
                notas = dados.notas.map(item => {
                    const criterio = mapa.get(item.idCriterioCiclo);
                    if (!criterio) falhar(GRAVACAO_ERROS.PAYLOAD_INVALIDO, { motivo: 'criterio_fora_snapshot' });
                    return { ...item, idCriterioOrigem: criterio.id_criterio_origem };
                });
                if (dados.estado === 'concluida' && notas.length !== criterios.length) {
                    falhar(GRAVACAO_ERROS.PAYLOAD_INVALIDO, { motivo: 'conclusao_incompleta' });
                }
                const [historico] = await connection.query(
                    `SELECT ${COLUNAS_AVALIACAO} FROM ist_eventos_avaliacoes
                     WHERE id_evento = ? AND id_ciclo = ? AND id_jurado = ? AND id_concorrente = ?
                     ORDER BY numero_tentativa, id_avaliacao FOR UPDATE`,
                    [par.id_evento, par.id_ciclo, par.id_jurado, par.id_concorrente]
                );
                efetiva = interpretarTentativasCiclo(historico, par);
                if ((efetiva?.numero_tentativa ?? null) !== dados.contexto.numeroTentativa) falhar(GRAVACAO_ERROS.TENTATIVA_DESATUALIZADA);
                return efetiva;
            }
        });
        // Preserva conflito de versao antes do limite de incremento; demais negacoes precedem o token.
        if ((autorizacao.podeGravar || autorizacao.motivo === 'limite_versao')
            && (efetiva?.versao ?? 0) !== dados.versao) falhar(GRAVACAO_ERROS.VERSAO_DESATUALIZADA);
        exigirAutorizacao(autorizacao);
        let idAvaliacao = efetiva?.id_avaliacao;
        const numeroTentativa = efetiva ? efetiva.numero_tentativa : 1;
        const versao = dados.versao + 1;
        if (efetiva) {
            const [anteriores] = await connection.query(
                `SELECT id_avaliacao, id_evento, id_ciclo, id_criterio, id_criterio_ciclo, nota
                 FROM ist_eventos_avaliacoes_notas WHERE id_avaliacao = ?`, [idAvaliacao]
            );
            validarNotasExistentes(anteriores, efetiva, criterios);
            const [result] = await connection.query(
                `UPDATE ist_eventos_avaliacoes SET estado = ?, versao = ?, possivel_desclassificacao = ?,
                 motivo_desclassificacao = ?, data_atualizacao = CURRENT_TIMESTAMP,
                 data_conclusao = CASE WHEN ? = 'concluida' THEN CURRENT_TIMESTAMP ELSE NULL END
                 WHERE id_avaliacao = ? AND id_evento = ? AND id_ciclo = ? AND id_jurado = ? AND id_concorrente = ?
                 AND numero_tentativa = ? AND estado = 'rascunho' AND versao = ?`,
                [dados.estado, versao, dados.sinal, dados.motivo, dados.estado,
                    idAvaliacao, par.id_evento, par.id_ciclo, par.id_jurado, par.id_concorrente, numeroTentativa, dados.versao]
            );
            if (result.affectedRows === 0) falhar(GRAVACAO_ERROS.VERSAO_DESATUALIZADA);
            exigir(result.affectedRows === 1, 'update');
        } else {
            try {
                const [result] = await connection.query(
                    `INSERT INTO ist_eventos_avaliacoes
                     (id_evento, id_ciclo, id_jurado, id_concorrente, numero_tentativa, id_avaliacao_origem,
                      estado, versao, possivel_desclassificacao, motivo_desclassificacao, data_conclusao)
                     VALUES (?, ?, ?, ?, 1, NULL, ?, 1, ?, ?, CASE WHEN ? = 'concluida' THEN CURRENT_TIMESTAMP ELSE NULL END)`,
                    [par.id_evento, par.id_ciclo, par.id_jurado, par.id_concorrente, dados.estado, dados.sinal, dados.motivo, dados.estado]
                );
                exigir(result.affectedRows === 1 && idValido(result.insertId), 'insert');
                idAvaliacao = result.insertId;
            } catch (error) {
                if (duplicidadeTentativa(error)) falhar(GRAVACAO_ERROS.CONFLITO_CONCORRENCIA);
                throw error;
            }
        }
        await connection.query(
            'DELETE FROM ist_eventos_avaliacoes_notas WHERE id_avaliacao = ? AND id_evento = ? AND id_ciclo = ?',
            [idAvaliacao, par.id_evento, par.id_ciclo]
        );
        if (notas.length > 0) {
            await connection.query(
                `INSERT INTO ist_eventos_avaliacoes_notas
                 (id_avaliacao, id_criterio, id_evento, id_ciclo, id_criterio_ciclo, nota)
                 VALUES ${notas.map(() => '(?, ?, ?, ?, ?, ?)').join(', ')}`,
                notas.flatMap(item => [idAvaliacao, item.idCriterioOrigem, par.id_evento, par.id_ciclo, item.idCriterioCiclo, item.nota])
            );
        }
        const resposta = await obterAvaliacaoJuradoCycleAware(identificado, idParticipacao, idUsuarioAutenticado, connection);
        exigir(resposta.contexto.idCiclo === par.id_ciclo && resposta.contexto.numeroTentativa === numeroTentativa
            && resposta.versao === versao && resposta.estado === dados.estado && resposta.avaliacao?.idAvaliacao === idAvaliacao, 'releitura');
        commitAttempted = true;
        await connection.commit();
        commitConfirmed = true;
        transactionStarted = false;
        return resposta;
    } catch (error) {
        primaryError = error;
        if (connection && transactionStarted && !commitConfirmed) {
            try {
                await connection.rollback();
                transactionStarted = false;
            } catch {
                logCleanup('rollback', commitConfirmed);
                destruir();
            }
        }
        // COMMIT sem confirmacao pode ter persistido; a conexao nao deve ser reutilizada.
        if (connection && (!reusable || commitAttempted)) destruir();
        if (!commitAttempted && concorrencia(primaryError)) {
            logSeguro('Conflito de concorrencia de avaliacao cycle-aware.');
            throw new JuradoAvaliacaoGravacaoError(GRAVACAO_ERROS.CONFLITO_CONCORRENCIA);
        }
        throw primaryError;
    } finally {
        if (connection && reusable && !destroyed) {
            try { connection.release(); } catch {
                logCleanup('release', commitConfirmed);
                destruir();
            }
        }
    }
};
