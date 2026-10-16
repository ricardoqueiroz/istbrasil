import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { executarHomologacaoPaypal } from '../scripts/loja-paypal-sandbox-manual.mjs';

const env = { IST_LOJA_PAYPAL_ENV: 'sandbox', IST_LOJA_PAYPAL_CLIENT_ID: 'fixture-client', IST_LOJA_PAYPAL_CLIENT_SECRET: 'fixture-secret' };
const argv = () => ['--executar-sandbox', '--recebedor', 'QYR5Z8XDVJNXQ', '--referencia', randomUUID(), '--request-id', randomUUID()];
const proibido = { request() { assert.fail('nao deveria executar HTTP'); } };
const rodar = async opcoes => {
    const linhas = []; const codigo = await executarHomologacaoPaypal({ argv: argv(), env, http: proibido,
        ...opcoes, saida: linha => linhas.push(linha) });
    return { codigo, linhas, dados: linhas.map(JSON.parse) };
};
test('exige comando explicito e argumentos completos antes de qualquer chamada', async () => {
    for (const entrada of [[], ['--executar-sandbox'], argv().slice(1), [...argv(), '--capturar'],
        argv().map(v => v === '--recebedor' ? '--client-secret' : v)]) {
        assert.equal((await rodar({ argv: entrada })).codigo, 1);
    }
});
test('Live, producao e credenciais ausentes falham antes de HTTP', async () => {
    for (const config of [{}, { ...env, IST_LOJA_PAYPAL_ENV: 'live' }, { ...env, IST_LOJA_PAYPAL_ENV: 'production' },
        { ...env, IST_LOJA_PAYPAL_CLIENT_ID: '' }, { ...env, IST_LOJA_PAYPAL_CLIENT_SECRET: '' },
        { IST_LOJA_PAYPAL_ENV: 'sandbox', PAYPAL_CLIENT_ID: 'legado', PAYPAL_CLIENT_SECRET: 'legado' }]) {
        const r = await rodar({ env: config }); assert.equal(r.codigo, 1);
        assert.equal(r.dados[0].codigo, 'CONFIGURACAO_INVALIDA');
    }
});
test('usa adaptador para OAuth, uma criacao BRL 1,00 e uma consulta, sem captura', async () => {
    const entrada = argv(); const chamadas = []; let recurso;
    const http = { async request(c) {
        chamadas.push(c); assert.equal(new URL(c.url).origin, 'https://api-m.sandbox.paypal.com');
        if (c.url.endsWith('/token')) return { status: 200, data: { token_type: 'Bearer', access_token: 'fixture-token', expires_in: 3600 } };
        assert.equal(c.url.includes('/capture'), false);
        if (c.method === 'POST') {
            assert.deepEqual(c.data.purchase_units[0].amount, { value: '1.00', currency_code: 'BRL' });
            assert.equal(c.headers['PayPal-Request-Id'], entrada[6]); assert.equal(c.data.purchase_units[0].reference_id, entrada[4]);
            recurso = { id: 'ISTMANUAL123', status: 'CREATED', intent: 'CAPTURE', purchase_units: c.data.purchase_units,
                payer: { email_address: 'private@example.invalid' }, access_token: 'fixture-token' };
            return { status: 201, data: recurso };
        }
        assert.equal(c.url.endsWith('/orders/ISTMANUAL123'), true); return { status: 200, data: recurso };
    } };
    const r = await rodar({ argv: entrada, http }); assert.equal(r.codigo, 0); assert.equal(chamadas.length, 3);
    assert.deepEqual(r.dados.map(d => d.estado), ['VALIDA', 'AGUARDANDO_APROVACAO', 'AGUARDANDO_APROVACAO']);
    for (const segredo of ['fixture-token', 'fixture-secret', 'fixture-client', 'private@example.invalid', 'Authorization', 'payer']) {
        assert.equal(r.linhas.join('\n').includes(segredo), false);
    }
});
test('erro externo e sanitizado, sem retry, stack ou resposta integral', async () => {
    let chamadas = 0;
    const r = await rodar({ http: { async request() {
        chamadas++; throw Object.assign(new Error('fixture-secret fixture-token'), { response: { data: { access_token: 'fixture-token' } } });
    } } });
    assert.equal(r.codigo, 1); assert.equal(chamadas, 1);
    assert.equal(r.linhas.join().includes('fixture-'), false); assert.equal(r.linhas.join().includes('stack'), false);
});
test('representacao parcial nao e declarada homologada e nao provoca nova criacao', async () => {
    let chamadas = 0;
    const r = await rodar({ http: { async request(c) {
        chamadas++;
        return c.url.endsWith('/token') ? { status: 200, data: { token_type: 'Bearer', access_token: 'fixture-token', expires_in: 3600 } }
            : { status: 200, data: { id: 'ISTPARCIAL123', status: 'CREATED' } };
    } } });
    assert.equal(r.codigo, 1); assert.equal(chamadas, 3); assert.equal(r.dados.at(-1).estado, 'DESCONHECIDO');
});
test('entrada CLI sem argumentos falha com seguranca, sem usar credenciais herdadas', () => {
    const r = spawnSync(process.execPath, ['scripts/loja-paypal-sandbox-manual.mjs'], { encoding: 'utf8', windowsHide: true,
        env: { ...process.env, IST_LOJA_PAYPAL_ENV: 'live', IST_LOJA_PAYPAL_CLIENT_ID: '', IST_LOJA_PAYPAL_CLIENT_SECRET: '' } });
    assert.equal(r.status, 1); assert.equal(JSON.parse(r.stdout).estado, 'FALHA'); assert.equal(r.stderr, '');
});
test('script nao contem credenciais embutidas nem acesso independente a HTTP, banco ou env legado', async () => {
    const fonte = await readFile(new URL('../scripts/loja-paypal-sandbox-manual.mjs', import.meta.url), 'utf8');
    assert.doesNotMatch(fonte, /fixture-secret|fixture-token|axios|fetch\(|mysql|dotenv|PAYPAL_SECRET|\.capturar\(/);
    assert.doesNotMatch(fonte, /IST_LOJA_PAYPAL_CLIENT_(?:SECRET|ID)\s*[:=]\s*['"][^'"]+/);
});
