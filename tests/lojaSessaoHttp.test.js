import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import cors from 'cors';
import { criarAmbiente } from './lojaSessao.fixture.js';
import { criarLojaRouter, tratarErroLoja } from '../src/routes/loja.routes.js';
import { criarProtecaoLoja } from '../src/middlewares/lojaSessaoMiddleware.js';
import { tratarErroSessaoLoja } from '../src/routes/lojaSessao.routes.js';
import { criarConfiguracaoLojaSessao, carregarConfiguracaoLojaSessao } from '../src/config/lojaSessao.js';

const iniciar = async (t, { producao = false, semConfig = false } = {}) => {
    const a = criarAmbiente();
    const origem = producao ? 'https://istbrasil.org.br' : 'http://localhost:4200';
    const config = criarConfiguracaoLojaSessao({ producao, origens: [origem], segredoCsrf: Buffer.alloc(32, 9) });
    const obterConfiguracao = () => semConfig ? carregarConfiguracaoLojaSessao({}) : config;
    const app = express(); app.use(cors());
    const protecao = criarProtecaoLoja({ service: a.service, obterConfiguracao });
    // Rota artificial somente neste teste; nenhuma operação comercial.
    app.post('/api/loja/_protegido', protecao.protegerEscritaLoja, (req, res) => res.json({ ok: true }));
    app.use('/api/loja/_protegido', tratarErroSessaoLoja);
    app.get('/api/livros-legado', (req, res) => res.json({ legado: true }));
    const service = { listarCategorias: async () => [], listarProdutos: async () => [], obterProduto: async () => ({ id: 1 }), cotar: async () => ({ total: '95.00' }) };
    app.use('/api/loja', criarLojaRouter({ service, sessaoService: a.service, obterConfiguracaoSessao: obterConfiguracao, agoraSessao: a.agora }));
    app.use('/api/loja', tratarErroLoja);
    const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    const url = `http://127.0.0.1:${server.address().port}`;
    const enviar = async ({ caminho = '/api/loja/sessao', headers = {}, body = '{}', method = 'POST' } = {}) => {
        const cabecalhos = { Origin: origem, 'X-IST-Loja': '1', 'Content-Type': 'application/json', ...headers };
        for (const key of Object.keys(cabecalhos)) if (cabecalhos[key] === undefined) delete cabecalhos[key];
        return fetch(url + caminho, { method, headers: cabecalhos, ...(method === 'GET' ? {} : { body }) });
    };
    const criar = async () => {
        const res = await enviar(); assert.equal(res.status, 201);
        return { cookie: res.headers.get('set-cookie').split(';')[0], csrf: res.headers.get('x-csrf-token'), res, body: await res.json() };
    };
    return { ...a, origem, url, enviar, criar };
};

for (const producao of [false, true]) {
    test(`cookie correto e resposta sem segredos (produção=${producao})`, async t => {
        const a = await iniciar(t, { producao }); const r = await a.criar(); const cookie = r.res.headers.get('set-cookie');
        assert.match(cookie, producao ? /^__Host-ist-loja=/ : /^ist-loja-dev=/);
        assert.match(cookie, /; HttpOnly/); assert.match(cookie, /; SameSite=Lax/); assert.match(cookie, /; Path=\//);
        assert.equal(/; Secure/.test(cookie), producao); assert.doesNotMatch(cookie, /Domain=/i);
        const segundos = Number(cookie.match(/Max-Age=(\d+)/)[1]); assert.ok(segundos > 0 && segundos <= 86400);
        assert.deepEqual(r.body, { sessao: { expiraEm: '2026-10-16T12:34:56.123Z' } });
        assert.equal(r.res.headers.get('cache-control'), 'no-store');
        assert.notEqual(r.csrf, r.cookie.split('=')[1]);
        assert.equal(JSON.stringify(r.body).includes(r.cookie.split('=')[1]), false);
    });
}
test('reutilização não renova cookie, registro ou CSRF', async t => {
    const a = await iniciar(t); const r = await a.criar(); a.avancar(3600_000);
    const res = await a.enviar({ headers: { Cookie: r.cookie } });
    assert.equal(res.status, 200); assert.equal(res.headers.get('set-cookie'), null);
    assert.equal(res.headers.get('x-csrf-token'), r.csrf); assert.deepEqual(await res.json(), r.body);
    assert.equal(a.chamadas.filter(c => c.sql.startsWith('INSERT')).length, 1);
});
for (const tipo of ['expirada', 'revogada', 'inválida', 'duplicada']) {
    test(`sessão ${tipo} é substituída no bootstrap`, async t => {
        const a = await iniciar(t); const r = await a.criar(); let cookie = r.cookie;
        if (tipo === 'expirada') a.avancar(86400_000);
        if (tipo === 'revogada') await a.service.revogarSessao(cookie.split('=')[1]);
        if (tipo === 'inválida') cookie = 'ist-loja-dev=incorreto';
        if (tipo === 'duplicada') cookie += '; ' + cookie;
        const res = await a.enviar({ headers: { Cookie: cookie } });
        assert.equal(res.status, 201); assert.notEqual(res.headers.get('set-cookie').split(';')[0], r.cookie);
    });
}
for (const origem of [undefined, 'null', 'http://evil.example', 'http://localhost:4200.evil.example', 'http://localhost:4201']) {
    test(`Origin ${origem} rejeitado antes do banco apesar do CORS global`, async t => {
        const a = await iniciar(t); const res = await a.enviar({ headers: { Origin: origem } });
        assert.equal(res.status, 403); assert.equal((await res.json()).erro.codigo, 'ORIGEM_INVALIDA'); assert.equal(a.chamadas.length, 0);
    });
}
for (const valor of [undefined, '0', 'true']) {
    test(`cabeçalho próprio ${valor} rejeitado`, async t => {
        const a = await iniciar(t); const res = await a.enviar({ headers: { 'X-IST-Loja': valor } });
        assert.equal(res.status, 403); assert.equal(a.chamadas.length, 0);
    });
}
for (const tipo of ['text/plain', 'application/x-www-form-urlencoded', 'application/ld+json']) {
    test(`Content-Type ${tipo} rejeitado`, async t => {
        const a = await iniciar(t); const res = await a.enviar({ headers: { 'Content-Type': tipo } });
        assert.equal(res.status, 400); assert.equal(a.chamadas.length, 0);
    });
}
for (const body of ['{', '[]', 'null', '{"token":"não aceitar"}', '"texto"']) {
    test(`corpo inválido ${body} não grava sessão`, async t => {
        const a = await iniciar(t); const res = await a.enviar({ body });
        assert.equal(res.status, 400); assert.equal(a.chamadas.length, 0); assert.equal(res.headers.get('cache-control'), 'no-store');
    });
}
test('limite do corpo próprio é 4 KiB', async t => {
    const a = await iniciar(t); const res = await a.enviar({ body: JSON.stringify({ x: 'x'.repeat(5000) }) });
    assert.equal(res.status, 413); assert.equal(a.chamadas.length, 0);
});
test('middleware aceita cookie e CSRF válidos e não expõe contexto', async t => {
    const a = await iniciar(t); const r = await a.criar();
    const res = await a.enviar({ caminho: '/api/loja/_protegido', headers: { Cookie: r.cookie, 'X-CSRF-Token': r.csrf } });
    assert.equal(res.status, 200); assert.deepEqual(await res.json(), { ok: true });
});
for (const caso of ['ausente', 'inválido', 'outra sessão', 'sem cookie', 'expirada', 'revogada', 'query']) {
    test(`middleware rejeita CSRF/sessão: ${caso}`, async t => {
        const a = await iniciar(t); const r = await a.criar();
        const headers = { Cookie: r.cookie, 'X-CSRF-Token': r.csrf }; let caminho = '/api/loja/_protegido';
        if (caso === 'ausente') delete headers['X-CSRF-Token'];
        if (caso === 'inválido') headers['X-CSRF-Token'] = 'x';
        if (caso === 'outra sessão') headers['X-CSRF-Token'] = (await a.criar()).csrf;
        if (caso === 'sem cookie') delete headers.Cookie;
        if (caso === 'expirada') a.avancar(86400_000);
        if (caso === 'revogada') await a.service.revogarSessao(r.cookie.split('=')[1]);
        if (caso === 'query') { caminho += '?csrf=' + r.csrf; delete headers['X-CSRF-Token']; }
        const res = await a.enviar({ caminho, headers });
        assert.equal(res.status, caso === 'query' ? 400 : ['sem cookie', 'expirada', 'revogada'].includes(caso) ? 401 : 403);
        assert.equal(res.headers.get('set-cookie'), null);
    });
}
test('cabeçalhos do cliente não reduzem segurança do cookie', async t => {
    const a = await iniciar(t, { producao: true });
    const res = await a.enviar({ headers: { Host: 'localhost', 'X-Forwarded-Proto': 'http' } });
    assert.equal(res.status, 201); assert.match(res.headers.get('set-cookie'), /^__Host-ist-loja=.*; Secure/);
});
test('concorrência HTTP mantém tokens únicos', async t => {
    const a = await iniciar(t); const resultados = await Promise.all(Array.from({ length: 12 }, () => a.criar()));
    assert.equal(new Set(resultados.map(r => r.cookie)).size, 12); assert.equal(a.registros.size, 12);
});
test('erro do banco é sanitizado e não retorna cookie', async t => {
    const a = await iniciar(t); a.falhar(); const res = await a.enviar();
    assert.equal(res.status, 500); assert.equal(res.headers.get('set-cookie'), null);
    const body = await res.json(); assert.equal(body.erro.codigo, 'ERRO_INTERNO'); assert.doesNotMatch(JSON.stringify(body), /senha|SQL|stack/);
});
test('configuração ausente bloqueia somente sessão; catálogo e legado preservados', async t => {
    const a = await iniciar(t, { semConfig: true }); assert.equal((await a.enviar()).status, 500);
    for (const caminho of ['/api/loja/categorias', '/api/loja/produtos', '/api/loja/produtos/1', '/api/livros-legado']) {
        assert.equal((await fetch(a.url + caminho)).status, 200);
    }
    assert.equal(a.chamadas.length, 0);
});
