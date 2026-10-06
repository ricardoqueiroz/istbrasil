import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { after, before, test } from 'node:test';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import { pool } from '../src/config/db.js';
import { criarSalvarAvaliacaoJuradoCycleAwareController } from '../src/controllers/juradoAvaliacaoCycleAwareController.js';
import { JuradoAvaliacaoGravacaoError, GRAVACAO_ERROS } from '../src/services/juradoAvaliacaoGravacaoService.js';
import { JulgamentoContextError, JULGAMENTO_ERROS } from '../src/services/julgamentoContextService.js';
import { autorizarJuradoEvento } from '../src/middlewares/juradoAuthorizationMiddleware.js';

const secret = 'synthetic-cycle-aware-http-test-secret';
const cookieName = 'cycle_aware_http_test_session';
const ambienteAnterior = { JWT_SECRET: process.env.JWT_SECRET, COOKIE_NAME: process.env.COOKIE_NAME };
let autenticarUsuario;
// O middleware captura o ambiente no import, antes de qualquer teste iniciar.
try {
    process.env.JWT_SECRET = secret;
    process.env.COOKIE_NAME = cookieName;
    ({ autenticarUsuario } = await import('../src/middlewares/authMiddleware.js'));
} finally {
    for (const [key, value] of Object.entries(ambienteAnterior)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
}

const evento = Object.freeze({ id: 17, slug: 'evento-teste', nome: 'Evento Teste' });
const path = '/api/jurado/eventos/evento-teste/concorrentes/40/avaliacao';
const payload = () => ({
    contexto: { idCiclo: 20, numeroTentativa: null }, versao: 0, estado: 'rascunho',
    notas: [{ idCriterioCiclo: 501, nota: 80 }], possivelDesclassificacao: false, motivoDesclassificacao: null
});
const dto = () => ({
    evento, contexto: { idCiclo: 20, numeroCiclo: 1, numeroTentativa: 1 }, versao: 1,
    podeGravar: true, autorizacaoGravacao: { estado: 'autorizada', code: null, motivo: null }, estado: 'rascunho',
    criterios: [{ idCriterio: 101, idCriterioOrigem: 101, idCriterioCiclo: 501, peso: '100.00' }],
    avaliacao: { idAvaliacao: 60, media: '80.00', notas: [{ idCriterioCiclo: 501, nota: 80 }] }
});
const token = (claims = { id_usuario: 10, id_tipo_usuario: 4 }, options = {}) =>
    jwt.sign(claims, secret, { expiresIn: '5m', ...options });
const neutral = { message: 'N\u00e3o foi poss\u00edvel concluir a opera\u00e7\u00e3o de avalia\u00e7\u00e3o.' };
const originalQuery = pool.query;
const originalGetConnection = pool.getConnection;
let forbiddenQueries = 0;
let forbiddenConnections = 0;
let closedServers = 0;
let openedServers = 0;

before(() => {
    pool.query = () => { forbiddenQueries++; throw new Error('Real SQL forbidden in HTTP harness'); };
    pool.getConnection = () => { forbiddenConnections++; throw new Error('Real connection forbidden in HTTP harness'); };
});
after(() => {
    pool.query = originalQuery;
    pool.getConnection = originalGetConnection;
    assert.equal(forbiddenQueries, 0);
    assert.equal(forbiddenConnections, 0);
    assert.equal(closedServers, openedServers);
    assert.deepEqual({ JWT_SECRET: process.env.JWT_SECRET, COOKIE_NAME: process.env.COOKIE_NAME }, ambienteAnterior);
});

const harness = async (t, { authorization = 'allowed', realAuthorization = false, writer = async () => dto(),
    responseFailure = null, simulatedAuthentication = false } = {}) => {
    const state = { trace: [], calls: [], bodies: [], responses: [], errors: [], attemptedStatuses: [], jsonAttempts: 0, gets: 0 };
    const app = express();
    app.set('env', 'production');
    app.use(cookieParser());
    app.use(express.json());
    const router = express.Router();
    const authenticate = (req, res, next) => {
        state.trace.push('authentication');
        if (simulatedAuthentication) {
            req.usuario = { id_usuario: 10 };
            return next();
        }
        return autenticarUsuario(req, res, next);
    };
    const authorize = (req, res, next) => {
        state.trace.push('authorization');
        if (realAuthorization) return autorizarJuradoEvento(req, res, next);
        if (authorization === 'missing') return res.status(404).json({ message: 'Evento n\u00e3o encontrado.' });
        if (authorization === 'denied') return res.status(403).json({ message: 'Acesso ao evento n\u00e3o autorizado.' });
        req.eventoJurado = evento;
        return next();
    };
    const adapter = criarSalvarAvaliacaoJuradoCycleAwareController({
        salvarAvaliacao: async (...args) => {
            state.trace.push('writer');
            state.calls.push(args);
            return writer(...args);
        }
    });
    const inspect = (req, res, next) => {
        state.bodies.push(req.body);
        const status = res.status;
        const json = res.json;
        let failed = false;
        res.status = function (code) {
            state.attemptedStatuses.push(code);
            if (responseFailure === 'status-persistent' || (responseFailure === 'status-once' && !failed)) {
                failed = true;
                throw new Error('synthetic response failure');
            }
            return status.call(this, code);
        };
        res.json = function (value) {
            state.jsonAttempts++;
            state.responses.push(value);
            if ((responseFailure === 'json-once' || responseFailure === 'partial') && !failed) {
                failed = true;
                if (responseFailure === 'partial') {
                    this.setHeader('Content-Type', 'application/json');
                    this.write('{"partial":');
                }
                throw new Error('synthetic response failure');
            }
            return json.call(this, value);
        };
        // Parametro externo presente somente no router de teste.
        req.params.idJurado = '98';
        return next();
    };
    router.put('/eventos/:slug/concorrentes/:idParticipacao/avaliacao', authenticate, authorize, inspect, adapter);
    router.get('/eventos/:slug/concorrentes/:idParticipacao/avaliacao', (_req, res) => {
        state.gets++;
        return res.sendStatus(405);
    });
    app.use('/api/jurado', router);
    // Handler exclusivo deste harness; nao esta instalado no servidor produtivo.
    app.use((error, req, res, next) => {
        state.errors.push({ headersSent: res.headersSent, type: error.type });
        if (res.headersSent) return next(new Error('Response interrupted'));
        const parsing = error instanceof SyntaxError && error.type === 'entity.parse.failed' && error.status === 400;
        // Usa os metodos originais do Express quando o teste injeta falha persistente.
        return express.response.status.call(res, parsing ? 400 : 500).json(
            parsing ? { message: 'JSON inv\u00e1lido.' } : neutral
        );
    });
    const server = http.createServer(app);
    t.after(async () => {
        if (!server.listening) return;
        await new Promise((resolve, reject) => {
            server.close(error => error ? reject(error) : resolve());
            server.closeAllConnections();
        });
        assert.equal(server.listening, false);
        closedServers++;
        assert.ok(state.calls.length <= state.bodies.length);
        assert.equal(state.gets, 0);
    });
    const listening = once(server, 'listening');
    server.listen(0, '127.0.0.1');
    await listening;
    openedServers++;
    assert.ok(server.listening);
    const base = `http://127.0.0.1:${server.address().port}`;
    const request = async ({ session = token(), route = path, body = JSON.stringify(payload()),
        contentType = 'application/json' } = {}) => {
        const headers = {};
        if (session !== null) headers.Cookie = `${cookieName}=${session}`;
        if (contentType !== null) headers['Content-Type'] = contentType;
        const result = await fetch(base + route, { method: 'PUT', headers, body, signal: AbortSignal.timeout(5000) });
        const text = await result.text();
        return { status: result.status, body: JSON.parse(text), text };
    };
    return { state, request, base };
};

test('JWT real e HTTP: ordem, payload por identidade, DTO intacto, uma gravacao e nenhum GET', async t => {
    const resultDto = dto();
    const beforeDto = structuredClone(resultDto);
    const { state, request } = await harness(t, { writer: async () => resultDto });
    const result = await request();
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, resultDto);
    assert.equal(state.responses[0], resultDto);
    assert.deepEqual(resultDto, beforeDto);
    assert.deepEqual(state.trace, ['authentication', 'authorization', 'writer']);
    assert.equal(state.calls.length, 1);
    assert.equal(state.calls[0][0], evento);
    assert.equal(state.calls[0][1], 40);
    assert.equal(state.calls[0][2], 10);
    assert.equal(state.calls[0][3], state.bodies[0]);
    assert.deepEqual(state.calls[0][3], payload());
});

const invalidSessions = [
    ['cookie ausente', null], ['assinatura invalida', jwt.sign({ id_usuario: 10, id_tipo_usuario: 4 }, 'wrong-test-secret')],
    ['expirado', token(undefined, { expiresIn: -1 })], ['claims ausentes', token({})],
    ['usuario zero', token({ id_usuario: 0, id_tipo_usuario: 4 })],
    ['usuario negativo', token({ id_usuario: -1, id_tipo_usuario: 4 })],
    ['usuario fracionario', token({ id_usuario: 1.5, id_tipo_usuario: 4 })],
    ['usuario texto invalido', token({ id_usuario: 'abc', id_tipo_usuario: 4 })],
    ['tipo ausente', token({ id_usuario: 10 })], ['tipo zero', token({ id_usuario: 10, id_tipo_usuario: 0 })]
];
for (const [name, session] of invalidSessions) {
    test(`JWT real rejeita ${name} antes da autorizacao`, async t => {
        const { state, request } = await harness(t);
        assert.equal((await request({ session })).status, 401);
        assert.deepEqual(state.trace, ['authentication']);
        assert.equal(state.calls.length, 0);
    });
}
test('JWT real respeita conversao numerica existente dos claims', async t => {
    const { state, request } = await harness(t);
    assert.equal((await request({ session: token({ id_usuario: '10', id_tipo_usuario: '4' }) })).status, 200);
    assert.equal(state.calls[0][2], 10);
});
test('body, query e params nunca substituem jurado JWT; extras chegam intactos', async t => {
    const sent = { ...payload(), idJurado: 99 };
    const { state, request } = await harness(t, { writer: async () => {
        throw new JuradoAvaliacaoGravacaoError(GRAVACAO_ERROS.PAYLOAD_INVALIDO);
    } });
    assert.equal((await request({ route: path + '?idJurado=97', body: JSON.stringify(sent) })).status, 400);
    assert.equal(state.calls.length, 1);
    assert.equal(state.calls[0][2], 10);
    assert.deepEqual(state.calls[0][3], sent);
});
for (const [authorization, status] of [['missing', 404], ['denied', 403]]) {
    test(`autorizacao simulada ${authorization} impede writer`, async t => {
        const { state, request } = await harness(t, { authorization });
        assert.equal((await request()).status, status);
        assert.deepEqual(state.trace, ['authentication', 'authorization']);
        assert.equal(state.calls.length, 0);
    });
}

const withRealAuthorization = async (scenario, run, transformQuery = (sql, params) => ({ sql, params })) => {
    const previousQuery = pool.query;
    const previousConnection = pool.getConnection;
    const queries = [];
    const violations = [];
    const expectedCount = ['missing', 'query-failure'].includes(scenario) ? 1 : 2;
    let deliberateFailureInjected = false;
    pool.query = async (sql, params) => {
        queries.push({ sql, params });
        try {
            ({ sql, params } = transformQuery(sql, params));
            assert.ok(queries.length <= expectedCount, 'Unexpected query count');
            if (queries.length === 1) {
                assert.equal(sql, 'SELECT id, slug, nome FROM ist_eventos WHERE slug = ?');
                assert.deepEqual(params, ['evento-teste']);
            } else {
                assert.equal(sql.replace(/\s+/g, ' ').trim(),
                    'SELECT e.id, e.slug, e.nome FROM ist_usuarios u INNER JOIN ist_eventos_jurados j ON j.id_usuario = u.id_usuario '
                    + 'INNER JOIN ist_eventos e ON e.id = j.id_evento WHERE u.id_usuario = ? AND u.id_tipo_usuario = ? '
                    + 'AND u.id_situacao = ? AND u.id_cargo = ? AND j.ativo = ? AND e.id = ? ORDER BY e.nome, e.id');
                assert.deepEqual(params, [10, 4, 8, 11, 1, 17]);
            }
        } catch (error) {
            violations.push(error);
            throw error;
        }
        if (queries.length === 1) {
            if (scenario === 'query-failure') {
                deliberateFailureInjected = true;
                throw new Error('private SQL constraint stack');
            }
            return [scenario === 'missing' ? [] : [{ ...evento }], []];
        }
        return [scenario === 'denied' ? [] : [{ ...evento }], []];
    };
    pool.getConnection = () => { forbiddenConnections++; throw new Error('Connection forbidden'); };
    try { await run(queries); } finally {
        pool.query = previousQuery;
        pool.getConnection = previousConnection;
    }
    // So verifica o contrato se o callback terminou normalmente; nao substitui seu erro.
    assert.equal(violations.length, 0, 'SQL fake contract violation captured outside middleware');
    assert.equal(queries.length, expectedCount, 'Unexpected final query count');
    assert.equal(deliberateFailureInjected, scenario === 'query-failure', 'Deliberate failure injection not confirmed');
};
for (const [scenario, status, count] of [['missing', 404, 1], ['denied', 403, 2], ['allowed', 200, 2], ['query-failure', 500, 1]]) {
    test(`middleware autorizacao real com query fake: ${scenario}`, { concurrency: false }, async t => {
        t.mock.method(console, 'error', () => {});
        await withRealAuthorization(scenario, async queries => {
            const { state, request } = await harness(t, { realAuthorization: true });
            const result = await request();
            assert.equal(result.status, status);
            assert.equal(queries.length, count);
            assert.equal(state.calls.length, status === 200 ? 1 : 0);
            if (status === 200) assert.deepEqual(state.calls[0][0], evento);
            if (scenario === 'query-failure') {
                assert.deepEqual(result.body, { message: 'N\u00e3o foi poss\u00edvel validar o acesso ao evento.' });
            }
            assert.doesNotMatch(result.text, /private|SQL|constraint|stack/);
        });
    });
}

const contratoSqlViolado = error => error instanceof assert.AssertionError
    && error.message.includes('SQL fake contract violation captured outside middleware')
    && error.actual === 1 && error.expected === 0 && error.operator === 'strictEqual';

for (const [name, transformQuery] of [
    ['SQL inesperado', (_sql, params) => ({ sql: 'SELECT unexpected', params })],
    ['parametros incorretos', (sql, _params) => ({ sql, params: ['wrong-event'] })],
    ['sequencia incorreta', (_sql, params) => ({ sql: 'SELECT e.id, e.slug, e.nome FROM ist_usuarios u', params })]
]) {
    test(`prova negativa: ${name} nao e aceito como query-failure apesar do HTTP 500`, { concurrency: false }, async t => {
        t.mock.method(console, 'error', () => {});
        const queryBefore = pool.query;
        const connectionBefore = pool.getConnection;
        let callbackCompleted = false;
        await assert.rejects(withRealAuthorization('query-failure', async () => {
            const { state, request } = await harness(t, { realAuthorization: true });
            const result = await request();
            assert.equal(result.status, 500);
            assert.equal(state.calls.length, 0);
            callbackCompleted = true;
        }, transformQuery), contratoSqlViolado);
        assert.equal(callbackCompleted, true);
        assert.equal(pool.query, queryBefore);
        assert.equal(pool.getConnection, connectionBefore);
    });
}
test('prova negativa: consulta esperada ausente e detectada externamente', { concurrency: false }, async () => {
    await assert.rejects(withRealAuthorization('query-failure', async () => {}),
        error => error instanceof assert.AssertionError && error.message.includes('Unexpected final query count'));
});

for (const [name, fail] of [
    ['HTTP diferente de 500', () => assert.equal(403, 500, 'HTTP status incorrect')],
    ['writer chamado indevidamente', () => assert.equal(1, 0, 'Writer unexpectedly called')],
    ['requisicao falha antes das assertions', () => { throw new Error('Request failed before assertions'); }]
]) {
    test(`regressao do verificador: preserva erro primario de ${name}`, { concurrency: false }, async () => {
        let primaryError;
        try { fail(); } catch (error) { primaryError = error; }
        const queryBefore = pool.query;
        const connectionBefore = pool.getConnection;
        await assert.rejects(withRealAuthorization('query-failure', async () => {
            // Reproduz a captura pelo middleware, seguida de falha do callback.
            await assert.rejects(pool.query('SELECT unexpected', ['evento-teste']), assert.AssertionError);
            throw primaryError;
        }), error => error === primaryError && !contratoSqlViolado(error));
        assert.equal(pool.query, queryBefore);
        assert.equal(pool.getConnection, connectionBefore);
    });
}
test('regressao do verificador: ausencia de violacao nao satisfaz prova negativa', { concurrency: false }, async () => {
    let callbackCompleted = false;
    await assert.rejects(
        assert.rejects(withRealAuthorization('query-failure', async () => {
            await assert.rejects(pool.query('SELECT id, slug, nome FROM ist_eventos WHERE slug = ?', ['evento-teste']),
                error => error.message === 'private SQL constraint stack');
            callbackCompleted = true;
        }), contratoSqlViolado),
        error => error instanceof assert.AssertionError && error.code === 'ERR_ASSERTION'
            && error.message.includes('Missing expected rejection')
    );
    assert.equal(callbackCompleted, true);
});

for (const body of ['{"secret":"private",', '"private"', '123', 'null']) {
    test(`parser JSON rejeita ${body} com 400 sanitizado`, async t => {
        const { state, request } = await harness(t);
        const result = await request({ body });
        assert.equal(result.status, 400);
        assert.deepEqual(result.body, { message: 'JSON inv\u00e1lido.' });
        assert.equal(state.calls.length, 0);
        assert.deepEqual(state.trace, []);
        assert.equal(state.errors[0].type, 'entity.parse.failed');
        assert.doesNotMatch(result.text, /private|stack|SyntaxError/);
    });
}
for (const [name, options, expected] of [
    ['text/plain nao convertido', { body: JSON.stringify(payload()), contentType: 'text/plain' }, undefined],
    ['body ausente sem Content-Type', { body: null, contentType: null }, undefined],
    ['body JSON vazio', { body: null }, {}],
    ['legado intacto', { body: JSON.stringify({ versao: 0, estado: 'rascunho', notas: [{ idCriterio: 101, nota: 80 }],
        possivelDesclassificacao: false, motivoDesclassificacao: 'nao normalizar' }) },
    { versao: 0, estado: 'rascunho', notas: [{ idCriterio: 101, nota: 80 }],
        possivelDesclassificacao: false, motivoDesclassificacao: 'nao normalizar' }],
    ['extras intactos', { body: JSON.stringify({ ...payload(), extra: 'preservar' }) }, { ...payload(), extra: 'preservar' }],
    ['semanticamente invalido', { body: JSON.stringify({ ...payload(), versao: -1 }) }, { ...payload(), versao: -1 }]
]) {
    test(`body ${name}: rejeicao scriptada do writer, nao validacao real de dominio`, async t => {
        const { state, request } = await harness(t, { writer: async () => {
            throw new JuradoAvaliacaoGravacaoError(GRAVACAO_ERROS.PAYLOAD_INVALIDO);
        } });
        const response = await request(options);
        assert.equal(response.status, 400);
        assert.equal(state.calls.length, 1);
        assert.deepEqual(state.calls[0][3], expected);
        assert.equal(state.calls[0][3], state.bodies[0]);
    });
}

const conflicts = [
    GRAVACAO_ERROS.CICLO_DESATUALIZADO, GRAVACAO_ERROS.TENTATIVA_DESATUALIZADA,
    GRAVACAO_ERROS.VERSAO_DESATUALIZADA, GRAVACAO_ERROS.AVALIACAO_CONCLUIDA,
    GRAVACAO_ERROS.CONFLITO_CONCORRENCIA, GRAVACAO_ERROS.CONTEXTO_NAO_GRAVAVEL
];
for (const code of conflicts) {
    test(`HTTP 409 ${code} sem retry ou GET`, async t => {
        const { state, request } = await harness(t, { writer: async () => {
            throw new JuradoAvaliacaoGravacaoError(code, { private: 'SQL constraint' });
        } });
        const result = await request();
        assert.equal(result.status, 409);
        assert.equal(result.body.code, code);
        assert.equal(state.calls.length, 1);
        assert.doesNotMatch(result.text, /private|SQL|constraint/);
    });
}
for (const [error, status] of [
    [new JulgamentoContextError(JULGAMENTO_ERROS.CONCORRENTE_NAO_INCLUIDO), 409],
    [new JulgamentoContextError(JULGAMENTO_ERROS.CONCORRENTE_AUSENTE), 404],
    [new JuradoAvaliacaoGravacaoError(GRAVACAO_ERROS.ACESSO_OPERACIONAL_NEGADO), 403],
    [new JuradoAvaliacaoGravacaoError(GRAVACAO_ERROS.CONTEXTO_NAO_GRAVAVEL,
        { motivo: JULGAMENTO_ERROS.JURADO_NAO_INCLUIDO }), 403],
    [new JulgamentoContextError(JULGAMENTO_ERROS.CONTEXTO_INCONSISTENTE), 500],
    [Object.assign(new Error('private commit failure'), { code: 'ER_LOCK_DEADLOCK', errno: 1213, sqlMessage: 'private SQL' }), 500],
    [Object.assign(new Error('private commit timeout'), { code: 'ER_LOCK_WAIT_TIMEOUT', errno: 1205 }), 500],
    [{ code: GRAVACAO_ERROS.PAYLOAD_INVALIDO, status: 400, stack: 'private' }, 500],
    [new Error('private infrastructure'), 500]
]) {
    test(`erro HTTP ${error.code || 'Error'} -> ${status} sanitizado sem replay`, async t => {
        t.mock.method(console, 'error', () => {});
        const { state, request } = await harness(t, { writer: async () => { throw error; } });
        const result = await request();
        assert.equal(result.status, status);
        if (status === 500) assert.deepEqual(result.body, neutral);
        assert.equal(state.calls.length, 1);
        assert.doesNotMatch(result.text, /private|sqlMessage|stack|constraint|details|ER_LOCK/);
    });
}
test('idParticipacao nao canonico recusado pelo adapter antes do writer', async t => {
    const { state, request } = await harness(t);
    assert.equal((await request({ route: path.replace('/40/', '/01/') })).status, 400);
    assert.equal(state.calls.length, 0);
});

for (const responseFailure of ['status-once', 'json-once', 'status-persistent']) {
    test(`falha por resposta ${responseFailure}, gravacao unica e fallback neutro`, async t => {
        t.mock.method(console, 'error', () => {});
        const { state, request } = await harness(t, { responseFailure, simulatedAuthentication: true });
        const result = await request();
        assert.equal(result.status, 500);
        assert.deepEqual(result.body, neutral);
        assert.equal(state.calls.length, 1);
        assert.deepEqual(state.attemptedStatuses, [200, 500]);
        assert.equal(state.errors.length, responseFailure === 'status-persistent' ? 1 : 0);
        assert.equal(state.jsonAttempts, responseFailure === 'json-once' ? 2 : 1);
        if (state.errors.length) assert.equal(state.errors[0].headersSent, false);
    });
}
test('headers parciais: segunda resposta falha, Express encerra conexao, nenhuma segunda gravacao', async t => {
    t.mock.method(console, 'error', () => {});
    const { state, base } = await harness(t, { responseFailure: 'partial', simulatedAuthentication: true });
    const result = await new Promise((resolve, reject) => {
        let status;
        let text = '';
        const req = http.request(base + path, { method: 'PUT', headers: { 'Content-Type': 'application/json' } }, res => {
            status = res.statusCode;
            res.setEncoding('utf8');
            res.on('data', chunk => { text += chunk; });
            res.on('aborted', () => resolve({ interrupted: true, status, text }));
            res.on('error', error => error.code === 'ECONNRESET'
                ? resolve({ interrupted: true, status, text }) : reject(error));
            res.on('end', () => resolve({ interrupted: false, status, text }));
        });
        t.after(() => req.destroy());
        req.setTimeout(5000, () => req.destroy(new Error('HTTP timeout')));
        req.on('error', error => error.code === 'ECONNRESET'
            ? resolve({ interrupted: true, status, text }) : reject(error));
        req.end(JSON.stringify(payload()));
    });
    assert.equal(result.interrupted, true);
    assert.equal(state.calls.length, 1);
    assert.deepEqual(state.attemptedStatuses, [200, 500]);
    assert.equal(state.jsonAttempts, 2);
    assert.equal(state.errors.length, 1);
    assert.equal(state.errors[0].headersSent, true);
    assert.doesNotMatch(result.text, /synthetic|stack|Response interrupted/);
});

test('harness nao importa servidor ou rotas produtivas; cutover continua ausente', () => {
    const source = readFileSync(new URL(import.meta.url), 'utf8');
    assert.doesNotMatch(source, /from ['"][^'"]*(?:server\.js|jurado\.routes\.js)['"]/);
    for (const file of ['../src/routes/jurado.routes.js', '../src/controllers/juradoController.js', '../server.js']) {
        const contents = readFileSync(new URL(file, import.meta.url), 'utf8');
        assert.doesNotMatch(contents, /juradoAvaliacaoCycleAwareController|salvarAvaliacaoJuradoCycleAware|obterAvaliacaoJuradoCycleAware/);
    }
});
