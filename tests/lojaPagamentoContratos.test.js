import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { camposExatos, centavosPagamento, erroPagamentoPublico, hashPagamento, normalizarResultadoPagamento,
    criarFalhaPagamento, classificarFalhaPagamento, TRANSICOES_PAGAMENTO, validarTransicaoPagamento } from '../src/services/lojaPagamentoContratos.js';
import { criarLojaPagamentoService } from '../src/services/lojaPagamentoService.js';

test('contratos rejeitam autoridade financeira e getters no payload', () => {
    const pedidoPublicId = randomUUID();
    assert.deepEqual(camposExatos({ pedidoPublicId }, ['pedidoPublicId']), { pedidoPublicId });
    assert.throws(() => camposExatos({ pedidoPublicId, preco: 1 }, ['pedidoPublicId']));
    assert.throws(() => camposExatos(Object.defineProperty({}, 'pedidoPublicId', { enumerable: true, get() { throw new Error('nao acessar'); } }), ['pedidoPublicId']), { codigo: 'SOLICITACAO_INVALIDA' });
});
test('centavos exatos ate BIGINT UNSIGNED; rejeita fracao, float inseguro e overflow', () => {
    assert.equal(centavosPagamento('18446744073709551615'), '18446744073709551615');
    assert.equal(centavosPagamento(19000), '19000');
    for (const valor of ['1.00', -1, 1.1, Number.MAX_SAFE_INTEGER + 1, '18446744073709551616']) assert.throws(() => centavosPagamento(valor));
});
test('hash e deterministico e distingue o contexto financeiro', () => {
    assert.deepEqual(hashPagamento({ acao: 'CRIAR', ambiente: 'sandbox' }), hashPagamento({ acao: 'CRIAR', ambiente: 'sandbox' }));
    assert.notDeepEqual(hashPagamento({ acao: 'CRIAR' }), hashPagamento({ acao: 'CAPTURAR' }));
});
test('maquina de estados rejeita pago antes da captura e regressao financeira', () => {
    validarTransicaoPagamento('APROVADO', 'CAPTURANDO'); validarTransicaoPagamento('DESCONHECIDO', 'CAPTURADO');
    for (const [de, para] of [['CRIANDO', 'CAPTURADO'], ['CAPTURADO', 'APROVADO'], ['REVISAO', 'CAPTURADO'], ['INVALIDO', 'INVALIDO']]) assert.throws(() => validarTransicaoPagamento(de, para));
    for (const estado of ['PARCIALMENTE_REEMBOLSADO', 'REEMBOLSADO', 'ESTORNADO']) assert.ok(TRANSICOES_PAGAMENTO[estado]);
});
test('normalizacao descarta extras e exige captura identificada e UTC', () => {
    const r = { estado: 'CAPTURADO', referencia: randomUUID(), ordemId: 'ordem', capturaId: 'captura', valorCentavos: '19000',
        moeda: 'BRL', ambiente: 'sandbox', contaRecebedora: 'conta', capturadoEm: '2026-10-16T12:00:00.000Z', access_token: 'privado' };
    assert.equal(normalizarResultadoPagamento(r).access_token, undefined);
    assert.throws(() => normalizarResultadoPagamento({ ...r, capturaId: null }));
    assert.throws(() => normalizarResultadoPagamento({ ...r, capturadoEm: '2026-10-16 12:00:00' }));
});
test('erros externos nao sao serializados e nao ha adapter/pool padrao', () => {
    assert.deepEqual(erroPagamentoPublico(new Error('SQL segredo')), { erro: { codigo: 'ERRO_INTERNO', mensagem: 'Não foi possível processar o pagamento.' } });
    assert.throws(() => criarLojaPagamentoService(), { codigo: 'CONFIGURACAO_INVALIDA' });
});

const parcial = () => ({ estado: 'DESCONHECIDO', referencia: randomUUID(), ambiente: 'sandbox', ordemId: 'ordem-parcial' });
test('RECUSADO admite recurso identificado ou sem ID, sem instante de captura', () => {
    const r = { ...parcial(), estado: 'RECUSADO', valorCentavos: '19000', moeda: 'BRL', contaRecebedora: 'conta' };
    assert.equal(normalizarResultadoPagamento(r).capturaId, null);
    const identificado = { ...r, capturaId: 'captura-recusada', capturadoEm: null };
    assert.equal(normalizarResultadoPagamento(identificado).capturaId, 'captura-recusada');
    assert.equal(classificarFalhaPagamento(criarFalhaPagamento({ categoria: 'RECUSA_DEFINITIVA', envio: 'ENVIADO',
        resultado: identificado })).resultado.capturaId, 'captura-recusada');
    for (const extras of [{ capturadoEm: '2026-10-16T12:00:00.000Z' }, { capturadoEm: '' },
        { capturaId: 'invalido\n' }, { ordemId: null }, { valorCentavos: null }, { moeda: null }, { contaRecebedora: null }]) {
        assert.throws(() => normalizarResultadoPagamento({ ...identificado, ...extras }));
    }
});
test('resultado inconclusivo admite fatos ausentes sem preencher valores esperados', () => {
    const r = normalizarResultadoPagamento(parcial());
    for (const k of ['valorCentavos', 'moeda', 'contaRecebedora', 'capturaId', 'capturadoEm']) assert.equal(r[k], null);
    assert.equal(r.ordemId, 'ordem-parcial');
    assert.equal(normalizarResultadoPagamento({ ...parcial(), valorCentavos: '19000', moeda: 'BRL' }).contaRecebedora, null);
});
test('captura e demais resultados conclusivos continuam exigindo fatos financeiros completos', () => {
    for (const estado of ['CAPTURADO', 'APROVADO', 'RECUSADO', 'AGUARDANDO_APROVACAO', 'PENDENTE']) {
        assert.throws(() => normalizarResultadoPagamento({ ...parcial(), estado, capturaId: 'captura', capturadoEm: '2026-10-16T12:00:00.000Z' }));
    }
});
test('parciais rejeitam tipos invalidos, contradicoes, referencia ausente e getters', () => {
    for (const extras of [{ valorCentavos: '1.1' }, { moeda: 'brl' }, { contaRecebedora: '' },
        { ordemId: 'id\n' }, { referencia: null }, { capturaId: 'captura', ordemId: null },
        { capturadoEm: '2026-10-16T12:00:00.000Z' }]) {
        assert.throws(() => normalizarResultadoPagamento({ ...parcial(), ...extras }));
    }
    assert.throws(() => normalizarResultadoPagamento([]));
    assert.throws(() => normalizarResultadoPagamento(Object.defineProperty(parcial(), 'valorCentavos', { get() { assert.fail('getter executado'); } })));
});
test('classificacao e sanitizada, validada e nao inferida de HTTP ou propriedades arbitrarias', () => {
    const falha = criarFalhaPagamento({ categoria: 'AUTENTICACAO', envio: 'NAO_ENVIADO', access_token: 'segredo' });
    assert.deepEqual(classificarFalhaPagamento(falha), { categoria: 'AUTENTICACAO', envio: 'NAO_ENVIADO', resultado: null });
    assert.equal(JSON.stringify(classificarFalhaPagamento(falha)).includes('segredo'), false);
    assert.deepEqual(classificarFalhaPagamento({ status: 401, categoria: 'RECUSA_DEFINITIVA', envio: 'NAO_ENVIADO' }),
        { categoria: 'OPERACAO', envio: 'INDETERMINADO', resultado: null });
    assert.throws(() => criarFalhaPagamento({ categoria: 'RECUSA_DEFINITIVA', envio: 'ENVIADO' }));
    assert.throws(() => criarFalhaPagamento({ categoria: 'VALIDACAO_LOCAL', envio: 'INDETERMINADO' }));
    assert.throws(() => criarFalhaPagamento({ categoria: 'INVENTADA', envio: 'NAO_ENVIADO' }));
});
