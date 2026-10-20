import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';

test('assets publicos Angular preservam imagens e capas sinteticas, separados dos PDFs privados',async t=>{
    const angular=JSON.parse(await readFile(new URL('../angular.json',import.meta.url),'utf8'));
    const assets=angular.projects['sakai-ng'].architect.build.options.assets;
    assert(assets.some(a=>a.input==='src/assets'&&a.output==='assets'));assert(assets.some(a=>a.input==='public'));
    const raiz=await mkdtemp(path.join(tmpdir(),'ist-d6b4-imagens-'));t.after(()=>rm(raiz,{recursive:true,force:true}));
    await mkdir(path.join(raiz,'images'),{recursive:true});const png=Buffer.from([137,80,78,71,13,10,26,10]);
    for(const nome of ['imagem-sintetica.png','capa-sintetica.png'])await writeFile(path.join(raiz,'images',nome),png);
    const app=express();app.use('/assets',express.static(raiz));
    const s=await new Promise(resolve=>{const server=app.listen(0,'127.0.0.1',()=>resolve(server));});
    t.after(async()=>{s.closeAllConnections();await new Promise(r=>s.close(r));});
    for(const nome of ['imagem-sintetica.png','capa-sintetica.png']){
        const r=await fetch(`http://127.0.0.1:${s.address().port}/assets/images/${nome}`);assert.equal(r.status,200);assert.equal(r.headers.get('content-type'),'image/png');
        assert.deepEqual(Buffer.from(await r.arrayBuffer()),png);
    }
});
