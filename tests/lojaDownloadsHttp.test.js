import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile,unlink,open} from 'node:fs/promises';
import path from 'node:path';
import fs from 'node:fs/promises';
import {ServerResponse} from 'node:http';
import {configurarHttpDownloads as fixture,pdfSintetico as pdf,origemDownload as origem} from './fixtures/lojaDownloadsHttpFixture.js';
import {prepararArquivoValidado} from '../src/services/lojaDownloadArquivoService.js';

const seguro=async(r,status)=>{
    assert.equal(r.status,status);const b=await r.text();assert.doesNotMatch(b,/%PDF|SEGREDO|privado|sha256|SELECT|token|caminho/);return b;
};
test('GET completo: duas autorizacoes, SQL fechado, headers privados e buffer exato',async t=>{
    let f;f=await fixture(t,{opcoes:{prepararArquivo:async(...args)=>{assert.equal(f.estado.tx,0);return prepararArquivoValidado(...args);}}});
    const r=await f.enviar();assert.equal(r.status,200);assert.deepEqual(Buffer.from(await r.arrayBuffer()),pdf);
    assert.equal(f.estado.autorizacoes,2);assert.equal(f.estado.tx,0);assert.equal(f.estado.transicoes,0);
    for(const [k,v]of Object.entries({'content-type':'application/pdf','content-disposition':'attachment; filename="ebook.pdf"',
        'content-length':String(pdf.length),'cache-control':'private, no-store','accept-ranges':'none','x-content-type-options':'nosniff',
        'referrer-policy':'no-referrer','access-control-allow-origin':origem,'access-control-allow-credentials':'true'}))assert.equal(r.headers.get(k),v,k);
    assert.match(r.headers.get('vary'),/Cookie/);assert.match(r.headers.get('vary'),/Origin/);
    assert.equal(r.headers.get('etag'),null);assert.equal(r.headers.get('last-modified'),null);
});
test('HEAD autorizado verifica tudo e retorna comprimento sem corpo',async t=>{
    const f=await fixture(t),r=await f.enviar(undefined,{method:'HEAD'});assert.equal(r.status,200);
    assert.equal(await r.text(),'');assert.equal(r.headers.get('content-length'),String(pdf.length));assert.equal(f.estado.autorizacoes,2);
});
for(const headers of [{Range:'bytes=0-2'},{Range:'bytes=0-2,5-6','If-Range':'"anterior"'},{'If-None-Match':'*','If-Modified-Since':'Wed, 21 Oct 2030 07:28:00 GMT'}])
    test('Range e condicionais nao produzem 206, 304 ou leitura parcial '+JSON.stringify(headers),async t=>{
        const f=await fixture(t),r=await f.enviar(undefined,{headers});assert.equal(r.status,200);assert.deepEqual(Buffer.from(await r.arrayBuffer()),pdf);
    });
for(const caso of ['ausente','expirada','revogada','duplicada'])test('sessao '+caso+' nao entrega PDF',async t=>{
    const f=await fixture(t);if(['expirada','revogada'].includes(caso))f.estado.sessaoInvalida=true;
    const cookie=caso==='ausente'?'':caso==='duplicada'?`ist-loja-dev=${f.token}; ist-loja-dev=${f.token}`:`ist-loja-dev=${f.token}`;
    await seguro(await f.enviar(undefined,{headers:{Cookie:cookie}}),401);assert.equal(f.estado.autorizacoes,0);
});
for(const id of ['malformado',randomUUID()])test('identificador invalido ou alheio nao revela direito '+id,async t=>{
    const f=await fixture(t);await seguro(await f.enviar(`/itens/${id}/arquivo`),404);
});
for(const estado of ['AGUARDANDO_CONFIRMACAO','SUSPENSO','REVOGADO'])test('direito '+estado+' bloqueado sem transicao',async t=>{
    const f=await fixture(t,{dados:{direito:estado}});await seguro(await f.enviar(),409);assert.equal(f.estado.transicoes,0);
    const r=await f.enviar(undefined,{method:'HEAD'});assert.equal(r.status,409);assert.equal(await r.text(),'');
});
test('evidencia adversa bloqueia ATIVO',async t=>{const f=await fixture(t,{dados:{adverso:true}});await seguro(await f.enviar(),409);});
test('segunda autorizacao nega suspensao ocorrida durante preparacao sem entregar bytes',async t=>{
    let f;f=await fixture(t,{opcoes:{prepararArquivo:async(...args)=>{const r=await prepararArquivoValidado(...args);f.estado.direito='SUSPENSO';return r;}}});
    await seguro(await f.enviar(),409);assert.equal(f.estado.autorizacoes,2);
});
test('segunda autorizacao exige exatamente a versao preparada',async t=>{
    let f;f=await fixture(t,{opcoes:{prepararArquivo:async(...args)=>{const r=await prepararArquivoValidado(...args);f.meta.arquivoVersaoId=2;return r;}}});
    await seguro(await f.enviar(),409);
});
test('listagem so retorna campos publicos e nao ativa pendentes',async t=>{
    const f=await fixture(t,{dados:{direito:'AGUARDANDO_CONFIRMACAO'}}),r=await f.enviar('/direitos?limite=1');
    assert.equal(r.status,200);const dto=await r.json();assert.deepEqual(Object.keys(dto.direitos[0]),['publicId','titulo','estado','podeSolicitarArquivo']);
    assert.equal(f.estado.transicoes,0);await seguro(await f.enviar('/direitos?pedidoId=1'),400);
});
test('POST protegido ativa pendente pela fachada e somente apos propriedade',async t=>{
    const f=await fixture(t,{dados:{direito:'AGUARDANDO_CONFIRMACAO'}});
    const post=url=>f.enviar(url,{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':f.csrf},body:'{}'});
    await seguro(await post(`/itens/${randomUUID()}/reavaliar`),404);assert.equal(f.estado.transicoes,0);
    const r=await post(`/itens/${f.publicId}/reavaliar`);assert.equal(r.status,200);assert.deepEqual(await r.json(),{publicId:f.publicId,estado:'ATIVO'});
    assert.equal(f.estado.transicoes,1);
});
test('POST nao reativa suspenso nem aceita pedido/estado do cliente',async t=>{
    const f=await fixture(t,{dados:{direito:'SUSPENSO'}}),url=`/itens/${f.publicId}/reavaliar`;
    const options={method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':f.csrf}};
    await seguro(await f.enviar(url,{...options,body:'{"pedidoId":1,"estado":"ATIVO"}'}),400);
    const r=await f.enviar(url,{...options,body:'{}'});assert.equal((await r.json()).estado,'SUSPENSO');
});
test('POST sem CSRF rejeitado',async t=>{
    const f=await fixture(t);await seguro(await f.enviar(`/itens/${f.publicId}/reavaliar`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}),403);
});
for(const headers of [{Origin:'https://externo.invalid'},{'X-IST-Loja':''},{'Sec-Fetch-Site':'cross-site'},{Origin:'null'}])test('origem/cabecalho inadequado rejeitado '+JSON.stringify(headers),async t=>{
    const f=await fixture(t);await seguro(await f.enviar(undefined,{headers}),403);
});
test('Referer autorizado pode identificar origem de GET; Host nao a substitui',async t=>{
    const f=await fixture(t);const r=await fetch(f.base+'/direitos',{headers:{Cookie:`ist-loja-dev=${f.token}`,'X-IST-Loja':'1',Referer:origem+'/loja'}});assert.equal(r.status,200);
    await seguro(await fetch(f.base+'/direitos',{headers:{Cookie:`ist-loja-dev=${f.token}`,'X-IST-Loja':'1',Host:'localhost:4200'}}),403);
});
test('preflight antes do cors global: origem explicita com credenciais, sem wildcard',async t=>{
    const f=await fixture(t);const r=await f.enviar(undefined,{method:'OPTIONS',headers:{'Access-Control-Request-Method':'GET','Access-Control-Request-Headers':'x-ist-loja'}});
    assert.equal(r.status,204);assert.equal(r.headers.get('access-control-allow-origin'),origem);assert.equal(r.headers.get('access-control-allow-credentials'),'true');
    await seguro(await f.enviar(undefined,{method:'OPTIONS',headers:{Origin:'https://externo.invalid','Access-Control-Request-Method':'GET'}}),403);
});
for(const caso of ['ausente','hash','grande','raiz'])test('preparacao '+caso+' falha 503 sem PDF ou path',async t=>{
    const f=await fixture(t);
    if(caso==='ausente')await unlink(path.join(f.raiz,'arquivo.pdf'));
    if(caso==='hash')await writeFile(path.join(f.raiz,'arquivo.pdf'),Buffer.alloc(pdf.length,65));
    if(caso==='grande'){const h=await open(path.join(f.raiz,'arquivo.pdf'),'r+');try{await h.truncate(32*1024*1024+1);}finally{await h.close();}}
    if(caso==='raiz')f.meta.caminhoRelativo='../privado.pdf';
    await seguro(await f.enviar(),503);assert.equal(f.estado.autorizacoes,1);
});
test('limites de lista 30/min e arquivo 10/min incluem HEAD; janela renova',async t=>{
    const f=await fixture(t);
    for(let n=0;n<30;n++)assert.equal((await f.enviar('/direitos')).status,200);
    await seguro(await f.enviar('/direitos'),429);
    for(let n=0;n<10;n++)assert.equal((await f.enviar(undefined,{method:'HEAD'})).status,200);
    assert.equal((await f.enviar()).status,429);f.estado.instante+=60001;assert.equal((await f.enviar('/direitos')).status,200);
});
test('limite adicional por IP para sessoes invalidas',async t=>{
    const f=await fixture(t);for(let n=0;n<30;n++)assert.equal((await f.enviar('/direitos',{headers:{Cookie:''}})).status,401);
    assert.equal((await f.enviar('/direitos',{headers:{Cookie:''}})).status,429);
});
test('duas entregas simultaneas por sessao; terceira recusada; erro libera slots',async t=>{
    let liberar,pronto,n=0;const espera=new Promise(r=>liberar=r),atingiu=new Promise(r=>pronto=r);
    const f=await fixture(t,{opcoes:{prepararArquivo:async(...args)=>{if(++n===2)pronto();await espera;return prepararArquivoValidado(...args);}}});
    const reqs=[f.enviar(),f.enviar()];
    try{await atingiu;await seguro(await f.enviar(),429);}finally{liberar();}
    for(const r of await Promise.all(reqs))assert.equal(r.status,200);assert.equal((await f.enviar()).status,200);
});
test('desconexao aborta preparacao e libera capacidade da sessao',async t=>{
    let iniciou,abortou,primeira=true;const pronto=new Promise(r=>iniciou=r),fim=new Promise(r=>abortou=r);
    const f=await fixture(t,{opcoes:{prepararArquivo:async(m,c)=>{
        if(primeira){primeira=false;iniciou();await new Promise(resolve=>c.signal.addEventListener('abort',resolve,{once:true}));abortou();throw Error('Cancelada');}
        return prepararArquivoValidado(m,c);
    }}});
    const c=new AbortController(),exec=f.enviar(undefined,{signal:c.signal}).catch(()=>null);await pronto;c.abort();await exec;await fim;
    assert.equal((await f.enviar()).status,200);
});
test('erro tecnico de avaliacao e configuracao ausente retornam 503',async t=>{
    const f=await fixture(t,{opcoes:{autorizacaoService:{async autorizarArquivoNaConexao(){throw Error('SQL /privado TOKEN');}}}});
    await seguro(await f.enviar(),503);
    const g=await fixture(t,{opcoes:{env:{}}});await seguro(await g.enviar(),503);
});
test('cookie malformado e contexto financeiro tecnico divergente nao entregam bytes',async t=>{
    const f=await fixture(t);
    for(const cookie of ['ist-loja-dev=invalido','ist-loja-dev=%41'.repeat(43)])await seguro(await f.enviar(undefined,{headers:{Cookie:cookie}}),401);
    const g=await fixture(t,{opcoes:{contextoEsperado:undefined,env:{IST_LOJA_PAYPAL_ENV:'live'}}});await seguro(await g.enviar(),503);
});
test('falha apos preparar libera slots, sem retornar PDF em erro',async t=>{
    let falhar=true;
    const f=await fixture(t,{opcoes:{prepararArquivo:async(...args)=>{const r=await prepararArquivoValidado(...args);if(falhar)throw Error('FALHA APOS PREPARACAO');return r;}}});
    for(let n=0;n<4;n++)await seguro(await f.enviar(),503);falhar=false;assert.equal((await f.enviar()).status,200);
});
test('falha depois de iniciar resposta encerra conexao sem JSON e libera slots',async t=>{
    const f=await fixture(t),end=ServerResponse.prototype.end;let injetou=false,jsonDepois=false;
    t.mock.method(ServerResponse.prototype,'end',function(chunk,...args){
        if(this.getHeader('Content-Type')==='application/pdf'&&!injetou){injetou=true;this.write(chunk.subarray(0,1));throw Error('FALHA SINTETICA ENVIO');}
        if(injetou&&this.getHeader('Content-Type')==='application/json; charset=utf-8')jsonDepois=true;
        return end.call(this,chunk,...args);
    });
    const r=await f.enviar().catch(()=>null);if(r)await r.arrayBuffer().catch(()=>null);
    assert(injetou);assert.equal(jsonDepois,false);assert.equal((await f.enviar()).status,200);
});
test('quatro preparacoes HTTP globais entre sessoes, quinta recusada e liberacao posterior',async t=>{
    const f=await fixture(t),g=await fixture(t),h=await fixture(t),abrir=fs.open.bind(fs);
    let liberar,pronto,n=0;const espera=new Promise(r=>liberar=r),atingiu=new Promise(r=>pronto=r);
    t.mock.method(fs,'open',async(...args)=>{if(++n===4)pronto();await espera;return abrir(...args);});
    const rs=[f.enviar(),f.enviar(),g.enviar(),g.enviar()];
    try{await atingiu;await seguro(await h.enviar(),429);}finally{liberar();}
    for(const r of await Promise.all(rs))assert.equal(r.status,200);assert.equal((await h.enviar()).status,200);
});
