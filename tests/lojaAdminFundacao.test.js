import test from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import {randomBytes,createHash,createHmac} from 'node:crypto';
import {criarProtecaoLojaAdmin,carregarConfiguracaoLojaAdmin,tratarErroAdmin,responderErroAdmin} from '../src/middlewares/lojaAdminMiddleware.js';
import {CONTRATOS_LOJA_ADMIN,validarEntradaAdmin,validarConsultaAdmin,validarIdAdmin,criarEtagAdmin,conferirIfMatchAdmin,MAX_PDF_ADMIN,CAMPOS_REVISAO_ADMIN,projetarRevisaoAdmin} from '../src/services/lojaAdminContratos.js';
import {avaliarPoliticaComercial} from '../src/services/lojaCatalogoService.js';

const env=()=>({NODE_ENV:'test',JWT_SECRET:randomBytes(32).toString('hex'),LOJA_CSRF_SECRET:randomBytes(32).toString('base64url'),LOJA_ORIGENS_PERMITIDAS:'http://localhost:4200'});
const montar=({config=env(),tipo=1,token,semUsuario=false,falha=false,agoraMs=Date.now}={})=>{
    let consultas=0;const p=criarProtecaoLojaAdmin({env:config,agoraMs,db:{query:async(sql,args)=>{
        consultas++;assert.equal(args[0],7);assert.equal(sql,'SELECT id_tipo_usuario FROM ist_usuarios WHERE id_usuario = ?');
        if(falha)throw Error('SENHA_SQL_SINTETICA');return [semUsuario?[]:[{id_tipo_usuario:tipo}]];
    }}});
    const t=token??jwt.sign({id_usuario:7,id_tipo_usuario:1},config.JWT_SECRET||'fixture-insecure',{expiresIn:3600});
    const req={method:'POST',cookies:{ist_session:t},headers:{cookie:`ist_session=${t}`},
        get(n){return this.headers[n.toLowerCase()];}};
    const res={statusCode:200,headers:{},status(n){this.statusCode=n;return this;},
        set(k,v){if(typeof k==='object')Object.assign(this.headers,k);else this.headers[k]=v;return this;},
        json(body){this.body=body;return this;}};
    let n=0;return {p,req,res,t,config,next:()=>n++,get avancou(){return n;},get consultas(){return consultas;}};
};
test('sem autenticacao e cookie de compra nao concedem autoridade',async()=>{
    const m=montar();m.req.cookies={};m.req.headers.cookie='ist-loja-dev=COMPRA';
    await m.p.entrada(m.req,m.res,m.next);assert.equal(m.res.statusCode,401);assert.equal(m.consultas,0);assert.equal(m.avancou,0);
    assert.equal(m.res.headers['Cache-Control'],'no-store');
});
test('cookie duplicado, JWT invalido, expirado, sem exp e algoritmo inesperado negados',async()=>{
    const c=env();const payload={id_usuario:7,id_tipo_usuario:1};
    for(const token of ['invalido',jwt.sign(payload,c.JWT_SECRET,{expiresIn:-1}),jwt.sign(payload,c.JWT_SECRET),
        jwt.sign(payload,c.JWT_SECRET,{algorithm:'HS384',expiresIn:3600})]){
        const m=montar({config:c,token});await m.p.entrada(m.req,m.res,m.next);assert.equal(m.res.statusCode,401);assert.equal(m.consultas,0);
    }
    const m=montar();m.req.headers.cookie+=`; ist_session=${m.t}`;await m.p.entrada(m.req,m.res,m.next);assert.equal(m.res.statusCode,401);
});
test('papel atual do banco prevalece sobre JWT administrativo; usuario removido negado',async()=>{
    for(const opts of [{tipo:2},{semUsuario:true}]){
        const m=montar(opts);await m.p.entrada(m.req,m.res,m.next);assert.equal(m.res.statusCode,opts.semUsuario?401:403);assert.equal(m.avancou,0);assert.equal(m.consultas,1);
    }
});
test('JWT ausente, fallback ou configuracao invalida falham fechado antes de SQL',async()=>{
    for(const mudanca of [{JWT_SECRET:undefined},{JWT_SECRET:''},{JWT_SECRET:'dev-only-insecure-secret'},
        {JWT_SECRET:' '.repeat(64)},{JWT_SECRET:'replace-with-a-long-random-secret'},{LOJA_CSRF_SECRET:undefined},
        {COOKIE_NAME:'ist-loja-dev'},{COOKIE_HTTPONLY:'false'},{NODE_ENV:undefined}]){
        const m=montar({config:{...env(),...mudanca}});await m.p.entrada(m.req,m.res,m.next);assert.equal(m.res.statusCode,503);assert.equal(m.consultas,0);
    }
    assert.throws(()=>carregarConfiguracaoLojaAdmin({...env(),NODE_ENV:'production',LOJA_ORIGENS_PERMITIDAS:'https://ist.example'}));
    assert.doesNotThrow(()=>carregarConfiguracaoLojaAdmin({...env(),NODE_ENV:'production',COOKIE_SECURE:'true',LOJA_ORIGENS_PERMITIDAS:'https://ist.example'}));
});
test('CSRF ligado a sessao autenticada, origem exata e prazo; sem nova sessao de compra',async()=>{
    const m=montar();await m.p.entrada(m.req,m.res,m.next);assert.equal(m.avancou,1);
    const csrf=m.p.emitirCsrf(m.req);m.req.headers.origin='http://localhost:4200';
    m.p.protegerEscrita(m.req,m.res,m.next);assert.equal(m.res.statusCode,403);assert.equal(m.avancou,1);
    m.req.headers['x-csrf-token']=csrf;m.p.protegerEscrita(m.req,m.res,m.next);assert.equal(m.avancou,2);
    for(const origin of [undefined,'https://evil.invalid','http://localhost:4200.evil.invalid']){
        m.req.headers.origin=origin;m.p.protegerEscrita(m.req,m.res,m.next);assert.equal(m.avancou,2);
    }
    const outro=montar({config:m.config});outro.req.cookies.ist_session=jwt.sign({id_usuario:7,id_tipo_usuario:1,jti:'OUTRO'},m.config.JWT_SECRET,{expiresIn:3600});
    outro.req.headers.cookie=`ist_session=${outro.req.cookies.ist_session}`;
    await outro.p.entrada(outro.req,outro.res,outro.next);outro.req.headers.origin='http://localhost:4200';outro.req.headers['x-csrf-token']=csrf;
    outro.p.protegerEscrita(outro.req,outro.res,outro.next);assert.equal(outro.res.statusCode,403);assert.equal(outro.avancou,1);
    m.req.headers.origin='http://localhost:4200';m.req.headers['x-csrf-token']='1.'+csrf.split('.').slice(1).join('.');
    m.p.protegerEscrita(m.req,m.res,m.next);assert.equal(m.avancou,2);
});
test('cross-site e chamada sem entrada administrativa nao avancam',async()=>{
    const m=montar();m.p.protegerEscrita(m.req,m.res,m.next);assert.equal(m.res.statusCode,401);
    await m.p.entrada(m.req,m.res,m.next);m.req.headers.origin='http://localhost:4200';m.req.headers['sec-fetch-site']='cross-site';
    m.req.headers['x-csrf-token']=m.p.emitirCsrf(m.req);m.p.protegerEscrita(m.req,m.res,m.next);assert.equal(m.avancou,1);
});
test('falhas SQL e erros arbitrarios possuem envelope sanitizado e no-store',async()=>{
    const m=montar({falha:true});await m.p.entrada(m.req,m.res,m.next);
    assert.equal(m.res.statusCode,503);assert.deepEqual(Object.keys(m.res.body),['erro']);
    assert.deepEqual(Object.keys(m.res.body.erro),['codigo','mensagem']);assert.doesNotMatch(JSON.stringify(m.res.body),/SENHA|SELECT|stack|JWT/);
    tratarErroAdmin(Error('SEGREDO'),m.req,m.res,m.next);assert.doesNotMatch(JSON.stringify(m.res.body),/SEGREDO/);
    assert.equal(m.res.headers['Cache-Control'],'no-store');
});
test('onze contratos administrativos; POST editorial valido e DELETE exige revisao',()=>{
    assert.equal(CONTRATOS_LOJA_ADMIN.length,11);assert(CONTRATOS_LOJA_ADMIN.every(c=>c.permissao===1&&!c.handler));
    assert.equal(MAX_PDF_ADMIN,33554432);
    const livro={title:'Livro',format:'E-Book',category:'Musica',pertenceEditoraIst:true,comercial:{categoriaId:1,sku:'COM-1',precoCentavos:1000}};
    assert.deepEqual(validarEntradaAdmin('livros','POST',livro),livro);
    const post=CONTRATOS_LOJA_ADMIN.find(c=>c.metodo==='POST'&&c.rota==='/api/admin/loja/livros');
    assert.equal(post.bloqueado,false); // Compatibilidade de price pertence ao handler, nao ao validador.
    const excluir=CONTRATOS_LOJA_ADMIN.find(c=>c.metodo==='DELETE'&&c.rota==='/api/admin/loja/livros/:id');
    assert.equal(excluir.ifMatch,true);assert.deepEqual(excluir.campos,[]);
});
test('campos comerciais legados, privados, desconhecidos e tipos invalidos rejeitados',()=>{
    for(const language of ['pt-BR','pt-PT','en','en-US','en-GB','es','fr','fr-CA','de','it','ja','pt-br','es-419'])
        assert.equal(validarEntradaAdmin('livros','PATCH',{language}).language,language);
    assert.throws(()=>validarEntradaAdmin('livros','PATCH',{language:'pt-419'}));
    for(const extra of ['file','currency','precoCentavos'])
        assert.throws(()=>validarEntradaAdmin('livros','PATCH',{title:'Editorial',[extra]:'NAO'}));
    for(const entrada of [{titulo:'Comercial',podeComprar:true},{precoCentavos:1.5},{precoCentavos:0},{moeda:'USD'},{tipo:'MERCADORIA'},{ativo:1},{arquivoVersaoId:1}])
        assert.throws(()=>validarEntradaAdmin('produtos','PATCH',entrada));
    assert.deepEqual(validarEntradaAdmin('livros','PATCH',{category:'Musica'}),{category:'Musica'});
    assert.deepEqual(validarEntradaAdmin('produtos','PATCH',{precoCentavos:9500}),{precoCentavos:9500});
    assert.throws(()=>validarEntradaAdmin('situacao','PATCH',{file:'privado'}));
    assert.throws(()=>validarEntradaAdmin('livros','PATCH',{}));
    assert.throws(()=>validarEntradaAdmin('toString','PATCH',{x:1}));
});

test('livros ampliados: preco decimal exato, SKU latin1, JSON e marcadores legados',()=>{
    const dados={sku:'REF-01',format:'E-Book',description:JSON.stringify({Título:'Editorial',Extra:{preservar:true}}),
        price:'999.99',onsale:0,inventory:'Poucas unidades',language:'es-419'};
    assert.deepEqual(validarEntradaAdmin('livros','PATCH',dados),dados);
    for(const price of ['0.00','0.01','12.30','999.99',null])
        assert.deepEqual(validarEntradaAdmin('livros','PATCH',{price}),{price});
    for(const price of [1,0.1,'1,00','1000.00','-1.00','1.001','NaN','1e2',''])
        assert.throws(()=>validarEntradaAdmin('livros','PATCH',{price}));
    for(const entrada of [{sku:'😀'},{sku:'x'.repeat(51)},{onsale:true},{onsale:2},{inventory:'Outro'},
        {description:'texto legado'},{description:'[]'},{description:'null'}])
        assert.throws(()=>validarEntradaAdmin('livros','PATCH',entrada));
});
test('consulta paginada e IDs estritos sem interpolacao de SQL ou filtros arbitrarios',()=>{
    assert.deepEqual(validarConsultaAdmin('produtos',{pagina:'2',limite:'10',ativo:'false'}),{pagina:2,limite:10,ativo:false});
    for(const q of [{limite:'101'},{sort:'DROP'},{pagina:['1']},{ativo:'1'}])assert.throws(()=>validarConsultaAdmin('produtos',q));
    for(const id of ['0','1 OR 1','01','2147483648'])assert.throws(()=>validarIdAdmin(id));
    assert.equal(validarIdAdmin('2'),2);
});
const produtoPersistido=()=>({autor:null,livroId:1,categoriaId:1,sku:'SKU / ed. 2',titulo:'A',descricao:null,tipo:'DIGITAL',
    precoCentavos:100,moeda:'BRL',imagemUrl:null,ativo:true,emVenda:true,disponivel:true});
test('ETag forte, deterministico, escopado por registro; If-Match obrigatorio e comparado',()=>{
    const dto=produtoPersistido(),a=criarEtagAdmin('produtos',1,dto);
    assert.equal(a,criarEtagAdmin('produtos',1,Object.fromEntries(Object.entries(dto).reverse())));
    assert.notEqual(a,criarEtagAdmin('produtos',2,dto));
    assert.throws(()=>conferirIfMatchAdmin(undefined,a),e=>e.statusAdmin===428);
    for(const h of ['*','W/'+a,a+','+a])assert.throws(()=>conferirIfMatchAdmin(h,a),e=>e.statusAdmin===400);
    assert.throws(()=>conferirIfMatchAdmin(criarEtagAdmin('produtos',1,{...dto,titulo:'B'}),a),e=>e.statusAdmin===412);
    assert.doesNotThrow(()=>conferirIfMatchAdmin(a,a));
});

test('SKU administrativo preserva os mesmos criterios da politica comercial existente',()=>{
    for(const sku of ['REF / edição 2.0','A:B+2026','é'.repeat(50),'𝄞'.repeat(50),' '.repeat(3),'a'.repeat(51),'a\ud800']){
        const p={id:1,ativo:1,em_venda:1,categoria_id:1,tipo:'DIGITAL',moeda:'BRL',preco_centavos:100,titulo:'Livro',descricao:null,sku};
        const valido=avaliarPoliticaComercial(p,()=>true).visivel;
        if(valido)assert.deepEqual(validarEntradaAdmin('produtos','PATCH',{sku}),{sku});
        else assert.throws(()=>validarEntradaAdmin('produtos','PATCH',{sku}));
    }
});
test('latin1/cp1252: limites armazenados, acentos e caracteres estendidos sem substituicao',()=>{
    for(const [campo,max]of [['title',255],['category',50]]){
        for(const c of ['é','€','“','œ','Ÿ'])assert.deepEqual(validarEntradaAdmin('livros','PATCH',{[campo]:c.repeat(max)}),{[campo]:c.repeat(max)});
        for(const texto of ['é'.repeat(max+1),'漢','😀','A\ud800','A\u0080','A\u009f','A\0'])
            assert.throws(()=>validarEntradaAdmin('livros','PATCH',{[campo]:texto}));
    }
});
test('JWT: requisitos minimos nao alegam entropia; configuracao continua exigindo segredo seguro',()=>{
    assert.doesNotThrow(()=>carregarConfiguracaoLojaAdmin({...env(),JWT_SECRET:'0123456789abcdef'.repeat(2)}));
    assert.throws(()=>carregarConfiguracaoLojaAdmin({...env(),JWT_SECRET:'curto'}));
});
test('CSRF com relogio controlado: prazo maximo, expiracao valida e assinatura adulterada',async()=>{
    let tempo=Date.parse('2026-01-01T12:00:00Z');const m=montar({agoraMs:()=>tempo});
    await m.p.entrada(m.req,m.res,m.next);const token=m.p.emitirCsrf(m.req),[fim,nonce,mac]=token.split('.');
    assert.equal(Number(fim),tempo+900000);m.req.headers.origin='http://localhost:4200';
    const conferir=(valor,liberado)=>{m.req.headers['x-csrf-token']=valor;const n=m.avancou;
        m.p.protegerEscrita(m.req,m.res,m.next);assert.equal(m.avancou,n+Number(liberado));if(!liberado)assert.equal(m.res.statusCode,403);};
    conferir(token,true);
    conferir(`${fim}.${nonce}.${mac[0]==='A'?'B':'A'}${mac.slice(1)}`,false);
    // Assinatura correta com prazo acima do permitido: a rejeicao e temporal.
    const valor=`${tempo+900001}.${nonce}`;
    const assinatura=createHmac('sha256',Buffer.from(m.config.LOJA_CSRF_SECRET,'base64url'))
        .update('ist-loja/admin/csrf/v1\0').update(createHash('sha256').update(m.t).digest()).update(valor).digest('base64url');
    conferir(`${valor}.${assinatura}`,false);
    tempo=Number(fim)-1;conferir(token,true);tempo=Number(fim);conferir(token,false);tempo++;conferir(token,false);
});
test('404 administrativo e preservado pelo formatador e pelo error middleware',()=>{
    const m=montar();responderErroAdmin(m.res,404);assert.equal(m.res.statusCode,404);
    assert.equal(m.res.body.erro.codigo,'ADMIN_REGISTRO_NAO_ENCONTRADO');
    tratarErroAdmin(Object.assign(Error('SEGREDO'),{statusAdmin:404}),m.req,m.res,m.next);
    assert.equal(m.res.statusCode,404);assert.equal(m.res.headers['Cache-Control'],'no-store');
    assert.doesNotMatch(JSON.stringify(m.res.body),/SEGREDO/);
});
test('projecoes completas: cada campo editavel muda revisao, campos derivados nao mudam',()=>{
    const livro={author:null,currency:'BRL',title:'Editorial',description:null,language:'pt-br',format:'E-Book',category:'Música',img:null,pertenceEditoraIst:true,sku:null,price:null,onsale:1,inventory:'Em estoque'};
    for(const [recurso,dto]of [['livros',livro],['produtos',produtoPersistido()]]){
        const tag=criarEtagAdmin(recurso,1,dto);
        assert.equal(tag,criarEtagAdmin(recurso,1,{...dto,podeComprar:false,versaoPublicadaId:'OUTRA',comercial:{precoCentavos:999}}));
        for(const campo of CAMPOS_REVISAO_ADMIN[recurso]){
            const v=dto[campo],alterado=v===null?'Novo':typeof v==='boolean'?!v:typeof v==='number'?v+1:v+'B';
            assert.notEqual(tag,criarEtagAdmin(recurso,1,{...dto,[campo]:alterado}),campo);
            const parcial={...dto};delete parcial[campo];assert.throws(()=>criarEtagAdmin(recurso,1,parcial));
        }
        assert.deepEqual(Object.keys(projetarRevisaoAdmin(recurso,dto)),CAMPOS_REVISAO_ADMIN[recurso]);
    }
});
