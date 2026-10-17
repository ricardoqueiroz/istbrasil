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

// Os codigos sao diagnosticos; nao alteram a precedencia das classificacoes.
for (const [nome, origem, permitida, canonica, porta] of [
    ['Sandbox', 'https://api-m.sandbox.paypal.com', true, true, null],
    ['alternativa', 'https://api.sandbox.paypal.com', false, false, null],
    ['Live', 'https://api-m.paypal.com', false, false, null],
    ['externa', 'https://evil.example', false, false, null],
    ['porta padrao explicita', 'https://api-m.sandbox.paypal.com:443', true, false, null],
    ['porta alternativa', 'https://api-m.sandbox.paypal.com:8443', false, false, '8443']
]) test(`diagnostico da origem ${nome} sem alterar aceitacao`, async () => {
    const d = recurso(); d.links = [{ rel: 'up', method: 'GET', href: `${origem}/v2/checkout/orders/${ORDEM}` }];
    const m = montar({ status: 200, data: d }); const r = await rodar(m);
    const [diag] = r.resultado.diagnosticosLinksUp;
    assert.deepEqual(diag, { indice: 0, metodo: 'GET', protocolo: 'https:', hostname: new URL(origem).hostname,
        porta, tipoRecurso: 'ORDEM', possuiCredenciais: false, possuiQuery: false, possuiFragmento: false,
        origemPermitida: permitida, representacaoCanonica: canonica,
        codigos: [...(!permitida ? ['UP_ORIGEM_NAO_PERMITIDA'] : []), ...(!canonica ? ['UP_URL_NAO_CANONICA'] : [])] });
    assert.equal(r.resultado.associacaoOrdem, canonica ? 'CONFIRMADA' : 'INVALIDA');
    assert.equal(r.resultado.validacao, canonica ? 'CONSISTENTE' : 'INCONCLUSIVA');
    assert.equal(m.chamadas.length, 2);
});

test('diagnosticos incluem apenas up, preservam indices e omitem IDs e conteudos secretos', async () => {
    const d = recurso('PENDING');
    d.links = [{ rel: 'self', href: 'fixture-secret' },
        { rel: 'up', method: 'GET', href: 'https://user:fixture-secret@api-m.sandbox.paypal.com/v2/payments/authorizations/AUTHSECRET123?token=fixture-token#private@example.invalid' },
        { rel: 'up', method: 'GET', href: `https://api-m.sandbox.paypal.com/v2/checkout/orders/${ORDEM}` },
        { rel: 'refund', method: 'POST', href: 'fixture-secret' }];
    const m = montar({ status: 200, data: d }); const r = await rodar(m);
    const [a, b] = r.resultado.diagnosticosLinksUp;
    assert.deepEqual(r.resultado.diagnosticosLinksUp.map(v => v.indice), [1, 2]);
    assert.equal(a.tipoRecurso, 'AUTORIZACAO');
    assert.equal(a.possuiCredenciais, true); assert.equal(a.possuiQuery, true); assert.equal(a.possuiFragmento, true);
    assert.equal(a.origemPermitida, true); assert.equal(a.representacaoCanonica, false);
    assert.deepEqual(a.codigos, ['UP_CREDENCIAIS_PROIBIDAS', 'UP_FRAGMENTO_PROIBIDO', 'UP_QUERY_PROIBIDA', 'UP_URL_NAO_CANONICA']);
    assert.deepEqual(b.codigos, []); assert.equal(b.representacaoCanonica, true);
    const json = JSON.stringify(r.resultado.diagnosticosLinksUp);
    for (const secreto of [ORDEM, ID, 'AUTHSECRET123', 'fixture-secret', 'fixture-token', 'private@example.invalid', '/v2/', 'https://']) {
        assert.equal(json.includes(secreto), false);
    }
    assert.deepEqual(r.resultado.ordensRelacionadas, [ORDEM]);
    assert.equal(r.resultado.statusFinanceiro, 'PENDING'); assert.equal(r.resultado.associacaoOrdem, 'INVALIDA');
    assert.equal(m.chamadas.length, 2);
});

for (const href of ['not-a-url', {}, null]) test(`URL inesperada ${typeof href} recebe diagnostico generico`, async () => {
    const d = recurso(); d.links = [{ rel: 'up', method: 'fixture-secret', href }];
    const r = await rodar(montar({ status: 200, data: d })); const [diag] = r.resultado.diagnosticosLinksUp;
    assert.equal(diag.metodo, 'INVALIDO'); assert.equal(diag.protocolo, 'INVALIDO');
    assert.equal(diag.hostname, null); assert.equal(diag.porta, null); assert.equal(diag.tipoRecurso, 'DESCONHECIDO');
    assert.equal(diag.origemPermitida, false); assert.equal(diag.representacaoCanonica, false);
    assert.equal(r.resultado.associacaoOrdem, 'INVALIDA');
    assert.equal(JSON.stringify(diag).includes('fixture-secret'), false);
});

test('hostname excessivo e protocolo inesperado nao sao refletidos arbitrariamente', async () => {
    const d = recurso(); d.links = [{ rel: 'up', method: 'GET', href: `https://${'a'.repeat(254)}.example/v2/checkout/orders/${ORDEM}` },
        { rel: 'up', method: 'GET', href: `customsecret://evil.example/v2/checkout/orders/${ORDEM}` }];
    const r = await rodar(montar({ status: 200, data: d }));
    assert.equal(r.resultado.diagnosticosLinksUp[0].hostname, null);
    assert.equal(r.resultado.diagnosticosLinksUp[1].protocolo, 'DESCONHECIDO');
    assert.equal(JSON.stringify(r.resultado.diagnosticosLinksUp).includes('customsecret'), false);
    assert.equal(r.resultado.associacaoOrdem, 'INVALIDA');
});

test('ausencia de links produz colecao vazia sem mudar a associacao', async () => {
    for (const links of [undefined, [], [{ rel: 'self', href: 'fixture-secret' }]]) {
        const d = recurso(); d.links = links;
        const r = await rodar(montar({ status: 200, data: d }));
        assert.deepEqual(r.resultado.diagnosticosLinksUp, []); assert.equal(r.resultado.associacaoOrdem, 'CONFIRMADA');
    }
});

for (const [codigo, alterar] of [
    ['SUPPLEMENTARY_DATA_INVALIDO', d => { d.supplementary_data = []; }],
    ['RELATED_IDS_INVALIDO', d => { d.supplementary_data.related_ids = []; }],
    ['ORDEM_RELACIONADA_ID_INVALIDO', d => { d.supplementary_data.related_ids.order_id = 'bad-id'; }],
    ['LINKS_ESTRUTURA_INVALIDA', d => { d.links = {}; }],
    ['UP_METODO_INVALIDO', (d, l) => { l.method = 'POST'; }],
    ['UP_HREF_TIPO_INVALIDO', (d, l) => { l.href = {}; }],
    ['UP_URL_LIMITE_EXCEDIDO', (d, l) => { l.href += 'A'.repeat(2048); }],
    ['UP_URL_ESPACOS', (d, l) => { l.href += ' '; }],
    ['UP_URL_INVALIDA', (d, l) => { l.href = 'not-a-url'; }],
    ['UP_ORIGEM_NAO_PERMITIDA', (d, l) => { l.href = l.href.replace('api-m.sandbox.paypal.com', 'evil.example'); }],
    ['UP_CREDENCIAIS_PROIBIDAS', (d, l) => { l.href = l.href.replace('https://', 'https://user:fixture-secret@'); }],
    ['UP_QUERY_PROIBIDA', (d, l) => { l.href += '?fixture-secret=1'; }],
    ['UP_FRAGMENTO_PROIBIDO', (d, l) => { l.href += '#fixture-secret'; }],
    ['UP_RECURSO_ID_INVALIDO', (d, l) => { l.href = l.href.replace(ORDEM, 'bad-id'); }],
    ['UP_CAMINHO_NAO_RECONHECIDO', (d, l) => { l.href = l.href.replace('/checkout/orders/', '/payments/captures/'); }],
    ['UP_URL_NAO_CANONICA', (d, l) => { l.href = l.href.replace('/v2/', '/extra/../v2/'); }]
]) test(`motivo estruturado ${codigo}`, async () => {
    const d = recurso(); const l = { rel: 'up', method: 'GET', href: `https://api-m.sandbox.paypal.com/v2/checkout/orders/${ORDEM}` };
    d.links = [l]; alterar(d, l);
    const r = await rodar(montar({ status: 200, data: d }));
    assert.equal(r.resultado.associacaoOrdem, 'INVALIDA');
    assert.equal(r.resultado.validacao, 'INCONCLUSIVA');
    assert.ok(r.resultado.motivosAssociacaoInvalida.includes(codigo));
    assert.equal(r.linhas.join().includes('fixture-secret'), false);
    assert.equal(r.linhas.join().includes('https://'), false);
});

test('multiplos motivos ordenados, sem duplicacao, preservam INVALIDA com ordem correta', async () => {
    const d = recurso();
    const l = { rel: 'up', method: 'POST', href: 'https://user:secret@evil.example/v2/checkout/orders/BAD?private=1#private' };
    d.links = [l, { ...l }];
    const r = await rodar(montar({ status: 200, data: d }));
    assert.deepEqual(r.resultado.motivosAssociacaoInvalida, [
        'UP_CREDENCIAIS_PROIBIDAS', 'UP_FRAGMENTO_PROIBIDO', 'UP_METODO_INVALIDO',
        'UP_ORIGEM_NAO_PERMITIDA', 'UP_QUERY_PROIBIDA', 'UP_URL_NAO_CANONICA'
    ]);
    assert.equal(r.resultado.associacaoOrdem, 'INVALIDA');
    assert.deepEqual(r.resultado.ordensRelacionadas, [ORDEM]);
});

for (const [nome, detalhes, estado, motivo] of [
    ['presente', { reason: 'PENDING_REVIEW' }, 'INFORMADO', 'PENDING_REVIEW'],
    ['ausente', undefined, 'AUSENTE', null],
    ['sem reason', {}, 'AUSENTE', null],
    ['nulo', { reason: null }, 'AUSENTE', null],
    ['vazio', { reason: '' }, 'INVALIDO', null],
    ['objeto', { reason: { secret: 'fixture-secret' } }, 'INVALIDO', null],
    ['estrutura inesperada', [], 'INVALIDO', null],
    ['texto arbitrario', { reason: 'private@example.invalid fixture-secret' }, 'INVALIDO', null],
    ['desconhecido', { reason: 'PRIVATE_SECRET' }, 'NAO_RECONHECIDO', null],
    ['limite', { reason: 'A'.repeat(129) }, 'INVALIDO', null]
]) test(`motivo de pendencia ${nome} sem alterar classificacao financeira`, async () => {
    for (const status of ['PENDING', 'COMPLETED']) {
        const d = recurso(status); d.status_details = detalhes;
        const r = await rodar(montar({ status: 200, data: d }));
        assert.equal(r.resultado.estadoMotivoPendencia, estado);
        assert.equal(r.resultado.motivoPendencia, motivo);
        assert.equal(r.resultado.statusFinanceiro, status);
        assert.equal(r.resultado.validacao, 'CONSISTENTE');
        assert.deepEqual(r.resultado.motivosAssociacaoInvalida, []);
        for (const segredo of ['fixture-secret', 'private@example.invalid', 'PRIVATE_SECRET']) assert.equal(r.linhas.join().includes(segredo), false);
    }
});

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
        assert.equal(r.resultado.associacaoOrdem, href.includes('evil.example') ? 'INVALIDA' : 'DIVERGENTE');
        assert.equal(r.linhas.join().includes(href), false);
    }
});
const AUTORIZACAO = '0T620041CK889853A';
const upAutorizacao = () => ({ rel: 'up', method: 'GET', href: `https://api-m.sandbox.paypal.com/v2/payments/authorizations/${AUTORIZACAO}` });
const upOrdem = (id = ORDEM) => ({ rel: 'up', method: 'GET', href: `https://api-m.sandbox.paypal.com/v2/checkout/orders/${id}` });

for (const status of ['PENDING', 'COMPLETED']) test(`ordem correta com autorizacao pai e CONFIRMADA; status ${status} preservado`, async () => {
    const d = recurso(status); d.supplementary_data.related_ids.authorization_id = AUTORIZACAO;
    d.links = [{ rel: 'self', method: 'GET', href: `https://api-m.sandbox.paypal.com/v2/payments/captures/${ID}` },
        { rel: 'refund', method: 'POST', href: `https://api-m.sandbox.paypal.com/v2/payments/captures/${ID}/refund` }, upAutorizacao()];
    const m = montar({ status: 200, data: d }); const r = await rodar(m);
    assert.equal(r.resultado.associacaoOrdem, 'CONFIRMADA'); assert.equal(r.resultado.validacao, 'CONSISTENTE');
    assert.equal(r.resultado.statusFinanceiro, status); assert.equal(r.codigo, 0);
    assert.deepEqual(r.resultado.ordensRelacionadas, [ORDEM]); assert.equal(m.chamadas.length, 2);
});
test('apenas up para autorizacao nao demonstra identidade da ordem', async () => {
    const d = recurso(); delete d.supplementary_data; d.links = [upAutorizacao()];
    const r = await rodar(montar({ status: 200, data: d }));
    assert.equal(r.resultado.associacaoOrdem, 'NAO_DEMONSTRADA'); assert.deepEqual(r.resultado.ordensRelacionadas, []);
    assert.deepEqual(r.resultado.motivosAssociacaoInvalida, []);
    assert.equal(r.codigo, 1); assert.equal(r.resultado.limitacaoAssociacao, 'API_NAO_INFORMOU_ORDEM_RELACIONADA');
});
test('ordem diferente com autorizacao valida continua DIVERGENTE', async () => {
    const d = recurso(); d.supplementary_data.related_ids.order_id = 'OTHERORDER'; d.links = [upAutorizacao()];
    const r = await rodar(montar({ status: 200, data: d }));
    assert.equal(r.resultado.associacaoOrdem, 'DIVERGENTE'); assert.equal(r.resultado.validacao, 'DIVERGENTE'); assert.equal(r.codigo, 1);
});
test('links simultaneos de ordem e autorizacao so acrescentam IDs de ordens', async () => {
    const d = recurso(); delete d.supplementary_data; d.links = [upAutorizacao(), upOrdem()];
    const m = montar({ status: 200, data: d }); const r = await rodar(m);
    assert.equal(r.resultado.associacaoOrdem, 'CONFIRMADA'); assert.deepEqual(r.resultado.ordensRelacionadas, [ORDEM]);
    assert.equal(m.chamadas.length, 2); // Os links nao sao seguidos.
});
test('ordens contraditorias nao sao ignoradas pela presenca de autorizacao valida', async () => {
    const d = recurso(); d.links = [upOrdem('OTHERORDER'), upAutorizacao(), upOrdem()];
    const r = await rodar(montar({ status: 200, data: d }));
    assert.equal(r.resultado.associacaoOrdem, 'DIVERGENTE'); assert.deepEqual(r.resultado.ordensRelacionadas, [ORDEM, 'OTHERORDER']);
    assert.deepEqual(r.resultado.motivosAssociacaoInvalida, []);
    assert.equal(r.codigo, 1);
});
for (const [caso, alterar] of [
    ['ID malformado', l => { l.href = l.href.replace(AUTORIZACAO, 'invalido-123'); }],
    ['ID ausente', l => { l.href = l.href.replace(AUTORIZACAO, ''); }],
    ['host externo', l => { l.href = l.href.replace('api-m.sandbox.paypal.com', 'evil.example'); }],
    ['host ambiguo', l => { l.href = l.href.replace('api-m.sandbox.paypal.com', 'api-m.sandbox.paypal.com.evil.example'); }],
    ['Live', l => { l.href = l.href.replace('api-m.sandbox.paypal.com', 'api-m.paypal.com'); }],
    ['HTTP', l => { l.href = l.href.replace('https:', 'http:'); }],
    ['query string', l => { l.href += '?extra=1'; }],
    ['fragmento', l => { l.href += '#extra'; }],
    ['credenciais', l => { l.href = l.href.replace('https://', 'https://user:secret@'); }],
    ['metodo POST', l => { l.method = 'POST'; }],
    ['metodo ausente', l => { delete l.method; }],
    ['href nao textual', l => { l.href = {}; }],
    ['URL longa', l => { l.href += 'A'.repeat(2048); }],
    ['porta alternativa', l => { l.href = l.href.replace('.com/', '.com:8443/'); }],
    ['normalizacao ambigua', l => { l.href = l.href.replace('/v2/', '/nao-oficial/../v2/'); }],
    ['ID codificado', l => { l.href = l.href.replace(AUTORIZACAO, '%30T620041CK889853A'); }]
]) test(`up de autorizacao inseguro ou malformado: ${caso}`, async () => {
    const d = recurso(); const l = upAutorizacao(); alterar(l); d.links = [l];
    const m = montar({ status: 200, data: d }); const r = await rodar(m);
    assert.equal(r.resultado.associacaoOrdem, 'INVALIDA'); assert.equal(r.resultado.validacao, 'INCONCLUSIVA');
    assert.deepEqual(r.resultado.ordensRelacionadas, [ORDEM]); assert.equal(r.codigo, 1); assert.equal(m.chamadas.length, 2);
});
test('estrutura links invalida nao confirma nem demonstra associacao ausente', async () => {
    for (const links of [{}, 'nao e array']) {
        const d = recurso(); d.links = links;
        const r = await rodar(montar({ status: 200, data: d }));
        assert.equal(r.resultado.associacaoOrdem, 'INVALIDA'); assert.equal(r.codigo, 1);
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
