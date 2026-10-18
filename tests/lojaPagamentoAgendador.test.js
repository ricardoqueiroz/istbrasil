import test from 'node:test';
import assert from 'node:assert/strict';
import { iniciarRecuperacaoLoja } from '../src/services/lojaPagamentoAgendador.js';

const ambiente = { IST_LOJA_RECUPERACAO_ATIVA: 'true', IST_LOJA_PAYPAL_ENV: 'sandbox',
    IST_LOJA_PAYPAL_CONTA_RECEBEDORA: 'QYR5Z8XDVJNXQ',
    IST_LOJA_PAYPAL_CLIENT_ID: 'fixture-client', IST_LOJA_PAYPAL_CLIENT_SECRET: 'fixture-secret' };
const flush = () => new Promise(resolve => setImmediate(resolve));
const montar = (extras = {}) => {
    const chamadas = [], logs = []; let tick, intervalo, cancelamentos = 0, unrefs = 0;
    const db = { getConnection() { assert.fail('Banco proibido neste teste'); }, end() { assert.fail('Pool compartilhado nao deve ser fechado'); } };
    const adaptador = {};
    const controle = iniciarRecuperacaoLoja({ db, env: { ...ambiente },
        criarAdaptador(opcoes) { chamadas.push(['adaptador', opcoes]); return adaptador; },
        criarServico(opcoes) { chamadas.push(['servico', opcoes]); return { async recuperarPendencias(args) { chamadas.push(['ciclo', args]); return []; } }; },
        agendar(fn, ms) { tick = fn; intervalo = ms; return { unref() { unrefs++; } }; },
        cancelar() { cancelamentos++; }, registrar(mensagem) { logs.push(mensagem); }, ...extras });
    return { controle, chamadas, logs, db, adaptador, tick: () => tick?.(),
        get intervalo() { return intervalo; }, get cancelamentos() { return cancelamentos; }, get unrefs() { return unrefs; } };
};

test('desativado por padrao e valores diferentes de true nao instanciam nem agendam', async () => {
    for (const valor of [undefined, '', 'false', 'TRUE', '1', true]) {
        const m = montar({ env: { ...ambiente, IST_LOJA_RECUPERACAO_ATIVA: valor } });
        assert.equal(m.controle.ativo, false); assert.deepEqual(m.chamadas, []);
        assert.equal(m.intervalo, undefined); await m.controle.parar(); assert.equal(m.cancelamentos, 0);
    }
});
test('NODE_ENV=test impede ativacao automatica mesmo com flag true', () => {
    const m = montar({ env: { ...ambiente, NODE_ENV: 'test' } });
    assert.equal(m.controle.ativo, false); assert.deepEqual(m.chamadas, []);
});
test('compoe uma instancia com pool e contexto confiaveis e agenda sem execucao imediata', async () => {
    const m = montar(); assert.equal(m.controle.ativo, true);
    assert.equal(m.intervalo, 60000); assert.equal(m.unrefs, 1);
    assert.equal(m.chamadas.length, 2);
    assert.strictEqual(m.chamadas[1][1].db, m.db); assert.strictEqual(m.chamadas[1][1].adaptador, m.adaptador);
    assert.deepEqual(m.chamadas[1][1].contexto, { provedor: 'paypal', ambiente: 'sandbox', contaRecebedora: ambiente.IST_LOJA_PAYPAL_CONTA_RECEBEDORA });
    m.tick(); await flush(); m.tick(); await flush();
    assert.deepEqual(m.chamadas.filter(c => c[0] === 'ciclo'), [['ciclo', { limite: 10 }], ['ciclo', { limite: 10 }]]);
    await m.controle.parar(); assert.equal(m.cancelamentos, 1);
});
test('impede sobreposicao e encerramento aguarda ciclo sem permitir novos disparos', async () => {
    let liberar, execucoes = 0;
    const espera = new Promise(resolve => { liberar = resolve; });
    const m = montar({ criarServico: () => ({ async recuperarPendencias() { execucoes++; await espera; return []; } }) });
    m.tick(); await flush(); m.tick(); await flush(); assert.equal(execucoes, 1);
    let parou = false; const fim = m.controle.parar().then(() => { parou = true; });
    await flush(); assert.equal(parou, false); assert.equal(m.cancelamentos, 1);
    m.tick(); liberar(); await fim; m.tick(); await flush();
    assert.equal(execucoes, 1); await m.controle.parar(); assert.equal(m.cancelamentos, 1);
});
test('excecoes sincronas e assincronas sao sanitizadas e nao impedem proximo ciclo', async () => {
    let chamadas = 0;
    const m = montar({ criarServico: () => ({ recuperarPendencias() {
        chamadas++;
        if (chamadas === 1) throw new Error('fixture-secret Authorization private@example.invalid');
        if (chamadas === 2) return Promise.reject(new Error('fixture-secret'));
        return Promise.resolve([{ erro: 'RESULTADO_DESCONHECIDO' }]);
    } }) });
    for (let i = 0; i < 3; i++) { m.tick(); await flush(); }
    assert.equal(chamadas, 3); assert.equal(m.logs.length, 3);
    assert.doesNotMatch(m.logs.join(), /fixture-secret|Authorization|private@example.invalid/);
    await m.controle.parar();
});
test('configuracao ausente divergente ou Live mantem agendador desativado', () => {
    for (const extra of [{ IST_LOJA_PAYPAL_ENV: undefined }, { IST_LOJA_PAYPAL_ENV: 'live' },
        { LOJA_AMBIENTE: 'live' }, { IST_LOJA_PAYPAL_CONTA_RECEBEDORA: undefined },
        { IST_LOJA_PAYPAL_CONTA_RECEBEDORA: 'invalido' }]) {
        const m = montar({ env: { ...ambiente, ...extra } });
        assert.equal(m.controle.ativo, false); assert.equal(m.intervalo, undefined);
        assert.deepEqual(m.chamadas, []); assert.equal(m.logs.length, 1);
    }
});
test('credenciais ausentes sao rejeitadas pela fabrica real sem banco ou HTTP', () => {
    for (const chave of ['IST_LOJA_PAYPAL_CLIENT_ID', 'IST_LOJA_PAYPAL_CLIENT_SECRET']) {
        const logs = [];
        const m = iniciarRecuperacaoLoja({ env: { ...ambiente, [chave]: undefined },
            db: { getConnection() { assert.fail(); } },
            criarServico() { assert.fail('Servico nao deve ser criado'); },
            agendar() { assert.fail('Timer nao deve ser criado'); }, registrar: s => logs.push(s) });
        assert.equal(m.ativo, false); assert.equal(logs.length, 1); assert.doesNotMatch(logs[0], /fixture-secret/);
    }
});
test('falha de composicao ou agendamento nao propaga nem vaza erro', () => {
    for (const extra of [{ criarServico() { throw new Error('fixture-secret'); } },
        { agendar() { throw new Error('fixture-secret'); } }]) {
        const m = montar(extra); assert.equal(m.controle.ativo, false);
        assert.equal(m.logs.length, 1); assert.doesNotMatch(m.logs[0], /fixture-secret/);
    }
});
