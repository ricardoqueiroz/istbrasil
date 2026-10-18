import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import axios from 'axios';
import { criarPaypalProvider } from '../src/services/pagamentos/paypalProvider.js';
import { classificarFalhaPagamento, normalizarResultadoPagamento, normalizarReconciliacaoPagamento } from '../src/services/lojaPagamentoContratos.js';
import { criarLojaPagamentoService } from '../src/services/lojaPagamentoService.js';
import { criarBancoPagamentoIsolado } from './fixtures/lojaPagamentoBancoIsolado.js';

const HOST = 'https://api-m.sandbox.paypal.com';
const CONTA = 'QYR5Z8XDVJNXQ';
const ORDEM = '5O190127TN364715T';
const CAPTURA = '3C679366HH908993F';
// Valores ficticios, exclusivamente para o transporte simulado.
const env = { IST_LOJA_PAYPAL_ENV: 'sandbox', IST_LOJA_PAYPAL_CLIENT_ID: 'fixture-client', IST_LOJA_PAYPAL_CLIENT_SECRET: 'fixture-secret' };
const token = () => ({ status: 200, data: { access_token: 'fixture-access-token', token_type: 'Bearer', expires_in: 3600 } });
const args = (extras = {}) => ({ referencia: randomUUID(), requestId: randomUUID(), ambiente: 'sandbox', contaRecebedora: CONTA,
    moeda: 'BRL', valorCentavos: '19000', ordemId: ORDEM, ...extras });
const ordem = (a, status = 'CREATED', captura = null) => ({ id: ORDEM, intent: 'CAPTURE', status, purchase_units: [{
    reference_id: a.referencia, custom_id: a.referencia, amount: { currency_code: 'BRL', value: '190.00' },
    payee: { merchant_id: CONTA }, ...(captura ? { payments: { captures: [captura] } } : {})
}] });
const captura = (status = 'COMPLETED') => ({ id: CAPTURA, status, amount: { currency_code: 'BRL', value: '190.00' },
    final_capture: true, create_time: '2026-10-16T12:00:00Z' });
const montar = (api, opcoes = {}) => {
    const chamadas = [];
    const http = { async request(c) {
        chamadas.push(c);
        assert.equal(new URL(c.url).origin, HOST); assert.equal(c.maxRedirects, 0); assert.equal(c.proxy, false);
        return c.url.endsWith('/v1/oauth2/token') ? (opcoes.oauth ? opcoes.oauth(c) : token()) : api(c);
    } };
    const provider = criarPaypalProvider({ env, http, ...(opcoes.agora ? { agora: opcoes.agora } : {}) });
    return { provider, chamadas, http, financeiras: () => chamadas.filter(c => c.method === 'POST' && !c.url.endsWith('/token')) };
};
const falha = (categoria, envio, conferir = () => {}) => e => {
    const r = classificarFalhaPagamento(e); assert.equal(r.categoria, categoria); assert.equal(r.envio, envio);
    assert.equal(e.cause, undefined); assert.equal(e.response, undefined); conferir(r); return true;
};

test('configuracao aceita apenas Sandbox explicito e nao usa variaveis legadas', () => {
    assert.ok(criarPaypalProvider({ env, http: { request() { assert.fail(); } } }));
    for (const ambiente of ['live', 'production', '', undefined, 'Sandbox']) {
        assert.throws(() => criarPaypalProvider({ env: { ...env, IST_LOJA_PAYPAL_ENV: ambiente } }), { codigo: 'CONFIGURACAO_INVALIDA' });
    }
    for (const k of ['IST_LOJA_PAYPAL_CLIENT_ID', 'IST_LOJA_PAYPAL_CLIENT_SECRET']) {
        assert.throws(() => criarPaypalProvider({ env: { ...env, [k]: '', PAYPAL_CLIENT_ID: 'legado', PAYPAL_CLIENT_SECRET: 'legado' } }), { codigo: 'CONFIGURACAO_INVALIDA' });
    }
});
test('OAuth usa Client Credentials, token em memoria e margem de renovacao', async () => {
    let instante = 0; const a = args();
    const m = montar(() => ({ status: 200, data: ordem(a) }), { agora: () => instante });
    await m.provider.consultar(a); await m.provider.consultar(a);
    assert.equal(m.chamadas.filter(c => c.url.endsWith('/token')).length, 1);
    const c = m.chamadas[0]; assert.equal(c.url, `${HOST}/v1/oauth2/token`);
    assert.equal(c.data, 'grant_type=client_credentials'); assert.deepEqual(c.auth, { username: env.IST_LOJA_PAYPAL_CLIENT_ID, password: env.IST_LOJA_PAYPAL_CLIENT_SECRET });
    assert.equal(m.chamadas[1].headers.Authorization, 'Bearer fixture-access-token');
    instante = 3570000; await m.provider.consultar(a);
    assert.equal(m.chamadas.filter(c => c.url.endsWith('/token')).length, 2);
    assert.deepEqual(Object.keys(m.provider).sort(), ['capturar', 'consultar', 'consultarCaptura', 'criar', 'reconciliar', 'verificarWebhook']);
});
test('OAuth concorrente compartilha uma unica requisicao e recupera apos falha', async () => {
    const a = args(); let liberar; const bloqueio = new Promise(r => { liberar = r; }); let n = 0;
    const m = montar(() => ({ status: 200, data: ordem(a) }), { oauth: async () => { n++; await bloqueio; return token(); } });
    const simultaneas = Promise.all(Array.from({ length: 8 }, () => m.provider.consultar(a)));
    liberar(); await simultaneas; assert.equal(n, 1);
    let primeira = true;
    const outro = montar(() => ({ status: 200, data: ordem(a) }), { oauth: () => {
        if (primeira) { primeira = false; return { status: 401, data: { error: 'invalid_client', error_description: 'fixture-secret' } }; }
        return token();
    } });
    await assert.rejects(outro.provider.criar(a), falha('AUTENTICACAO', 'NAO_ENVIADO'));
    assert.equal(outro.financeiras().length, 0); await outro.provider.criar(a);
    assert.equal(outro.financeiras().length, 1);
});
test('OAuth malformado ou indisponivel e sanitizado antes da operacao financeira', async () => {
    for (const data of [{ access_token: 'privado', token_type: 7, expires_in: 3600 }, { access_token: '', token_type: 'Bearer', expires_in: 3600 },
        { access_token: 'privado', token_type: 'Bearer', expires_in: -1 }]) {
        const m = montar(() => assert.fail(), { oauth: () => ({ status: 200, data }) });
        await assert.rejects(m.provider.criar(args()), falha('RESPOSTA_INVALIDA', 'NAO_ENVIADO'));
    }
    const m = montar(() => assert.fail(), { oauth: () => { throw new Error('fixture-secret'); } });
    await assert.rejects(m.provider.criar(args()), falha('INFRAESTRUTURA', 'NAO_ENVIADO'));
});
test('criacao envia apenas valores IST, referencia e request ID imutavel', async () => {
    const a = args({ ordemId: null }); const m = montar(() => ({ status: 201, data: ordem(a) }));
    const r = await m.provider.criar({ ...a, url: 'http://outro-host', host: 'outro-host' });
    assert.equal(r.estado, 'AGUARDANDO_APROVACAO');
    const c = m.financeiras()[0]; assert.equal(c.url, `${HOST}/v2/checkout/orders`);
    assert.equal(c.headers['PayPal-Request-Id'], a.requestId); assert.equal(c.headers.Prefer, 'return=representation');
    assert.equal(c.data.intent, 'CAPTURE'); const u = c.data.purchase_units[0];
    assert.equal(u.reference_id, a.referencia); assert.equal(u.custom_id, a.referencia);
    assert.deepEqual(u.payee, { merchant_id: CONTA }); assert.deepEqual(u.amount, { currency_code: 'BRL', value: '190.00' });
    assert.deepEqual(normalizarResultadoPagamento(r), r);
});
for (const [valor, esperado] of [['1', '0.01'], ['95', '0.95'], ['9500', '95.00'], ['9007199254740991', '90071992547409.91']]) {
    test(`conversao exata de ${valor} centavos`, async () => {
        const a = args({ valorCentavos: valor }); const m = montar(() => ({ status: 201, data: { id: ORDEM, status: 'CREATED' } }));
        await m.provider.criar(a); assert.equal(m.financeiras()[0].data.purchase_units[0].amount.value, esperado);
    });
}
test('entrada invalida nao envia HTTP; ausencia de ordem para consulta nao prova ausencia de efeitos', async () => {
    const m = montar(() => assert.fail());
    for (const extras of [{ requestId: 'invalido' }, { valorCentavos: '1.01' }, { valorCentavos: '0' }, { moeda: 'USD' },
        { contaRecebedora: 'invalida' }, { ambiente: 'live' }, { ordemId: '../capture' }]) {
        await assert.rejects(m.provider.criar(args(extras)), falha('VALIDACAO_LOCAL', 'NAO_ENVIADO'));
    }
    const r = await m.provider.consultar(args({ ordemId: null })); assert.equal(r.estado, 'DESCONHECIDO'); assert.equal(m.chamadas.length, 0);
});
for (const [status, esperado] of [['CREATED', 'AGUARDANDO_APROVACAO'], ['PAYER_ACTION_REQUIRED', 'AGUARDANDO_APROVACAO'], ['APPROVED', 'APROVADO']]) {
    test(`consulta ${status} nao comprova captura`, async () => {
        const a = args(); const m = montar(() => ({ status: 200, data: ordem(a, status) })); const r = await m.provider.consultar(a);
        assert.equal(r.estado, esperado); assert.equal(r.capturadoEm, null); assert.equal(m.financeiras().length, 0);
        assert.equal(m.chamadas[1].url, `${HOST}/v2/checkout/orders/${ORDEM}`);
    });
}
test('resposta minima preserva ID e nao inventa valores, moeda, recebedor ou aprovacao', async () => {
    const a = args({ ordemId: null }); const m = montar(() => ({ status: 201, data: { id: ORDEM, status: 'APPROVED' } }));
    const r = await m.provider.criar(a); assert.equal(r.estado, 'DESCONHECIDO'); assert.equal(r.ordemId, ORDEM);
    for (const k of ['valorCentavos', 'moeda', 'contaRecebedora', 'capturaId', 'capturadoEm']) assert.equal(r[k], null);
});
for (const ausente of ['reference_id', 'payee', 'amount']) test(`consulta sem ${ausente} e inconclusiva`, async () => {
    const a = args(); const d = ordem(a, 'APPROVED'); delete d.purchase_units[0][ausente];
    if (ausente === 'reference_id') delete d.purchase_units[0].custom_id;
    const m = montar(() => ({ status: 200, data: d })); assert.equal((await m.provider.consultar(a)).estado, 'DESCONHECIDO');
});
for (const [status, esperado] of [['COMPLETED', 'CAPTURADO'], ['PENDING', 'PENDENTE'], ['DECLINED', 'RECUSADO']]) {
    test(`captura ${status} normaliza fatos e preserva ID`, async () => {
        const a = args(); const m = montar(c => ({ status: 200, data: c.method === 'GET' ? ordem(a, 'APPROVED') : ordem(a, 'COMPLETED', captura(status)) }));
        const r = await m.provider.capturar(a); assert.equal(r.estado, esperado); assert.equal(r.capturaId, CAPTURA);
        assert.equal(r.valorCentavos, '19000'); assert.equal(m.financeiras().length, 1);
        assert.equal(m.financeiras()[0].url, `${HOST}/v2/checkout/orders/${ORDEM}/capture`);
        assert.equal(m.financeiras()[0].headers['PayPal-Request-Id'], a.requestId);
        assert.equal(r.capturadoEm, status === 'COMPLETED' ? '2026-10-16T12:00:00.000Z' : null);
        assert.deepEqual(normalizarResultadoPagamento(r), r);
    });
}
test('recusa comprovada sem ID e recusa identificada incompleta permanecem distintas', async () => {
    const a = args(); const c = captura('DECLINED'); delete c.id;
    const m = montar(() => ({ status: 200, data: ordem(a, 'COMPLETED', c) }));
    const r = await m.provider.consultar(a); assert.equal(r.estado, 'RECUSADO'); assert.equal(r.capturaId, null); assert.equal(r.capturadoEm, null);
    const d = ordem(a, 'COMPLETED', captura('DECLINED')); delete d.purchase_units[0].payee;
    const incompleto = montar(() => ({ status: 200, data: d })); const parcial = await incompleto.provider.consultar(a);
    assert.equal(parcial.estado, 'DESCONHECIDO'); assert.equal(parcial.capturaId, CAPTURA); assert.equal(parcial.contaRecebedora, null);
});
test('nao captura sem aprovacao completa nem repete POST apos resultado ja capturado', async () => {
    const a = args();
    for (const d of [ordem(a), { id: ORDEM, status: 'APPROVED' }, ordem(a, 'COMPLETED', captura())]) {
        const m = montar(() => ({ status: 200, data: d })); await m.provider.capturar(a); assert.equal(m.financeiras().length, 0);
    }
});
for (const campo of ['valor', 'moeda', 'recebedor', 'referencia', 'ordem']) test(`divergencia de ${campo} e preservada e impede envio de captura`, async () => {
    const a = args(); const d = ordem(a, 'APPROVED'); const u = d.purchase_units[0];
    if (campo === 'valor') u.amount.value = '191.00';
    if (campo === 'moeda') u.amount.currency_code = 'USD';
    if (campo === 'recebedor') u.payee.merchant_id = 'ABCD23456789A';
    if (campo === 'referencia') { u.reference_id = randomUUID(); u.custom_id = u.reference_id; }
    if (campo === 'ordem') d.id = 'OTHERORDER';
    const m = montar(() => ({ status: 200, data: d })); const r = await m.provider.capturar(a);
    assert.equal(m.financeiras().length, 0);
    assert.ok(r.valorCentavos !== a.valorCentavos || r.moeda !== a.moeda || r.contaRecebedora !== a.contaRecebedora
        || r.referencia !== a.referencia || r.ordemId !== a.ordemId);
});
test('captura monetariamente divergente preserva o valor observado para revisao do nucleo', async () => {
    const a = args(); const d = ordem(a, 'COMPLETED', captura());
    d.purchase_units[0].amount.value = '191.00'; d.purchase_units[0].payments.captures[0].amount.value = '191.00';
    const m = montar(() => ({ status: 200, data: d })); const r = await m.provider.consultar(a);
    assert.equal(r.estado, 'CAPTURADO'); assert.equal(r.valorCentavos, '19100');
});
for (const modo of ['timeout', 'respostaPerdida']) test(`${modo} apos POST nao e recusa nem provoca retry`, async () => {
    const a = args(); let efeitos = 0;
    const m = montar(c => { if (c.method === 'GET') return { status: 200, data: ordem(a, 'APPROVED') };
        if (modo === 'respostaPerdida') efeitos++; throw Object.assign(new Error('fixture-secret'), { code: modo === 'timeout' ? 'ETIMEDOUT' : 'ECONNRESET' }); });
    await assert.rejects(m.provider.capturar(a), falha('INFRAESTRUTURA', 'INDETERMINADO'));
    assert.equal(m.financeiras().length, 1); assert.equal(efeitos, modo === 'respostaPerdida' ? 1 : 0);
});
for (const [status, data, categoria] of [[422, { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'INSTRUMENT_DECLINED' }] }, 'OPERACAO'],
    [422, {}, 'OPERACAO'], [422, { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'ORDER_NOT_APPROVED' }] }, 'OPERACAO'],
    [404, { name: 'RESOURCE_NOT_FOUND' }, 'OPERACAO'], [429, { name: 'RATE_LIMIT_REACHED' }, 'INFRAESTRUTURA'],
    [503, { name: 'INTERNAL_SERVER_ERROR' }, 'INFRAESTRUTURA'], [401, { name: 'AUTHENTICATION_FAILURE' }, 'AUTENTICACAO'],
    [400, { name: 'INVALID_REQUEST' }, 'RESPOSTA_INVALIDA']]) {
    test(`HTTP ${status}/${data.name ?? 'sem evidencia'} tem classificacao conservadora`, async () => {
        const m = montar(() => ({ status, data }));
        await assert.rejects(m.provider.criar(args({ ordemId: null })), falha(categoria, 'ENVIADO', r => assert.equal(r.resultado.estado, 'DESCONHECIDO')));
        assert.equal(m.financeiras().length, 1);
    });
}
test('erro com ID externo parcial preserva recurso sem fabricar recusa definitiva', async () => {
    const m = montar(() => ({ status: 422, data: { name: 'UNPROCESSABLE_ENTITY', id: ORDEM } }));
    await assert.rejects(m.provider.criar(args({ ordemId: null })), falha('OPERACAO', 'ENVIADO', f => assert.equal(f.resultado.ordemId, ORDEM)));
});
for (const modo of ['json', 'id', 'decimal', 'contradicao', 'multiplas', 'data']) test(`resposta malformada ${modo} e sanitizada e conserva ID conhecido`, async () => {
    const a = args(); let d = ordem(a, 'COMPLETED', captura());
    if (modo === 'json') d = 'nao e JSON';
    if (modo === 'id') d.purchase_units[0].payments.captures[0].id = '../invalido';
    if (modo === 'decimal') d.purchase_units[0].amount.value = 190;
    if (modo === 'contradicao') d.purchase_units[0].payments.captures[0].amount.value = '191.00';
    if (modo === 'multiplas') d.purchase_units.push(structuredClone(d.purchase_units[0]));
    if (modo === 'data') d.purchase_units[0].payments.captures[0].create_time = '2026-02-30T12:00:00Z';
    const m = montar(() => ({ status: 200, data: d }));
    await assert.rejects(m.provider.consultar(a), falha('RESPOSTA_INVALIDA', 'ENVIADO', f => {
        assert.equal(f.resultado.estado, 'DESCONHECIDO'); assert.equal(f.resultado.ordemId, ORDEM);
        if (['decimal', 'contradicao', 'data'].includes(modo)) assert.equal(f.resultado.capturaId, CAPTURA);
    }));
});
test('captura sem prova integral ou com estados contraditorios nunca confirma recebimento', async () => {
    const a = args();
    for (const modo of ['estado', 'final', 'montante', 'identificador', 'data', 'recebedor']) {
        const d = ordem(a, 'COMPLETED', captura()); const c = d.purchase_units[0].payments.captures[0];
        if (modo === 'estado') d.status = 'APPROVED';
        if (modo === 'final') delete c.final_capture;
        if (modo === 'montante') delete c.amount;
        if (modo === 'identificador') delete c.id;
        if (modo === 'data') { delete c.create_time; delete c.update_time; }
        if (modo === 'recebedor') delete d.purchase_units[0].payee;
        const m = montar(() => ({ status: 200, data: d }));
        if (modo === 'data') await assert.rejects(m.provider.consultar(a), falha('RESPOSTA_INVALIDA', 'ENVIADO'));
        else assert.equal((await m.provider.consultar(a)).estado, 'DESCONHECIDO');
    }
});
test('mesma captura explicita conserva a chave; idempotencia financeira cabe ao provedor e nucleo IST', async () => {
    const a = args(); const requests = new Map(); let efeitos = 0;
    const m = montar(c => {
        if (c.method === 'GET') return { status: 200, data: ordem(a, 'APPROVED') };
        const chave = c.headers['PayPal-Request-Id'];
        if (!requests.has(chave)) { efeitos++; requests.set(chave, ordem(a, 'COMPLETED', captura())); }
        return { status: 201, data: requests.get(chave) };
    });
    assert.deepEqual(await m.provider.capturar(a), await m.provider.capturar(a)); assert.equal(efeitos, 1);
    assert.equal(m.financeiras().length, 2); assert.ok(m.financeiras().every(c => c.headers['PayPal-Request-Id'] === a.requestId));
});
test('idempotencia reutiliza request ID fornecido, sem cache local de resultado financeiro', async () => {
    const a = args({ ordemId: null }); const m = montar(() => ({ status: 201, data: ordem(a) }));
    assert.deepEqual(await m.provider.criar(a), await m.provider.criar(a));
    assert.equal(m.financeiras().length, 2); // Reenvio explicito do chamador, nunca retry automatico.
    assert.ok(m.financeiras().every(c => c.headers['PayPal-Request-Id'] === a.requestId));
});
test('secrets, dados pessoais e erros HTTP brutos nao aparecem em logs/resultados', async t => {
    const logs = []; for (const metodo of ['log', 'warn', 'error', 'info', 'debug']) t.mock.method(console, metodo, (...a) => logs.push(a));
    const a = args(); const d = ordem(a); d.payer = { email_address: 'private@example.invalid' }; d.access_token = 'fixture-access-token';
    const m = montar(() => ({ status: 200, data: d })); const r = await m.provider.consultar(a);
    assert.equal(JSON.stringify(r).includes('private@example.invalid'), false); assert.equal(JSON.stringify(r).includes('fixture-access-token'), false);
    const ruim = montar(() => { throw Object.assign(new Error('fixture-secret'), { config: { headers: { Authorization: 'Bearer fixture-access-token' } } }); });
    await assert.rejects(ruim.provider.criar(a), e => {
        const seguro = `${String(e)} ${JSON.stringify(e)} ${JSON.stringify(classificarFalhaPagamento(e))}`;
        assert.equal(seguro.includes('fixture-secret'), false); assert.equal(seguro.includes('fixture-access-token'), false); return true;
    }); assert.deepEqual(logs, []);
});
test('axios existente serializa requisicoes com transporte simulado e sem conexao real', async () => {
    const a = args(); const http = axios.create({ adapter: async config => {
        assert.equal(new URL(config.url).origin, HOST);
        if (config.url.endsWith('/token')) return { ...token(), config, headers: {} };
        const body = JSON.parse(config.data); assert.equal(body.intent, 'CAPTURE');
        return { status: 201, data: ordem(a), config, headers: {} };
    } });
    const p = criarPaypalProvider({ env, http }); assert.equal((await p.criar(a)).estado, 'AGUARDANDO_APROVACAO');
});
test('JSON invalido rejeitado pelo proprio axios tambem e sanitizado', async () => {
    const http = axios.create({ adapter: async config => ({
        status: 200, data: config.url.endsWith('/token') ? token().data : '{JSON quebrado fixture-secret', config, headers: {}
    }) });
    const p = criarPaypalProvider({ env, http });
    await assert.rejects(p.criar(args()), falha('RESPOSTA_INVALIDA', 'INDETERMINADO'));
});
test('cancelamento durante OAuth nao envia operacao e nao interrompe renovacao compartilhada', async () => {
    const a = args(); let liberar; const bloqueio = new Promise(r => { liberar = r; }); const controller = new AbortController();
    const m = montar(() => ({ status: 200, data: ordem(a) }), { oauth: async () => { await bloqueio; return token(); } });
    const cancelada = assert.rejects(m.provider.criar({ ...a, signal: controller.signal }), falha('INFRAESTRUTURA', 'NAO_ENVIADO'));
    const outra = m.provider.consultar(a); controller.abort(); liberar(); await cancelada; await outra;
    assert.equal(m.chamadas.filter(c => c.url.endsWith('/token')).length, 1); assert.equal(m.financeiras().length, 0);
});
test('falha de autenticacao invalida cache sem repetir a operacao automaticamente', async () => {
    const a = args(); let primeira = true;
    const m = montar(() => { if (primeira) { primeira = false; return { status: 401, data: { name: 'AUTHENTICATION_FAILURE' } }; }
        return { status: 200, data: ordem(a) }; });
    await assert.rejects(m.provider.criar(a), falha('AUTENTICACAO', 'ENVIADO'));
    assert.equal(m.financeiras().length, 1);
    await m.provider.consultar(a); assert.equal(m.chamadas.filter(c => c.url.endsWith('/token')).length, 2);
    assert.equal(m.financeiras().length, 1);
});
test('token que ja venceu durante a obtencao nao e enviado a Orders API', async () => {
    let instante = 0;
    const m = montar(() => assert.fail(), { agora: () => instante, oauth: () => { instante = 3600001; return token(); } });
    await assert.rejects(m.provider.criar(args()), falha('INFRAESTRUTURA', 'NAO_ENVIADO')); assert.equal(m.financeiras().length, 0);
});

const montarReconciliacao = (a, alterar = () => {}) => {
    const c = { ...captura(), supplementary_data: { related_ids: { order_id: ORDEM } },
        payer: { email_address: 'private@example.invalid' } };
    const d = ordem(a, 'COMPLETED', captura());
    const f = { ordem: d, captura: c, statusOrdem: 200, statusCaptura: 200 };
    alterar(f);
    const m = montar(config => {
        assert.equal(config.method, 'GET'); assert.equal(config.headers['PayPal-Request-Id'], undefined);
        if (config.url === `${HOST}/v2/checkout/orders/${ORDEM}`) return { status: f.statusOrdem, data: f.ordem };
        assert.equal(config.url, `${HOST}/v2/payments/captures/${CAPTURA}`);
        if (f.erroCaptura) throw f.erroCaptura;
        return { status: f.statusCaptura, data: f.captura };
    });
    return { ...m, f };
};

for (const conhecido of [false, true]) test(`reconciliar confirma captura completa com ID conhecido=${conhecido}`, async () => {
    const a = args({ ...(conhecido ? { capturaId: CAPTURA } : {}), provedor: 'paypal' });
    Object.freeze(a); const antes = JSON.stringify(a); const m = montarReconciliacao(a);
    const r = await m.provider.reconciliar(a);
    assert.equal(r.resultado.estado, 'CAPTURADO'); assert.equal(r.resultado.capturaId, CAPTURA);
    assert.equal(r.resultado.valorCentavos, '19000'); assert.equal(r.resultado.contaRecebedora, CONTA);
    assert.equal(r.observacao.associacaoOrdem, 'CONFIRMADA'); assert.equal(r.observacao.validacao, 'CONSISTENTE');
    assert.deepEqual(normalizarReconciliacaoPagamento(r), r); assert.equal(JSON.stringify(a), antes);
    assert.equal(m.chamadas.length, 3); assert.equal(m.financeiras().length, 0);
    for (const secreto of ['fixture-secret', 'fixture-access-token', 'private@example.invalid', 'https://', 'payer']) assert.equal(JSON.stringify(r).includes(secreto), false);
});

test('reconciliar preserva PENDING/PENDING_REVIEW sem pagamento ou download', async () => {
    const a = args(); const m = montarReconciliacao(a, f => {
        f.captura.status = 'PENDING'; f.captura.status_details = { reason: 'PENDING_REVIEW' };
        f.ordem.purchase_units[0].payments.captures[0].status = 'PENDING';
    });
    const r = await m.provider.reconciliar(a);
    assert.equal(r.resultado.estado, 'PENDENTE'); assert.equal(r.resultado.capturadoEm, null);
    assert.equal(r.observacao.motivoPendencia, 'PENDING_REVIEW'); assert.equal(r.pedidoEstado, undefined);
    assert.equal(r.downloadAutorizado, undefined);
});

test('reconciliar ordem APPROVED sem captura nao cobra nem confirma pagamento', async () => {
    const a = args(); const m = montarReconciliacao(a, f => { f.ordem = ordem(a, 'APPROVED'); });
    const r = await m.provider.reconciliar(a);
    assert.equal(r.resultado.estado, 'APROVADO'); assert.equal(r.observacao.statusCaptura, null);
    assert.equal(r.observacao.associacaoOrdem, 'NAO_DEMONSTRADA'); assert.equal(m.chamadas.length, 2);
});

for (const [nome, alterar] of [
    ['captura divergente', f => { f.captura.id = 'OTHERCAPTURE'; }],
    ['ordem divergente', f => { f.ordem.id = 'OTHERORDER'; }],
    ['referencia divergente', f => { f.ordem.purchase_units[0].reference_id = 'OTHERREF'; }],
    ['referencia da captura divergente', f => { f.captura.custom_id = 'OTHERREF'; }],
    ['valor divergente', f => { f.captura.amount.value = '191.00'; }],
    ['valor da ordem divergente', f => { f.ordem.purchase_units[0].amount.value = '191.00'; }],
    ['moeda divergente', f => { f.captura.amount.currency_code = 'USD'; }],
    ['recebedor divergente', f => { f.captura.payee = { merchant_id: 'ABCD23456789A' }; }],
    ['associacao contraditoria', f => { f.captura.supplementary_data.related_ids.order_id = 'OTHERORDER'; }],
    ['multiplas capturas', f => { f.ordem.purchase_units[0].payments.captures.push({ ...captura(), id: 'OTHER' }); }],
    ['montante malformado', f => { f.captura.amount.value = '1e2'; }],
    ['HATEOAS invalido', f => { f.captura.links = [{ rel: 'up', method: 'GET', href: 'https://evil.example/v2/checkout/orders/OTHER' }]; }],
    ['captura embutida divergente', f => { f.ordem.purchase_units[0].payments.captures[0].id = 'OTHER'; }],
    ['tipo de operacao divergente', f => { f.ordem.intent = 'AUTHORIZE'; }],
    ['estrutura de autorizacoes invalida', f => { f.ordem.purchase_units[0].payments.authorizations = {}; }],
    ['referencia embutida contraditoria', f => { f.ordem.purchase_units[0].payments.captures[0].custom_id = 'OTHERREF'; }]
]) test(`reconciliar ${nome} nunca produz resultado confirmavel`, async () => {
    const a = args({ capturaId: CAPTURA }); const m = montarReconciliacao(a, alterar);
    const r = await m.provider.reconciliar(a);
    assert.equal(r.resultado.estado, 'DESCONHECIDO'); assert.equal(r.resultado.capturadoEm, null);
    assert.equal(r.observacao.evidencia, 'CONTRADITORIA'); assert.equal(r.observacao.validacao, 'DIVERGENTE');
    assert.deepEqual(normalizarReconciliacaoPagamento(r), r); assert.equal(m.financeiras().length, 0);
});

for (const [nome, alterar] of [
    ['recebedor ausente', f => { delete f.ordem.purchase_units[0].payee; }],
    ['referencia ausente', f => { delete f.ordem.purchase_units[0].reference_id; delete f.ordem.purchase_units[0].custom_id; }],
    ['valor ausente', f => { delete f.captura.amount; }],
    ['identidade da ordem ausente', f => { delete f.ordem.id; }],
    ['final_capture ausente', f => { delete f.captura.final_capture; }],
    ['associacao nao demonstrada', f => { delete f.ordem.purchase_units[0].payments; delete f.captura.supplementary_data; }]
]) test(`reconciliar ${nome} permanece inconclusivo`, async () => {
    const a = args({ capturaId: CAPTURA }); const m = montarReconciliacao(a, alterar);
    const r = await m.provider.reconciliar(a);
    assert.equal(r.resultado.estado, 'DESCONHECIDO'); assert.equal(r.observacao.validacao, 'INCONCLUSIVA');
    if (nome === 'recebedor ausente') assert.equal(r.resultado.contaRecebedora, null);
    if (nome === 'associacao nao demonstrada') assert.equal(r.observacao.associacaoOrdem, 'NAO_DEMONSTRADA');
});

for (const status of ['DECLINED', 'FAILED', 'REFUNDED', 'PARTIALLY_REFUNDED', 'FUTURE_SECRET']) test(`reconciliar ${status} conservador`, async () => {
    const a = args(); const m = montarReconciliacao(a, f => {
        f.captura.status = status; f.ordem.purchase_units[0].payments.captures[0].status = status;
    });
    const r = await m.provider.reconciliar(a);
    assert.equal(r.resultado.estado, 'DESCONHECIDO'); assert.equal(r.observacao.validacao, 'INCONCLUSIVA');
    assert.equal(r.observacao.statusCaptura, status === 'FUTURE_SECRET' ? 'DESCONHECIDO' : status);
    assert.equal(JSON.stringify(r).includes('FUTURE_SECRET'), false);
});

test('reconciliar usa recebedor observado na captura e evidencia da ordem quando disponivel', async () => {
    const a = args(); const m = montarReconciliacao(a, f => { delete f.ordem.purchase_units[0].payee; f.captura.payee = { merchant_id: CONTA }; });
    assert.equal((await m.provider.reconciliar(a)).resultado.estado, 'CAPTURADO');
});

test('reconciliar sem captura embutida exige associacao direta demonstrada', async () => {
    const a = args({ capturaId: CAPTURA }); const m = montarReconciliacao(a, f => { delete f.ordem.purchase_units[0].payments; });
    assert.equal((await m.provider.reconciliar(a)).resultado.estado, 'CAPTURADO');
});

test('reconciliar permite PENDING passar a COMPLETED entre leituras sem POST', async () => {
    const a = args(); const m = montarReconciliacao(a, f => { f.ordem.purchase_units[0].payments.captures[0].status = 'PENDING'; });
    assert.equal((await m.provider.reconciliar(a)).resultado.estado, 'CAPTURADO'); assert.equal(m.financeiras().length, 0);
});

for (const recurso of ['ordem', 'captura']) test(`reconciliar 404 de ${recurso} nao prova ausencia de cobranca`, async () => {
    const a = args(); const m = montarReconciliacao(a, f => {
        f[recurso] = { name: 'RESOURCE_NOT_FOUND', private: 'fixture-secret' };
        f[recurso === 'ordem' ? 'statusOrdem' : 'statusCaptura'] = 404;
    });
    const r = await m.provider.reconciliar(a);
    assert.equal(r.resultado.estado, 'DESCONHECIDO'); assert.equal(r.observacao.validacao, 'INCONCLUSIVA');
    assert.equal(JSON.stringify(r).includes('fixture-secret'), false);
});

test('reconciliar timeout e resposta malformada falham sem exposicao ou retry', async () => {
    const a = args(); const m = montarReconciliacao(a, f => { f.erroCaptura = Object.assign(new Error('fixture-secret'), { code: 'ETIMEDOUT' }); });
    await assert.rejects(m.provider.reconciliar(a), falha('INFRAESTRUTURA', 'INDETERMINADO'));
    assert.equal(m.chamadas.length, 3);
    const invalido = montarReconciliacao(a, f => { f.captura = ['fixture-secret']; });
    await assert.rejects(invalido.provider.reconciliar(a), falha('RESPOSTA_INVALIDA', 'ENVIADO'));
});

test('reconciliar rejeita contexto invalido antes de HTTP e nao exige nova chave', async () => {
    const m = montar(() => assert.fail('sem HTTP'));
    for (const extra of [{ provedor: 'outro' }, { ambiente: 'live' }, { ordemId: '../orders' }, { capturaId: '../capture' }, { moeda: 'USD' }]) {
        await assert.rejects(m.provider.reconciliar(args(extra)), falha('VALIDACAO_LOCAL', 'NAO_ENVIADO'));
    }
    const a = args({ ordemId: null, requestId: undefined });
    const r = await m.provider.reconciliar(a); assert.equal(r.observacao.evidencia, 'AUSENTE'); assert.equal(m.chamadas.length, 0);
});

test('reconciliar nao registra segredos e sanitiza motivos desconhecidos e autenticacao', async t => {
    const logs = []; for (const k of ['log', 'error', 'warn', 'info', 'debug']) t.mock.method(console, k, (...v) => logs.push(v));
    const a = args({ requestId: undefined });
    const m = montarReconciliacao(a, f => {
        f.captura.status_details = { reason: 'fixture-secret private@example.invalid' };
        f.captura.links = [{ rel: 'up', method: 'GET', href: `https://api.sandbox.paypal.com/v2/checkout/orders/${ORDEM}` }];
    });
    const r = await m.provider.reconciliar(a);
    assert.equal(r.resultado.estado, 'CAPTURADO'); assert.equal(r.observacao.motivoPendencia, null);
    assert.ok(Buffer.byteLength(JSON.stringify(r.observacao), 'utf8') <= 1024);
    for (const secreto of ['fixture-secret', 'fixture-access-token', 'private@example.invalid', 'Authorization', 'https://']) {
        assert.equal(JSON.stringify(r).includes(secreto), false);
    }
    const outro = montarReconciliacao(a, f => { f.statusCaptura = 401; f.captura = { name: 'AUTHENTICATION_FAILURE', description: 'fixture-secret' }; });
    await assert.rejects(outro.provider.reconciliar(a), falha('AUTENTICACAO', 'ENVIADO'));
    assert.deepEqual(logs, []);
});

test('adaptador HTTP simulado com nucleo real e MariaDB descartavel', {
    skip: !process.env.IST_LOJA_PAGAMENTOS_MARIADB_BIN, timeout: 180000
}, async t => {
    const { pool, admin, novaCompra } = await criarBancoPagamentoIsolado(t);
    let sequencia = 0;
    for (const modo of ['COMPLETED', 'DECLINED', 'PERDIDA', 'PARCIAL']) await t.test(modo, async () => {
        const compra = await novaCompra(); const id = `ISTORDER${++sequencia}`; let recurso, efeitos = 0, posts = 0;
        const m = montar(c => {
            if (c.url.endsWith('/orders') && c.method === 'POST') {
                recurso = { id, intent: 'CAPTURE', status: 'APPROVED', purchase_units: structuredClone(c.data.purchase_units) };
                return { status: 201, data: structuredClone(recurso) };
            }
            if (c.method === 'POST') {
                posts++; if (modo !== 'DECLINED') efeitos++;
                recurso.status = 'COMPLETED'; recurso.purchase_units[0].payments = { captures: [{ ...captura(modo === 'DECLINED' ? 'DECLINED' : 'COMPLETED'),
                    id: `ISTCAPTURE${sequencia}`, create_time: new Date().toISOString() }] };
                if (modo === 'PERDIDA') throw new Error('resposta perdida fixture');
                const d = structuredClone(recurso); if (modo === 'PARCIAL') delete d.purchase_units[0].payee;
                return { status: 201, data: d };
            }
            return { status: 200, data: structuredClone(recurso) };
        });
        const novo = () => criarLojaPagamentoService({ db: pool, adaptador: criarPaypalProvider({ env, http: m.http }),
            contexto: { provedor: 'paypal', ambiente: 'sandbox', contaRecebedora: CONTA } });
        const service = novo(); const pg = await service.criarTentativa(compra.sessao, { pedidoPublicId: compra.pedidoPublicId }, randomUUID());
        const chave = randomUUID(); const ref = { pagamentoPublicId: pg.publicId };
        if (modo === 'PERDIDA') await assert.rejects(service.capturar(compra.sessao, ref, chave), { codigo: 'RESULTADO_DESCONHECIDO' });
        else {
            const r = await service.capturar(compra.sessao, ref, chave);
            assert.equal(r.estado, modo === 'PARCIAL' ? 'DESCONHECIDO' : modo === 'DECLINED' ? 'RECUSADO' : 'CAPTURADO');
        }
        const antes = modo === 'PARCIAL' || modo === 'PERDIDA';
        if (antes) {
            const [[p]] = await admin.query('SELECT reserva_ativa FROM ist_loja_pagamentos WHERE public_id=?', [pg.publicId]); assert.equal(p.reserva_ativa, 1);
        }
        const repetido = await novo().capturar(compra.sessao, ref, chave);
        assert.equal(repetido.estado, modo === 'DECLINED' ? 'RECUSADO' : 'CAPTURADO'); assert.equal(posts, 1);
        const [[p]] = await admin.query('SELECT captura_externa_id,CAST(capturado_centavos AS CHAR) AS recebido,capturado_em FROM ist_loja_pagamentos WHERE public_id=?', [pg.publicId]);
        assert.equal(p.captura_externa_id, `ISTCAPTURE${sequencia}`); assert.equal(p.recebido, modo === 'DECLINED' ? '0' : '19000');
        assert.equal(efeitos, modo === 'DECLINED' ? 0 : 1); if (modo === 'DECLINED') assert.equal(p.capturado_em, null);
    });
});
