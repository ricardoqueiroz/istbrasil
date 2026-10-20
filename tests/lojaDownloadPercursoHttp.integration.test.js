import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {criarPercursoDownload} from './fixtures/lojaDownloadPercursoFixture.js';
import {criarLojaDownloadDireitosService} from '../src/services/lojaDownloadDireitosService.js';

test('D6-B4-R compra sintetica completa e entrega HTTP em MariaDB descartavel',{
    skip:!process.env.IST_LOJA_PAGAMENTOS_MARIADB_BIN&&!process.env.IST_R2_10339_MANIFEST,timeout:180000
},async t=>{
    const f=await criarPercursoDownload(t),{estado}=f;let pago;
    const caso=async(nome,fn)=>{let falhou=false;await t.test(nome,async()=>{try{await fn();}catch(e){falhou=true;throw e;}});if(falhou)throw Error('HOMOLOGACAO_INTERROMPIDA');};
    const negar=async(r,status)=>{assert.equal(r.status,status);assert.doesNotMatch(await r.text(),/%PDF|sha256|comprado.pdf|RECEBEDOR|SELECT/);};
    const ativar=async x=>{await f.capturar(x);assert.equal((await f.enviar(x,'POST')).status,200);};
    await caso('sessao convidada -> publicacao F1 -> pedido comercial -> direito pendente -> captura simulada',async()=>{
        pago=await f.compra();const d=await f.dados(pago);assert.equal(d.direitos.length,1);assert.equal(d.direitos[0].estado,'AGUARDANDO_CONFIRMACAO');
        assert.equal(d.eventos.length,1);assert.equal(d.eventos[0].origem,'PEDIDO');await negar(await f.enviar(pago),409);await f.capturar(pago);
        assert.equal((await f.dados(pago)).direitos[0].estado,'AGUARDANDO_CONFIRMACAO');
    });
    await caso('POST HTTP com sessao/origem/CSRF reais ativa e registra evento uma unica vez',async()=>{
        const r=await f.enviar(pago,'POST');assert.equal(r.status,200);assert.equal((await r.json()).estado,'ATIVO');
        const d=await f.dados(pago);assert.equal(d.eventos.length,2);assert.equal(d.eventos[1].estado_anterior,'AGUARDANDO_CONFIRMACAO');
        assert.equal(d.eventos[1].estado_novo,'ATIVO');assert.equal(d.eventos[1].origem,'FINANCEIRO');
        assert.equal((await f.enviar(pago,'POST')).status,200);assert.deepEqual(await f.dados(pago),d);
    });
    await caso('GET integral: igualdade byte a byte/SHA; preparacao -> autorizacao -> COMMIT -> envio',async()=>{
        const antes=await f.dados(pago);estado.log=[];const r=await f.enviar(pago);assert.equal(r.status,200);
        const bytes=Buffer.from(await r.arrayBuffer());assert.deepEqual(bytes,f.pdf);
        assert.equal(createHash('sha256').update(bytes).digest('hex'),createHash('sha256').update(f.pdf).digest('hex'));
        const log=estado.log;assert(log.indexOf('PREPARACAO')<log.indexOf('PDF_VALIDADO'));
        const auth=log.lastIndexOf('AUTORIZACAO'),commit=log.lastIndexOf('COMMIT'),envio=log.indexOf('ENVIO');
        assert(log.indexOf('PDF_VALIDADO')<auth&&auth<commit&&commit<envio);assert.equal(estado.ativos.size,0);
        assert.deepEqual(await f.dados(pago),antes);
    });
    await caso('HEAD e repeticao GET nao alteram direitos/eventos e ignoram Range/If-Range',async()=>{
        const antes=await f.dados(pago),head=await f.enviar(pago,'HEAD');assert.equal(head.status,200);assert.equal(await head.text(),'');
        for(const headers of [{},{Range:'bytes=0-2'},{Range:'bytes=0-2,5-6','If-Range':'"anterior"'},{'If-None-Match':'*'}]){
            const r=await f.enviar(pago,'GET',undefined,headers);assert.equal(r.status,200);assert.deepEqual(Buffer.from(await r.arrayBuffer()),f.pdf);
            for(const h of ['content-type','content-length','content-disposition','cache-control','accept-ranges','x-content-type-options','referrer-policy','vary'])assert.equal(r.headers.get(h),head.headers.get(h));
            assert.equal(r.headers.get('etag'),null);assert.equal(r.headers.get('last-modified'),null);
        }
        assert.deepEqual(await f.dados(pago),antes);
    });
    await caso('outra sessao, inexistente e token falsificado nao recebem bytes',async()=>{
        const outro=await f.compra(),id=(await f.dados(outro)).direitos[0].public_id;
        await negar(await f.enviar(pago,'GET',id),404);await negar(await f.enviar(pago,'POST',id),404);
        await negar(await f.enviar(pago,'GET',randomUUID()),404);
        await negar(await f.enviar(pago,'GET',undefined,{Cookie:'ist-loja-dev='+'A'.repeat(43)}),401);
    });
    await caso('reavaliacoes POST concorrentes nao duplicam transicao/evento',async()=>{
        const x=await f.compra();await f.capturar(x);
        const rs=await Promise.all([f.enviar(x,'POST'),f.enviar(x,'POST')]);assert(rs.every(r=>r.status===200));
        const d=await f.dados(x);assert.equal(d.eventos.length,2);assert.equal(d.direitos[0].versao,2);
    });
    await caso('falha no evento durante POST reverte UPDATE; tentativa posterior recupera sem duplicar',async()=>{
        const x=await f.compra();await f.capturar(x);const antes=await f.dados(x);estado.falharEvento=true;
        try{await negar(await f.enviar(x,'POST'),503);}finally{estado.falharEvento=false;}
        assert.deepEqual(await f.dados(x),antes);assert.equal(estado.ativos.size,0);
        assert.equal((await f.enviar(x,'POST')).status,200);assert.equal((await f.dados(x)).eventos.length,2);
    });
    await caso('suspensao financeira confirmada durante preparacao impede entrega na autorizacao final',async()=>{
        const x=await f.compra();await ativar(x);let iniciou,liberar;
        const pronto=new Promise(r=>iniciou=r),espera=new Promise(r=>liberar=r);
        estado.preparar=async()=>{iniciou();await espera;};
        const download=f.enviar(x);await pronto;
        try{
            const [[pg]]=await f.a.query('SELECT id FROM ist_loja_pagamentos WHERE public_id=?',[x.pagamento.publicId]);
            await f.a.execute('UPDATE ist_loja_pagamentos SET reembolsado_centavos=50 WHERE id=?',[pg.id]);
            await criarLojaDownloadDireitosService({db:f.db,agora:f.agora}).reavaliarDireitosDoPedido(x.pedidoId,f.contexto);
            assert.equal((await f.dados(x)).direitos[0].estado,'SUSPENSO');
        }finally{estado.preparar=null;liberar();}
        await negar(await download,409);assert.equal(estado.ativos.size,0);
    });
    t.diagnostic(`D6_B4_PERCURSO_HTTP: ${f.identidade.versao}; schema ${f.identidade.banco}; porta ${f.identidade.porta}; PDF sintetico e SHA conferidos; SQL encerrado antes do envio.`);
});
