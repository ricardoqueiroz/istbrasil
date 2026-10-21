import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {criarFixtureDireitos,contextoDireitos as contexto} from './fixtures/lojaDownloadDireitosFixture.js';
import {criarLojaDescobertaService} from '../src/services/lojaDescobertaService.js';
import {observarRecursoPaypal,erroDescoberta} from '../src/services/lojaDescobertaContratos.js';
import {criarLojaPagamentoService} from '../src/services/lojaPagamentoService.js';

test('D9-B3 descoberta, checkpoint e reconciliacao API reais em banco descartavel',async t=>{
    const f=await criarFixtureDireitos(t),{a,pool}=f;
    const migration=await readFile(new URL('../migrations/ist_loja_descoberta_adversa.sql',import.meta.url),'utf8');
    await a.query(migration.replace(/^DELIMITER[^\r\n]*$/gm,'').replace(/END\$\$\s*$/,'END'));
    let tempo=Date.parse('2026-01-03T12:00:00Z'),pagina=async()=>({observacoes:[],proxima:null});
    const desde='2026-01-01T00:00:00.000Z',agora=()=>new Date(tempo),recursos=new Map(),capturas=new Map(),consultas=[];
    const adaptador={criar(){assert.fail();},capturar(){assert.fail();},consultar(){assert.fail();},
        listarObservacoesAdversas:async x=>{consultas.push(x);return pagina(x);},
        consultarEvidenciaAdversa:async x=>x.tipo==='CAPTURA'?capturas.get(x.recursoId):recursos.get(x.recursoId)};
    const service=criarLojaPagamentoService({db:pool,adaptador,contexto,agora});
    const engine=()=>criarLojaDescobertaService({db:pool,adaptador,contexto,desde,agora});
    const checkpoint=async fonte=>(await a.query('SELECT * FROM ist_loja_descoberta_checkpoints WHERE fonte=?',[fonte]))[0][0];
    const observados=async()=>(await a.query("SELECT * FROM ist_loja_pagamento_eventos WHERE origem='API' AND evento_id LIKE 'D9-OBS-%' ORDER BY id"))[0];
    const preparar=async()=>{
        const x=await f.preparar({estadoDireito:'ATIVO'}),id=`REF-${randomUUID()}`;
        const raw={id,status:'COMPLETED',amount:{value:'0.50',currency_code:'BRL'},
            links:[{rel:'up',method:'GET',href:`https://api-m.sandbox.paypal.com/v2/payments/captures/${x.resultado.capturaId}`}]};
        recursos.set(id,{tipo:'REEMBOLSO',recursoId:id,estado:'COMPLETED',valorCentavos:'50',moeda:'BRL',capturaId:x.resultado.capturaId,vinculoInvalido:false});
        capturas.set(x.resultado.capturaId,{tipo:'CAPTURA',recursoId:x.resultado.capturaId,estado:'COMPLETED',valorCentavos:'200',moeda:'BRL',
            ordemId:x.resultado.ordemId,contaRecebedora:contexto.contaRecebedora});
        const evento={id:`WH-${randomUUID()}`,event_type:'PAYMENT.CAPTURE.REFUNDED',resource_type:'refund',resource_version:'2.0',resource:raw};
        const historico=async()=>JSON.stringify([
            (await a.query('SELECT * FROM ist_loja_pagamento_operacoes WHERE pedido_id=?',[x.pedidoId]))[0],
            (await a.query('SELECT * FROM ist_loja_pedido_itens WHERE pedido_id=?',[x.pedidoId]))[0],
            (await a.query('SELECT captura_externa_id,ordem_externa_id,capturado_centavos,capturado_em FROM ist_loja_pagamentos WHERE id=?',[x.pagamentoId]))[0]]);
        return {x,raw,evento,observar:()=>observarRecursoPaypal('NOTIFICACOES',evento),historico};
    };
    const caso=async(nome,fn)=>{
        let falhou=false;await t.test(nome,async()=>{try{await fn();}catch(e){falhou=true;throw e;}});
        if(falhou)throw Error('D9_DESCOBERTA_TESTE_INTERROMPIDO');
        // Teardown somente do schema sintetico validado pela fixture.
        await a.query('DELETE FROM ist_loja_descoberta_checkpoints');
        await a.query(`UPDATE ist_loja_pagamento_eventos SET estado='REVISAO',execucao_token=NULL,execucao_ate=NULL,
            proxima_tentativa_em=NULL,codigo_erro='TESTE_ENCERRADO' WHERE origem='API' AND evento_id LIKE 'D9-OBS-%' AND estado<>'PROCESSADO'`);
        consultas.length=0;pagina=async()=>({observacoes:[],proxima:null});
    };
    await caso('notificacao ausente vira observacao API e worker D9-B2 aplica D8 sem webhook ficticio',async()=>{
        const c=await preparar(),antes=await c.historico();pagina=async()=>({observacoes:[c.observar()],proxima:null});
        assert.equal((await engine().executar({fonte:'NOTIFICACOES'})).estado,'CONCLUIDO');
        const rows=await observados(),r=rows.at(-1);assert.equal(r.origem,'API');assert.equal(r.estado,'RECEBIDO');
        assert.equal(JSON.parse(r.evidencia_json).contrato,'PAYPAL_OBSERVACAO_POS_CAPTURA_V1');
        assert.equal((await a.query("SELECT COUNT(*) n FROM ist_loja_pagamento_eventos WHERE origem='WEBHOOK' AND evento_id=?",[c.evento.id]))[0][0].n,'0');
        await service.processarEventosAdversos();assert((await f.ler(c.x)).direitos.every(d=>d.estado==='SUSPENSO'));
        assert.equal(await c.historico(),antes);assert.equal((await checkpoint('NOTIFICACOES')).estado,'PRONTO');
    });
    await caso('notificacao conhecida no webhook nao gera observacao duplicada',async()=>{
        const c=await preparar(),antes=(await observados()).length;
        await service.receberEventoAdverso({evento:c.evento,corpo:Buffer.from(JSON.stringify(c.evento))});
        pagina=async()=>({observacoes:[c.observar()],proxima:null});await engine().executar({fonte:'NOTIFICACOES'});
        assert.equal((await observados()).length,antes);
        await service.processarEventosAdversos();
    });
    await caso('refund ja contabilizado por webhook e nova observacao API nao somam outra vez',async()=>{
        const c=await preparar();await service.receberEventoAdverso({evento:c.evento,corpo:Buffer.from(JSON.stringify(c.evento))});
        await service.processarEventosAdversos();const direitos=JSON.stringify(await f.ler(c.x));
        c.evento.id=`WH-${randomUUID()}`;pagina=async()=>({observacoes:[c.observar()],proxima:null});
        await engine().executar({fonte:'NOTIFICACOES'});await service.processarEventosAdversos();
        const [[pg]]=await a.query('SELECT CAST(reembolsado_centavos AS CHAR) v FROM ist_loja_pagamentos WHERE id=?',[c.x.pagamentoId]);
        assert.equal(pg.v,'50');assert.equal(JSON.stringify(await f.ler(c.x)),direitos);
    });
    await caso('disputa nova/atualizada e resolvida preserva recurso e nao reativa direitos',async()=>{
        const c=await preparar(),recursoId=`PP-D-${randomUUID()}`;
        for(const estado of ['OPEN','RESOLVED']){
            const raw={dispute_id:recursoId,status:estado,update_time:agora().toISOString(),
                dispute_life_cycle_stage:'CHARGEBACK',dispute_channel:'EXTERNAL',dispute_amount:{value:'2.00',currency_code:'BRL'},
                dispute_outcome:{outcome_code:'RESOLVED_SELLER_FAVOUR'},disputed_transactions:[{seller_transaction_id:c.x.resultado.capturaId}],fund_movements:[]};
            recursos.set(recursoId,{tipo:'DISPUTA',recursoId,estado,moeda:'BRL',valorCentavos:'200',transacoesVendedor:[c.x.resultado.capturaId],vinculoInvalido:false});
            pagina=async()=>({observacoes:[observarRecursoPaypal('DISPUTAS',raw)],proxima:null});
            assert.equal((await engine().executar({fonte:'DISPUTAS'})).estado,'CONCLUIDO');await service.processarEventosAdversos();
            assert((await f.ler(c.x)).direitos.every(d=>d.estado==='SUSPENSO'));tempo+=3600001;
        }
    });
    await caso('disputa sem correlacao fica em revisao sem escolher pagamento',async()=>{
        const id=`PP-D-${randomUUID()}`,raw={dispute_id:id,status:'OPEN',disputed_transactions:[{seller_transaction_id:'NAO-LOCAL'}]};
        recursos.set(id,{tipo:'DISPUTA',recursoId:id,transacoesVendedor:['NAO-LOCAL'],vinculoInvalido:false});
        pagina=async()=>({observacoes:[observarRecursoPaypal('DISPUTAS',raw)],proxima:null});
        await engine().executar({fonte:'DISPUTAS'});await service.processarEventosAdversos();
        assert.equal((await observados()).at(-1).estado,'REVISAO');assert.equal((await observados()).at(-1).pagamento_id,null);
    });
    await caso('Transaction Search: mesmo transaction_id com referencias diferentes, sem contabilizacao',async()=>{
        const c=await preparar(),antes=await c.historico(),direitos=JSON.stringify(await f.ler(c.x));
        const items=['REFERENCIA1','REFERENCIA2'].map(ref=>observarRecursoPaypal('TRANSACOES',{transaction_info:{transaction_id:'TXSINTETICO',
            paypal_reference_id:ref,paypal_reference_id_type:'TXN',transaction_event_code:'T1201',transaction_status:'S',transaction_amount:{value:'-0.50',currency_code:'BRL'}}}));
        const n=(await observados()).length;pagina=async()=>({observacoes:[...items,items[0]],proxima:null});
        await engine().executar({fonte:'TRANSACOES'});assert.equal((await observados()).length,n+2);
        assert.equal(await c.historico(),antes);assert.equal(JSON.stringify(await f.ler(c.x)),direitos);
        assert((await observados()).slice(-2).every(x=>x.estado==='REVISAO'&&x.pagamento_id===null));
    });
    await caso('falha intermediaria nao avanca checkpoint; reinicio repete janela e deduplica paginas',async()=>{
        const c=await preparar(),obs=c.observar();let falhar=true;const janelas=[];
        pagina=async x=>{janelas.push([x.inicio,x.fim]);if(x.continuacao&&falhar)throw erroDescoberta('D9_DESCOBERTA_TRANSITORIA');
            return {observacoes:[obs],proxima:x.continuacao?null:'pagina-2'};};
        const n=(await observados()).length;
        await engine().executar({fonte:'NOTIFICACOES'});const cp=await checkpoint('NOTIFICACOES');
        assert.equal(cp.ultima_fim,null);assert(cp.janela_fim);assert.equal(cp.estado,'PRONTO');assert.equal((await observados()).length,n+1);
        tempo+=300001;falhar=false;assert.equal((await engine().executar({fonte:'NOTIFICACOES'})).estado,'CONCLUIDO');
        assert(janelas.every(j=>JSON.stringify(j)===JSON.stringify(janelas[0])));assert.equal((await observados()).length,n+1);
        assert((await checkpoint('NOTIFICACOES')).ultima_fim);
    });
    await caso('duas instancias concorrentes compartilham a reserva sem repetir GET',async()=>{
        let entrou,liberar;const entrada=new Promise(r=>entrou=r),fim=new Promise(r=>liberar=r);
        pagina=async()=>{entrou();await fim;return {observacoes:[],proxima:null};};
        const primeira=engine().executar({fonte:'NOTIFICACOES'});await entrada;
        assert.equal((await engine().executar({fonte:'NOTIFICACOES'})).estado,'SEM_TRABALHO');
        liberar();assert.equal((await primeira).estado,'CONCLUIDO');assert.equal(consultas.length,1);
    });
    await caso('reserva vencida: executor antigo nao persiste pagina nem avanca checkpoint novo',async()=>{
        const c=await preparar(),e=engine(),j1=await e.reservar('NOTIFICACOES');tempo+=300001;
        const outro=engine(),j2=await outro.reservar('NOTIFICACOES');assert(!j1.token.equals(j2.token));
        await assert.rejects(e.persistirPagina(j1,[c.observar()]),{codigo:'D9_DESCOBERTA_RESERVA_PERDIDA'});
        await assert.rejects(e.concluir(j1),{codigo:'D9_DESCOBERTA_RESERVA_PERDIDA'});
        await outro.persistirPagina(j2,[c.observar()]);await outro.concluir(j2);assert((await checkpoint('NOTIFICACOES')).ultima_fim);
    });
    await caso('relatorio respeita atraso de tres horas, sobreposicao e tamanho de janela',async()=>{
        await engine().executar({fonte:'TRANSACOES'});const fim=Date.parse(consultas[0].fim);
        assert(fim<=tempo-10800000);tempo+=86400001;
        await engine().executar({fonte:'TRANSACOES'});assert(Date.parse(consultas[1].inicio)<fim);
        assert(Date.parse(consultas[1].fim)-Date.parse(consultas[1].inicio)<=31*86400000);
    });
    for(const codigo of ['D9_DESCOBERTA_TRANSITORIA','D9_DESCOBERTA_PERMISSAO','D9_DESCOBERTA_CONTRATO'])await caso(`fonte indisponivel/429/permissao: ${codigo}`,async()=>{
        pagina=async()=>{throw erroDescoberta(codigo);};await engine().executar({fonte:'DISPUTAS'});
        const cp=await checkpoint('DISPUTAS');assert.equal(cp.ultima_fim,null);assert.equal(cp.execucao_token,null);
        assert.equal(cp.estado,codigo==='D9_DESCOBERTA_TRANSITORIA'?'PRONTO':'REVISAO');
        const n=consultas.length;await engine().executar({fonte:'DISPUTAS'});assert.equal(consultas.length,n);
    });
    await caso('paginacao repetida falha fechada e checkpoint nao avanca',async()=>{
        pagina=async()=>({observacoes:[],proxima:'mesma-pagina'});await engine().executar({fonte:'NOTIFICACOES'});
        const cp=await checkpoint('NOTIFICACOES');assert.equal(cp.ultima_fim,null);assert.equal(cp.estado,'REVISAO');
    });
    await caso('falha transitoria persistente para apos oito tentativas por janela',async()=>{
        pagina=async()=>{throw erroDescoberta('D9_DESCOBERTA_TRANSITORIA');};
        for(let i=0;i<8;i++){await engine().executar({fonte:'DISPUTAS'});tempo+=300001;}
        const n=consultas.length;await engine().executar({fonte:'DISPUTAS'});
        const cp=await checkpoint('DISPUTAS');assert.equal(consultas.length,n);assert.equal(cp.tentativas,8);
        assert.equal(cp.estado,'REVISAO');assert.equal(cp.ultima_fim,null);assert.equal(cp.codigo_erro,'D9_DESCOBERTA_LIMITE');
    });
    for(const etapa of ['reserva','pagina','conclusao'])for(const depois of [false,true])
        await caso(`D9-B4 COMMIT incerto ${etapa} ${depois?'depois':'antes'}: retomada sem duplicar`,async()=>{
            const c=await preparar(),obs=c.observar(),n=(await observados()).length;
            pagina=async()=>({observacoes:[obs],proxima:null});
            let disparou=false;
            const db={getConnection:async()=>{
                const con=await pool.getConnection();let fase;
                return {query:async(s,p)=>{
                    if(s.includes("SET estado='EXECUTANDO'"))fase='reserva';
                    if(s.startsWith('INSERT INTO ist_loja_pagamento_eventos'))fase='pagina';
                    if(s.includes("SET estado='PRONTO',ultima_inicio"))fase='conclusao';
                    return con.query(s,p);
                },beginTransaction:()=>con.beginTransaction(),rollback:()=>con.rollback(),
                release:()=>con.release(),destroy:()=>con.destroy(),commit:async()=>{
                    if(!disparou&&fase===etapa){disparou=true;if(depois)await con.commit();throw Error('COMMIT_SINTETICO');}
                    return con.commit();
                }};
            }};
            const parcial=criarLojaDescobertaService({db,adaptador,contexto,desde,agora});
            const r=await parcial.executar({fonte:'NOTIFICACOES'});assert(disparou);
            assert.equal(r.codigo,'D9_DESCOBERTA_COMMIT_INCERTO');assert.notEqual(r.estado,'CONCLUIDO');
            const cp=await checkpoint('NOTIFICACOES');
            if(etapa==='conclusao'&&depois){
                assert(cp.ultima_fim);assert.equal(cp.estado,'PRONTO');
                assert.equal((await engine().executar({fonte:'NOTIFICACOES'})).estado,'SEM_TRABALHO');
            }else{
                assert.equal(cp?.ultima_fim??null,null);tempo+=300001;
                assert.equal((await engine().executar({fonte:'NOTIFICACOES'})).estado,'CONCLUIDO');
            }
            assert.equal((await observados()).length,n+1);
            await service.processarEventosAdversos();const fim=await f.ler(c.x);
            await service.processarEventosAdversos();assert.deepEqual(await f.ler(c.x),fim);
            assert(fim.direitos.every(d=>d.estado==='SUSPENSO'));
            assert.equal(Number((await a.query('SELECT reembolsado_centavos n FROM ist_loja_pagamentos WHERE id=?',[c.x.pagamentoId]))[0][0].n),50);
        });
    await caso('migration preserva schema existente, constraints e bloqueia configuracao/destino invalidos',async()=>{
        const sql=migration.replace(/^DELIMITER[^\r\n]*$/gm,'').replace(/END\$\$\s*$/,'END');
        const [constraints]=await a.query(`SELECT CONSTRAINT_NAME FROM information_schema.TABLE_CONSTRAINTS
            WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='ist_loja_descoberta_checkpoints'`);
        for(const nome of ['PRIMARY','uq_ldc_contexto','ck_ldc_contexto','ck_ldc_fonte','ck_ldc_estado','ck_ldc_reserva','ck_ldc_janela','ck_ldc_ultima','ck_ldc_tentativas'])
            assert(constraints.some(x=>x.CONSTRAINT_NAME===nome));
        await assert.rejects(a.query(`INSERT INTO ist_loja_descoberta_checkpoints(provedor,ambiente,conta_recebedora,fonte,estado,
            inicio_configurado,execucao_token,execucao_ate,proxima_execucao,atualizado_em)
            VALUES('paypal','sandbox','SINTETICO','DISPUTAS','EXECUTANDO','2026-01-01',UNHEX(REPEAT('ab',16)),NULL,'2026-01-01','2026-01-01')`),
            e=>e.errno===4025&&/ck_ldc_reserva/.test(e.sqlMessage??''));
        await assert.rejects(a.query(sql),e=>e.code==='ER_TABLE_EXISTS_ERROR');
        await a.query('SET foreign_key_checks=0');try{await assert.rejects(a.query(sql),/D9_DESTINO_OU_CONFIGURACAO_INVALIDA/);}
        finally{await a.query('SET foreign_key_checks=1');}
        const nome=`ist_d9_guard_${randomUUID().replaceAll('-','').slice(0,12)}`;
        await a.query(`CREATE DATABASE ${nome}`);await a.query(`USE ${nome}`);
        try{await assert.rejects(a.query(sql),/D9_DESTINO_OU_CONFIGURACAO_INVALIDA/);}
        finally{await a.query(`USE ${f.identidade.banco}`);}
        // O schema adicional tambem desaparece com a instancia/volume exclusivo.
    });
    t.diagnostic(`D9_B3_DESCOBERTA: ${f.identidade.versao}; schema ${f.identidade.banco}; porta ${f.identidade.porta}; fontes e dados sinteticos.`);
});
