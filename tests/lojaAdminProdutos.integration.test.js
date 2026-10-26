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
import {avaliarPoliticaComercial,criarContextoCategorias} from '../src/services/lojaCatalogoService.js';
import {randomUUID} from 'node:crypto';

// Executar somente mediante autorizacao: a fixture cria instancia/schema sinteticos.
// Nao carrega dumps, .env para destino SQL, PDFs ou configuracao do pool padrao.
test('Produtos/categorias administrativos: HTTP e SQL reais exclusivamente descartaveis', {timeout:120000},async t=>{
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
    // Manter PK referenciada, sem AUTO_INCREMENT; IDs sempre explicitos.
    await a.query(`ALTER TABLE ist_livros
        ADD title TINYTEXT CHARACTER SET latin1 COLLATE latin1_general_ci NULL,
        ADD author VARCHAR(100) NULL,
        ADD description LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
        ADD format ENUM('E-Book','Livro Físico') CHARACTER SET latin1 COLLATE latin1_general_ci NULL,
        ADD price DECIMAL(5,2) NOT NULL,ADD currency CHAR(3) DEFAULT 'BRL',
        ADD onsale TINYINT NOT NULL DEFAULT 1,ADD inventory VARCHAR(32) DEFAULT 'Em estoque'`);
    // Helper ja existente extrai DDLs homologados para a instancia validada,
    // sem executar arquivo de migration completo ou carregar dados reais.
    await expandirCatalogoSintetico(a,{publicar:false});
    await a.query('ALTER TABLE ist_loja_produtos ADD autor VARCHAR(100) NULL');
    await a.query('CREATE TABLE ist_usuarios(id_usuario INT PRIMARY KEY,id_tipo_usuario INT NOT NULL) ENGINE=InnoDB');
    await a.query('INSERT INTO ist_usuarios(id_usuario,id_tipo_usuario) VALUES(7,1),(8,2)');
    const inserirLivro=async id=>a.execute("INSERT INTO ist_livros(id,title,format,price) VALUES(?,'Editorial divergente','E-Book',1.00)",[id]);
    for(const id of [1,2,3,4,5,7,8,9,10])await inserirLivro(id);
    for(const [id,nome,slug,pai,ativo,ordem]of [
        [10,'Raiz','raiz',null,1,0],[20,'Filha','filha',10,1,2],
        [30,'Raiz inativa','inativa',null,0,1],[40,'Descendente','descendente',30,1,3],
        [50,"Literal %_!\\' categoria",'especial',null,1,4]
    ])await a.execute('INSERT INTO ist_loja_categorias(id,nome,slug,categoria_pai_id,ativo,ordem) VALUES(?,?,?,?,?,?)',[id,nome,slug,pai,ativo,ordem]);
    const baseProduto={categoria:20,livro:null,sku:'SKU',titulo:'Comercial',tipo:'DIGITAL',preco:'9500',
        ativo:1,emVenda:1,disponivel:1,moeda:'BRL',imagem:null};
    const inserirProduto=async(id,opcoes={})=>{
        const x={...baseProduto,sku:`SINT-${id}`,...opcoes};
        await a.execute(`INSERT INTO ist_loja_produtos(id,categoria_id,livro_id,sku,titulo,descricao,tipo,
            preco_centavos,moeda,ativo,em_venda,disponivel,imagem_url)
            VALUES(?,?,?,?,?,NULL,?,?,?,?,?,?,?)`,
        [id,x.categoria,x.livro,x.sku,x.titulo,x.tipo,x.preco,x.moeda,x.ativo,x.emVenda,x.disponivel,x.imagem]);
    };
    for(const [id,opcoes]of [
        [12,{sku:'SKU-ESPECIAL',titulo:"Literal %_!\\' produto"}],
        [1,{livro:1}],[2,{livro:2,ativo:0}],[3,{tipo:'MERCADORIA'}],[4,{tipo:'SERVICO'}],
        [5,{}],[6,{livro:3,sku:'IST-SANDBOX-CHECKOUT-001',preco:'100'}],
        [7,{livro:4,emVenda:0}],[8,{livro:5}],
        [9,{tipo:null,titulo:null,preco:null,moeda:null,emVenda:null,disponivel:null}],
        [10,{livro:7,preco:'9007199254740991'}],[11,{livro:8,categoria:40}],
        [13,{livro:9,disponivel:0}],[14,{livro:10}]
    ])await inserirProduto(id,opcoes);
    const inserirVersao=async(id,produto,estado)=>a.execute(`INSERT INTO ist_loja_arquivo_versoes
        (id,public_id,produto_id,arquivo_logico_id,numero_versao,caminho_relativo,tamanho_bytes,sha256,mime,
        estado,publicacao_atual,criado_em,publicado_em,retirado_em)
        VALUES(?,?,?,?,1,?,32,UNHEX(REPEAT('ab',32)),'application/pdf',?,?,
        '2026-01-01',?,?)`,[id,randomUUID(),produto,randomUUID(),`privado/SEGREDO-${id}.pdf`,
        estado,estado==='PUBLICADA'?1:null,estado==='RASCUNHO'?null:'2026-01-01',estado==='RETIRADA'?'2026-01-02':null]);
    for(const id of [1,2,7,10,11,13])await inserirVersao(id,id,'PUBLICADA');
    await inserirVersao(8,8,'RETIRADA');await inserirVersao(14,14,'RASCUNHO');
    const env={NODE_ENV:'test',IST_LOJA_PAYPAL_ENV:'sandbox',COOKIE_NAME:'ist_session',
        JWT_SECRET:randomBytes(32).toString('hex'),LOJA_CSRF_SECRET:randomBytes(32).toString('base64url'),
        LOJA_ORIGENS_PERMITIDAS:'http://localhost:4200'};
    let reservas=0,liberacoes=0;
    const consultas=[];
    const db={query:(...args)=>pool.query(...args),getConnection:async()=>{
        const c=await pool.getConnection();reservas++;
        return {query:async(sql,args)=>{
            assert.doesNotMatch(sql,/FOR UPDATE|LOCK IN SHARE MODE|SELECT\s+\*|caminho_relativo|sha256|l\.(price|title|description)/i);
            consultas.push({sql,args});const resultado=await c.query(sql,args);
            if(barreira&&sql.includes('COUNT(*)')){const continuar=barreira;barreira=null;await continuar();}
            return resultado;
        },commit:()=>c.commit(),rollback:()=>c.rollback(),release:()=>{liberacoes++;c.release();}};
    }};
    const app=express();app.use(cookieParser());app.use('/api/admin/loja',criarLojaAdminRouter({db,env}));
    servidor=await new Promise((r,j)=>{const s=app.listen(0,'127.0.0.1',()=>r(s));s.once('error',j);});
    const url=`http://127.0.0.1:${servidor.address().port}/api/admin/loja`;
    const cookie=id=>'ist_session='+jwt.sign({id_usuario:id,id_tipo_usuario:1},env.JWT_SECRET,{expiresIn:3600});
    const get=async(path,c=cookie(7))=>{
        const r=await fetch(url+path,{headers:c?{Cookie:c}:{},signal:AbortSignal.timeout(10000)}),texto=await r.text();
        assert.equal(r.headers.get('cache-control'),'no-store');assert.equal(r.headers.get('x-content-type-options'),'nosniff');
        assert.doesNotMatch(texto,/SEGREDO|privado\/|caminho_relativo|sha256|"stack"|"price"|"file"/);
        return {r,body:JSON.parse(texto)};
    };
    const listar=async path=>{const x=await get(path);assert.equal(x.r.status,200);return x.body;};
    const detalhe=async id=>{const x=await get('/produtos/'+id);assert.equal(x.r.status,200);return x.body.item;};
    const ids=b=>b.itens.map(x=>x.id);
    const snapshot=async()=>{
        const dados=[];
        for(const tabela of ['ist_livros','ist_loja_produtos','ist_loja_categorias','ist_loja_arquivo_versoes','ist_usuarios']){
            const ordem=tabela==='ist_usuarios'?'id_usuario':'id';
            dados.push((await a.query(`SELECT * FROM ${tabela} ORDER BY ${ordem}`))[0]);
        }
        return createHash('sha256').update(JSON.stringify(dados)).digest('hex');
    };
    const antesLeituras=await snapshot();
    await t.test('autenticacao/autorizacao SQL e configuracao invalida sem acesso comercial',async()=>{
        const {carregarConfiguracaoLojaAdmin}=await import('../src/middlewares/lojaAdminMiddleware.js');
        const n=reservas;
        for(const path of ['/produtos','/produtos/1','/categorias']){
            for(const [c,status]of [[null,401],[cookie(8),403],[cookie(999),401]]){
                const x=await get(path,c);assert.equal(x.r.status,status);assert.equal(x.r.headers.get('x-csrf-token'),null);
            }
            const tokenValido=cookie(7),segredo=env.JWT_SECRET;
            assert.equal(jwt.verify(tokenValido.slice('ist_session='.length),segredo).id_usuario,7);
            assert.doesNotThrow(()=>carregarConfiguracaoLojaAdmin(env));
            delete env.JWT_SECRET;
            try {
                assert.equal(Object.hasOwn(env,'JWT_SECRET'),false);
                assert.throws(()=>carregarConfiguracaoLojaAdmin(env),/CONFIGURACAO_ADMIN_INVALIDA/);
                const x=await get(path,tokenValido);assert.equal(x.r.status,503);
                assert.equal(x.body.erro.codigo,'ADMIN_INDISPONIVEL');
                assert.equal(x.r.headers.get('x-csrf-token'),null);
            }finally{env.JWT_SECRET=segredo;}
        }
        assert.equal(reservas,n);
    });
    await t.test('contrato de produto, centavos oficiais, nullable e vinculo editorial opcional',async()=>{
        const x=await get('/produtos/1');assert.equal(x.r.status,200);assert(x.r.headers.get('x-csrf-token'));
        const item=x.body.item;
        assert.deepEqual(Object.keys(item).sort(),['id','livroId','categoriaId','sku','titulo','autor','descricao','tipo',
            'precoCentavos','moeda','imagemUrl','ativo','emVenda','disponivel','formatoEditorial','temVersaoPublicada','podeComprar','revisao'].sort());
        assert.equal(item.precoCentavos,9500);assert.equal(item.livroId,1);assert.equal(item.descricao,null);
        assert.equal(item.moeda,'BRL');assert.equal(item.titulo,'Comercial');assert.match(item.revisao,/^"[a-f0-9]{64}"$/);
        const sem=await detalhe(5);assert.equal(sem.livroId,null);assert.equal(sem.formatoEditorial,null);assert.equal(sem.podeComprar,false);
        const nulo=await detalhe(9);
        for(const campo of ['titulo','descricao','tipo','precoCentavos','moeda','imagemUrl','emVenda','disponivel'])assert.equal(nulo[campo],null,campo);
    });
    await t.test('situacoes, tipos e limites seguros sem habilitar modalidades nao suportadas',async()=>{
        for(const id of [2,3,4,7,13])assert.equal((await detalhe(id)).podeComprar,false);
        assert.equal((await detalhe(2)).ativo,false);assert.equal((await detalhe(7)).emVenda,false);
        assert.equal((await detalhe(13)).disponivel,false);
        assert.equal((await detalhe(3)).tipo,'MERCADORIA');assert.equal((await detalhe(4)).tipo,'SERVICO');
        assert.equal((await detalhe(10)).precoCentavos,Number.MAX_SAFE_INTEGER);
        assert.equal((await detalhe(1)).precoCentavos,9500);
    });
    await t.test('produtos: contagem, ordem, paginas vazias e filtros combinados',async()=>{
        const b=await listar('/produtos?limite=100');assert.equal(b.paginacao.total,14);
        assert.deepEqual(ids(b),Array.from({length:14},(_,i)=>i+1));
        const pag=await listar('/produtos?pagina=2&limite=3');assert.deepEqual(ids(pag),[4,5,6]);
        assert.deepEqual(pag.paginacao,{pagina:2,limite:3,total:14});
        const vazia=await listar('/produtos?pagina=99');assert.deepEqual(ids(vazia),[]);assert.equal(vazia.paginacao.total,14);
        assert.deepEqual(ids(await listar('/produtos?categoriaId=20&ativo=false&emVenda=true&disponivel=true')),[2]);
        assert.deepEqual(ids(await listar('/produtos?emVenda=false')),[7]);
        assert.deepEqual(ids(await listar('/produtos?disponivel=false')),[13]);
    });
    await t.test('busca literal parametrizada titulo/SKU/nome e curingas adversos',async()=>{
        for(const busca of ['%','_','!',"\\","'","%_!\\'"]){
            const b=await listar('/produtos?busca='+encodeURIComponent(busca));assert.deepEqual(ids(b),[12]);assert.equal(b.paginacao.total,1);
            assert.deepEqual(ids(await listar('/categorias?busca='+encodeURIComponent(busca))),[50]);
        }
        assert.deepEqual(ids(await listar('/produtos?busca=SKU-ESPECIAL')),[12]);
        const ataque="' OR 1=1 --";consultas.length=0;
        assert.deepEqual(ids(await listar('/produtos?busca='+encodeURIComponent(ataque))),[]);
        const q=consultas.find(x=>x.sql.includes('ORDER BY p.id'));
        assert(!q.sql.includes(ataque));assert.deepEqual(q.args.slice(0,2),['%'+ataque+'%','%'+ataque+'%']);
    });
    await t.test('categorias: lista plana, hierarquia, inativas, ordem e filtros',async()=>{
        const b=await listar('/categorias');assert.deepEqual(ids(b),[10,30,20,40,50]);assert.equal(b.paginacao.total,5);
        assert.deepEqual(b.itens[2],{id:20,nome:'Filha',slug:'filha',categoriaPaiId:10,ativo:true,ordem:2});
        assert.deepEqual(ids(await listar('/categorias?ativo=false')),[30]);
        assert.deepEqual(ids(await listar('/categorias?pagina=2&limite=2')),[20,40]);
        const vazia=await listar('/categorias?pagina=99');assert.deepEqual(ids(vazia),[]);assert.equal(vazia.paginacao.total,5);
        assert.equal((await detalhe(11)).podeComprar,false); // categoria ativa, ancestral inativo
    });
    await t.test('publicacao e politica compartilhada, incluindo contexto Sandbox especifico',async()=>{
        // Adaptacao de transporte SQL, sem reproduzir regras comerciais ou o mapper HTTP.
        const inteiroSql=(valor,min,max,nullable=false)=>{
            if(nullable&&valor===null)return null;
            assert.ok(typeof valor==='number'||(typeof valor==='string'&&/^[0-9]+$/.test(valor)),
                'Representacao numerica SQL invalida');
            const n=Number(valor);
            assert.ok(Number.isSafeInteger(n)&&n>=min&&n<=max,'Inteiro SQL fora do contrato');
            return n;
        };
        const idSql=(v,nullable=false)=>inteiroSql(v,1,2147483647,nullable);
        const binarioSql=(v,nullable=false)=>inteiroSql(v,0,1,nullable);
        assert.equal((await detalhe(1)).temVersaoPublicada,true);
        for(const id of [8,14]){const p=await detalhe(id);assert.equal(p.temVersaoPublicada,false);assert.equal(p.podeComprar,false);}
        const [categorias]=await a.query('SELECT id,categoria_pai_id,ativo FROM ist_loja_categorias');
        const {caminho}=criarContextoCategorias(categorias.map(c=>({...c,id:idSql(c.id),
            categoria_pai_id:idSql(c.categoria_pai_id,true),ativo:binarioSql(c.ativo)})));
        const [produtos]=await a.query(`SELECT p.id,p.categoria_id,p.livro_id,p.sku,p.titulo,p.descricao,p.tipo,
            CAST(p.preco_centavos AS CHAR) preco_centavos,p.moeda,p.ativo,p.em_venda,p.disponivel,l.format formato_editorial,
            EXISTS(SELECT 1 FROM ist_loja_arquivo_versoes v WHERE v.produto_id=p.id AND v.estado='PUBLICADA' AND v.publicacao_atual=1) versao_publicada
            FROM ist_loja_produtos p LEFT JOIN ist_livros l ON l.id=p.livro_id ORDER BY p.id`);
        for(const row of produtos){
            // CAST AS CHAR deve permanecer decimal exato; nao converter preco em Number.
            if(row.preco_centavos!==null){
                assert.equal(typeof row.preco_centavos,'string');
                assert.match(row.preco_centavos,/^[1-9][0-9]*$/);
                assert.ok(BigInt(row.preco_centavos)<=BigInt(Number.MAX_SAFE_INTEGER));
            }
            const referencia={...row,id:idSql(row.id),categoria_id:idSql(row.categoria_id),
                livro_id:idSql(row.livro_id,true),ativo:binarioSql(row.ativo),
                em_venda:binarioSql(row.em_venda,true),disponivel:binarioSql(row.disponivel,true),
                versao_publicada:binarioSql(row.versao_publicada)};
            const esperado=avaliarPoliticaComercial(referencia,caminho,{ambienteBackend:env.NODE_ENV,ambientePaypal:env.IST_LOJA_PAYPAL_ENV});
            assert.equal((await detalhe(row.id)).podeComprar,esperado.elegivel,`produto ${row.id}`);
        }
        assert.equal((await detalhe(6)).podeComprar,true);
        const anteriores={NODE_ENV:env.NODE_ENV,COOKIE_SECURE:env.COOKIE_SECURE,LOJA_ORIGENS_PERMITIDAS:env.LOJA_ORIGENS_PERMITIDAS};
        env.NODE_ENV='production';env.COOKIE_SECURE='true';
        try {
            // HTTP continua recusado; HTTPS sintetico libera a avaliacao, sem rede externa.
            assert.equal((await get('/produtos/6')).r.status,503);
            env.LOJA_ORIGENS_PERMITIDAS='https://admin.example.invalid';
            const n=reservas,x=await get('/produtos/6');
            assert.equal(x.r.status,200);assert(x.r.headers.get('x-csrf-token'));
            assert(reservas>n);assert.equal(x.body.item.id,6);
            assert.equal(x.body.item.temVersaoPublicada,false);assert.equal(x.body.item.podeComprar,false);
            assert.equal((await detalhe(1)).podeComprar,true);
        }finally{
            env.NODE_ENV=anteriores.NODE_ENV;env.LOJA_ORIGENS_PERMITIDAS=anteriores.LOJA_ORIGENS_PERMITIDAS;
            if(anteriores.COOKIE_SECURE===undefined)delete env.COOKIE_SECURE;else env.COOKIE_SECURE=anteriores.COOKIE_SECURE;
        }
    });
    await t.test('validacoes e 404 com envelopes sanitizados; GETs nao escrevem',async()=>{
        const n=reservas;
        for(const path of ['/produtos/0','/produtos/01','/produtos/1?extra=1','/produtos?ativo=null',
            '/produtos?pagina=1&pagina=2','/produtos?tipo=DIGITAL','/produtos?categoriaId=0','/categorias?limite=101']){
            const x=await get(path);assert.equal(x.r.status,400);assert.equal(x.body.erro.codigo,'ADMIN_ENTRADA_INVALIDA');
        }
        assert.equal(reservas,n);
        const ausente=await get('/produtos/999');assert.equal(ausente.r.status,404);assert.equal(ausente.body.erro.codigo,'ADMIN_REGISTRO_NAO_ENCONTRADO');
        assert.equal(await snapshot(),antesLeituras);assert.equal(reservas,liberacoes);
    });
    await t.test('revisao estavel para publicacao/editorial/categoria; muda com dado comercial',async()=>{
        const antes=await detalhe(1);
        await a.query("UPDATE ist_loja_arquivo_versoes SET estado='RETIRADA',publicacao_atual=NULL,retirado_em='2026-01-02' WHERE id=1");
        let depois=await detalhe(1);assert.equal(depois.temVersaoPublicada,false);assert.equal(depois.podeComprar,false);assert.equal(depois.revisao,antes.revisao);
        await a.query("UPDATE ist_livros SET format='Livro Físico' WHERE id=1");
        assert.equal((await detalhe(1)).revisao,antes.revisao);
        await a.query('UPDATE ist_loja_categorias SET ativo=0 WHERE id=10');
        assert.equal((await detalhe(1)).revisao,antes.revisao);
        await a.query('UPDATE ist_loja_produtos SET preco_centavos=9501 WHERE id=1');
        assert.notEqual((await detalhe(1)).revisao,antes.revisao);
        await a.query("UPDATE ist_loja_produtos SET imagem_url='privado/SEGREDO.png' WHERE id=1");
        assert.equal((await detalhe(1)).imagemUrl,null);
    });
    await t.test('snapshot produtos: COMMIT concorrente entre contagem e pagina',async()=>{
        let confirmou=false;
        barreira=async()=>{await a.beginTransaction();try{await inserirProduto(15);await a.commit();confirmou=true;}catch(e){await a.rollback();throw e;}};
        const b=await listar('/produtos?limite=100');assert.equal(confirmou,true);assert.equal(b.paginacao.total,14);assert(!ids(b).includes(15));
        const novo=await listar('/produtos?limite=100');assert.equal(novo.paginacao.total,15);assert(ids(novo).includes(15));
    });
    await t.test('snapshot categorias: COMMIT concorrente entre contagem e pagina',async()=>{
        let confirmou=false;
        barreira=async()=>{await a.beginTransaction();try{
            await a.query("INSERT INTO ist_loja_categorias(id,nome,slug,ordem) VALUES(60,'Concorrente','concorrente',5)");
            await a.commit();confirmou=true;
        }catch(e){await a.rollback();throw e;}};
        const b=await listar('/categorias?limite=100');assert.equal(confirmou,true);assert.equal(b.paginacao.total,5);assert(!ids(b).includes(60));
        const novo=await listar('/categorias?limite=100');assert.equal(novo.paginacao.total,6);assert(ids(novo).includes(60));assert.equal(reservas,liberacoes);
    });
    t.diagnostic(`ADMIN_PRODUTOS_SQL_HTTP: ${identidade.versao}; host ${cfg.host}; porta externa ${cfg.port}; schema ${identidade.banco}; somente dados sinteticos; pool padrao bloqueado.`);
});
