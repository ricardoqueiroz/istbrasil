import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {criarFixtureNotificacoes} from './fixtures/lojaNotificacoesFixture.js';
import {registrarConfirmacaoCompraNaConexao} from '../src/services/lojaNotificacoesService.js';
import {criarProcessadorNotificacoes} from '../src/services/lojaNotificacoesWorker.js';

test('68.2 worker SQL real isolado com SMTP exclusivamente simulado',{timeout:120000},async t=>{
    const {admin,pool,novaCompra}=await criarFixtureNotificacoes(t);
    let agora=Date.now();
    const preparar=async(ambiente='sandbox')=>{
        await admin.query('DELETE FROM ist_loja_notificacoes'); // only this disposable fixture
        const compra=await novaCompra({ambiente});const instante=new Date(agora).toISOString();
        await admin.query("UPDATE ist_loja_pedidos SET estado='PAGO',pagamento_confirmado_em=? WHERE id=?",[instante.slice(0,23).replace('T',' '),compra.pedidoId]);
        await admin.beginTransaction();
        try{
            const [[p]]=await admin.query('SELECT * FROM ist_loja_pedidos WHERE id=? FOR UPDATE',[compra.pedidoId]);
            await registrarConfirmacaoCompraNaConexao(admin,p,instante);await admin.commit();
        }catch(e){await admin.rollback();throw e;}
        return compra;
    };
    const linha=async()=>(await admin.query('SELECT * FROM ist_loja_notificacoes'))[0][0];
    const worker=enviar=>criarProcessadorNotificacoes({db:pool,enviar,ambiente:'sandbox',comporMensagem:async n=>({to:n.destinatario,subject:'Fixture de worker',text:n.pedido_public_id}),agora:()=>agora,timeoutMs:30,reservaMs:2000});
    const snapshot=async()=>{
        const resultado=[];for(const tabela of ['ist_loja_pedidos','ist_loja_pagamentos','ist_loja_pagamento_operacoes','ist_loja_pagamento_eventos'])
            resultado.push((await admin.query(`SELECT * FROM ${tabela} ORDER BY id`))[0]);
        return JSON.stringify(resultado);
    };
    await t.test('reserva atomica, dois workers, SMTP fora da transacao, destinatario e integridade financeira',async()=>{
        await preparar();const antes=await snapshot();let liberar,entrou,envios=0;
        const pronta=new Promise(r=>{entrou=r;});
        const w=worker(async m=>{envios++;assert.equal(m.to,'fixture@example.invalid');
            const [[s]]=await admin.query('SELECT @@in_transaction tx');assert.equal(Number(s.tx),0);
            entrou();await new Promise(r=>{liberar=r;});});
        const a=w.processar();await pronta;
        try{assert.equal((await worker(()=>{assert.fail('DUPLICADO');}).processar()).reservadas,0);}finally{liberar();}
        assert.equal((await a).enviadas,1);assert.equal(envios,1);assert.equal((await linha()).estado,'ENVIADO');
        assert.equal((await w.processar()).reservadas,0);assert.equal(await snapshot(),antes);
    });
    await t.test('falha comprovada, backoff e limite de cinco tentativas',async()=>{
        await preparar();let envios=0;
        const w=worker(async()=>{envios++;throw {notificacaoNaoEnviada:true};});
        for(let tentativa=1;tentativa<=5;tentativa++){
            const r=await w.processar();assert.equal(r.falhas,1);const n=await linha();assert.equal(n.tentativas,tentativa);
            assert.equal((await w.processar()).reservadas,0);agora+=3600000;
        }
        assert.equal(envios,5);assert.equal((await linha()).proxima_tentativa_em,null);assert.equal((await w.processar()).reservadas,0);
    });
    await t.test('timeout apos possivel aceitacao vira INCERTO e nao reenvia',async()=>{
        await preparar();let envios=0;
        const w=worker(()=>{envios++;return new Promise(()=>{});});
        assert.equal((await w.processar()).incertas,1);assert.equal((await linha()).estado,'INCERTO');
        agora+=3600000;await w.processar();assert.equal(envios,1);
    });
    await t.test('reserva expirada nao confirma nem reenvia; recupera conservadoramente',async()=>{
        await preparar();let envios=0;
        const w=worker(async()=>{envios++;agora+=2500;});
        assert.equal((await w.processar({limite:1})).semReserva,1);
        assert.equal((await linha()).estado,'PROCESSANDO');
        assert.equal((await w.processar()).incertas,1);assert.equal((await linha()).estado,'INCERTO');assert.equal(envios,1);
    });
    await t.test('token adulterado nao permite finalizar uma reserva alheia',async()=>{
        await preparar();
        const w=worker(async()=>{await admin.query('UPDATE ist_loja_notificacoes SET reserva_token=?',[randomBytes(32)]);});
        assert.equal((await w.processar({limite:1})).semReserva,1);assert.equal((await linha()).estado,'PROCESSANDO');
        agora+=2500;assert.equal((await w.processar()).incertas,1);
    });
    await t.test('Live preservado e cancelamento antes de iniciar nao reserva',async()=>{
        await preparar('live');const n=await linha();
        const w=worker(()=>assert.fail('LIVE_PROIBIDO'));assert.equal((await w.processar()).reservadas,0);assert.deepEqual(await linha(),n);
        await preparar();const c=new AbortController();c.abort();assert.equal((await w.processar({signal:c.signal})).reservadas,0);
    });
    await t.test('desligamento durante envio fica INCERTO, sem rejeicao assincrona ou repeticao',async()=>{
        await preparar();const c=new AbortController();let envios=0;
        const w=worker(()=>{envios++;c.abort();return new Promise(()=>{});});
        assert.equal((await w.processar({signal:c.signal})).incertas,1);assert.equal((await linha()).estado,'INCERTO');
        await w.processar();assert.equal(envios,1);
    });
});
