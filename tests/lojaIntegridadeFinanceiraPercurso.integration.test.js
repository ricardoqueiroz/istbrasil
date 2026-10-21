import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {criarPercursoDownload} from './fixtures/lojaDownloadPercursoFixture.js';
import {criarLojaPagamentoService} from '../src/services/lojaPagamentoService.js';
import {criarProcessadorWebhookPayPal} from '../src/services/lojaPaypalWebhook.js';
import {criarLojaDownloadRecuperacaoService} from '../src/services/lojaDownloadRecuperacaoService.js';

test('D8-B4 pedido real sintetico -> captura simulada -> webhook -> suspensao -> negacao D6/D7',async t=>{
    const f=await criarPercursoDownload(t,{raizTemporariaBase:process.cwd()});
    const {a,pool,contexto,agora}=f;
    await a.query((await readFile(new URL('../migrations/ist_loja_download_recuperacao_fundacao.sql',import.meta.url),'utf8'))
        .replace(/^DELIMITER[^\r\n]*$/gm,'').replace(/END\$\$\s*$/,'END'));
    const x=await f.compra();await f.capturar(x);
    assert.equal((await f.enviar(x,'POST')).status,200);
    const download=await f.enviar(x);assert.equal(download.status,200);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()),f.pdf);
    const [[pg]]=await a.query('SELECT * FROM ist_loja_pagamentos WHERE public_id=?',[x.pagamento.publicId]);
    const historico=async()=>{
        const [itens]=await a.query('SELECT * FROM ist_loja_pedido_itens WHERE pedido_id=? ORDER BY id',[x.pedidoId]);
        const [ops]=await a.query('SELECT * FROM ist_loja_pagamento_operacoes WHERE pagamento_id=? ORDER BY id',[pg.id]);
        const [[cap]]=await a.query('SELECT ordem_externa_id,captura_externa_id,capturado_centavos,capturado_em FROM ist_loja_pagamentos WHERE id=?',[pg.id]);
        return JSON.stringify({itens,ops,cap});
    };
    const original=await historico(),direitos=await f.dados(x);
    const recuperar=criarLojaDownloadRecuperacaoService({db:pool,chaveEmail:randomBytes(32),contextoEsperado:contexto,agora});
    const desafio=await recuperar.criarDesafio('sintetico@example.invalid');
    const sessao=await recuperar.consumirDesafio(desafio.publicId,desafio.segredo);
    const cookie={Cookie:`ist-loja-recuperacao-dev=${sessao.token}`};
    assert.equal((await f.enviar(x,'GET',undefined,cookie)).status,200);
    const recursoId=`REFUND-${randomUUID()}`,eventoId=`WH-${randomUUID()}`;
    let verificacoes=0;
    const adaptador={...x.sim.adaptador,verificarWebhook:async()=>{verificacoes++;return true;},
        consultarEvidenciaAdversa:async({tipo})=>tipo==='CAPTURA'?
            {tipo,recursoId:pg.captura_externa_id,estado:'COMPLETED',valorCentavos:String(pg.capturado_centavos),moeda:'BRL',
                ordemId:pg.ordem_externa_id,contaRecebedora:contexto.contaRecebedora}:
            {tipo:'REEMBOLSO',recursoId,estado:'COMPLETED',valorCentavos:'50',moeda:'BRL',capturaId:pg.captura_externa_id,vinculoInvalido:false}};
    const service=criarLojaPagamentoService({db:pool,adaptador,contexto,agora});
    const receber=criarProcessadorWebhookPayPal({obterWebhookId:()=> 'WH-SINTETICO',obterFinanceiro:()=>({adaptador,service})});
    const corpo=Buffer.from(JSON.stringify({id:eventoId,event_type:'PAYMENT.CAPTURE.REFUNDED',resource_type:'refund',resource_version:'2.0',
        resource:{id:recursoId,status:'COMPLETED',amount:{value:'0.50',currency_code:'BRL'},
            links:[{rel:'up',method:'GET',href:`https://api-m.sandbox.paypal.com/v2/payments/captures/${pg.captura_externa_id}`}]}}));
    await receber({corpo,cabecalhos:{}});assert.equal(verificacoes,1);
    const [[evento]]=await a.query('SELECT pagamento_id,provedor,ambiente,conta_recebedora FROM ist_loja_pagamento_eventos WHERE evento_id=?',[eventoId]);
    assert.equal(Number(evento.pagamento_id),Number(pg.id));assert.equal(evento.provedor,contexto.provedor);
    assert.equal(evento.ambiente,contexto.ambiente);assert.equal(evento.conta_recebedora,contexto.contaRecebedora);
    await service.reconciliarEventoAdverso({eventoId});
    const depois=await f.dados(x);assert.ok(depois.direitos.every(d=>d.estado==='SUSPENSO'));
    assert.equal(depois.eventos.length,direitos.eventos.length+direitos.direitos.length);
    for(const extras of [{},cookie]){
        const r=await f.enviar(x,'GET',undefined,extras);assert.equal(r.status,409);
        assert.doesNotMatch(await r.text(),/%PDF/);
    }
    await receber({corpo,cabecalhos:{}});await service.reconciliarEventoAdverso({eventoId});
    assert.deepEqual(await f.dados(x),depois);assert.equal(await historico(),original);
    assert.equal(x.sim.chamadas.capturar,1);
    t.diagnostic(`D8_B4_PERCURSO: ${f.identidade.versao}; schema ${f.identidade.banco}; porta ${f.identidade.porta}; pedido/captura reais do servico, provedor e PDF sinteticos.`);
});
