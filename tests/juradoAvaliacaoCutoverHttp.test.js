import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { after, before, test } from 'node:test';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import { pool } from '../src/config/db.js';
import {
    obterAvaliacaoJuradoCycleAwareController, salvarAvaliacaoJuradoCycleAwareController
} from '../src/controllers/juradoAvaliacaoCycleAwareController.js';
import { obterAvaliacaoJurado, salvarAvaliacaoJurado } from '../src/controllers/juradoController.js';

const secret = 'synthetic-evaluation-cutover-secret';
const previous = { JWT_SECRET: process.env.JWT_SECRET, COOKIE_NAME: process.env.COOKIE_NAME };
let router;
try {
    process.env.JWT_SECRET = secret;
    process.env.COOKIE_NAME = 'cutover_test';
    ({ default: router } = await import('../src/routes/jurado.routes.js'));
} finally {
    for (const [key, value] of Object.entries(previous))
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
}
const event = { id: 17, slug: 'snapshot-event', nome: 'Event label' };
const date = '2026-10-05 12:00:00';
const originalQuery = pool.query, originalConnection = pool.getConnection;
let current;
before(() => {
    pool.query = async (sql, params) => {
        current.middleware.push(sql);
        if (sql.includes('FROM ist_eventos WHERE slug')) return [[event].filter(e => e.slug === params[0])];
        if (sql.includes('FROM ist_usuarios u') && sql.includes('INNER JOIN ist_eventos_jurados'))
            return [current.revoked || params[0] !== 10 ? [] : [event]];
        assert.fail('Unexpected pool/legacy query: ' + sql);
    };
    pool.getConnection = async () => {
        current.acquired++;
        return current.connection;
    };
});
after(() => { pool.query = originalQuery; pool.getConnection = originalConnection; });

// SQL fixture only: domain decisions, DTO, locks, validation and mutations use the real services.
function fixture() {
    const state = {
        julgamentos: [{ id_evento: 17, id_ciclo_atual: 20, id_publicacao_vigente: null, quantidade_classificados: null, versao: 1 }],
        ciclos: [{ id_ciclo: 20, id_evento: 17, numero_ciclo: 1, estado: 'aberto',
            id_ciclo_origem: null, id_publicacao_origem: null, publicado_em: null, motivo_reabertura: null }],
        usuarios: [{ id_usuario: 10, id_tipo_usuario: 4, id_situacao: 8, id_cargo: 11 }],
        designacoes: [{ id_evento: 17, id_usuario: 10, ativo: 1 }],
        jurados: [{ id_ciclo: 20, id_evento: 17, id_usuario: 10, nome_publico: 'Frozen juror', estado_participacao: 'incluido' }],
        participantes: [{ id_ciclo_concorrente: 30, id_ciclo: 20, id_evento: 17, id_concorrente: 40, id_usuario: 50,
            numero_concorrente: 'FROZEN-040', nome_publico: 'Frozen participant', id_obra_1: 22,
            obra_1_publica: 'Frozen work', link_video_1: 'https://example.invalid/frozen',
            id_obra_2: null, obra_2_publica: null, link_video_2: null,
            fingerprint: 'a'.repeat(64), estado_participacao: 'incluido' }],
        criterios: [
            { id_criterio_ciclo: 501, id_criterio_origem: 101, id_ciclo: 20, id_evento: 17,
                nome: 'First frozen criterion', descricao: null, ordem: 1, peso: '40.00' },
            { id_criterio_ciclo: 502, id_criterio_origem: 102, id_ciclo: 20, id_evento: 17,
                nome: 'Second frozen criterion', descricao: null, ordem: 2, peso: '60.00' }
        ],
        publicacoes: [], avaliacoes: [], notas: []
    };
    const f = { state, calls: [], middleware: [], acquired: 0 };
    let active = false, readView, backup;
    const start = readonly => {
        assert.equal(active, false);
        active = true;
        backup = structuredClone(state);
        readView = readonly ? structuredClone(state) : null;
    };
    f.connection = {
        async beginTransaction() { f.calls.push('BEGIN'); start(false); },
        async commit() { f.calls.push('COMMIT'); assert(active); active = false; readView = null; },
        async rollback() {
            f.calls.push('ROLLBACK');
            assert(active);
            if (!readView) Object.assign(state, backup);
            active = false;
            readView = null;
        },
        release() { assert.equal(active, false); f.calls.push('RELEASE'); },
        destroy() { active = false; f.calls.push('DESTROY'); },
        async query(sql, params = []) {
            const s = sql.replace(/\s+/g, ' ').trim();
            f.calls.push(s);
            if (s.startsWith('SET TRANSACTION ISOLATION LEVEL ')) { assert(!active); return [[]]; }
            if (s === 'START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY') { start(true); return [[]]; }
            assert(active, 'Domain SQL must execute in the owned transaction');
            assert.doesNotMatch(s, /\bist_concorrentes\b|\bist_composicao\b|\bist_eventos_criterios_avaliacao\b/);
            if (f.error && s.includes(f.error.sql)) throw f.error.value;
            const v = readView || state;
            const rows = value => [structuredClone(value)];
            if (s.includes('FROM ist_eventos_julgamentos')) {
                const result = rows(v.julgamentos.filter(r => r.id_evento === params[0]));
                if (f.afterJudgment) { const fn = f.afterJudgment; f.afterJudgment = null; fn(); }
                return result;
            }
            if (s.includes('FROM ist_eventos_ciclos WHERE')) return rows(v.ciclos.filter(r => r.id_ciclo === params[0]));
            if (s.includes('FROM ist_eventos_publicacoes p')) return rows(v.publicacoes.filter(r => r.id_publicacao === params[0]).map(p => {
                const c = v.ciclos.find(c => c.id_ciclo === p.id_ciclo);
                return { ...p, ciclo_evento: c.id_evento, numero_ciclo: c.numero_ciclo,
                    estado_ciclo: c.estado, ciclo_publicado_em: c.publicado_em };
            }));
            if (s.includes('FROM ist_eventos_publicacoes WHERE')) return rows(v.publicacoes.filter(r => r.id_evento === params[0] && r.id_ciclo === params[1]));
            if (s.includes('FROM ist_usuarios')) return rows(v.usuarios.filter(r => r.id_usuario === params[0]));
            if (s.includes('FROM ist_eventos_jurados')) return rows(v.designacoes.filter(r => r.id_evento === params[0] && r.id_usuario === params[1] && r.ativo === 1));
            if (s.includes('FROM ist_eventos_ciclos_jurados')) return rows(v.jurados.filter(r => r.id_ciclo === params[0] && r.id_usuario === params[1]));
            if (s.includes('FROM ist_eventos_ciclos_concorrentes')) return rows(v.participantes.filter(r => r.id_ciclo === params[0] && r.id_concorrente === params[1]));
            if (s.includes('FROM ist_eventos_ciclos_criterios')) return rows(v.criterios.filter(r => r.id_ciclo === params[0]));
            if (s.startsWith('SELECT ') && s.includes('FROM ist_eventos_avaliacoes_notas')) return rows(v.notas.filter(r => r.id_avaliacao === params[0]));
            if (s.startsWith('SELECT ') && s.includes('FROM ist_eventos_avaliacoes ')) return rows(v.avaliacoes.filter(r =>
                r.id_evento === params[0] && r.id_ciclo === params[1] && r.id_jurado === params[2] && r.id_concorrente === params[3]));
            assert(!readView, 'GET must not mutate');
            if (s.startsWith('INSERT INTO ist_eventos_avaliacoes ')) {
                const [id_evento, id_ciclo, id_jurado, id_concorrente, estado, sinal, motivo] = params;
                const id = 60 + state.avaliacoes.length;
                state.avaliacoes.push({ id_avaliacao: id, id_evento, id_ciclo, id_jurado, id_concorrente,
                    numero_tentativa: 1, id_avaliacao_origem: null, estado, versao: 1,
                    possivel_desclassificacao: sinal, motivo_desclassificacao: motivo,
                    data_inclusao: date, data_atualizacao: date, data_conclusao: estado === 'concluida' ? date : null });
                return [{ insertId: id, affectedRows: 1 }];
            }
            if (s.startsWith('UPDATE ist_eventos_avaliacoes ')) {
                const [estado, versao, sinal, motivo, , id, idEvento, idCiclo, idJurado, idConcorrente, numero, anterior] = params;
                const a = state.avaliacoes.find(a => a.id_avaliacao === id && a.id_evento === idEvento && a.id_ciclo === idCiclo
                    && a.id_jurado === idJurado && a.id_concorrente === idConcorrente
                    && a.numero_tentativa === numero && a.estado === 'rascunho' && a.versao === anterior);
                if (!a) return [{ affectedRows: 0 }];
                Object.assign(a, { estado, versao, possivel_desclassificacao: sinal, motivo_desclassificacao: motivo,
                    data_atualizacao: date, data_conclusao: estado === 'concluida' ? date : null });
                return [{ affectedRows: 1 }];
            }
            if (s.startsWith('DELETE FROM ist_eventos_avaliacoes_notas ')) {
                state.notas = state.notas.filter(n => !(n.id_avaliacao === params[0] && n.id_evento === params[1] && n.id_ciclo === params[2]));
                return [{ affectedRows: 1 }];
            }
            if (s.startsWith('INSERT INTO ist_eventos_avaliacoes_notas ')) {
                for (let i = 0; i < params.length; i += 6) {
                    const [id_avaliacao, id_criterio, id_evento, id_ciclo, id_criterio_ciclo, nota] = params.slice(i, i + 6);
                    state.notas.push({ id_avaliacao, id_criterio, id_evento, id_ciclo, id_criterio_ciclo, nota });
                }
                return [{ affectedRows: params.length / 6 }];
            }
            assert.fail('Unexpected SQL: ' + s);
        }
    };
    f.seal = () => {
        Object.assign(state.ciclos[0], { estado: 'selado', publicado_em: date });
        state.publicacoes.push({ id_publicacao: 70, id_evento: 17, id_ciclo: 20, versao: 1, publicado_em: date });
        state.julgamentos[0].id_publicacao_vigente = 70;
    };
    f.reopen = () => {
        f.seal();
        state.ciclos.push({ id_ciclo: 21, id_evento: 17, numero_ciclo: 2, estado: 'aberto',
            id_ciclo_origem: 20, id_publicacao_origem: 70, publicado_em: null, motivo_reabertura: 'Formal reopening' });
        Object.assign(state.julgamentos[0], { id_ciclo_atual: 21, versao: 2 });
        state.jurados.push({ ...state.jurados[0], id_ciclo: 21 });
        state.participantes.push({ ...state.participantes[0], id_ciclo: 21, id_ciclo_concorrente: 31, nome_publico: 'Cycle two participant' });
        state.criterios.push(...state.criterios.map(c => ({ ...c, id_ciclo: 21, id_criterio_ciclo: c.id_criterio_ciclo + 100 })));
    };
    return f;
}
const payload = (dto, notas = [], changes = {}) => ({
    contexto: { idCiclo: dto.contexto.idCiclo, numeroTentativa: dto.contexto.numeroTentativa },
    versao: dto.versao, estado: 'rascunho', notas, possivelDesclassificacao: false,
    motivoDesclassificacao: null, ...changes
});
async function harness(t) {
    current = fixture();
    const app = express();
    app.use(cookieParser());
    app.use(express.json());
    app.use('/api/jurado', router);
    app.use((error, req, res, next) => {
        if (error.type === 'entity.parse.failed') return res.status(400).json({ message: 'Invalid JSON' });
        next(error);
    });
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(async () => {
        await new Promise((resolve, reject) => {
            server.close(e => e ? reject(e) : resolve());
            server.closeAllConnections();
        });
    });
    const request = async ({ method = 'GET', body, user = 10, id = '40', slug = event.slug, raw } = {}) => {
        const headers = user === null ? {} : { Cookie: `cutover_test=${jwt.sign({ id_usuario: user, id_tipo_usuario: 4 }, secret)}` };
        if (body !== undefined || raw !== undefined) headers['Content-Type'] = 'application/json';
        const r = await fetch(`http://127.0.0.1:${server.address().port}/api/jurado/eventos/${slug}/concorrentes/${id}/avaliacao`, {
            method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body))
        });
        return { status: r.status, body: await r.json() };
    };
    return { f: current, request, get: async () => {
        const r = await request();
        assert.equal(r.status, 200);
        return r.body;
    }, put: body => request({ method: 'PUT', body }) };
}
test('22/23: default real GET/PUT bindings select cycle-aware controllers, never legacy', () => {
    for (const [method, expected, legacy] of [
        ['get', obterAvaliacaoJuradoCycleAwareController, obterAvaliacaoJurado],
        ['put', salvarAvaliacaoJuradoCycleAwareController, salvarAvaliacaoJurado]
    ]) {
        const route = router.stack.find(l => l.route?.path === '/eventos/:slug/concorrentes/:idParticipacao/avaliacao' && l.route.methods[method]).route;
        assert.equal(route.stack.length, 3);
        assert.equal(route.stack.at(-1).handle, expected);
        assert(!route.stack.some(l => l.handle === legacy));
    }
});
test('1/2/3: real GET uses reader and policy with frozen material and one read-only snapshot', async t => {
    const h = await harness(t), before = structuredClone(h.f.state), dto = await h.get();
    assert.deepEqual(dto.contexto, { idCiclo: 20, numeroCiclo: 1, numeroTentativa: null });
    assert.equal(dto.podeGravar, true);
    assert.deepEqual(dto.autorizacaoGravacao, { estado: 'autorizada', code: null, motivo: null });
    assert.equal(dto.concorrente.nome, 'Frozen participant');
    assert.equal(dto.criterios[0].idCriterioCiclo, 501);
    assert.equal(dto.estado, 'pendente');
    assert.deepEqual(h.f.state, before);
    assert.equal(h.f.acquired, 1);
    assert.deepEqual(h.f.calls.slice(0, 2), ['SET TRANSACTION ISOLATION LEVEL REPEATABLE READ', 'START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY']);
    assert.deepEqual(h.f.calls.slice(-2), ['COMMIT', 'RELEASE']);
    assert(!h.f.calls.some(s => /\b(INSERT|UPDATE|DELETE)\b/.test(s)));
});
test('8/9/10: first PUT, draft update and full note replacement return real post-write DTO', async t => {
    const h = await harness(t), empty = await h.get();
    const first = await h.put(payload(empty, [{ idCriterioCiclo: 501, nota: 25 }, { idCriterioCiclo: 502, nota: 75 }]));
    assert.equal(first.status, 200);
    assert.equal(first.body.versao, 1);
    assert.equal(first.body.contexto.numeroTentativa, 1);
    assert.equal(first.body.avaliacao.media, '55.00');
    assert.equal(h.f.state.avaliacoes.length, 1);
    const updated = await h.put(payload(first.body, [{ idCriterioCiclo: 502, nota: 60 }]));
    assert.equal(updated.status, 200);
    assert.equal(updated.body.versao, 2);
    assert.equal(updated.body.podeGravar, true);
    assert.equal(updated.body.avaliacao.media, null);
    assert.deepEqual(updated.body.avaliacao.notas, [{ idCriterio: 102, idCriterioOrigem: 102, idCriterioCiclo: 502, nota: 60 }]);
    assert.equal(h.f.state.notas.length, 1);
    assert.deepEqual(h.f.calls.slice(-2), ['COMMIT', 'RELEASE']);
});
test('4/11/12: completion is readable, policy denies future writes, normal PUT cannot reopen', async t => {
    const h = await harness(t), dto = await h.get();
    const completed = await h.put(payload(dto, [{ idCriterioCiclo: 501, nota: 80 }, { idCriterioCiclo: 502, nota: 90 }], { estado: 'concluida' }));
    assert.equal(completed.status, 200);
    const read = await h.get();
    assert.deepEqual(read, completed.body);
    assert.equal(read.podeGravar, false);
    assert.equal(read.autorizacaoGravacao.estado, 'avaliacao_concluida');
    assert.equal(read.autorizacaoGravacao.code, 'AVALIACAO_CONCLUIDA');
    const before = structuredClone(h.f.state), rejected = await h.put(payload(read));
    assert.equal(rejected.status, 409);
    assert.equal(rejected.body.code, 'AVALIACAO_CONCLUIDA');
    assert.deepEqual(h.f.state, before);
});
test('5/19: published/sealed cycle remains readable but PUT is denied without changes', async t => {
    const h = await harness(t);
    h.f.seal();
    const dto = await h.get(), before = structuredClone(h.f.state);
    assert.equal(dto.podeGravar, false);
    assert.equal(dto.autorizacaoGravacao.estado, 'ciclo_fechado');
    const r = await h.put(payload(dto));
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'CONTEXTO_NAO_GRAVAVEL');
    assert.deepEqual(h.f.state, before);
});
test('13: reopened cycle 2 isolates prior evaluations, notes and publication; old tab tokens reject', async t => {
    const h = await harness(t), first = await h.put(payload(await h.get(), [{ idCriterioCiclo: 501, nota: 25 }]));
    h.f.reopen();
    const before = structuredClone(h.f.state), dto = await h.get();
    assert.deepEqual(dto.contexto, { idCiclo: 21, numeroCiclo: 2, numeroTentativa: null });
    assert.equal(dto.avaliacao, null);
    assert.equal(dto.versao, 0);
    assert.equal(dto.concorrente.nome, 'Cycle two participant');
    assert.equal(dto.podeGravar, true);
    assert.deepEqual(dto.criterios.map(c => c.idCriterioCiclo), [601, 602]);
    const r = await h.put(payload(first.body));
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'CICLO_DESATUALIZADO');
    assert.deepEqual(h.f.state, before);
    assert.equal(h.f.calls.filter(s => s === 'BEGIN').length, 2, 'No automatic retry');
});
test('GET remains in one snapshot if judgment switches cycle between reader queries', async t => {
    const h = await harness(t);
    h.f.afterJudgment = () => h.f.reopen();
    const dto = await h.get();
    assert.equal(h.f.state.julgamentos[0].id_ciclo_atual, 21);
    assert.equal(dto.contexto.idCiclo, 20);
    assert.equal(dto.concorrente.nome, 'Frozen participant');
    assert.deepEqual(dto.criterios.map(c => c.idCriterioCiclo), [501, 502]);
    assert.equal((await h.get()).contexto.idCiclo, 21);
});
for (const [name, changes, code] of [
    ['13 stale cycle', d => ({ contexto: { idCiclo: 99, numeroTentativa: d.contexto.numeroTentativa } }), 'CICLO_DESATUALIZADO'],
    ['14 stale attempt', d => ({ contexto: { idCiclo: d.contexto.idCiclo, numeroTentativa: 2 } }), 'TENTATIVA_DESATUALIZADA'],
    ['15 stale version', () => ({ versao: 2 }), 'VERSAO_DESATUALIZADA'],
    ['16 foreign snapshot criterion', () => ({ notas: [{ idCriterioCiclo: 999, nota: 50 }] }), 'PAYLOAD_INVALIDO']
]) test(name + ' is rejected without mutations or retry', async t => {
    const h = await harness(t), created = await h.put(payload(await h.get())), before = structuredClone(h.f.state);
    const r = await h.put(payload(created.body, [], changes(created.body)));
    assert.equal(r.status, code === 'PAYLOAD_INVALIDO' ? 400 : 409);
    assert.equal(r.body.code, code);
    assert.deepEqual(h.f.state, before);
    assert.equal(h.f.calls.filter(s => s === 'BEGIN').length, 2);
});
for (const [name, mutate, getStatus, putStatus, code] of [
    ['6/18 absent participant', s => { s.participantes = []; }, 404, 404, 'CONCORRENTE_AUSENTE'],
    ['6/18 excluded participant', s => { s.participantes[0].estado_participacao = 'inelegivel'; }, 409, 409, 'CONCORRENTE_NAO_INCLUIDO'],
    ['juror outside roster', s => { s.jurados = []; }, 403, 403, 'JURADO_FORA_ROSTER'],
    ['missing judgment', s => { s.julgamentos = []; }, 404, 404, 'JULGAMENTO_NAO_CONFIGURADO'],
    ['missing current cycle', s => { s.julgamentos[0].id_ciclo_atual = null; }, 404, 404, 'CICLO_ATUAL_AUSENTE']
]) test(name + ': both real methods enforce context, without live completion', async t => {
    const h = await harness(t), initial = await h.get();
    mutate(h.f.state);
    const before = structuredClone(h.f.state), read = await h.request(), write = await h.put(payload(initial));
    assert.equal(read.status, getStatus);
    assert.equal(read.body.code, code);
    assert.equal(write.status, putStatus);
    assert.equal(write.body.code, code === 'JURADO_FORA_ROSTER' ? 'ACESSO_OPERACIONAL_NEGADO'
        : code === 'CONCORRENTE_NAO_INCLUIDO' ? 'CONTEXTO_NAO_GRAVAVEL' : code);
    assert.deepEqual(h.f.state, before);
});
test('17: revoked live juror is blocked by the actual HTTP middleware, preserving frozen history', async t => {
    const h = await harness(t), dto = await h.get();
    h.f.revoked = true;
    h.f.state.designacoes[0].ativo = 0;
    const before = structuredClone(h.f.state), acquired = h.f.acquired;
    for (const r of [await h.request(), await h.put(payload(dto))]) assert.equal(r.status, 403);
    assert.equal(h.f.acquired, acquired);
    assert.equal(h.f.state.jurados[0].estado_participacao, 'incluido');
    assert.deepEqual(h.f.state, before);
});
test('HTTP live gate can pass but writer rechecks eligibility under its transaction locks', async t => {
    const h = await harness(t), dto = await h.get();
    h.f.state.usuarios[0].id_situacao = 9;
    const before = structuredClone(h.f.state), r = await h.put(payload(dto));
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'ACESSO_OPERACIONAL_NEGADO');
    assert.deepEqual(h.f.state, before);
});
for (const [name, body] of [
    ['20 legacy payload without context', { versao: 0, estado: 'rascunho', notas: [{ idCriterio: 101, nota: 50 }], possivelDesclassificacao: false, motivoDesclassificacao: null }],
    ['legacy criterion alias with explicit context', { contexto: { idCiclo: 20, numeroTentativa: null }, versao: 0,
        estado: 'rascunho', notas: [{ idCriterio: 101, nota: 50 }], possivelDesclassificacao: false, motivoDesclassificacao: null }],
    ['malformed body', []]
]) test(name + ': 400, no conversion, no database transaction', async t => {
    const h = await harness(t), before = structuredClone(h.f.state), r = await h.put(body);
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'PAYLOAD_INVALIDO');
    assert.equal(h.f.acquired, 0);
    assert.deepEqual(h.f.state, before);
});
for (const method of ['GET', 'PUT']) test('7/21: ' + method + ' unknown SQL error has neutral 500 and rollback', async t => {
    const h = await harness(t), dto = await h.get(), before = structuredClone(h.f.state);
    h.f.error = { sql: method === 'GET' ? 'FROM ist_eventos_julgamentos' : 'INSERT INTO ist_eventos_avaliacoes ',
        value: Object.assign(new Error('SELECT private SQL password driver stack'), { code: 'PAYLOAD_INVALIDO', sql: 'secret' }) };
    const r = await h.request({ method, body: method === 'PUT' ? payload(dto) : undefined });
    assert.equal(r.status, 500);
    assert.deepEqual(Object.keys(r.body), ['message']);
    assert.doesNotMatch(JSON.stringify(r.body), /SELECT|private|password|driver|stack|secret|PAYLOAD_INVALIDO/);
    assert.deepEqual(h.f.state, before);
    assert.deepEqual(h.f.calls.slice(-2), ['ROLLBACK', 'RELEASE']);
});
for (const method of ['GET', 'PUT']) test(method + ': JWT, event lookup and canonical HTTP id validation stay enforced', async t => {
    const h = await harness(t);
    assert.equal((await h.request({ method, user: null })).status, 401);
    assert.equal((await h.request({ method, slug: 'nonexistent' })).status, 404);
    for (const id of ['0', '01', '-1', '1.5', '1x', '4294967296'])
        assert.equal((await h.request({ method, id })).status, 400);
    assert.equal(h.f.acquired, 0);
});
test('PUT malformed JSON is 400 before either service', async t => {
    const h = await harness(t);
    assert.equal((await h.request({ method: 'PUT', raw: '{' })).status, 400);
    assert.equal(h.f.acquired, 0);
});
