import { pool as db } from '../config/db.js';
import { SQL_ELEGIBILIDADE_CONCORRENTE, SQL_JOINS_CONCORRENTE, consultarConcorrenteJurado } from './juradoFilaService.js';

const UINT_MAX = 4294967295;
const CONFIGURACAO_INDISPONIVEL = 'Configura\u00e7\u00e3o de avalia\u00e7\u00e3o indispon\u00edvel';
const CAMPOS_PAYLOAD = ['versao', 'estado', 'notas', 'possivelDesclassificacao', 'motivoDesclassificacao'];
const COLUNAS_AVALIACAO = `id_avaliacao, id_evento, id_concorrente, id_jurado, estado,
    versao, possivel_desclassificacao, motivo_desclassificacao,
    data_inclusao, data_atualizacao, data_conclusao`;

export class JuradoAvaliacaoError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

const configuracaoInvalida = () => {
    throw new JuradoAvaliacaoError(409, CONFIGURACAO_INDISPONIVEL);
};

const inteiroId = (valor) => Number.isSafeInteger(valor) && valor > 0 && valor <= UINT_MAX;
const objeto = (valor) => valor !== null && typeof valor === 'object' && !Array.isArray(valor);
const camposExatos = (valor, campos) => objeto(valor)
    && Object.keys(valor).length === campos.length
    && campos.every((campo) => Object.prototype.hasOwnProperty.call(valor, campo));

const pesoEmCentesimos = (peso) => {
    if (typeof peso !== 'string' || !/^\d{1,3}(?:\.\d{1,2})?$/.test(peso)) configuracaoInvalida();
    const [inteira, fracao = ''] = peso.split('.');
    const centesimos = BigInt(inteira) * 100n + BigInt(fracao.padEnd(2, '0'));
    if (centesimos <= 0n || centesimos > 10000n) configuracaoInvalida();
    return centesimos;
};

const decimalDuasCasas = (valor) => `${valor / 100n}.${String(valor % 100n).padStart(2, '0')}`;

const validarConfiguracao = (rows) => {
    if (rows.some((row) => row.ativo !== 0 && row.ativo !== 1)) configuracaoInvalida();
    const ativos = rows.filter((row) => row.ativo === 1);
    if (ativos.length === 0) configuracaoInvalida();
    const ids = new Set();
    const ordens = new Set();
    let soma = 0n;
    const criterios = ativos.map((row) => {
        if (!inteiroId(row.id_criterio) || ids.has(row.id_criterio)
            || !Number.isInteger(row.ordem) || row.ordem <= 0 || ordens.has(row.ordem)) configuracaoInvalida();
        ids.add(row.id_criterio);
        ordens.add(row.ordem);
        const peso = pesoEmCentesimos(row.peso);
        soma += peso;
        return { idCriterio: row.id_criterio, nome: row.nome, descricao: row.descricao, ordem: row.ordem, peso: decimalDuasCasas(peso) };
    });
    if (soma !== 10000n) configuracaoInvalida();
    return criterios.sort((primeiro, segundo) => primeiro.ordem - segundo.ordem || primeiro.idCriterio - segundo.idCriterio);
};

export const calcularMediaPonderada = (criterios, notas) => {
    const porId = new Map(criterios.map((criterio) => [criterio.idCriterio, criterio]));
    const vistos = new Set();
    for (const item of notas) {
        if (!porId.has(item.idCriterio) || vistos.has(item.idCriterio)
            || !Number.isInteger(item.nota) || item.nota < 0 || item.nota > 100) configuracaoInvalida();
        vistos.add(item.idCriterio);
    }
    if (criterios.length === 0 || vistos.size !== criterios.length) return null;
    let numerador = 0n;
    let denominador = 0n;
    for (const item of notas) {
        const peso = pesoEmCentesimos(porId.get(item.idCriterio).peso);
        numerador += BigInt(item.nota) * peso;
        denominador += peso;
    }
    return decimalDuasCasas((numerador * 200n + denominador) / (denominador * 2n));
};

export const validarPayloadAvaliacao = (payload, criterios) => {
    const invalido = (message) => { throw new JuradoAvaliacaoError(400, message); };
    if (!camposExatos(payload, CAMPOS_PAYLOAD)) invalido('Payload de avalia\u00e7\u00e3o inv\u00e1lido.');
    if (!Number.isSafeInteger(payload.versao) || payload.versao < 0 || payload.versao > UINT_MAX
        || !['rascunho', 'concluida'].includes(payload.estado)
        || !Array.isArray(payload.notas) || typeof payload.possivelDesclassificacao !== 'boolean'
        || (payload.motivoDesclassificacao !== null && typeof payload.motivoDesclassificacao !== 'string')) {
        invalido('Dados de avalia\u00e7\u00e3o inv\u00e1lidos.');
    }
    const ativos = new Set(criterios.map((criterio) => criterio.idCriterio));
    const vistos = new Set();
    const notas = payload.notas.map((item) => {
        if (!camposExatos(item, ['idCriterio', 'nota']) || !inteiroId(item.idCriterio)
            || !ativos.has(item.idCriterio) || vistos.has(item.idCriterio)
            || !Number.isInteger(item.nota) || item.nota < 0 || item.nota > 100) invalido('Notas de avalia\u00e7\u00e3o inv\u00e1lidas.');
        vistos.add(item.idCriterio);
        return { idCriterio: item.idCriterio, nota: item.nota };
    }).sort((primeiro, segundo) => primeiro.idCriterio - segundo.idCriterio);
    if (payload.estado === 'concluida' && vistos.size !== ativos.size) invalido('Informe todas as notas para concluir a avalia\u00e7\u00e3o.');
    const motivo = payload.possivelDesclassificacao ? payload.motivoDesclassificacao?.trim() : null;
    if (payload.possivelDesclassificacao && (!motivo || Array.from(motivo).length > 2000)) {
        invalido('Informe um motivo v\u00e1lido para a sinaliza\u00e7\u00e3o.');
    }
    return { versao: payload.versao, estado: payload.estado, notas, possivelDesclassificacao: payload.possivelDesclassificacao, motivoDesclassificacao: motivo };
};

const montarResposta = (evento, participacao, criterios, avaliacao, notas) => {
    const media = avaliacao ? calcularMediaPonderada(criterios, notas) : null;
    if (avaliacao && (!['rascunho', 'concluida'].includes(avaliacao.estado)
        || !inteiroId(avaliacao.versao) || (avaliacao.estado === 'concluida' && media === null))) configuracaoInvalida();
    return {
        evento: { id: evento.id, slug: evento.slug, nome: evento.nome },
        concorrente: { idParticipacao: participacao.id_concorrente, numeroConcorrente: participacao.numero_concorrente },
        estado: avaliacao?.estado || 'pendente',
        versao: avaliacao?.versao || 0,
        escala: { min: 0, max: 100, passo: 1 },
        criterios,
        avaliacao: avaliacao ? {
            idAvaliacao: avaliacao.id_avaliacao,
            notas: [...notas].sort((primeiro, segundo) => primeiro.idCriterio - segundo.idCriterio),
            possivelDesclassificacao: Boolean(avaliacao.possivel_desclassificacao),
            motivoDesclassificacao: avaliacao.motivo_desclassificacao,
            media,
            dataInclusao: avaliacao.data_inclusao,
            dataAtualizacao: avaliacao.data_atualizacao,
            dataConclusao: avaliacao.data_conclusao
        } : null
    };
};

export const obterAvaliacaoJurado = async (evento, idParticipacao, idJurado, executor = db) => {
    const [rows] = await executor.query(
        `SELECT c.id_concorrente AS id_participacao, c.numero_concorrente,
                cr.id_criterio, cr.nome, cr.descricao, cr.ordem, cr.peso, cr.ativo,
                a.id_avaliacao, a.estado, a.versao, a.possivel_desclassificacao,
                a.motivo_desclassificacao, a.data_inclusao, a.data_atualizacao, a.data_conclusao,
                n.id_criterio AS id_criterio_nota, n.nota,
                (SELECT COUNT(*) FROM ist_eventos_avaliacoes_notas nt WHERE nt.id_avaliacao = a.id_avaliacao) AS quantidade_notas
         ${SQL_JOINS_CONCORRENTE}
         LEFT JOIN ist_eventos_criterios_avaliacao cr ON cr.id_evento = c.id_evento
         LEFT JOIN ist_eventos_avaliacoes a ON a.id_evento = c.id_evento AND a.id_concorrente = c.id_concorrente AND a.id_jurado = ?
         LEFT JOIN ist_eventos_avaliacoes_notas n ON n.id_avaliacao = a.id_avaliacao AND n.id_criterio = cr.id_criterio AND n.id_evento = c.id_evento
         WHERE ${SQL_ELEGIBILIDADE_CONCORRENTE} AND c.id_concorrente = ?
         ORDER BY cr.ordem, cr.id_criterio`,
        [idJurado, evento.id, idParticipacao]
    );
    if (rows.length === 0) throw new JuradoAvaliacaoError(404, 'Concorrente indispon\u00edvel.');
    const criterios = validarConfiguracao(rows.filter((row) => row.id_criterio !== null));
    const notas = rows.filter((row) => row.id_criterio_nota !== null).map((row) => ({ idCriterio: row.id_criterio_nota, nota: row.nota }));
    if (notas.length !== Number(rows[0].quantidade_notas)) configuracaoInvalida();
    return montarResposta(evento, { id_concorrente: rows[0].id_participacao, numero_concorrente: rows[0].numero_concorrente }, criterios,
        rows[0].id_avaliacao === null ? null : rows[0], notas);
};

const revalidarJurado = async (connection, idEvento, idJurado) => {
    const [usuarios] = await connection.query(
        'SELECT id_tipo_usuario, id_situacao, id_cargo FROM ist_usuarios WHERE id_usuario = ? LOCK IN SHARE MODE', [idJurado]
    );
    const usuario = usuarios[0];
    if (!usuario || usuario.id_tipo_usuario !== 4 || usuario.id_situacao !== 8 || usuario.id_cargo !== 11) {
        throw new JuradoAvaliacaoError(403, 'Acesso ao evento n\u00e3o autorizado.');
    }
    const [designacoes] = await connection.query(
        'SELECT ativo FROM ist_eventos_jurados WHERE id_evento = ? AND id_usuario = ? LOCK IN SHARE MODE', [idEvento, idJurado]
    );
    if (designacoes[0]?.ativo !== 1) throw new JuradoAvaliacaoError(403, 'Acesso ao evento n\u00e3o autorizado.');
};

const lerAvaliacaoBloqueada = async (connection, idAvaliacao, idEvento, idParticipacao, idJurado) => {
    const [rows] = await connection.query(
        `SELECT ${COLUNAS_AVALIACAO} FROM ist_eventos_avaliacoes
         WHERE id_avaliacao = ? AND id_evento = ? AND id_concorrente = ? AND id_jurado = ? FOR UPDATE`,
        [idAvaliacao, idEvento, idParticipacao, idJurado]
    );
    if (!rows[0]) throw new JuradoAvaliacaoError(409, 'Conflito de avalia\u00e7\u00e3o. Consulte novamente.');
    return rows[0];
};

export const salvarAvaliacaoJurado = async (evento, idParticipacao, idJurado, payload, pool = db) => {
    let connection;
    let transacaoIniciada = false;
    try {
        connection = await pool.getConnection();
        transacaoIniciada = true;
        await connection.beginTransaction();
        await revalidarJurado(connection, evento.id, idJurado);
        const [participacoes] = await connection.query(
            `SELECT c.id_concorrente, c.numero_concorrente FROM ist_concorrentes c
             WHERE ${SQL_ELEGIBILIDADE_CONCORRENTE} AND c.id_concorrente = ? LOCK IN SHARE MODE`,
            [evento.id, idParticipacao]
        );
        if (!participacoes[0] || !await consultarConcorrenteJurado(evento.id, idParticipacao, connection)) {
            throw new JuradoAvaliacaoError(404, 'Concorrente indispon\u00edvel.');
        }
        const [configuracao] = await connection.query(
            `SELECT id_criterio, nome, descricao, ordem, peso, ativo FROM ist_eventos_criterios_avaliacao
             WHERE id_evento = ? ORDER BY ordem, id_criterio LOCK IN SHARE MODE`, [evento.id]
        );
        const [existentes] = await connection.query(
            'SELECT id_avaliacao FROM ist_eventos_avaliacoes WHERE id_evento = ? AND id_jurado = ? AND id_concorrente = ?',
            [evento.id, idJurado, idParticipacao]
        );
        let avaliacao = existentes[0] ? await lerAvaliacaoBloqueada(connection, existentes[0].id_avaliacao, evento.id, idParticipacao, idJurado) : null;
        if (avaliacao?.estado === 'concluida') throw new JuradoAvaliacaoError(409, 'Avalia\u00e7\u00e3o conclu\u00edda n\u00e3o pode ser alterada.');
        const criterios = validarConfiguracao(configuracao);
        const dados = validarPayloadAvaliacao(payload, criterios);
        if (dados.versao !== (avaliacao?.versao || 0) || (avaliacao && avaliacao.versao >= UINT_MAX)) {
            throw new JuradoAvaliacaoError(409, 'Conflito de vers\u00e3o. Consulte novamente.');
        }
        if (!avaliacao) {
            try {
                const [result] = await connection.query(
                    `INSERT INTO ist_eventos_avaliacoes
                     (id_evento, id_concorrente, id_jurado, estado, possivel_desclassificacao, motivo_desclassificacao, versao, data_conclusao)
                     VALUES (?, ?, ?, ?, ?, ?, 1, CASE WHEN ? = 'concluida' THEN CURRENT_TIMESTAMP ELSE NULL END)`,
                    [evento.id, idParticipacao, idJurado, dados.estado, dados.possivelDesclassificacao ? 1 : 0, dados.motivoDesclassificacao, dados.estado]
                );
                avaliacao = { id_avaliacao: result.insertId, versao: 1 };
            } catch (error) {
                if (error.code === 'ER_DUP_ENTRY' || error.errno === 1062) throw new JuradoAvaliacaoError(409, 'Conflito de avalia\u00e7\u00e3o. Consulte novamente.');
                throw error;
            }
        } else {
            const [atualizacao] = await connection.query(
            `UPDATE ist_eventos_avaliacoes
             SET estado = ?, possivel_desclassificacao = ?, motivo_desclassificacao = ?, versao = ?,
                 data_atualizacao = CURRENT_TIMESTAMP,
                 data_conclusao = CASE WHEN ? = 'concluida' THEN CURRENT_TIMESTAMP ELSE NULL END
             WHERE id_avaliacao = ? AND id_evento = ? AND id_jurado = ? AND id_concorrente = ? AND estado = 'rascunho' AND versao = ?`,
                [dados.estado, dados.possivelDesclassificacao ? 1 : 0, dados.motivoDesclassificacao, dados.versao + 1, dados.estado,
                    avaliacao.id_avaliacao, evento.id, idJurado, idParticipacao, dados.versao]
            );
            if (atualizacao.affectedRows !== 1) throw new JuradoAvaliacaoError(409, 'Conflito de avalia\u00e7\u00e3o. Consulte novamente.');
        }
        await connection.query('DELETE FROM ist_eventos_avaliacoes_notas WHERE id_avaliacao = ? AND id_evento = ?', [avaliacao.id_avaliacao, evento.id]);
        if (dados.notas.length > 0) {
            const valores = dados.notas.map(() => '(?, ?, ?, ?)').join(', ');
            await connection.query(
                `INSERT INTO ist_eventos_avaliacoes_notas (id_avaliacao, id_criterio, id_evento, nota) VALUES ${valores}`,
                dados.notas.flatMap((item) => [avaliacao.id_avaliacao, item.idCriterio, evento.id, item.nota])
            );
        }
        const atual = await lerAvaliacaoBloqueada(connection, avaliacao.id_avaliacao, evento.id, idParticipacao, idJurado);
        const resposta = montarResposta(evento, participacoes[0], criterios, atual, dados.notas);
        await connection.commit();
        transacaoIniciada = false;
        return resposta;
    } catch (error) {
        if (connection && transacaoIniciada) {
            try {
                await connection.rollback();
                transacaoIniciada = false;
            } catch (rollbackError) {
                console.error('Erro ao desfazer avalia\u00e7\u00e3o de jurado:', rollbackError);
                connection.destroy();
                connection = null;
            }
        }
        if (error.code === 'ER_LOCK_DEADLOCK' || error.code === 'ER_LOCK_WAIT_TIMEOUT' || [1205, 1213].includes(error.errno)) {
            throw new JuradoAvaliacaoError(409, 'Conflito tempor\u00e1rio de avalia\u00e7\u00e3o. Consulte novamente.');
        }
        throw error;
    } finally {
        if (connection) connection.release();
    }
};