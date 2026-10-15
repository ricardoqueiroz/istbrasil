import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { criarAmbiente } from './lojaSessao.fixture.js';
import { criarLojaSessaoService, hashTokenSessao, criarTokenCsrf, csrfValido, tokenSessaoValido } from '../src/services/lojaSessaoService.js';
import { criarConfiguracaoLojaSessao, carregarConfiguracaoLojaSessao } from '../src/config/lojaSessao.js';

test('gera 32 bytes e persiste exclusivamente SHA-256 binário e UTC DATETIME(3)', async () => {
    const a = criarAmbiente();
    const r = await a.service.estabelecerSessao();
    assert.equal(Buffer.from(r.token, 'base64url').length, 32);
    assert.equal(tokenSessaoValido(r.token), true);
    assert.deepEqual(a.chamadas[0].params, [createHash('sha256').update(r.token).digest(), '2026-10-15 12:34:56.123', '2026-10-16 12:34:56.123']);
    assert.equal(a.chamadas[0].params[0].length, 32);
    assert.deepEqual(await a.service.obterSessao(r.token), r.sessao);
});
test('criações concorrentes geram tokens e hashes únicos', async () => {
    const a = criarAmbiente();
    const resultados = await Promise.all(Array.from({ length: 30 }, () => a.service.estabelecerSessao()));
    assert.equal(new Set(resultados.map(r => r.token)).size, 30);
    assert.equal(a.registros.size, 30);
});
test('reutiliza sem renovar ou gravar inclusive em concorrência', async () => {
    const a = criarAmbiente(); const inicial = await a.service.estabelecerSessao(); a.avancar(60_000);
    const resultados = await Promise.all([a.service.estabelecerSessao(inicial.token), a.service.estabelecerSessao(inicial.token)]);
    for (const r of resultados) assert.deepEqual(r, { ...inicial, nova: false });
    assert.equal(a.chamadas.filter(c => !c.sql.startsWith('SELECT')).length, 1);
});
test('expiração absoluta no limite de 24 horas rejeita e substitui sessão', async () => {
    const a = criarAmbiente(); const r = await a.service.estabelecerSessao(); a.avancar(86_400_000);
    await assert.rejects(a.service.obterSessao(r.token), { codigo: 'SESSAO_INVALIDA' });
    const nova = await a.service.estabelecerSessao(r.token);
    assert.equal(nova.nova, true); assert.notEqual(nova.token, r.token);
});
test('revogação é idempotente, impede uso e permite nova sessão', async () => {
    const a = criarAmbiente(); const r = await a.service.estabelecerSessao();
    assert.equal(await a.service.revogarSessao(r.token), true);
    assert.equal(await a.service.revogarSessao(r.token), false);
    await assert.rejects(a.service.obterSessao(r.token), { codigo: 'SESSAO_INVALIDA' });
    assert.equal((await a.service.estabelecerSessao(r.token)).nova, true);
});
for (const token of [undefined, '', 'inválido', 'A'.repeat(42), 'A'.repeat(44), 'A'.repeat(42) + 'B']) {
    test(`token não canônico ${JSON.stringify(token)} não consulta banco`, async () => {
        const a = criarAmbiente(); await assert.rejects(a.service.obterSessao(token), { codigo: 'SESSAO_INVALIDA' });
        assert.equal(a.chamadas.length, 0);
        assert.equal((await a.service.estabelecerSessao(token)).nova, true);
    });
}
test('token desconhecido não autentica', async () => {
    const a = criarAmbiente(); await assert.rejects(a.service.obterSessao(randomBytes(32).toString('base64url')), { codigo: 'SESSAO_INVALIDA' });
});
test('falhas do banco não expõem detalhes nem criam substituição indevida', async () => {
    const a = criarAmbiente(); const r = await a.service.estabelecerSessao(); a.falhar();
    for (const executar of [() => a.service.obterSessao(r.token), () => a.service.estabelecerSessao(r.token), () => a.service.estabelecerSessao(), () => a.service.revogarSessao(r.token)]) {
        await assert.rejects(executar, e => e.codigo === 'ERRO_INTERNO' && !e.message.includes('privados'));
    }
    assert.equal(a.registros.size, 1);
});
test('colisão UNIQUE limita tentativas a três', async () => {
    const a = criarAmbiente(); let chamadas = 0;
    const service = criarLojaSessaoService({ db: a.db, agora: a.agora, aleatorio: n => { chamadas++; assert.equal(n, 32); return Buffer.alloc(32, 7); } });
    await service.estabelecerSessao();
    await assert.rejects(service.estabelecerSessao(), { codigo: 'ERRO_INTERNO' });
    assert.equal(chamadas, 4); assert.equal(a.registros.size, 1);
});
test('colisão transitória gera outro token', async () => {
    const a = criarAmbiente(); const bytes = Buffer.alloc(32, 7);
    await criarLojaSessaoService({ db: a.db, agora: a.agora, aleatorio: () => bytes }).estabelecerSessao();
    let n = 0;
    const r = await criarLojaSessaoService({ db: a.db, agora: a.agora, aleatorio: () => ++n === 1 ? bytes : Buffer.alloc(32, 8) }).estabelecerSessao();
    assert.equal(r.nova, true); assert.equal(n, 2);
});
test('fonte aleatória inválida falha sem gravação', async () => {
    const a = criarAmbiente();
    await assert.rejects(criarLojaSessaoService({ db: a.db, aleatorio: () => Buffer.alloc(31) }).estabelecerSessao(), { codigo: 'ERRO_INTERNO' });
    assert.equal(a.chamadas.length, 0);
});
for (const alterar of [l => { l.criada_em_utc = '2026-10-16T12:34:56.123000Z'; }, l => { l.expira_em_utc = '2026-10-17T12:34:56.123000Z'; }]) {
    test('datas fora da validade contratual são rejeitadas', async () => {
        const a = criarAmbiente(); const r = await a.service.estabelecerSessao(); alterar([...a.registros.values()][0]);
        await assert.rejects(a.service.obterSessao(r.token), { codigo: 'SESSAO_INVALIDA' });
    });
}
test('data SQL corrompida não é interpretada no fuso local', async () => {
    const a = criarAmbiente(); const r = await a.service.estabelecerSessao(); [...a.registros.values()][0].expira_em_utc = '2026-02-30T12:34:56.123000Z';
    await assert.rejects(a.service.obterSessao(r.token), { codigo: 'ERRO_INTERNO' });
});
test('CSRF tem domínio próprio, segredo e vínculo com sessão', () => {
    const token = randomBytes(32).toString('base64url'); const outro = randomBytes(32).toString('base64url'); const segredo = randomBytes(32);
    const csrf = criarTokenCsrf(token, segredo);
    assert.equal(csrfValido(csrf, token, segredo), true);
    assert.equal(csrfValido(csrf, outro, segredo), false);
    assert.equal(csrfValido(csrf, token, randomBytes(32)), false);
    assert.notEqual(csrf, token); assert.notEqual(csrf, hashTokenSessao(token).toString('base64url'));
    for (const valor of [undefined, '', 'x', token + '=', '<script>']) assert.equal(csrfValido(valor, token, segredo), false);
});
test('configuração local confiável tem cookie distinto', () => {
    const c = carregarConfiguracaoLojaSessao({ LOJA_CSRF_SECRET: Buffer.alloc(32, 3).toString('base64url') });
    assert.deepEqual(c.origens, ['http://localhost:4200']);
    assert.deepEqual(c.cookie, { nome: 'ist-loja-dev', httpOnly: true, secure: false, sameSite: 'lax', path: '/' });
});
test('produção exige origens HTTPS explícitas e cookie __Host-', () => {
    const c = carregarConfiguracaoLojaSessao({ NODE_ENV: 'production', LOJA_ORIGENS_PERMITIDAS: 'https://istbrasil.org.br,https://www.istbrasil.org.br', LOJA_CSRF_SECRET: Buffer.alloc(32, 3).toString('base64url') });
    assert.equal(c.cookie.nome, '__Host-ist-loja'); assert.equal(c.cookie.secure, true); assert.equal('domain' in c.cookie, false);
});
for (const origem of ['*', 'null', 'http://evil.example', 'https://localhost:4200/', 'http://user@localhost:4200', 'http://localhost:4200?x=1', '']) {
    test(`origem de configuração inválida: ${origem}`, () => {
        assert.throws(() => criarConfiguracaoLojaSessao({ origens: [origem], segredoCsrf: Buffer.alloc(32) }), { codigo: 'ERRO_INTERNO' });
    });
}
for (const env of [{}, { NODE_ENV: 'production' }, { NODE_ENV: 'staging' }, { LOJA_CSRF_SECRET: 'A'.repeat(42) + 'B' }, { NODE_ENV: 'production', LOJA_ORIGENS_PERMITIDAS: 'http://localhost', LOJA_CSRF_SECRET: 'A'.repeat(43) }]) {
    test('configuração incompleta ou insegura falha fechada', () => assert.throws(() => carregarConfiguracaoLojaSessao(env), { codigo: 'ERRO_INTERNO' }));
}
