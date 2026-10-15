import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { criarAmbiente } from './lojaSessao.fixture.js';
import { criarLojaRouter, tratarErroLoja } from '../src/routes/loja.routes.js';
import { criarConfiguracaoLojaSessao, carregarConfiguracaoLojaSessao } from '../src/config/lojaSessao.js';
import { carregarConfiguracaoLojaPedido } from '../src/config/lojaPedido.js';
import { criarErroPedido } from '../src/services/lojaPedidoContratos.js';

const CHAVE = 'aabbccdd-1122-4333-8abc-123456789abc';
const publico = { publicId: '12345678-1234-4234-8234-123456789abc', estado: 'CRIADO', versao: 1,
    moeda: 'BRL', totalCentavos: 19000, criadoEm: '2026-10-15T12:34:56.123Z', expiraEm: '2026-10-15T13:04:56.123Z',
    itens: [1, 2].map(produtoId => ({ produtoId, sku: `SKU${produtoId}`, titulo: `Livro ${produtoId}`, tipo: 'E-Book',
        quantidade: 1, precoUnitarioCentavos: 9500, subtotalCentavos: 9500 })) };
const iniciar = async (t, { criado = true, erro, semConfigSessao = false, configPedido = { ambiente: 'sandbox' },
    resultado = { pedido: publico, criado }, producao = false } = {}) => {
    const a = criarAmbiente(); const chamadas = []; const origem = producao ? 'https://istbrasil.org.br' : 'http://localhost:4200';
    const config = criarConfiguracaoLojaSessao({ producao, origens: [origem], segredoCsrf: Buffer.alloc(32, 11) });
    const app = express(); app.use(cors()); app.use(cookieParser());
    const pedidoService = { criarPedido: () => { throw Error('Interface sem metadado nao deve ser usada pelo HTTP'); },
        async criarPedidoComResultado(...args) { chamadas.push(args); if (erro) throw erro; return resultado; } };
    const catalogo = { listarCategorias: async () => [], listarProdutos: async () => [], obterProduto: async id => ({ id }), cotar: async () => ({ totalCentavos: 19000 }) };
    app.use('/api/loja', criarLojaRouter({ service: catalogo, sessaoService: a.service, pedidoService, agoraSessao: a.agora,
        obterConfiguracaoSessao: () => semConfigSessao ? carregarConfiguracaoLojaSessao({}) : config,
        obterConfiguracaoPedido: () => configPedido }));
    app.use('/api/loja', tratarErroLoja);
    app.use(express.json()); // Mesma ordem do server.js; parser da Loja vem antes.
    app.get('/legado', (req, res) => res.json({ preservado: true }));
    const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    const url = `http://127.0.0.1:${server.address().port}`;
    const enviar = async ({ caminho = '/api/loja/pedidos', headers = {}, body = JSON.stringify({ produtoIds: [1, 2], compradorEmail: 'Pessoa@example.com' }) } = {}) => {
        const cabecalhos = { Origin: origem, 'X-IST-Loja': '1', 'Content-Type': 'application/json', 'Idempotency-Key': CHAVE, ...headers };
        for (const chave of Object.keys(cabecalhos)) if (cabecalhos[chave] === undefined) delete cabecalhos[chave];
        return fetch(url + caminho, { method: 'POST', headers: cabecalhos, body });
    };
    const sessao = async () => {
        const res = await enviar({ caminho: '/api/loja/sessao', body: '{}' }); assert.equal(res.status, 201);
        return { Cookie: res.headers.get('set-cookie').split(';')[0], 'X-CSRF-Token': res.headers.get('x-csrf-token') };
    };
    return { ...a, chamadasPedidos: chamadas, url, enviar, sessao };
};
const conferirErro = async (res, status, codigo) => {
    assert.equal(res.status, status); assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('set-cookie'), null);
    const body = await res.json(); assert.deepEqual(Object.keys(body), ['erro']);
    assert.deepEqual(Object.keys(body.erro), ['codigo', 'mensagem']); assert.equal(body.erro.codigo, codigo);
    assert.doesNotMatch(JSON.stringify(body), /SELECT|INSERT|password|senha|stack|token_hash|privado\.pdf/);
};

for (const criado of [true, false]) test(`resultado explícito criado=${criado} retorna ${criado ? 201 : 200}, mesmo com estado CRIADO`, async t => {
    const a = await iniciar(t, { criado }); const headers = await a.sessao();
    const res = await a.enviar({ headers, body: JSON.stringify({ produtoIds: [2, 1], compradorEmail: ' Pessoa@EXAMPLE.COM ' }) });
    assert.equal(res.status, criado ? 201 : 200); assert.deepEqual(await res.json(), publico);
    assert.equal(res.headers.get('cache-control'), 'no-store'); assert.equal(res.headers.get('set-cookie'), null);
    assert.equal(a.chamadasPedidos.length, 1);
    assert.deepEqual(a.chamadasPedidos[0], [{ id: 1, criadaEm: '2026-10-15T12:34:56.123Z', expiraEm: '2026-10-16T12:34:56.123Z' },
        { produtoIds: [1, 2], compradorEmail: 'Pessoa@example.com' }, CHAVE]);
});
for (const [codigo, status] of [['CONFLITO_IDEMPOTENCIA', 409], ['PRODUTO_INDISPONIVEL', 422], ['SESSAO_INVALIDA', 401], ['CONTENCAO_TEMPORARIA', 503], ['ERRO_INTERNO', 500]]) {
    test(`erro de domínio ${codigo} mapeado para ${status}`, async t => {
        const a = await iniciar(t, { erro: criarErroPedido(codigo) });
        await conferirErro(await a.enviar({ headers: await a.sessao() }), status, codigo); assert.equal(a.chamadasPedidos.length, 1);
    });
}
test('erro inesperado não expõe SQL ou mensagens privadas', async t => {
    const erro = Object.assign(new Error('senha SELECT token_hash /privado.pdf'), { sql: 'SELECT', stack: 'stack privada', status: 200 });
    const a = await iniciar(t, { erro }); await conferirErro(await a.enviar({ headers: await a.sessao() }), 500, 'ERRO_INTERNO');
});
for (const caso of ['ausente', 'inválido', 'expirada', 'revogada', 'duplicado', 'CSRF como cookie']) test(`sessão ${caso}: 401, sem invocar pedidos`, async t => {
    const a = await iniciar(t); const headers = await a.sessao();
    if (caso === 'ausente') delete headers.Cookie;
    if (caso === 'inválido') headers.Cookie = 'ist-loja-dev=invalido';
    if (caso === 'expirada') a.avancar(86400_000);
    if (caso === 'revogada') await a.service.revogarSessao(headers.Cookie.split('=')[1]);
    if (caso === 'duplicado') headers.Cookie += '; ' + headers.Cookie;
    if (caso === 'CSRF como cookie') headers.Cookie = 'ist-loja-dev=' + headers['X-CSRF-Token'];
    await conferirErro(await a.enviar({ headers }), 401, 'SESSAO_INVALIDA'); assert.equal(a.chamadasPedidos.length, 0);
});
for (const Origin of [undefined, 'null', 'http://evil.example', 'http://localhost:4200.evil.example']) test(`Origin ${Origin}: 403 antes da sessão e de pedidos`, async t => {
    const a = await iniciar(t); const headers = await a.sessao(); const consultas = a.chamadas.length;
    await conferirErro(await a.enviar({ headers: { ...headers, Origin } }), 403, 'ORIGEM_INVALIDA');
    assert.equal(a.chamadasPedidos.length, 0); assert.equal(a.chamadas.length, consultas);
});
for (const caso of ['ausente', 'inválido', 'outra sessão']) test(`CSRF ${caso}: 403 sem invocar pedidos`, async t => {
    const a = await iniciar(t); const headers = await a.sessao();
    if (caso === 'ausente') delete headers['X-CSRF-Token'];
    if (caso === 'inválido') headers['X-CSRF-Token'] = 'invalido';
    if (caso === 'outra sessão') headers['X-CSRF-Token'] = (await a.sessao())['X-CSRF-Token'];
    await conferirErro(await a.enviar({ headers }), 403, 'CSRF_INVALIDO'); assert.equal(a.chamadasPedidos.length, 0);
});
test('cabeçalho próprio ausente: 403 antes de pedidos', async t => {
    const a = await iniciar(t); await conferirErro(await a.enviar({ headers: { ...(await a.sessao()), 'X-IST-Loja': undefined } }), 403, 'CSRF_INVALIDO');
    assert.equal(a.chamadasPedidos.length, 0);
});
for (const tipo of ['text/plain', 'application/x-www-form-urlencoded', 'application/ld+json']) test(`Content-Type ${tipo}: 400`, async t => {
    const a = await iniciar(t); await conferirErro(await a.enviar({ headers: { ...(await a.sessao()), 'Content-Type': tipo } }), 400, 'SOLICITACAO_INVALIDA');
    assert.equal(a.chamadasPedidos.length, 0);
});
for (const chave of [undefined, 'invalido', CHAVE.replace('-4333-', '-1333-'), CHAVE + ',' + CHAVE]) test(`Idempotency-Key inválido: ${chave?.slice(0, 12)}`, async t => {
    const a = await iniciar(t); await conferirErro(await a.enviar({ headers: { ...(await a.sessao()), 'Idempotency-Key': chave } }), 400, 'IDEMPOTENCIA_INVALIDA');
    assert.equal(a.chamadasPedidos.length, 0);
});
test('valida UUID antes de analisar corpo e normaliza caixa', async t => {
    const a = await iniciar(t); const headers = await a.sessao();
    await conferirErro(await a.enviar({ headers: { ...headers, 'Idempotency-Key': 'invalido' }, body: '{' }), 400, 'IDEMPOTENCIA_INVALIDA');
    assert.equal((await a.enviar({ headers: { ...headers, 'Idempotency-Key': CHAVE.toUpperCase() } })).status, 201);
    assert.equal(a.chamadasPedidos[0][2], CHAVE);
});
for (const campo of ['preco', 'precoCentavos', 'moeda', 'ambiente', 'quantidade', 'total', 'totalCentavos', 'sessaoId', 'token', 'csrf']) test(`campo extra ${campo} rejeitado`, async t => {
    const a = await iniciar(t); await conferirErro(await a.enviar({ headers: await a.sessao(), body: JSON.stringify({ produtoIds: [1], compradorEmail: 'a@example.com', [campo]: 1 }) }), 400, 'SOLICITACAO_INVALIDA');
    assert.equal(a.chamadasPedidos.length, 0);
});
for (const [dados, codigo] of [[{ produtoIds: [1], compradorEmail: 'invalido' }, 'EMAIL_INVALIDO'],
    [{ produtoIds: [], compradorEmail: 'a@example.com' }, 'SELECAO_INVALIDA'], [{ produtoIds: [1, 1], compradorEmail: 'a@example.com' }, 'SELECAO_INVALIDA']]) {
    test(`payload retorna 422: ${codigo}`, async t => {
        const a = await iniciar(t); await conferirErro(await a.enviar({ headers: await a.sessao(), body: JSON.stringify(dados) }), 422, codigo); assert.equal(a.chamadasPedidos.length, 0);
    });
}
for (const body of ['{', '[]', 'null', '"texto"']) test(`JSON/corpo inválido ${body}: 400`, async t => {
    const a = await iniciar(t); const res = await a.enviar({ headers: await a.sessao(), body });
    assert.equal(res.status, 400); assert.equal(res.headers.get('cache-control'), 'no-store'); assert.equal(a.chamadasPedidos.length, 0);
});
test('corpo acima de 8 KiB retorna 413 e não invoca pedidos', async t => {
    const a = await iniciar(t); await conferirErro(await a.enviar({ headers: await a.sessao(), body: JSON.stringify({ x: 'x'.repeat(9000) }) }), 413, 'CORPO_MUITO_GRANDE'); assert.equal(a.chamadasPedidos.length, 0);
});
for (const query of ['token=naoaceitar', 'csrf=naoaceitar', 'sessaoId=1']) test(`query ${query} rejeitada`, async t => {
    const a = await iniciar(t); await conferirErro(await a.enviar({ caminho: '/api/loja/pedidos?' + query, headers: await a.sessao() }), 400, 'SOLICITACAO_INVALIDA'); assert.equal(a.chamadasPedidos.length, 0);
});
test('limite específico de 20/minuto, no-store e catálogo preservado', async t => {
    const a = await iniciar(t);
    for (let n = 0; n < 20; n++) assert.equal((await a.enviar({ headers: { Origin: 'http://evil.example' } })).status, 403);
    const res = await a.enviar(); await conferirErro(res, 429, 'LIMITE_REQUISICOES');
    assert.equal(a.chamadasPedidos.length, 0); assert.equal(a.chamadas.length, 0);
    assert.equal((await fetch(a.url + '/api/loja/categorias')).status, 200);
});
test('configuração de sessão ausente bloqueia pedidos com erro seguro', async t => {
    const a = await iniciar(t, { semConfigSessao: true }); await conferirErro(await a.enviar(), 500, 'ERRO_INTERNO'); assert.equal(a.chamadasPedidos.length, 0); assert.equal(a.chamadas.length, 0);
});
test('ambiente inválido no servidor impede chamada do serviço', async t => {
    const a = await iniciar(t, { configPedido: { ambiente: 'invalido' } }); await conferirErro(await a.enviar({ headers: await a.sessao() }), 500, 'ERRO_INTERNO'); assert.equal(a.chamadasPedidos.length, 0);
});
test('resposta não inclui metadado interno criado nem dados privados', async t => {
    const a = await iniciar(t); const res = await a.enviar({ headers: await a.sessao() }); const r = await res.json();
    assert.deepEqual(r, publico); assert.equal(Object.hasOwn(r, 'criado'), false);
    assert.doesNotMatch(JSON.stringify(r), /sessao|hash|token|example.com|privado\.pdf|pagamento/i);
});
test('resultado sem metadado explícito falha seguro em vez de inferir pelo estado', async t => {
    const a = await iniciar(t, { resultado: { pedido: publico } }); await conferirErro(await a.enviar({ headers: await a.sessao() }), 500, 'ERRO_INTERNO');
});
test('endpoints anteriores e autenticação legada não ganham proteção de pedidos', async t => {
    const a = await iniciar(t); const headers = await a.sessao();
    for (const caminho of ['/api/loja/categorias', '/api/loja/produtos', '/api/loja/produtos/1', '/legado']) assert.equal((await fetch(a.url + caminho)).status, 200);
    assert.equal((await a.enviar({ caminho: '/api/loja/cotacao', headers: { Origin: undefined, 'X-IST-Loja': undefined, 'Idempotency-Key': undefined }, body: '{"itens":[]}' })).status, 200);
    assert.equal((await a.enviar({ caminho: '/api/loja/sessao', headers, body: '{}' })).status, 200);
    assert.equal(a.chamadasPedidos.length, 0);
});
test('cookie de produção é reconhecido pela cadeia protegida', async t => {
    const a = await iniciar(t, { producao: true }); const headers = await a.sessao(); assert.match(headers.Cookie, /^__Host-ist-loja=/);
    assert.equal((await a.enviar({ headers })).status, 201);
});
test('configuração de ambiente do processo tem default sandbox e valida valores', () => {
    assert.deepEqual(carregarConfiguracaoLojaPedido({}), { ambiente: 'sandbox' });
    assert.deepEqual(carregarConfiguracaoLojaPedido({ LOJA_AMBIENTE: 'live' }), { ambiente: 'live' });
    for (const LOJA_AMBIENTE of ['', 'LIVE', 'production', ' sandbox ']) assert.throws(() => carregarConfiguracaoLojaPedido({ LOJA_AMBIENTE }), { codigo: 'ERRO_INTERNO' });
});
