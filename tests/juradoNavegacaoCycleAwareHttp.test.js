import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { after, before, test } from 'node:test';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import { pool } from '../src/config/db.js';
import { criarJuradoNavegacaoControllers } from '../src/controllers/juradoNavegacaoCycleAwareController.js';
import { JuradoNavegacaoError } from '../src/services/juradoNavegacaoCycleAwareService.js';
import { JulgamentoContextError } from '../src/services/julgamentoContextService.js';

const secret = 'synthetic-navigation-http-secret';
const previous = { JWT_SECRET: process.env.JWT_SECRET, COOKIE_NAME: process.env.COOKIE_NAME };
let criarJuradoRouter, actualRouter;
try {
    process.env.JWT_SECRET = secret;
    process.env.COOKIE_NAME = 'navigation_test';
    ({ criarJuradoRouter, default: actualRouter } = await import('../src/routes/jurado.routes.js'));
} finally {
    for (const [key, value] of Object.entries(previous))
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
}
const ev = { id: 101, slug: 'fixture-event', nome: 'Live event label' };
const contexto = { idCiclo: 8001, numeroCiclo: 2, estadoCiclo: 'aberto', versaoJulgamento: 2 };
const participant = { idParticipacao: 3001, idSnapshot: 9000, numeroConcorrente: 'FROZEN-1',
    nome: 'Frozen participant', obraPrincipal: { id: 5001, titulo: 'Frozen work' },
    linkVideoPrincipal: 'https://example.invalid/frozen', obraOpcional: null, linkVideoOpcional: null };
const originalQuery = pool.query, originalConnection = pool.getConnection;
let current;
before(() => {
    pool.query = async (sql, params) => {
        current.sql.push(sql);
        if (sql.includes('FROM ist_eventos WHERE slug')) return [current.missing ? [] : [ev]];
        if (sql.includes('FROM ist_usuarios u') && sql.includes('INNER JOIN ist_eventos_jurados'))
            return [current.revoked || params[0] === 1002 ? [] : [ev]];
        throw new Error('Unexpected legacy SQL: ' + sql);
    };
    pool.getConnection = async () => { throw new Error('Unexpected real connection'); };
});
after(() => { pool.query = originalQuery; pool.getConnection = originalConnection; });
async function harness(t, options = {}) {
    current = { sql: [], calls: [], revoked: false, missing: false, ...options };
    const call = (name, dto) => async (...args) => {
        current.calls.push({ name, args });
        if (options.error) throw options.error;
        return dto;
    };
    const handlers = criarJuradoNavegacaoControllers({
        acessos: call('acessos', { eventos: [{ ...ev, contexto }] }),
        evento: call('evento', { evento: ev, contexto }),
        fila: call('fila', { evento: ev, contexto, concorrentes: [participant],
            pagination: { page: 1, limit: 25, total: 1, totalPages: 1 } }),
        detalhe: call('detalhe', { evento: ev, contexto, concorrente: participant })
    });
    const app = express();
    app.use(cookieParser());
    app.use(express.json());
    app.use('/api/jurado', options.actual ? actualRouter : criarJuradoRouter({ navegacao: handlers }));
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(async () => {
        await new Promise((resolve, reject) => {
            server.close(e => e ? reject(e) : resolve());
            server.closeAllConnections();
        });
    });
    return async (suffix, { user = 1001, method = 'GET', body } = {}) => {
        const headers = user === null ? {} : { Cookie: `navigation_test=${jwt.sign({ id_usuario: user, id_tipo_usuario: 4 }, secret)}` };
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api/jurado${suffix}`,
            { headers, method, body: body === undefined ? undefined : JSON.stringify(body) });
        return { status: response.status, body: await response.json() };
    };
}
test('A: real paths preserve JWT authentication and event middleware; open DTO is delegated', async t => {
    const request = await harness(t);
    assert.equal((await request('/acessos', { user: null })).status, 401);
    assert.equal(current.calls.length, 0);
    const response = await request('/eventos/fixture-event');
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { evento: ev, contexto });
    assert.deepEqual(current.calls, [{ name: 'evento', args: ['fixture-event', 1001] }]);
    assert.equal(current.sql.length, 2);
});
test('access list delegates cycle-aware service and retains event envelope', async t => {
    const request = await harness(t);
    assert.deepEqual((await request('/acessos')).body, { eventos: [{ ...ev, contexto }] });
    assert.deepEqual(current.calls[0].args, [1001]);
    assert.equal(current.sql.length, 0);
});
test('B/G: queue preserves frozen DTO/current reopened cycle without legacy membership SQL', async t => {
    const request = await harness(t);
    const response = await request('/eventos/fixture-event/concorrentes?page=1&limit=25&sort=nome&order=desc');
    assert.equal(response.status, 200);
    assert.equal(response.body.contexto.idCiclo, 8001);
    assert.deepEqual(response.body.concorrentes, [participant]);
    assert.deepEqual(current.calls[0].args, ['fixture-event', 1001, { page: 1, limit: 25, sort: 'nome', order: 'desc' }]);
    assert.equal(current.sql.length, 2);
    assert(!('cidade' in response.body.concorrentes[0]));
    assert(!('dataInscricao' in response.body.concorrentes[0]));
});
test('C: detail is the material endpoint and forwards only authenticated identity', async t => {
    const request = await harness(t);
    const response = await request('/eventos/fixture-event/concorrentes/3001?idUsuario=999');
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.concorrente, participant);
    assert.deepEqual(current.calls[0].args, ['fixture-event', 3001, 1001]);
    assert.equal(current.sql.length, 2);
});
for (const value of ['0', '-1', '1x', '4294967296', '9007199254740992'])
    test(`invalid detail id ${value} is HTTP 400 before service`, async t => {
        const request = await harness(t);
        assert.equal((await request(`/eventos/fixture-event/concorrentes/${value}`)).status, 400);
        assert.equal(current.calls.length, 0);
    });
for (const query of ['page=0', 'limit=101', 'sort=dataInscricao', 'sort=nome&sort=numeroConcorrente',
    'order=drop'])
    test(`invalid/unsupported queue ${query} is 400 without domain query`, async t => {
        const request = await harness(t);
        assert.equal((await request(`/eventos/fixture-event/concorrentes?${query}`)).status, 400);
        assert.equal(current.calls.length, 0);
    });
test('G: forged cycle in query cannot override the current reopened cycle', async t => {
    const request = await harness(t);
    const response = await request('/eventos/fixture-event/concorrentes?idCiclo=1');
    assert.equal(response.status, 200);
    assert.equal(response.body.contexto.idCiclo, 8001);
    assert.deepEqual(current.calls[0].args[2], { page: 1, limit: 25, sort: 'numeroConcorrente', order: 'asc' });
});
test('D: out-of-snapshot participant is 404 even when live event authorization passes', async t => {
    const request = await harness(t, { error: new JuradoNavegacaoError('CONCORRENTE_AUSENTE') });
    const response = await request('/eventos/fixture-event/concorrentes/3103');
    assert.equal(response.status, 404);
    assert.equal(response.body.code, 'CONCORRENTE_AUSENTE');
});
test('E: real live authorization rejects revoked juror before navigation service', async t => {
    const request = await harness(t);
    assert.equal((await request('/eventos/fixture-event', { user: 1002 })).status, 403);
    assert.equal(current.calls.length, 0);
});
test('F: event absent in middleware is 404 before service', async t => {
    const request = await harness(t, { missing: true });
    assert.equal((await request('/eventos/fixture-event')).status, 404);
    assert.equal(current.calls.length, 0);
});
for (const [errorCode, status] of [['EVENTO_INEXISTENTE', 404], ['CICLO_ATUAL_AUSENTE', 404],
    ['JULGAMENTO_NAO_CONFIGURADO', 404], ['JURADO_FORA_ROSTER', 403], ['JURADO_NAO_INCLUIDO', 403]])
    test(`typed context error ${errorCode} maps ${status}`, async t => {
        const request = await harness(t, { error: new JulgamentoContextError(errorCode) });
        assert.equal((await request('/eventos/fixture-event')).status, status);
    });
test('H: driver-looking error and spoofed code never expose SQL, stack or internals', async t => {
    const request = await harness(t, { error: Object.assign(new Error('SELECT secret FROM private; stack'), { code: 'CONCORRENTE_AUSENTE' }) });
    const response = await request('/eventos/fixture-event/concorrentes/3001');
    assert.equal(response.status, 500);
    assert.deepEqual(response.body, { message: 'N\u00e3o foi poss\u00edvel consultar a navega\u00e7\u00e3o do jurado.' });
});
test('default production router binds cycle-aware navigation, not only injectable handlers', async t => {
    const request = await harness(t, { actual: true });
    let queries = 0, committed = 0, released = 0;
    pool.getConnection = async () => ({
        query: async sql => {
            queries++;
            if (sql.startsWith('SET ') || sql.startsWith('START ')) return [[], []];
            if (sql.includes('FROM ist_usuarios u')) return [[]];
            throw new Error('Unexpected default navigation SQL');
        },
        commit: async () => { committed++; }, rollback: async () => {},
        release: () => { released++; }, destroy: () => assert.fail('Unexpected destroy')
    });
    try {
        assert.deepEqual((await request('/acessos')).body, { eventos: [] });
        assert.equal(queries, 3); assert.equal(committed, 1); assert.equal(released, 1);
    } finally { pool.getConnection = async () => { throw new Error('Unexpected real connection'); }; }
});
test('I: real GET/PUT evaluation bindings are cycle-aware and never select legacy handlers', async () => {
    const controller = readFileSync(new URL('../src/controllers/juradoController.js', import.meta.url), 'utf8');
    const evaluation = controller.slice(controller.indexOf('const responderErroAvaliacao'));
    assert.match(evaluation, /consultarAvaliacao\(req\.eventoJurado, idParticipacao, req\.usuario\.id_usuario\)/);
    assert.match(evaluation, /persistirAvaliacao\(req\.eventoJurado, idParticipacao, req\.usuario\.id_usuario, req\.body\)/);
    assert.doesNotMatch(evaluation, /CycleAware|idCiclo|numeroTentativa/);
    const { obterAvaliacaoJurado, salvarAvaliacaoJurado } = await import('../src/controllers/juradoController.js');
    const { obterAvaliacaoJuradoCycleAwareController, salvarAvaliacaoJuradoCycleAwareController } =
        await import('../src/controllers/juradoAvaliacaoCycleAwareController.js');
    for (const [method, handler, legacy] of [
        ['get', obterAvaliacaoJuradoCycleAwareController, obterAvaliacaoJurado],
        ['put', salvarAvaliacaoJuradoCycleAwareController, salvarAvaliacaoJurado]
    ]) {
        const layer = actualRouter.stack.find(l => l.route?.path.endsWith('/avaliacao') && l.route.methods[method]);
        assert.equal(layer.route.stack.at(-1).handle, handler);
        assert(!layer.route.stack.some(l => l.handle === legacy));
    }
});
test('I: GET/PUT evaluation on real router reject malformed ids before cycle-aware services', async t => {
    const request = await harness(t);
    for (const method of ['GET', 'PUT'])
        assert.equal((await request('/eventos/fixture-event/concorrentes/0/avaliacao', { method })).status, 400);
    assert.equal(current.calls.length, 0);
});
