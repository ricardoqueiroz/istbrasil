import test from 'node:test';
import assert from 'node:assert/strict';
import { criarPaypalProvider } from '../src/services/pagamentos/paypalProvider.js';
import { projetarRecursoAdversoPaypal, validarEvidenciaAdversa } from '../src/services/lojaPagamentoAdversoContratos.js';

const env={IST_LOJA_PAYPAL_ENV:'sandbox',IST_LOJA_PAYPAL_CLIENT_ID:'fixture',IST_LOJA_PAYPAL_CLIENT_SECRET:'fixture-secret'};
const montar=(resposta)=>{
    const chamadas=[];
    const provider=criarPaypalProvider({env,http:{request:async c=>{
        chamadas.push(c);assert.equal(new URL(c.url).origin,'https://api-m.sandbox.paypal.com');assert.equal(c.maxRedirects,0);
        if(c.url.endsWith('/token'))return {status:200,data:{token_type:'Bearer',access_token:'fixture-token',expires_in:3600}};
        return resposta;
    }}});
    return {provider,chamadas};
};
for(const [tipo,id,path,data]of [
    ['REEMBOLSO','REFUND123','/v2/payments/refunds/REFUND123',{id:'REFUND123',status:'COMPLETED',amount:{value:'0.5',currency_code:'BRL'},
        links:[{rel:'up',method:'GET',href:'https://api-m.sandbox.paypal.com/v2/payments/captures/CAPTURE123'}],note_to_payer:'SEGREDO'}],
    ['DISPUTA','PP-D-123','/v1/customer/disputes/PP-D-123',{dispute_id:'PP-D-123',status:'RESOLVED',
        disputed_transactions:[{seller_transaction_id:'CAPTURE123',buyer:{email:'SEGREDO'}}],dispute_outcome:{outcome_code:'RESOLVED_SELLER_FAVOUR'}}],
    ['CAPTURA','CAPTURE123','/v2/payments/captures/CAPTURE123',{id:'CAPTURE123',status:'COMPLETED',amount:{value:'1.00',currency_code:'BRL'},
        payee:{merchant_id:'RECEBEDOR',email_address:'SEGREDO'},supplementary_data:{related_ids:{order_id:'ORDER123'}}}]
])test(`GET ${tipo}: caminho fixo, somente projecao e sem mutacao`,async()=>{
    const m=montar({status:200,data}),r=await m.provider.consultarEvidenciaAdversa({tipo,recursoId:id,ambiente:'sandbox'});
    assert.equal(r.recursoId,id);assert.equal(m.chamadas.at(-1).method,'GET');assert.equal(new URL(m.chamadas.at(-1).url).pathname,path);
    assert.doesNotMatch(JSON.stringify(r),/SEGREDO|fixture-token|fixture-secret/);
    assert.equal(m.chamadas.filter(c=>c.method==='POST'&&!c.url.endsWith('/token')).length,0);
});
test('parametros invalidos nao fazem OAuth nem permitem URLs arbitrarias',async()=>{
    for(const extras of [{tipo:'REVERSAO'},{recursoId:'../captura'},{recursoId:'https://evil.invalid'},{ambiente:'live'}]){
        const m=montar({status:200,data:{}});
        await assert.rejects(m.provider.consultarEvidenciaAdversa({tipo:'REEMBOLSO',recursoId:'REFUND123',ambiente:'sandbox',...extras}));
        assert.equal(m.chamadas.length,0);
    }
});
for(const status of [401,404,429,500])test(`GET HTTP ${status} sanitizado, sem transformar falha em prova`,async()=>{
    const m=montar({status,data:{message:'SEGREDO'}});
    await assert.rejects(m.provider.consultarEvidenciaAdversa({tipo:'REEMBOLSO',recursoId:'REFUND123',ambiente:'sandbox'}),e=>
        !/SEGREDO|fixture-secret|fixture-token/.test(e.message)&&!e.response);
});
test('montante ausente, negativo, fracao excessiva e overflow ficam ausentes',()=>{
    for(const v of [undefined,'-1.00','0.001','90071992547409.92']){
        const r=projetarRecursoAdversoPaypal('REEMBOLSO',{id:'REFUND123',amount:{value:v,currency_code:'BRL'}});
        assert.equal(r.valorCentavos,null);
    }
});
test('refund up estrangeiro, ambiguo ou excessivo nao prova associacao',()=>{
    for(const links of [
        [{rel:'up',method:'GET',href:'https://api-m.paypal.com/v2/payments/captures/CAPTURE123'}],
        ['A','B'].map(id=>({rel:'up',method:'GET',href:`https://api-m.sandbox.paypal.com/v2/payments/captures/${id}`})),
        Array.from({length:11},()=>({rel:'up',method:'GET',href:'https://api-m.sandbox.paypal.com/v2/payments/captures/CAPTURE123'}))
    ])assert.equal(projetarRecursoAdversoPaypal('REEMBOLSO',{id:'REFUND123',links}).capturaId,null);
});
test('disputa com multiplas transacoes nao escolhe pagamento por aproximacao',()=>{
    const r=projetarRecursoAdversoPaypal('DISPUTA',{dispute_id:'PP-D-123',disputed_transactions:[{seller_transaction_id:'A'},{seller_transaction_id:'B'}]});
    assert.equal(r.vinculoInvalido,true);assert.deepEqual(r.transacoesVendedor,[]);
});
test('contrato persistido rejeita contexto, captura, moeda e valor contraditorios',()=>{
    const ctx={provedor:'paypal',ambiente:'sandbox',contaRecebedora:'RECEBEDOR'},pg={captura_externa_id:'CAPTURE123'};
    const f={contrato:'IST_EVIDENCIA_ADVERSA_V1',eventoOrigem:'WH-123',hashOrigem:'a'.repeat(64),contexto:ctx,
        tipo:'REEMBOLSO',recursoId:'REFUND123',capturaId:'CAPTURE123',classificacao:'REEMBOLSO_CONFIRMADO',valorCentavos:'50',moeda:'BRL'};
    assert.equal(validarEvidenciaAdversa(f,pg,ctx),f);
    for(const extras of [{contexto:{...ctx,ambiente:'live'}},{capturaId:'OUTRA'},{moeda:'USD'},{valorCentavos:'0'},
        {valorCentavos:'9007199254740992'},{hashOrigem:null},{tipo:'CAPTURA'}])assert.throws(()=>validarEvidenciaAdversa({...f,...extras},pg,ctx));
});
