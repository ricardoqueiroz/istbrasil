import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { criarBancoPagamentoIsolado } from './fixtures/lojaPagamentoBancoIsolado.js';
import { criarLojaPagamentoService } from '../src/services/lojaPagamentoService.js';
import { criarProcessadorWebhookPayPal } from '../src/services/lojaPaypalWebhook.js';
import { criarPersistenciaPagamento } from '../src/services/lojaPagamentoPersistencia.js';
import { normalizarEventoAdversoPaypal } from '../src/services/lojaPaypalEventoAdverso.js';

test('D8-B1 ingestao real em MariaDB descartavel, somente ledger', async t => {
    const {admin,pool,novaCompra,versao}=await criarBancoPagamentoIsolado(t);
    const compra=await novaCompra({estado:'PAGO'});
    const contexto={provedor:'paypal',ambiente:'sandbox',contaRecebedora:'RECEBEDOR-TESTE'};
    await admin.query(`INSERT INTO ist_loja_pagamentos
        (public_id,pedido_id,provedor,ambiente,conta_recebedora,estado,reserva_ativa,moeda,valor_centavos,
        capturado_centavos,ordem_externa_id,captura_externa_id,criado_em,atualizado_em,expira_em,capturado_em,encerrado_em)
        VALUES (?,?, 'paypal','sandbox',?,'CAPTURADO',NULL,'BRL',19000,19000,'ORDER123','CAPTURE123',
        '2026-01-01','2026-01-01','2026-01-02','2026-01-01','2026-01-01')`,
    [randomUUID(),compra.pedidoId,contexto.contaRecebedora]);
    const consultas=[];
    const db={getConnection:async()=>{
        const c=await pool.getConnection();
        return {query:(sql,ps)=>{consultas.push(sql);return c.query(sql,ps);},beginTransaction:()=>c.beginTransaction(),
            commit:()=>c.commit(),rollback:()=>c.rollback(),release:()=>c.release(),destroy:()=>c.destroy()};
    }};
    const snapshot=async()=>{
        const saida=[];
        for(const tabela of ['ist_loja_pedidos','ist_loja_pedido_itens','ist_loja_pagamentos','ist_loja_pagamento_operacoes']){
            const [rows]=await admin.query(`SELECT * FROM ${tabela} ORDER BY id`);saida.push(rows);
        }
        return JSON.stringify(saida);
    };
    const antes=await snapshot();
    const service=criarLojaPagamentoService({db,contexto,adaptador:{criar(){assert.fail();},consultar(){assert.fail();},capturar(){assert.fail();}}});
    const processar=criarProcessadorWebhookPayPal({obterWebhookId:()=> 'WH-CONFIG',obterFinanceiro:()=>({service,
        adaptador:{verificarWebhook:async()=>true}})});
    const evento=(id,valor='95.00')=>({id,event_type:'PAYMENT.CAPTURE.REFUNDED',resource_type:'refund',resource_version:'2.0',
        create_time:'2026-01-01T00:00:00Z',resource:{id:`REFUND-${id}`,status:'COMPLETED',
            amount:{value:valor,currency_code:'BRL'},links:[{rel:'up',method:'GET',
                href:'https://api-m.sandbox.paypal.com/v2/payments/captures/CAPTURE123'}]}});
    const enviar=e=>processar({corpo:Buffer.from(JSON.stringify(e)),cabecalhos:{}});
    const ler=async id=>{const [[r]]=await admin.query('SELECT * FROM ist_loja_pagamento_eventos WHERE evento_id=?',[id]);
        return {...r,evidencia:JSON.parse(r.evidencia_json)};};
    await t.test('parcial e integral recebidos, sem calcular saldo ou aplicar efeito',async()=>{
        for(const [id,valor] of [['WH-PARCIAL','95.00'],['WH-TOTAL','190.00']]){
            await enviar(evento(id,valor));const r=await ler(id);
            assert.equal(r.pagamento_id,1);assert.equal(r.estado,'RECEBIDO');assert.equal(r.processado_em,null);
            assert.equal(r.evidencia.correlacao,'CORRELACIONADO');assert.equal(r.evidencia.efeitoFinanceiroAplicado,false);
            assert.equal(r.evidencia.valorCentavos,valor==='95.00'?'9500':'19000');
        }
    });
    await t.test('duplicatas concorrentes possuem uma unica identidade',async()=>{
        await Promise.all([enviar(evento('WH-DUP')),enviar(evento('WH-DUP'))]);
        await enviar(evento('WH-DUP'));
        const [[r]]=await admin.query("SELECT COUNT(*) n FROM ist_loja_pagamento_eventos WHERE evento_id='WH-DUP'");assert.equal(Number(r.n),1);
        await assert.rejects(enviar(evento('WH-DUP','1.00')),{status:503});
        assert.equal((await ler('WH-DUP')).evidencia.valorCentavos,'9500');
    });
    await t.test('fora de ordem preserva ambas evidencias sem sobrescrever',async()=>{
        const novo=evento('WH-NOVO'),antigo=evento('WH-ANTIGO');novo.create_time='2026-01-03T00:00:00Z';
        await enviar(novo);await enviar(antigo);
        assert.notEqual((await ler('WH-NOVO')).id,(await ler('WH-ANTIGO')).id);
    });
    await t.test('sem correlacao, ambiente divergente e links conflitantes ficam sem pedido',async()=>{
        for(const id of ['WH-SEM','WH-LIVE','WH-CONFLITO']){
            const e=evento(id);
            if(id==='WH-SEM')e.resource.links=[];
            if(id==='WH-LIVE')e.resource.links[0].href=e.resource.links[0].href.replace('api-m.sandbox','api-m');
            if(id==='WH-CONFLITO')e.resource.links.push({...e.resource.links[0],href:e.resource.links[0].href.replace('CAPTURE123','OUTRA')});
            await enviar(e);assert.equal((await ler(id)).pagamento_id,null);
        }
    });
    await t.test('disputas, reversao e desconhecido persistem sem extrair captura por suposicao',async()=>{
        for(const tipo of ['CUSTOMER.DISPUTE.CREATED','CUSTOMER.DISPUTE.UPDATED','CUSTOMER.DISPUTE.RESOLVED',
            'PAYMENT.CAPTURE.REVERSED','OUTRO.EVENTO']){
            const e={id:`WH-${tipo.replaceAll('.','-')}`,event_type:tipo,resource:{dispute_id:'PP-D-123',
                disputed_transactions:[{seller_transaction_id:'CAPTURE123'}]}};
            await enviar(e);const r=await ler(e.id);assert.equal(r.pagamento_id,null);
            assert.equal(r.estado,tipo==='OUTRO.EVENTO'?'IGNORADO':'RECEBIDO');assert.equal(r.processado_em,null);
        }
    });
    await t.test('falha SQL e COMMIT incerto real nao duplicam nem alteram financeiro',async()=>{
        for(const modo of ['sql','commit-antes','commit-depois']){
            let disparou=false;
            const injetado={getConnection:async()=>{
                const c=await db.getConnection();
                return {...c,query:async(sql,ps)=>{
                    if(modo==='sql'&&sql.startsWith('INSERT INTO ist_loja_pagamento_eventos'))throw Error('SEGREDO-SINTETICO');
                    return c.query(sql,ps);
                },commit:async()=>{
                    if(!disparou&&modo.startsWith('commit')){
                        disparou=true;if(modo==='commit-depois')await c.commit();throw Error('RESPOSTA-COMMIT-PERDIDA');
                    }
                    return c.commit();
                }};
            }};
            const p=criarPersistenciaPagamento({db:injetado,agora:()=>new Date('2026-01-04T00:00:00Z')});
            const e=evento(`WH-FALHA-${modo}`),n=normalizarEventoAdversoPaypal(e,Buffer.from(JSON.stringify(e)));
            const execucao=p.receberEventoAdverso(contexto,n);
            if(modo==='commit-depois')assert.equal((await execucao).reconciliado,true);
            else await assert.rejects(execucao,{codigo:modo==='sql'?'ERRO_PERSISTENCIA':'RESULTADO_DESCONHECIDO'});
            const [[r]]=await admin.query('SELECT COUNT(*) n FROM ist_loja_pagamento_eventos WHERE evento_id=?',[e.id]);
            assert.equal(Number(r.n),modo==='commit-depois'?1:0);
        }
    });
    await t.test('tabelas financeiras intactas e nenhuma escrita em direitos ou tabelas alheias',async()=>{
        assert.equal(await snapshot(),antes);
        for(const sql of consultas)assert.ok(/^(SELECT|SET |INSERT INTO ist_loja_pagamento_eventos)/.test(sql),sql);
    });
    t.diagnostic(`D8_B1_INGESTAO: ${versao}; somente eventos sinteticos; sem aplicacao financeira.`);
});
