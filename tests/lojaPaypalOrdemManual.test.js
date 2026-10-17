import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { consultarAprovacaoManual } from '../scripts/loja-paypal-aprovacao-manual.mjs';
import { capturarOrdemManual } from '../scripts/loja-paypal-captura-manual.mjs';

const ID = '92R75874BG9454744';
const CONTA = 'QYR5Z8XDVJNXQ';
const REFERENCIA = randomUUID();
const CHAVE = randomUUID();
const env = { IST_LOJA_PAYPAL_ENV: 'sandbox', IST_LOJA_PAYPAL_CLIENT_ID: 'fixture-client', IST_LOJA_PAYPAL_CLIENT_SECRET: 'fixture-secret' };
const argv = (captura = false) => [captura ? '--autorizar-captura-sandbox' : '--autorizar-consulta-sandbox',
    '--ordem', ID, '--recebedor', CONTA, '--referencia', REFERENCIA, ...(captura ? ['--request-id', CHAVE] : [])];
const url = `https://www.sandbox.paypal.com/checkoutnow?token=${ID}`;
const ordem = (estado = 'CREATED') => ({ id: ID, intent: 'CAPTURE', status: estado,
    purchase_units: [{ reference_id: REFERENCIA, custom_id: REFERENCIA,
        amount: { currency_code: 'BRL', value: '1.00' }, payee: { merchant_id: CONTA } }],
    links: [{ rel: 'approve', method: 'GET', href: url }], payer: { email_address: 'private@example.invalid' } });
const montar = (opcoes = {}) => {
    const chamadas = [];
    const http = { async request(c) {
        chamadas.push(c); assert.equal(new URL(c.url).origin, 'https://api-m.sandbox.paypal.com');
        if (c.url.endsWith('/token')) return { status: 200, data: { access_token: 'fixture-token', token_type: 'Bearer', expires_in: 3600 } };
        assert.notEqual(c.url, 'https://api-m.sandbox.paypal.com/v2/checkout/orders', 'criacao proibida');
        if (c.method === 'GET') {
            assert.equal(c.url.endsWith(`/orders/${ID}`), true);
            return opcoes.consultar ? opcoes.consultar(c) : { status: 200, data: ordem('APPROVED') };
        }
        assert.equal(c.url.endsWith(`/orders/${ID}/capture`), true);
        assert.equal(c.headers['PayPal-Request-Id'], CHAVE);
        return opcoes.capturar(c);
    } };
    return { http, chamadas, posts: () => chamadas.filter(c => c.url.endsWith('/capture')) };
};
const rodar = async (captura, m, extras = {}) => {
    const linhas = [];
    const codigo = await (captura ? capturarOrdemManual : consultarAprovacaoManual)({ argv: argv(captura), env, http: m.http,
        ...extras, saida: linha => linhas.push(linha) });
    return { codigo, linhas, dados: linhas.map(JSON.parse) };
};
const concluida = (estado = 'COMPLETED') => {
    const d = ordem('COMPLETED');
    d.purchase_units[0].payments = { captures: [{ id: 'CAPTUREMANUAL123', status: estado,
        amount: { currency_code: 'BRL', value: '1.00' }, final_capture: true, create_time: '2026-10-16T12:00:00Z' }] };
    return d;
};

test('consulta existente recupera somente link oficial retornado pela API', async () => {
    const m = montar({ consultar: () => ({ status: 200, data: ordem() }) }); const r = await rodar(false, m);
    assert.equal(r.codigo, 0); assert.equal(r.dados[0].estado, 'AGUARDANDO_APROVACAO');
    assert.equal(r.dados[1].linkAprovacao, url); assert.equal(r.dados[1].estadoLink, 'VALIDO');
    assert.equal(m.chamadas.length, 2); assert.equal(m.posts().length, 0);
});
test('payer-action GET oficial tambem e aceito sem construir URL', async () => {
    const d = ordem(); d.links[0].rel = 'payer-action';
    const m = montar({ consultar: () => ({ status: 200, data: d }) }); const r = await rodar(false, m);
    assert.equal(r.dados[1].linkAprovacao, d.links[0].href);
});
test('ordem aprovada nao exige link e nao captura', async () => {
    const m = montar(); const r = await rodar(false, m); assert.equal(r.codigo, 0);
    assert.equal(r.dados[0].estado, 'APROVADO'); assert.equal(m.posts().length, 0); assert.equal(r.dados.length, 1);
});
test('link ausente nao e substituido por URL suposta', async () => {
    const d = ordem(); delete d.links;
    const r = await rodar(false, montar({ consultar: () => ({ status: 200, data: d }) }));
    assert.equal(r.codigo, 1); assert.equal(r.dados[1].estadoLink, 'AUSENTE'); assert.equal(r.dados[1].linkAprovacao, null);
});
for (const href of ['https://evil.example/checkoutnow', `https://www.paypal.com/checkoutnow?token=${ID}`,
    `https://www.sandbox.paypal.com.evil.example/checkoutnow?token=${ID}`, `http://www.sandbox.paypal.com/checkoutnow?token=${ID}`,
    `https://user:secret@www.sandbox.paypal.com/checkoutnow?token=${ID}`, `${url}&redirect_uri=https://evil.example`,
    `${url}&token=OTHER`, url.replace(ID, 'OTHER'), `${url}#segredo`, `https://www.sandbox.paypal.com:8443/checkoutnow?token=${ID}`]) {
    test(`rejeita link nao confiavel ${new URL(href).hostname}/${new URL(href).protocol}`, async () => {
        const d = ordem(); d.links[0].href = href;
        const r = await rodar(false, montar({ consultar: () => ({ status: 200, data: d }) }));
        assert.equal(r.codigo, 1); assert.equal(r.dados[1].estadoLink, 'REJEITADO');
        assert.equal(r.linhas.join().includes(href), false);
    });
}
test('ordem VOIDED ou indisponivel nao oferece aprovacao nem captura', async () => {
    for (const resposta of [{ status: 200, data: ordem('VOIDED') }, { status: 404, data: { name: 'RESOURCE_NOT_FOUND' } }]) {
        for (const capturar of [false, true]) {
            const m = montar({ consultar: () => resposta }); const r = await rodar(capturar, m);
            assert.equal(r.codigo, 1); assert.equal(m.posts().length, 0); assert.equal(r.linhas.join().includes(url), false);
        }
    }
});
test('flags, identidade original e credenciais sao obrigatorias antes de HTTP', async () => {
    const http = { request() { assert.fail('nenhuma chamada autorizada'); } };
    for (const captura of [false, true]) {
        for (const entrada of [[], argv(!captura), argv(captura).slice(0, -2), [...argv(captura), '--criar']]) {
            assert.equal((await rodar(captura, { http }, { argv: entrada })).codigo, 1);
        }
        for (const config of [{}, { ...env, IST_LOJA_PAYPAL_ENV: 'live' }, { ...env, IST_LOJA_PAYPAL_ENV: 'production' }]) {
            assert.equal((await rodar(captura, { http }, { env: config })).codigo, 1);
        }
    }
});
test('captura bloqueada antes da aprovacao e quando ja concluida', async () => {
    for (const d of [ordem(), concluida()]) {
        const m = montar({ consultar: () => ({ status: 200, data: d }) }); const r = await rodar(true, m);
        assert.equal(r.codigo, 1); assert.equal(m.posts().length, 0);
    }
});
for (const [status, esperado, codigo] of [['COMPLETED', 'CAPTURADO', 0], ['PENDING', 'PENDENTE', 1], ['DECLINED', 'RECUSADO', 1]]) {
    test(`captura ${status} preserva identificadores sem nova ordem`, async () => {
        const m = montar({ capturar: () => ({ status: 201, data: concluida(status) }) }); const r = await rodar(true, m);
        assert.equal(r.codigo, codigo); assert.equal(m.posts().length, 1);
        assert.equal(r.dados.at(-1).estado, esperado); assert.equal(r.dados.at(-1).capturaId, 'CAPTUREMANUAL123');
        assert.equal(r.dados.at(-1).requestIdCaptura, CHAVE);
        assert.deepEqual(r.dados.map(linha => linha.requestIdCaptura), [CHAVE, CHAVE, CHAVE]);
        assert.equal(r.dados.at(-1).capturadoEm, status === 'COMPLETED' ? '2026-10-16T12:00:00.000Z' : null);
    });
}
test('mudanca de aprovacao entre consultas bloqueia o POST', async () => {
    let n = 0;
    const m = montar({ consultar: () => ({ status: 200, data: ordem(++n === 1 ? 'APPROVED' : 'CREATED') }) });
    const r = await rodar(true, m); assert.equal(r.codigo, 1); assert.equal(m.posts().length, 0);
});
for (const campo of ['valor', 'moeda', 'referencia', 'recebedor', 'id']) test(`contradicao ${campo} antes da captura bloqueia envio`, async () => {
    const d = ordem('APPROVED'); const u = d.purchase_units[0];
    if (campo === 'valor') u.amount.value = '2.00';
    if (campo === 'moeda') u.amount.currency_code = 'USD';
    if (campo === 'recebedor') u.payee.merchant_id = 'ABCD23456789A';
    if (campo === 'referencia') { u.reference_id = randomUUID(); u.custom_id = u.reference_id; }
    if (campo === 'id') d.id = 'OTHERORDER';
    const m = montar({ consultar: () => ({ status: 200, data: d }) }); const r = await rodar(true, m);
    assert.equal(r.codigo, 1); assert.equal(m.posts().length, 0);
});
test('resposta parcial antes ou depois do envio interrompe e preserva IDs conhecidos', async () => {
    const m = montar({ consultar: () => ({ status: 200, data: { id: ID, status: 'APPROVED' } }) });
    assert.equal((await rodar(true, m)).codigo, 1); assert.equal(m.posts().length, 0);
    const d = concluida(); delete d.purchase_units[0].payee;
    const depois = montar({ capturar: () => ({ status: 201, data: d }) }); const r = await rodar(true, depois);
    assert.equal(r.codigo, 1); assert.equal(r.dados.at(-1).estado, 'DESCONHECIDO');
    assert.equal(r.dados.at(-1).capturaId, 'CAPTUREMANUAL123'); assert.equal(depois.posts().length, 1);
});
for (const code of ['ETIMEDOUT', 'ECONNRESET']) test(`falha ${code} nunca repete captura ou exibe segredos`, async () => {
    const m = montar({ capturar: () => { throw Object.assign(new Error('fixture-secret fixture-token'), { code }); } });
    const r = await rodar(true, m); assert.equal(r.codigo, 1); assert.equal(m.posts().length, 1);
    assert.equal(r.dados.at(-1).envio, 'INDETERMINADO');
    assert.equal(r.linhas.join().includes('fixture-'), false); assert.equal(r.dados.at(-1).requestIdCaptura, CHAVE);
    assert.ok(r.dados.every(linha => linha.requestIdCaptura === CHAVE));
});
test('repeticao explicita conserva chave e consulta impede recaptura de ordem ja concluida', async () => {
    let estado = ordem('APPROVED');
    const m = montar({ consultar: () => ({ status: 200, data: estado }), capturar: () => {
        estado = concluida(); return { status: 201, data: estado };
    } });
    assert.equal((await rodar(true, m)).codigo, 0); assert.equal((await rodar(true, m)).codigo, 1);
    assert.equal(m.posts().length, 1); assert.equal(m.posts()[0].headers['PayPal-Request-Id'], CHAVE);
});
test('logs e saida nao incluem credenciais, headers, dados pessoais ou corpo bruto', async t => {
    const logs = []; for (const k of ['log', 'error', 'warn', 'info', 'debug']) t.mock.method(console, k, (...a) => logs.push(a));
    const r = await rodar(true, montar({ capturar: () => ({ status: 201, data: concluida() }) }));
    for (const segredo of ['fixture-secret', 'fixture-token', 'fixture-client', 'Authorization', 'private@example.invalid', 'purchase_units']) {
        assert.equal(r.linhas.join().includes(segredo), false);
    }
    assert.deepEqual(logs, []);
});
