import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import {prepararArmazenamentoSintetico} from './fixtures/lojaArmazenamentoSintetico.js';

test('server compoe rotas atuais sem legado, portas, banco ou chamadas externas', async t => {
    const armazenamento=await prepararArmazenamentoSintetico(t);
    const fonte = await readFile(new URL('../server.js', import.meta.url), 'utf8');
    assert.doesNotMatch(fonte, /paypalController|paypal\.routes|ist_orders|paypalClient|@paypal\/paypal-server-sdk/);
    const script = `
        import assert from 'node:assert/strict';
        import express from 'express';
        import http from 'node:http';
        import https from 'node:https';
        import { pool } from './src/config/db.js';
        let tentativasBanco=0, tentativasHttp=0, escutasSimuladas=0;
        const caminhos=[];
        const admin = (await import('./src/routes/admin.routes.js')).default;
        const loja = admin.stack.find(l=>l.handle?.stack?.some(r=>r.route?.path==='/livros'));
        assert.ok(loja,'Router administrativo da Loja registrado');
        assert.deepEqual(loja.handle.stack.filter(l=>l.route).map(l=>[l.route.path,Object.keys(l.route.methods)]),
            [['/livros',['get']],['/livros/:id',['get']],['/livros',['post']],['/livros/capa',['post']],
                ['/livros/:id',['delete']],['/livros/:id/pdf',['post']],['/livros/:id',['patch']],
                ['/livros/:id/versoes-pdf/:versaoPublicId/publicar',['post']],
                ['/produtos',['get']],['/produtos/:id',['get']],['/categorias',['get']]]);
        for(const metodo of ['getConnection','query','execute']) pool[metodo]=()=>{
            tentativasBanco++;throw Error('ACESSO_BANCO_PROIBIDO_NO_TESTE');
        };
        const bloquear=()=>{tentativasHttp++;throw Error('ACESSO_HTTP_PROIBIDO_NO_TESTE');};
        http.request=bloquear;https.request=bloquear;http.get=bloquear;https.get=bloquear;globalThis.fetch=bloquear;
        const usar=express.application.use;
        express.application.use=function(...args){if(typeof args[0]==='string')caminhos.push(args[0]);return usar.apply(this,args);};
        http.Server.prototype.listen=function(...args){
            escutasSimuladas++;const callback=args.at(-1);
            if(typeof callback==='function')queueMicrotask(()=>callback.call(this));return this;
        };
        console.log=()=>{};
        await import('./server.js');
        await new Promise(resolve=>setImmediate(resolve));
        assert.equal(escutasSimuladas,1);
        for(const rota of ['/api/loja/downloads','/api/loja/checkout','/api/loja/pagamentos/paypal/webhook','/api/loja','/api/books',
            '/istbrasil.private/projetos','/api/usuarios',
            '/istbrasil.private/documents/','/api/istbrasil.private/documents/'])assert.ok(caminhos.includes(rota),rota);
        assert.equal(caminhos.includes('/api/paypal'),false);
        for(const rota of ['/istbrasil.private/products/livros/','/api/istbrasil.private/products/livros/'])
            assert.equal(caminhos.includes(rota),false,rota);
        assert.equal(tentativasBanco,0);assert.equal(tentativasHttp,0);
        await pool.end();
        process.stdout.write('COMPOSICAO_VALIDADA');
    `;
    const saida = execFileSync(process.execPath, ['--input-type=module'], {
        cwd: new URL('..', import.meta.url), input: script, encoding: 'utf8', timeout: 20000,
        windowsHide: true, env: { ...process.env, DOTENV_CONFIG_PATH:armazenamento.arquivo,NODE_ENV: 'test', IST_LOJA_RECUPERACAO_ATIVA: 'false' },
        stdio: ['pipe', 'pipe', 'pipe']
    });
    assert.equal(saida, 'COMPOSICAO_VALIDADA');
});

test('URLs comerciais antigas retornam 404 para GET e HEAD sem banco ou arquivos', async t => {
    const armazenamento=await prepararArmazenamentoSintetico(t);
    const script = `
        import assert from 'node:assert/strict';
        import express from 'express';
        import http from 'node:http';
        import { pool } from './src/config/db.js';
        import books from './src/controllers/bookController.js';
        let acessosBanco=0, app;
        for(const metodo of ['getConnection','query','execute']) pool[metodo]=()=>{
            acessosBanco++;throw Error('BANCO_PROIBIDO');
        };
        books.getAllBooks=(req,res)=>res.json([{id:1,title:'Editorial'}]);
        books.getBookById=(req,res)=>res.json({id:Number(req.params.id),title:'Editorial'});
        const estatico=express.static;
        express.static=(raiz,...args)=>/documents|projetos/.test(String(raiz))
            ?(req,res,next)=>req.path==='/institucional-sintetico.txt'?res.type('text').send('DOCUMENTO INSTITUCIONAL SINTETICO'):next()
            :estatico(raiz,...args);
        const escutar=express.application.listen;
        express.application.listen=function(){app=this;return {close(){}};};
        console.log=()=>{};
        await import('./server.js');
        express.application.listen=escutar;
        // Sentinela: URLs comerciais nao podem chegar a um fallback Angular.
        app.use((req,res)=>res.status(200).type('html').send('<html>fallback</html>'));
        const servidor=http.createServer(app);
        await new Promise(resolve=>servidor.listen(0,'127.0.0.1',resolve));
        try {
            const origem='http://127.0.0.1:'+servidor.address().port;
            const caminhos=[];
            for(const prefixo of ['/istbrasil.private/products/livros','/api/istbrasil.private/products/livros']) {
                for(const sufixo of ['', '/', '/ausente.pdf', '/ebook-sebastiao-tapajos-sheet-music-catalog-original-compositions-en.pdf', '/subdiretorio/arquivo.pdf', '/%61rquivo.pdf']) caminhos.push(prefixo+sufixo);
            }
            caminhos.push('/api/books/download/SKU','/api/books/download/SKU/','/api/books/download/%25',
                '/api/books/%64ownload/SKU','/api/istbrasil%2eprivate/products/livros/a.pdf',
                '/api/istbrasil.private/products%2Flivros/a.pdf');
            for(const method of ['GET','HEAD']) for(const caminho of caminhos) {
                const r=await fetch(origem+caminho,{method,redirect:'manual'});
                assert.equal(r.status,404,method+' '+caminho);
                assert.equal(r.headers.get('location'),null);
                assert.match(r.headers.get('content-type'),/application\\/json/);
                assert.equal(r.headers.get('cache-control'),'no-store');
                assert.equal(await r.text(),method==='HEAD'?'':JSON.stringify({erro:{codigo:'ROTA_NAO_ENCONTRADA'}}));
            }
            for(const caminho of ['/api/books','/api/books/1']) {
                const r=await fetch(origem+caminho);assert.equal(r.status,200);assert.match(await r.text(),/Editorial/);
            }
            for(const caminho of ['/istbrasil.private/documents/institucional-sintetico.txt','/api/istbrasil.private/documents/institucional-sintetico.txt','/istbrasil.private/projetos/institucional-sintetico.txt']){
                const r=await fetch(origem+caminho);assert.equal(r.status,200);assert.equal(await r.text(),'DOCUMENTO INSTITUCIONAL SINTETICO');
            }
            assert.equal(acessosBanco,0);
        } finally {
            servidor.closeAllConnections();
            await new Promise(resolve=>servidor.close(resolve));
            await pool.end();
        }
        process.stdout.write('BLOQUEIO_VALIDADO');
    `;
    const saida = execFileSync(process.execPath, ['--input-type=module'], {
        cwd: new URL('..', import.meta.url), input: script, encoding: 'utf8', timeout: 20000,
        windowsHide: true, env: { ...process.env,DOTENV_CONFIG_PATH:armazenamento.arquivo, NODE_ENV: 'test', IST_LOJA_RECUPERACAO_ATIVA: 'false' },
        stdio: ['pipe', 'pipe', 'pipe']
    });
    assert.equal(saida, 'BLOQUEIO_VALIDADO');
});
