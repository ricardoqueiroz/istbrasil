import { pool as db } from '../config/db.js';
import { SQL_ELEGIBILIDADE_CONCORRENTE, SQL_JOINS_CONCORRENTE } from './juradoFilaService.js';

export const CAMPOS_ORDENACAO_ADMIN_AVALIACOES = Object.freeze({
    numeroConcorrente: 'c.numero_concorrente',
    nome: 'u.nome'
});

export class AdminAvaliacoesError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

const inconsistente = () => {
    throw new AdminAvaliacoesError(409, 'Dados de acompanhamento indispon\u00edveis.');
};
const idValido = (valor) => Number.isSafeInteger(valor) && valor > 0;

export const consultarAndamentoAdmin = async (slug, { page, limit, sortField, sortOrder }, pool = db) => {
    if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100
        || !Number.isSafeInteger((page - 1) * limit)
        || !Object.prototype.hasOwnProperty.call(CAMPOS_ORDENACAO_ADMIN_AVALIACOES, sortField)
        || !['asc', 'desc'].includes(sortOrder)) {
        throw new AdminAvaliacoesError(400, 'Par\u00e2metros de listagem inv\u00e1lidos.');
    }
    let connection;
    let transacao = false;
    let erroOriginal;
    try {
        connection = await pool.getConnection();
        await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
        transacao = true;
        await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');

        const [eventos] = await connection.query('SELECT id, slug, nome FROM ist_eventos WHERE slug = ?', [slug]);
        const evento = eventos[0];
        if (!evento) throw new AdminAvaliacoesError(404, 'Evento indispon\u00edvel.');
        if (eventos.length !== 1 || !idValido(evento.id) || evento.slug !== slug) inconsistente();

        const [jurados] = await connection.query(
            `SELECT j.id_usuario FROM ist_eventos_jurados j
             INNER JOIN ist_usuarios u ON u.id_usuario = j.id_usuario
             WHERE j.id_evento = ? AND j.ativo = 1 AND u.id_tipo_usuario = 4 AND u.id_situacao = 8 AND u.id_cargo = 11`, [evento.id]
        );
        const atuais = new Set(jurados.map((jurado) => jurado.id_usuario));
        if (atuais.size !== jurados.length || jurados.some((jurado) => !idValido(jurado.id_usuario))) inconsistente();

        const base = `${SQL_JOINS_CONCORRENTE} WHERE ${SQL_ELEGIBILIDADE_CONCORRENTE}`;
        const [totais] = await connection.query(`SELECT COUNT(*) AS total ${base}`, [evento.id]);
        const total = Number(totais[0]?.total);
        if (!Number.isSafeInteger(total) || total < 0) inconsistente();
        const direcao = sortOrder === 'desc' ? 'DESC' : 'ASC';
        const [participacoes] = await connection.query(
            `SELECT c.id_concorrente, c.numero_concorrente, u.nome ${base}
             ORDER BY ${CAMPOS_ORDENACAO_ADMIN_AVALIACOES[sortField]} ${direcao}, c.id_concorrente ASC LIMIT ? OFFSET ?`,
            [evento.id, limit, (page - 1) * limit]
        );
        if (participacoes.length > limit || participacoes.length > total
            || participacoes.some((participacao) => !idValido(participacao.id_concorrente))
            || new Set(participacoes.map((participacao) => participacao.id_concorrente)).size !== participacoes.length) inconsistente();
        const porParticipacao = new Map(participacoes.map((participacao) => [participacao.id_concorrente, {
            idParticipacao: participacao.id_concorrente,
            numeroConcorrente: participacao.numero_concorrente,
            nome: participacao.nome,
            andamento: { totalJuradosAtuais: atuais.size, concluidasAtuais: 0, rascunhosAtuais: 0, pendentesAtuais: atuais.size },
            historico: { totalAvaliacoesForaDoJuriAtual: 0, concluidas: 0, rascunhos: 0, possuiSinalizacaoPossivelDesclassificacao: false },
            sinalizacoes: { possuiAtual: false, possuiHistorica: false, possuiQualquer: false }
        }]));

        if (participacoes.length > 0) {
            const ids = participacoes.map((participacao) => participacao.id_concorrente);
            const [avaliacoes] = await connection.query(
                `SELECT id_evento, id_concorrente, id_jurado, estado, possivel_desclassificacao
                 FROM ist_eventos_avaliacoes WHERE id_concorrente IN (${ids.map(() => '?').join(', ')})`,
                ids
            );
            for (const avaliacao of avaliacoes) {
                const row = porParticipacao.get(avaliacao.id_concorrente);
                if (!row || avaliacao.id_evento !== evento.id || !idValido(avaliacao.id_jurado)
                    || !['rascunho', 'concluida'].includes(avaliacao.estado)
                    || ![0, 1].includes(avaliacao.possivel_desclassificacao)) inconsistente();
                const sinalizada = avaliacao.possivel_desclassificacao === 1;
                if (atuais.has(avaliacao.id_jurado)) {
                    if (avaliacao.estado === 'concluida') row.andamento.concluidasAtuais += 1;
                    else row.andamento.rascunhosAtuais += 1;
                    row.sinalizacoes.possuiAtual ||= sinalizada;
                } else {
                    row.historico.totalAvaliacoesForaDoJuriAtual += 1;
                    if (avaliacao.estado === 'concluida') row.historico.concluidas += 1;
                    else row.historico.rascunhos += 1;
                    row.historico.possuiSinalizacaoPossivelDesclassificacao ||= sinalizada;
                    row.sinalizacoes.possuiHistorica ||= sinalizada;
                }
                row.sinalizacoes.possuiQualquer = row.sinalizacoes.possuiAtual || row.sinalizacoes.possuiHistorica;
            }
        }
        const data = [...porParticipacao.values()];
        for (const row of data) {
            row.andamento.pendentesAtuais = atuais.size - row.andamento.concluidasAtuais - row.andamento.rascunhosAtuais;
            if (!Number.isSafeInteger(row.andamento.pendentesAtuais) || row.andamento.pendentesAtuais < 0) inconsistente();
        }
        const resposta = {
            evento: { id: evento.id, slug: evento.slug, nome: evento.nome },
            jurados: { totalAtuais: atuais.size },
            data,
            pagination: { page, limit, total, totalPages: total === 0 ? 0 : Math.ceil(total / limit) }
        };
        await connection.commit();
        transacao = false;
        return resposta;
    } catch (error) {
        erroOriginal = error;
        if (connection && transacao) {
            try {
                await connection.rollback();
                transacao = false;
            }
            catch (rollbackError) {
                console.error('Erro ao encerrar snapshot administrativo:', rollbackError);
                const invalida = connection;
                connection = null;
                try { invalida.destroy(); }
                catch (destroyError) { console.error('Erro ao descartar conexao administrativa:', destroyError); }
            }
        }
        throw error;
    } finally {
        if (connection) {
            try { connection.release(); }
            catch (releaseError) {
                try { connection.destroy(); }
                catch (destroyError) { console.error('Erro ao descartar conexao administrativa:', destroyError); }
                if (!erroOriginal) throw releaseError;
                console.error('Erro ao liberar conexao administrativa:', releaseError);
            }
        }
    }
};