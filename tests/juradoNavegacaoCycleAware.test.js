import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { pool } from '../src/config/db.js';
import { JULGAMENTO_ERROS, JulgamentoContextError } from '../src/services/julgamentoContextService.js';

const originalQuery = pool.query;
const originalGetConnection = pool.getConnection;
let realAttempts = 0;
const denyReal = async () => { realAttempts++; throw new Error('Real connection forbidden'); };
pool.query = denyReal;
pool.getConnection = denyReal;
const {
    listarAcessosJuradoCycleAware: acessos, obterEventoJuradoCycleAware: evento,
    listarConcorrentesJuradoCycleAware: fila, obterConcorrenteJuradoCycleAware: detalhe,
    NAVEGACAO_ERROS, JuradoNavegacaoError
} = await import('../src/services/juradoNavegacaoCycleAwareService.js');
after(() => {
    pool.query = originalQuery;
    pool.getConnection = originalGetConnection;
    assert.equal(realAttempts, 0);
});

const normalize = sql => sql.replace(/\s+/g, ' ').trim();
const SQL = {
    set: 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ',
    start: 'START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY',
    evento: 'SELECT id, slug, nome FROM ist_eventos WHERE slug = ?',
    live: `SELECT e.id, e.slug, e.nome FROM ist_usuarios u
        INNER JOIN ist_eventos_jurados j ON j.id_usuario = u.id_usuario
        INNER JOIN ist_eventos e ON e.id = j.id_evento
        WHERE u.id_usuario = ? AND u.id_tipo_usuario = ? AND u.id_situacao = ?
        AND u.id_cargo = ? AND j.ativo = ?`,
    julgamento: `SELECT id_evento, id_ciclo_atual, id_publicacao_vigente, quantidade_classificados, versao
        FROM ist_eventos_julgamentos WHERE id_evento = ?`,
    ciclo: `SELECT id_ciclo, id_evento, numero_ciclo, estado, id_ciclo_origem,
        id_publicacao_origem, publicado_em, motivo_reabertura FROM ist_eventos_ciclos WHERE id_ciclo = ?`,
    publicadas: 'SELECT id_publicacao FROM ist_eventos_publicacoes WHERE id_evento = ? AND id_ciclo = ?',
    publicacao: `SELECT p.id_publicacao, p.id_evento, p.id_ciclo, p.versao, p.publicado_em,
        c.id_evento AS ciclo_evento, c.numero_ciclo, c.estado AS estado_ciclo,
        c.publicado_em AS ciclo_publicado_em FROM ist_eventos_publicacoes p
        LEFT JOIN ist_eventos_ciclos c ON c.id_ciclo = p.id_ciclo WHERE p.id_publicacao = ?`,
    roster: `SELECT id_ciclo, id_evento, id_usuario, nome_publico, estado_participacao
        FROM ist_eventos_ciclos_jurados WHERE id_ciclo = ? AND id_usuario = ?`,
    inclusao: `SELECT id_ciclo_concorrente, id_evento, id_ciclo, id_concorrente, estado_participacao
        FROM ist_eventos_ciclos_concorrentes WHERE id_ciclo = ? AND id_concorrente = ?`,
    participante: `SELECT id_ciclo_concorrente, id_ciclo, id_evento, id_concorrente, id_usuario,
        numero_concorrente, nome_publico, id_obra_1, obra_1_publica, link_video_1,
        id_obra_2, obra_2_publica, link_video_2, fingerprint, estado_participacao
        FROM ist_eventos_ciclos_concorrentes WHERE id_ciclo = ? AND id_concorrente = ?`,
    count: `SELECT COUNT(*) AS total FROM ist_eventos_ciclos_concorrentes
        WHERE id_evento = ? AND id_ciclo = ? AND estado_participacao = ?`,
    pagina: `SELECT id_evento, id_ciclo, id_concorrente FROM ist_eventos_ciclos_concorrentes
        WHERE id_evento = ? AND id_ciclo = ? AND estado_participacao = ?`
};
const ev = (id = 17) => ({ id, slug: `evento-${id}`, nome: `Evento ${id}` });
const judgment = (id = 17, ciclo = 20) => ({
    id_evento: id, id_ciclo_atual: ciclo, id_publicacao_vigente: null,
    quantidade_classificados: null, versao: 1
});
const cycle = (id = 17, ciclo = 20) => ({
    id_ciclo: ciclo, id_evento: id, numero_ciclo: 1, estado: 'aberto',
    id_ciclo_origem: null, id_publicacao_origem: null, publicado_em: null, motivo_reabertura: null
});
const juror = (id = 17, ciclo = 20) => ({
    id_ciclo: ciclo, id_evento: id, id_usuario: 10, nome_publico: 'Jurado', estado_participacao: 'incluido'
});
const participant = (campos = {}) => ({
    id_ciclo_concorrente: 30, id_ciclo: 20, id_evento: 17, id_concorrente: 40, id_usuario: 50,
    numero_concorrente: '040', nome_publico: 'Nome congelado', id_obra_1: 22,
    obra_1_publica: 'Obra congelada', link_video_1: 'https://example.invalid/snapshot',
    id_obra_2: null, obra_2_publica: null, link_video_2: null,
    fingerprint: 'a'.repeat(64), estado_participacao: 'incluido', ...campos
});
const expectedParticipant = {
    idParticipacao: 40, idSnapshot: 30, numeroConcorrente: '040', nome: 'Nome congelado',
    obraPrincipal: { id: 22, titulo: 'Obra congelada' }, linkVideoPrincipal: 'https://example.invalid/snapshot',
    obraOpcional: null, linkVideoOpcional: null
};
const step = (sql, params, rows = []) => ({ sql: normalize(sql), params, rows });
const live = (rows, id) => step(
    `${SQL.live}${id === undefined ? '' : ' AND e.id = ?'} ORDER BY e.nome, e.id`,
    id === undefined ? [10, 4, 8, 11, 1] : [10, 4, 8, 11, 1, id], rows
);
const context = (id = 17, ciclo = 20, roster = [juror(id, ciclo)]) => [
    step(SQL.julgamento, [id], [judgment(id, ciclo)]),
    step(SQL.ciclo, [ciclo], [cycle(id, ciclo)]),
    step(SQL.publicadas, [id, ciclo]),
    step(SQL.roster, [ciclo, 10], roster)
];
const authorized = () => [step(SQL.evento, ['evento-17'], [ev()]), live([ev()], 17), ...context()];
const material = (rows = [participant()], id = 40, ciclo = 20) => step(SQL.participante, [ciclo, id], rows);
const inclusao = (rows = [participant()], id = 40, ciclo = 20) => step(SQL.inclusao, [ciclo, id], rows.map(p => ({
    id_ciclo_concorrente: p.id_ciclo_concorrente, id_evento: p.id_evento, id_ciclo: p.id_ciclo,
    id_concorrente: p.id_concorrente, estado_participacao: p.estado_participacao
})));
const count = total => step(SQL.count, [17, 20, 'incluido'], [{ total }]);
const pagina = (rows, { sort = 'numero_concorrente', order = 'ASC', limit = 25, offset = 0 } = {}) =>
    step(`${SQL.pagina} ORDER BY ${sort} ${order}, id_concorrente ASC LIMIT ? OFFSET ?`,
        [17, 20, 'incluido', limit, offset], rows);
const pageRow = (id = 40) => ({ id_evento: 17, id_ciclo: 20, id_concorrente: id });

// Contract violations live outside the fake's thrown error and cannot pass an expected rejection.
function fake(t, consultas, options = {}) {
    const events = [];
    const violations = [];
    let cursor = 0;
    let acquired = false;
    const connection = {
        async query(sql, params) {
            const atual = { sql: normalize(sql), params };
            events.push(atual.sql);
            const esperado = consultas[cursor++];
            try {
                assert(esperado, 'Unexpected query');
                assert.equal(atual.sql, esperado.sql);
                assert.deepEqual(params, esperado.params);
                assert.doesNotMatch(atual.sql, /\b(INSERT|UPDATE|DELETE|ALTER|CREATE|FOR UPDATE|LOCK IN SHARE MODE)\b/);
            } catch (error) {
                violations.push(error);
                throw error;
            }
            if (esperado.error) throw esperado.error;
            return [structuredClone(esperado.rows), []];
        },
        async commit() { events.push('commit'); if (options.commit) throw options.commit; },
        async rollback() { events.push('rollback'); if (options.rollback) throw options.rollback; },
        release() { events.push('release'); if (options.release) throw options.release; },
        destroy() { events.push('destroy'); if (options.destroy) throw options.destroy; }
    };
    const db = {
        async getConnection() {
            events.push('acquire');
            assert.equal(acquired, false);
            acquired = true;
            if (options.acquire) throw options.acquire;
            return connection;
        },
        async query() { assert.fail('Pool query forbidden'); }
    };
    t.after(() => {
        assert.deepEqual(violations, [], 'Unexpected SQL contract violation');
        assert.equal(cursor, consultas.length, 'Unconsumed expected queries');
    });
    return { db, events };
}
const transaction = reads => [step(SQL.set, undefined), step(SQL.start, undefined), ...reads];
const domain = code => error => error instanceof JuradoNavegacaoError && error.code === code;
const structural = error => error instanceof JulgamentoContextError
    && error.code === JULGAMENTO_ERROS.CONTEXTO_INCONSISTENTE;
const runEvent = db => evento('evento-17', 10, db);
const runDetail = db => detalhe('evento-17', 40, 10, db);
const runFila = (db, params = {}) => fila('evento-17', 10, params, db);

test('import performs no SQL or real acquisition', () => assert.equal(realAttempts, 0));

for (const id of [0, -1, '10', null, undefined, 1.5, 2147483648, NaN]) {
    test(`invalid authenticated identity ${String(id)} before acquisition`, async t => {
        const { db, events } = fake(t, []);
        for (const promise of [
            acessos(id, db), evento('evento-17', id, db),
            fila('evento-17', id, {}, db), detalhe('evento-17', 40, id, db)
        ]) await assert.rejects(promise, domain(NAVEGACAO_ERROS.ENTRADA_INVALIDA));
        assert.deepEqual(events, []);
    });
}
for (const slug of ['', ' evento-17', 'evento-17 ', null, 17, 'a'.repeat(256)]) {
    test(`invalid slug ${String(slug).slice(0, 30)}`, async t => {
        const { db, events } = fake(t, []);
        await assert.rejects(evento(slug, 10, db), domain(NAVEGACAO_ERROS.ENTRADA_INVALIDA));
        await assert.rejects(fila(slug, 10, {}, db), domain(NAVEGACAO_ERROS.ENTRADA_INVALIDA));
        await assert.rejects(detalhe(slug, 40, 10, db), domain(NAVEGACAO_ERROS.ENTRADA_INVALIDA));
        assert.deepEqual(events, []);
    });
}
for (const id of [0, -1, '40', null, 1.5, 4294967296]) {
    test(`invalid participant ${String(id)}`, async t => {
        const { db, events } = fake(t, []);
        await assert.rejects(detalhe('evento-17', id, 10, db), domain(NAVEGACAO_ERROS.ENTRADA_INVALIDA));
        assert.deepEqual(events, []);
    });
}
for (const params of [
    null, [], 1, { page: 0 }, { page: '1' }, { limit: 0 }, { limit: 101 }, { limit: '25' },
    { page: Number.MAX_SAFE_INTEGER, limit: 100 }, { sort: 'dataInscricao' }, { sort: 'nome DESC' },
    { order: 'ASC' }, { idCiclo: 20 }, { idJurado: 10 }, { dataInscricao: 'x' },
    { filtro: 'x' }, { [Symbol('extra')]: 1 }
]) test(`invalid pagination ${String(JSON.stringify(params))}`, async t => {
    const { db, events } = fake(t, []);
    await assert.rejects(runFila(db, params), domain(NAVEGACAO_ERROS.ENTRADA_INVALIDA));
    assert.deepEqual(events, []);
});

test('open event uses live then current pointer then included roster', async t => {
    const { db, events } = fake(t, transaction(authorized()));
    assert.deepEqual(await runEvent(db), {
        evento: ev(), contexto: { idCiclo: 20, numeroCiclo: 1, estadoCiclo: 'aberto', versaoJulgamento: 1 }
    });
    assert.deepEqual(events.slice(0, 3), ['acquire', SQL.set, SQL.start]);
    assert.deepEqual(events.slice(-2), ['commit', 'release']);
});
test('empty discovery is an authorized empty DTO, not a fallback', async t => {
    const { db } = fake(t, transaction([live([])]));
    assert.deepEqual(await acessos(10, db), { eventos: [] });
});
test('discovery spans events and omits only roster-denied candidates', async t => {
    const reads = [live([ev(17), ev(18), ev(19)]), ...context(),
        ...context(18, 21, []), ...context(19, 22)];
    const { db } = fake(t, transaction(reads));
    const result = await acessos(10, db);
    assert.deepEqual(result.eventos.map(e => [e.id, e.contexto.idCiclo]), [[17, 20], [19, 22]]);
});
for (const estado of ['inelegivel', 'retirado']) {
    test(`roster ${estado} is excluded from discovery`, async t => {
        const { db } = fake(t, transaction([live([ev()]), ...context(17, 20, [{ ...juror(), estado_participacao: estado }])]));
        assert.deepEqual(await acessos(10, db), { eventos: [] });
    });
}
test('discovery structural failure is not omitted', async t => {
    const reads = [live([ev()]), step(SQL.julgamento, [17], [])];
    const { db, events } = fake(t, transaction(reads));
    await assert.rejects(acessos(10, db), e => e instanceof JulgamentoContextError
        && e.code === JULGAMENTO_ERROS.JULGAMENTO_NAO_CONFIGURADO);
    assert.deepEqual(events.slice(-2), ['rollback', 'release']);
});
test('unexpected infrastructure error with roster-like code is not silently omitted', async t => {
    const primary = Object.assign(new Error('infrastructure'), { code: JULGAMENTO_ERROS.JURADO_FORA_ROSTER });
    const reads = [live([ev()]), ...context()];
    reads[reads.length - 1].error = primary;
    const { db } = fake(t, transaction(reads));
    await assert.rejects(acessos(10, db), error => error === primary);
});
for (const [label, rows] of [
    ['duplicate', [ev(), ev()]], ['invalid id', [{ ...ev(), id: 0 }]], ['invalid name', [{ ...ev(), nome: '' }]]
]) test(`discovery rejects ${label}`, async t => {
    const { db } = fake(t, transaction([live(rows)]));
    await assert.rejects(acessos(10, db), structural);
});
test('event absent does not query authorization or participants', async t => {
    const { db } = fake(t, transaction([step(SQL.evento, ['evento-17'])]));
    await assert.rejects(runDetail(db), e => e instanceof JulgamentoContextError && e.code === JULGAMENTO_ERROS.EVENTO_INEXISTENTE);
});
test('live denial precedes all institutional/material queries', async t => {
    const { db } = fake(t, transaction([step(SQL.evento, ['evento-17'], [ev()]), live([], 17)]));
    await assert.rejects(runDetail(db), domain(NAVEGACAO_ERROS.ACESSO_OPERACIONAL_NEGADO));
});
for (const rows of [[ev(18)], [ev(), ev()], [{ ...ev(), nome: 'different' }]]) {
    test(`invalid live contract ${JSON.stringify(rows)}`, async t => {
        const { db } = fake(t, transaction([step(SQL.evento, ['evento-17'], [ev()]), live(rows, 17)]));
        await assert.rejects(runEvent(db), structural);
    });
}
for (const roster of [[], [{ ...juror(), estado_participacao: 'retirado' }], [{ ...juror(), estado_participacao: 'inelegivel' }]]) {
    test(`roster authorization denied ${JSON.stringify(roster)}`, async t => {
        const reads = authorized();
        reads[reads.length - 1].rows = roster;
        const { db } = fake(t, transaction(reads));
        await assert.rejects(runDetail(db), e => e instanceof JulgamentoContextError
            && [JULGAMENTO_ERROS.JURADO_FORA_ROSTER, JULGAMENTO_ERROS.JURADO_NAO_INCLUIDO].includes(e.code));
    });
}
for (const [label, mutate] of [
    ['duplicate event', reads => { reads[0].rows.push(ev()); reads.splice(1); }],
    ['missing pointer', reads => { reads[2].rows[0].id_ciclo_atual = null; reads.splice(3); }],
    ['missing judgment', reads => { reads[2].rows = []; reads.splice(3); }],
    ['cycle other event', reads => { reads[3].rows[0].id_evento = 18; reads.splice(4); }],
    ['roster other cycle', reads => { reads[5].rows[0].id_ciclo = 21; }]
]) test(`structural context ${label} never falls back`, async t => {
    const reads = authorized();
    mutate(reads);
    const { db } = fake(t, transaction(reads));
    await assert.rejects(runDetail(db), e => e instanceof JulgamentoContextError);
});
test('sealed cycle is readable with valid publication and without gravability', async t => {
    const reads = authorized();
    const date = '2026-10-01 10:00:00';
    reads[3].rows[0] = { ...cycle(), estado: 'selado', publicado_em: date };
    reads[4].rows = [{ id_publicacao: 70 }];
    reads.splice(5, 0, step(SQL.publicacao, [70], [{
        id_publicacao: 70, id_evento: 17, id_ciclo: 20, versao: 1, publicado_em: date,
        ciclo_evento: 17, numero_ciclo: 1, estado_ciclo: 'selado', ciclo_publicado_em: date
    }]));
    const { db } = fake(t, transaction([...reads, inclusao(), material()]));
    const result = await runDetail(db);
    assert.equal(result.contexto.estadoCiclo, 'selado');
    assert.deepEqual(result.concorrente, expectedParticipant);
    assert.equal(Object.hasOwn(result, 'podeGravar'), false);
});
test('material DTO has only frozen fields and no live material query', async t => {
    const { db } = fake(t, transaction([...authorized(), inclusao(), material()]));
    assert.deepEqual((await runDetail(db)).concorrente, expectedParticipant);
});
test('new open current cycle reads only its snapshot while previous publication remains valid', async t => {
    const date = '2026-10-01 10:00:00';
    const reads = [
        step(SQL.evento, ['evento-17'], [ev()]), live([ev()], 17),
        step(SQL.julgamento, [17], [{ ...judgment(17, 21), id_publicacao_vigente: 70, versao: 2 }]),
        step(SQL.ciclo, [21], [{
            ...cycle(17, 21), numero_ciclo: 2, id_ciclo_origem: 20,
            id_publicacao_origem: 70, motivo_reabertura: 'Revisao'
        }]),
        step(SQL.ciclo, [20], [{ ...cycle(), estado: 'selado', publicado_em: date }]),
        step(SQL.publicacao, [70], [{
            id_publicacao: 70, id_evento: 17, id_ciclo: 20, versao: 1, publicado_em: date,
            ciclo_evento: 17, numero_ciclo: 1, estado_ciclo: 'selado', ciclo_publicado_em: date
        }]),
        step(SQL.publicadas, [17, 21]),
        step(SQL.roster, [21, 10], [juror(17, 21)]),
        inclusao([participant({ id_ciclo: 21, id_ciclo_concorrente: 31 })], 40, 21),
        material([participant({ id_ciclo: 21, id_ciclo_concorrente: 31, obra_1_publica: 'Snapshot ciclo 2' })], 40, 21)
    ];
    const { db } = fake(t, transaction(reads));
    const result = await runDetail(db);
    assert.deepEqual(result.contexto, { idCiclo: 21, numeroCiclo: 2, estadoCiclo: 'aberto', versaoJulgamento: 2 });
    assert.equal(result.concorrente.idSnapshot, 31);
    assert.equal(result.concorrente.obraPrincipal.titulo, 'Snapshot ciclo 2');
});
test('participant existing only outside the current cycle has uniform absence without historical lookup', async t => {
    const reads = [step(SQL.evento, ['evento-17'], [ev()]), live([ev()], 17), ...context(17, 21), inclusao([], 40, 21)];
    const { db } = fake(t, transaction(reads));
    await assert.rejects(runDetail(db), domain(NAVEGACAO_ERROS.CONCORRENTE_AUSENTE));
});
test('optional material is projected without enrichment', async t => {
    const { db } = fake(t, transaction([...authorized(), inclusao(), material([participant({
        id_obra_2: 23, obra_2_publica: 'Outra congelada', link_video_2: 'https://example.invalid/optional'
    })])]));
    assert.deepEqual((await runDetail(db)).concorrente, {
        ...expectedParticipant, obraOpcional: { id: 23, titulo: 'Outra congelada' },
        linkVideoOpcional: 'https://example.invalid/optional'
    });
});
for (const state of [null, 'desistente', 'desclassificado', 'inelegivel']) {
    test(`uniform participant absence ${state}`, async t => {
        const { db } = fake(t, transaction([...authorized(), inclusao(state === null ? [] : [participant({ estado_participacao: state })])]));
        await assert.rejects(runDetail(db), error => {
            assert(error instanceof JuradoNavegacaoError);
            assert.equal(error.code, 'CONCORRENTE_AUSENTE');
            assert.equal(error.message, 'Participacao nao encontrada.');
            assert.deepEqual(Object.keys(error).sort(), ['code', 'name']);
            return true;
        });
    });
}
test('unexpected infrastructure error with participant-like code retains its identity', async t => {
    const primary = Object.assign(new Error('infrastructure'), { code: JULGAMENTO_ERROS.CONCORRENTE_AUSENTE });
    const reads = [...authorized(), inclusao(), material()];
    reads[reads.length - 1].error = primary;
    const { db } = fake(t, transaction(reads));
    await assert.rejects(runDetail(db), error => error === primary);
});
test('absent and excluded participants with incomplete material have exactly the same public error', async t => {
    const cases = [[],
        [participant({ estado_participacao: 'inelegivel', numero_concorrente: null })],
        [participant({ estado_participacao: 'desistente', nome_publico: null, id_obra_1: null,
            obra_1_publica: null, link_video_1: null, fingerprint: null })],
        [participant({ estado_participacao: 'desclassificado', numero_concorrente: '', link_video_1: '' })]
    ];
    const errors = [];
    for (const rows of cases) {
        const { db, events } = fake(t, transaction([...authorized(), inclusao(rows)]));
        await assert.rejects(runDetail(db), error => {
            assert(error instanceof JuradoNavegacaoError);
            assert.equal(error.code, NAVEGACAO_ERROS.CONCORRENTE_AUSENTE);
            errors.push(error);
            return true;
        });
        assert.equal(events.includes('commit'), false);
        assert.deepEqual(events.slice(-2), ['rollback', 'release']);
    }
    for (const error of errors) {
        assert.equal(error.constructor, errors[0].constructor);
        assert.equal(error.code, errors[0].code);
        assert.equal(error.message, errors[0].message);
        assert.deepEqual(Object.keys(error).sort(), ['code', 'name']);
    }
});
for (const fields of [
    { numero_concorrente: null }, { nome_publico: null }, { id_obra_1: null },
    { obra_1_publica: null }, { link_video_1: null }, { fingerprint: null }
]) test(`included participant invalid material remains structural: ${Object.keys(fields)}`, async t => {
    const { db, events } = fake(t, transaction([...authorized(), inclusao(), material([participant(fields)])]));
    await assert.rejects(runDetail(db), structural);
    assert.equal(events.includes('commit'), false);
    assert.deepEqual(events.slice(-2), ['rollback', 'release']);
});
for (const rows of [
    null, {}, [null], [[]], [participant(), participant()],
    [participant({ id_ciclo_concorrente: 0 })],
    [participant({ estado_participacao: 'invalido' })],
    [participant({ id_evento: 18, estado_participacao: 'inelegivel' })],
    [participant({ id_ciclo: 21, estado_participacao: 'desistente' })],
    [participant({ id_concorrente: 41, estado_participacao: 'desclassificado' })]
]) test(`detail precheck malformed identity/state/format: ${JSON.stringify(rows)}`, async t => {
    const { db, events } = fake(t, transaction([...authorized(), step(SQL.inclusao, [20, 40], rows)]));
    await assert.rejects(runDetail(db), structural);
    assert.equal(events.includes('commit'), false);
    assert.deepEqual(events.slice(-2), ['rollback', 'release']);
});
for (const rows of [
    [], [participant({ estado_participacao: 'inelegivel' })], [participant({ id_ciclo_concorrente: 31 })]
]) test(`detail included precheck contradicted by full resolver: ${JSON.stringify(rows)}`, async t => {
    const { db, events } = fake(t, transaction([...authorized(), inclusao(), material(rows)]));
    await assert.rejects(runDetail(db), structural);
    assert.equal(events.includes('commit'), false);
    assert.deepEqual(events.slice(-2), ['rollback', 'release']);
});
for (const fields of [{ id_evento: 18 }, { id_ciclo: 21 }, { id_concorrente: 41 }, { fingerprint: 'bad' }]) {
    test(`invalid participant linkage ${JSON.stringify(fields)}`, async t => {
        const p = participant(fields);
        const reads = [...authorized(), inclusao([p])];
        if (fields.fingerprint) reads.push(material([p]));
        const { db } = fake(t, transaction(reads));
        await assert.rejects(runDetail(db), structural);
    });
}
test('default queue count/page/material use the same cycle and connection', async t => {
    const { db } = fake(t, transaction([...authorized(), count(1), pagina([pageRow()]), material()]));
    const result = await runFila(db);
    assert.deepEqual(result.concorrentes, [expectedParticipant]);
    assert.deepEqual(result.pagination, { page: 1, limit: 25, total: 1, totalPages: 1 });
});
for (const sort of ['numeroConcorrente', 'nome']) for (const order of ['asc', 'desc']) {
    test(`sort allowlist ${sort} ${order} and numeric paging`, async t => {
        const { db } = fake(t, transaction([...authorized(), count(201), pagina([pageRow()], {
            sort: sort === 'nome' ? 'nome_publico' : 'numero_concorrente', order: order.toUpperCase(), limit: 100, offset: 200
        }), material()]));
        const result = await runFila(db, { page: 3, limit: 100, sort, order });
        assert.deepEqual(result.pagination, { page: 3, limit: 100, total: 201, totalPages: 3 });
    });
}
for (const total of [0, 1]) {
    test(`empty/out-of-range queue total ${total}`, async t => {
        const { db } = fake(t, transaction([...authorized(), count(total), pagina([], { offset: 25 })]));
        const result = await runFila(db, { page: 2 });
        assert.deepEqual(result.concorrentes, []);
        assert.equal(result.pagination.totalPages, total);
    });
}
test('bounded N+1 preserves page order for multiple participants', async t => {
    const { db } = fake(t, transaction([...authorized(), count(2), pagina([pageRow(41), pageRow()]),
        material([participant({ id_concorrente: 41, id_ciclo_concorrente: 31 })], 41), material()]));
    assert.deepEqual((await runFila(db)).concorrentes.map(p => p.idParticipacao), [41, 40]);
});
test('maximum page reads exactly 100 snapshots sequentially', async t => {
    const ids = Array.from({ length: 100 }, (_, i) => 40 + i);
    const reads = [...authorized(), count(100), pagina(ids.map(pageRow), { limit: 100 }),
        ...ids.map(id => material([participant({ id_concorrente: id, id_ciclo_concorrente: id + 100 })], id))];
    const { db, events } = fake(t, transaction(reads));
    const result = await runFila(db, { limit: 100 });
    assert.deepEqual(result.concorrentes.map(p => p.idParticipacao), ids);
    assert.equal(events.filter(e => e === normalize(SQL.participante)).length, 100);
});
for (const rows of [[], [participant({ estado_participacao: 'desclassificado' })]]) {
    test(`queue page/material contradiction is structural: ${rows.length ? 'excluded' : 'absent'}`, async t => {
        const { db, events } = fake(t, transaction([...authorized(), count(1), pagina([pageRow()]), material(rows)]));
        let dtoReturned = false;
        await assert.rejects(runFila(db).then(dto => { dtoReturned = true; return dto; }), structural);
        assert.equal(dtoReturned, false);
        assert.equal(events.includes('commit'), false);
        assert.deepEqual(events.slice(-2), ['rollback', 'release']);
    });
}
for (const [label, counts, rows] of [
    ['string count', [{ total: '1' }], null], ['negative count', [{ total: -1 }], null],
    ['duplicate count', [{ total: 0 }, { total: 0 }], null],
    ['page count mismatch', [{ total: 1 }], []],
    ['wrong cycle', [{ total: 1 }], [{ ...pageRow(), id_ciclo: 21 }]],
    ['wrong event', [{ total: 1 }], [{ ...pageRow(), id_evento: 18 }]],
    ['duplicate id', [{ total: 2 }], [pageRow(), pageRow()]]
]) test(`queue integrity ${label}`, async t => {
    const reads = [...authorized(), step(SQL.count, [17, 20, 'incluido'], counts)];
    if (rows !== null) reads.push(pagina(rows));
    const { db } = fake(t, transaction(reads));
    await assert.rejects(runFila(db), structural);
});
test('parameters are copied before asynchronous acquisition', async t => {
    const params = { limit: 1, sort: 'nome' };
    const { db } = fake(t, transaction([...authorized(), count(0), pagina([], { sort: 'nome_publico', limit: 1 })]));
    const pending = runFila(db, params);
    params.limit = 100;
    params.sort = 'bad';
    assert.equal((await pending).pagination.limit, 1);
});

for (const stage of ['acquire', 'set', 'start', 'query', 'commit']) {
    test(`primary infrastructure error preserved at ${stage}`, async t => {
        const primary = new Error(stage);
        const options = {};
        let queries;
        let tail;
        if (stage === 'acquire') { options.acquire = primary; queries = []; tail = ['acquire']; }
        else if (stage === 'set' || stage === 'start') {
            queries = stage === 'set' ? [step(SQL.set, undefined)] : transaction([]);
            queries[queries.length - 1].error = primary;
            tail = ['destroy'];
        } else if (stage === 'query') {
            queries = transaction([step(SQL.evento, ['evento-17'])]);
            queries[2].error = primary;
            tail = ['rollback', 'release'];
        } else {
            queries = transaction(authorized());
            options.commit = primary;
            tail = ['commit', 'rollback', 'destroy'];
        }
        const { db, events } = fake(t, queries, options);
        await assert.rejects(runEvent(db), e => e === primary);
        assert.deepEqual(events.slice(-tail.length), tail);
    });
}
for (const options of [
    { rollback: new Error('rollback') },
    { rollback: new Error('rollback'), destroy: new Error('destroy') },
    { release: new Error('release'), destroy: new Error('destroy') }
]) test(`cleanup cannot replace query failure ${Object.keys(options)}`, async t => {
    const primary = new Error('primary');
    const queries = transaction([step(SQL.evento, ['evento-17'])]);
    queries[2].error = primary;
    const { db, events } = fake(t, queries, options);
    const original = console.error;
    console.error = () => { throw new Error('logger'); };
    try { await assert.rejects(runEvent(db), e => e === primary); }
    finally { console.error = original; }
    assert.equal(events.filter(e => e === 'destroy').length, 1);
    if (options.rollback) assert.equal(events.includes('release'), false);
});
test('commit failure remains failure when rollback/destroy/logger also fail', async t => {
    const primary = new Error('commit');
    const { db, events } = fake(t, transaction(authorized()), {
        commit: primary, rollback: new Error('rollback'), destroy: new Error('destroy')
    });
    const original = console.error;
    console.error = () => { throw new Error('logger'); };
    try { await assert.rejects(runEvent(db), e => e === primary); }
    finally { console.error = original; }
    assert.equal(events.includes('release'), false);
    assert.equal(events.filter(e => e === 'destroy').length, 1);
});
test('confirmed DTO survives release/destroy/logger failure', async t => {
    const { db, events } = fake(t, transaction(authorized()), {
        release: new Error('release'), destroy: new Error('destroy')
    });
    const original = console.error;
    console.error = () => { throw new Error('logger'); };
    try { assert.equal((await runEvent(db)).contexto.idCiclo, 20); }
    finally { console.error = original; }
    assert.deepEqual(events.slice(-3), ['commit', 'release', 'destroy']);
});
