import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink,readdir,link} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import express from 'express';
import sharp from 'sharp';
import {armazenarCapaAdmin,criarEntregaCapasLivros} from '../src/services/lojaCapaService.js';
import {createPm2Adapter} from '../scripts/deploy/production-operation.mjs';

const preparar=async t=>{
    const base=await mkdtemp(path.join(tmpdir(),'ist-capas-persistentes-'));
    t.after(()=>rm(base,{recursive:true,force:true}));
    const storage=path.join(base,'uploads','livros'),a=path.join(base,'releases','a'),b=path.join(base,'releases','b');
    for(const dir of [storage,path.join(a,'src/assets/images/livros'),path.join(b,'src/assets/images/livros')])await mkdir(dir,{recursive:true});
    const env={CAPAS_LIVROS_STORAGE_PATH:storage};
    const bytes=await sharp({create:{width:186,height:260,channels:3,background:'white'}}).png().toBuffer();
    const servir=async(raizProjeto,config=env)=>{
        const app=express();app.use('/assets/images/livros',criarEntregaCapasLivros({raizProjeto,env:config}));
        const s=app.listen(0,'127.0.0.1');await new Promise((r,j)=>{s.once('listening',r);s.once('error',j);});
        t.after(async()=>{s.closeAllConnections();await new Promise(r=>s.close(r));});
        return `http://127.0.0.1:${s.address().port}/`;
    };
    return {base,storage,a,b,env,bytes,servir};
};

test('upload persiste fora das releases, leitura em B e rollback A preservam URL e bytes',async t=>{
    const f=await preparar(t);
    await writeFile(path.join(f.storage,'existente.png'),f.bytes);
    const item=await armazenarCapaAdmin(f.bytes,{env:f.env,raizProjeto:f.a});
    assert.match(item.img,/^assets\/images\/livros\/[a-f0-9-]{36}\.webp$/);
    const nome=path.basename(item.img),gravado=await readFile(path.join(f.storage,nome));
    for(const release of [f.a,f.b,f.a]){
        const url=await f.servir(release),r=await fetch(url+item.img);
        assert.equal(r.status,200);assert.equal(r.headers.get('x-content-type-options'),'nosniff');
        assert.deepEqual(Buffer.from(await r.arrayBuffer()),gravado);
        assert.equal((await fetch(url+item.img,{method:'HEAD'})).status,200);
    }
    assert.deepEqual(await readFile(path.join(f.storage,'existente.png')),f.bytes);
    assert.deepEqual(await readdir(path.join(f.a,'src/assets/images/livros')),[]);
    assert.deepEqual(await readdir(path.join(f.b,'src/assets/images/livros')),[]);
});

test('capas legadas continuam disponiveis sem copia ou sobrescrita',async t=>{
    const f=await preparar(t),legada=path.join(f.a,'src/assets/images/livros/legada.png');
    await writeFile(legada,f.bytes);const url=await f.servir(f.a);
    assert.equal((await fetch(url+'assets/images/livros/legada.png')).status,200);
    assert.deepEqual(await readFile(legada),f.bytes);assert.deepEqual(await readdir(f.storage),[]);
    const anterior=await f.servir(f.a,{});
    assert.equal((await fetch(anterior+'assets/images/livros/legada.png')).status,404);
});

test('diretorio persistente invalido nao causa fallback de escrita',async t=>{
    const f=await preparar(t);
    for(const alvo of ['relativo',path.parse(f.base).root,f.a,path.join(f.a,'src'),path.join(f.base,'ausente')]){
        await assert.rejects(armazenarCapaAdmin(f.bytes,{raizProjeto:f.a,env:{...f.env,CAPAS_LIVROS_STORAGE_PATH:alvo}}));
    }
    await assert.rejects(armazenarCapaAdmin(f.bytes,{raizProjeto:f.a,env:{...f.env,PRODUCTS_LIVROS_PATH:f.storage}}));
    assert.deepEqual(await readdir(f.storage),[]);
});

test('traversal, inexistentes e conteudo nao imagem nao sao publicados',async t=>{
    const f=await preparar(t);await writeFile(path.join(f.storage,'falsa.webp'),'NAO_EXPOR');
    const url=await f.servir(f.a);
    for(const alvo of ['falsa.webp','ausente.png','%2e%2e%2fsegredo.png','sub/capa.png','.oculta.png']){
        const r=await fetch(url+'assets/images/livros/'+alvo);assert.equal(r.status,404);assert.doesNotMatch(await r.text(),/NAO_EXPOR/);
    }
    await assert.rejects(armazenarCapaAdmin(Buffer.from('NAO_IMAGEM'),{env:f.env,raizProjeto:f.a}));
    await assert.rejects(armazenarCapaAdmin(Buffer.alloc(5*1024*1024+1),{env:f.env,raizProjeto:f.a}));
});

test('junction/symlink do diretorio persistente e rejeitado sem publicar ou gravar',async t=>{
    const f=await preparar(t),link=path.join(f.base,'link');
    try{await symlink(f.storage,link,process.platform==='win32'?'junction':'dir');}
    catch(e){if(['EPERM','EACCES','ENOTSUP'].includes(e.code)){t.skip('Criacao de link indisponivel');return;}throw e;}
    const env={...f.env,CAPAS_LIVROS_STORAGE_PATH:link};
    await assert.rejects(armazenarCapaAdmin(f.bytes,{env,raizProjeto:f.a}));
    const url=await f.servir(f.a,env);assert.equal((await fetch(url+'assets/images/livros/x.png')).status,404);
    assert.deepEqual(await readdir(f.storage),[]);
});

test('arquivo hardlink nao e publicado mesmo quando possui nome de imagem',async t=>{
    const f=await preparar(t);await writeFile(path.join(f.base,'original.png'),f.bytes);
    await link(path.join(f.base,'original.png'),path.join(f.storage,'link.png'));
    const url=await f.servir(f.a);assert.equal((await fetch(url+'assets/images/livros/link.png')).status,404);
    assert.deepEqual(await readFile(path.join(f.base,'original.png')),f.bytes);
});

test('adaptador PM2 vincula o mesmo storage em duas releases e rollback sem executar PM2',async()=>{
    const chamadas=[],base='/var/www/ist-fixture';
    const adapter=createPm2Adapter({base,executeCommand:async(command,args,op)=>{
        chamadas.push({command,args,env:op.env});return {stdout:''};
    }});
    for(const release of ['a','b','a'])await adapter.switchTo({cwd:`${base}/releases/${release}`,script:`${base}/releases/${release}/server.js`});
    assert.equal(chamadas.length,6);
    for(const c of chamadas){assert.equal(c.command,'pm2');assert.equal('CAPAS_LIVROS_STORAGE_PATH' in c.env,false);assert.equal('PRODUCTS_LIVROS_PATH' in c.env,false);}
    for(const c of chamadas.filter(c=>c.args[0]==='start'))assert(c.args.includes('--update-env'));
});
