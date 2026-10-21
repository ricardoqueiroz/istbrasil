import test from 'node:test';
import assert from 'node:assert/strict';
import {projetarRecursoAdversoPaypal as projetar} from '../src/services/lojaPagamentoAdversoContratos.js';
import {normalizarEventoAdversoPaypal as normalizar} from '../src/services/lojaPaypalEventoAdverso.js';

// Fonte dos campos: schema oficial customer_disputes_v1, transaction_info e
// fund_movement. Nenhum ID de movimento ou status de liquidacao foi inventado.
const disputa=()=>({dispute_id:'PP-D-SINTETICO',status:'RESOLVED',dispute_life_cycle_stage:'CHARGEBACK',
    dispute_channel:'EXTERNAL',dispute_amount:{value:'1.00',currency_code:'BRL'},
    dispute_outcome:{outcome_code:'RESOLVED_BUYER_FAVOUR'},
    disputed_transactions:[{seller_transaction_id:'CAPTURE123',transaction_status:'HELD',
        seller:{merchant_id:'RECEBEDOR',email:'NAO-PROJETAR'},buyer:{email:'NAO-PROJETAR'}}],
    fund_movements:[{party:'SELLER',type:'DEBIT',reason:'DISPUTE_SETTLEMENT',
        amount:{value:'0.50',currency_code:'BRL'},initiated_time:'2026-01-01T00:00:00Z',nota:'NAO-PROJETAR'}]});

test('disputa: identidade do vendedor, retencao e debito relatado distintos do valor disputado',()=>{
    const r=projetar('DISPUTA',disputa());
    assert.equal(r.contaRecebedora,'RECEBEDOR');assert.equal(r.estadoTransacao,'HELD');
    assert.equal(r.estagio,'CHARGEBACK');assert.equal(r.valorCentavos,'100');
    assert.equal(r.movimentos[0].valorCentavos,'50');assert.equal(r.movimentos[0].direcao,'DEBIT');
    assert.equal(r.identidadeEconomica,'NAO_COMPROVADA');assert.doesNotMatch(JSON.stringify(r),/NAO-PROJETAR/);
    assert.equal(Object.hasOwn(r,'capturaId'),false);
});
for(const motivo of ['DISPUTE_SETTLEMENT','DISPUTE_FEE','CHARGEBACK_FEE','REVERSED_TRANSACTION_FEE'])
    test(`motivo oficial ${motivo} preservado sem gerar reembolso`,()=>{
        const d=disputa();d.fund_movements[0].reason=motivo;d.fund_movements[0].type='CREDIT';
        const r=projetar('DISPUTA',d);assert.equal(r.movimentos[0].motivo,motivo);
        assert.equal(r.movimentos[0].direcao,'CREDIT');assert.equal(r.identidadeEconomica,'NAO_COMPROVADA');
        assert.equal(Object.hasOwn(r,'reembolsadoCentavos'),false);
    });
test('recebedor ausente nao e inferido; identidade malformada e sinalizada',()=>{
    const d=disputa();delete d.disputed_transactions[0].seller;
    assert.equal(projetar('DISPUTA',d).contaRecebedora,null);
    d.disputed_transactions[0].seller={merchant_id:'../invalido'};
    assert.equal(projetar('DISPUTA',d).identidadeRecebedorInvalida,true);
});
test('transacoes ambiguas nao escolhem vendedor nem captura',()=>{
    const d=disputa();d.disputed_transactions.push({seller_transaction_id:'OUTRA',seller:{merchant_id:'OUTRO'}});
    const r=projetar('DISPUTA',d);assert.equal(r.vinculoInvalido,true);assert.equal(r.contaRecebedora,null);
});
test('movimentos ausentes, desconhecidos e invalidos nao viram zero nem contrato de liquidacao',()=>{
    const d=disputa();delete d.fund_movements;assert.deepEqual(projetar('DISPUTA',d).movimentos,[]);
    d.fund_movements=[{type:'HOLD',party:'X',reason:'REFUND',amount:{value:'-1.00',currency_code:'BRL'}}];
    const m=projetar('DISPUTA',d).movimentos[0];
    assert.deepEqual([m.direcao,m.parte,m.motivo,m.valorCentavos,m.moeda],[null,null,null,null,null]);
});
test('limite 50 nao trunca silenciosamente listas invalidas',()=>{
    const d=disputa();d.fund_movements=Array(51).fill(d.fund_movements[0]);
    const r=projetar('DISPUTA',d);assert.equal(r.movimentosInvalidos,true);assert.deepEqual(r.movimentos,[]);
});
test('webhook e GET preservam observacoes repetidas, sem criar identidade economica ficticia',()=>{
    const d=disputa();d.fund_movements.push(structuredClone(d.fund_movements[0]));
    const e={id:'WH-SINTETICO',event_type:'CUSTOMER.DISPUTE.UPDATED',resource:d};
    const n=normalizar(e,Buffer.from(JSON.stringify(e))),r=projetar('DISPUTA',d);
    assert.deepEqual(n.detalhesDisputa.movimentos,r.movimentos);assert.equal(r.movimentos.length,2);
    assert.equal(n.detalhesDisputa.identidadeEconomica,'NAO_COMPROVADA');
    assert.equal(n.efeitoFinanceiroAplicado,false);assert.equal(n.capturaId,null);
});
for(const tipo of ['PAYMENT.CAPTURE.REVERSED','CHECKOUT.PAYMENT-APPROVAL.REVERSED'])
    test(`${tipo}: envelope preservado sem captura presumida`,()=>{
        const e={id:'WH-SINTETICO',event_type:tipo,resource:{}};
        const n=normalizar(e,Buffer.from(JSON.stringify(e)));
        assert.equal(n.capturaId,null);assert.equal(n.recursoId,null);assert.equal(n.efeitoFinanceiroAplicado,false);
        assert.equal(n.classificacao,tipo==='PAYMENT.CAPTURE.REVERSED'?'REVERSAO_NOTIFICADA_SEM_EXTRATOR':'DESCONHECIDO');
    });
