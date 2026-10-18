import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { criarPaypalProvider } from '../src/services/pagamentos/paypalProvider.js';
import { criarProcessadorWebhookPayPal } from '../src/services/lojaPaypalWebhook.js';
import { criarLojaPaypalWebhookRouter } from '../src/routes/lojaPaypalWebhook.routes.js';

const env = { IST_LOJA_PAYPAL_ENV: 'sandbox', IST_LOJA_PAYPAL_CLIENT_ID: 'fixture-client', IST_LOJA_PAYPAL_CLIENT_SECRET: 'fixture-secret' };
const cabecalhos = { 'paypal-transmission-id': 'transmission-fixture', 'paypal-transmission-time': '2026-10-18T12:00:00Z',
    'paypal-transmission-sig': 'fixture-signature', 'paypal-auth-algo': 'SHA256withRSA',
    'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-fixture' };
const evento = (tipo = 'PAYMENT.CAPTURE.COMPLETED') => ({ id: 'WH-FIXTURE', event_type: tipo,
    resource: { id: 'CAPTURE123', supplementary_data: { related_ids: { order_id: 'ORDER123' } }, status: 'UNTRUSTED' } });
const corpo = tipo => Buffer.from(JSON.stringify(evento(tipo)));
const montar = ({ status = 'SUCCESS', oauthErro = false } = {}) => {
    const chamadas = [];
    const adaptador = criarPaypalProvider({ env, http: { async request(c) {
        chamadas.push(c);
        assert.ok(c.url.startsWith('https://api-m.sandbox.paypal.com/'));
        if (c.url.endsWith('/token')) return oauthErro ? { status: 401, data: { error: 'invalid_client' } }
            : { status: 200, data: { token_type: 'Bearer', access_token: 'fixture-token', expires_in: 3600 } };
        assert.ok(c.url.endsWith('/v1/notifications/verify-webhook-signature'));
        return { status: 200, data: { verification_status: status } };
    } } });
    return { adaptador, chamadas };
};
const processador = (m, service = { async reconciliarWebhook() {} }, webhookId = 'WEBHOOK-FIXTURE') =>
    criarProcessadorWebhookPayPal({ obterWebhookId: () => webhookId, obterFinanceiro: () => ({ adaptador: m.adaptador, service }) });

test('verificacao oficial preserva JSON original, reutiliza OAuth e aceita apenas SUCCESS', async () => {
    const m = montar(); const bruto = ' { "id" : "WH-FIXTURE", "event_type":"OTHER", "preciso":9007199254740993 } ';
    assert.equal(await m.adaptador.verificarWebhook({ corpo: bruto, cabecalhos, webhookId: 'WEBHOOK-FIXTURE' }), true);
    assert.ok(m.chamadas[1].data.endsWith(',"webhook_event":' + bruto + '}'));
    const p = JSON.parse(m.chamadas[1].data);
    assert.equal(p.transmission_id, cabecalhos['paypal-transmission-id']); assert.equal(p.webhook_id, 'WEBHOOK-FIXTURE');
    assert.equal(p.transmission_sig, cabecalhos['paypal-transmission-sig']); assert.equal(p.auth_algo, 'SHA256withRSA');
    await m.adaptador.verificarWebhook({ corpo: bruto, cabecalhos, webhookId: 'WEBHOOK-FIXTURE' });
    assert.equal(m.chamadas.filter(c => c.url.endsWith('/token')).length, 1);
    assert.equal(await montar({ status: 'FAILURE' }).adaptador.verificarWebhook({ corpo: bruto, cabecalhos, webhookId: 'WEBHOOK-FIXTURE' }), false);
});
test('assinatura invalida nao acessa persistencia e responde 401', async () => {
    const m = montar({ status: 'FAILURE' });
    await assert.rejects(processador(m, { reconciliarWebhook() { assert.fail(); } })({ corpo: corpo(), cabecalhos }), { status: 401 });
});
test('Webhook ID ausente desabilita sem OAuth, banco ou instanciacao financeira', async () => {
    const p = criarProcessadorWebhookPayPal({ obterWebhookId: () => undefined, obterFinanceiro() { assert.fail(); } });
    await assert.rejects(p({ corpo: corpo(), cabecalhos }), { status: 503 });
});
test('evento autenticado desconhecido e ignorado sem reconciliacao', async () => {
    const m = montar(); await processador(m, { reconciliarWebhook() { assert.fail(); } })({ corpo: corpo('OTHER.EVENT'), cabecalhos });
    assert.equal(m.chamadas.length, 2);
});
for (const tipo of ['COMPLETED', 'PENDING', 'DENIED']) test(`evento ${tipo} apenas direciona reconciliacao, sem sessao ou valores do payload`, async () => {
    const m = montar(); const chamadas = [];
    await processador(m, { async reconciliarWebhook(w) { chamadas.push(w); } })({ corpo: corpo(`PAYMENT.CAPTURE.${tipo}`), cabecalhos });
    assert.equal(chamadas.length, 1); const w = chamadas[0];
    assert.deepEqual(Object.keys(w).sort(), ['capturaId', 'eventoId', 'hash', 'ordemId', 'tipo']);
    assert.equal(w.ordemId, 'ORDER123'); assert.equal(w.capturaId, 'CAPTURE123'); assert.equal(w.hash.length, 32);
    assert.equal(m.chamadas.some(c => /\/capture$|\/orders$/.test(c.url)), false);
});
test('falha de consulta ou identificador desconhecido permite reentrega com 503 sem vazar excecao', async () => {
    const m = montar(); let consultas = 0;
    const p = processador(m, { async reconciliarWebhook() { if (++consultas === 1) throw new Error('fixture-secret private@example.invalid'); } });
    await assert.rejects(p({ corpo: corpo(), cabecalhos }), e => e.status === 503 && !/fixture-secret|private@/.test(e.message));
    await p({ corpo: corpo(), cabecalhos }); assert.equal(consultas, 2);
});
test('erro OAuth nao processa webhook e nao expoe credenciais', async () => {
    const m = montar({ oauthErro: true });
    await assert.rejects(processador(m, { reconciliarWebhook() { assert.fail(); } })({ corpo: corpo(), cabecalhos }), e => e.status === 503 && !/fixture|token/.test(e.message));
    assert.equal(m.chamadas.length, 1);
});
test('cabecalhos ausentes e certificado externo sao rejeitados antes de OAuth', async () => {
    for (const headers of [{}, { ...cabecalhos, 'paypal-cert-url': 'https://evil.example/cert' },
        { ...cabecalhos, 'paypal-transmission-sig': ['duplicado', 'duplicado'] }]) {
        const m = montar(); await assert.rejects(processador(m)({ corpo: corpo(), cabecalhos: headers }), { status: 400 });
        assert.equal(m.chamadas.length, 0);
    }
});
test('rota Express recebe bytes originais sem servidor HTTP e sem sessao', async () => {
    const m = montar(); let recebidos = 0;
    const router = criarLojaPaypalWebhookRouter({ obterWebhookId: () => 'WEBHOOK-FIXTURE',
        obterFinanceiro: () => ({ adaptador: m.adaptador, service: { async reconciliarWebhook() { recebidos++; } } }) });
    const bruto = corpo(); const req = Readable.from([bruto]);
    Object.assign(req, { method: 'POST', url: '/', headers: { ...cabecalhos, 'content-type': 'application/json', 'content-length': String(bruto.length) } });
    await new Promise((resolve, reject) => {
        const res = { headersSent: false, set() { return this; }, status(c) { this.codigo = c; return this; },
            end() { try { assert.equal(this.codigo, 204); resolve(); } catch (e) { reject(e); } },
            json(v) { reject(new Error(`Resposta inesperada ${this.codigo}: ${JSON.stringify(v)}`)); } };
        router.handle(req, res, reject);
    });
    assert.equal(recebidos, 1);
});
