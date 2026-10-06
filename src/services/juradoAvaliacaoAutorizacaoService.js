import {
    JULGAMENTO_ERROS, JulgamentoContextError, validarCriteriosCiclo
} from './julgamentoContextService.js';

export const AUTORIZACAO_ERROS = Object.freeze({
    ACESSO_OPERACIONAL_NEGADO: 'ACESSO_OPERACIONAL_NEGADO',
    CONTEXTO_NAO_GRAVAVEL: 'CONTEXTO_NAO_GRAVAVEL',
    AVALIACAO_CONCLUIDA: 'AVALIACAO_CONCLUIDA'
});
const estadosContexto = new Map([
    [JULGAMENTO_ERROS.JURADO_FORA_ROSTER, 'jurado_fora_do_ciclo'],
    [JULGAMENTO_ERROS.JURADO_NAO_INCLUIDO, 'jurado_fora_do_ciclo'],
    [JULGAMENTO_ERROS.CONCORRENTE_AUSENTE, 'concorrente_fora_do_ciclo'],
    [JULGAMENTO_ERROS.CONCORRENTE_NAO_INCLUIDO, 'concorrente_inelegivel'],
    [JULGAMENTO_ERROS.CRITERIOS_INVALIDOS, 'criterios_invalidos'],
    [JULGAMENTO_ERROS.TENTATIVAS_INVALIDAS, 'contexto_invalido'],
    [JULGAMENTO_ERROS.EVENTO_INEXISTENTE, 'contexto_invalido'],
    [JULGAMENTO_ERROS.JULGAMENTO_NAO_CONFIGURADO, 'contexto_invalido'],
    [JULGAMENTO_ERROS.CICLO_ATUAL_AUSENTE, 'contexto_invalido'],
    [JULGAMENTO_ERROS.CONTEXTO_INCONSISTENTE, 'contexto_invalido']
]);
const negar = (estado, code, motivo = code) => ({ podeGravar: false, estado, code, motivo });
const obter = valor => typeof valor === 'function' ? valor() : valor;
const idValido = (id, max = 4294967295) => Number.isSafeInteger(id) && id > 0 && id <= max;
const exigir = condition => {
    if (!condition) throw new JulgamentoContextError(JULGAMENTO_ERROS.CONTEXTO_INCONSISTENTE);
};

// O executor pertence ao caller. Somente o writer pede locks, dentro da sua transacao.
export const carregarElegibilidadeLiveGravacao = async (executor, idEvento, idUsuario, { bloquear = false } = {}) => {
    const lock = bloquear ? ' LOCK IN SHARE MODE' : '';
    const [usuarios] = await executor.query(
        `SELECT id_usuario, id_tipo_usuario, id_situacao, id_cargo
         FROM ist_usuarios WHERE id_usuario = ?${lock}`, [idUsuario]
    );
    if (usuarios.length !== 1 || usuarios[0].id_usuario !== idUsuario || usuarios[0].id_tipo_usuario !== 4
        || usuarios[0].id_situacao !== 8 || usuarios[0].id_cargo !== 11) return false;
    const [designacoes] = await executor.query(
        `SELECT id_evento, id_usuario, ativo FROM ist_eventos_jurados
         WHERE id_evento = ? AND id_usuario = ?${lock}`, [idEvento, idUsuario]
    );
    return designacoes.length === 1 && designacoes[0].id_evento === idEvento
        && designacoes[0].id_usuario === idUsuario && designacoes[0].ativo === 1;
};

// Fatos estruturais vem dos resolvers do dominio. Carregadores sao sequenciais:
// writer conserva locks/ordem; reader reaproveita fatos lidos. Nao recebe payload ou versao cliente.
// efetiva deve vir de interpretarTentativasCiclo sobre o historico completo do par.
// Decisao: { podeGravar, estado, code, motivo }; motivo e codigo seguro, nunca mensagem de infraestrutura.
export const avaliarAutorizacaoGravacao = async ({
    contexto, idUsuario, idParticipacao, live, jurado, participante, criterios, efetiva
}) => {
    try {
        const c = await obter(contexto);
        exigir(c && idValido(c.id_evento) && c.id_julgamento === c.id_evento
            && idValido(c.id_ciclo_atual) && idValido(c.numero_ciclo)
            && ['aberto', 'selado'].includes(c.estado_ciclo)
            && c.permite_escrita === (c.estado_ciclo === 'aberto')
            && idValido(idUsuario, 2147483647) && idValido(idParticipacao));
        if (!c.permite_escrita) return negar('ciclo_fechado', AUTORIZACAO_ERROS.CONTEXTO_NAO_GRAVAVEL);
        const elegivel = await obter(live);
        exigir(typeof elegivel === 'boolean');
        if (!elegivel) return negar('jurado_inelegivel', AUTORIZACAO_ERROS.ACESSO_OPERACIONAL_NEGADO);
        const j = await obter(jurado);
        if (j === null) return negar('jurado_fora_do_ciclo', JULGAMENTO_ERROS.JURADO_FORA_ROSTER);
        exigir(j && j.id_ciclo === c.id_ciclo_atual && j.id_evento === c.id_evento && j.id_usuario === idUsuario
            && ['incluido', 'inelegivel', 'retirado'].includes(j.estado_participacao));
        if (j.estado_participacao !== 'incluido') return negar('jurado_fora_do_ciclo', JULGAMENTO_ERROS.JURADO_NAO_INCLUIDO);
        const p = await obter(participante);
        if (p === null) return negar('concorrente_fora_do_ciclo', JULGAMENTO_ERROS.CONCORRENTE_AUSENTE);
        exigir(p && p.id_ciclo === c.id_ciclo_atual && p.id_evento === c.id_evento && p.id_concorrente === idParticipacao
            && ['incluido', 'desistente', 'desclassificado', 'inelegivel'].includes(p.estado_participacao));
        if (p.estado_participacao !== 'incluido') return negar('concorrente_inelegivel', JULGAMENTO_ERROS.CONCORRENTE_NAO_INCLUIDO);
        validarCriteriosCiclo(await obter(criterios), c);
        const a = await obter(efetiva);
        exigir(a === null || (a && a.id_evento === c.id_evento && a.id_ciclo === c.id_ciclo_atual
            && a.id_jurado === idUsuario && a.id_concorrente === idParticipacao
            && idValido(a.numero_tentativa) && idValido(a.versao) && ['rascunho', 'concluida'].includes(a.estado)));
        if (a?.estado === 'concluida') return negar('avaliacao_concluida', AUTORIZACAO_ERROS.AVALIACAO_CONCLUIDA);
        // Saturacao persistida impede qualquer incremento; nao compara tokens de optimistic locking.
        if (a?.versao === 4294967295) return negar('contexto_invalido', AUTORIZACAO_ERROS.CONTEXTO_NAO_GRAVAVEL, 'limite_versao');
        return { podeGravar: true, estado: 'autorizada', code: null, motivo: null };
    } catch (error) {
        if (error instanceof JulgamentoContextError && estadosContexto.has(error.code)) {
            return negar(estadosContexto.get(error.code), error.code);
        }
        throw error;
    }
};
