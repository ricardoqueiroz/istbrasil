import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {AsyncLocalStorage} from 'node:async_hooks';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {criarFixtureDireitos,contextoDireitos as contexto} from './fixtures/lojaDownloadDireitosFixture.js';
import {criarLojaPagamentoService} from '../src/services/lojaPagamentoService.js';
import {criarLojaPagamentoAdversoWorker} from '../src/services/lojaPagamentoAdversoWorker.js';
import {criarFalhaPagamento} from '../src/services/lojaPagamentoContratos.js';

test('D9-B2 worker SQL: reservas, reinicio, backoff e aplicacao D8 atomica',async t=>{
    const f=await criarFixtureDireitos(t),{a,pool}=f,als=new AsyncLocalStorage();
    let tempo=Date.parse('2026-01-01T13:00:00Z'),falha=null,disparou=false,hook=null,gets=0;
    const agora=()=>new Date(tempo),recursos=new Map(),capturas=new Map(),criados=[];
    const db={getConnection:async()=>{
        const c=await pool.getConnection(),dono=als.getStore();let tx=false,financeiro=false,reserva=false;
        const fim=()=>{if(tx){tx=false;if(dono)dono.tx--;}};
        return {beginTransaction:async()=>{await c.beginTransaction();tx=true;if(dono)dono.tx++;},
            query:async(s,p=[])=>{
                if(s.includes("SET estado='PROCESSANDO'"))reserva=true;
                if(s.startsWith('INSERT INTO ist_loja_pagamento_eventos')&&p.includes('EVIDENCIA_ADVERSA'))financeiro=true;
                if(falha==='sql'&&s.startsWith('INSERT INTO ist_loja_download_direito_eventos')&&!disparou){disparou=true;throw Error('SEGREDO SQL');}
                return c.query(s,p);
            },commit:async()=>{
                if(!disparou&&((financeiro&&['commit-antes','commit-depois'].includes(falha))||(reserva&&falha==='commit-reserva'))){
                    disparou=true;if(falha!=='commit-antes'){await c.commit();fim();}throw Error('COMMIT INCERTO');
                }
                await c.commit();fim();
            },rollback:async()=>{await c.rollback();fim();},release:()=>{assert.equal(tx,false);c.release();},destroy:()=>{fim();c.destroy();}};
    }};
    const adaptador={criar(){assert.fail();},capturar(){assert.fail();},consultar(){assert.fail();},
        consultarEvidenciaAdversa:async x=>{
            assert.equal(als.getStore()?.tx??0,0,'GET fora da transacao desta chamada');gets++;await hook?.(x);
            return x.tipo==='CAPTURA'?capturas.get(x.recursoId):recursos.get(x.recursoId);
        }};
    const service=criarLojaPagamentoService({db,adaptador,contexto,agora});
    const novoWorker=()=>criarLojaPagamentoAdversoWorker({db,contexto,agora,aleatorio:()=>0,reconciliar:x=>service.reconciliarEventoAdverso(x)});
    const rodar=fn=>als.run({tx:0},fn);
    const ler=async id=>(await a.query('SELECT * FROM ist_loja_pagamento_eventos WHERE evento_id=?',[id]))[0][0];
    const preparar=async(valor='50',tipo='refund')=>{
        const x=await f.preparar({estadoDireito:'ATIVO'}),eventoId=`WH-${randomUUID()}`,recursoId=`REC-${randomUUID()}`;
        capturas.set(x.resultado.capturaId,{tipo:'CAPTURA',recursoId:x.resultado.capturaId,estado:'COMPLETED',valorCentavos:'200',moeda:'BRL',
            ordemId:x.resultado.ordemId,contaRecebedora:contexto.contaRecebedora});
        recursos.set(recursoId,tipo==='refund'?{tipo:'REEMBOLSO',recursoId,estado:'COMPLETED',valorCentavos:valor,moeda:'BRL',capturaId:x.resultado.capturaId,vinculoInvalido:false}:
            {tipo:'DISPUTA',recursoId,estado:'OPEN',valorCentavos:'200',moeda:'BRL',transacoesVendedor:[x.resultado.capturaId],vinculoInvalido:false});
        const n=BigInt(valor),evento=tipo==='refund'?{id:eventoId,event_type:'PAYMENT.CAPTURE.REFUNDED',resource_type:'refund',resource_version:'2.0',
            resource:{id:recursoId,status:'COMPLETED',amount:{value:`${n/100n}.${String(n%100n).padStart(2,'0')}`,currency_code:'BRL'},links:[{rel:'up',method:'GET',
                href:`https://api-m.sandbox.paypal.com/v2/payments/captures/${x.resultado.capturaId}`}]}}:
            {id:eventoId,event_type:'CUSTOMER.DISPUTE.CREATED',resource:{dispute_id:recursoId,disputed_transactions:[{seller_transaction_id:x.resultado.capturaId}]}};
        const enviar=()=>service.receberEventoAdverso({evento,corpo:Buffer.from(JSON.stringify(evento))});await enviar();criados.push(eventoId);
        const historico=async()=>JSON.stringify([
            (await a.query('SELECT * FROM ist_loja_pagamento_operacoes WHERE pedido_id=?',[x.pedidoId]))[0],
            (await a.query('SELECT * FROM ist_loja_pedido_itens WHERE pedido_id=?',[x.pedidoId]))[0],
            (await a.query('SELECT captura_externa_id,ordem_externa_id,capturado_centavos,capturado_em FROM ist_loja_pagamentos WHERE id=?',[x.pagamentoId]))[0]]);
        return {x,eventoId,recursoId,enviar,historico};
    };
    const caso=async(nome,fn)=>{
        let falhou=false;await t.test(nome,async()=>{try{await fn();}catch(e){falhou=true;throw e;}});
        if(falhou)throw Error('D9_HOMOLOGACAO_INTERROMPIDA');
        // Teardown apenas de jobs sinteticos deste teste; nenhum caso seguinte
        // deve consumir a reserva intencionalmente abandonada pelo caso anterior.
        for(const id of criados.splice(0))await a.query(`UPDATE ist_loja_pagamento_eventos SET estado='REVISAO',
            execucao_token=NULL,execucao_ate=NULL,proxima_tentativa_em=NULL,codigo_erro='TESTE_ENCERRADO'
            WHERE evento_id=? AND estado<>'PROCESSADO'`,[id]);
        falha=null;hook=null;disparou=false;
    };
    await caso('parcial/integral e disputa: fila reutiliza D8, preserva captura e suspende todos direitos uma vez',async()=>{
        for(const [v,tipo] of [['50','refund'],['200','refund'],['50','disputa']]){
            const c=await preparar(v,tipo),antes=await c.historico(),w=novoWorker();
            const r=await rodar(()=>w.processar());assert.equal(r.length,1);assert.equal((await ler(c.eventoId)).estado,'PROCESSADO');
            const d=await f.ler(c.x);assert(d.direitos.every(x=>x.estado==='SUSPENSO'));const fim=JSON.stringify(d);
            await c.enviar();assert.deepEqual(await rodar(()=>novoWorker().processar()),[]);
            assert.equal(JSON.stringify(await f.ler(c.x)),fim);assert.equal(await c.historico(),antes);
        }
    });
    await caso('dois workers e conexoes independentes: uma reserva e uma transicao por direito',async()=>{
        const c=await preparar(),antes=await f.ler(c.x);
        const r=await Promise.all([rodar(()=>novoWorker().processar()),rodar(()=>novoWorker().processar())]);
        assert.equal(r.flat().length,1);const d=await f.ler(c.x);assert.equal(d.eventos.length,antes.eventos.length+2);
    });
    await caso('dois processos Node distintos e pool sem dateStrings aplicam somente uma vez',async()=>{
        const c=await preparar(),antes=await f.ler(c.x);
        const executar=()=>new Promise((resolve,reject)=>{
            const filho=spawn(process.execPath,[fileURLToPath(new URL('./fixtures/lojaAdversoWorkerProcesso.js',import.meta.url))],
                {windowsHide:true,stdio:['pipe','pipe','pipe']});
            let saida='',diagnostico='';filho.stdout.on('data',x=>saida+=x);filho.stderr.on('data',x=>diagnostico+=x);
            const timer=setTimeout(()=>{filho.kill();reject(Error('PROCESSO_SINTETICO_TIMEOUT'));},30000);
            filho.once('error',e=>{clearTimeout(timer);reject(e);});
            filho.once('exit',codigo=>{clearTimeout(timer);try{assert.equal(codigo,0,/^[A-Z0-9_]{1,64}$/.test(diagnostico)?diagnostico:'FALHA_PROCESSO_SINTETICO');resolve(JSON.parse(saida));}catch(e){reject(e);}});
            filho.stdin.end(JSON.stringify({config:f.config,identidade:f.identidade,tempo,contexto,
                recursos:[...recursos],capturas:[...capturas]}));
        });
        const r=await Promise.all([executar(),executar()]);assert.equal(r.flat().length,1);
        assert.equal((await ler(c.eventoId)).estado,'PROCESSADO');
        assert.equal((await f.ler(c.x)).eventos.length,antes.eventos.length+2);
    });
    await caso('reinicio/reserva expirada: novo token, antigo nao grava nem encerra reserva nova',async()=>{
        const c=await preparar(),w=novoWorker(),a1=await w.reservar();
        await assert.rejects(service.reconciliarEventoAdverso({eventoId:c.eventoId}),{codigo:'D9_RESERVA_PERDIDA'});
        tempo+=121000;const a2=await novoWorker().reservar();assert(!a1.execucaoToken.equals(a2.execucaoToken));
        await assert.rejects(service.reconciliarEventoAdverso(a1),{codigo:'D9_RESERVA_PERDIDA'});
        await assert.rejects(w.registrarFalha(a1,'D9_TRANSITORIO'),{codigo:'D9_RESERVA_PERDIDA'});
        await rodar(()=>service.reconciliarEventoAdverso(a2));assert.equal((await ler(c.eventoId)).estado,'PROCESSADO');
    });
    await caso('expiracao durante GET bloqueia aplicacao e estado financeiro fica intacto',async()=>{
        const c=await preparar(),antes=JSON.stringify(await f.ler(c.x));let entrou=false;
        hook=async()=>{if(!entrou){entrou=true;tempo+=121000;}};
        const r=await rodar(()=>novoWorker().processar({limite:1}));assert.equal(r[0].codigo,'D9_RESERVA_PERDIDA');
        assert.equal(JSON.stringify(await f.ler(c.x)),antes);assert.equal((await ler(c.eventoId)).estado,'PROCESSANDO');
    });
    await caso('falha antes/depois do GET, backoff e limite de oito persistem sem tempestade',async()=>{
        const c=await preparar(),w=novoWorker();hook=async()=>{throw Error('SEGREDO DE REDE');};
        for(let i=1;i<=8;i++){
            const r=await rodar(()=>w.processar({limite:1})),e=await ler(c.eventoId);assert.equal(e.tentativas,i);
            assert.equal(e.execucao_token,null);assert.equal(e.execucao_ate,null);
            if(i<8){assert.equal(e.estado,'RECEBIDO');assert.equal(r[0].codigo,'D9_TRANSITORIO');
                assert.deepEqual(await w.processar(),[]);tempo=Date.parse(e.proxima_tentativa_em.replace(' ','T')+'Z')+1;
            }else{assert.equal(e.estado,'REVISAO');assert.equal(e.codigo_erro,'D9_LIMITE');}
        }
        assert.deepEqual(await w.processar(),[]);assert.equal((await w.diagnosticar()).esgotados,1);
    });
    await caso('falha apos primeiro GET reagenda sem aplicar',async()=>{
        const c=await preparar();hook=async x=>{if(x.tipo==='CAPTURA')throw Error('REDE');};
        assert.equal((await rodar(()=>novoWorker().processar()))[0].codigo,'D9_TRANSITORIO');
        assert.equal((await ler(c.eventoId)).estado,'RECEBIDO');
    });
    await caso('snapshot alterado durante GET exige nova evidencia e backoff',async()=>{
        const c=await preparar();hook=async x=>{if(x.tipo==='CAPTURA')await a.query('UPDATE ist_loja_pagamentos SET versao=versao+1 WHERE id=?',[c.x.pagamentoId]);};
        const r=await rodar(()=>novoWorker().processar({limite:1}));assert.equal(r[0].codigo,'D9_SNAPSHOT');
        assert.equal((await ler(c.eventoId)).estado,'RECEBIDO');assert((await f.ler(c.x)).direitos.every(d=>d.estado==='ATIVO'));
    });
    await caso('reserva abandonada na oitava tentativa vai para revisao sem GET nem tentativa nove',async()=>{
        const c=await preparar(),w=novoWorker();await w.reservar();
        await a.query('UPDATE ist_loja_pagamento_eventos SET tentativas=8 WHERE evento_id=?',[c.eventoId]);tempo+=121000;
        const n=gets;assert.equal((await w.processar())[0].codigo,'D9_LIMITE');assert.equal(gets,n);
        assert.equal((await ler(c.eventoId)).tentativas,8);assert.equal((await ler(c.eventoId)).execucao_token,null);
    });
    await caso('cancelamento durante GET impede efeitos e deixa retentativa limitada',async()=>{
        const c=await preparar(),controle=new AbortController();hook=async()=>controle.abort();
        const r=await rodar(()=>novoWorker().processar({signal:controle.signal}));
        assert.equal(r[0].codigo,'D9_CANCELADO');assert((await f.ler(c.x)).direitos.every(d=>d.estado==='ATIVO'));
    });
    for(const modo of ['sql','commit-antes','commit-depois','commit-reserva'])await caso(`falha/COMMIT incerto: ${modo}`,async()=>{
        const c=await preparar(),antes=JSON.stringify(await f.ler(c.x));falha=modo;
        const r=await rodar(()=>novoWorker().processar({limite:1}));
        if(['commit-depois','commit-reserva'].includes(modo))assert.equal((await ler(c.eventoId)).estado,'PROCESSADO');
        else {assert.equal(JSON.stringify(await f.ler(c.x)),antes);assert(['RECEBIDO','PROCESSANDO'].includes((await ler(c.eventoId)).estado));}
        assert.equal(r.length,1);
    });
    await caso('401/403 tipados pausam contexto de forma duravel; outro ciclo/reinicio nao faz GET',async()=>{
        const c=await preparar();hook=async()=>{throw criarFalhaPagamento({categoria:'AUTENTICACAO',envio:'ENVIADO'});};
        const r=await rodar(()=>novoWorker().processar());assert.equal(r[0].codigo,'D9_AUTENTICACAO');
        const n=gets;assert.equal((await novoWorker().processar())[0].codigo,'D9_AUTENTICACAO');assert.equal(gets,n);
        assert.equal((await ler(c.eventoId)).estado,'REVISAO');
    });
    await caso('contrato insuficiente/sem correlacao/revisao nao entram em loop',async()=>{
        const c=await preparar();recursos.get(c.recursoId).capturaId='NAO-EXISTE';
        const w=novoWorker();await rodar(()=>w.processar());const n=gets;assert.equal((await ler(c.eventoId)).estado,'REVISAO');
        assert.deepEqual(await w.processar(),[]);assert.equal(gets,n);
        const e={id:`WH-${randomUUID()}`,event_type:'PAYMENT.CAPTURE.REVERSED',resource:{}};
        criados.push(e.id);await service.receberEventoAdverso({evento:e,corpo:Buffer.from(JSON.stringify(e))});
        await w.processar();assert.equal((await ler(e.id)).codigo_erro,'D8_RECURSO_NAO_COMPROVADO');
    });
    t.diagnostic(`D9_B2_WORKER: ${f.identidade.versao}; schema ${f.identidade.banco}; porta ${f.identidade.porta}; somente dados sinteticos.`);
});
