import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { criarBancoPagamentoIsolado } from './fixtures/lojaPagamentoBancoIsolado.js';
import { expandirCatalogoSintetico } from './fixtures/lojaCatalogoComercialFixture.js';
import { criarLojaCatalogoService, prepararItensNaConexao } from '../src/services/lojaCatalogoService.js';
import { criarLojaPedidoService } from '../src/services/lojaPedidoService.js';

test('R3.3 catalogo, pedidos e concorrencia em MariaDB descartavel',
    { skip: !process.env.IST_LOJA_PAGAMENTOS_MARIADB_BIN, timeout: 120000 }, async t => {
    const {admin,pool,novaCompra}=await criarBancoPagamentoIsolado(t);
    await admin.query(`ALTER TABLE ist_livros ADD title TEXT,ADD description LONGTEXT,ADD price DECIMAL(5,2),
      ADD currency CHAR(3),ADD onsale INT,ADD format VARCHAR(32),ADD inventory VARCHAR(32),ADD file TEXT,ADD language VARCHAR(5)`);
    for(const id of [1,2,3])await admin.execute(`INSERT INTO ist_livros(id,title,description,price,currency,onsale,format,inventory,file)
      VALUES(?,?,'{"Texto":"Música & arte"}',?,'BRL',1,'E-Book','Em estoque','arquivo-sintetico.pdf')`,
    [id,`Título ${id}`,id===3?'1.00':'95.00']);
    await admin.query("INSERT INTO ist_loja_categorias(id,nome,slug) VALUES(1,'Musica','musica')");
    await admin.query("INSERT INTO ist_loja_produtos(id,categoria_id,livro_id,sku) VALUES(1,1,1,'SKU-EN'),(2,1,2,'SKU-PT'),(6,1,3,'IST-SANDBOX-CHECKOUT-001')");
    await expandirCatalogoSintetico(admin);
    // Contrato de pedidos usa o mesmo type casting da aplicacao, sem mudar a fixture.
    const db={async getConnection(){const c=await pool.getConnection();return {
      query:(sql,args)=>c.query({sql,typeCast:(field,next)=>{if(field.type!=='LONGLONG')return next();const s=field.string();if(s===null)return null;const n=Number(s);return Number.isSafeInteger(n)?n:s;}},args),
      beginTransaction:()=>c.beginTransaction(),commit:()=>c.commit(),rollback:()=>c.rollback(),release:()=>c.release(),destroy:()=>c.destroy()};}};
    const catalogo=criarLojaCatalogoService({db}),pedidos=criarLojaPedidoService({db,ambiente:'sandbox'});
    const entrada={produtoIds:[1,2,6],compradorEmail:'fixture@example.invalid'};
    const historico=await novaCompra();
    await admin.execute(`INSERT INTO ist_loja_pedido_itens(pedido_id,produto_id,posicao,sku_snapshot,titulo_snapshot,
      descricao_snapshot,tipo_snapshot,quantidade,preco_unitario_centavos,subtotal_centavos)
      VALUES(?,1,1,'HISTORICO','Título antigo','{}','E-Book',1,9500,9500)`,[historico.pedidoId]);
    const [antes]=await admin.execute('SELECT * FROM ist_loja_pedido_itens WHERE pedido_id=?',[historico.pedidoId]);

    await t.test('precos 1/2/6 coincidem na cotacao e preparacao; snapshots DIGITAL',async()=>{
      const cotacao=await catalogo.cotar({itens:entrada.produtoIds.map(produtoId=>({produtoId,quantidade:1}))});
      const c=await db.getConnection();try{await c.beginTransaction();
        const r=await prepararItensNaConexao(c,entrada.produtoIds);assert.equal(r.totalCentavos,19100);assert.equal(r.totalCentavos,cotacao.totalCentavos);
        assert.deepEqual(r.itens.map(x=>[x.produto_id,x.preco_unitario_centavos,x.tipo_snapshot]),[[1,9500,'DIGITAL'],[2,9500,'DIGITAL'],[6,100,'DIGITAL']]);
        await c.rollback();}finally{await c.rollback();c.release();}
    });
    await t.test('concorrrencia real serializa idempotencia; catalogo novo nao altera replay',async()=>{
      const compra=await novaCompra(),chave=randomUUID();
      const rs=await Promise.all(Array.from({length:4},()=>pedidos.criarPedido(compra.sessao,entrada,chave)));
      assert.equal(new Set(rs.map(x=>x.publicId)).size,1);assert.equal(rs[0].totalCentavos,19100);
      await admin.query("UPDATE ist_livros SET price=0.01,currency='USD',onsale=0,inventory='Esgotado',title='LEGADO' WHERE id=1");
      assert.equal((await catalogo.obterProduto(1)).precoCentavos,9500);
      await admin.query('UPDATE ist_loja_produtos SET preco_centavos=10001 WHERE id=1');
      try{assert.deepEqual(await pedidos.criarPedido(compra.sessao,entrada,chave),rs[0]);
        const novo=await pedidos.criarPedido(compra.sessao,entrada,randomUUID());assert.equal(novo.totalCentavos,19601);
        assert.equal(novo.itens[0].tipo,'DIGITAL');assert.equal(novo.itens[0].titulo,'Título 1');
      }finally{await admin.query('UPDATE ist_loja_produtos SET preco_centavos=9500 WHERE id=1');}
    });
    await t.test('share lock protege preco ate rollback e nao e liberado pelo preparador',async()=>{
      const c=await db.getConnection(),writer=await pool.getConnection();
      try{await c.beginTransaction();await prepararItensNaConexao(c,[1]);
        await writer.query('SET SESSION innodb_lock_wait_timeout=1');
        await assert.rejects(writer.query('UPDATE ist_loja_produtos SET preco_centavos=10001 WHERE id=1'),{code:'ER_LOCK_WAIT_TIMEOUT'});
        await c.rollback();await writer.query('UPDATE ist_loja_produtos SET preco_centavos=10001 WHERE id=1');
        assert.equal((await catalogo.obterProduto(1)).precoCentavos,10001);
      }finally{await c.rollback();await writer.query('UPDATE ist_loja_produtos SET preco_centavos=9500 WHERE id=1');c.release();writer.release();}
    });
    await t.test('falha apos primeiro item reverte pedido e itens sem residuos',async()=>{
      const compra=await novaCompra(),chave=randomUUID();
      let falhaInjetada=false;
      const falho={async getConnection(){const c=await db.getConnection();return {...c,async query(sql,args){
        if(sql.startsWith('INSERT INTO ist_loja_pedido_itens')&&args[2]===2){falhaInjetada=true;throw Error('Falha sintetica');}return c.query(sql,args);}};}};
      await assert.rejects(criarLojaPedidoService({db:falho,ambiente:'sandbox'}).criarPedido(compra.sessao,entrada,chave));
      assert.equal(falhaInjetada,true);
      const [[n]]=await admin.execute('SELECT COUNT(*) AS n FROM ist_loja_pedidos WHERE sessao_id=? AND idempotencia_criacao=?',[compra.sessao.id,chave]);assert.equal(Number(n.n),0);
    });
    const [depois]=await admin.execute('SELECT * FROM ist_loja_pedido_itens WHERE pedido_id=?',[historico.pedidoId]);assert.deepEqual(depois,antes);
    t.diagnostic('Historico E-Book intacto; novos snapshots DIGITAL; concorrencia, locks e rollback comprovados em MariaDB real.');
});
