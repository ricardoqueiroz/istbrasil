import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { criarBancoPagamentoIsolado } from './fixtures/lojaCatalogoMariaDB10339.js';
import { criarBookController } from '../src/controllers/bookController.js';
import { criarLojaCatalogoService, prepararItensNaConexao } from '../src/services/lojaCatalogoService.js';
import { criarLojaPedidoService } from '../src/services/lojaPedidoService.js';
import { montarDownloadsSinteticos } from './fixtures/lojaCatalogoComercialFixture.js';

test('R3 consultas editoriais, comerciais e pedidos em MariaDB 10.3.39 isolado',
    { skip: !process.env.IST_R2_10339_MANIFEST }, async t => {
    // A fixture valida manifesto, hostname/container, versao, porta, schema novo
    // e autenticacao correta/incorreta antes de qualquer SQL modificador.
    const { admin, novaCompra, versao } = await criarBancoPagamentoIsolado(t);
    assert.match(versao, /^10\.3\.39-MariaDB/);
    await admin.query(`ALTER TABLE ist_livros ADD title TEXT, ADD description LONGTEXT,
        ADD language VARCHAR(10), ADD format VARCHAR(32), ADD img TEXT, ADD category VARCHAR(100),
        ADD price DECIMAL(10,2), ADD currency CHAR(3), ADD onsale INT, ADD inventory VARCHAR(32), ADD file TEXT`);
    for (const id of [1, 2, 3, 4, 5]) await admin.execute(`INSERT INTO ist_livros
        (id,title,description,language,format,img,category,price,currency,onsale,inventory,file)
        VALUES(?,?,'{"Conteúdo":"Música & memória 🎵"}','pt-br','E-Book',
        'assets/images/livros/capa.png','Música',?,'BRL',1,'Em estoque','arquivo-sintetico.pdf')`,
    [id, `Editorial ${id}`, id === 3 ? '1.00' : '95.00']);
    await admin.query("INSERT INTO ist_loja_categorias(id,nome,slug) VALUES(1,'Música','musica')");
    await admin.query(`INSERT INTO ist_loja_produtos(id,categoria_id,livro_id,sku) VALUES
        (1,1,1,'SKU-EN'),(2,1,2,'SKU-PT'),(6,1,3,'SKU-SANDBOX')`);
    const sql = await readFile(new URL('../migrations/ist_loja_catalogo_expansao_r2.sql', import.meta.url), 'utf8');
    // Estrutura R2 original; carga exclusivamente sintetica, sem copiar banco real.
    for (const nome of ['CREATE TABLE ist_loja_perfis_fiscais', 'ALTER TABLE ist_loja_produtos', 'ALTER TABLE ist_livros']) {
        const inicio = sql.indexOf('    ' + nome); assert.ok(inicio >= 0);
        await admin.query(sql.slice(inicio, sql.indexOf(';', inicio) + 1));
    }
    await admin.query(`UPDATE ist_loja_produtos p JOIN ist_livros l ON l.id=p.livro_id SET
        p.tipo='DIGITAL',p.titulo=l.title,p.descricao=l.description,p.preco_centavos=CAST(l.price*100 AS UNSIGNED),
        p.moeda=l.currency,p.em_venda=1,p.disponivel=1`);
    await montarDownloadsSinteticos(admin);
    await admin.query('UPDATE ist_livros SET pertence_editora_ist=1 WHERE id IN (1,2,5)');
    await admin.query('UPDATE ist_livros SET pertence_editora_ist=0 WHERE id=3');
    // Unica conexao dedicada neste teste sequencial. Nenhuma conexao da aplicacao.
    const conexao = {
        query: (sql, args) => admin.query({ sql, typeCast(field, next) {
            if (field.type !== 'LONGLONG') return next();
            const s = field.string(); if (s === null) return null;
            const n = Number(s); return Number.isSafeInteger(n) ? n : s;
        } }, args),
        beginTransaction: () => admin.beginTransaction(), commit: () => admin.commit(),
        rollback: () => admin.rollback(), release() {}, destroy: () => admin.destroy()
    };
    const db = { async getConnection() { return conexao; } };
    const editorial = criarBookController({ banco: db }), catalogo = criarLojaCatalogoService({ db });
    const resposta = () => ({ statusCode: 200, status(n) { this.statusCode = n; return this; }, json(body) { this.body = body; } });
    const historico = await novaCompra();
    await admin.execute(`INSERT INTO ist_loja_pedido_itens(pedido_id,produto_id,posicao,sku_snapshot,titulo_snapshot,
        descricao_snapshot,tipo_snapshot,quantidade,preco_unitario_centavos,subtotal_centavos)
        VALUES(?,6,1,'HISTORICO','Snapshot anterior','{}','E-Book',1,100,100)`, [historico.pedidoId]);
    const [antes] = await admin.execute('SELECT * FROM ist_loja_pedido_itens WHERE pedido_id=?', [historico.pedidoId]);

    const livros = resposta(); await editorial.getAllBooks({}, livros);
    assert.equal(livros.statusCode, 200); assert.deepEqual(livros.body.map(l => l.id), [1, 2, 5]);
    assert.equal(livros.body[2].comercial, null); assert.equal(livros.body[0].comercial.podeComprar, true);
    for (const id of ['3', '4']) {
        const r = resposta(); await editorial.getBookById({ params: { id } }, r); assert.equal(r.statusCode, 404);
    }
    await admin.query('UPDATE ist_loja_produtos SET em_venda=0 WHERE id=2');
    const fora = resposta(); await editorial.getBookById({ params: { id: '2' } }, fora);
    assert.equal(fora.statusCode, 200); assert.equal(fora.body.comercial.produtoId, 2); assert.equal(fora.body.comercial.podeComprar, false);
    await admin.query('UPDATE ist_loja_produtos SET em_venda=1 WHERE id=2');
    await admin.query("UPDATE ist_livros SET price=0.01,currency='USD',onsale=0,inventory='Esgotado' WHERE id=1");
    const cotacao = await catalogo.cotar({ itens: [{ produtoId: 1, quantidade: 1 }, { produtoId: 2, quantidade: 1 }] });
    assert.equal(cotacao.totalCentavos, 19000);
    await conexao.beginTransaction();
    try {
        const preparados = await prepararItensNaConexao(conexao, [1, 2, 6]);
        assert.equal(preparados.totalCentavos, 19100);
        assert.deepEqual(preparados.itens.map(i => i.tipo_snapshot), ['DIGITAL', 'DIGITAL', 'DIGITAL']);
        assert.equal(preparados.itens[0].descricao_snapshot, '{"Conteúdo":"Música & memória 🎵"}');
    } finally { await conexao.rollback(); }
    // As tres modalidades sem suporte continuam visiveis, mas nao compraveis.
    for (const tipo of ['DIGITAL', 'MERCADORIA', 'SERVICO']) {
        await admin.execute('UPDATE ist_loja_produtos SET tipo=?,livro_id=NULL WHERE id=6', [tipo]);
        const produto = await catalogo.obterProduto(6);
        assert.equal(produto.tipo, tipo); assert.equal(produto.livroId, null); assert.equal(produto.disponivel, false);
        await assert.rejects(catalogo.cotar({ itens: [{ produtoId: 6, quantidade: 1 }] }), e => e.codigo === 'PRODUTO_INDISPONIVEL');
        await conexao.beginTransaction();
        try { await assert.rejects(prepararItensNaConexao(conexao, [6]), e => e.codigo === 'PRODUTO_INDISPONIVEL'); }
        finally { await conexao.rollback(); }
    }
    await admin.query("UPDATE ist_loja_produtos SET tipo='DIGITAL',livro_id=3 WHERE id=6");
    await admin.query('UPDATE ist_loja_categorias SET ativo=0 WHERE id=1');
    assert.deepEqual(await catalogo.listarProdutos(), []);
    await admin.query('UPDATE ist_loja_categorias SET ativo=1 WHERE id=1');
    const pedidos = criarLojaPedidoService({ db, ambiente: 'sandbox', agora: () => new Date('2026-01-01T12:00:00.000Z') });
    const compra = await novaCompra(), chave = randomUUID();
    const entrada = { produtoIds: [1, 2], compradorEmail: 'fixture@example.invalid' };
    const pedido = await pedidos.criarPedido(compra.sessao, entrada, chave);
    assert.equal(pedido.totalCentavos, cotacao.totalCentavos);
    await admin.query('UPDATE ist_loja_produtos SET preco_centavos=10001 WHERE id=1');
    assert.deepEqual(await pedidos.criarPedido(compra.sessao, entrada, chave), pedido);
    const novo = await pedidos.criarPedido(compra.sessao, entrada, randomUUID()); assert.equal(novo.totalCentavos, 19501);
    assert.deepEqual((await admin.execute('SELECT * FROM ist_loja_pedido_itens WHERE pedido_id=?', [historico.pedidoId]))[0], antes);
    for (const tabela of ['ist_loja_pagamentos', 'ist_loja_pagamento_operacoes', 'ist_loja_pagamento_eventos']) {
        assert.equal(Number((await admin.query(`SELECT COUNT(*) AS n FROM ${tabela}`))[0][0].n), 0);
    }
    assert.doesNotMatch(JSON.stringify(livros.body), /arquivo-sintetico|arquivo_presente|preco_centavos/);
    t.diagnostic('Consultas R3 reais: LEFT JOIN editorial, politica publica, CAST BIGINT, snapshot READ ONLY, locks separados, pedidos e replay aprovados.');
});
