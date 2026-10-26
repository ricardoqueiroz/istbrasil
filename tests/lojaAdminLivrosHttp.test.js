import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import {randomBytes} from 'node:crypto';
import sharp from 'sharp';
import {mkdtemp,mkdir,writeFile,rm,lstat,realpath,access,open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {criarEntregaCapasLivros} from '../src/services/lojaCapaService.js';
import {criarConfiguracaoCapasLoja} from '../src/config/lojaArmazenamento.js';
import {criarLojaAdminRouter} from '../src/routes/lojaAdmin.routes.js';

test('publicacao administrativa: HTTP protegido, metadados em lote e adaptacao sem SQL real',async t=>{
    const env={NODE_ENV:'test',COOKIE_NAME:'ist_session',JWT_SECRET:randomBytes(32).toString('hex'),
        LOJA_CSRF_SECRET:randomBytes(32).toString('base64url'),LOJA_ORIGENS_PERMITIDAS:'http://localhost:4200'};
    const versao='11111111-1111-4111-8111-111111111111';
    let tipo=1,erroPublicacao=null,chamadas=0;
    const sqls=[];
    const row={id:1,author:null,currency:'BRL',title:'Livro',description:null,language:null,format:'E-Book',category:null,img:null,
        pertence_editora_ist:1,sku:null,price:null,onsale:1,inventory:null,produto_id:7,produto_tipo:'DIGITAL'};
    const db={query:async()=>[[{id_tipo_usuario:tipo}]],getConnection:async()=>({
        query:async(sql,args)=>{sqls.push([sql,args]);
            if(sql.includes('COUNT(*)'))return [[{total:1}]];
            if(sql.includes('FROM ist_loja_arquivo_versoes'))return [[{produto_id:7,versaoPublicId:versao,numeroVersao:1,estado:'RASCUNHO'}]];
            if(sql.includes('FROM ist_livros'))return [[row]];
            if(sql.startsWith('START')||sql.startsWith('SET'))return [[]];
            throw Error('SQL_INESPERADO');
        },commit:async()=>{},rollback:async()=>{},release(){}})};
    const arquivos={criarPublicacao:()=>({publicar:async entrada=>{
        chamadas++;assert.deepEqual(entrada,{produtoId:7,versaoPublicId:versao,publicacaoAtualEsperada:null});
        if(erroPublicacao)throw {codigo:erroPublicacao};
        return {versaoPublicId:versao,numeroVersao:1,estado:'PUBLICADA',caminho:'NAO_EXPOR'};
    }})};
    const app=express();app.use(cookieParser());app.use('/api/admin/loja',criarLojaAdminRouter({db,env,configuracaoArquivos:arquivos}));
    const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
    t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
    const base=`http://127.0.0.1:${server.address().port}/api/admin/loja/livros`;
    const cookie='ist_session='+jwt.sign({id_usuario:7,id_tipo_usuario:1},env.JWT_SECRET,{expiresIn:3600});
    const leitura=await fetch(base,{headers:{Cookie:cookie}});const body=await leitura.json();
    assert.equal(leitura.status,200);assert.equal(body.itens[0].versoesPdf[0].estado,'RASCUNHO');
    assert.equal(sqls.filter(([sql])=>sql.includes('FROM ist_loja_arquivo_versoes')).length,1);
    assert(!sqls.some(([sql])=>/caminho|sha256/.test(sql)));
    const headers={Cookie:cookie,Origin:'http://localhost:4200','X-CSRF-Token':leitura.headers.get('x-csrf-token'),
        'If-Match':body.itens[0].revisao,'Content-Type':'application/json'};
    const enviar=h=>fetch(`${base}/1/versoes-pdf/${versao}/publicar`,{method:'POST',headers:h,body:JSON.stringify({publicacaoAtualEsperada:null})});
    assert.equal((await enviar({})).status,401);
    tipo=2;assert.equal((await enviar(headers)).status,403);tipo=1;
    assert.equal((await enviar({...headers,Origin:'http://indevido.local'})).status,403);
    assert.equal((await enviar({...headers,'X-CSRF-Token':'invalido'})).status,403);
    assert.equal(chamadas,0);
    const sucesso=await enviar(headers);assert.equal(sucesso.status,200);
    assert.deepEqual(await sucesso.json(),{item:{versaoPublicId:versao,numeroVersao:1,estado:'PUBLICADA'}});
    for(const codigo of ['CONFLITO_PUBLICACAO','VERSAO_INEXISTENTE','RESULTADO_DESCONHECIDO']){
        erroPublicacao=codigo;const r=await enviar(headers);assert.equal(r.status,codigo==='RESULTADO_DESCONHECIDO'?503:409);
        assert.doesNotMatch(JSON.stringify(await r.json()),/NAO_EXPOR|SELECT|caminho|sha256/);
    }
    assert(!sqls.some(([sql])=>/^(INSERT|UPDATE|DELETE)/.test(sql)));
});

test('capas publicas: arquivo novo imediato, legado, HEAD e bloqueio de caminhos privados',async t=>{
    // Ancestrais inspecionaveis pelo sandbox; exclusivo por execucao, sem caminho fixo.
    const raiz=await mkdtemp(fileURLToPath(new URL('./ist-capas-http-',import.meta.url)));
    let server;
    t.after(async()=>{
        try{if(server){server.closeAllConnections();await new Promise((r,j)=>server.close(e=>e?j(e):r()));}}
        finally{await rm(raiz,{recursive:true,force:true});}
    });
    const dir=path.join(raiz,'src/assets/images/livros');await mkdir(dir,{recursive:true});
    const storage=path.join(raiz,'uploads/livros');await mkdir(storage,{recursive:true});
    // Diagnostico local: nao imprimir caminhos, ambiente ou conteudo dos arquivos.
    let ancestral=path.parse(storage).root;
    for(const [indice,parte] of storage.slice(ancestral.length).split(path.sep).filter(Boolean).entries()){
        ancestral=path.join(ancestral,parte);
        const st=await lstat(ancestral);
        assert(st.isDirectory()&&!st.isSymbolicLink(),`CAPAS_FIXTURE_ANCESTRAL_INSEGURO_${indice}`);
    }
    assert.equal(path.relative(await realpath(storage),storage),'','CAPAS_FIXTURE_RAIZ_NAO_CANONICA');
    await access(storage,constants.R_OK|constants.W_OK|constants.X_OK);
    const configuracaoCapas=criarConfiguracaoCapasLoja({raizProjeto:raiz,env:{CAPAS_LIVROS_STORAGE_PATH:storage}});
    assert.equal(await configuracaoCapas.obterRaizValidada(),storage,'CAPAS_FIXTURE_CONFIGURACAO');
    const conferirImagem=async(arquivo,formato)=>{
        const st=await lstat(arquivo);
        assert(st.isFile()&&!st.isSymbolicLink(),'CAPAS_FIXTURE_ARQUIVO_INVALIDO');
        assert.equal(st.nlink,1,'CAPAS_FIXTURE_HARDLINK');
        const h=await open(arquivo,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
        try{
            const aberto=await h.stat();
            assert.equal(aberto.ino,st.ino,'CAPAS_FIXTURE_IDENTIDADE_INODE');
            assert.equal(aberto.dev,st.dev,'CAPAS_FIXTURE_IDENTIDADE_DEVICE');
            assert.equal((await sharp(await h.readFile()).metadata()).format,formato,'CAPAS_FIXTURE_CONTEUDO');
        }finally{await h.close();}
    };
    const app=express();app.use('/assets/images/livros',criarEntregaCapasLivros({raizProjeto:raiz,configuracaoCapas}));
    server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
    const url=`http://127.0.0.1:${server.address().port}/assets/images/livros/`;
    const bytes=await sharp({create:{width:2,height:2,channels:3,background:'white'}}).webp().toBuffer();
    await writeFile(path.join(storage,'nova.webp'),bytes);
    await conferirImagem(path.join(storage,'nova.webp'),'webp');
    assert.equal(await lstat(path.join(dir,'nova.webp')).then(()=>true,e=>{if(e.code==='ENOENT')return false;throw e;}),false);
    const r=await fetch(url+'nova.webp');assert.equal(r.status,200);assert.match(r.headers.get('content-type'),/image\/webp/);
    assert.equal(r.headers.get('x-content-type-options'),'nosniff');assert.deepEqual(Buffer.from(await r.arrayBuffer()),bytes);
    await writeFile(path.join(dir,'legada.png'),await sharp(bytes).png().toBuffer());
    await conferirImagem(path.join(dir,'legada.png'),'png');
    assert.equal(await lstat(path.join(storage,'legada.png')).then(()=>true,e=>{if(e.code==='ENOENT')return false;throw e;}),false);
    assert.equal((await fetch(url+'legada.png',{method:'HEAD'})).status,200);
    await writeFile(path.join(dir,'privado.txt'),'NAO_EXPOR');
    for(const alvo of ['privado.txt','.oculto.webp','sub/nova.webp','%2e%2e%2fprivado.txt','ausente.webp']){
        const erro=await fetch(url+alvo);assert.equal(erro.status,404);assert.doesNotMatch(await erro.text(),/NAO_EXPOR/);
    }
    assert.equal((await fetch(url+'nova.webp',{method:'POST'})).status,404);
});

test('GETs administrativos de livros com HTTP real e banco exclusivamente simulado',async t=>{
    const env={NODE_ENV:'test',COOKIE_NAME:'ist_session',JWT_SECRET:randomBytes(32).toString('hex'),
        LOJA_CSRF_SECRET:randomBytes(32).toString('base64url'),LOJA_ORIGENS_PERMITIDAS:'http://localhost:4200'};
    let autor=null;
    let tipo=1,falha=null,produtoId=null,clas=null,vazio=false,imagem='assets/images/livros/capa.png';
    const logs=[];
    const linha=()=>({id:1,author:autor,currency:'BRL',title:null,description:null,language:null,format:null,category:'Musica',img:imagem,
        pertence_editora_ist:clas,produto_id:produtoId,produto_tipo:null,onsale:1,inventory:'Em estoque',sku:null,price:'999.99',file:'/privado/SEGREDO.pdf'});
    const db={query:async(sql,args)=>{
        assert.equal(sql,'SELECT id_tipo_usuario FROM ist_usuarios WHERE id_usuario = ?');
        assert.deepEqual(args,[7]);return [[{id_tipo_usuario:tipo}]];
    },getConnection:async()=>{
        logs.push('conexao');if(falha==='conexao')throw Error('SEGREDO_SQL');
        return {query:async(sql,args)=>{
            logs.push([sql,args]);
            if(falha&&sql.includes(falha))throw Error('SEGREDO_SQL');
            assert.doesNotMatch(sql,/SELECT\s+\*|l\.(file)|FOR UPDATE|LOCK IN SHARE MODE/i);
            if(sql.includes('FROM ist_loja_produtos WHERE livro_id=?'))return [[]];
            if(sql.includes('COUNT(*)'))return [[{total:vazio?'0':'1'}]];
            if(sql.startsWith('SELECT'))return [vazio||args?.[0]===999?[]:[linha()]];
            return [[]];
        },commit:async()=>{logs.push('commit');if(falha==='commit')throw Error('SEGREDO_SQL');},
        rollback:async()=>{logs.push('rollback');},release:()=>logs.push('release')};
    }};
    const app=express();app.use(cookieParser());app.use('/api/admin/loja',criarLojaAdminRouter({db,env}));
    const server=await new Promise(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s));});
    t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
    const base=`http://127.0.0.1:${server.address().port}/api/admin/loja`;
    const cookie='ist_session='+jwt.sign({id_usuario:7,id_tipo_usuario:1},env.JWT_SECRET,{expiresIn:3600});
    const get=async(path,c=cookie)=>{
        const r=await fetch(base+path,{headers:c?{Cookie:c}:{}}),text=await r.text();
        assert.equal(r.headers.get('cache-control'),'no-store');
        assert.doesNotMatch(text,/SEGREDO|\"file\"|stack|SELECT/);
        assert(!text.includes(cookie));return {r,body:JSON.parse(text)};
    };
    await t.test('401/403/503 antes de consultar livros e sem emitir CSRF',async()=>{
        for(const [c,status]of [[null,401],['ist-loja-dev=COMPRA',401],[cookie+'; '+cookie,401]]){
            const x=await get('/livros',c);assert.equal(x.r.status,status);assert.equal(x.r.headers.get('x-csrf-token'),null);
        }
        tipo=2;assert.equal((await get('/livros')).r.status,403);tipo=1;
        const segredo=env.JWT_SECRET;delete env.JWT_SECRET;
        assert.equal((await get('/livros')).r.status,503);env.JWT_SECRET=segredo;
        assert.equal(logs.length,0);
    });
    await t.test('lista e detalhe preservam nulos e emitem CSRF somente autenticado',async()=>{
        const x=await get('/livros');assert.equal(x.r.status,200);assert(x.r.headers.get('x-csrf-token'));
        assert.deepEqual(x.body.paginacao,{pagina:1,limite:20,total:1});
        assert.equal(x.body.itens[0].title,null);assert.equal(x.body.itens[0].produtoId,null);
        assert.equal(x.body.itens[0].pertenceEditoraIst,null);
        assert.match(x.body.itens[0].revisao,/^"[a-f0-9]{64}"$/);
        const d=await get('/livros/1');assert.deepEqual(d.body.item,{...x.body.itens[0],comercial:null,versoesPdf:[]});
        assert.equal(logs.at(-1),'release');assert.equal(logs.at(-2),'commit');
    });
    await t.test('listagem e detalhe: author preenchido ou NULL, projecao explicita e campos preservados',async()=>{
        for(const valor of ['Autor IST',null]){
            autor=valor;logs.length=0;
            const lista=await get('/livros?pagina=1&limite=20');assert.equal(lista.r.status,200);
            assert.equal(lista.body.itens[0].author,valor);
            assert.deepEqual(lista.body.paginacao,{pagina:1,limite:20,total:1});
            const detalhe=await get('/livros/1');assert.equal(detalhe.r.status,200);assert.equal(detalhe.body.item.author,valor);
            assert.deepEqual(detalhe.body.item,{...lista.body.itens[0],comercial:null,versoesPdf:[]});
            assert.deepEqual(Object.keys(lista.body.itens[0]).sort(),['id','title','author','currency','description','language','format','category','img',
                'pertenceEditoraIst','sku','price','onsale','inventory','produtoId','produtoTipo','revisao','versoesPdf'].sort());
            assert(logs.filter(Array.isArray).filter(([sql])=>sql.includes('l.title')).every(([sql])=>sql.includes('l.author AS author')));
        }
        autor=null;
    });
    await t.test('classificacoes e associacao comercial nao alteram autoridade editorial',async()=>{
        for(const [valor,esperado]of [[0,false],[1,true],[null,null]]){
            clas=valor;const a=await get('/livros/1');assert.equal(a.body.item.pertenceEditoraIst,esperado);
            produtoId=6;const b=await get('/livros/1');assert.equal(b.body.item.produtoId,6);
            assert.equal(a.body.item.revisao,b.body.item.revisao);produtoId=null;
        }
        imagem='/privado/SEGREDO.pdf';assert.equal((await get('/livros/1')).body.item.img,null);
        imagem='assets/images/livros/capa.png';
    });
    await t.test('filtros parametrizados, LIKE literal e pagina ordenada no mesmo snapshot',async()=>{
        logs.length=0;
        const busca="x%'_! OR 1=1";
        const x=await get('/livros?pagina=2&limite=3&pertenceEditoraIst=false&busca='+encodeURIComponent(busca));
        assert.equal(x.r.status,200);
        const queries=logs.filter(Array.isArray),contagem=queries.find(([sql])=>sql.includes('COUNT(*)'));
        const pagina=queries.find(([sql])=>sql.includes('ORDER BY'));
        assert(!pagina[0].includes(busca));assert.match(pagina[0],/LIKE \? ESCAPE '!'/);
        assert.deepEqual(contagem[1],["%x!%'!_!! OR 1=1%",0]);
        assert.deepEqual(pagina[1],[...contagem[1],3,3]);
        assert.match(queries[1][0],/CONSISTENT SNAPSHOT, READ ONLY/);
        await get('/livros?pertenceEditoraIst=null');
        assert(logs.some(x=>Array.isArray(x)&&x[0].includes('IS NULL')));
    });
    await t.test('400 para entradas invalidas, 404 para ID valido ausente',async()=>{
        for(const path of ['/livros?pagina=0','/livros?limite=101','/livros?extra=1','/livros?pagina=1&pagina=2',
            '/livros?pertenceEditoraIst=2','/livros/0','/livros/01','/livros/2147483648','/livros/1?extra=1']){
            const antes=logs.length;assert.equal((await get(path)).r.status,400,path);assert.equal(logs.length,antes);
        }
        const x=await get('/livros/999');assert.equal(x.r.status,404);
        assert.equal(x.body.erro.codigo,'ADMIN_REGISTRO_NAO_ENCONTRADO');
    });
    await t.test('erros SQL/commit sanitizados com rollback e release',async()=>{
        for(const etapa of ['COUNT(*)','WHERE l.id','commit','conexao']){
            falha=etapa;logs.length=0;
            const x=await get(etapa==='WHERE l.id'?'/livros/1':'/livros');assert.equal(x.r.status,503);
            if(etapa!=='conexao'){assert.equal(logs.at(-1),'release');assert(logs.includes('rollback'));}
        }
        falha=null;
    });
    await t.test('lista vazia e POST existente exige autenticacao',async()=>{
        vazio=true;const x=await get('/livros');
        assert.deepEqual(x.body,{itens:[],paginacao:{pagina:1,limite:20,total:0}});vazio=false;
        const antes=logs.length;
        const r=await fetch(base+'/livros',{method:'POST'});assert.equal(r.status,401);
        assert.equal(logs.length,antes);
    });
});

test('POST e DELETE administrativos: HTTP real, persistencia e transacoes somente simuladas',async t=>{
    const env={NODE_ENV:'test',COOKIE_NAME:'ist_session',JWT_SECRET:randomBytes(32).toString('hex'),
        LOJA_CSRF_SECRET:randomBytes(32).toString('base64url'),LOJA_ORIGENS_PERMITIDAS:'http://localhost:4200'};
    const original={id:1,author:null,currency:'BRL',title:'Editorial original',description:null,language:null,format:'E-Book',category:'Musica',
        img:null,pertence_editora_ist:null,price:'95.00',file:'privado/SEGREDO.pdf',sku:'LEGADO',onsale:1,inventory:'Em estoque'};
    const schemaValido={DATA_TYPE:'decimal',NUMERIC_PRECISION:'5',NUMERIC_SCALE:'2',IS_NULLABLE:'YES'};
    const comercialOriginal={produtos:[],pedidos:[{id:70}],pagamentos:[{id:80}],versoes:[{id:90}]};
    let livros,comercial,schema,tipo,falha;
    const logs=[],inesperadas=[];
    const reset=()=>{livros=new Map([[1,{...original}]]);comercial=structuredClone(comercialOriginal);
        schema=[{...schemaValido}];tipo=1;falha=null;logs.length=0;};
    reset();
    const db={query:async(sql,args)=>{
        assert.equal(sql,'SELECT id_tipo_usuario FROM ist_usuarios WHERE id_usuario = ?');
        assert.deepEqual(args,[7]);return [[{id_tipo_usuario:tipo}]];
    },getConnection:async()=>{
        logs.push('conexao');let backup,backupComercial,confirmado=false;
        return {query:async(sql,args=[])=>{
            const q=sql.replace(/\s+/g,' ').trim();logs.push({sql:q,args:structuredClone(args)});
            if(q==='START TRANSACTION READ WRITE'||q==='START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY'){
                backup=structuredClone(livros);backupComercial=structuredClone(comercial);return [[]];
            }
            if(q==='SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')return [[]];
            if(q===`SELECT DATA_TYPE,NUMERIC_PRECISION,NUMERIC_SCALE,IS_NULLABLE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='ist_livros' AND COLUMN_NAME='price'`)
                return [structuredClone(schema)];
            if(q==='SELECT nome FROM ist_loja_categorias WHERE id=?')return [[{nome:'Musica'}]];
            if(q==='SELECT id,categoria_pai_id,ativo FROM ist_loja_categorias ORDER BY id')return [[{id:1,categoria_pai_id:null,ativo:1},{id:2,categoria_pai_id:1,ativo:falha==='categoria'?0:1}]];
            if(q.startsWith('SELECT id,categoria_pai_id,ativo FROM ist_loja_categorias WHERE'))return [[{id:args[0],categoria_pai_id:args[0]===1?null:1,ativo:1}]];
            if(q.includes('FROM ist_loja_produtos WHERE livro_id=?')&&!q.startsWith('SELECT id FROM'))
                return [structuredClone(comercial.produtos.filter(p=>p.livro_id===args[0]))];
            if(q.startsWith('INSERT INTO ist_loja_produtos')){
                if(falha==='produto')throw Error('SEGREDO_SQL');
                if(falha==='sku')throw Object.assign(Error('SEGREDO_SKU'),{errno:1062});
                const [livro_id,categoria_id,sku,tipo,titulo,autor,descricao,imagem_url,preco_centavos,moeda,disponivel]=args;
                comercial.produtos.push({id:5,livro_id,categoria_id,sku,tipo,titulo,autor,descricao,imagem_url,preco_centavos:String(preco_centavos),moeda,ativo:1,em_venda:0,disponivel,ordem:0,perfil_fiscal_id:null});
                return [{insertId:5}];
            }
            if(q.startsWith('SELECT id FROM ist_loja_pedido_itens WHERE produto_id='))return [falha==='pedido'?[{id:70}]:[]];
            if(q.startsWith('SELECT id FROM ist_loja_arquivo_versoes WHERE produto_id='))return [falha==='versao'?[{id:90}]:[]];
            if(q==='DELETE FROM ist_loja_produtos WHERE id=?'){
                if(falha==='fkProduto')throw Object.assign(Error('SEGREDO_FK'),{errno:1451});
                comercial.produtos=comercial.produtos.filter(p=>p.id!==args[0]);return [{affectedRows:1}];
            }
            if(q.startsWith('INSERT INTO ist_livros (')){
                const match=q.match(/^INSERT INTO ist_livros \(([^)]+)\) VALUES \(([^)]+)\)$/);
                if(!match){inesperadas.push(q);throw Error('SQL_INESPERADO');}
                const colunas=match[1].split(',');
                assert(colunas.every(k=>['author','currency','title','format','category','pertence_editora_ist','price','language','img','description','sku','onsale','inventory'].includes(k)));
                assert.equal(match[2],colunas.map(()=>'?').join(','));assert.equal(args.length,colunas.length);
                const row={id:2,author:null,currency:'BRL',description:null,language:null,img:null,sku:null,onsale:1,inventory:'Em estoque',produto_id:null};
                colunas.forEach((k,i)=>{row[k]=args[i];});livros.set(2,row);
                if(falha==='insertDepois')throw Error('SEGREDO_SQL');
                return [{insertId:2}];
            }
            if(q==='SELECT id FROM ist_loja_produtos WHERE livro_id=? LIMIT 1')
                return [comercial.produtos.filter(p=>p.livro_id===args[0]).slice(0,1).map(p=>({id:p.id}))];
            if(q==='DELETE FROM ist_livros WHERE id=?'){
                if(falha==='fk')throw Object.assign(Error('SEGREDO_FK'),{errno:1451,code:'ER_ROW_IS_REFERENCED_2'});
                livros.delete(args[0]);if(falha==='deleteDepois')throw Error('SEGREDO_SQL');
                return [{affectedRows:1}];
            }
            if(q===`SELECT l.id,l.title,l.author AS author,l.currency,l.description,l.language,l.format,l.category,l.img, l.pertence_editora_ist,l.sku,l.price,l.onsale,l.inventory,p.id AS produto_id,p.tipo AS produto_tipo FROM ist_livros l LEFT JOIN ist_loja_produtos p ON p.livro_id=l.id WHERE l.id=?`
                ||q===`SELECT id,title,author,currency,description,language,format,category,img,pertence_editora_ist,sku,price,onsale,inventory FROM ist_livros WHERE id=?`
                ||q===`SELECT id,title,author,currency,description,language,format,category,img,pertence_editora_ist,sku,price,onsale,inventory FROM ist_livros WHERE id=? FOR UPDATE`){
                if(falha==='releitura'&&args[0]===2)throw Error('SEGREDO_SQL');
                const row=livros.get(args[0]);return [row?[{...row,produto_id:null}]:[]];
            }
            inesperadas.push(q);throw Error('SQL_INESPERADO');
        },commit:async()=>{
            logs.push('commit');if(falha==='commitAntes')throw Error('SEGREDO_COMMIT');
            confirmado=true;if(falha==='commitDepois')throw Error('SEGREDO_COMMIT');
        },rollback:async()=>{logs.push('rollback');livros=structuredClone(backup);comercial=structuredClone(backupComercial);},
        release:()=>logs.push('release'),destroy:()=>{
            logs.push('destroy');if(!confirmado&&backup){livros=structuredClone(backup);comercial=structuredClone(backupComercial);}
        }};
    }};
    const app=express();app.use(cookieParser());app.use('/api/admin/loja',criarLojaAdminRouter({db,env}));
    const server=await new Promise((r,j)=>{const s=app.listen(0,'127.0.0.1',()=>r(s));s.once('error',j);});
    t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
    const base=`http://127.0.0.1:${server.address().port}/api/admin/loja`;
    // Stable JWT: GET-issued CSRF must bind to exactly the cookie used in writes.
    const cookie='ist_session='+jwt.sign({id_usuario:7,id_tipo_usuario:1},env.JWT_SECRET,{expiresIn:3600});
    const ler=async(id=1)=>{
        const r=await fetch(`${base}/livros/${id}`,{headers:{Cookie:cookie},signal:AbortSignal.timeout(5000)});
        const body=await r.json();assert.equal(r.status,200);
        return {revisao:body.item.revisao,csrf:r.headers.get('x-csrf-token'),item:body.item};
    };
    const escrever=async(metodo,{dados,ctx,headers={},c=cookie,id=1}={})=>{
        const h={Origin:env.LOJA_ORIGENS_PERMITIDAS,...(c?{Cookie:c}:{}),
            ...(ctx?{'X-CSRF-Token':ctx.csrf,...(metodo==='DELETE'?{'If-Match':ctx.revisao}:{})}:{}),
            ...(dados!==undefined?{'Content-Type':'application/json'}:{}),...headers};
        const r=await fetch(base+'/livros'+(metodo==='DELETE'?'/'+id:''),{method:metodo,headers:h,
            ...(dados!==undefined?{body:JSON.stringify(dados)}:{}),signal:AbortSignal.timeout(5000)});
        const texto=await r.text();
        assert.equal(r.headers.get('cache-control'),'no-store');
        assert.doesNotMatch(texto,/SEGREDO|privado\/|"file"|stack|INFORMATION_SCHEMA|INSERT INTO|DELETE FROM/);
        assert(!texto.includes(cookie));assert(!ctx||!texto.includes(ctx.csrf));
        return {r,body:texto?JSON.parse(texto):null,texto};
    };
    const dados=()=>({title:"Livro ' sintetico",format:'E-Book',category:'Musica',pertenceEditoraIst:true,
        language:null,img:null,description:null,comercial:{categoriaId:2,sku:'COM-001',precoCentavos:1000}});
    const comandos=prefixo=>logs.filter(x=>typeof x==='object'&&x.sql.startsWith(prefixo));
    const integridade=antes=>{assert.deepEqual(comercial,antes);assert.deepEqual(inesperadas,[]);};

    await t.test('POST 201: campos parametrizados, price NULL e resposta somente apos COMMIT',async()=>{
        reset();const ctx=await ler();logs.length=0;const antes=structuredClone(comercial);
        const x=await escrever('POST',{ctx,dados:dados()});assert.equal(x.r.status,201);
        assert.equal(x.body.item.id,2);assert.equal(x.body.item.produtoId,5);assert.equal(x.body.item.comercial.categoriaId,2);assert.equal(x.body.item.produtoTipo,'DIGITAL');
        assert.equal(x.body.item.language,null);assert.equal(x.body.item.title,dados().title);
        assert.match(x.body.item.revisao,/^"[a-f0-9]{64}"$/);
        assert.equal(livros.get(2).price,null);assert.deepEqual(livros.get(1),original);
        assert.equal(comandos('INSERT').length,2);assert(!comandos('INSERT')[0].sql.includes(dados().title));
        assert.equal(comercial.produtos[0].em_venda,0);assert.equal(comercial.produtos[0].disponivel,0);assert.equal(comercial.produtos[0].preco_centavos,'1000');
        assert.deepEqual(logs.slice(-2),['commit','release']);assert.deepEqual(comercial.pedidos,antes.pedidos);assert.deepEqual(comercial.pagamentos,antes.pagamentos);
        assert.equal((await ler(2)).revisao,x.body.item.revisao);
    });
    await t.test('POST compartilhado sem comercial: autor, categoria por ID, SKU, centavos e JSON preservado',async()=>{
        reset();const ctx=await ler();logs.length=0;
        const entrada={title:'Livro compartilhado',author:'Autor IST',format:'E-Book',categoriaId:2,
            sku:'COMPARTILHADO-1',price:'95.50',currency:'BRL',inventory:'Em estoque',pertenceEditoraIst:true,
            description:JSON.stringify({Author:'Autor antigo','Autor:':'Duplicado',Extra:{preservado:true}})};
        const x=await escrever('POST',{ctx,dados:entrada});assert.equal(x.r.status,201);
        assert.equal(x.body.item.author,'Autor IST');assert.equal(livros.get(2).category,'Musica');
        assert.equal(livros.get(2).price,'95.50');assert.equal(comercial.produtos[0].preco_centavos,'9550');
        assert.equal(comercial.produtos[0].categoria_id,2);assert.equal(comercial.produtos[0].sku,livros.get(2).sku);
        assert.equal(comercial.produtos[0].autor,'Autor IST');assert.equal(comercial.produtos[0].titulo,entrada.title);
        const bibliografia=JSON.parse(livros.get(2).description);assert.equal(bibliografia['Autor:'],'Autor IST');assert(!Object.hasOwn(bibliografia,'Author'));assert.deepEqual(bibliografia.Extra,{preservado:true});
        assert.equal(comercial.produtos[0].descricao,livros.get(2).description);assert.equal(comercial.produtos[0].disponivel,1);assert.equal(comercial.produtos[0].em_venda,0);
        const lido=await ler(2);assert.equal(lido.item.author,'Autor IST');assert.equal(lido.item.comercial.autor,'Autor IST');
        reset();const falho=await ler();falha='produto';
        assert.equal((await escrever('POST',{ctx:falho,dados:entrada})).r.status,503);assert.equal(livros.size,1);assert.equal(comercial.produtos.length,0);
    });
    await t.test('POST livro fisico gera MERCADORIA sem ativar venda ou disponibilidade',async()=>{
        reset();const ctx=await ler();const entrada={...dados(),format:'Livro F\u00edsico'};
        const x=await escrever('POST',{ctx,dados:entrada});assert.equal(x.r.status,201);
        assert.equal(x.body.item.produtoTipo,'MERCADORIA');assert.equal(comercial.produtos[0].ativo,1);
        assert.equal(comercial.produtos[0].em_venda,0);assert.equal(comercial.produtos[0].disponivel,0);
        assert.equal(comercial.produtos[0].perfil_fiscal_id,null);
    });
    await t.test('POST 400: obrigatorios, tipos e campos comerciais/privados desconhecidos',async()=>{
        reset();const ctx=await ler();logs.length=0;
        const invalidos=[{},...['title','format','category','pertenceEditoraIst'].map(k=>{
            const d=dados();delete d[k];return d;
        }),{...dados(),title:null},{...dados(),category:''},{...dados(),format:'PDF'},
        {...dados(),language:'pt-419'},{...dados(),pertenceEditoraIst:1},
        ...['precoCentavos','file','produtoId','desconhecido'].map(k=>({...dados(),[k]:1}))];
        for(const entrada of invalidos)assert.equal((await escrever('POST',{ctx,dados:entrada})).r.status,400);
        assert.equal(logs.length,0);assert.equal(livros.size,1);assert.deepEqual(inesperadas,[]);
    });
    await t.test('POST NOT NULL: preco informado grava; omitido ou NULL retorna 400 sem INSERT',async()=>{
        reset();let ctx=await ler();schema=[{...schemaValido,IS_NULLABLE:'NO'}];logs.length=0;
        const r=await escrever('POST',{ctx,dados:{...dados(),price:'10.00'}});
        assert.equal(r.r.status,201);assert.equal(livros.get(2).price,'10.00');
        for(const entrada of [dados(),{...dados(),price:null}]){
            reset();ctx=await ler();schema=[{...schemaValido,IS_NULLABLE:'NO'}];logs.length=0;
            const erro=await escrever('POST',{ctx,dados:entrada});
            assert.equal(erro.r.status,400);assert.equal(erro.body.erro.codigo,'ADMIN_PRECO_OBRIGATORIO');
            assert.equal(comandos('INSERT').length,0);assert(logs.includes('rollback'));
        }
    });
    await t.test('POST 503: schema price ausente ou tipo/precisao/escala divergentes',async()=>{
        for(const valor of [[],[{...schemaValido,IS_NULLABLE:'INVALIDO'}],[{...schemaValido,DATA_TYPE:'int'}],
            [{...schemaValido,NUMERIC_PRECISION:6}],[{...schemaValido,NUMERIC_SCALE:3}]]){
            reset();const ctx=await ler();logs.length=0;schema=valor;
            assert.equal((await escrever('POST',{ctx,dados:dados()})).r.status,503);
            assert.equal(comandos('INSERT').length,0);assert(logs.includes('rollback'));
            assert.equal(logs.at(-1),'release');assert.equal(livros.size,1);assert.deepEqual(inesperadas,[]);
        }
    });
    await t.test('POST e DELETE: 401/403 sem autenticacao, perfil, CSRF ou Origin autorizados',async()=>{
        for(const metodo of ['POST','DELETE']){
            reset();const ctx=await ler();logs.length=0;
            const op={ctx,...(metodo==='POST'?{dados:dados()}:{} )};
            assert.equal((await escrever(metodo,{...op,c:null})).r.status,401);
            tipo=2;assert.equal((await escrever(metodo,op)).r.status,403);tipo=1;
            for(const headers of [{'X-CSRF-Token':''},{'X-CSRF-Token':'invalido'},{Origin:'https://externo.invalid'},{Origin:''}])
                assert.equal((await escrever(metodo,{...op,headers})).r.status,403);
            assert.equal(logs.length,0);assert.deepEqual(livros.get(1),original);
        }
    });
    await t.test('POST: erro apos INSERT ou na releitura reverte gravacao e sanitiza 503',async()=>{
        for(const etapa of ['insertDepois','releitura']){
            reset();const ctx=await ler();logs.length=0;falha=etapa;const antes=structuredClone(comercial);
            assert.equal((await escrever('POST',{ctx,dados:dados()})).r.status,503);
            assert.equal(comandos('INSERT').length,1);assert(logs.includes('rollback'));
            assert.deepEqual([...livros.values()],[original]);assert.equal(logs.at(-1),'release');integridade(antes);
        }
    });
    await t.test('DELETE 204: lock/revisao antes de excluir, sem escrita comercial ou cascata',async()=>{
        reset();const ctx=await ler();logs.length=0;const antes=structuredClone(comercial);
        const x=await escrever('DELETE',{ctx});assert.equal(x.r.status,204);assert.equal(x.texto,'');
        assert.equal(livros.size,0);assert.equal(comandos('DELETE').length,1);
        const lock=logs.findIndex(x=>x?.sql?.endsWith('FOR UPDATE'));
        const vinculo=logs.findIndex(x=>x?.sql?.includes('FROM ist_loja_produtos WHERE livro_id=?')&&x.sql.endsWith('FOR UPDATE'));
        const exclusao=logs.findIndex(x=>x?.sql==='DELETE FROM ist_livros WHERE id=?');
        assert(lock>=0&&vinculo===lock&&lock<exclusao);assert.deepEqual(comandos('DELETE')[0].args,[1]);
        assert.deepEqual(logs.slice(-2),['commit','release']);integridade(antes);
    });
    const produtoSintetico=()=>({id:5,livro_id:1,categoria_id:2,sku:'COM-001',autor:null,tipo:'DIGITAL',titulo:'Livro',descricao:null,imagem_url:null,
        preco_centavos:'1000',moeda:'BRL',ativo:1,em_venda:0,disponivel:0});
    await t.test('DELETE conjunto permitido; pedidos, versoes e FK impedem exclusao atomica',async()=>{
        for(const causa of [null,'pedido','versao','fkProduto']){
            reset();comercial.produtos.push(produtoSintetico());const ctx=await ler();logs.length=0;falha=causa;
            const antes=structuredClone(comercial);
            const x=await escrever('DELETE',{ctx,headers:{'If-Match-Produto':ctx.item.comercial.revisao}});
            assert.equal(x.r.status,causa?409:204);
            if(causa){assert.deepEqual(comercial,antes);assert(livros.has(1));assert(logs.includes('rollback'));}
            else {assert.equal(comercial.produtos.length,0);assert.equal(livros.size,0);
                assert.deepEqual(comandos('DELETE').map(x=>x.sql),['DELETE FROM ist_loja_produtos WHERE id=?','DELETE FROM ist_livros WHERE id=?']);}
        }
    });
    await t.test('DELETE com produto exige revisao comercial atual',async()=>{
        reset();comercial.produtos.push(produtoSintetico());const ctx=await ler();logs.length=0;
        assert.equal((await escrever('DELETE',{ctx})).r.status,428);
        assert.equal((await escrever('DELETE',{ctx,headers:{'If-Match-Produto':'"'+'0'.repeat(64)+'"'}})).r.status,412);
        assert.equal(comandos('DELETE').length,0);
    });
    await t.test('POST conjunto: categoria, SKU, preco e rollback entre INSERTs',async()=>{
        for(const [causa,status]of [['categoria',400],['sku',409],['produto',503]]){
            reset();const ctx=await ler();logs.length=0;falha=causa;
            assert.equal((await escrever('POST',{ctx,dados:dados()})).r.status,status);
            assert.equal(livros.size,1);assert.equal(comercial.produtos.length,0);assert(logs.includes('rollback'));
        }
        for(const comando of [undefined,{categoriaId:999,sku:'COM',precoCentavos:100},{categoriaId:2,sku:'',precoCentavos:100},{categoriaId:2,sku:'COM',precoCentavos:0},{categoriaId:2,sku:'COM',precoCentavos:1.1}]){
            reset();const ctx=await ler();assert.equal((await escrever('POST',{ctx,dados:{...dados(),comercial:comando}})).r.status,400);assert.equal(livros.size,1);
        }
    });
    await t.test('DELETE 428/400/412/404: revisao ausente/invalida/obsoleta e registro ausente',async()=>{
        reset();const ctx=await ler();logs.length=0;
        assert.equal((await escrever('DELETE',{ctx,headers:{'If-Match':''}})).r.status,400);
        // Keep valid CSRF while omitting only If-Match.
        assert.equal((await escrever('DELETE',{headers:{'X-CSRF-Token':ctx.csrf}})).r.status,428);
        assert.equal(logs.length,0);
        assert.equal((await escrever('DELETE',{ctx,headers:{'If-Match':'"'+'0'.repeat(64)+'"'}})).r.status,412);
        assert.equal((await escrever('DELETE',{ctx,id:999})).r.status,404);
        assert.equal(comandos('DELETE').length,0);assert.deepEqual(livros.get(1),original);
        assert.deepEqual(inesperadas,[]);
    });
    await t.test('DELETE: erro apos exclusao simula rollback e FK concorrente retorna 409',async()=>{
        for(const [etapa,status]of [['deleteDepois',503],['fk',409]]){
            reset();const ctx=await ler();logs.length=0;falha=etapa;const antes=structuredClone(comercial);
            assert.equal((await escrever('DELETE',{ctx})).r.status,status);
            assert.equal(comandos('DELETE').length,1);assert(logs.includes('rollback'));
            assert.deepEqual(livros.get(1),original);assert.equal(logs.at(-1),'release');integridade(antes);
        }
    });
    await t.test('upload de capa: autenticacao, MIME, dimensoes e configuracao falham sem gravar ou alterar livro',async()=>{
        reset();const ctx=await ler();logs.length=0;
        const enviar=async(bytes,mime,c=cookie,csrf=ctx.csrf)=>{
            const dados=new FormData();dados.append('capa',new Blob([bytes],{type:mime}),'nome-nao-confiavel.png');
            const r=await fetch(base+'/livros/capa',{method:'POST',headers:{...(c?{Cookie:c}:{}),
                Origin:env.LOJA_ORIGENS_PERMITIDAS,'X-CSRF-Token':csrf},body:dados,signal:AbortSignal.timeout(5000)});
            const texto=await r.text();assert.equal(r.headers.get('cache-control'),'no-store');
            assert.doesNotMatch(texto,/SEGREDO|nome-nao-confiavel|CAPAS_LIVROS_STORAGE_PATH|PRODUCTS_LIVROS_PATH|[A-Za-z]:\\|stack/);
            return r.status;
        };
        const pequena=await sharp({create:{width:10,height:10,channels:3,background:'#ffffff'}}).png().toBuffer();
        assert.equal(await enviar(pequena,'image/png',null),401);
        assert.equal(await enviar(pequena,'image/png',cookie,''),403);
        assert.equal(await enviar(pequena,'image/svg+xml'),400);
        assert.equal(await enviar(pequena,'image/png'),400);
        assert.equal(await enviar(Buffer.alloc(5*1024*1024+1),'image/png'),413);
        const valida=await sharp({create:{width:186,height:260,channels:3,background:'#ffffff'}}).png().toBuffer();
        // No upload path in this synthetic env: fail before mkdir/open, never touch assets.
        assert.equal(await enviar(valida,'image/png'),503);
        assert.deepEqual(livros.get(1),original);assert.equal(logs.length,0);assert.deepEqual(inesperadas,[]);
    });
    await t.test('POST e DELETE: COMMIT incerto antes/depois sem rollback presumido nem repeticao',async()=>{
        for(const metodo of ['POST','DELETE'])for(const etapa of ['commitAntes','commitDepois']){
            reset();const ctx=await ler();logs.length=0;falha=etapa;const antes=structuredClone(comercial);
            assert.equal((await escrever(metodo,{ctx,...(metodo==='POST'?{dados:dados()}:{})})).r.status,503);
            assert.equal(logs.filter(x=>x==='commit').length,1);assert(!logs.includes('rollback'));
            assert.equal(logs.at(-1),'destroy');assert(!logs.includes('release'));
            assert.equal(comandos(metodo==='POST'?'INSERT':'DELETE').length,metodo==='POST'?2:1);
            if(etapa==='commitAntes')assert.deepEqual([...livros.values()],[original]);
            else if(metodo==='POST')assert(livros.has(2));else assert.equal(livros.size,0);
            if(metodo==='POST'&&etapa==='commitDepois'){assert.equal(comercial.produtos.length,1);assert.deepEqual(comercial.pedidos,antes.pedidos);assert.deepEqual(comercial.pagamentos,antes.pagamentos);assert.deepEqual(comercial.versoes,antes.versoes);}
            else integridade(antes);
        }
    });
});
