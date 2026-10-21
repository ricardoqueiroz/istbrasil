import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import http from 'node:http';
import express from 'express';
import {randomBytes} from 'node:crypto';
import {criarConfiguracaoLojaSessao} from '../src/config/lojaSessao.js';
import {criarLojaDownloadRecuperacaoRouter} from '../src/routes/lojaDownloadRecuperacao.routes.js';

const fonte=await readFile(new URL('../src/assets/loja-recuperacao-bootstrap.js',import.meta.url),'utf8');
const id='aa000000-0000-4000-8000-000000000001',segredo='A'.repeat(43);
const executar=(pathname,hash='')=>{
    const elementos=[],historico=[];
    const w={location:{pathname,hash,replace:p=>historico.push(p)},history:{replaceState:(_a,_b,p)=>historico.push(p)}};
    const d={createElement:()=>({}),head:{appendChild:e=>elementos.push(e)}};
    vm.runInNewContext(fonte,{window:w,document:d,URLSearchParams});return {w,elementos,historico};
};
for(const path of ['/loja/recuperar','/loja/biblioteca/confirmar'])test('bootstrap antecipado '+path,()=>{
    const r=executar(path,`#id=${id}&segredo=${segredo}`);
    assert.deepEqual(r.historico,[path]);assert.equal(r.elementos.some(e=>e.href),false);
    assert(r.elementos.some(e=>e.name==='referrer'&&e.content==='no-referrer'));
    assert(r.elementos.some(e=>e.httpEquiv==='Cache-Control'&&e.content==='no-store'));
    const d=r.w.__istRetirarDesafio();assert.equal(d.publicId,id);assert.equal(d.segredo,segredo);assert.equal(r.w.__istRetirarDesafio,undefined);
});
test('bootstrap normal preserva fonte e nao captura fragmentos de outras paginas',()=>{
    const r=executar('/loja','#nao-e-desafio');assert.equal(r.elementos[0].href,'https://fonts.cdnfonts.com/css/lato');assert.equal(r.w.__istRetirarDesafio,undefined);
});
test('bootstrap rejeita parametros duplicados mas limpa a URL',()=>{
    const r=executar('/loja/recuperar',`#id=${id}&segredo=${segredo}&segredo=B`);assert.equal(r.w.__istRetirarDesafio(),null);assert.equal(r.historico.length,1);
});
test('script de limpeza precede recursos e nao ha fonte externa estatica',async()=>{
    const index=await readFile(new URL('../src/index.html',import.meta.url),'utf8');assert(index.indexOf('loja-recuperacao-bootstrap.js')<index.indexOf('rel="icon"'));
    assert(!/<link[^>]+https?:/.test(index));assert(!/localStorage|sessionStorage|console\./.test(fonte));
});

test('GET B2 same-origin sem Origin; POST e preflight continuam estritos, sem banco',async t=>{
    const app=express();let origem;
    app.use('/api/loja/downloads/recuperacao',criarLojaDownloadRecuperacaoRouter({
        obterConfiguracao:()=>criarConfiguracaoLojaSessao({producao:false,origens:[origem],segredoCsrf:randomBytes(32)})
    }));
    const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
    t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
    origem='http://127.0.0.1:'+server.address().port;
    const enviar=(path='/sessao',headers={},method='GET')=>fetch(origem+'/api/loja/downloads/recuperacao'+path,{
        method,headers:{'X-IST-Loja':'1',...headers}
    });
    const valido=await enviar('/sessao',{'Sec-Fetch-Site':'same-origin'});
    assert.equal(valido.status,200);assert.equal(valido.headers.get('access-control-allow-origin'),null);
    assert.match(valido.headers.get('cache-control'),/no-store/);assert.equal((await valido.json()).sessao.autenticada,false);
    for(const headers of [{},{'Sec-Fetch-Site':'same-site'},{'Sec-Fetch-Site':'cross-site'},
        {'Sec-Fetch-Site':'same-origin',Origin:'https://externo.invalid'},
        {'Sec-Fetch-Site':'same-origin','X-IST-Loja':'0'}])assert.equal((await enviar('/sessao',headers)).status>=400,true,JSON.stringify(headers));
    assert.equal((await enviar('/solicitar',{'Sec-Fetch-Site':'same-origin'},'POST')).status,403);
    assert.equal((await enviar('/sessao',{'Sec-Fetch-Site':'same-origin'},'OPTIONS')).status,403);
    assert.equal((await enviar('/sessao',{'Origin':origem})).status,200);
    const hostForjado=await new Promise((resolve,reject)=>{
        const req=http.get(origem+'/api/loja/downloads/recuperacao/sessao',{
            headers:{Host:'externo.invalid','Sec-Fetch-Site':'same-origin','X-IST-Loja':'1'}
        },r=>{r.resume();r.on('end',()=>resolve(r.statusCode));});req.on('error',reject);
    });
    assert.equal(hostForjado,403);
});
