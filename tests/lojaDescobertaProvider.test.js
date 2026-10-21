import test from 'node:test';
import assert from 'node:assert/strict';
import {criarPaypalProvider} from '../src/services/pagamentos/paypalProvider.js';
import {observarRecursoPaypal} from '../src/services/lojaDescobertaContratos.js';
const inicio='2026-01-01T00:00:00.000Z',fim='2026-01-02T00:00:00.000Z';
const montar=fn=>{
    const chamadas=[];const provider=criarPaypalProvider({agora:()=>Date.parse('2026-01-03T00:00:00Z'),
        env:{IST_LOJA_PAYPAL_ENV:'sandbox',IST_LOJA_PAYPAL_CLIENT_ID:'fixture',IST_LOJA_PAYPAL_CLIENT_SECRET:'fixture-secret'},
        http:{request:async c=>{chamadas.push(c);assert.equal(new URL(c.url).origin,'https://api-m.sandbox.paypal.com');
            assert.equal(c.maxRedirects,0);if(c.url.endsWith('/token'))return {status:200,data:{token_type:'Bearer',access_token:'fixture-token',expires_in:3600}};
            assert.equal(c.method,'GET');return fn(c);}}});return {provider,chamadas};
};
test('notificacoes: GET autenticado e observacao API sem simular assinatura ou reenvio',async()=>{
    const m=montar(c=>{const u=new URL(c.url);assert.equal(u.pathname,'/v1/notifications/webhooks-events');
        assert.equal(u.searchParams.get('start_time'),inicio);return {status:200,data:{events:[{id:'WH-SINTETICO',event_type:'PAYMENT.CAPTURE.REVERSED',resource:{email:'SEGREDO'}}],links:[]}};});
    const r=await m.provider.listarObservacoesAdversas({fonte:'NOTIFICACOES',inicio,fim});
    assert.equal(r.observacoes[0].fonte,'NOTIFICACOES');assert.equal(r.proxima,null);
    assert.doesNotMatch(JSON.stringify(r),/SEGREDO|fixture-token|fixture-secret|assinatura/);
});
test('disputas: lista resumida seguida de GET por ID preserva dados D9-B1',async()=>{
    const m=montar(c=>new URL(c.url).pathname.endsWith('/PP-D-1')?{status:200,data:{dispute_id:'PP-D-1',status:'OPEN',
        disputed_transactions:[{seller_transaction_id:'CAPTURE1',seller:{merchant_id:'RECEBEDOR'}}],dispute_life_cycle_stage:'CHARGEBACK',fund_movements:[]}}:
        {status:200,data:{items:[{dispute_id:'PP-D-1'}],links:[]}});
    const r=await m.provider.listarObservacoesAdversas({fonte:'DISPUTAS',inicio,fim});
    assert.equal(r.observacoes[0].recurso.transacoesVendedor[0],'CAPTURE1');assert.equal(m.chamadas.length,3);
});
test('Transaction Search: paginacao numerica e projecao sem dados pessoais',async()=>{
    const m=montar(()=>({status:200,data:{transaction_details:[{transaction_info:{transaction_id:'TX1',transaction_event_code:'T1201',
        paypal_reference_id:'CAPTURE1',paypal_reference_id_type:'TXN',payer_email:'SEGREDO'}}],total_pages:2,links:[]}}));
    const r=await m.provider.listarObservacoesAdversas({fonte:'TRANSACOES',inicio,fim});
    assert.equal(new URL(r.proxima).searchParams.get('page'),'2');assert.doesNotMatch(JSON.stringify(r),/SEGREDO/);
    assert.equal(r.observacoes[0].identidadeEconomica,'NAO_COMPROVADA');
});
for(const status of [401,403,429,500,404])test(`descoberta HTTP ${status} tem classificacao sanitizada`,async()=>{
    const m=montar(()=>({status,data:{message:'SEGREDO'}}));
    await assert.rejects(m.provider.listarObservacoesAdversas({fonte:'NOTIFICACOES',inicio,fim}),e=>
        e.codigo===([401,403].includes(status)?'D9_DESCOBERTA_PERMISSAO':[429,500].includes(status)?'D9_DESCOBERTA_TRANSITORIA':'D9_DESCOBERTA_CONTRATO')
        &&!e.message.includes('SEGREDO'));
});
test('intervalo acima de 31 dias/fonte invalida bloqueiam antes do OAuth',async()=>{
    const m=montar(()=>assert.fail());
    for(const x of [{fim:'2026-02-03T00:00:00Z'},{fonte:'LIVE'}])await assert.rejects(m.provider.listarObservacoesAdversas({fonte:'TRANSACOES',inicio,fim,...x}));
    assert.equal(m.chamadas.length,0);
});
test('continuacao externa, outro endpoint ou janela alterada nao executam GET',async()=>{
    for(const continuacao of ['https://evil.invalid/v1/notifications/webhooks-events',
        'https://api-m.sandbox.paypal.com/v2/payments/captures/ID',
        'https://api-m.sandbox.paypal.com/v1/notifications/webhooks-events?start_time=OUTRO']){
        const m=montar(()=>assert.fail());await assert.rejects(m.provider.listarObservacoesAdversas({fonte:'NOTIFICACOES',inicio,fim,continuacao}));
        assert.equal(m.chamadas.length,0);
    }
});
test('identidade da observacao inclui referencia e estado; transaction_id nao e chave universal',()=>{
    const raw={transaction_info:{transaction_id:'TX1',transaction_event_code:'T1107',paypal_reference_id:'CAPTURE1',transaction_status:'S'}};
    const a=observarRecursoPaypal('TRANSACOES',raw),b=observarRecursoPaypal('TRANSACOES',{transaction_info:{...raw.transaction_info,paypal_reference_id:'CAPTURE2'}});
    assert.notEqual(a.observacaoId,b.observacaoId);assert.equal(a.observacaoId,observarRecursoPaypal('TRANSACOES',raw).observacaoId);
});
test('reembolso de versao desconhecida fica em revisao, sem contrato hipotetico',()=>{
    const r=observarRecursoPaypal('NOTIFICACOES',{id:'WH-1',event_type:'PAYMENT.CAPTURE.REFUNDED',resource_version:'1.0'});
    assert.equal(r.tipoRecurso,null);assert.equal(r.recurso,null);
});
test('relatorio ainda nao atualizado ate o fim pedido nao permite fechar janela',async()=>{
    const m=montar(()=>({status:200,data:{transaction_details:[],total_pages:0,end_date:inicio,last_refreshed_datetime:inicio,links:[]}}));
    await assert.rejects(m.provider.listarObservacoesAdversas({fonte:'TRANSACOES',inicio,fim}),{codigo:'D9_DESCOBERTA_TRANSITORIA'});
});
