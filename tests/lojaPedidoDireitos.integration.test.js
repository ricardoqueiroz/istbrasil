import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import mysql from 'mysql2/promise';
import { expandirCatalogoSintetico } from './fixtures/lojaCatalogoComercialFixture.js';
import { criarLojaArquivoService, selecionarVersoesNaConexao } from '../src/services/lojaArquivoService.js';
import { criarLojaCatalogoService, avaliarPoliticaComercial, prepararItensNaConexao } from '../src/services/lojaCatalogoService.js';
import { criarLojaPedidoService } from '../src/services/lojaPedidoService.js';
import { criarBookController } from '../src/controllers/bookController.js';

const contexto = {ambienteBackend:'test',ambientePaypal:'sandbox'};
const produtoSandbox = {id:6,livro_id:3,sku:'IST-SANDBOX-CHECKOUT-001',preco_centavos:'100',moeda:'BRL',
    ativo:1,em_venda:1,disponivel:1,tipo:'DIGITAL',titulo:'Sintetico',descricao:null,categoria_id:1,formato_editorial:'E-Book',versao_publicada:0};
test('excecao Sandbox exige identidade completa e contexto confiavel',()=>{
    assert.equal(avaliarPoliticaComercial(produtoSandbox,()=>true,contexto).elegivel,true);
    for(const c of [{}, {...contexto,ambienteBackend:'production'}, {...contexto,ambientePaypal:'live'}, {...contexto,ambientePedido:'live'}])
        assert.equal(avaliarPoliticaComercial(produtoSandbox,()=>true,c).elegivel,false);
    for(const [k,v] of [['id',7],['livro_id',4],['sku','OUTRO'],['preco_centavos','101'],['moeda','USD'],['tipo','SERVICO'],['disponivel',0],['formato_editorial','Impresso']])
        assert.equal(avaliarPoliticaComercial({...produtoSandbox,[k]:v},()=>true,contexto).elegivel,false);
});
test('seletor exige transacao, ordena produtos e nunca administra conexao',async()=>{
    const calls=[]; const c={query:async(sql,p)=>{calls.push([sql,p]);return sql.includes('@@in_transaction')?[[{em_transacao:1}]]:[[{id:p[0]+10,produto_id:p[0]}]];}};
    assert.deepEqual(await selecionarVersoesNaConexao(c,[2,1]),new Map([[1,11],[2,12]]));
    assert.deepEqual(calls.slice(1).map(x=>x[1][0]),[1,2]);
    for(const [sql] of calls.slice(1)){assert.match(sql,/estado = 'PUBLICADA'/);assert.match(sql,/publicacao_atual = 1/);assert.match(sql,/LOCK IN SHARE MODE/);}
    await assert.rejects(selecionarVersoesNaConexao({query:async()=>[[{em_transacao:0}]]},[1]),{codigo:'ERRO_INTERNO'});
});

test('D5.2-B2 direitos e pedidos atomicos em MariaDB descartavel',{
    skip:!process.env.IST_LOJA_PAGAMENTOS_MARIADB_BIN&&!process.env.IST_R2_10339_MANIFEST,timeout:180000
},async t=>{
    const antigo=Boolean(process.env.IST_R2_10339_MANIFEST);
    const {criarBancoPagamentoIsolado}=await import(antigo?'./fixtures/lojaCatalogoMariaDB10339.js':'./fixtures/lojaPagamentoBancoIsolado.js');
    const fixture=await criarBancoPagamentoIsolado(t),a=fixture.admin;
    const [[identidade]]=await a.query('SELECT VERSION() versao,DATABASE() banco,@@port porta,@@datadir datadir');
    assert.match(identidade.versao,antigo?/^10\.3\.39-MariaDB/:/^13\.0\.2-MariaDB/);
    const cfg=a.config??a.connection.config;
    const pool=fixture.pool??mysql.createPool({host:cfg.host,port:cfg.port,user:cfg.user,password:cfg.password,database:identidade.banco,dateStrings:true,connectionLimit:10});
    if(!fixture.pool)t.after(()=>pool.end());
    await a.query(`ALTER TABLE ist_livros ADD title TEXT,ADD description LONGTEXT,ADD price DECIMAL(5,2),ADD currency CHAR(3),
        ADD onsale INT,ADD format VARCHAR(32),ADD inventory VARCHAR(32),ADD file TEXT,ADD language VARCHAR(5),ADD img TEXT,ADD category TEXT`);
    await a.query("INSERT INTO ist_loja_categorias(id,nome,slug) VALUES(1,'Sintetico','sintetico')");
    for(const id of [1,2,3])await a.execute(`INSERT INTO ist_livros(id,title,description,price,currency,onsale,format,inventory,file)
        VALUES(?,?,'{}',?,'BRL',1,'E-Book','Em estoque',NULL)`,[id,`Sintetico ${id}`,id===3?'1.00':'95.00']);
    await a.query("INSERT INTO ist_loja_produtos(id,categoria_id,livro_id,sku) VALUES(1,1,1,'SINT-1'),(2,1,2,'SINT-2'),(6,1,3,'IST-SANDBOX-CHECKOUT-001')");
    await expandirCatalogoSintetico(a,{publicar:false});
    await a.query('UPDATE ist_livros SET pertence_editora_ist=1 WHERE id IN (1,2)');
    const db={async getConnection(){const c=await pool.getConnection();return {
        query:(sql,args)=>c.query({sql,typeCast:(f,next)=>{if(f.type!=='LONGLONG')return next();const s=f.string();return s===null?null:Number.isSafeInteger(Number(s))?Number(s):s;}},args),
        execute:(sql,args)=>c.execute(sql,args),beginTransaction:()=>c.beginTransaction(),commit:()=>c.commit(),rollback:()=>c.rollback(),release:()=>c.release(),destroy:()=>c.destroy()
    };}};
    const agora=()=>new Date('2026-01-01T12:00:00.000Z');
    const raiz=await mkdtemp(path.join(tmpdir(),'ist-direitos-db-'));t.after(()=>rm(raiz,{recursive:true}));
    const arquivos=criarLojaArquivoService({db,raizPrivada:raiz,agora}),logico=randomUUID();
    const registrar=async(nome,produtoId=1)=>{await writeFile(path.join(raiz,nome),'%PDF-1.7\nSINTETICO\n%%EOF');
        return arquivos.registrarRascunho({registroPublicId:randomUUID(),produtoId,arquivoLogicoId:logico,caminhoRelativo:nome});};
    const publicar=(v,esperada=null)=>arquivos.publicar({produtoId:v.produtoId,versaoPublicId:v.versaoPublicId,publicacaoAtualEsperada:esperada});
    const pedidos=criarLojaPedidoService({db,agora,contextoComercial:contexto}),catalogo=criarLojaCatalogoService({db,contextoComercial:contexto});
    const nova=async()=>{const c=await fixture.novaCompra();
        await a.execute("UPDATE ist_loja_sessoes SET criada_em='2026-01-01',expira_em='2026-01-02' WHERE id=?",[c.sessao.id]);
        return {sessao:c.sessao,chave:randomUUID(),entrada:{produtoIds:[1],compradorEmail:'sintetico@example.invalid'}};};
    const criar=(x,svc=pedidos)=>svc.criarPedido(x.sessao,x.entrada,x.chave);
    const contar=async(tabela)=>Number((await a.query(`SELECT COUNT(*) n FROM ${tabela}`))[0][0].n);
    const vinculos=async(publicId)=>(await a.execute(`SELECT d.*,e.estado_anterior,e.estado_novo,e.origem,e.motivo_codigo,e.direito_versao
        FROM ist_loja_pedidos p JOIN ist_loja_pedido_itens i ON i.pedido_id=p.id
        JOIN ist_loja_download_direitos d ON d.pedido_item_id=i.id JOIN ist_loja_download_direito_eventos e ON e.direito_id=d.id
        WHERE p.public_id=?`,[publicId]))[0];
    let v1,v2,compra,pedido;
    await t.test('sem versao ou com rascunho bloqueia catalogo e pedido, mesmo com file legado',async()=>{
        await a.query("UPDATE ist_livros SET file='nao-e-autoridade.pdf' WHERE id=1");
        assert.equal((await catalogo.obterProduto(1)).disponivel,false);
        await assert.rejects(criar(await nova()),{codigo:'PRODUTO_INDISPONIVEL'});
        v1=await registrar('v1.pdf');await assert.rejects(criar(await nova()),{codigo:'PRODUTO_INDISPONIVEL'});
    });
    await t.test('versao publicada, cotacao, editorial e pedido compartilham politica',async()=>{
        await publicar(v1);await a.query('UPDATE ist_livros SET file=NULL WHERE id=1');
        assert.equal((await catalogo.obterProduto(1)).disponivel,true);
        const res={json(body){this.body=body;},status(){return this;}};
        await criarBookController({banco:db}).getBookById({params:{id:'1'}},res);assert.equal(res.body.comercial.podeComprar,true);
        compra=await nova();pedido=await criar(compra);
        const [d]=await vinculos(pedido.publicId);assert.equal(d.estado,'AGUARDANDO_CONFIRMACAO');assert.equal(d.versao,1);
        assert.equal(d.estado_anterior,null);assert.equal(d.origem,'PEDIDO');assert.equal(d.direito_versao,1);assert.equal(d.motivo_codigo,'DIREITO_CRIADO');
        assert.equal(pedido.totalCentavos,9500);assert.doesNotMatch(JSON.stringify(pedido),/arquivo_versao|caminho|sha256|direito/);
        await assert.rejects(a.execute(`INSERT INTO ist_loja_download_direitos
            (public_id,pedido_item_id,produto_id,arquivo_versao_id,criado_em,atualizado_em)
            VALUES(?,?,?,?,?,?)`,[randomUUID(),d.pedido_item_id,d.produto_id,d.arquivo_versao_id,d.criado_em,d.atualizado_em]),{code:'ER_DUP_ENTRY'});
    });
    await t.test('replay apos nova publicacao fixa versao anterior e nao duplica evento',async()=>{
        const antes=await vinculos(pedido.publicId);v2=await registrar('v2.pdf');await publicar(v2,v1.versaoPublicId);
        assert.deepEqual(await criar(compra),pedido);assert.deepEqual(await vinculos(pedido.publicId),antes);
        const novo=await criar(await nova()),[d]=await vinculos(novo.publicId);
        assert.notEqual(d.arquivo_versao_id,antes[0].arquivo_versao_id);
        const [[v]]=await a.execute('SELECT estado FROM ist_loja_arquivo_versoes WHERE id=?',[antes[0].arquivo_versao_id]);assert.equal(v.estado,'RETIRADA');
    });
    const envolver=(hook,commit)=>({async getConnection(){const c=await db.getConnection();return {...c,query:async(sql,p)=>{await hook?.(sql,p,c);return c.query(sql,p);},commit:()=>commit?commit(c):c.commit()};}});
    for(const tabela of ['ist_loja_download_direitos','ist_loja_download_direito_eventos'])await t.test(`falha em ${tabela} reverte pedido itens direitos e eventos`,async()=>{
        const x=await nova(),tabelas=['ist_loja_pedidos','ist_loja_pedido_itens','ist_loja_download_direitos','ist_loja_download_direito_eventos'];
        const antes=await Promise.all(tabelas.map(contar));
        const falho=envolver(sql=>{if(sql.startsWith(`INSERT INTO ${tabela}`))throw Error('FALHA_SINTETICA');});
        await assert.rejects(criar(x,criarLojaPedidoService({db:falho,agora,contextoComercial:contexto})),{codigo:'ERRO_INTERNO'});
        assert.deepEqual(await Promise.all(tabelas.map(contar)),antes);
    });
    await t.test('compras simultaneas e replay simultaneo nao duplicam direitos',async()=>{
        const x=await nova(),r=await Promise.all(Array.from({length:3},()=>criar(x)));
        assert.equal(new Set(r.map(p=>p.publicId)).size,1);assert.equal((await vinculos(r[0].publicId)).length,1);
        const rs=await Promise.all([nova(),nova()].map(async p=>criar(await p)));assert.notEqual(rs[0].publicId,rs[1].publicId);
    });
    await t.test('pedido mantem locks e publicacao concorrente aguarda COMMIT',async()=>{
        const v=await registrar('v3.pdf');let liberar,atingiu;const espera=new Promise(r=>liberar=r),pronto=new Promise(r=>atingiu=r);
        const bloqueado=envolver(async sql=>{if(sql.startsWith('INSERT INTO ist_loja_pedidos')){atingiu();await espera;}});
        const exec=criar(await nova(),criarLojaPedidoService({db:bloqueado,agora,contextoComercial:contexto}));await pronto;
        let terminou=false;const pub=publicar(v,v2.versaoPublicId).then(r=>{terminou=true;return r;});
        try{await new Promise(r=>setTimeout(r,100));assert.equal(terminou,false);}finally{liberar();}
        const p=await exec;await pub;const [d]=await vinculos(p.publicId);
        const [[fixada]]=await a.execute('SELECT public_id FROM ist_loja_arquivo_versoes WHERE id=?',[d.arquivo_versao_id]);assert.equal(fixada.public_id,v2.versaoPublicId);
    });
    await t.test('COMMIT efetivado com resposta perdida reconcilia direitos sem reinserir',async()=>{
        let primeiro=true,inserts=0;const incerto=envolver(sql=>{if(sql.startsWith('INSERT'))inserts++;},async c=>{await c.commit();if(primeiro){primeiro=false;throw Error('RESPOSTA_PERDIDA');}});
        const p=await criar(await nova(),criarLojaPedidoService({db:incerto,agora,contextoComercial:contexto}));assert.equal(inserts,4);assert.equal((await vinculos(p.publicId)).length,1);
    });
    await t.test('COMMIT nao efetivado nao repete insercoes',async()=>{
        let inserts=0;const incerto=envolver(sql=>{if(sql.startsWith('INSERT'))inserts++;},async c=>{await c.rollback();throw Error('SEM_COMMIT');});
        const antes=await contar('ist_loja_download_direitos');await assert.rejects(criar(await nova(),criarLojaPedidoService({db:incerto,agora,contextoComercial:contexto})),{codigo:'CONTENCAO_TEMPORARIA'});
        assert.equal(inserts,4);assert.equal(await contar('ist_loja_download_direitos'),antes);
    });
    await t.test('reconciliacao de COMMIT incerto rejeita evento esperado ausente sem reparar',async()=>{
        let itemId,primeiro=true,inserts=0;
        const incerto=envolver((sql,p)=>{if(sql.startsWith('INSERT'))inserts++;if(sql.startsWith('INSERT INTO ist_loja_download_direitos'))itemId=p[1];},async c=>{
            await c.commit();if(primeiro){primeiro=false;
                // Corrupcao artificial posterior ao COMMIT exclusivamente no banco sintetico.
                await a.execute('DELETE e FROM ist_loja_download_direito_eventos e JOIN ist_loja_download_direitos d ON d.id=e.direito_id WHERE d.pedido_item_id=?',[itemId]);
                throw Error('RESPOSTA_PERDIDA');}
        });
        await assert.rejects(criar(await nova(),criarLojaPedidoService({db:incerto,agora,contextoComercial:contexto})),{codigo:'CONTENCAO_TEMPORARIA'});
        assert.equal(inserts,4);
    });
    await t.test('deadlock tem rollback e no maximo tres tentativas',async()=>{
        let n=0;const falho=envolver(sql=>{if(sql.startsWith('INSERT INTO ist_loja_download_direitos')){n++;throw Object.assign(Error('SINTETICO'),{code:'ER_LOCK_DEADLOCK',errno:1213});}});
        await assert.rejects(criar(await nova(),criarLojaPedidoService({db:falho,agora,contextoComercial:contexto})),{codigo:'CONTENCAO_TEMPORARIA'});assert.equal(n,3);
        n=0;const uma=envolver(sql=>{if(sql.startsWith('INSERT INTO ist_loja_download_direitos')&&++n===1)throw Object.assign(Error('SINTETICO'),{code:'ER_LOCK_DEADLOCK',errno:1213});});
        assert.equal((await vinculos((await criar(await nova(),criarLojaPedidoService({db:uma,agora,contextoComercial:contexto}))).publicId)).length,1);
    });
    await t.test('historico sem direitos retorna intacto sem backfill',async()=>{
        const x=await nova();const p=await criar(x),[d]=await vinculos(p.publicId);
        // Simular historico exclusivamente na fixture: nunca em dados reais.
        await a.execute('DELETE FROM ist_loja_download_direito_eventos WHERE direito_id=?',[d.id]);await a.execute('DELETE FROM ist_loja_download_direitos WHERE id=?',[d.id]);
        assert.deepEqual(await criar(x),p);assert.deepEqual(await vinculos(p.publicId),[]);
    });
    await t.test('Sandbox sem conteudo nao recebe direito; producao e outro produto bloqueados',async()=>{
        const x=await nova();x.entrada.produtoIds=[6];const p=await criar(x);assert.equal(p.totalCentavos,100);assert.deepEqual(await vinculos(p.publicId),[]);
        assert.equal((await catalogo.obterProduto(6)).disponivel,true);
        const y=await nova();y.entrada.produtoIds=[6];await assert.rejects(criar(y,criarLojaPedidoService({db,agora,contextoComercial:{...contexto,ambienteBackend:'production'}})),{codigo:'PRODUTO_INDISPONIVEL'});
        const z=await nova();z.entrada.produtoIds=[2];await assert.rejects(criar(z),{codigo:'PRODUTO_INDISPONIVEL'});
    });
    t.diagnostic(`Identidade: ${identidade.versao}; porta ${identidade.porta}; schema ${identidade.banco}; cleanup registrado pela fixture.`);
});
