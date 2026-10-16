import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { reconciliarCapturaManual } from '../scripts/loja-paypal-reconciliacao-captura-manual.mjs';
import { criarPaypalProvider } from '../src/services/pagamentos/paypalProvider.js';

const ID = '9G418289UJ6071503', ORDEM = '92R75874BG9454744';
const env = { IST_LOJA_PAYPAL_ENV: 'sandbox', IST_LOJA_PAYPAL_CLIENT_ID: 'fixture-client', IST_LOJA_PAYPAL_CLIENT_SECRET: 'fixture-secret' };
const argv = ['--autorizar-consulta-sandbox', '--captura', ID, '--ordem', ORDEM];
const recurso = (status = 'COMPLETED') => ({ id: ID, status, amount: { currency_code: 'BRL', value: '1.00' },
    create_time: '2026-10-16T12:00:00Z', update_time: '2026-10-16T12:01:00Z',
    supplementary_data: { related_ids: { order_id: ORDEM } },
    payer: { email_address: 'private@example.invalid' }, processor_response: { private: 'fixture-secret' } });
const montar = (resposta = { status: 200, data: recurso() }, oauth) => {
    const chamadas = [];
    const http = { async request(c) {
        chamadas.push(c); assert.equal(new URL(c.url).origin, 'https://api-m.sandbox.paypal.com');
        if (c.url.endsWith('/token')) return oauth ?? { status: 200, data: { token_type: 'Bearer', access_token: 'fixture-token', expires_in: 3600 } };
        assert.equal(c.method, 'GET'); assert.equal(c.url, `https://api-m.sandbox.paypal.com/v2/payments/captures/${ID}`);
        assert.equal(c.headers['PayPal-Request-Id'], undefined);
        if (resposta instanceof Error) throw resposta;
        return resposta;
    } };
    return { http, chamadas };
};
const rodar = async (m, opcoes = {}) => {
    const linhas = []; const codigo = await reconciliarCapturaManual({ argv, env, http: m.http, ...opcoes,
        saida: linha => linhas.push(linha) });
    return { codigo, linhas, resultado: JSON.parse(linhas.at(-1)) };
};

for (const status of ['COMPLETED', 'PENDING', 'DECLINED', 'REFUNDED', 'PARTIALLY_REFUNDED', 'FAILED']) {
    test(`consulta diagnostica distingue ${status}, sem inferir estado da ordem`, async () => {
        const m = montar({ status: 200, data: recurso(status) }); const r = await rodar(m);
        assert.equal(r.codigo, 0); assert.equal(r.resultado.statusFinanceiro, status);
        assert.equal(r.resultado.validacao, 'CONSISTENTE'); assert.equal(r.resultado.capturaId, ID);
        assert.equal(r.resultado.associacaoOrdem, 'CONFIRMADA'); assert.equal(m.chamadas.length, 2);
        assert.equal(r.resultado.horarioReferenciaUTC, status === 'COMPLETED' ? '2026-10-16T12:01:00.000Z' : null);
    });
}
test('captura indisponivel nao e prova de ausencia de efeito financeiro', async () => {
    const r = await rodar(montar({ status: 404, data: { name: 'RESOURCE_NOT_FOUND' } }));
    assert.equal(r.codigo, 1); assert.equal(r.resultado.estadoConsulta, 'INDISPONIVEL');
    assert.equal(r.resultado.statusFinanceiro, 'DESCONHECIDO');
});
for (const campo of ['valor', 'moeda', 'captura', 'ordem']) test(`divergencia ${campo} e explicitada`, async () => {
    const d = recurso();
    if (campo === 'valor') d.amount.value = '1.01';
    if (campo === 'moeda') d.amount.currency_code = 'USD';
    if (campo === 'captura') d.id = 'OTHERID';
    if (campo === 'ordem') d.supplementary_data.related_ids.order_id = 'OTHERORDER';
    const r = await rodar(montar({ status: 200, data: d })); assert.equal(r.codigo, 1); assert.equal(r.resultado.validacao, 'DIVERGENTE');
});
for (const campo of ['id', 'amount', 'status']) test(`resposta parcial sem ${campo} nao e validada`, async () => {
    const d = recurso(); delete d[campo]; const r = await rodar(montar({ status: 200, data: d }));
    assert.equal(r.codigo, 1); assert.equal(r.resultado.validacao, 'INCONCLUSIVA');
});
test('associacao ausente e uma limitacao explicita, sem preencher com ordem esperada', async () => {
    const d = recurso(); delete d.supplementary_data;
    const r = await rodar(montar({ status: 200, data: d })); assert.equal(r.codigo, 1);
    assert.equal(r.resultado.statusFinanceiro, 'COMPLETED'); assert.equal(r.resultado.associacaoOrdem, 'NAO_DEMONSTRADA');
    assert.deepEqual(r.resultado.ordensRelacionadas, []); assert.equal(r.resultado.limitacaoAssociacao, 'API_NAO_INFORMOU_ORDEM_RELACIONADA');
});
test('link up oficial demonstra associacao sem seguir ou imprimir a URL', async () => {
    const d = recurso(); delete d.supplementary_data;
    d.links = [{ rel: 'up', method: 'GET', href: `https://api-m.sandbox.paypal.com/v2/checkout/orders/${ORDEM}` }];
    const m = montar({ status: 200, data: d }); const r = await rodar(m); assert.equal(r.codigo, 0);
    assert.equal(r.resultado.associacaoOrdem, 'CONFIRMADA'); assert.equal(m.chamadas.length, 2);
    assert.equal(r.linhas.join().includes('https://'), false);
});
test('fontes de associacao contraditorias e links externos nao sao aceitos', async () => {
    for (const href of ['https://evil.example/v2/checkout/orders/OTHERORDER', 'https://api-m.sandbox.paypal.com/v2/checkout/orders/OTHERORDER']) {
        const d = recurso(); d.links = [{ rel: 'up', method: 'GET', href }];
        const r = await rodar(montar({ status: 200, data: d })); assert.equal(r.codigo, 1);
        assert.notEqual(r.resultado.associacaoOrdem, 'CONFIRMADA'); assert.equal(r.linhas.join().includes(href), false);
    }
});
test('datas ausentes nao sao inventadas e datas invalidas nao validam a resposta', async () => {
    const d = recurso(); delete d.create_time; delete d.update_time;
    const r = await rodar(montar({ status: 200, data: d })); assert.equal(r.resultado.horarioReferenciaUTC, null);
    assert.equal(r.resultado.fonteHorario, null); assert.equal(r.resultado.statusFinanceiro, 'COMPLETED');
    d.update_time = '2026-02-30T12:00:00Z';
    assert.equal((await rodar(montar({ status: 200, data: d }))).resultado.validacao, 'INCONCLUSIVA');
});
test('status desconhecido e resposta inesperada nao vazam dados nem indicam conclusao', async () => {
    const d = recurso('future-status-fixture-secret'); const r = await rodar(montar({ status: 200, data: d }));
    assert.equal(r.resultado.statusFinanceiro, 'DESCONHECIDO'); assert.equal(r.codigo, 1);
    assert.equal(r.linhas.join().includes('fixture-secret'), false);
    for (const data of ['fixture-secret', [], null]) assert.equal((await rodar(montar({ status: 200, data }))).codigo, 1);
});
test('timeout e falhas de autenticacao sao sanitizados sem retentativas', async () => {
    const timeout = montar(Object.assign(new Error('fixture-secret'), { code: 'ETIMEDOUT' })); const r = await rodar(timeout);
    assert.equal(r.codigo, 1); assert.equal(r.resultado.categoria, 'INFRAESTRUTURA'); assert.equal(timeout.chamadas.length, 2);
    const oauth = montar(undefined, { status: 401, data: { error: 'invalid_client', error_description: 'fixture-secret' } });
    const o = await rodar(oauth); assert.equal(o.resultado.categoria, 'AUTENTICACAO'); assert.equal(oauth.chamadas.length, 1);
    const a = await rodar(montar({ status: 401, data: { name: 'AUTHENTICATION_FAILURE' } })); assert.equal(a.resultado.categoria, 'AUTENTICACAO');
    assert.equal([r, o, a].some(v => v.linhas.join().includes('fixture-secret')), false);
});
test('exige autorizacao, IDs validos e configuracao Sandbox antes de HTTP', async () => {
    const http = { request() { assert.fail('nenhum HTTP permitido'); } };
    for (const entrada of [[], argv.slice(1), [...argv, '--capturar'], argv.map(v => v === ID ? '../refund' : v)]) {
        assert.equal((await rodar({ http }, { argv: entrada })).codigo, 1);
    }
    for (const config of [{}, { ...env, IST_LOJA_PAYPAL_ENV: 'live' }, { ...env, IST_LOJA_PAYPAL_ENV: 'production' }]) {
        assert.equal((await rodar({ http }, { env: config })).codigo, 1);
    }
});
test('sem POST financeiro, sem banco e sem vazamento de campos privados', async t => {
    const logs = []; for (const k of ['log', 'warn', 'error', 'info', 'debug']) t.mock.method(console, k, (...a) => logs.push(a));
    const m = montar(); const r = await rodar(m);
    assert.ok(m.chamadas.every(c => c.method === 'GET' || c.url.endsWith('/v1/oauth2/token')));
    for (const segredo of ['fixture-secret', 'fixture-token', 'fixture-client', 'Authorization', 'private@example.invalid', 'processor_response']) {
        assert.equal(r.linhas.join().includes(segredo), false);
    }
    assert.deepEqual(logs, []);
});
test('consulta auxiliar compartilha OAuth com o adaptador existente', async () => {
    let oauth = 0;
    const provider = criarPaypalProvider({ env, http: { async request(c) {
        if (c.url.endsWith('/token')) { oauth++; return { status: 200, data: { access_token: 'fixture-token', token_type: 'Bearer', expires_in: 3600 } }; }
        assert.equal(c.method, 'GET');
        return { status: 200, data: c.url.includes('/payments/captures/') ? recurso() : { id: ORDEM, status: 'CREATED' } };
    } } });
    await provider.consultarCaptura({ capturaId: ID, ambiente: 'sandbox' });
    await provider.consultar({ ordemId: ORDEM, referencia: randomUUID(), ambiente: 'sandbox', contaRecebedora: 'QYR5Z8XDVJNXQ', valorCentavos: '100', moeda: 'BRL' });
    assert.equal(oauth, 1);
});
