import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs/promises';
import {configurarHttpDownloads,pdfSintetico} from './fixtures/lojaDownloadsHttpFixture.js';

// Reproducao exclusivamente sintetica: o segundo servidor representa um root/alias
// publico independente (por exemplo Nginx), sem modificar o backend ou deploy real.
test('D6-B4: raiz configurada tambem publicada deve ser recusada pelo download protegido',async t=>{
    const protegido=await configurarHttpDownloads(t,{publicarRaiz:true});
    const appPublico=express();
    appPublico.use('/publico',express.static(protegido.raiz));
    const servidor=await new Promise(resolve=>{const s=appPublico.listen(0,'127.0.0.1',()=>resolve(s));});
    t.after(async()=>{servidor.closeAllConnections();await new Promise(r=>servidor.close(r));});
    const publico=await fetch(`http://127.0.0.1:${servidor.address().port}/publico/arquivo.pdf`);
    assert.equal(publico.status,200);
    assert.deepEqual(Buffer.from(await publico.arrayBuffer()),pdfSintetico);
    let aberturas=0;const abrir=fs.open.bind(fs);
    t.mock.method(fs,'open',(...args)=>{aberturas++;return abrir(...args);});
    const resposta=await protegido.enviar();
    t.diagnostic(`Reproducao sintetica: sem cookie pela rota publica=${publico.status}; raiz publica aceita pelo endpoint protegido=${resposta.status}.`);
    assert.equal(resposta.status,503,'Raiz que tambem esta publicada nao pode ser aceita como armazenamento privado.');
    assert.equal(aberturas,0,'Rejeitar configuracao antes de abrir PDF');
    assert.equal(protegido.estado.autorizacoes,0);
    assert.doesNotMatch(await resposta.text(),/%PDF|caminho|ist-d6b3|sha256/);
});
