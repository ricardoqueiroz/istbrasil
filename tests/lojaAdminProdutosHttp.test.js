import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import {randomBytes} from 'node:crypto';
import {criarLojaAdminRouter} from '../src/routes/lojaAdmin.routes.js';
import {avaliarPoliticaComercial,criarContextoCategorias} from '../src/services/lojaCatalogoService.js';

test('Produtos/categorias administrativos: HTTP real, SQL exclusivamente simulado',async t=>{
    const env={NODE_ENV:'test',IST_LOJA_PAYPAL_ENV:'sandbox',COOKIE_NAME:'ist_session',
        JWT_SECRET:randomBytes(32).toString('hex'),LOJA_CSRF_SECRET:randomBytes(32).toString('base64url'),
        LOJA_ORIGENS_PERMITIDAS:'http://localhost:4200'};
    const original={id:1,livro_id:2,categoria_id:20,autor:null,sku:'SKU original',titulo:'Comercial',descricao:null,
        tipo:'DIGITAL',preco_centavos:'9500',moeda:'BRL',imagem_url:'assets/images/capa.png',ativo:1,
        em_venda:1,disponivel:1,formato_editorial:'E-Book',versao_publicada:1,
        caminho_relativo:'privado/SEGREDO.pdf',sha256:'SEGREDO',file:'SEGREDO'};
    let produto={...original},tipoUsuario=1,falha=null,vazio=false;
    const categorias=[{id:10,nome:'Raiz',slug:'raiz',categoria_pai_id:null,ativo:1,ordem:0},
        {id:20,nome:'Filha',slug:'filha',categoria_pai_id:10,ativo:1,ordem:1}];
    const logs=[];
    const db={query:async(sql,args)=>{
        assert.equal(sql,'SELECT id_tipo_usuario FROM ist_usuarios WHERE id_usuario = ?');
        assert.deepEqual(args,[7]);return [[{id_tipo_usuario:tipoUsuario}]];
    },getConnection:async()=>{
        logs.push('conexao');if(falha==='conexao')throw Error('SEGREDO_SQL');
        return {query:async(sql,args)=>{
            logs.push([sql,args]);if(falha&&sql.includes(falha))throw Error('SEGREDO_SQL');
            assert.doesNotMatch(sql,/SELECT\s+\*|caminho_relativo|sha256|l\.(price|file|sku|currency)|FOR UPDATE|LOCK IN SHARE MODE/i);
            if(sql.includes('COUNT(*)'))return [[{total:vazio?'0':'1'}]];
            if(sql.includes('FROM ist_loja_categorias'))return [categorias];
            if(sql.startsWith('SELECT'))return [vazio||args?.[0]===999?[]:[produto]];
            return [[]];
        },commit:async()=>{logs.push('commit');if(falha==='commit')throw Error('SEGREDO_SQL');},
        rollback:async()=>logs.push('rollback'),release:()=>logs.push('release')};
    }};
    const app=express();app.use(cookieParser());app.use('/api/admin/loja',criarLojaAdminRouter({db,env}));
    const server=await new Promise((r,j)=>{const s=app.listen(0,'127.0.0.1',()=>r(s));s.once('error',j);});
    t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
    const base=`http://127.0.0.1:${server.address().port}/api/admin/loja`;
    const cookie='ist_session='+jwt.sign({id_usuario:7,id_tipo_usuario:1},env.JWT_SECRET,{expiresIn:3600});
    const get=async(path,c=cookie)=>{
        const r=await fetch(base+path,{headers:c?{Cookie:c}: {}}),text=await r.text();
        assert.equal(r.headers.get('cache-control'),'no-store');assert.equal(r.headers.get('x-content-type-options'),'nosniff');
        assert.doesNotMatch(text,/SEGREDO|caminho_relativo|sha256|stack|SELECT/);
        assert(!text.includes(cookie));return {r,body:JSON.parse(text)};
    };
    await t.test('401/403/503 e CSRF apenas autorizado nos tres GETs',async()=>{
        for(const path of ['/produtos','/produtos/1','/categorias']){
            let x=await get(path,null);assert.equal(x.r.status,401);assert.equal(x.r.headers.get('x-csrf-token'),null);
            tipoUsuario=2;x=await get(path);assert.equal(x.r.status,403);assert.equal(x.r.headers.get('x-csrf-token'),null);tipoUsuario=1;
            const segredo=env.JWT_SECRET;delete env.JWT_SECRET;x=await get(path);assert.equal(x.r.status,503);env.JWT_SECRET=segredo;
        }
        assert.equal(logs.length,0);
    });
    await t.test('DTO comercial, detalhe/lista e snapshot completo de categorias',async()=>{
        const x=await get('/produtos');assert.equal(x.r.status,200);assert(x.r.headers.get('x-csrf-token'));
        assert.deepEqual(x.body.paginacao,{pagina:1,limite:20,total:1});
        const item=x.body.itens[0];assert.equal(item.precoCentavos,9500);assert.equal(item.disponivel,true);assert.equal(item.podeComprar,true);
        assert.deepEqual(Object.keys(item).sort(),['id','livroId','categoriaId','sku','autor','titulo','descricao','tipo','precoCentavos','moeda','imagemUrl',
            'ativo','emVenda','disponivel','formatoEditorial','temVersaoPublicada','podeComprar','revisao'].sort());
        assert.deepEqual((await get('/produtos/1')).body.item,item);
        assert.equal(logs.at(-1),'release');assert.equal(logs.at(-2),'commit');
        assert(logs.some(x=>Array.isArray(x)&&x[0].includes('CONSISTENT SNAPSHOT, READ ONLY')));
        const sql=logs.find(x=>Array.isArray(x)&&x[0].includes('ORDER BY p.id'))[0];
        assert.match(sql,/LEFT JOIN ist_livros/);assert.match(sql,/v.estado='PUBLICADA' AND v.publicacao_atual=1/);
    });
    await t.test('politica compartilhada: modalidades, nulos, flags e publicacao',async()=>{
        const casos=[{}, {ativo:0},{em_venda:0},{disponivel:0},{versao_publicada:0},
            {tipo:'MERCADORIA'},{tipo:'SERVICO'},{livro_id:null,formato_editorial:null},
            {tipo:null,titulo:null,descricao:null,moeda:null,em_venda:null,disponivel:null,preco_centavos:null,imagem_url:null},
            {preco_centavos:'9007199254740991'},
            {id:6,livro_id:3,autor:null,sku:'IST-SANDBOX-CHECKOUT-001',preco_centavos:'100',versao_publicada:0}];
        for(const caso of casos){
            produto={...original,...caso};const x=await get('/produtos/1');assert.equal(x.r.status,200);
            const {caminho}=criarContextoCategorias(categorias);
            const esperado=avaliarPoliticaComercial(produto,caminho,{ambienteBackend:env.NODE_ENV,ambientePaypal:env.IST_LOJA_PAYPAL_ENV});
            assert.equal(x.body.item.podeComprar,esperado.elegivel);assert.equal(x.body.item.disponivel,produto.disponivel===null?null:produto.disponivel===1);
            assert.equal(x.body.item.tipo,produto.tipo);assert.equal(x.body.item.precoCentavos,produto.preco_centavos===null?null:Number(produto.preco_centavos));
            assert.equal(x.body.item.livroId,produto.livro_id);
        }
        produto={...original};
        for(const i of [0,1]){
            categorias[i].ativo=0;assert.equal((await get('/produtos/1')).body.item.podeComprar,false);categorias[i].ativo=1;
        }
    });
    await t.test('revisao exclui derivados e usa imagem persistida sem expo-la',async()=>{
        const a=(await get('/produtos/1')).body.item;
        produto.versao_publicada=0;produto.formato_editorial='Livro Físico';categorias[0].ativo=0;
        const b=(await get('/produtos/1')).body.item;assert.equal(a.revisao,b.revisao);assert.equal(b.podeComprar,false);
        categorias[0].ativo=1;produto={...original,preco_centavos:'9501'};
        assert.notEqual((await get('/produtos/1')).body.item.revisao,a.revisao);
        produto.imagem_url='privado/SEGREDO.png';assert.equal((await get('/produtos/1')).body.item.imagemUrl,null);
        produto={...original};
    });
    await t.test('busca literal, filtros parametrizados e paginacao',async()=>{
        logs.length=0;const busca="a%'_!";
        assert.equal((await get('/produtos?pagina=2&limite=3&categoriaId=20&ativo=false&emVenda=true&disponivel=false&busca='+encodeURIComponent(busca))).r.status,200);
        const q=logs.find(x=>Array.isArray(x)&&x[0].includes('ORDER BY p.id'));
        assert(!q[0].includes(busca));assert.deepEqual(q[1],["%a!%'!_!!%","%a!%'!_!!%",20,0,1,0,3,3]);
        assert.match(q[0],/p.categoria_id=\?/);assert.match(q[0],/p.sku LIKE \? ESCAPE '!'/);
        vazio=true;assert.deepEqual((await get('/produtos')).body,{itens:[],paginacao:{pagina:1,limite:20,total:0}});vazio=false;
    });
    await t.test('categorias planas incluindo inativas e busca parametrizada',async()=>{
        categorias[0].ativo=0;logs.length=0;
        const x=await get('/categorias?pagina=2&limite=3&ativo=false&busca='+encodeURIComponent('%_!'));
        assert.equal(x.r.status,200);assert(x.r.headers.get('x-csrf-token'));
        assert.deepEqual(x.body.itens[0],{id:10,nome:'Raiz',slug:'raiz',categoriaPaiId:null,ativo:false,ordem:0});
        assert.equal(x.body.itens[1].categoriaPaiId,10);
        const q=logs.find(x=>Array.isArray(x)&&x[0].includes('ORDER BY ordem'));
        assert.deepEqual(q[1],['%!%!_!!%','%!%!_!!%',0,3,3]);categorias[0].ativo=1;
    });
    await t.test('IDs e filtros invalidos nao consultam catalogo; inexistente 404',async()=>{
        for(const path of ['/produtos/0','/produtos/01','/produtos/1?extra=1','/produtos?tipo=DIGITAL',
            '/produtos?ativo=null','/produtos?categoriaId=0','/produtos?pagina=1&pagina=2','/categorias?limite=101','/categorias?categoriaId=1']){
            const n=logs.length;assert.equal((await get(path)).r.status,400,path);assert.equal(logs.length,n);
        }
        assert.equal((await get('/produtos/999')).r.status,404);
    });
    await t.test('precos nao representaveis e falhas SQL/commit sao 503 sanitizados',async()=>{
        for(const preco of ['9007199254740992','1.5','',0,-1,NaN]){
            produto={...original,preco_centavos:preco};assert.equal((await get('/produtos/1')).r.status,503);assert.equal(logs.at(-1),'release');
        }
        produto={...original};
        for(const path of ['/produtos','/categorias'])for(const etapa of ['COUNT(*)','commit','conexao']){
            falha=etapa;logs.length=0;assert.equal((await get(path)).r.status,503);
            if(etapa!=='conexao'){assert(logs.includes('rollback'));assert.equal(logs.at(-1),'release');}
        }
        falha=null;
    });
});
