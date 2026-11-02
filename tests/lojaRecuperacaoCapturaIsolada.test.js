import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { criarPersistenciaPagamento } from '../src/services/lojaPagamentoPersistencia.js';
import { executarRecuperacaoCapturaIsolada } from '../scripts/loja-recuperacao-captura-isolada.mjs';

const contexto = { provedor: 'paypal', ambiente: 'sandbox', contaRecebedora: 'QYR5Z8XDVJNXQ' };
const ambiente = { NODE_ENV: 'production', DB_HOST: '127.0.0.1', DB_PORT: '3307', DB_NAME: 'istbrasil_homolog',
    LOJA_AMBIENTE: 'sandbox', IST_LOJA_PAYPAL_ENV: 'sandbox', IST_LOJA_RECUPERACAO_ATIVA: 'false',
    IST_LOJA_PAYPAL_CLIENT_ID: 'fixture-client', IST_LOJA_PAYPAL_CLIENT_SECRET: 'fixture-secret',
    IST_LOJA_PAYPAL_CONTA_RECEBEDORA: contexto.contaRecebedora };

test('filtros de pedido e captura expirada nunca enviada precedem ordenacao e LIMIT', async () => {
    const pedidoPublicId = randomUUID(), consultas = []; let liberada = 0;
    const db = { async getConnection() { return {
        async query(sql, params) { consultas.push({ sql, params }); return [[{
            pagamentoId: 3, pedidoId: 4, sessaoId: 5, pedidoPublicId, operacaoId: 6
        }]]; }, release() { liberada++; }
    }; } };
    const persistencia = criarPersistenciaPagamento({ db, agora: () => new Date('2026-11-02T12:00:00.000Z') });
    assert.equal((await persistencia.candidatosRecuperacao(contexto, 1, pedidoPublicId))[0].pedidoPublicId, pedidoPublicId);
    const filtrada = consultas[0];
    const filtro = 'AND (? IS NULL OR d.public_id=?)';
    const expirada = "AND NOT (o.acao='CAPTURAR' AND o.envio_iniciado_em IS NULL AND d.expira_em<=?)";
    assert(filtrada.sql.includes(filtro));
    assert(filtrada.sql.includes(expirada));
    for (const condicao of [filtro, expirada]) {
        assert(filtrada.sql.indexOf(condicao) < filtrada.sql.indexOf('ORDER BY'));
        assert(filtrada.sql.indexOf(condicao) < filtrada.sql.indexOf('LIMIT ?'));
    }
    const instante = '2026-11-02 12:00:00.000';
    assert.deepEqual(filtrada.params, [contexto.provedor, contexto.ambiente,
        contexto.contaRecebedora, pedidoPublicId, pedidoPublicId, instante, instante, instante, 1]);
    await persistencia.candidatosRecuperacao(contexto, 10);
    assert.deepEqual(consultas[1].params.slice(3, 5), [null, null]);
    assert.deepEqual(consultas[1].params.slice(5, 8), [instante, instante, instante]);
    assert.equal(consultas[1].params.at(-1), 10);
    assert.equal(liberada, 2);
});

test('executor isolado exige homologacao Sandbox, flag global false e confirmacao explicita', async () => {
    let carregamentos = 0;
    const saida = [];
    const codigo = await executarRecuperacaoCapturaIsolada({ argv: ['--pedido', randomUUID()], env: ambiente,
        carregar: async () => { carregamentos++; }, saida: linha => saida.push(linha) });
    assert.equal(codigo, 1); assert.equal(carregamentos, 0);
    assert.deepEqual(JSON.parse(saida[0]), { pedidoPublicId: null, selecionados: 0,
        estado: 'FALHA', codigo: 'SOLICITACAO_INVALIDA' });
    for (const alteracao of [{ IST_LOJA_PAYPAL_ENV: 'live' }, { IST_LOJA_RECUPERACAO_ATIVA: 'true' },
        { DB_NAME: 'istbrasil' }, { DB_PORT: '3306' }]) {
        const linhas = [];
        const retorno = await executarRecuperacaoCapturaIsolada({
            argv: ['--autorizar-recuperacao-sandbox', '--pedido', randomUUID()], env: { ...ambiente, ...alteracao },
            carregar: async () => { carregamentos++; }, saida: linha => linhas.push(linha)
        });
        assert.equal(retorno, 1); assert.equal(JSON.parse(linhas[0]).codigo, 'CONFIGURACAO_INVALIDA');
    }
    assert.equal(carregamentos, 0);
});

test('executor isolado faz uma passagem limitada ao pedido e encerra seu pool', async () => {
    const pedidoPublicId = randomUUID(), chamadas = [], linhas = []; let encerramentos = 0;
    const pool = { getConnection() {}, async end() { encerramentos++; } };
    const carregar = async () => ({ pool, comporFinanceiroLoja({ db, env }) {
        assert.strictEqual(db, pool); assert.strictEqual(env, ambiente);
        return { service: { async recuperarPendencias(opcoes) {
            chamadas.push(opcoes); return [{ resultado: { estado: 'CAPTURADO' } }];
        } } };
    } });
    const codigo = await executarRecuperacaoCapturaIsolada({
        argv: ['--autorizar-recuperacao-sandbox', '--pedido', pedidoPublicId], env: ambiente,
        carregar, saida: linha => linhas.push(linha)
    });
    assert.equal(codigo, 0); assert.deepEqual(chamadas, [{ limite: 1, pedidoPublicId }]);
    assert.equal(encerramentos, 1);
    assert.deepEqual(JSON.parse(linhas[0]), { pedidoPublicId, selecionados: 1,
        estado: 'CAPTURADO', codigo: null, intervencao: null });
});

test('executor isolado nao repete nem vaza excecao quando o resultado nao conclui captura', async () => {
    const pedidoPublicId = randomUUID(), linhas = []; let chamadas = 0, encerramentos = 0;
    const retorno = await executarRecuperacaoCapturaIsolada({
        argv: ['--autorizar-recuperacao-sandbox', '--pedido', pedidoPublicId], env: ambiente,
        carregar: async () => ({ pool: { getConnection() {}, async end() { encerramentos++; } },
            comporFinanceiroLoja: () => ({ service: { async recuperarPendencias() {
                chamadas++; throw new Error('fixture-secret comprador@example.invalid');
            } } }) }), saida: linha => linhas.push(linha)
    });
    assert.equal(retorno, 1); assert.equal(chamadas, 1); assert.equal(encerramentos, 1);
    assert.equal(JSON.parse(linhas[0]).codigo, 'FALHA_INTERNA');
    assert.doesNotMatch(linhas.join(), /fixture-secret|comprador@example.invalid/);
});
