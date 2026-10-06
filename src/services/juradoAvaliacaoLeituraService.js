import { pool as db } from '../config/db.js';
import {
    JULGAMENTO_ERROS, JulgamentoContextError, resolverContextoJulgamento,
    resolverJuradoCiclo, resolverConcorrenteCiclo, carregarCriteriosCiclo,
    interpretarTentativasCiclo
} from './julgamentoContextService.js';
import { calcularMediaPonderada } from './juradoAvaliacaoService.js';
import { avaliarAutorizacaoGravacao, carregarElegibilidadeLiveGravacao } from './juradoAvaliacaoAutorizacaoService.js';

const idValido = (valor, maximo = 4294967295) => Number.isSafeInteger(valor) && valor > 0 && valor <= maximo;
const exigir = (condicao, etapa) => {
    if (!condicao) throw new JulgamentoContextError(JULGAMENTO_ERROS.CONTEXTO_INCONSISTENTE, { etapa });
};

const dataValida = (valor) => {
    if (valor instanceof Date) return Number.isFinite(valor.getTime());
    if (typeof valor !== 'string') return false;
    const partes = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})?$/.exec(valor);
    if (!partes) return false;
    const [ano, mes, dia, hora, minuto, segundo] = partes.slice(1, 7).map(Number);
    const bissexto = ano % 4 === 0 && (ano % 100 !== 0 || ano % 400 === 0);
    const dias = [31, bissexto ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return ano >= 1000 && mes >= 1 && mes <= 12 && dia >= 1 && dia <= dias[mes - 1]
        && hora <= 23 && minuto <= 59 && segundo <= 59 && Number.isFinite(Date.parse(valor));
};

const validarAvaliacaoEfetiva = (avaliacao) => {
    exigir(dataValida(avaliacao.data_inclusao) && dataValida(avaliacao.data_atualizacao)
        && ((avaliacao.estado === 'rascunho' && avaliacao.data_conclusao === null)
            || (avaliacao.estado === 'concluida' && dataValida(avaliacao.data_conclusao))), 'avaliacao');
    const sinal = avaliacao.possivel_desclassificacao;
    const motivo = avaliacao.motivo_desclassificacao;
    exigir((sinal === 0 && motivo === null)
        || (sinal === 1 && typeof motivo === 'string' && motivo.trim().length > 0
            && Array.from(motivo).length <= 2000), 'avaliacao');
};

const mapearNotas = (rows, avaliacao, criterios) => {
    exigir(Array.isArray(rows), 'notas');
    const porSnapshot = new Map(criterios.map(criterio => [criterio.idCriterioCiclo, criterio]));
    const vistos = new Set();
    const notas = rows.map(row => {
        exigir(row && typeof row === 'object' && !Array.isArray(row), 'notas');
        const criterio = porSnapshot.get(row.id_criterio_ciclo);
        exigir(row.id_avaliacao === avaliacao.id_avaliacao && row.id_evento === avaliacao.id_evento
            && row.id_ciclo === avaliacao.id_ciclo && criterio
            && row.id_criterio === criterio.idCriterioOrigem && !vistos.has(row.id_criterio_ciclo)
            && Number.isInteger(row.nota) && row.nota >= 0 && row.nota <= 100, 'notas');
        vistos.add(row.id_criterio_ciclo);
        return {
            idCriterio: criterio.idCriterioOrigem,
            idCriterioOrigem: criterio.idCriterioOrigem,
            idCriterioCiclo: criterio.idCriterioCiclo,
            nota: row.nota
        };
    });
    exigir(avaliacao.estado !== 'concluida' || vistos.size === criterios.length, 'notas');
    return notas.sort((a, b) => a.idCriterio - b.idCriterio);
};

// Service interno, sem cutover. O caller fornece identidade autenticada.
// Leitura historica nao concede gravacao: a politica revalida elegibilidade live.
// O executor e compartilhado em toda a leitura. Consistencia multiconsulta exige
// isolamento adequado pelo caller; este service nao gerencia transacao ou locks.
export const obterAvaliacaoJuradoCycleAware = async (evento, idParticipacao, idUsuarioAutenticado, executor = db) => {
    exigir(idValido(idParticipacao) && idValido(idUsuarioAutenticado, 2147483647), 'entrada');
    const contexto = await resolverContextoJulgamento(evento, executor);
    const jurado = await resolverJuradoCiclo(contexto, idUsuarioAutenticado, executor, { exigirIncluido: true });
    const participante = await resolverConcorrenteCiclo(contexto, idParticipacao, executor, { exigirIncluido: true });
    const snapshots = await carregarCriteriosCiclo(contexto, executor);
    const criterios = snapshots.map(row => ({
        idCriterio: row.id_criterio_origem,
        idCriterioOrigem: row.id_criterio_origem,
        idCriterioCiclo: row.id_criterio_ciclo,
        nome: row.nome, descricao: row.descricao, ordem: row.ordem, peso: row.peso
    }));
    const par = {
        id_evento: contexto.id_evento, id_ciclo: contexto.id_ciclo_atual,
        id_jurado: idUsuarioAutenticado, id_concorrente: participante.id_concorrente
    };
    const [tentativas] = await executor.query(
        `SELECT id_avaliacao, id_evento, id_ciclo, id_jurado, id_concorrente,
                numero_tentativa, id_avaliacao_origem, estado, versao,
                possivel_desclassificacao, motivo_desclassificacao,
                data_inclusao, data_atualizacao, data_conclusao
         FROM ist_eventos_avaliacoes
         WHERE id_evento = ? AND id_ciclo = ? AND id_jurado = ? AND id_concorrente = ?
         ORDER BY numero_tentativa, id_avaliacao`,
        [par.id_evento, par.id_ciclo, par.id_jurado, par.id_concorrente]
    );
    const efetiva = interpretarTentativasCiclo(tentativas, par);
    const autorizacao = await avaliarAutorizacaoGravacao({
        contexto, idUsuario: idUsuarioAutenticado, idParticipacao, jurado, participante, criterios: snapshots, efetiva,
        live: () => carregarElegibilidadeLiveGravacao(executor, contexto.id_evento, idUsuarioAutenticado)
    });
    let avaliacao = null;
    if (efetiva) {
        validarAvaliacaoEfetiva(efetiva);
        const [rows] = await executor.query(
            `SELECT id_avaliacao, id_evento, id_ciclo, id_criterio, id_criterio_ciclo, nota
             FROM ist_eventos_avaliacoes_notas WHERE id_avaliacao = ?`,
            [efetiva.id_avaliacao]
        );
        const notas = mapearNotas(rows, efetiva, criterios);
        avaliacao = {
            idAvaliacao: efetiva.id_avaliacao,
            notas,
            possivelDesclassificacao: efetiva.possivel_desclassificacao === 1,
            motivoDesclassificacao: efetiva.motivo_desclassificacao,
            media: calcularMediaPonderada(criterios, notas),
            dataInclusao: efetiva.data_inclusao,
            dataAtualizacao: efetiva.data_atualizacao,
            dataConclusao: efetiva.data_conclusao
        };
    }
    return {
        evento: { id: contexto.id_evento, slug: contexto.slug, nome: contexto.nome },
        contexto: {
            idCiclo: contexto.id_ciclo_atual, numeroCiclo: contexto.numero_ciclo,
            numeroTentativa: efetiva ? efetiva.numero_tentativa : null
        },
        podeGravar: autorizacao.podeGravar,
        autorizacaoGravacao: { estado: autorizacao.estado, code: autorizacao.code, motivo: autorizacao.motivo },
        concorrente: {
            idParticipacao: participante.id_concorrente,
            idSnapshot: participante.id_ciclo_concorrente,
            numeroConcorrente: participante.numero_concorrente,
            nome: participante.nome_publico,
            obraPrincipal: { id: participante.id_obra_1, titulo: participante.obra_1_publica },
            linkVideoPrincipal: participante.link_video_1,
            obraOpcional: participante.id_obra_2 === null ? null
                : { id: participante.id_obra_2, titulo: participante.obra_2_publica },
            linkVideoOpcional: participante.link_video_2
        },
        estado: efetiva ? efetiva.estado : 'pendente',
        versao: efetiva ? efetiva.versao : 0,
        escala: { min: 0, max: 100, passo: 1 },
        criterios,
        avaliacao
    };
};
