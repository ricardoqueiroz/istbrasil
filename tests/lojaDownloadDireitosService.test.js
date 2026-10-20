import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {criarLojaDownloadDireitosService} from '../src/services/lojaDownloadDireitosService.js';
import {criarFixtureDireitos,contextoDireitos as contexto} from './fixtures/lojaDownloadDireitosFixture.js';

const agora=()=>new Date('2026-01-01T13:00:00.000Z');
test('composicao sem efeitos e entradas invalidas antes de abrir conexao',async()=>{
    assert.throws(()=>criarLojaDownloadDireitosService(),{codigo:'CONFIGURACAO_INVALIDA'});
    let chamadas=0;const s=criarLojaDownloadDireitosService({db:{getConnection(){chamadas++;throw Error();}}});
    for(const [id,c]of [[0,contexto],[1,{}],[1,{...contexto,ambiente:'outro'}]])await assert.rejects(s.reavaliarDireitosDoPedido(id,c),{codigo:'CONTEXTO_INVALIDO'});
    assert.equal(chamadas,0);
});
test('conexao suja e descartada sem transacao aninhada',async()=>{
    let destruida=false;const c={query:async sql=>sql.startsWith('SET')?[[]]:[[{transacao:1,autocommit:1}]],destroy(){destruida=true;},beginTransaction(){assert.fail('transacao aninhada');}};
    await assert.rejects(criarLojaDownloadDireitosService({db:{getConnection:async()=>c}}).reavaliarDireitosDoPedido(1,contexto),{codigo:'CONEXAO_INVALIDA'});
    assert.equal(destruida,true);
});

test('transicoes financeiras em MariaDB descartavel',{
    skip:!process.env.IST_LOJA_PAGAMENTOS_MARIADB_BIN&&!process.env.IST_R2_10339_MANIFEST,timeout:180000
},async t=>{
    const f=await criarFixtureDireitos(t),{a,pool,preparar,ler}=f;
    const svc=(db=pool)=>criarLojaDownloadDireitosService({db,agora});
    const executar=(x,s=svc())=>s.reavaliarDireitosDoPedido(x.pedidoId,contexto);
    const envolver=(hook,commit,rollback)=>({async getConnection(){const c=await pool.getConnection();return {
        query:async(sql,p)=>{const r=await hook?.(sql,p,c);return r??c.query(sql,p);},
        beginTransaction:()=>c.beginTransaction(),commit:()=>commit?commit(c):c.commit(),rollback:()=>rollback?rollback(c):c.rollback(),
        release:()=>c.release(),destroy:()=>c.destroy()
    };}});
    const financeiro=async x=>{
        const out=[];for(const [tabela,coluna,id]of [['ist_loja_pedidos','id',x.pedidoId],['ist_loja_pedido_itens','pedido_id',x.pedidoId],
            ['ist_loja_pagamentos','pedido_id',x.pedidoId],['ist_loja_pagamento_operacoes','pedido_id',x.pedidoId],['ist_loja_pagamento_eventos','pagamento_id',x.pagamentoId]])
            out.push((await a.query(`SELECT * FROM ${tabela} WHERE ${coluna}=? ORDER BY id`,[id]))[0]);return out;
    };
    await t.test('ativacao atomica, ordem de locks, timestamp e versao adquirida preservada',async()=>{
        const x=await preparar(),antes=await financeiro(x),chamadas=[];
        const r=await executar(x,svc(envolver(sql=>{chamadas.push(sql);})));assert.equal(r.avaliacao.classificacao,'ELEGIVEL');assert.equal(r.transicoes.length,2);
        const dados=await ler(x);assert.deepEqual(dados.direitos.map(d=>d.estado),['ATIVO','ATIVO']);
        assert.deepEqual(dados.direitos.map(d=>d.versao),[2,2]);assert.deepEqual(dados.direitos.map(d=>d.arquivo_versao_id),[1,2]);
        assert.equal(dados.eventos.length,4);for(const e of dados.eventos.filter(e=>e.direito_versao===2)){assert.equal(e.origem,'FINANCEIRO');assert.equal(e.motivo_codigo,'CAPTURA_CONFIRMADA');}
        const locks=chamadas.filter(sql=>sql.includes('FOR UPDATE'));
        const pos=nome=>locks.findIndex(sql=>sql.includes(`FROM ${nome}`));
        assert(pos('ist_loja_sessoes')<pos('ist_loja_pedidos'));assert(pos('ist_loja_pedidos')<pos('ist_loja_pagamentos'));
        assert(pos('ist_loja_pagamentos')<pos('ist_loja_pagamento_operacoes'));
        assert(pos('ist_loja_pagamento_operacoes')<pos('ist_loja_pagamento_eventos'));
        assert(pos('ist_loja_pagamento_eventos')<pos('ist_loja_download_direitos'));
        assert(pos('ist_loja_download_direitos')<pos('ist_loja_download_direito_eventos'));
        assert.equal(chamadas.some(sql=>/GET_LOCK|FROM ist_loja_produtos .*FOR UPDATE|FROM ist_loja_arquivo_versoes .*FOR UPDATE/.test(sql)),false);
        assert.deepEqual(await financeiro(x),antes);
    });
    await t.test('pagamento apenas pendente nao suspende direito aguardando',async()=>{
        const x=await preparar();await a.execute("UPDATE ist_loja_pedidos SET estado='AGUARDANDO_PAGAMENTO',pagamento_confirmado_em=NULL WHERE id=?",[x.pedidoId]);
        await a.execute("UPDATE ist_loja_pagamentos SET estado='PENDENTE',reserva_ativa=1,encerrado_em=NULL,capturado_centavos=0,capturado_em=NULL WHERE id=?",[x.pagamentoId]);
        await a.execute('UPDATE ist_loja_pagamento_operacoes SET resultado_json=? WHERE id=?',[JSON.stringify({...x.resultado,estado:'PENDENTE',capturadoEm:null}),x.operacaoId]);
        await a.execute('DELETE FROM ist_loja_pagamento_eventos WHERE pagamento_id=?',[x.pagamentoId]);
        const antes=await ler(x),r=await executar(x);assert.equal(r.avaliacao.classificacao,'PENDENTE');assert.deepEqual(r.transicoes,[]);assert.deepEqual(await ler(x),antes);
    });
    for(const caso of ['REVISAO','ADVERSO','CONTRADICAO'])await t.test(`suspensao financeira ${caso} de aguardando e ativo`,async()=>{
        for(const estadoDireito of ['AGUARDANDO_CONFIRMACAO','ATIVO']){
            const x=await preparar({estadoDireito}),antes=await ler(x);
            if(caso==='REVISAO')await a.execute("UPDATE ist_loja_pedidos SET estado='REVISAO',motivo_revisao='SINTETICO' WHERE id=?",[x.pedidoId]);
            if(caso==='ADVERSO')await a.execute('UPDATE ist_loja_pagamentos SET reembolsado_centavos=50 WHERE id=?',[x.pagamentoId]);
            if(caso==='CONTRADICAO')await a.execute('UPDATE ist_loja_pagamentos SET capturado_centavos=199 WHERE id=?',[x.pagamentoId]);
            const r=await executar(x);assert.equal(r.transicoes.length,2);assert(r.transicoes.every(x=>x.estado==='SUSPENSO'));
            const depois=await ler(x);assert.equal(depois.direitos[0].ativado_em,antes.direitos[0].ativado_em);
            assert.deepEqual((await executar(x)).transicoes,[]);assert.deepEqual(await ler(x),depois);
        }
    });
    await t.test('evidencia insuficiente mantem aguardando e suspende ativo, sem autorizacao de download',async()=>{
        for(const estadoDireito of ['AGUARDANDO_CONFIRMACAO','ATIVO']){
            const x=await preparar({estadoDireito});await a.execute('UPDATE ist_loja_pagamento_operacoes SET resultado_json=NULL WHERE id=?',[x.operacaoId]);
            const r=await executar(x);assert.equal(r.avaliacao.elegivel,false);assert.equal(r.transicoes.length,estadoDireito==='ATIVO'?2:0);
            if(estadoDireito==='ATIVO')assert.equal(r.transicoes[0].motivo,'EVIDENCIA_INSUFICIENTE');
        }
    });
    for(const estadoDireito of ['ATIVO','SUSPENSO','REVOGADO'])await t.test(`idempotencia e ausencia de reativacao automatica: ${estadoDireito}`,async()=>{
        const x=await preparar({estadoDireito}),antes=await ler(x);const r=await executar(x);
        assert.equal(r.avaliacao.elegivel,true);assert.deepEqual(r.transicoes,[]);assert.deepEqual(await ler(x),antes);
    });
    await t.test('reembolso total nao produz revogacao inferida',async()=>{
        const x=await preparar({estadoDireito:'ATIVO'});await a.execute("UPDATE ist_loja_pagamentos SET reembolsado_centavos=200,estado='REEMBOLSADO' WHERE id=?",[x.pagamentoId]);
        const r=await executar(x);assert(r.transicoes.every(x=>x.estado==='SUSPENSO'));assert((await ler(x)).direitos.every(d=>d.estado!=='REVOGADO'));
    });
    await t.test('falha no evento depois do UPDATE causa rollback integral',async()=>{
        const x=await preparar(),antes=await ler(x);let updates=0;
        const db=envolver(sql=>{if(sql.startsWith('UPDATE ist_loja_download_direitos'))updates++;if(sql.startsWith('INSERT INTO ist_loja_download_direito_eventos'))throw Error('SEGREDO SQL');});
        await assert.rejects(executar(x,svc(db)),{codigo:'ERRO_PERSISTENCIA'});assert.equal(updates,1);assert.deepEqual(await ler(x),antes);
    });
    await t.test('affectedRows zero no segundo direito reverte primeiro direito e evento',async()=>{
        const x=await preparar(),antes=await ler(x);let n=0;
        const db=envolver(sql=>{if(sql.startsWith('UPDATE ist_loja_download_direitos')&&++n===2)return [{affectedRows:0,warningStatus:0}];});
        await assert.rejects(executar(x,svc(db)),{codigo:'CONFLITO_VERSAO'});assert.deepEqual(await ler(x),antes);
    });
    await t.test('deadlock transitorio faz retry apos rollback, permanente limita a tres',async()=>{
        for(const permanente of [false,true]){
            const x=await preparar(),antes=await ler(x);let n=0,rollbacks=0;
            const db=envolver(sql=>{if(sql.startsWith('UPDATE ist_loja_download_direitos')&&(permanente||n===0)){n++;throw Object.assign(Error('SINTETICO'),{errno:1213,code:'ER_LOCK_DEADLOCK'});}},null,async c=>{rollbacks++;await c.rollback();});
            if(permanente){await assert.rejects(executar(x,svc(db)),{codigo:'CONTENCAO_TEMPORARIA'});assert.equal(n,3);assert.equal(rollbacks,3);assert.deepEqual(await ler(x),antes);}
            else{assert.equal((await executar(x,svc(db))).transicoes.length,2);assert.equal(rollbacks,1);}
        }
    });
    await t.test('falha SQL no avaliador aborta sem suspensao e preserva categoria de retry',async()=>{
        const x=await preparar({estadoDireito:'ATIVO'}),antes=await ler(x);let n=0;
        const db=envolver(sql=>{if(sql.startsWith('SELECT id,sessao_id,estado,ambiente,moeda,versao,motivo_revisao')){n++;throw Object.assign(Error('SINTETICO'),{errno:1213,code:'ER_LOCK_DEADLOCK'});}});
        await assert.rejects(executar(x,svc(db)),{codigo:'CONTENCAO_TEMPORARIA'});assert.equal(n,3);assert.deepEqual(await ler(x),antes);
    });
    for(const efetivado of [true,false])await t.test(`COMMIT incerto efetivado=${efetivado}`,async()=>{
        const x=await preparar(),antes=await ler(x);let commits=0,updates=0;
        const db=envolver(sql=>{if(sql.startsWith('UPDATE ist_loja_download_direitos'))updates++;},async c=>{
            commits++;if(commits===1){if(efetivado)await c.commit();else await c.rollback();throw Error('RESPOSTA_PERDIDA');}await c.commit();
        });
        if(efetivado){const r=await executar(x,svc(db));assert.equal(r.reconciliado,true);assert.equal(r.transicoes.length,2);assert.equal((await ler(x)).eventos.length,4);}
        else{await assert.rejects(executar(x,svc(db)),{codigo:'RESULTADO_DESCONHECIDO'});assert.deepEqual(await ler(x),antes);}
        assert.equal(updates,2);
    });
    await t.test('reconciliacao nao sobrescreve suspensao posterior a COMMIT perdido',async()=>{
        const x=await preparar();let primeiro=true;
        const db=envolver(null,async c=>{await c.commit();if(primeiro){primeiro=false;
            await a.execute('UPDATE ist_loja_pagamentos SET reembolsado_centavos=50 WHERE id=?',[x.pagamentoId]);await executar(x);throw Error('RESPOSTA_PERDIDA');}
        });
        const r=await executar(x,svc(db));assert.equal(r.reconciliado,true);assert.equal(r.avaliacao.classificacao,'ADVERSO');assert(r.direitos.every(d=>d.estado==='SUSPENSO'&&d.versao===3));assert.equal((await ler(x)).eventos.length,6);
    });
    await t.test('financeiro concorrente aguarda sessao e posterior adverso suspende',async()=>{
        const x=await preparar();let liberar,atingiu,pausa=true;const espera=new Promise(r=>liberar=r),pronto=new Promise(r=>atingiu=r);
        const db=envolver(async sql=>{if(pausa&&sql.startsWith('UPDATE ist_loja_download_direitos')){pausa=false;atingiu();await espera;}});
        const exec=executar(x,svc(db));await pronto;
        const w=await pool.getConnection();let terminou=false;
        const writer=(async()=>{await w.beginTransaction();await w.query('SELECT id FROM ist_loja_sessoes WHERE id=? FOR UPDATE',[x.sessaoId]);
            await w.query('SELECT id FROM ist_loja_pedidos WHERE id=? FOR UPDATE',[x.pedidoId]);await w.query('UPDATE ist_loja_pagamentos SET reembolsado_centavos=50 WHERE id=?',[x.pagamentoId]);await w.commit();terminou=true;})();
        try{await new Promise(r=>setTimeout(r,100));assert.equal(terminou,false);}finally{liberar();}
        try{await exec;await writer;assert.equal((await executar(x)).transicoes[0].estado,'SUSPENSO');}finally{await w.rollback();w.release();}
    });
    await t.test('dois processos Node concorrentes nao duplicam versoes ou eventos',async()=>{
        const x=await preparar();const url=new URL('../src/services/lojaDownloadDireitosService.js',import.meta.url).href;
        const code=`import mysql from 'mysql2/promise';import {criarLojaDownloadDireitosService} from ${JSON.stringify(url)};
            let entrada='';for await(const b of process.stdin)entrada+=b;const {config,pedidoId,contexto}=JSON.parse(entrada);
            const db=mysql.createPool(config);try{const r=await criarLojaDownloadDireitosService({db,agora:()=>new Date('2026-01-01T13:00:00.000Z')}).reavaliarDireitosDoPedido(pedidoId,contexto);
            process.stdout.write(JSON.stringify({transicoes:r.transicoes.length}));}catch{process.stderr.write('FALHA_WORKER_SINTETICO');process.exitCode=1;}finally{await db.end();}`;
        const worker=()=>new Promise((resolve,reject)=>{
            const p=spawn(process.execPath,['--input-type=module','-e',code],{cwd:process.cwd(),windowsHide:true,stdio:['pipe','pipe','pipe']});let out='';
            p.stdout.on('data',b=>out+=b);p.stderr.resume();p.on('error',()=>reject(Error('WORKER_INDISPONIVEL')));p.on('close',c=>c===0?resolve(JSON.parse(out)):reject(Error('WORKER_FALHOU')));
            // Credencial exclusiva da fixture: somente stdin, nunca args/env/log.
            p.stdin.end(JSON.stringify({config:f.config,pedidoId:x.pedidoId,contexto}));
        });
        const rs=await Promise.all([worker(),worker()]);assert.equal(rs.reduce((n,r)=>n+r.transicoes,0),2);assert.equal((await ler(x)).eventos.length,4);
    });
    await t.test('historicos sem direitos nao sao reconstruidos; contexto Live divergente nao modifica',async()=>{
        const x=await preparar({semDireitos:true}),antes=await financeiro(x);assert.deepEqual((await executar(x)).transicoes,[]);assert.deepEqual(await ler(x),{direitos:[],eventos:[]});assert.deepEqual(await financeiro(x),antes);
        const y=await preparar(),d=await ler(y);await assert.rejects(svc().reavaliarDireitosDoPedido(y.pedidoId,{...contexto,ambiente:'live'}),{codigo:'CONTEXTO_DIVERGENTE'});assert.deepEqual(await ler(y),d);
    });
    t.diagnostic(`Transicoes homologadas em ${f.identidade.versao}; schema ${f.identidade.banco}; porta ${f.identidade.porta}. Sem banco principal ou PayPal.`);
});
