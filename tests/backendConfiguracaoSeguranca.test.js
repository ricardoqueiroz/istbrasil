import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { pool } from '../src/config/db.js';

const originalEnv = { ...process.env };
const originalListen = express.application.listen;
const originalQuery = pool.query;
const originalCompare = bcrypt.compare;
const originalLog = console.log;
let sequencia = 0;
function ambiente(valores) {
    for (const nome of ['NODE_ENV', 'JWT_SECRET', 'COOKIE_SECURE', 'HOST', 'PORT', 'COOKIE_NAME', 'COOKIE_HTTPONLY', 'COOKIE_SAMESITE', 'COOKIE_MAXLIFETIME', 'COOKIE_HTTP_HOST']) delete process.env[nome];
    Object.assign(process.env, valores);
}
test.after(() => {
    for (const nome of ['NODE_ENV', 'JWT_SECRET', 'COOKIE_SECURE', 'HOST', 'PORT', 'COOKIE_NAME', 'COOKIE_HTTPONLY', 'COOKIE_SAMESITE', 'COOKIE_MAXLIFETIME', 'COOKIE_HTTP_HOST']) {
        if (originalEnv[nome] === undefined) delete process.env[nome]; else process.env[nome] = originalEnv[nome];
    }
    express.application.listen = originalListen; pool.query = originalQuery; bcrypt.compare = originalCompare; console.log = originalLog;
});

for (const segredo of [undefined, '', '   ', 'dev-only-insecure-secret', ' dev-only-insecure-secret ']) {
    test('configuração de produção rejeita segredo ausente ou inseguro', async () => {
        ambiente({ NODE_ENV: 'production', ...(segredo === undefined ? {} : { JWT_SECRET: segredo }) });
        await assert.rejects(import(`../src/config/jwt.js?teste=${sequencia++}`), /JWT_SECRET deve ser configurado/);
    });
}

test('desenvolvimento preserva segredo de fallback e produção preserva segredo configurado', async () => {
    ambiente({ NODE_ENV: 'development' });
    assert.equal((await import(`../src/config/jwt.js?teste=${sequencia++}`)).JWT_SECRET, 'dev-only-insecure-secret');
    ambiente({ NODE_ENV: 'production', JWT_SECRET: 'segredo-sintetico' });
    assert.equal((await import(`../src/config/jwt.js?teste=${sequencia++}`)).JWT_SECRET, 'segredo-sintetico');
});

test('servidor usa host padrão e host e porta configurados', async () => {
    const escutas = [];
    express.application.listen = function(porta, host, callback) { escutas.push({ porta, host }); callback(); return { close() {} }; };
    console.log = () => {};
    ambiente({ NODE_ENV: 'development', JWT_SECRET: 'segredo-sintetico' });
    await import(`../server.js?teste=${sequencia++}`);
    ambiente({ NODE_ENV: 'production', JWT_SECRET: 'segredo-sintetico', HOST: '127.0.0.2', PORT: '3011' });
    await import(`../server.js?teste=${sequencia++}`);
    assert.deepEqual(escutas, [{ porta: 3000, host: '127.0.0.1' }, { porta: '3011', host: '127.0.0.2' }]);
});

for (const [nome, variaveis, secure] of [
    ['produção por padrão', { NODE_ENV: 'production' }, true],
    ['desenvolvimento por padrão', { NODE_ENV: 'development' }, false],
    ['desenvolvimento com true', { NODE_ENV: 'development', COOKIE_SECURE: 'true' }, true],
    ['desenvolvimento com false', { NODE_ENV: 'development', COOKIE_SECURE: 'false' }, false],
    ['produção com false explícito', { NODE_ENV: 'production', COOKIE_SECURE: 'false' }, false]
]) {
    test(`login e middleware compartilham JWT e cookie: ${nome}`, async () => {
        ambiente({ ...variaveis, JWT_SECRET: 'segredo-sintetico' });
        const { default: controller } = await import('../src/controllers/usuariosController.js');
        const { autenticarUsuario } = await import('../src/middlewares/authMiddleware.js');
        pool.query = async () => [[{ id_usuario: 7, id_tipo_usuario: 3, nome: 'Pessoa', senha: 'hash', foto: null }]];
        bcrypt.compare = async () => true;
        let cookie;
        const res = { cookie(nomeCookie, valor, opcoes) { cookie = { nomeCookie, valor, opcoes }; },
            status(codigo) { this.codigo = codigo; return this; }, json() { return this; } };
        await controller.login({ body: { email: 'pessoa@example.org', senha: 'senha' } }, res);
        assert.equal(res.codigo, 200);
        assert.equal(cookie.opcoes.secure, secure); assert.equal(cookie.opcoes.httpOnly, true);
        assert.equal(cookie.opcoes.sameSite, 'lax'); assert.equal(cookie.opcoes.maxAge, 86400000);
        assert.equal(jwt.verify(cookie.valor, 'segredo-sintetico').id_usuario, 7);
        for (const token of [cookie.valor, jwt.sign({ id_usuario: 7, id_tipo_usuario: 3 }, 'segredo-sintetico')]) {
            const req = { cookies: { [cookie.nomeCookie]: token } }; let aceito = false;
            autenticarUsuario(req, res, () => { aceito = true; });
            assert.equal(aceito, true); assert.equal(req.usuario.id_usuario, 7);
        }
    });
}
