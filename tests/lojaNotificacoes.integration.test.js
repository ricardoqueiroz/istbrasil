import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setTimeout as pausa} from 'node:timers/promises';
import {criarFixtureNotificacoes} from './fixtures/lojaNotificacoesFixture.js';
import {criarPagamentoSimulado} from './fixtures/lojaPagamentoSimulado.js';
import {criarLojaPagamentoService} from '../src/services/lojaPagamentoService.js';
import {normalizarReconciliacaoPagamento,hashPagamento} from '../src/services/lojaPagamentoContratos.js';

const contexto={provedor:'simulado',ambiente:'sandbox',contaRecebedora:'recebedor-fixture-681'};
const envelope=r=>normalizarReconciliacaoPagamento({resultado:r,observacao:{
    evidencia:'PRESENTE',associacaoOrdem:r.capturaId?'CONFIRMADA':'NAO_DEMONSTRADA',
    validacao:r.capturaId?'CONSISTENTE':'INCONCLUSIVA',statusOrdem:r.capturaId?'COMPLETED':'APPROVED',
    statusCaptura:r.estado==='CAPTURADO'?'COMPLETED':r.estado==='PENDENTE'?'PENDING':null,
    motivoPendencia:r.estado==='PENDENTE'?'PENDING_REVIEW':null}});
const barreira=()=>{let resolver;const promessa=new Promise(r=>{resolver=r;});return {promessa,resolver};};
const aguardar=async p=>{
    let timer;try{return await Promise.race([p,new Promise((_,j)=>{timer=setTimeout(()=>j(Error('BARREIRA_681_TIMEOUT')),10000);})]);}
    finally{clearTimeout(timer);}
};

test('68.1-A SQL real, MariaDB explicitamente selecionado e descartavel', {timeout:120000},async t=>{
    assert.equal(process.platform,'win32');
    const anterior=process.env.NODE_ENV;process.env.NODE_ENV='test';
    t.after(()=>{if(anterior===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=anterior;});
    const {admin,pool,novaCompra,identidade,portaExterna}=await criarFixtureNotificacoes(t);
    assert.match(identidade.banco,/^ist_loja_67_3_[0-9a-f]{12}$/);assert.notEqual(identidade.banco,'istbrasil');
    const c=await pool.getConnection();
    try{
        const [[i]]=await c.query('SELECT DATABASE() banco,@@port porta,@@datadir datadir,@@hostname hostname,VERSION() versao');
        assert.deepEqual(i,identidade);assert.equal(c.connection.config.host,'127.0.0.1');
        assert.equal(Number(c.connection.config.port),portaExterna);
    }finally{c.release();}
    const fonte=(db,adaptador)=>criarLojaPagamentoService({db,adaptador,contexto});
    const novo=async()=>{
        const sim=criarPagamentoSimulado();
        const adaptador={...sim.adaptador,reconciliar:async args=>envelope(await sim.adaptador.consultar(args))};
        const service=fonte(pool,adaptador),compra=await novaCompra();
        const pg=await service.criarTentativa(compra.sessao,{pedidoPublicId:compra.pedidoPublicId},randomUUID());
        return {sim,adaptador,service,compra,pg,chave:randomUUID()};
    };
    const capturar=(m,s=m.service)=>s.capturar(m.compra.sessao,{pagamentoPublicId:m.pg.publicId},m.chave);
    const reconciliar=m=>m.service.reconciliar(m.compra.sessao,{pagamentoPublicId:m.pg.publicId});
    const notificacoes=async m=>(await admin.query('SELECT * FROM ist_loja_notificacoes WHERE pedido_id=?',[m.compra.pedidoId]))[0];
    const webhook=async m=>{
        const [[p]]=await admin.query('SELECT ordem_externa_id,captura_externa_id FROM ist_loja_pagamentos WHERE public_id=?',[m.pg.publicId]);
        const w={eventoId:'WH-'+randomUUID(),tipo:'PAYMENT.CAPTURE.COMPLETED',ordemId:p.ordem_externa_id,capturaId:p.captura_externa_id};
        return {...w,hash:hashPagamento(w)};
    };
    const envolver=hook=>({getConnection:async()=>{
        const c=await pool.getConnection(),[[{id}]]=await c.query('SELECT CONNECTION_ID() id');
        return {query:(sql,args)=>hook(c,Number(id),sql,args),beginTransaction:()=>c.beginTransaction(),
            commit:()=>c.commit(),rollback:()=>c.rollback(),release:()=>c.release(),destroy:()=>c.destroy()};
    }});

    await t.test('migration completa: InnoDB, charset, indices, FK e CHECK',async()=>{
        const [[r]]=await admin.query('SHOW CREATE TABLE ist_loja_notificacoes');
        const ddl=r['Create Table'];assert.match(ddl,/ENGINE=InnoDB/);assert.match(ddl,/ascii_bin/);
        assert.match(ddl,/UNIQUE KEY `uq_lnot_pedido_finalidade` \(`pedido_id`,`finalidade`\)/);
        assert.match(ddl,/FOREIGN KEY \(`pedido_id`\) REFERENCES `ist_loja_pedidos`/);
        for(const nome of ['ck_lnot_estado','ck_lnot_reserva','ck_lnot_conclusao','idx_lnot_processamento'])assert(ddl.includes(nome));
        const [[n]]=await admin.query('SELECT COUNT(*) n FROM ist_loja_notificacoes');assert.equal(Number(n.n),0);
    });
    let confirmado;
    await t.test('PAGO atomico, destinatario, Sandbox e captura/reconciliacao idempotentes',async()=>{
        const m=await novo();confirmado=m;
        assert.equal((await notificacoes(m)).length,0);
        m.sim.aprovado(m.pg.publicId);const r=await capturar(m);assert.equal(r.pedidoEstado,'PAGO');
        const [n]=await notificacoes(m);
        const [[p]]=await admin.query('SELECT comprador_email,ambiente,estado FROM ist_loja_pedidos WHERE id=?',[m.compra.pedidoId]);
        assert.equal(n.destinatario,p.comprador_email);assert.equal(n.ambiente,'sandbox');assert.equal(n.ambiente,p.ambiente);
        assert.equal(n.estado,'PENDENTE');assert.equal(Number(n.tentativas),0);assert.equal(n.reserva_token,null);
        await capturar(m);await reconciliar(m);await reconciliar(m);
        assert.deepEqual(await notificacoes(m),[n]);assert.equal(m.sim.efeitosCaptura,1);
    });
    await t.test('FK, unicidade e estados invalidos rejeitados pelo MariaDB',async()=>{
        const [n]=await notificacoes(confirmado);
        const sql=`INSERT INTO ist_loja_notificacoes(public_id,pedido_id,finalidade,ambiente,destinatario,estado,criado_em,atualizado_em)
            VALUES (?,?,'CONFIRMACAO_COMPRA','sandbox','sintetico@example.invalid','PENDENTE',NOW(3),NOW(3))`;
        await assert.rejects(admin.query(sql,[randomUUID(),confirmado.compra.pedidoId]),e=>e.errno===1062);
        await assert.rejects(admin.query(sql,[randomUUID(),4294967295]),e=>e.errno===1452);
        for(const estado of ['INVALIDO','PROCESSANDO','ENVIADO'])
            await assert.rejects(admin.query('UPDATE ist_loja_notificacoes SET estado=? WHERE id=?',[estado,n.id]),e=>e.errno===4025);
        assert.deepEqual(await notificacoes(confirmado),[n]);
    });
    await t.test('rollback financeiro depois do INSERT real da outbox',async()=>{
        const m=await novo();m.sim.aprovado(m.pg.publicId);let inseriu=false;
        const banco=envolver(async(c,_id,sql,args)=>{
            const r=await c.query(sql,args);
            if(sql.startsWith('INSERT INTO ist_loja_notificacoes')){
                const [[n]]=await c.query('SELECT COUNT(*) n FROM ist_loja_notificacoes WHERE pedido_id=?',[m.compra.pedidoId]);
                assert.equal(Number(n.n),1);inseriu=true;throw Error('FALHA_SQL_SINTETICA_681');
            }return r;
        });
        await assert.rejects(capturar(m,fonte(banco,m.adaptador)));assert(inseriu);
        assert.equal((await notificacoes(m)).length,0);
        const [[p]]=await admin.query('SELECT estado,pagamento_confirmado_em FROM ist_loja_pedidos WHERE id=?',[m.compra.pedidoId]);
        assert.notEqual(p.estado,'PAGO');assert.equal(p.pagamento_confirmado_em,null);
        const [[pg]]=await admin.query('SELECT capturado_centavos FROM ist_loja_pagamentos WHERE public_id=?',[m.pg.publicId]);
        assert.equal(Number(pg.capturado_centavos),0);
    });
    await t.test('webhook confirma pendencia e reentregas nao duplicam',async()=>{
        const m=await novo();m.sim.aprovado(m.pg.publicId);m.sim.modos.captura='pendente';await capturar(m);
        assert.equal((await notificacoes(m)).length,0);m.sim.concluirPendente(m.pg.publicId);
        const w=await webhook(m);await m.service.reconciliarWebhook(w);
        const antes=await notificacoes(m);assert.equal(antes.length,1);
        await m.service.reconciliarWebhook(w);await reconciliar(m);assert.deepEqual(await notificacoes(m),antes);
    });
    await t.test('pedido historico sintetico PAGO sem outbox nao recebe backfill',async()=>{
        const m=await novo();m.sim.aprovado(m.pg.publicId);await capturar(m);
        await admin.query('DELETE FROM ist_loja_notificacoes WHERE pedido_id=?',[m.compra.pedidoId]);
        await capturar(m);await reconciliar(m);await m.service.reconciliarWebhook(await webhook(m));
        assert.equal((await notificacoes(m)).length,0);
    });
    await t.test('conexoes independentes: espera InnoDB B para A, um COMMIT financeiro e uma notificacao',async()=>{
        const m=await novo();m.sim.aprovado(m.pg.publicId);
        const entrou=barreira(),liberar=barreira(),tentou=barreira();let idA,idB,a,b;
        const bancoA=envolver(async(c,id,sql,args)=>{
            const r=await c.query(sql,args);
            if(sql.startsWith('INSERT INTO ist_loja_notificacoes')){idA=id;entrou.resolver();await liberar.promessa;}
            return r;
        });
        const bancoB=envolver(async(c,id,sql,args)=>{
            const pendente=c.query(sql,args);
            if(sql.includes('FROM ist_loja_sessoes')&&sql.includes('FOR UPDATE')){idB=id;tentou.resolver();}
            return pendente;
        });
        try{
            a=capturar(m,fonte(bancoA,m.adaptador));a.catch(()=>{});await aguardar(entrou.promessa);
            b=fonte(bancoB,m.adaptador).reconciliar(m.compra.sessao,{pagamentoPublicId:m.pg.publicId});b.catch(()=>{});
            await aguardar(tentou.promessa);assert.notEqual(idA,idB);
            const fim=Date.now()+6000;let comprovado=false;
            do{
                await pausa(220);
                const [rows]=await admin.query(`SELECT r.trx_mysql_thread_id solicitante,b.trx_mysql_thread_id bloqueador
                    FROM information_schema.INNODB_LOCK_WAITS w
                    JOIN information_schema.INNODB_TRX r ON r.trx_id=w.requesting_trx_id
                    JOIN information_schema.INNODB_TRX b ON b.trx_id=w.blocking_trx_id
                    WHERE r.trx_mysql_thread_id=? AND b.trx_mysql_thread_id=?`,[idB,idA]);
                comprovado=rows.some(r=>Number(r.solicitante)===idB&&Number(r.bloqueador)===idA);
            }while(!comprovado&&Date.now()<fim);
            assert(comprovado,'ESPERA_INNODB_681_NAO_COMPROVADA');
            liberar.resolver();const [ra,rb]=await Promise.all([a,b]);
            assert.equal(ra.pedidoEstado,'PAGO');assert.equal(rb.pedidoEstado,'PAGO');
            assert.equal((await notificacoes(m)).length,1);assert.equal(m.sim.efeitosCaptura,1);
            t.diagnostic(`OUTBOX_LOCK_REAL: A=${idA}; B=${idB}; espera B -> A comprovada no InnoDB; uma notificacao.`);
        }finally{liberar.resolver();await Promise.allSettled([a,b]);}
    });
});
