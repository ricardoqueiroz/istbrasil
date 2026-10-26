import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,createHash} from 'node:crypto';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import mysql from 'mysql2/promise';
import {pool as poolPadrao} from '../src/config/db.js';
import {criarLojaAdminRouter} from '../src/routes/lojaAdmin.routes.js';
import {expandirCatalogoSintetico} from './fixtures/lojaCatalogoComercialFixture.js';

// Executar somente mediante autorizacao: a fixture cria instancia/schema sinteticos.
// Nao carrega dumps, .env para destino SQL, PDFs ou configuracao do pool padrao.
test('Livros administrativos: HTTP e SQL reais exclusivamente descartaveis', {timeout:120000},async t=>{
    const antigo=Boolean(process.env.IST_R2_10339_MANIFEST),limpezas=[];
    let pool,servidor,barreira=null;
    const originais=new Map();
    for(const nome of ['query','execute','getConnection']){
        originais.set(nome,poolPadrao[nome]);
        poolPadrao[nome]=()=>{throw Error('POOL_PERSISTENTE_PROIBIDO');};
    }
    t.after(async()=>{
        try {
            if(servidor){servidor.closeAllConnections();await new Promise((r,j)=>servidor.close(e=>e?j(e):r()));}
            if(pool)await pool.end();
        } finally {
            try {for(const limpar of limpezas)await limpar();}
            finally {for(const [nome,fn]of originais)poolPadrao[nome]=fn;}
        }
    });
    const {criarBancoPagamentoIsolado}=await import(antigo
        ? './fixtures/lojaCatalogoMariaDB10339.js':'./fixtures/lojaPagamentoBancoIsolado.js');
    const fx=await criarBancoPagamentoIsolado({after:fn=>limpezas.push(fn),diagnostic:v=>t.diagnostic(v)});
    const a=fx.admin;
    const [[identidade]]=await a.query('SELECT VERSION() versao,DATABASE() banco,@@port porta,@@datadir datadir');
    assert.match(identidade.versao,antigo?/^10\.3\.39-MariaDB(?:-|$)/:/^13\.0\.2-MariaDB(?:-|$)/);
    assert.match(identidade.banco,/^ist_loja_67_3_[0-9a-f]{12}$/);
    const cfg=a.config??a.connection.config;
    assert.equal(cfg.host,'127.0.0.1');
    assert.equal(Number(cfg.port),antigo?13339:Number(identidade.porta));
    // Configuracao somente da conexao autenticada/identificada pela fixture.
    // Pool novo nao depende de DB_*; nunca imprimir cfg ou password.
    pool=mysql.createPool({host:cfg.host,port:cfg.port,user:cfg.user,password:cfg.password,
        database:identidade.banco,dateStrings:true,connectionLimit:4,connectTimeout:2000});
    const [[p]]=await pool.query('SELECT DATABASE() banco,@@port porta,@@datadir datadir');
    const normalizarPorta=valor=>{
        assert.ok(typeof valor==='number'||(typeof valor==='string'&&/^[0-9]+$/.test(valor)),
            'Porta ausente ou com representacao invalida');
        const numero=Number(valor);
        assert.ok(Number.isInteger(numero)&&numero>=1&&numero<=65535,'Porta fora do intervalo TCP');
        return numero;
    };
    const portaFixture=normalizarPorta(identidade.porta),portaPool=normalizarPorta(p.porta);
    assert.deepEqual({...p,porta:portaPool},{banco:identidade.banco,porta:portaFixture,datadir:identidade.datadir});
    // id fica INT PRIMARY KEY sem AUTO_INCREMENT, pois ja e referenciado por FK.
    // Colunas editoriais reproduzem charset/collation; nenhum MODIFY id.
    await a.query(`ALTER TABLE ist_livros
        ADD title TINYTEXT CHARACTER SET latin1 COLLATE latin1_general_ci NULL,
        ADD author VARCHAR(100) NULL,
        ADD description LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
        ADD language VARCHAR(6) CHARACTER SET latin1 COLLATE latin1_general_ci NULL,
        ADD format ENUM('E-Book','Livro Físico') CHARACTER SET latin1 COLLATE latin1_general_ci NULL,
        ADD category VARCHAR(50) CHARACTER SET latin1 COLLATE latin1_general_ci NOT NULL,
        ADD img TINYTEXT CHARACTER SET latin1 COLLATE latin1_general_ci NULL,
        ADD currency CHAR(3) DEFAULT 'BRL',
        ADD sku VARCHAR(50) NULL,
        ADD onsale TINYINT DEFAULT 1,
        ADD inventory VARCHAR(32) DEFAULT 'Em estoque',
        ADD price DECIMAL(5,2) NOT NULL,
        ADD file TINYTEXT CHARACTER SET latin1 NULL,
        DEFAULT CHARACTER SET latin1 COLLATE latin1_general_ci`);
    await expandirCatalogoSintetico(a,{publicar:false});
    await a.query('ALTER TABLE ist_loja_produtos ADD autor VARCHAR(100) NULL');
    const [[coluna]]=await a.query(`SELECT COLLATION_NAME collation FROM information_schema.columns
        WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='ist_livros' AND COLUMN_NAME='title'`);
    assert.equal(coluna.collation,'latin1_general_ci');
    await a.query('CREATE TABLE ist_usuarios(id_usuario INT PRIMARY KEY,id_tipo_usuario INT NOT NULL) ENGINE=InnoDB');
    await a.query('INSERT INTO ist_usuarios(id_usuario,id_tipo_usuario) VALUES(7,1),(8,2)');
    await a.query("INSERT INTO ist_loja_categorias(id,nome,slug) VALUES(1,'Sintetica','sintetica')");
    const livros=[
        [50,'Base semelhante',0], [10,null,null], [40,"Literal %_!\\' fim",1],
        [20,'Música editorial',1], [30,'Literal ABC fim',0]
    ];
    for(const [id,title,clas]of livros)await a.execute(`INSERT INTO ist_livros
        (id,title,description,language,format,category,img,pertence_editora_ist,price,file)
        VALUES(?,?,NULL,NULL,NULL,'Musica',?,?,95.00,'privado/SEGREDO.pdf')`,
    [id,title,id===50?'privado/SEGREDO.png':null,clas]);
    await a.execute('UPDATE ist_livros SET author=?,sku=? WHERE id=20',['Autor sintetico','EDITORIAL-20']);
    await a.query("INSERT INTO ist_loja_produtos(id,categoria_id,livro_id,sku) VALUES(6,1,20,'SINTETICO-6')");
    const env={NODE_ENV:'test',COOKIE_NAME:'ist_session',JWT_SECRET:randomBytes(32).toString('hex'),
        LOJA_CSRF_SECRET:randomBytes(32).toString('base64url'),LOJA_ORIGENS_PERMITIDAS:'http://localhost:4200'};
    let reservas=0,liberacoes=0;
    const db={query:(...args)=>pool.query(...args),getConnection:async()=>{
        const c=await pool.getConnection();reservas++;
        return {query:async(sql,args)=>{
            assert.doesNotMatch(sql,/FOR UPDATE|LOCK IN SHARE MODE|SELECT\s+\*/i);
            const resultado=await c.query(sql,args);
            if(barreira&&sql.includes('COUNT(*)')){
                const continuar=barreira;barreira=null;await continuar();
            }
            return resultado;
        },commit:()=>c.commit(),rollback:()=>c.rollback(),release:()=>{liberacoes++;c.release();}};
    }};
    const app=express();app.use(cookieParser());app.use('/api/admin/loja',criarLojaAdminRouter({db,env}));
    servidor=await new Promise((r,j)=>{const s=app.listen(0,'127.0.0.1',()=>r(s));s.once('error',j);});
    const base=`http://127.0.0.1:${servidor.address().port}/api/admin/loja`;
    const cookie=id=>'ist_session='+jwt.sign({id_usuario:id,id_tipo_usuario:1},env.JWT_SECRET,{expiresIn:3600});
    const get=async(path,c=cookie(7))=>{
        const r=await fetch(base+path,{headers:c?{Cookie:c}:{},signal:AbortSignal.timeout(10000)});
        const texto=await r.text();assert.equal(r.headers.get('cache-control'),'no-store');
        assert.equal(r.headers.get('x-content-type-options'),'nosniff');
        assert.doesNotMatch(texto,/SEGREDO|privado\/|"file"|"caminho_relativo"|"sha256"|"password"|"stack"/);
        return {r,body:JSON.parse(texto)};
    };
    const ids=x=>x.body.itens.map(l=>l.id);
    const hash=async()=>createHash('sha256').update(JSON.stringify((await a.query('SELECT * FROM ist_livros ORDER BY id'))[0])).digest('hex');
    await t.test('autenticacao e papel SQL real, sem consulta editorial indevida',async()=>{
        const n=reservas;
        for(const [c,status]of [[null,401],[cookie(8),403],[cookie(999),401]]){
            const x=await get('/livros',c);assert.equal(x.r.status,status);assert.equal(x.r.headers.get('x-csrf-token'),null);
        }
        assert.equal(reservas,n);
    });
    await t.test('lista/detalhe: contrato, nulos, vinculo opcional e ausencia de escritas',async()=>{
        const antes=await hash(),x=await get('/livros');assert.equal(x.r.status,200);
        assert(x.r.headers.get('x-csrf-token'));assert.deepEqual(ids(x),[10,20,30,40,50]);
        assert.deepEqual(x.body.paginacao,{pagina:1,limite:20,total:5});
        assert.equal(x.body.itens.find(i=>i.id===20).author,'Autor sintetico');
        assert.equal(x.body.itens.find(i=>i.id===10).author,null);
        const d=await get('/livros/10');assert.equal(d.r.status,200);
        assert.deepEqual(Object.keys(d.body.item).sort(),['id','title','author','currency','description','language','format','category','img','pertenceEditoraIst','sku','price','onsale','inventory','produtoId','produtoTipo','comercial','versoesPdf','revisao'].sort());
        assert.deepEqual({...d.body.item,revisao:undefined},{id:10,title:null,author:null,currency:'BRL',description:null,language:null,
            format:null,category:'Musica',img:null,pertenceEditoraIst:null,sku:null,price:'95.00',onsale:1,
            inventory:'Em estoque',produtoId:null,produtoTipo:null,comercial:null,versoesPdf:[],revisao:undefined});
        assert.match(d.body.item.revisao,/^"[a-f0-9]{64}"$/);
        assert.equal((await get('/livros/20')).body.item.produtoId,6);
        assert.equal((await get('/livros/20')).body.item.author,'Autor sintetico');
        assert.equal((await get('/livros/20')).body.item.sku,'EDITORIAL-20');
        assert.equal((await get('/livros/50')).body.item.img,null);
        assert.equal(await hash(),antes);assert.equal(reservas,liberacoes);
    });
    await t.test('contagem, pagina ordenada, pagina vazia e filtros NULL/0/1',async()=>{
        const x=await get('/livros?pagina=2&limite=2');assert.deepEqual(ids(x),[30,40]);
        assert.deepEqual(x.body.paginacao,{pagina:2,limite:2,total:5});
        assert.deepEqual(ids(await get('/livros?pagina=99&limite=2')),[]);
        for(const [f,esperado]of [['null',[10]],['true',[20,40]],['false',[30,50]]]){
            const r=await get('/livros?pertenceEditoraIst='+f);assert.deepEqual(ids(r),esperado);
            assert.equal(r.body.paginacao.total,esperado.length);
            assert(r.body.itens.every(i=>i.pertenceEditoraIst===(f==='null'?null:f==='true')));
        }
    });
    await t.test('LIKE literal: curingas, escape, barra e apostrofo; filtros combinados',async()=>{
        for(const busca of ['%','_','!',"\\", "'","%_!\\'"]){
            const x=await get('/livros?busca='+encodeURIComponent(busca));assert.deepEqual(ids(x),[40],busca);
            assert.equal(x.body.paginacao.total,1);
        }
        assert.deepEqual(ids(await get('/livros?busca=Literal&pertenceEditoraIst=true')),[40]);
        assert.deepEqual(ids(await get('/livros?busca='+encodeURIComponent("' OR 1=1 --"))),[]);
    });
    await t.test('validacoes HTTP e inexistente nao se confundem',async()=>{
        for(const path of ['/livros?limite=101','/livros?campo=1','/livros?pagina=1&pagina=2','/livros/0','/livros/01','/livros/1?campo=1'])
            assert.equal((await get(path)).r.status,400,path);
        const x=await get('/livros/999');assert.equal(x.r.status,404);
        assert.equal(x.body.erro.codigo,'ADMIN_REGISTRO_NAO_ENCONTRADO');
    });
    await t.test('revisao independente do vinculo comercial; alteracao editorial muda revisao',async()=>{
        const antes=(await get('/livros/20')).body.item;
        await a.query('UPDATE ist_loja_produtos SET livro_id=30 WHERE id=6');
        const depois=(await get('/livros/20')).body.item;
        assert.equal(depois.produtoId,null);assert.equal(depois.revisao,antes.revisao);
        assert.equal((await get('/livros/30')).body.item.produtoId,6);
        await a.query("UPDATE ist_livros SET title='Editorial alterado' WHERE id=20");
        assert.notEqual((await get('/livros/20')).body.item.revisao,antes.revisao);
    });
    await t.test('snapshot deterministico: COMMIT concorrente entre contagem e pagina',async()=>{
        let confirmou=false;
        barreira=async()=>{
            // a e conexao independente daquela reservada pelo controller.
            await a.beginTransaction();
            try {await a.query("INSERT INTO ist_livros(id,title,category,price) VALUES(60,'Concorrente','Musica',95.00)");await a.commit();confirmou=true;}
            catch(e){await a.rollback();throw e;}
        };
        const x=await get('/livros?limite=100');assert.equal(confirmou,true);
        assert.equal(x.body.paginacao.total,5);assert.deepEqual(ids(x),[10,20,30,40,50]);
        const novo=await get('/livros?limite=100');assert.equal(novo.body.paginacao.total,6);
        assert.deepEqual(ids(novo),[10,20,30,40,50,60]);assert.equal(reservas,liberacoes);
    });
    t.diagnostic(`ADMIN_LIVROS_SQL_HTTP: ${identidade.versao}; host ${cfg.host}; porta externa ${cfg.port}; schema ${identidade.banco}; dados sinteticos; pool padrao bloqueado.`);
});
