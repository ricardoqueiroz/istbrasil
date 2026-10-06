import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
    avaliarAutorizacaoGravacao, carregarElegibilidadeLiveGravacao, AUTORIZACAO_ERROS
} from '../src/services/juradoAvaliacaoAutorizacaoService.js';
import { JulgamentoContextError, JULGAMENTO_ERROS } from '../src/services/julgamentoContextService.js';
import { GRAVACAO_ERROS } from '../src/services/juradoAvaliacaoGravacaoService.js';

const facts = () => ({
    contexto: { id_evento: 17, id_julgamento: 17, id_ciclo_atual: 20, numero_ciclo: 1,
        estado_ciclo: 'aberto', permite_escrita: true },
    idUsuario: 10, idParticipacao: 40, live: true,
    jurado: { id_evento: 17, id_ciclo: 20, id_usuario: 10, estado_participacao: 'incluido' },
    participante: { id_evento: 17, id_ciclo: 20, id_concorrente: 40, estado_participacao: 'incluido' },
    criterios: [{ id_criterio_ciclo: 501, id_criterio_origem: 101, id_ciclo: 20, id_evento: 17,
        nome: 'Snapshot', descricao: null, ordem: 1, peso: '100.00' }],
    efetiva: null
});
const draft = (fields = {}) => ({ id_evento: 17, id_ciclo: 20, id_jurado: 10,
    id_concorrente: 40, numero_tentativa: 1, estado: 'rascunho', versao: 3, ...fields });
const allowed = { podeGravar: true, estado: 'autorizada', code: null, motivo: null };
test('open + live + roster + snapshot + valid criteria + first attempt permits writing', async () => {
    const f = facts(), before = structuredClone(f);
    assert.deepEqual(await avaliarAutorizacaoGravacao(f), allowed);
    assert.deepEqual(f, before);
});
test('existing draft permits writing independently of client version or invalid PUT payload', async () => {
    const f = { ...facts(), efetiva: draft(), versao: -1, payload: { notas: 'invalid' } };
    assert.deepEqual(await avaliarAutorizacaoGravacao(f), allowed);
});
const negatives = [
    ['sealed cycle', f => { Object.assign(f.contexto, { estado_ciclo: 'selado', permite_escrita: false }); },
        'ciclo_fechado', AUTORIZACAO_ERROS.CONTEXTO_NAO_GRAVAVEL],
    ['revoked live', f => { f.live = false; }, 'jurado_inelegivel', AUTORIZACAO_ERROS.ACESSO_OPERACIONAL_NEGADO],
    ['absent juror', f => { f.jurado = null; }, 'jurado_fora_do_ciclo', JULGAMENTO_ERROS.JURADO_FORA_ROSTER],
    ['excluded juror', f => { f.jurado.estado_participacao = 'retirado'; }, 'jurado_fora_do_ciclo', JULGAMENTO_ERROS.JURADO_NAO_INCLUIDO],
    ['absent participant', f => { f.participante = null; }, 'concorrente_fora_do_ciclo', JULGAMENTO_ERROS.CONCORRENTE_AUSENTE],
    ...['inelegivel', 'desistente', 'desclassificado'].map(state => [
        `participant ${state}`, f => { f.participante.estado_participacao = state; },
        'concorrente_inelegivel', JULGAMENTO_ERROS.CONCORRENTE_NAO_INCLUIDO
    ]),
    ['invalid criteria', f => { f.criterios[0].peso = '99.00'; }, 'criterios_invalidos', JULGAMENTO_ERROS.CRITERIOS_INVALIDOS],
    ['completed', f => { f.efetiva = draft({ estado: 'concluida' }); }, 'avaliacao_concluida', AUTORIZACAO_ERROS.AVALIACAO_CONCLUIDA],
    ['identity mismatch', f => { f.jurado.id_usuario = 99; }, 'contexto_invalido', JULGAMENTO_ERROS.CONTEXTO_INCONSISTENTE],
    ['participant wrong cycle', f => { f.participante.id_ciclo = 21; }, 'contexto_invalido', JULGAMENTO_ERROS.CONTEXTO_INCONSISTENTE],
    ['criteria wrong cycle', f => { f.criterios[0].id_ciclo = 21; }, 'criterios_invalidos', JULGAMENTO_ERROS.CRITERIOS_INVALIDOS],
    ['effective wrong cycle', f => { f.efetiva = draft({ id_ciclo: 21 }); }, 'contexto_invalido', JULGAMENTO_ERROS.CONTEXTO_INCONSISTENTE],
    ['inconsistent lifecycle', f => { f.contexto.permite_escrita = false; }, 'contexto_invalido', JULGAMENTO_ERROS.CONTEXTO_INCONSISTENTE],
    ['missing facts fail closed', f => { delete f.efetiva; }, 'contexto_invalido', JULGAMENTO_ERROS.CONTEXTO_INCONSISTENTE],
    ['invalid authenticated identity', f => { f.idUsuario = '10'; }, 'contexto_invalido', JULGAMENTO_ERROS.CONTEXTO_INCONSISTENTE]
];
for (const [name, modify, estado, code] of negatives) test(name + ' returns deterministic domain denial', async () => {
    const f = facts(); modify(f);
    assert.deepEqual(await avaliarAutorizacaoGravacao(f), { podeGravar: false, estado, code, motivo: code });
});
test('saturated persisted version cannot be incremented, unlike a stale client version', async () => {
    assert.deepEqual(await avaliarAutorizacaoGravacao({ ...facts(), efetiva: draft({ versao: 4294967295 }) }), {
        podeGravar: false, estado: 'contexto_invalido', code: AUTORIZACAO_ERROS.CONTEXTO_NAO_GRAVAVEL, motivo: 'limite_versao'
    });
});
for (const code of Object.values(JULGAMENTO_ERROS)) test('typed resolver failure maps without driver detail: ' + code, async () => {
    const f = facts();
    f.contexto = () => { throw new JulgamentoContextError(code, { sql: 'secret' }); };
    const result = await avaliarAutorizacaoGravacao(f);
    assert.equal(result.podeGravar, false);
    assert.equal(result.code, code);
    assert.equal(result.motivo, code);
    assert.doesNotMatch(JSON.stringify(result), /sql|secret|stack/);
});
test('facts/loaders run serially in institutional order, never allocate a connection', async () => {
    const f = facts(), trace = [];
    for (const key of ['contexto', 'live', 'jurado', 'participante', 'criterios', 'efetiva']) {
        const value = f[key];
        f[key] = async () => { trace.push(key); await Promise.resolve(); return value; };
    }
    assert.deepEqual(await avaliarAutorizacaoGravacao(f), allowed);
    assert.deepEqual(trace, ['contexto', 'live', 'jurado', 'participante', 'criterios', 'efetiva']);
});
test('denial short-circuits later loaders and has stable precedence', async () => {
    const f = facts();
    f.live = false;
    f.jurado = () => assert.fail('Must not load roster after live denial');
    assert.equal((await avaliarAutorizacaoGravacao(f)).estado, 'jurado_inelegivel');
    Object.assign(f.contexto, { estado_ciclo: 'selado', permite_escrita: false });
    f.live = () => assert.fail('Must not load live after closed cycle');
    assert.equal((await avaliarAutorizacaoGravacao(f)).estado, 'ciclo_fechado');
});
for (const error of [new Error('driver SQL'), Object.assign(new Error('spoofed'), { code: 'CRITERIOS_INVALIDOS' }),
    new JulgamentoContextError('UNKNOWN')]) test('unknown failure propagates, never becomes denial/success: ' + error.message, async () => {
    await assert.rejects(avaliarAutorizacaoGravacao({
        ...facts(), live: () => { throw error; }
    }), e => e === error);
});
const user = { id_usuario: 10, id_tipo_usuario: 4, id_situacao: 8, id_cargo: 11 };
const assignment = { id_evento: 17, id_usuario: 10, ativo: 1 };
for (const bloquear of [false, true]) test(`live helper uses caller executor; lock=${bloquear}`, async () => {
    const calls = [];
    const executor = { async query(sql, params) {
        calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
        assert.equal(this, executor);
        return [calls.length === 1 ? [user] : [assignment]];
    } };
    assert.equal(await carregarElegibilidadeLiveGravacao(executor, 17, 10, { bloquear }), true);
    assert.equal(calls.length, 2);
    for (const { sql } of calls) assert.equal(sql.endsWith('LOCK IN SHARE MODE'), bloquear);
    assert.deepEqual(calls.map(c => c.params), [[10], [17, 10]]);
});
for (const [name, users, assignments] of [
    ['missing', [], [assignment]], ['wrong type', [{ ...user, id_tipo_usuario: 3 }], [assignment]],
    ['revoked', [{ ...user, id_situacao: 9 }], [assignment]], ['wrong role', [{ ...user, id_cargo: 10 }], [assignment]],
    ['inactive assignment', [user], [{ ...assignment, ativo: 0 }]], ['assignment missing', [user], []],
    ['assignment wrong event', [user], [{ ...assignment, id_evento: 18 }]]
]) test('live denies ' + name, async () => {
    const executor = { query: async sql => [sql.includes('FROM ist_usuarios') ? users : assignments] };
    assert.equal(await carregarElegibilidadeLiveGravacao(executor, 17, 10), false);
});
test('reader and writer import the same policy; writer codes retain existing API and no legacy cutover', () => {
    for (const file of ['juradoAvaliacaoLeituraService', 'juradoAvaliacaoGravacaoService']) {
        const source = readFileSync(new URL(`../src/services/${file}.js`, import.meta.url), 'utf8');
        assert.match(source, /from '\.\/juradoAvaliacaoAutorizacaoService\.js'/);
        assert.match(source, /await avaliarAutorizacaoGravacao\(/);
        assert.doesNotMatch(source, /nao_avaliada|const revalidarLive|const resolverInclusao/);
    }
    for (const [name, code] of Object.entries(AUTORIZACAO_ERROS)) assert.equal(GRAVACAO_ERROS[name], code);
    const routes = readFileSync(new URL('../src/routes/jurado.routes.js', import.meta.url), 'utf8');
    assert.doesNotMatch(routes, /juradoAvaliacaoAutorizacao|obterAvaliacaoJuradoCycleAware|salvarAvaliacaoJuradoCycleAware/);
});
