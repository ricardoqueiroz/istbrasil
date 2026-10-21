import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {criarPercursoDownload} from './fixtures/lojaDownloadPercursoFixture.js';
import {criarLojaPagamentoService} from '../src/services/lojaPagamentoService.js';
import {criarProcessadorWebhookPayPal} from '../src/services/lojaPaypalWebhook.js';
import {observarRecursoPaypal} from '../src/services/lojaDescobertaContratos.js';
import {criarLojaDownloadRecuperacaoService} from '../src/services/lojaDownloadRecuperacaoService.js';
import {iniciarDescobertaLoja,iniciarWorkerAdversoLoja} from '../src/services/lojaPagamentoAgendador.js';

test('D9-B4 combinacoes independentes de flags, sem ativacao implicita ou ciclo imediato',async()=>{
    for(const d of [false,true])for(const w of [false,true]){
        let ciclos=0,chamadas=0;
        const env={IST_LOJA_DESCOBERTA_ATIVA:String(d),IST_LOJA_ADVERSOS_ATIVA:String(w),
            IST_LOJA_DESCOBERTA_FONTES:'NOTIFICACOES',IST_LOJA_DESCOBERTA_DESDE:'2026-01-01T00:00:00Z'};
        const service={descobrirEventosAdversos:()=>chamadas++,processarEventosAdversos:()=>chamadas++,diagnosticarEventosAdversos:()=>({})};
        const opcoes={env,obterFinanceiro:()=>({service}),agendar:()=>{ciclos++;return {unref(){}};},cancelar(){}};
        const descoberta=iniciarDescobertaLoja(opcoes),worker=iniciarWorkerAdversoLoja(opcoes);
        assert.equal(descoberta.ativo,d);assert.equal(worker.ativo,w);assert.equal(ciclos,Number(d)+Number(w));
        assert.equal(chamadas,0);await descoberta.parar();await worker.parar();
    }
});

test('D9-B4 descoberta e webhook -> worker -> D8 -> negacao HTTP D6/D7',async t=>{
    const f=await criarPercursoDownload(t,{raizTemporariaBase:process.cwd()}),{a,pool,contexto,agora}=f;
    for(const nome of ['ist_loja_download_recuperacao_fundacao.sql','ist_loja_descoberta_adversa.sql'])
        await a.query((await readFile(new URL(`../migrations/${nome}`,import.meta.url),'utf8'))
            .replace(/^DELIMITER[^\r\n]*$/gm,'').replace(/END\$\$\s*$/,'END'));
    const x=await f.compra();await f.capturar(x);assert.equal((await f.enviar(x,'POST')).status,200);
    assert.deepEqual(Buffer.from(await (await f.enviar(x)).arrayBuffer()),f.pdf);
    const [[pg]]=await a.query('SELECT * FROM ist_loja_pagamentos WHERE public_id=?',[x.pagamento.publicId]);
    const historico=async()=>JSON.stringify([
        (await a.query('SELECT * FROM ist_loja_pedido_itens WHERE pedido_id=? ORDER BY id',[x.pedidoId]))[0],
        (await a.query('SELECT * FROM ist_loja_pagamento_operacoes WHERE pagamento_id=? ORDER BY id',[pg.id]))[0],
        (await a.query('SELECT ordem_externa_id,captura_externa_id,capturado_centavos,capturado_em FROM ist_loja_pagamentos WHERE id=?',[pg.id]))[0],
        (await a.query("SELECT * FROM ist_loja_pagamento_eventos WHERE pagamento_id=? AND tipo='CAPTURADO' ORDER BY id",[pg.id]))[0]]);
    const original=await historico(),direitos=await f.dados(x);
    const recuperar=criarLojaDownloadRecuperacaoService({db:pool,chaveEmail:randomBytes(32),contextoEsperado:contexto,agora});
    const desafio=await recuperar.criarDesafio('sintetico@example.invalid');
    const sessao=await recuperar.consumirDesafio(desafio.publicId,desafio.segredo);
    const cookie={Cookie:`ist-loja-recuperacao-dev=${sessao.token}`};
    assert.equal((await f.enviar(x,'GET',undefined,cookie)).status,200);
    const recursoId=`REFUND-${randomUUID()}`,eventoId=`WH-${randomUUID()}`;
    const evento={id:eventoId,event_type:'PAYMENT.CAPTURE.REFUNDED',resource_type:'refund',resource_version:'2.0',
        resource:{id:recursoId,status:'COMPLETED',amount:{value:'0.50',currency_code:'BRL'},links:[{rel:'up',method:'GET',
            href:`https://api-m.sandbox.paypal.com/v2/payments/captures/${pg.captura_externa_id}`}]}};
    let verificacoes=0,paginas=0;
    const adaptador={...x.sim.adaptador,verificarWebhook:async()=>{verificacoes++;return true;},
        listarObservacoesAdversas:async()=>{paginas++;return {observacoes:[observarRecursoPaypal('NOTIFICACOES',evento)],proxima:null};},
        consultarEvidenciaAdversa:async({tipo})=>tipo==='CAPTURA'?
            {tipo,recursoId:pg.captura_externa_id,estado:'COMPLETED',valorCentavos:String(pg.capturado_centavos),moeda:'BRL',
                ordemId:pg.ordem_externa_id,contaRecebedora:contexto.contaRecebedora}:
            {tipo:'REEMBOLSO',recursoId,estado:'COMPLETED',valorCentavos:'50',moeda:'BRL',capturaId:pg.captura_externa_id,vinculoInvalido:false}};
    const service=criarLojaPagamentoService({db:pool,adaptador,contexto,agora});
    const receber=criarProcessadorWebhookPayPal({obterWebhookId:()=> 'WH-SINTETICO',obterFinanceiro:()=>({adaptador,service})});
    const corpo=Buffer.from(JSON.stringify(evento));
    await t.test('descoberta habilitada com worker desligado persiste sem aplicar financeiro',async()=>{
        let tick;const env={IST_LOJA_DESCOBERTA_ATIVA:'true',IST_LOJA_DESCOBERTA_FONTES:'NOTIFICACOES',
            IST_LOJA_DESCOBERTA_DESDE:'2026-01-01T00:00:00Z',IST_LOJA_ADVERSOS_ATIVA:'false'};
        const worker=iniciarWorkerAdversoLoja({env,obterFinanceiro:()=>assert.fail('Worker desligado nao deve compor')});
        assert.equal(worker.ativo,false);
        let concluir;const concluido=new Promise(r=>concluir=r);
        const fachada={...service,descobrirEventosAdversos:async args=>{
            try{return await service.descobrirEventosAdversos(args);}finally{concluir();}
        }};
        const descoberta=iniciarDescobertaLoja({env,obterFinanceiro:()=>({service:fachada}),
            agendar:fn=>{tick=fn;return {unref(){}};},cancelar(){},registrar(){}});
        assert.equal(descoberta.ativo,true);tick();await concluido;await descoberta.parar();await worker.parar();
        assert.equal(paginas,1);
        const [[r]]=await a.query("SELECT origem,estado FROM ist_loja_pagamento_eventos WHERE evento_id LIKE 'D9-OBS-%'");
        assert.equal(r.origem,'API');assert.equal(r.estado,'RECEBIDO');assert.deepEqual(await f.dados(x),direitos);
        assert.equal(await historico(),original);
        assert.equal(Number((await a.query('SELECT reembolsado_centavos n FROM ist_loja_pagamentos WHERE id=?',[pg.id]))[0][0].n),0);
    });
    await t.test('worker aplica observacao; suspensao e bloqueio HTTP nas duas autoridades',async()=>{
        await service.processarEventosAdversos();const depois=await f.dados(x);
        assert(depois.direitos.every(d=>d.estado==='SUSPENSO'));
        assert.equal(depois.eventos.length,direitos.eventos.length+direitos.direitos.length);
        for(const extras of [{},cookie])for(const metodo of ['GET','HEAD']){
            const r=await f.enviar(x,metodo,undefined,extras);assert.equal(r.status,409);
            assert.notEqual(r.headers.get('content-type'),'application/pdf');assert.doesNotMatch(await r.text(),/%PDF/);
        }
        assert.equal(await historico(),original);
    });
    await t.test('webhook autenticado posterior e reentrega nao duplicam refund nem suspensao',async()=>{
        const antes=await f.dados(x);
        for(let i=0;i<2;i++){await receber({corpo,cabecalhos:{}});await service.processarEventosAdversos();}
        assert.equal(verificacoes,2);assert.deepEqual(await f.dados(x),antes);
        const [[p]]=await a.query('SELECT reembolsado_centavos n FROM ist_loja_pagamentos WHERE id=?',[pg.id]);assert.equal(Number(p.n),50);
        const [origens]=await a.query("SELECT origem FROM ist_loja_pagamento_eventos WHERE tipo IN ('REVISAO_FINANCEIRA','PAYMENT.CAPTURE.REFUNDED')");
        assert(origens.some(r=>r.origem==='API'));assert(origens.some(r=>r.origem==='WEBHOOK'));
        assert.equal(await historico(),original);assert.equal(x.sim.chamadas.capturar,1);
    });
    t.diagnostic(`D9_B4_PERCURSO: ${f.identidade.versao}; schema ${f.identidade.banco}; porta ${f.identidade.porta}; descoberta/API e webhook simulados, worker real, D8 e HTTP D6/D7 reais; PDF sintetico.`);
});
