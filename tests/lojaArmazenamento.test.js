import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile,readdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {carregarCaminhosDoEnv,caminhoOficial,criarArmazenamentoLoja} from '../src/config/lojaArmazenamento.js';
import {prepararArmazenamentoSintetico} from './fixtures/lojaArmazenamentoSintetico.js';

test('arquivo env sintetico prevalece apenas para os caminhos oficiais, sem fallback legado',async t=>{
    const f=await prepararArmazenamentoSintetico(t),env={PRODUCTS_LIVROS_PATH:'HERDADO',CAPAS_LIVROS_STORAGE_PATH:'HERDADO',OUTRA:'preservada'};
    carregarCaminhosDoEnv({arquivo:f.arquivo,env});
    assert.equal(path.resolve(env.PRODUCTS_LIVROS_PATH),f.pdf);assert.equal(path.resolve(env.CAPAS_LIVROS_STORAGE_PATH),f.capas);assert.equal(env.OUTRA,'preservada');
    await criarArmazenamentoLoja({env}).validar();
    await writeFile(f.arquivo,'PRODUCTS_PATH=/legado\nCAPAS_LIVROS_PATH=assets/images/livros\n');
    assert.throws(()=>carregarCaminhosDoEnv({arquivo:f.arquivo,env}));
});
test('ausencia, relativo, raiz e segredo nao sao aceitos ou expostos',()=>{
    for(const valor of [undefined,'','assets/images/livros','SEGREDO_RELATIVO',path.parse(process.cwd()).root]){
        assert.throws(()=>caminhoOficial({CAPAS_LIVROS_STORAGE_PATH:valor},'CAPAS_LIVROS_STORAGE_PATH'),e=>!e.message.includes('SEGREDO_RELATIVO'));
    }
    assert.equal(caminhoOficial({PRODUCTS_LIVROS_PATH:process.cwd()+path.sep},'PRODUCTS_LIVROS_PATH'),process.cwd());
});
test('inexistencia e sobreposicao impedem inicializacao e nao criam diretorios',async t=>{
    const f=await prepararArmazenamentoSintetico(t),antes=await readdir(f.raiz);
    for(const capas of [path.join(f.raiz,'inexistente'),f.pdf,path.join(f.pdf,'sub')]){
        await assert.rejects(criarArmazenamentoLoja({env:{PRODUCTS_LIVROS_PATH:f.pdf,CAPAS_LIVROS_STORAGE_PATH:capas}}).validar());
    }
    assert.deepEqual(await readdir(f.raiz),antes);
});
test('configuracao comercial invalida nao impede inicializacao institucional nem consulta SQL',async t=>{
    const f=await prepararArmazenamentoSintetico(t);
    await writeFile(f.arquivo,'PRODUCTS_PATH=/legado\n');
    const script=`import http from 'node:http'; import mysql from 'mysql2/promise';
        let escutas=0; http.Server.prototype.listen=function(...args){escutas++; const cb=args.at(-1);if(typeof cb==='function')queueMicrotask(cb);return this;};
        mysql.createPool=()=>({getConnection(){throw Error('SQL_PROIBIDO');},query(){throw Error('SQL_PROIBIDO');},execute(){throw Error('SQL_PROIBIDO');}});
        console.log=()=>{}; await import('./server.js'); await new Promise(r=>setImmediate(r));
        if(escutas!==1)throw Error('LISTEN_AUSENTE');process.stdout.write('INICIALIZACAO_INSTITUCIONAL_OK');`;
    assert.equal(execFileSync(process.execPath,['--input-type=module'],{input:script,encoding:'utf8',windowsHide:true,
        cwd:new URL('..',import.meta.url),env:{PATH:process.env.PATH,DOTENV_CONFIG_PATH:f.arquivo,NODE_ENV:'production'},stdio:['pipe','pipe','pipe']}),'INICIALIZACAO_INSTITUCIONAL_OK');
});
