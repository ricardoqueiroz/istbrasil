import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { camposExatos, centavosPagamento, erroPagamentoPublico, hashPagamento, normalizarResultadoPagamento,
    criarFalhaPagamento, classificarFalhaPagamento, TRANSICOES_PAGAMENTO, validarTransicaoPagamento,
    normalizarReconciliacaoPagamento, pagamentoPublico } from '../src/services/lojaPagamentoContratos.js';
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
const envelopeReconciliacao = () => ({ resultado: parcial(), observacao: {
    evidencia: 'PRESENTE', associacaoOrdem: 'CONFIRMADA', validacao: 'CONSISTENTE',
    statusOrdem: 'COMPLETED', statusCaptura: 'COMPLETED', motivoPendencia: null
} });

test('envelope interno reutiliza normalizador financeiro sem converter CONSISTENTE em quitacao', () => {
    const e = envelopeReconciliacao(); const r = normalizarReconciliacaoPagamento(e);
    assert.deepEqual(r.resultado, normalizarResultadoPagamento(e.resultado));
    assert.equal(r.resultado.estado, 'DESCONHECIDO');
    for (const campo of ['valorCentavos', 'moeda', 'contaRecebedora']) assert.equal(r.resultado[campo], null);
    assert.deepEqual(r.observacao, e.observacao);
});

test('evidencia ausente e explicita e nao preenche fatos financeiros', () => {
    const e = envelopeReconciliacao(); e.observacao = { evidencia: 'AUSENTE', associacaoOrdem: 'NAO_DEMONSTRADA',
        validacao: 'INCONCLUSIVA', statusOrdem: null, statusCaptura: null, motivoPendencia: null };
    const r = normalizarReconciliacaoPagamento(e); assert.equal(r.observacao.evidencia, 'AUSENTE');
    assert.equal(r.resultado.contaRecebedora, null);
    assert.throws(() => normalizarReconciliacaoPagamento({ ...e, observacao: { ...e.observacao, validacao: 'CONSISTENTE' } }));
});

test('evidencia contraditoria e preservada sem reescrever resultado financeiro', () => {
    const e = envelopeReconciliacao(); Object.assign(e.observacao, {
        evidencia: 'CONTRADITORIA', associacaoOrdem: 'DIVERGENTE', validacao: 'DIVERGENTE' });
    assert.deepEqual(normalizarReconciliacaoPagamento(e).resultado, normalizarResultadoPagamento(e.resultado));
    assert.equal(normalizarReconciliacaoPagamento(e).observacao.associacaoOrdem, 'DIVERGENTE');
    e.observacao.associacaoOrdem = 'INVALIDA'; e.observacao.validacao = 'INCONCLUSIVA';
    assert.equal(normalizarReconciliacaoPagamento(e).observacao.validacao, 'INCONCLUSIVA');
    e.observacao.validacao = 'CONSISTENTE'; assert.throws(() => normalizarReconciliacaoPagamento(e));
});

test('CAPTURADO e COMPLETED permanecem fatos internos sem autorizacao comercial', () => {
    const e = envelopeReconciliacao(); Object.assign(e.resultado, { estado: 'CAPTURADO', capturaId: 'captura',
        valorCentavos: '100', moeda: 'BRL', contaRecebedora: 'recebedor', capturadoEm: '2026-10-18T12:00:00.000Z' });
    const r = normalizarReconciliacaoPagamento(e);
    assert.equal(r.resultado.estado, 'CAPTURADO');
    assert.deepEqual(Object.keys(r).sort(), ['observacao', 'resultado']);
    assert.equal(r.pedidoEstado, undefined); assert.equal(r.downloadAutorizado, undefined);
});

test('PENDENTE e PENDING_REVIEW nao sao promovidos para CAPTURADO', () => {
    const e = envelopeReconciliacao(); Object.assign(e.resultado, {
        estado: 'PENDENTE', capturaId: 'captura', valorCentavos: '100', moeda: 'BRL', contaRecebedora: 'recebedor' });
    Object.assign(e.observacao, { statusCaptura: 'PENDING', motivoPendencia: 'PENDING_REVIEW' });
    assert.equal(normalizarReconciliacaoPagamento(e).resultado.estado, 'PENDENTE');
    assert.equal(normalizarReconciliacaoPagamento(e).observacao.motivoPendencia, 'PENDING_REVIEW');
});

test('envelope rejeita tipos inesperados e campos obrigatorios ausentes', () => {
    for (const valor of [null, undefined, [], 'texto', 1, true, Object.create(null)]) {
        assert.throws(() => normalizarReconciliacaoPagamento(valor), { codigo: 'ERRO_INTERNO' });
        assert.throws(() => normalizarReconciliacaoPagamento({ ...envelopeReconciliacao(), observacao: valor }));
        assert.throws(() => normalizarReconciliacaoPagamento({ ...envelopeReconciliacao(), resultado: valor }));
    }
    for (const campo of ['resultado', 'observacao']) {
        const e = envelopeReconciliacao(); delete e[campo]; assert.throws(() => normalizarReconciliacaoPagamento(e));
    }
    for (const campo of Object.keys(envelopeReconciliacao().observacao)) {
        const e = envelopeReconciliacao(); delete e.observacao[campo]; assert.throws(() => normalizarReconciliacaoPagamento(e));
    }
    for (const campo of ['estado', 'referencia', 'ambiente']) {
        const e = envelopeReconciliacao(); delete e.resultado[campo]; assert.throws(() => normalizarReconciliacaoPagamento(e));
    }
});

test('observacao rejeita valores fora das listas fechadas e tipos inesperados', () => {
    for (const campo of Object.keys(envelopeReconciliacao().observacao)) {
        for (const valor of ['INVENTADO', '', 1, false, [], {}, undefined]) {
            const e = envelopeReconciliacao(); e.observacao[campo] = valor;
            assert.throws(() => normalizarReconciliacaoPagamento(e), { codigo: 'ERRO_INTERNO' });
        }
    }
});

test('observacao excessiva e rejeitada sem reproduzir conteudo em erro', () => {
    const e = envelopeReconciliacao(); e.observacao.motivoPendencia = 'segredo'.repeat(1000);
    assert.throws(() => normalizarReconciliacaoPagamento(e), erro => erro.codigo === 'ERRO_INTERNO' && !erro.message.includes('segredo'));
});

test('envelope conserva rejeicoes financeiras de montante, moeda, estado e instante', () => {
    for (const campos of [{ valorCentavos: '1.50' }, { moeda: 'brl' }, { ambiente: 'producao' },
        { estado: 'COMPLETED' }, { estado: 'CAPTURADO' }, { capturaId: 'captura', ordemId: null },
        { capturadoEm: '2026-10-18 12:00:00' }]) {
        const e = envelopeReconciliacao(); Object.assign(e.resultado, campos);
        assert.throws(() => normalizarReconciliacaoPagamento(e), { codigo: 'ERRO_INTERNO' });
    }
});

test('campos sensiveis ou inesperados sao rejeitados em todos os niveis', () => {
    for (const campo of ['access_token', 'client_secret', 'Authorization', 'url', 'respostaBruta', 'toJSON']) {
        for (const nivel of ['envelope', 'resultado', 'observacao']) {
            const e = envelopeReconciliacao(); (nivel === 'envelope' ? e : e[nivel])[campo] = 'segredo';
            assert.throws(() => normalizarReconciliacaoPagamento(e), { codigo: 'ERRO_INTERNO' });
        }
    }
});

test('getters, setters, simbolos e campos nao enumeraveis nao sao aceitos nem executados', () => {
    for (const nivel of ['envelope', 'resultado', 'observacao']) {
        const campo = { envelope: 'observacao', resultado: 'estado', observacao: 'evidencia' }[nivel];
        for (const descriptor of [{ get() { assert.fail('getter executado'); }, enumerable: true },
            { set() { assert.fail('setter executado'); }, enumerable: true }, { value: 'segredo', enumerable: false }]) {
            const e = envelopeReconciliacao(); Object.defineProperty(nivel === 'envelope' ? e : e[nivel], campo, descriptor);
            assert.throws(() => normalizarReconciliacaoPagamento(e), { codigo: 'ERRO_INTERNO' });
        }
        const e = envelopeReconciliacao(); (nivel === 'envelope' ? e : e[nivel])[Symbol('segredo')] = 'segredo';
        assert.throws(() => normalizarReconciliacaoPagamento(e));
    }
});

test('entradas congeladas nao sao modificadas e saidas nao compartilham objetos', () => {
    const e = envelopeReconciliacao(); Object.freeze(e.resultado); Object.freeze(e.observacao); Object.freeze(e);
    const antes = JSON.stringify(e); const r = normalizarReconciliacaoPagamento(e);
    r.observacao.validacao = 'INCONCLUSIVA'; r.resultado.moeda = 'USD';
    assert.equal(JSON.stringify(e), antes); assert.notEqual(r.observacao, e.observacao); assert.notEqual(r.resultado, e.resultado);
});

test('diagnosticos nao entram no DTO publico e contratos financeiros anteriores preservados', () => {
    const pg = { public_id: 'pagamento', estado: 'PENDENTE', moeda: 'BRL', valor_centavos: '100', versao: 1,
        criado_em: '2026-10-18T12:00:00.000Z', expira_em: '2026-10-18T12:30:00.000Z' };
    const pedido = { public_id: 'pedido', estado: 'AGUARDANDO_PAGAMENTO', pagamento_confirmado_em: null };
    const esperado = pagamentoPublico(pg, pedido);
    assert.deepEqual(pagamentoPublico({ ...pg, ...normalizarReconciliacaoPagamento(envelopeReconciliacao()) }, pedido), esperado);
    const e = envelopeReconciliacao(); e.resultado.access_token = 'segredo';
    assert.equal(normalizarResultadoPagamento(e.resultado).access_token, undefined);
    assert.throws(() => normalizarReconciliacaoPagamento(e));
    assert.equal(JSON.stringify(esperado).includes('observacao'), false);
});

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
