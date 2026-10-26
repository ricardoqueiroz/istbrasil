import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {verificarArmazenamentoRelease,antesDeAtivar} from '../scripts/deploy/storage-preflight.mjs';
import {limitesArmazenamentoImplantacao} from '../src/config/lojaImplantacao.js';
import {criarArmazenamentoLoja} from '../src/config/lojaArmazenamento.js';
import {prepararValidadorRelease} from './fixtures/lojaStorageRelease.js';

async function fixture(t){
    const base=await fs.mkdtemp(path.join(tmpdir(),'ist-storage-preflight-'));
    t.after(()=>fs.rm(base,{recursive:true,force:true}));
    const backend=path.join(base,'.deploy/releases/candidata/backend'),repo=path.join(base,'backend-node/istbrasil'),
        pdf=path.join(repo,'istbrasil.private/products/livros'),capas=path.join(base,'uploads/livros'),arquivoEnv=path.join(repo,'.env');
    for(const p of [pdf,capas,path.join(base,'html'),path.join(base,'backend-php')])await fs.mkdir(p,{recursive:true});
    await prepararValidadorRelease(backend);
    const env={PRODUCTS_LIVROS_PATH:pdf,CAPAS_LIVROS_STORAGE_PATH:capas};
    const gravar=async valores=>fs.writeFile(arquivoEnv,Object.entries(valores).map(([k,v])=>`${k}=${v.replaceAll('\\','/')}`).join('\n'));
    await gravar(env);return {base,backend,arquivoEnv,pdf,capas,env,gravar};
}
test('preflight importa validador da candidata com env persistente antes da ativacao',async t=>{
    const f=await fixture(t),eventos=[];
    await antesDeAtivar(f,async()=>eventos.push('PM2'));
    assert.deepEqual(eventos,['PM2']);
    // The old release is irrelevant: removing the candidate validator must fail closed.
    await fs.unlink(path.join(f.backend,'src/config/lojaArmazenamento.js'));
    await assert.rejects(antesDeAtivar(f,()=>eventos.push('PM2')),e=>e.code==='STORAGE_CONTRACT_INCOMPATIBLE');
    assert.deepEqual(eventos,['PM2']);
});
test('variavel ausente/invalida preserva processo atual e nao expoe segredos',async t=>{
    const f=await fixture(t);let atual='original',trocas=0;
    for(const valores of [{CAPAS_LIVROS_STORAGE_PATH:f.capas},{...f.env,PRODUCTS_LIVROS_PATH:'SEGREDO_RELATIVO'},
        {...f.env,CAPAS_LIVROS_STORAGE_PATH:path.join(f.base,'nao-existe') }]){
        await f.gravar(valores);
        await assert.rejects(antesDeAtivar(f,()=>{atual='candidata';trocas++;}),e=>e.message==='STORAGE_PREFLIGHT_FAILED'&&!e.cause);
    }
    assert.equal(atual,'original');assert.equal(trocas,0);
});
test('webroot real, publicos adicionais e releases sao recusados para PDF e capas',async t=>{
    const f=await fixture(t),limites=limitesArmazenamentoImplantacao(f.base);
    for(const raiz of [path.join(f.base,'html'),path.join(f.base,'backend-php'),path.join(f.base,'.deploy/releases/outra')]){
        await fs.mkdir(raiz,{recursive:true});
        for(const chave of ['PRODUCTS_LIVROS_PATH','CAPAS_LIVROS_STORAGE_PATH']){
            const env={...f.env,[chave]:raiz};
            await assert.rejects(criarArmazenamentoLoja({env,raizProjeto:f.backend,limites}).validar());
            await f.gravar(env);await assert.rejects(verificarArmazenamentoRelease(f));
        }
    }
});
test('rollback compativel e permitido e incompatibilidade e recusada antes de PM2',async t=>{
    const f=await fixture(t);let atual='B';
    await antesDeAtivar(f,()=>{atual='A';});assert.equal(atual,'A');
    const alvo=path.join(f.backend,'src/config/lojaArmazenamento.js');
    await fs.writeFile(alvo,"export const CONTRATO_ARMAZENAMENTO={versao:0};");
    await assert.rejects(antesDeAtivar(f,()=>{atual='antiga';}),e=>e.code==='STORAGE_CONTRACT_INCOMPATIBLE');
    assert.equal(atual,'A');
});
test('falha do subprocesso nao propaga stderr, valores arbitrarios ou causa',async t=>{
    const f=await fixture(t);
    await assert.rejects(verificarArmazenamentoRelease({...f,executar:async()=>{
        throw Object.assign(Error('SEGREDO'),{code:42,stdout:'TOKEN',stderr:'SENHA'});
    }}),e=>e.message==='STORAGE_PREFLIGHT_FAILED'&&!e.cause&&!e.stderr&&!e.stdout);
});
test('preflight e gate de deploy/rollback preservam integralmente uploads e PDFs sinteticos',async t=>{
    const f=await fixture(t),capa=path.join(f.capas,'capa.webp'),pdf=path.join(f.pdf,'livro.pdf');
    await fs.writeFile(capa,'CAPA_SINTETICA');await fs.writeFile(pdf,'PDF_SINTETICO');
    const antes={capas:await fs.readdir(f.capas),pdfs:await fs.readdir(f.pdf),env:await fs.readFile(f.arquivoEnv,'utf8')};
    for(const fase of ['deploy','rollback'])await antesDeAtivar(f,()=>assert(['deploy','rollback'].includes(fase)));
    assert.equal(await fs.readFile(capa,'utf8'),'CAPA_SINTETICA');assert.equal(await fs.readFile(pdf,'utf8'),'PDF_SINTETICO');
    assert.deepEqual({capas:await fs.readdir(f.capas),pdfs:await fs.readdir(f.pdf),env:await fs.readFile(f.arquivoEnv,'utf8')},antes);
});
