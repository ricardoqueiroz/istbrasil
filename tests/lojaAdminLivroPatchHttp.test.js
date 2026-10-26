import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import jwt from 'jsonwebtoken';
import {randomBytes} from 'node:crypto';
import {pool} from '../src/config/db.js';
import {prepararArmazenamentoSintetico} from './fixtures/lojaArmazenamentoSintetico.js';

test('PATCH editorial na composicao real do server, sem banco ou servidor IST',async t=>{
    const armazenamento=await prepararArmazenamentoSintetico(t);
    const chaves=['NODE_ENV','JWT_SECRET','COOKIE_NAME','LOJA_CSRF_SECRET','LOJA_ORIGENS_PERMITIDAS','PRODUCTS_LIVROS_PATH','CAPAS_LIVROS_STORAGE_PATH','DOTENV_CONFIG_PATH'];
    const anteriores=new Map(chaves.map(k=>[k,process.env[k]]));
    Object.assign(process.env,{NODE_ENV:'test',DOTENV_CONFIG_PATH:armazenamento.arquivo,JWT_SECRET:randomBytes(32).toString('hex'),COOKIE_NAME:'ist_session',
        LOJA_CSRF_SECRET:randomBytes(32).toString('base64url'),LOJA_ORIGENS_PERMITIDAS:'http://localhost:4200'});
    const original={id:1,author:null,currency:'BRL',title:'Titulo',description:'Legado intacto',language:null,format:'E-Book',category:'Musica',
        img:'privado/NAO_EXPOR.pdf',pertence_editora_ist:null,price:'95.00',file:'privado/NAO_EXPOR.pdf',sku:'LEGADO',onsale:1,inventory:'Em estoque'};
    let row={...original},tipo=1,falha=null,app,server,fila=Promise.resolve();
    let produto={id:6,livro_id:1,categoria_id:2,sku:'COM-001',autor:null,titulo:'Comercial independente',descricao:null,tipo:'DIGITAL',preco_centavos:'1000',moeda:'BRL',imagem_url:null,ativo:1,em_venda:0,disponivel:0};
    let versoes=[];
    const logs=[];
    const metodos=new Map(['query','execute','getConnection'].map(k=>[k,pool[k]]));
    pool.query=async(sql,args)=>{
        logs.push('auth');assert.equal(sql,'SELECT id_tipo_usuario FROM ist_usuarios WHERE id_usuario = ?');
        assert.deepEqual(args,[7]);return [[{id_tipo_usuario:tipo}]];
    };
    pool.execute=()=>{throw Error('POOL_REAL_PROIBIDO');};
    pool.getConnection=async()=>{
        logs.push('conexao');let backup,backupProduto,liberar;
        return {query:async(sql,args)=>{
            logs.push(sql);
            if(sql.includes('FOR UPDATE')&&sql.includes('FROM ist_livros')){
                const anterior=fila;fila=new Promise(r=>{liberar=r;});await anterior;
                backup={...row};backupProduto={...produto};
                if(falha==='lock')throw Error('SEGREDO_SQL');
            }
            if(sql.startsWith('START TRANSACTION')||sql==='SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')return [[]];
            if(sql.includes('SELECT public_id AS versaoPublicId,numero_versao AS numeroVersao,estado')){
                assert(!/caminho|sha256|mime|tamanho/.test(sql));return [structuredClone(versoes)];
            }
            if(sql==='SELECT nome FROM ist_loja_categorias WHERE id=?')return [[{nome:'Musica'}]];
            if(sql==='SELECT id,categoria_pai_id,ativo FROM ist_loja_categorias ORDER BY id')return [[{id:1,categoria_pai_id:null,ativo:1},{id:2,categoria_pai_id:null,ativo:1}]];
            if(sql.startsWith('SELECT id,categoria_pai_id,ativo FROM ist_loja_categorias WHERE'))return [[{id:args[0],categoria_pai_id:null,ativo:1}]];
            if(sql.includes('FROM ist_loja_produtos WHERE livro_id=?')&&!sql.startsWith('SELECT id FROM'))return [args[0]===999?[]:[{...produto}]];
            if(sql.startsWith('UPDATE ist_loja_produtos SET ')){
                const nomes=sql.split(' SET ')[1].split(' WHERE ')[0].split(',').map(x=>x.split('=')[0]);
                nomes.forEach((k,i)=>{produto[k]=args[i];});if(falha==='comercial')throw Error('SEGREDO_SQL');return [{affectedRows:1}];
            }
            if(sql.startsWith('SELECT id FROM ist_loja_produtos'))return [[{id:6}]];
            if(sql.startsWith('SELECT id,tipo FROM ist_loja_produtos')){
                assert(!/FOR UPDATE|SHARE/.test(sql));return [[{id:6,tipo:'DIGITAL'}]];
            }
            if(sql.startsWith('UPDATE ist_livros SET ')){
                if(falha==='update'||falha==='rollback')throw Error('SEGREDO_SQL');
                const colunas=sql.slice('UPDATE ist_livros SET '.length).split(' WHERE ')[0].split(',').map(x=>x.split('=')[0]);
                assert(colunas.every(k=>['author','currency','title','language','category','img','pertence_editora_ist','format','description','sku','price','onsale','inventory'].includes(k)));
                colunas.forEach((k,i)=>{row[k]=args[i];});return [{affectedRows:0}]; // Nao usar affectedRows como verdade.
            }
            if(sql.startsWith('SELECT')){
                if(falha==='releitura'&&!sql.includes('FOR UPDATE')&&!sql.includes('LEFT JOIN'))throw Error('SEGREDO_SQL');
                return [args?.[0]===999?[]:[{...row,produto_id:6,produto_tipo:'DIGITAL'}]];
            }
            throw Error('SQL_NAO_PREVISTO');
        },commit:async()=>{logs.push('commit');if(falha==='commit')throw Error('COMMIT_INCERTO');},
        rollback:async()=>{logs.push('rollback');if(falha==='rollback')throw Error('SEGREDO_SQL');if(backup){row={...backup};produto={...backupProduto};}},
        release:()=>{logs.push('release');liberar?.();},destroy:()=>{logs.push('destroy');liberar?.();}};
    };
    const escutar=express.application.listen;
    express.application.listen=function(){app=this;return {close(){}};};
    t.after(async()=>{
        if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}
        express.application.listen=escutar;
        for(const [k,fn]of metodos)pool[k]=fn;
        await pool.end();
        for(const [k,v]of anteriores){if(v===undefined)delete process.env[k];else process.env[k]=v;}
    });
    try {await import('../server.js');}finally{express.application.listen=escutar;}
    // Sonda apenas de teste depois da composicao real para conferir parsers das outras rotas.
    app.post('/__parser_sintetico',(req,res)=>res.json({body:req.body}));
    app.use((e,req,res,next)=>res.status(e.status??500).json({erro:'ERRO_PARSER_GLOBAL'}));
    server=http.createServer(app);await new Promise(r=>server.listen(0,'127.0.0.1',r));
    const base=`http://127.0.0.1:${server.address().port}`;
    const cookie='ist_session='+jwt.sign({id_usuario:7,id_tipo_usuario:1},process.env.JWT_SECRET,{expiresIn:3600});
    const contexto=async()=>{
        const r=await fetch(base+'/api/admin/loja/livros/1',{headers:{Cookie:cookie}});
        assert.equal(r.status,200);const item=(await r.json()).item;return {tag:item.revisao,comercialTag:item.comercial?.revisao,csrf:r.headers.get('x-csrf-token')};
    };
    const patch=async(body,op={})=>{
        const ctx=op.ctx??await contexto();
        const headers={Cookie:cookie,Origin:'http://localhost:4200','X-CSRF-Token':ctx.csrf,
            'If-Match':ctx.tag,...(ctx.comercialTag?{'If-Match-Produto':ctx.comercialTag}:{}),'Content-Type':'application/json',...op.headers};
        for(const [k,v]of Object.entries(headers))if(v===null)delete headers[k];
        const r=await fetch(base+(op.path??'/api/admin/loja/livros/1'),{method:op.method??'PATCH',headers,
            body:op.raw??JSON.stringify(body)});
        const text=await r.text();assert.doesNotMatch(text,/NAO_EXPOR|SEGREDO_SQL|COMMIT_INCERTO|stack|SELECT|SyntaxError/);
        if(op.method===undefined){assert.equal(r.headers.get('cache-control'),'no-store');assert.equal(r.headers.get('x-content-type-options'),'nosniff');}
        return {r,body:JSON.parse(text)};
    };
    await t.test('PDF exige autenticacao, CSRF, revisao e PDF valido antes de armazenamento',async()=>{
        const ctx=await contexto();
        const url=base+'/api/admin/loja/livros/1/pdf';
        assert.equal((await fetch(url,{method:'POST'})).status,401);
        const headers={Cookie:cookie,Origin:'http://localhost:4200','X-CSRF-Token':ctx.csrf};
        assert.equal((await fetch(url,{method:'POST',headers})).status,428);
        headers['If-Match']=ctx.tag;
        assert.equal((await fetch(url,{method:'POST',headers})).status,415);
        const body=new FormData();body.append('pdf',new Blob(['INVALIDO'],{type:'application/pdf'}),'teste.pdf');
        const resposta=await fetch(url,{method:'POST',headers,body});
        assert.equal(resposta.status,400);
        assert.doesNotMatch(await resposta.text(),/stack|SELECT|INVALIDO|teste\.pdf/);
        // A valid multipart reaches private-root validation, not a parser failure.
        const valido=new FormData();valido.append('pdf',new Blob(['%PDF-1.7'],{type:'application/pdf'}),'teste.pdf');
        assert.equal((await fetch(url,{method:'POST',headers,body:valido})).status,503);
    });
    await t.test('dois rascunhos historicos no detalhe bloqueiam upload antes de receber arquivo',async()=>{
        const fileOriginal=row.file;
        versoes=[{versaoPublicId:'11111111-1111-4111-8111-111111111111',numeroVersao:1,estado:'RASCUNHO'},
            {versaoPublicId:'22222222-2222-4222-8222-222222222222',numeroVersao:2,estado:'RASCUNHO'}];
        try{
            const r=await fetch(base+'/api/admin/loja/livros/1',{headers:{Cookie:cookie}}),body=await r.json();
            assert.equal(r.status,200);assert.deepEqual(body.item.versoesPdf,versoes);
            assert(body.item.versoesPdf.every(v=>Object.keys(v).sort().join(',')==='estado,numeroVersao,versaoPublicId'));
            const ctx=await contexto();
            const bloqueio=await fetch(base+'/api/admin/loja/livros/1/pdf',{method:'POST',headers:{Cookie:cookie,
                Origin:'http://localhost:4200','X-CSRF-Token':ctx.csrf,'If-Match':ctx.tag}});
            assert.equal(bloqueio.status,409);const erro=await bloqueio.json();assert.equal(erro.erro.codigo,'ADMIN_RASCUNHO_EXISTENTE');
            assert.doesNotMatch(JSON.stringify(erro),/NAO_EXPOR|caminho|SELECT|stack/);assert.equal(row.file,fileOriginal);
        }finally{versoes=[];}
    });
    await t.test('auth e CSRF/Origin precedem os dois parsers globais',async()=>{
        const ctx=await contexto();logs.length=0;
        assert.equal((await patch({}, {ctx,raw:'{INVALIDO',headers:{Cookie:null}})).r.status,401);
        assert.equal(logs.length,0);
        tipo=2;assert.equal((await patch({}, {ctx,raw:'{INVALIDO'})).r.status,403);tipo=1;
        for(const h of [{Origin:null},{Origin:'https://evil.invalid'},{'X-CSRF-Token':null},{'X-CSRF-Token':'adulterado'}])
            assert.equal((await patch({}, {ctx,raw:'{INVALIDO',headers:h})).r.status,403);
        assert(!logs.includes('conexao'));
        for(const path of ['/API/ADMIN/LOJA/LIVROS/1','/api/admin/loja/livros/1/'])
            assert.equal((await patch({}, {ctx,path,raw:'{INVALIDO',headers:{Cookie:null}})).r.status,401);
    });
    await t.test('JSON, charset, midia e limite 144 KiB sanitizados apos autorizacao',async()=>{
        const ctx=await contexto();
        for(const raw of ['{INVALIDO','[]','null',''])assert.equal((await patch({}, {ctx,raw})).r.status,400);
        for(const tipo of ['text/plain','application/json; charset=iso-8859-1','application/json; charset=utf-16'])
            assert.equal((await patch({}, {ctx,headers:{'Content-Type':tipo}})).r.status,415);
        assert.equal((await patch({}, {ctx,headers:{'Content-Encoding':'gzip'}})).r.status,415);
        assert.equal((await patch({title:'Titulo'}, {ctx,headers:{'Content-Type':'application/json; charset="UTF-8"'}})).r.status,200);
        assert.equal((await patch({}, {ctx,headers:{'Content-Type':null}})).r.status,415);
        assert.equal((await patch({}, {ctx,raw:' '.repeat(147456)+'{}'})).r.status,413);
        const raw=JSON.stringify({title:'Titulo'}); // exatamente 144 KiB com whitespace JSON valido
        assert.equal((await patch({}, {ctx:await contexto(),raw:raw+' '.repeat(147456-Buffer.byteLength(raw))})).r.status,200);
    });
    await t.test('campos proibidos, limites, null, vazio e precondicoes',async()=>{
        const ctx=await contexto();
        for(const body of [{}, {format:'PDF'},{description:'texto'},{price:1},{sku:'X'.repeat(51)},{file:'X'},
            {produtoId:6},{title:null},{category:null},{title:''},{category:''},{language:''},{img:''},
            {title:'x'.repeat(256)},{title:'😀'},{category:'x'.repeat(51)},{pertenceEditoraIst:1}])
            assert.equal((await patch(body,{ctx})).r.status,400,JSON.stringify(body));
        assert.equal((await patch({title:'Novo'},{ctx,headers:{'If-Match':null}})).r.status,428);
        for(const tag of ['*','W/'+ctx.tag,'invalido',ctx.tag+','+ctx.tag])
            assert.equal((await patch({title:'Novo'},{ctx,headers:{'If-Match':tag}})).r.status,400);
        assert.equal((await patch({title:'Novo'},{ctx,headers:{'If-Match':'"'+'0'.repeat(64)+'"'}})).r.status,412);
        assert.equal((await patch({title:'Novo'},{ctx,path:'/api/admin/loja/livros/999'})).r.status,404);
    });
    await t.test('atualizacao parcial preserva omitidos/imagem original e confirma COMMIT antes do sucesso',async()=>{
        const ctx=await contexto(),antes={...row};logs.length=0;
        const x=await patch({title:'Novo título',language:'pt-br',pertenceEditoraIst:true},{ctx});assert.equal(x.r.status,200);
        assert.equal(row.title,'Novo título');assert.equal(row.language,'pt-br');assert.equal(row.pertence_editora_ist,1);
        for(const k of ['img','description','format','price','file','sku','category'])assert.equal(row[k],antes[k],k);
        assert.equal(x.body.item.img,null);assert.notEqual(x.body.item.revisao,ctx.tag);
        assert.equal(x.body.item.produtoId,6);assert.equal(logs.at(-2),'commit');assert.equal(logs.at(-1),'release');
        assert(logs.indexOf('START TRANSACTION READ WRITE')<logs.findIndex(s=>s.includes('FOR UPDATE')));
        assert(logs.findIndex(s=>s.includes('FROM ist_loja_produtos WHERE livro_id=?')&&s.endsWith('FOR UPDATE'))<logs.findIndex(s=>s.includes('FROM ist_livros')&&s.endsWith('FOR UPDATE')));
        assert.equal(produto.titulo,row.title);
        const n=await patch({language:null,img:null,pertenceEditoraIst:null});assert.equal(n.r.status,200);
        assert.equal(row.language,null);assert.equal(row.img,null);assert.equal(row.pertence_editora_ist,null);
    });
    await t.test('no-op sem UPDATE, revisao estavel, concorrencia com uma revisao obsoleta',async()=>{
        const ctx=await contexto();logs.length=0;
        const x=await patch({title:row.title},{ctx});assert.equal(x.r.status,200);assert.equal(x.body.item.revisao,ctx.tag);
        assert(!logs.some(s=>s.startsWith('UPDATE')));
        const resultados=await Promise.all([patch({title:'Concorrente A'},{ctx}),patch({title:'Concorrente B'},{ctx})]);
        assert.deepEqual(resultados.map(x=>x.r.status).sort(),[200,412]);
    });
    await t.test('rollback em erros anteriores; COMMIT incerto sem retry ou rollback presumido',async()=>{
        for(const etapa of ['lock','update','releitura','rollback','commit']){
            const ctx=await contexto(),antes={...row};logs.length=0;falha=etapa;
            try {
                assert.equal((await patch({title:'Tentativa '+etapa},{ctx})).r.status,503);
                assert.equal(logs.filter(x=>x==='conexao').length,1);
                if(etapa==='commit'){assert.equal(logs.at(-1),'destroy');assert(!logs.includes('rollback'));assert(!logs.includes('release'));}
                else if(etapa==='rollback'){assert.equal(logs.at(-1),'destroy');assert(logs.includes('rollback'));}
                else {assert.equal(logs.at(-1),'release');assert(logs.includes('rollback'));assert.deepEqual(row,antes);}
            }finally{falha=null;}
        }
    });
    await t.test('outras rotas mantem parsing global e metodo PATCH nao ganha correspondencia ampla',async()=>{
        let r=await fetch(base+'/__parser_sintetico',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"x":1}'});
        assert.deepEqual(await r.json(),{body:{x:1}});
        r=await fetch(base+'/__parser_sintetico',{method:'POST',headers:{'Content-Type':'application/json'},body:'{INVALIDO'});assert.equal(r.status,400);
        r=await fetch(base+'/api/admin/loja/livros/1/extra',{method:'PATCH',headers:{'Content-Type':'application/json'},body:'{INVALIDO'});assert.equal(r.status,400);
        r=await fetch(base+'/api/admin/loja/livros/1',{method:'POST',headers:{'Content-Type':'application/json'},body:'{INVALIDO'});assert.equal(r.status,400);
        assert.equal((await contexto()).tag.length,66);
    });
    await t.test('PATCH comercial explicito exige revisoes e preserva editorial e demais campos',async()=>{
        let ctx=await contexto();const antes={...row};
        assert.equal((await patch({comercial:{precoCentavos:2000}},{ctx,headers:{'If-Match-Produto':null}})).r.status,428);
        let r=await fetch(base+'/api/admin/loja/livros/1',{headers:{Cookie:cookie}});let item=(await r.json()).item;
        assert.equal((await patch({comercial:{precoCentavos:2000}},{ctx,headers:{'If-Match-Produto':'"'+'0'.repeat(64)+'"'}})).r.status,412);
        const x=await patch({comercial:{precoCentavos:2000,titulo:'Titulo comercial explicito'}},{ctx,headers:{'If-Match-Produto':item.comercial.revisao}});
        assert.equal(x.r.status,200);assert.equal(produto.preco_centavos,2000);assert.equal(produto.titulo,'Titulo comercial explicito');
        assert.deepEqual(row,antes);assert.equal(x.body.item.revisao,ctx.tag);
        assert.equal(x.body.item.comercial.sku,'COM-001');assert.equal(x.body.item.comercial.emVenda,false);
    });
    await t.test('situacao comercial isolada preserva livro, PDF e todos os demais campos comerciais',async()=>{
        const editorial={...row},pdfs=structuredClone(versoes),antes={...produto};
        for(const valor of [true,false]){
            const ctx=await contexto();logs.length=0;
            const x=await patch({comercial:{emVenda:valor}},{ctx,headers:{'If-Match-Produto':ctx.comercialTag}});
            assert.equal(x.r.status,200);assert.equal(x.body.item.comercial.emVenda,valor);
            assert.deepEqual(row,editorial);assert.deepEqual(versoes,pdfs);
            assert.deepEqual({...produto,em_venda:antes.em_venda},antes);
            assert.deepEqual(logs.filter(s=>s.startsWith('UPDATE')),['UPDATE ist_loja_produtos SET em_venda=? WHERE id=?']);
        }
    });
    await t.test('PATCH conjunto reverte livro e produto apos falha comercial; no-op sem UPDATE',async()=>{
        let ctx=await contexto();let r=await fetch(base+'/api/admin/loja/livros/1',{headers:{Cookie:cookie}});
        const item=(await r.json()).item,antes={...row},antesProduto={...produto};
        falha='comercial';
        try{
            assert.equal((await patch({title:'Livro alterado',comercial:{sku:'COM-NOVO'}},{ctx,headers:{'If-Match-Produto':item.comercial.revisao}})).r.status,503);
            assert.deepEqual(row,antes);assert.deepEqual(produto,antesProduto);assert(logs.includes('rollback'));
        }finally{falha=null;}
        ctx=await contexto();logs.length=0;
        const x=await patch({comercial:{sku:produto.sku}},{ctx,headers:{'If-Match-Produto':item.comercial.revisao}});
        assert.equal(x.r.status,200);assert(!logs.some(s=>s.startsWith('UPDATE')));
        assert.equal(x.body.item.comercial.revisao,item.comercial.revisao);
    });
    await t.test('PATCH compartilhado sincroniza autor, JSON, preco e categoria sem ativar venda',async()=>{
        let ctx=await contexto();
        const entrada={author:'Autora IST',title:'Novo titulo compartilhado',categoriaId:1,sku:'SKU-COMUM',
            price:'95.50',currency:'BRL',inventory:'Esgotado',description:JSON.stringify({Author:'Anterior',Extra:'preservar'}),img:'assets/images/livros/nova.webp'};
        const antes={...row},antesProduto={...produto};
        assert.equal((await patch(entrada,{ctx,headers:{'If-Match-Produto':null}})).r.status,428);assert.deepEqual(row,antes);assert.deepEqual(produto,antesProduto);
        const x=await patch(entrada,{ctx});assert.equal(x.r.status,200);
        assert.equal(row.author,'Autora IST');assert.equal(produto.autor,'Autora IST');assert.equal(produto.titulo,row.title);
        assert.equal(produto.sku,row.sku);assert.equal(produto.preco_centavos,9550);assert.equal(row.price,'95.50');
        assert.equal(row.category,'Musica');assert.equal(produto.categoria_id,1);assert.equal(produto.imagem_url,row.img);
        assert.equal(produto.disponivel,0);assert.equal(produto.em_venda,antesProduto.em_venda);assert.equal(produto.ativo,antesProduto.ativo);
        assert.equal(produto.descricao,row.description);assert.equal(JSON.parse(row.description)['Autor:'],'Autora IST');assert.equal(JSON.parse(row.description).Extra,'preservar');
        assert.notEqual(x.body.item.revisao,ctx.tag);
        ctx=await contexto();const salvo={...row},salvoProduto={...produto};falha='comercial';
        try{assert.equal((await patch({author:'Reverter'},{ctx})).r.status,503);assert.deepEqual(row,salvo);assert.deepEqual(produto,salvoProduto);}finally{falha=null;}
    });
    await t.test('campos legados ampliados persistem sem tocar arquivo e formato vinculado falha 409',async()=>{
        const ctx=await contexto(),arquivo=row.file;logs.length=0;
        const x=await patch({sku:'NOVO',price:'999.99',onsale:0,inventory:'Esgotado',
            description:JSON.stringify({Título:row.title,Conteúdo:'Bibliografia',Extra:'preservado'})},{ctx});
        assert.equal(x.r.status,200);assert.equal(row.price,'999.99');assert.equal(row.onsale,0);
        assert.equal(row.inventory,'Esgotado');assert.equal(row.sku,'NOVO');assert.equal(row.file,arquivo);
        assert.equal(x.body.item.price,'999.99');assert.notEqual(x.body.item.revisao,ctx.tag);
        const novo=await contexto();logs.length=0;
        assert.equal((await patch({format:'Livro Físico'},{ctx:novo})).r.status,409);
        assert(!logs.some(s=>s.startsWith('UPDATE')));assert.equal(row.format,'E-Book');
    });
});
