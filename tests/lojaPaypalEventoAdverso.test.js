import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { normalizarEventoAdversoPaypal as normalizar } from '../src/services/lojaPaypalEventoAdverso.js';
import { criarPersistenciaPagamento } from '../src/services/lojaPagamentoPersistencia.js';
import { criarProcessadorWebhookPayPal } from '../src/services/lojaPaypalWebhook.js';

export const contexto = { provedor: 'paypal', ambiente: 'sandbox', contaRecebedora: 'RECEBEDOR-TESTE' };
export const evento = (id = 'WH-TESTE', valor = '0.50') => ({ id, event_type: 'PAYMENT.CAPTURE.REFUNDED',
    create_time: '2026-01-01T00:00:00Z', resource_type: 'refund', resource_version: '2.0',
    resource: { id: 'REFUND123', status: 'COMPLETED', amount: { value: valor, currency_code: 'BRL' },
        note_to_payer: 'SEGREDO-NAO-PERSISTIR', links: [{ rel: 'up', method: 'GET',
            href: 'https://api-m.sandbox.paypal.com/v2/payments/captures/CAPTURE123' }] } });
export const entrada = e => normalizar(e, Buffer.from(JSON.stringify(e)));

test('reembolso parcial/integral notificado: IDs distintos, centavos exatos, sem inferir alcance', () => {
    for (const valor of ['0.50','1.00']) {
        const e = evento('WH-TESTE', valor), n = entrada(e);
        assert.equal(n.reembolsoId, 'REFUND123'); assert.equal(n.capturaId, null);
        assert.deepEqual(n.capturasPorAmbiente.sandbox, ['CAPTURE123']);
        assert.equal(n.valorCentavos, valor === '0.50' ? '50' : '100');
        assert.equal(n.efeitoFinanceiroAplicado, false);
        assert.equal(JSON.stringify(n).includes('SEGREDO'), false);
        assert.deepEqual(n.hash, createHash('sha256').update(JSON.stringify(e)).digest());
    }
});
test('ausencia, numero, decimal invalido e overflow nunca viram zero', () => {
    for (const valor of [undefined, 1, '1.001', '-1.00', '90071992547409.92']) {
        const e=evento();e.resource.amount.value=valor;
        assert.equal(entrada(e).valorCentavos,null);
    }
});
test('links maliciosos nao sao correlacionados nem consultados', () => {
    for (const href of ['https://evil.invalid/v2/payments/captures/CAPTURE123',
        'https://api-m.sandbox.paypal.com/v2/payments/captures/CAPTURE123?x=1',
        'https://api-m.sandbox.paypal.com:443/v2/payments/captures/CAPTURE123']) {
        const e=evento();e.resource.links[0].href=href;
        assert.deepEqual(entrada(e).capturasPorAmbiente.sandbox,[]);
    }
});
test('contrato refund nao comprovado e excesso de links nao permitem inferir captura', () => {
    const e=evento();delete e.resource_version;
    assert.equal(entrada(e).classificacao,'REEMBOLSO_CONTRATO_NAO_SUPORTADO');
    assert.equal(entrada(e).reembolsoId,null);
    e.resource_version='2.0';e.resource.links=Array.from({length:11},()=>e.resource.links[0]);
    assert.equal(entrada(e).vinculoInvalido,true);
});
for (const sufixo of ['CREATED','UPDATED','RESOLVED']) test(`disputa ${sufixo}: transacao do vendedor nao e presumida captura`, () => {
    const e={id:'WH-DISPUTA',event_type:`CUSTOMER.DISPUTE.${sufixo}`,resource:{dispute_id:'PP-D-123',
        status:'RESOLVED',disputed_transactions:[{seller_transaction_id:'CAPTURE123',buyer_transaction_id:'IGNORADO'}],
        dispute_amount:{value:'1.00',currency_code:'BRL'},dispute_outcome:{outcome_code:'RESOLVED_SELLER_FAVOUR'}}};
    const n=entrada(e);assert.equal(n.disputaId,'PP-D-123');assert.equal(n.capturaId,null);
    assert.deepEqual(n.transacoesVendedor,['CAPTURE123']);assert.equal(n.efeitoFinanceiroAplicado,false);
});
test('reversao recebe somente envelope; desconhecido explicitamente classificado', () => {
    for (const tipo of ['PAYMENT.CAPTURE.REVERSED','OUTRO.EVENTO']) {
        const n=entrada({id:'WH-X',event_type:tipo,resource:{id:'NAO-PRESUMIR'}});
        assert.equal(n.recursoId,null);assert.equal(n.capturaId,null);
        assert.equal(n.classificacao,tipo==='OUTRO.EVENTO'?'DESCONHECIDO':'REVERSAO_NOTIFICADA_SEM_EXTRATOR');
    }
});
test('assinatura invalida impede nova ingestao; falha de persistencia e sanitizada', async () => {
    let valida=false,chamadas=0;
    const p=criarProcessadorWebhookPayPal({obterWebhookId:()=> 'WH-CONFIG',obterFinanceiro:()=>({
        adaptador:{verificarWebhook:async()=>valida},service:{receberEventoAdverso:async()=>{chamadas++;throw Error('SEGREDO');}}
    })});
    await assert.rejects(p({corpo:Buffer.from(JSON.stringify(evento())),cabecalhos:{}}),{status:401});
    assert.equal(chamadas,0);valida=true;
    await assert.rejects(p({corpo:Buffer.from(JSON.stringify(evento())),cabecalhos:{}}),e=>e.status===503&&!e.message.includes('SEGREDO'));
    assert.equal(chamadas,1);
});

// Double transacional somente do ledger; SQL real e exercitado em arquivo separado.
const montar = modo => {
    let duravel=null, falhou=false, rollback=0, destruida=0;
    const sqls=[];
    const db={getConnection:async()=>{
        let copia=null;
        return {
            beginTransaction:async()=>{copia=duravel;},
            query:async(sql,ps=[])=>{
                sqls.push(sql);
                if(sql.startsWith('SELECT @@'))return [[{transacao:0,autocommit:1}]];
                if(sql.startsWith('SET '))return [[]];
                if(sql.includes('FROM ist_loja_pagamento_eventos'))return [[...(copia??duravel?[copia??duravel]:[])]];
                if(sql.includes('FROM ist_loja_pagamentos'))return [[{id:1}]];
                if(sql.startsWith('INSERT INTO ist_loja_pagamento_eventos')){
                    if(modo==='sql')throw Error('SEGREDO-SQL');
                    copia={id:1,conteudo_hash:ps[8],estado:ps[10]};return [{insertId:1}];
                }
                assert.fail(sql);
            },
            commit:async()=>{
                if(modo?.startsWith('commit')&&!falhou){falhou=true;if(modo==='commit-gravado')duravel=copia;throw Error('SEGREDO-COMMIT');}
                duravel=copia;
            },rollback:async()=>{rollback++;copia=null;},destroy:()=>{destruida++;},release(){}
        };
    }};
    return {p:criarPersistenciaPagamento({db,agora:()=>new Date('2026-01-02T00:00:00Z')}),sqls,
        get estado(){return {duravel,rollback,destruida};}};
};
test('ledger deduplica e rejeita mesmo ID divergente sem UPDATE financeiro',async()=>{
    const m=montar(),n=entrada(evento());await m.p.receberEventoAdverso(contexto,n);
    assert.equal((await m.p.receberEventoAdverso(contexto,n)).duplicado,true);
    await assert.rejects(m.p.receberEventoAdverso(contexto,entrada(evento('WH-TESTE','0.75'))),{codigo:'EVENTO_CONTEUDO_DIVERGENTE'});
    assert.equal(m.sqls.filter(s=>s.startsWith('INSERT')).length,1);
    assert.equal(m.sqls.some(s=>/^(UPDATE|DELETE)/.test(s)),false);
});
test('falha SQL reverte; mensagem sanitizada',async()=>{
    const m=montar('sql');await assert.rejects(m.p.receberEventoAdverso(contexto,entrada(evento())),{codigo:'ERRO_PERSISTENCIA'});
    assert.equal(m.estado.duravel,null);assert.equal(m.estado.rollback,1);
});
for(const modo of ['commit-gravado','commit-nao-gravado'])test(`COMMIT incerto ${modo}: somente leitura, sem segunda insercao`,async()=>{
    const m=montar(modo),p=m.p.receberEventoAdverso(contexto,entrada(evento()));
    if(modo==='commit-gravado')assert.equal((await p).reconciliado,true);
    else await assert.rejects(p,{codigo:'RESULTADO_DESCONHECIDO'});
    assert.equal(m.sqls.filter(s=>s.startsWith('INSERT')).length,1);assert.equal(m.estado.destruida,1);
});
