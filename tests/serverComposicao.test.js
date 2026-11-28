import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const ambiente = () => ({ PATH: process.env.PATH, NODE_ENV: 'production',
    JWT_SECRET: 'segredo-sintetico-de-teste',
    DOTENV_CONFIG_PATH: '/tmp/ist-inexistente-config-composicao',
    IST_LOJA_RECUPERACAO_ATIVA: 'true', IST_LOJA_ADVERSOS_ATIVA: 'true',
    IST_LOJA_DESCOBERTA_ATIVA: 'true', IST_LOJA_NOTIFICACOES_ATIVAS: 'true' });
const executar = script => execFileSync(process.execPath, ['--input-type=module'], {
    cwd: new URL('..', import.meta.url), input: script, encoding: 'utf8',
    timeout: 30000, env: ambiente(), stdio: ['pipe', 'pipe', 'pipe']
});

test('composição institucional inicia sem armazenamento, PayPal, SQL, rede ou agendadores comerciais', async () => {
    const fonte = await readFile(new URL('../server.js', import.meta.url), 'utf8');
    for (const nome of ['iniciarRecuperacaoLoja','iniciarWorkerAdversoLoja','iniciarDescobertaLoja',
        'iniciarNotificacoesLoja','lojaArmazenamentoInicial','criarLojaAdminRouter','comporFinanceiroLoja']) {
        assert.ok(!fonte.includes(nome), nome);
    }
    const script = `
        import assert from 'node:assert/strict'; import express from 'express';
        import http from 'node:http'; import https from 'node:https'; import mysql from 'mysql2/promise';
        let sql=0, rede=0, escutas=0, agendadoresComerciais=0; const caminhos=[];
        const agendar=globalThis.setInterval;globalThis.setInterval=function(...args){
            if(/lojaPagamentoAgendador|lojaNotificacoesAgendador/.test(new Error().stack)){agendadoresComerciais++;throw Error('WORKER_PROIBIDO');}
            return agendar(...args);
        };
        mysql.createPool=()=>({query(){sql++;throw Error('SQL_PROIBIDO');},execute(){sql++;throw Error('SQL_PROIBIDO');},
            getConnection(){sql++;throw Error('SQL_PROIBIDO');}});
        const bloquear=()=>{rede++;throw Error('REDE_PROIBIDA');};
        http.request=bloquear; https.request=bloquear; http.get=bloquear; https.get=bloquear; globalThis.fetch=bloquear;
        const use=express.application.use;express.application.use=function(...args){if(typeof args[0]==='string')caminhos.push(args[0]);return use.apply(this,args);};
        http.Server.prototype.listen=function(...args){escutas++;const cb=args.at(-1);if(typeof cb==='function')queueMicrotask(cb);return this;};
        console.log=()=>{}; await import('./server.js'); await new Promise(r=>setImmediate(r));
        for(const path of ['/api/releases','/api/timeline','/api/obra','/api/usuarios','/api/eventos','/api/projetos','/api/admin','/api/jurado',
            '/istbrasil.private/projetos','/istbrasil.private/documents/','/api/istbrasil.private/documents/'])assert.ok(caminhos.includes(path),path);
        for(const path of ['/api/books','/api/loja','/api/loja/checkout','/api/loja/downloads','/api/loja/pagamentos/paypal/webhook','/assets/images/livros'])assert.ok(!caminhos.includes(path),path);
        assert.equal(escutas,1);assert.equal(sql,0);assert.equal(rede,0);assert.equal(agendadoresComerciais,0);
        process.stdout.write('OK');`;
    assert.equal(executar(script), 'OK');
});

test('HTTP desativa loja, protege arquivos e preserva documentos e rotas institucionais', () => {
    const script = `
        import assert from 'node:assert/strict';import express from 'express';import http from 'node:http';import mysql from 'mysql2/promise';
        let app, sql=0;mysql.createPool=()=>({query(){sql++;throw Error('SQL_PROIBIDO');},execute(){sql++;throw Error('SQL_PROIBIDO');},getConnection(){sql++;throw Error('SQL_PROIBIDO');}});
        const estatico=express.static;express.static=(raiz,...args)=>/documents|projetos/.test(String(raiz))
            ?(req,res,next)=>req.path==='/institucional-sintetico.txt'?res.type('text').send('DOCUMENTO'):next():estatico(raiz,...args);
        const escutar=express.application.listen;express.application.listen=function(){app=this;return {close(){}};};
        console.log=()=>{};await import('./server.js');express.application.listen=escutar;
        app.use((req,res)=>res.status(200).send('FALLBACK'));
        const servidor=http.createServer(app);await new Promise(r=>servidor.listen(0,'127.0.0.1',r));
        try {
            const base='http://127.0.0.1:'+servidor.address().port;
            const privados=['/api/books/download','/api/books/download/a','/api/books/%64ownload/a',
                '/istbrasil.private/products/livros/a.pdf','/api/istbrasil.private/products/livros/a.pdf',
                '/api/istbrasil%2eprivate/products%2Flivros/a.pdf'];
            const lojas=['/api/books','/api/books/1','/api/loja','/api/loja/cotacao','/api/loja/checkout/capturar',
                '/api/loja/pagamentos/paypal/webhook','/api/loja/downloads/recuperacao/validar',
                '/api/admin/loja/livros/1','/assets/images/livros/a.png','/API/LOJA/','/api/%6coja/produtos'];
            for(const [paths,status] of [[privados,404],[lojas,410]])for(const path of paths)for(const method of ['GET','HEAD','POST','PATCH','DELETE','OPTIONS']){
                const r=await fetch(base+path,{method,headers:method==='POST'?{'content-type':'application/json'}:{},
                    ...(method==='POST'?{body:'{invalido'}:{}),redirect:'manual'});
                assert.equal(r.status,status,method+' '+path);assert.equal(r.headers.get('cache-control'),'no-store');
                assert.equal(r.headers.get('location'),null);assert.equal(r.headers.get('x-content-type-options'),'nosniff');
                const body=await r.text();if(method==='HEAD')assert.equal(body,'');else assert.match(body,/ROTA_NAO_ENCONTRADA|FUNCIONALIDADE_DESATIVADA/);
            }
            const grande=await fetch(base+'/api/loja/pedidos',{method:'POST',headers:{'content-type':'application/json'},body:'x'.repeat(200000)});
            assert.equal(grande.status,410);
            const invalido=await fetch(base+'/api/loja/%ZZ');assert.equal(invalido.status,400);assert.equal(invalido.headers.get('cache-control'),'no-store');
            for(const p of ['/api/lojas','/api/bookshelf','/api/admin/lojista','/assets/images/livrose']){
                const r=await fetch(base+p);assert.equal(r.status,200,p);assert.equal(await r.text(),'FALLBACK');
            }
            for(const p of ['/istbrasil.private/documents/institucional-sintetico.txt','/api/istbrasil.private/documents/institucional-sintetico.txt','/istbrasil.private/projetos/institucional-sintetico.txt']){
                const r=await fetch(base+p);assert.equal(r.status,200);assert.equal(await r.text(),'DOCUMENTO');
            }
            const raiz=await fetch(base+'/');assert.match(await raiz.text(),/API IST Brasil/);assert.equal(sql,0);
        }finally{servidor.closeAllConnections();await new Promise(r=>servidor.close(r));}
        process.stdout.write('OK');`;
    assert.equal(executar(script), 'OK');
});
