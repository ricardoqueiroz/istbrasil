import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {readFile,mkdtemp,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {AsyncLocalStorage} from 'node:async_hooks';
import {criarFixtureDireitos,contextoDireitos as contexto} from './fixtures/lojaDownloadDireitosFixture.js';
import {criarLojaPagamentoService} from '../src/services/lojaPagamentoService.js';
import {criarProcessadorWebhookPayPal} from '../src/services/lojaPaypalWebhook.js';
import {criarLojaDownloadsRouter} from '../src/routes/lojaDownloads.routes.js';
import {criarConfiguracaoLojaSessao} from '../src/config/lojaSessao.js';
import {criarLojaDownloadRecuperacaoService} from '../src/services/lojaDownloadRecuperacaoService.js';
import {prepararArquivoValidado} from '../src/services/lojaDownloadArquivoService.js';
import {criarLojaSessaoService} from '../src/services/lojaSessaoService.js';

const agora=()=>new Date('2026-01-01T13:00:00.000Z');
const barreira=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const aguardar=async p=>{
    let timer;try{return await Promise.race([p,new Promise((_,j)=>{timer=setTimeout(()=>j(Error('BARREIRA_NAO_ATINGIDA')),5000);})]);}
    finally{clearTimeout(timer);}
};

test('D8-B3 suspensao atomica, concorrencia e fronteira HTTP D6/D7 em MariaDB descartavel',async t=>{
    const f=await criarFixtureDireitos(t),{a,pool}=f;
    const sql=await readFile(new URL('../migrations/ist_loja_download_recuperacao_fundacao.sql',import.meta.url),'utf8');
    await a.query(sql.replace(/^DELIMITER[^\r\n]*$/gm,'').replace(/END\$\$\s*$/,'END'));
    const pdf=Buffer.from('%PDF-1.7\nD8-B3 SOMENTE SINTETICO\n%%EOF\n'),sha=createHash('sha256').update(pdf).digest();
    await a.query('UPDATE ist_loja_arquivo_versoes SET tamanho_bytes=?,sha256=?',[pdf.length,sha]);
    // O sandbox Windows nega lstat de um ancestral de TEMP. Usar diretorio
    // sintetico exclusivo fora de todos os mounts publicos conhecidos, mantendo
    // a validacao real da raiz (sem stub ou enfraquecimento do servico).
    const raiz=await mkdtemp(path.join(process.cwd(),'.ist-d8-b3-'));
    t.after(async()=>{assert.match(path.basename(raiz),/^\.ist-d8-b3-/);await rm(raiz,{recursive:true});});
    for(const id of [1,2])await writeFile(path.join(raiz,`sintetico-${id}.pdf`),pdf);
    const origem='http://localhost:4200',config=criarConfiguracaoLojaSessao({origens:[origem],segredoCsrf:randomBytes(32)});
    const als=new AsyncLocalStorage();
    const preparar=async(estadoDireito='ATIVO')=>{
        const x=await f.preparar({estadoDireito}),token=randomBytes(32).toString('base64url'),email=`${randomUUID()}@example.invalid`;
        await a.query('UPDATE ist_loja_sessoes SET token_hash=? WHERE id=?',[createHash('sha256').update(token).digest(),x.sessaoId]);
        await a.query('UPDATE ist_loja_pedidos SET comprador_email=? WHERE id=?',[email,x.pedidoId]);
        const antes=await f.ler(x),queries=[];
        let falha=null,disparou=false,perdeuCommit=false,inserts=0;
        const db={getConnection:async()=>{
            const c=await pool.getConnection(),dono=als.getStore();let tx=false,aplicacao=false;
            const fim=()=>{if(tx){tx=false;if(dono)dono.tx--;}};
            return {beginTransaction:async()=>{await c.beginTransaction();tx=true;if(dono)dono.tx++;},
                query:async(s,p=[])=>{
                    queries.push(s);
                    if(s.startsWith('INSERT INTO ist_loja_pagamento_eventos')&&p.includes('EVIDENCIA_ADVERSA'))aplicacao=true;
                    if(falha==='historico'&&s.startsWith('INSERT INTO ist_loja_download_direito_eventos')&&++inserts===2)throw Error('SQL_SINTETICO');
                    if(falha==='update'&&s.startsWith('UPDATE ist_loja_download_direitos'))return [{affectedRows:0}];
                    if(falha==='confirmacao'&&perdeuCommit&&s.includes('FROM ist_loja_download_direito_eventos'))throw Error('LEITURA_SINTETICA');
                    return c.query(s,p);
                },commit:async()=>{
                    if(aplicacao&&!disparou&&['commit-antes','commit-depois','confirmacao'].includes(falha)){
                        disparou=true;if(falha!=='commit-antes'){await c.commit();fim();}perdeuCommit=true;throw Error('COMMIT_SINTETICO');
                    }
                    await c.commit();fim();
                },rollback:async()=>{await c.rollback();fim();},release:()=>{assert.equal(tx,false);c.release();},destroy:()=>{fim();c.destroy();}};
        }};
        const recursos=new Map(),captura={tipo:'CAPTURA',recursoId:x.resultado.capturaId,estado:'COMPLETED',valorCentavos:'200',moeda:'BRL',
            ordemId:x.resultado.ordemId,contaRecebedora:contexto.contaRecebedora};
        let gets=0;
        const adaptador={criar(){assert.fail();},capturar(){assert.fail();},consultar(){assert.fail();},verificarWebhook:async()=>true,
            consultarEvidenciaAdversa:async({tipo,recursoId})=>{
                assert.equal(als.getStore()?.tx??0,0,'consulta externa fora da transacao desta chamada');gets++;
                if(tipo==='CAPTURA')return captura;
                assert.ok(recursos.has(recursoId));return recursos.get(recursoId);
            }};
        const interno=criarLojaPagamentoService({db,adaptador,contexto,agora});
        const service={...interno,reconciliarEventoAdverso:e=>als.run({tx:0},()=>interno.reconciliarEventoAdverso(e))};
        const receber=criarProcessadorWebhookPayPal({obterWebhookId:()=> 'WEBHOOK-TESTE',obterFinanceiro:()=>({adaptador,service})});
        const enviar=async e=>{await receber({corpo:Buffer.from(JSON.stringify(e)),cabecalhos:{}});return e.id;};
        const refund=async(valor='50',recursoId=`REFUND-${randomUUID()}`,eventoId=`WH-${randomUUID()}`)=>{
            recursos.set(recursoId,{tipo:'REEMBOLSO',recursoId,estado:'COMPLETED',valorCentavos:valor,moeda:'BRL',capturaId:x.resultado.capturaId,vinculoInvalido:false});
            const n=BigInt(valor),value=`${n/100n}.${String(n%100n).padStart(2,'0')}`;
            return enviar({id:eventoId,event_type:'PAYMENT.CAPTURE.REFUNDED',resource_type:'refund',resource_version:'2.0',
                resource:{id:recursoId,status:'COMPLETED',amount:{value,currency_code:'BRL'},links:[{rel:'up',method:'GET',
                    href:`https://api-m.sandbox.paypal.com/v2/payments/captures/${x.resultado.capturaId}`}]}});
        };
        const disputa=async(sufixo='CREATED',estado='OPEN',desfecho=null)=>{
            const recursoId=`PP-D-${x.pedidoId}`;
            recursos.set(recursoId,{tipo:'DISPUTA',recursoId,estado,valorCentavos:'200',moeda:'BRL',transacoesVendedor:[x.resultado.capturaId],vinculoInvalido:false,desfecho});
            return enviar({id:`WH-${randomUUID()}`,event_type:`CUSTOMER.DISPUTE.${sufixo}`,resource:{dispute_id:recursoId,status:estado,
                dispute_amount:{value:'2.00',currency_code:'BRL'},disputed_transactions:[{seller_transaction_id:x.resultado.capturaId}]}});
        };
        const snapshot=async()=>{
            const dados=[];
            for(const [tabela,coluna,id]of [['ist_loja_pedidos','id',x.pedidoId],['ist_loja_pagamentos','id',x.pagamentoId],
                ['ist_loja_pagamento_operacoes','id',x.operacaoId],['ist_loja_pagamento_eventos','pagamento_id',x.pagamentoId]])
                dados.push((await a.query(`SELECT * FROM ${tabela} WHERE ${coluna}=? ORDER BY id`,[id]))[0]);
            dados.push(await f.ler(x));return JSON.stringify(dados);
        };
        const historico=async()=>{
            const [ops]=await a.query('SELECT * FROM ist_loja_pagamento_operacoes WHERE id=?',[x.operacaoId]);
            const [itens]=await a.query('SELECT * FROM ist_loja_pedido_itens WHERE pedido_id=?',[x.pedidoId]);
            const [cap]=await a.query('SELECT ordem_externa_id,captura_externa_id,capturado_em,capturado_centavos FROM ist_loja_pagamentos WHERE id=?',[x.pagamentoId]);
            return JSON.stringify({ops,itens,cap});
        };
        return {x,token,email,antes,db,service,refund,disputa,enviar,captura,queries,snapshot,historico,
            ler:()=>f.ler(x),get gets(){return gets;},falhar:modo=>{falha=modo;}};
    };
    for(const estado of ['ATIVO','AGUARDANDO_CONFIRMACAO','SUSPENSO','REVOGADO'])await t.test(`reembolso parcial: ${estado}, idempotencia e historico`,async()=>{
        const c=await preparar(estado),historico=await c.historico(),eventoId=await c.refund();
        c.queries.length=0; // A ordem verificada e da aplicacao, nao da ingestao B1.
        const r=await c.service.reconciliarEventoAdverso({eventoId}),depois=await c.ler();
        assert.deepEqual(depois.direitos.map(d=>d.estado),[estado==='REVOGADO'?'REVOGADO':'SUSPENSO',estado==='REVOGADO'?'REVOGADO':'SUSPENSO']);
        const mudou=['ATIVO','AGUARDANDO_CONFIRMACAO'].includes(estado);
        assert.equal(r.transicoes.length,mudou?2:0);assert.equal(depois.eventos.length,c.antes.eventos.length+(mudou?2:0));
        for(let i=0;i<2;i++){
            assert.equal(depois.direitos[i].arquivo_versao_id,c.antes.direitos[i].arquivo_versao_id);
            assert.equal(depois.direitos[i].versao,c.antes.direitos[i].versao+(mudou?1:0));
            if(!mudou)assert.deepEqual(depois.direitos[i],c.antes.direitos[i]);
        }
        const gets=c.gets;await c.service.reconciliarEventoAdverso({eventoId});assert.equal(c.gets,gets);
        assert.deepEqual(await c.ler(),depois);assert.equal(await c.historico(),historico);
        const locks=c.queries.filter(s=>s.includes('FOR UPDATE'));
        const pos=n=>locks.findIndex(s=>s.includes(`FROM ${n}`));
        const ordem=['ist_loja_sessoes','ist_loja_pedidos','ist_loja_pagamentos','ist_loja_pagamento_operacoes',
            'ist_loja_pagamento_eventos','ist_loja_download_direitos','ist_loja_download_direito_eventos'].map(pos);
        assert.ok(ordem.every((n,i)=>n>=0&&(i===0||n>ordem[i-1])));
    });
    for(const [tipo,status]of [['INTEGRAL',null],['CREATED','OPEN'],['UPDATED','UNDER_REVIEW'],['RESOLVED','RESOLVED']])await t.test(`suspensao ${tipo} e resolucao sem reativacao`,async()=>{
        const c=await preparar(),eventoId=tipo==='INTEGRAL'?await c.refund('200'):await c.disputa(tipo,status,'RESOLVED_SELLER_FAVOUR');
        await c.service.reconciliarEventoAdverso({eventoId});const depois=await c.ler();
        assert.ok(depois.direitos.every(d=>d.estado==='SUSPENSO'));
        if(tipo!=='INTEGRAL'){
            await c.service.reconciliarEventoAdverso({eventoId:await c.disputa('RESOLVED','RESOLVED','RESOLVED_SELLER_FAVOUR')});
            assert.deepEqual(await c.ler(),depois);
        }
    });
    await t.test('evidencia insuficiente mantem revisao e bloqueio; nao fabrica reembolso',async()=>{
        const c=await preparar(),eventoId=await c.refund();c.captura.contaRecebedora=null;
        const r=await c.service.reconciliarEventoAdverso({eventoId});assert.equal(r.classificacao,'INCOMPLETA');
        assert.ok((await c.ler()).direitos.every(d=>d.estado==='SUSPENSO'));
        const [[pg]]=await a.query('SELECT estado,reembolsado_centavos FROM ist_loja_pagamentos WHERE id=?',[c.x.pagamentoId]);
        assert.equal(pg.estado,'REVISAO');assert.equal(Number(pg.reembolsado_centavos),0);
    });
    await t.test('reversao incompleta e sem correlacao nao escolhem direitos para suspender',async()=>{
        const c=await preparar();
        for(const e of [{id:`WH-${randomUUID()}`,event_type:'PAYMENT.CAPTURE.REVERSED',resource:{id:c.x.resultado.capturaId}},
            {id:`WH-${randomUUID()}`,event_type:'CUSTOMER.DISPUTE.CREATED',resource:{dispute_id:'PP-D-INEXISTENTE'}}]){
            const eventoId=await c.enviar(e);await c.service.reconciliarEventoAdverso({eventoId});
        }
        assert.deepEqual(await c.ler(),c.antes);
    });
    await t.test('reversao/chargeback confirmados pelo provedor',{skip:'Contrato de correlacao nao comprovado na B1/B2; nenhuma fixture ficticia.'},()=>{});
    for(const falha of ['historico','update','commit-antes','commit-depois','confirmacao'])await t.test(`atomicidade e confirmacao: ${falha}`,async()=>{
        const c=await preparar(),eventoId=await c.refund(),antes=await c.snapshot();c.falhar(falha);
        if(falha==='commit-depois'){
            const r=await c.service.reconciliarEventoAdverso({eventoId});assert.equal(r.reconciliado,true);
            assert.equal(r.transicoes.length,2);assert.ok((await c.ler()).direitos.every(d=>d.estado==='SUSPENSO'));
        }else{
            await assert.rejects(c.service.reconciliarEventoAdverso({eventoId}),{codigo:falha==='update'?'CONFLITO_VERSAO':
                ['commit-antes','confirmacao'].includes(falha)?'RESULTADO_DESCONHECIDO':'ERRO_PERSISTENCIA'});
            if(falha!=='confirmacao')assert.equal(await c.snapshot(),antes);
            else assert.ok((await c.ler()).direitos.every(d=>d.estado==='SUSPENSO'));
        }
        c.falhar(null);await c.service.reconciliarEventoAdverso({eventoId});
        const depois=await c.ler();assert.equal(depois.eventos.length,c.antes.eventos.length+2);
        assert.ok(depois.direitos.every(d=>d.estado==='SUSPENSO'));
    });
    await t.test('duas reconciliacoes e reentrega nao duplicam suspensoes',async()=>{
        const c=await preparar(),e1=await c.refund('50'),e2=await c.refund('50');
        const eventos=[e1,e2],rs=await Promise.allSettled(eventos.map(eventoId=>c.service.reconciliarEventoAdverso({eventoId})));
        for(let i=0;i<rs.length;i++)if(rs[i].status==='rejected'){
            assert.equal(rs[i].reason.codigo,'EVIDENCIA_DESATUALIZADA');await c.service.reconciliarEventoAdverso({eventoId:eventos[i]});
        }
        const depois=await c.ler();assert.equal(depois.eventos.length,c.antes.eventos.length+2);
        await c.service.reconciliarEventoAdverso({eventoId:e1});assert.deepEqual(await c.ler(),depois);
    });
    await t.test('mesmo webhook e reconciliacoes simultaneas geram uma transicao por direito',async()=>{
        const c=await preparar(),recursoId=`REFUND-${randomUUID()}`,eventoId=await c.refund('50',recursoId);
        const rs=await Promise.all([c.service.reconciliarEventoAdverso({eventoId}),c.service.reconciliarEventoAdverso({eventoId})]);
        assert.equal(rs.flatMap(r=>r.transicoes??[]).length,2);
        const depois=await c.ler();await c.refund('50',recursoId,eventoId);await c.service.reconciliarEventoAdverso({eventoId});
        assert.equal(depois.eventos.length,c.antes.eventos.length+2);assert.deepEqual(await c.ler(),depois);
    });

    const recuperar=async c=>{
        const svc=criarLojaDownloadRecuperacaoService({db:pool,chaveEmail:randomBytes(32),contextoEsperado:contexto,agora});
        const d=await svc.criarDesafio(c.email);return (await svc.consumirDesafio(d.publicId,d.segredo)).token;
    };
    const http=async(c,hook=null)=>{
        const estado={hook,preparacoes:0};
        const app=express();app.use((req,res,next)=>als.run({tx:0},()=>next()));
        app.use('/api/loja/downloads',criarLojaDownloadsRouter({db:c.db,env:{PRODUCTS_PATH:raiz},agora,
            agoraMs:()=>agora().getTime(),contextoEsperado:contexto,obterConfiguracaoSessao:()=>config,
            sessaoService:criarLojaSessaoService({db:pool,agora}),
            prepararArquivo:async(...args)=>{
                assert.equal(als.getStore().tx,0);estado.preparacoes++;
                const r=await prepararArquivoValidado(...args);await estado.hook?.();return r;
            }}));
        const server=await new Promise(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s));});
        t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
        const url=`http://127.0.0.1:${server.address().port}/api/loja/downloads/itens/${c.antes.direitos[0].public_id}/arquivo`;
        const enviar=async(token=c.token,tipo='COMPRA')=>{
            const nome=tipo==='COMPRA'?config.cookie.nome:'ist-loja-recuperacao-dev';
            const r=await fetch(url,{headers:{Origin:origem,'X-IST-Loja':'1',Cookie:`${nome}=${token}`}});
            return {status:r.status,buffer:Buffer.from(await r.arrayBuffer()),tipo:r.headers.get('content-type')};
        };
        return {estado,enviar};
    };
    await t.test('adversidade antes da autorizacao final nega sem preparar nem enviar PDF',async()=>{
        const c=await preparar(),h=await http(c);await c.service.reconciliarEventoAdverso({eventoId:await c.refund()});
        const r=await h.enviar();assert.equal(r.status,409,r.buffer.toString('utf8'));assert.equal(h.estado.preparacoes,0);
        assert.deepEqual(JSON.parse(r.buffer.toString('utf8')),{erro:{codigo:'DIREITO_INDISPONIVEL'}});
        assert.equal(r.buffer.includes(pdf),false);assert.notEqual(r.tipo,'application/pdf');
    });
    for(const tipo of ['COMPRA','RECUPERACAO'])await t.test(`suspensao durante preparacao ${tipo} nega todos os bytes PDF`,async()=>{
        const c=await preparar(),token=tipo==='COMPRA'?c.token:await recuperar(c),entrou=barreira(),liberar=barreira();
        const h=await http(c,async()=>{entrou.resolve();await aguardar(liberar.promise);});
        const pedido=h.enviar(token,tipo);await aguardar(entrou.promise);
        try{await c.service.reconciliarEventoAdverso({eventoId:await c.disputa()});}finally{liberar.resolve();}
        const r=await pedido;assert.equal(r.status,409);assert.equal(h.estado.preparacoes,1);
        assert.deepEqual(JSON.parse(r.buffer.toString('utf8')),{erro:{codigo:'DIREITO_INDISPONIVEL'}});
        assert.equal(r.buffer.includes(pdf),false);assert.notEqual(r.tipo,'application/pdf');
        assert.ok((await c.ler()).direitos.every(d=>d.estado==='SUSPENSO'));
    });
    await t.test('autoridade recuperada nao contorna suspensao e REVOGADO nunca reativa',async()=>{
        const c=await preparar(),token=await recuperar(c),h=await http(c);await c.service.reconciliarEventoAdverso({eventoId:await c.refund()});
        assert.equal((await h.enviar(token,'RECUPERACAO')).status,409);
        const rev=await preparar('REVOGADO'),h2=await http(rev);await rev.service.reconciliarEventoAdverso({eventoId:await rev.disputa('RESOLVED','RESOLVED','RESOLVED_SELLER_FAVOUR')});
        assert.equal((await h2.enviar()).status,409);assert.deepEqual(await rev.ler(),rev.antes);
    });
    await t.test('PDF autorizado antes da adversidade permanece correto; proxima entrega e negada',async()=>{
        const c=await preparar(),h=await http(c),r=await h.enviar();assert.equal(r.status,200,r.buffer.toString('utf8'));assert.deepEqual(r.buffer,pdf);
        await c.service.reconciliarEventoAdverso({eventoId:await c.refund()});assert.equal((await h.enviar()).status,409);
    });
    t.diagnostic(`D8_B3_ATOMICO: ${f.identidade.versao}; schema ${f.identidade.banco}; porta ${f.identidade.porta}; PDFs e compras sinteticos; sem PayPal externo.`);
});
