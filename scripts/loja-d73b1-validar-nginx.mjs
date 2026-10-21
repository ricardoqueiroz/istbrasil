import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import net from 'node:net';
const esperar=ms=>new Promise(r=>setTimeout(r,ms));
async function aguardarHost(base) {
    const fim=Date.now()+45000;let etapa='TCP';
    while(Date.now()<fim){
        const tcp=await new Promise(resolve=>{
            const s=net.connect({host:'127.0.0.1',port:13380});
            const concluir=r=>{s.destroy();resolve(r);};
            s.setTimeout(1000,()=>concluir(false));s.once('connect',()=>concluir(true));s.once('error',()=>concluir(false));
        });
        if(tcp){
            etapa='HTTP';
            try{
                const r=await fetch(base+'/',{signal:AbortSignal.timeout(2000)});
                await r.arrayBuffer();
                if(r.status===200){console.log('PRONTIDAO_WINDOWS: TCP e HTTP 200 confirmados em 127.0.0.1:13380.');return;}
            }catch{}
        }
        await esperar(1000);
    }
    throw new Error(`NGINX_PRONTIDAO_TIMEOUT_${etapa}: 127.0.0.1:13380; limite 45s, sem detalhes de resposta.`);
}
const conf=await readFile(new URL('../nginx.conf',import.meta.url),'utf8');
const protegido=conf.match(/        location ~ \^\/loja\/\(recuperar\|biblioteca\/confirmar\)\/\?\$ \{[\s\S]*?\n        \}/)?.[0];
const geral=conf.match(/        location \/ \{\s*try_files \$uri \$uri\/ \/index\.html;\s*\}/)?.[0];
assert(protegido&&geral,'Blocos Nginx divergentes; interromper.');
if(process.argv[2]==='--config'&&process.argv.length===3){
    // Documento sintetico da imagem oficial. Nao usa build, PDFs ou dados locais.
    process.stdout.write(`pid /tmp/nginx.pid; events { worker_connections 32; } http { include /etc/nginx/mime.types; server {
        listen 8080; root /usr/share/nginx/html; ${protegido}\n${geral}\n} }`);
}else if(process.argv[2]==='--test'&&process.argv.length===3){
    const base='http://127.0.0.1:13380';
    await aguardarHost(base);
    const inicial=await fetch(base+'/',{signal:AbortSignal.timeout(3000)}),html=await inicial.text();assert.equal(inicial.status,200);
    assert.equal(inicial.headers.get('cache-control'),null);
    for(const path of ['/loja/recuperar','/loja/recuperar/','/loja/biblioteca/confirmar','/loja/biblioteca/confirmar/?teste=sintetico']){
        const r=await fetch(base+path,{signal:AbortSignal.timeout(3000),headers:{'If-Modified-Since':'Wed, 01 Jan 2031 00:00:00 GMT','If-None-Match':'"sintetico"'}});
        assert.equal(r.status,200);assert.equal(await r.text(),html);assert.equal(r.headers.get('cache-control'),'private, no-store, max-age=0');
        assert.equal(r.headers.get('referrer-policy'),'no-referrer');assert.equal(r.headers.get('etag'),null);
        assert(!/segredo|token/i.test([...r.headers].map(([k,v])=>k+':'+v).join('\n')));
        console.log(`HTTP_CONFIRMAR ${path}: 200; Cache-Control=${r.headers.get('cache-control')}; Referrer-Policy=${r.headers.get('referrer-policy')}; HTML igual ao index sintetico.`);
    }
    for(const path of ['/loja','/loja/biblioteca','/loja/biblioteca/recuperar','/editora']){
        const outra=await fetch(base+path,{signal:AbortSignal.timeout(3000)});assert.equal(outra.status,200);assert.equal(await outra.text(),html);
        assert.equal(outra.headers.get('cache-control'),null);assert.equal(outra.headers.get('referrer-policy'),null);
        console.log(`HTTP_SPA ${path}: 200; fallback preservado.`);
    }
    for(const path of ['/istbrasil.private/products/livros/sonda-sintetica.pdf','/private/sonda-sintetica.pdf']){
        const r=await fetch(base+path,{signal:AbortSignal.timeout(3000)});assert.equal(r.status,200);assert.match(r.headers.get('content-type'),/text\/html/);
        assert.equal(await r.text(),html);console.log(`PRIVADO ${path}: somente fallback HTML sintetico, sem PDF.`);
    }
    console.log('D7_3_B1_NGINX: 4 URLs protegidas HTTP 200/no-store/no-referrer; fallback SPA e demais paginas preservados.');
}else{throw Error('Uso: --config ou --test; nao aceita destino externo.');}
