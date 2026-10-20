import test from 'node:test';
import assert from 'node:assert/strict';
import { criarLojaCatalogoService, decimalParaCentavos } from '../src/services/lojaCatalogoService.js';

const preparar = () => {
    const categorias = [
        { id: 1, nome: 'Livros digitais', slug: 'livros-digitais', categoria_pai_id: null, ativo: 1, ordem: 1 },
        { id: 2, nome: 'Música', slug: 'musica', categoria_pai_id: 1, ativo: 1, ordem: 1 }
    ];
    const produtos = [1, 2].map((id) => ({ id, sku: `SKU${id}`, categoria_id: 2, ativo: 1,
        livro_id: id, tipo: 'DIGITAL', em_venda: 1, disponivel: 1, preco_centavos: '9500', moeda: 'BRL',
        titulo: `Livro ${id}`, descricao: '<script>alert(1)</script>Texto &amp; música\nSegunda linha',
        imagem_url: 'assets/images/livros/capa.png', formato_editorial: 'E-Book',
        title: `Livro ${id}`, description: '<script>alert(1)</script>Texto &amp; música\nSegunda linha',
        language: id === 1 ? 'en-uk' : 'pt-br', img: 'assets/images/livros/capa.png',
        price: '95.00', currency: 'BRL', onsale: 1, format: 'E-Book', inventory: 'Em estoque', versao_publicada: 1,
        file: '/privado/livro.pdf' }));
    const chamadas = [];
    const conexao = {
        async query(sql) { chamadas.push(sql); return [sql.includes('FROM ist_loja_categorias') ? categorias : sql.includes('FROM ist_loja_produtos') ? produtos : []]; },
        async commit() { chamadas.push('commit'); }, async rollback() { chamadas.push('rollback'); }, release() { chamadas.push('release'); }
    };
    const service = criarLojaCatalogoService({ db: { getConnection: async () => conexao }, agora: () => new Date('2026-10-15T12:00:00Z') });
    return { categorias, produtos, chamadas, conexao, service };
};

test('categorias públicas preservam hierarquia', async () => {
    const { service } = preparar(); const r = await service.listarCategorias();
    assert.equal(r.length, 2); assert.equal(r[1].categoriaPaiId, r[0].id); assert.equal(r[1].slug, 'musica');
});
test('dois produtos têm preço inteiro, limite e projeção pública segura', async () => {
    const { service } = preparar(); const r = await service.listarProdutos();
    assert.equal(r.length, 2); assert.equal(r[0].precoCentavos, 9500); assert.equal(r[0].quantidadeMaxima, 1);
    assert(!JSON.stringify(r).includes('/privado')); assert(!JSON.stringify(r).includes('<script')); assert(!JSON.stringify(r).includes('alert(1)'));
});
test('filtro música e raiz incluem os descendentes, slug desconhecido retorna vazio', async () => {
    const { service } = preparar();
    assert.equal((await service.listarProdutos('musica')).length, 2);
    assert.equal((await service.listarProdutos('livros-digitais')).length, 2);
    assert.deepEqual(await service.listarProdutos('inexistente'), []);
});
for (const id of [1, 2]) test(`detalhe do produto ${id}`, async () => {
    assert.equal((await preparar().service.obterProduto(id)).id, id);
});
test('produto inexistente retorna 404', async () => {
    await assert.rejects(preparar().service.obterProduto(99), { status: 404 });
});
for (const indice of [0, 1]) test(`categoria ou ancestral inativo (${indice}) oculta produtos e descendentes`, async () => {
    const { categorias, service } = preparar(); categorias[indice].ativo = 0;
    assert.deepEqual(await service.listarProdutos(), []);
    assert.equal((await service.listarCategorias()).length, indice);
});
test('ciclo na hierarquia é inelegível', async () => {
    const { categorias, service } = preparar(); categorias[0].categoria_pai_id = 2;
    assert.deepEqual(await service.listarCategorias(), []); assert.deepEqual(await service.listarProdutos(), []);
});
test('categoria órfã é inelegível', async () => {
    const { categorias, service } = preparar(); categorias[1].categoria_pai_id = 99;
    assert.deepEqual(await service.listarProdutos(), []);
});
for (const [campo, valor] of [['ativo', 0], ['em_venda', 0], ['moeda', 'USD'], ['preco_centavos', null], ['preco_centavos', 0], ['preco_centavos', '-1'], ['preco_centavos', '95.001']]) {
    test(`produto inelegível: ${campo}=${valor}`, async () => {
        const { produtos, service } = preparar(); produtos[0][campo] = valor;
        assert.equal((await service.listarProdutos()).length, 1);
        await assert.rejects(service.cotar({ itens: [{ produtoId: 1, quantidade: 1 }] }), { status: 422 });
    });
}
test('poucas unidades permite venda; imagem não pública é omitida', async () => {
    const { produtos, service } = preparar(); produtos[0].inventory = 'Poucas unidades'; produtos[0].imagem_url = '/privado/livro.pdf';
    assert.equal((await service.obterProduto(1)).imagemUrl, null);
});
test('DECIMAL é convertido exatamente, sem aceitar floats ou precisão indevida', () => {
    for (const [v, esperado] of [['95.00', 9500], ['0.01', 1], ['999.99', 99999], ['1.10', 110], ['0.00', null], [95, null], ['1e2', null], ['1.001', null], ['90071992547409.92', null]]) assert.equal(decimalParaCentavos(v), esperado);
});
test('cotação oficial preserva ordem e soma 19000', async () => {
    const { service, chamadas } = preparar(); const r = await service.cotar({ itens: [{ produtoId: 2, quantidade: 1 }, { produtoId: 1, quantidade: 1 }] });
    assert.equal(r.totalCentavos, 19000); assert.equal(r.itens[0].produtoId, 2); assert.equal(r.geradaEm, '2026-10-15T12:00:00.000Z');
    assert(chamadas[0].includes('REPEATABLE READ')); assert(chamadas[1].includes('WITH CONSISTENT SNAPSHOT, READ ONLY'));
    assert.deepEqual(chamadas.slice(-2), ['commit', 'release']);
});
test('cotação vazia é zero e não contém itens', async () => {
    const r = await preparar().service.cotar({ itens: [] }); assert.equal(r.totalCentavos, 0); assert.deepEqual(r.itens, []);
});
for (const [nome, entrada, status] of [
    ['quantidade 2', { itens: [{ produtoId: 1, quantidade: 2 }] }, 422],
    ['duplicado', { itens: [{ produtoId: 1, quantidade: 1 }, { produtoId: 1, quantidade: 1 }] }, 422],
    ['preço falso', { itens: [{ produtoId: 1, quantidade: 1, precoCentavos: 1 }] }, 400],
    ['campo no envelope', { itens: [], totalCentavos: 1 }, 400],
    ['ID string', { itens: [{ produtoId: '1', quantidade: 1 }] }, 400],
    ['ID zero', { itens: [{ produtoId: 0, quantidade: 1 }] }, 400],
    ['quantidade ausente', { itens: [{ produtoId: 1 }] }, 400],
    ['mais de 100', { itens: Array.from({ length: 101 }, (_, i) => ({ produtoId: i + 1, quantidade: 1 })) }, 400],
    ['envelope nulo', null, 400], ['item nulo', { itens: [null] }, 400]
]) test(`cotação rejeita ${nome}`, async () => {
    await assert.rejects(async () => preparar().service.cotar(entrada), { status });
});
test('erro no banco reverte e libera conexão', async () => {
    const { conexao, chamadas, service } = preparar(); conexao.query = async () => { throw Error('SQL privado'); };
    await assert.rejects(service.listarProdutos()); assert.deepEqual(chamadas, ['rollback', 'release']);
});
test('filtro e ID inválidos são rejeitados antes do banco', async () => {
    const { service, chamadas } = preparar();
    assert.throws(() => service.listarProdutos(['musica']), { status: 400 });
    assert.throws(() => service.obterProduto(1.5), { status: 400 }); assert.deepEqual(chamadas, []);
});

test('SQL publico usa LEFT JOIN e somente produto para campos comerciais', async () => {
    const a = preparar(); await a.service.listarProdutos();
    const sql = a.chamadas.find(x => x.includes('FROM ist_loja_produtos'));
    assert.match(sql, /FROM ist_loja_produtos p LEFT JOIN ist_livros l ON l.id = p.livro_id/);
    assert.doesNotMatch(sql, /l\.(title|description|price|currency|img|inventory|onsale|file)/i);
    assert.match(sql, /CAST\(p.preco_centavos AS CHAR\)/);
});

test('campos legados divergentes nunca substituem a autoridade comercial', async () => {
    const a = preparar(); Object.assign(a.produtos[0], { title: 'LEGADO', description: 'LEGADO',
        price: '0.01', currency: 'USD', img: '/legado.pdf', onsale: 0, inventory: 'Esgotado' });
    const p = await a.service.obterProduto(1);
    assert.equal(p.titulo, 'Livro 1'); assert.equal(p.precoCentavos, 9500); assert.equal(p.moeda, 'BRL');
    assert.equal(p.imagemUrl, 'assets/images/livros/capa.png'); assert.equal(p.disponivel, true);
    assert.notEqual(p.descricao, 'LEGADO');
    delete a.produtos[0].preco_centavos;
    assert.equal((await a.service.listarProdutos()).length, 1);
});

for (const campo of ['titulo', 'descricao', 'moeda', 'tipo', 'em_venda']) {
    test(`campo comercial ausente nao recorre ao livro: ${campo}`, async () => {
        const a = preparar(); delete a.produtos[0][campo];
        await assert.rejects(a.service.obterProduto(1), { status: 404 });
    });
}

for (const mudanca of [{ disponivel: 0 }, { tipo: 'MERCADORIA' }, { tipo: 'SERVICO' },
    { livro_id: null, formato_editorial: null, versao_publicada: 0, language: null },
    { versao_publicada: 0 }, { formato_editorial: 'Livro Físico' }]) {
    test(`visibilidade nao autoriza compra: ${JSON.stringify(mudanca)}`, async () => {
        const a = preparar(); Object.assign(a.produtos[0], mudanca);
        const p = await a.service.obterProduto(1);
        assert.equal(p.disponivel, false); assert.equal(p.precoCentavos, 9500);
        if (mudanca.livro_id === null) { assert.equal(p.livroId, null); assert.equal(p.formatoEditorial, null); }
        await assert.rejects(a.service.cotar({ itens: [{ produtoId: 1, quantidade: 1 }] }), { status: 422 });
    });
}

for (const valor of [undefined, null, 0, -1, 1.5, NaN, Infinity, '1.0', '1e2', '9007199254740992', Number.MAX_SAFE_INTEGER + 1]) {
    test(`centavos invalidos sem fallback: ${String(valor)}`, async () => {
        const a = preparar(); a.produtos[0].preco_centavos = valor;
        await assert.rejects(a.service.obterProduto(1), { status: 404 });
    });
}

test('centavos seguros e soma com overflow controlado', async () => {
    const a = preparar(); a.produtos[0].preco_centavos = String(Number.MAX_SAFE_INTEGER);
    assert.equal((await a.service.obterProduto(1)).precoCentavos, Number.MAX_SAFE_INTEGER);
    await assert.rejects(a.service.cotar({ itens: [{ produtoId: 1, quantidade: 1 }, { produtoId: 2, quantidade: 1 }] }), { status: 422 });
});

test('produtos 1, 2 e 6 preservam valores e novos DTOs sem campos privados', async () => {
    const a = preparar(); a.produtos.push({ ...a.produtos[0], id: 6, livro_id: 3, sku: 'IST-SANDBOX-CHECKOUT-001', preco_centavos: '100' });
    const ps = await a.service.listarProdutos();
    assert.deepEqual(ps.map(p => [p.id,p.precoCentavos,p.tipo,p.livroId,p.formatoEditorial,p.disponivel]),
        [[1,9500,'DIGITAL',1,'E-Book',true],[2,9500,'DIGITAL',2,'E-Book',true],[6,100,'DIGITAL',3,'E-Book',true]]);
    for (const p of ps) assert.deepEqual(Object.keys(p).sort(), ['id','sku','titulo','descricao','categoria','idioma','imagemUrl',
        'precoCentavos','moeda','tipo','livroId','formatoEditorial','disponivel','quantidadeMaxima'].sort());
});

test('descricao acima do limite de snapshot nao e truncada nem autoriza cotacao', async () => {
    const a = preparar(); a.produtos[0].descricao = 'á'.repeat(32768);
    const p = await a.service.obterProduto(1);
    assert.equal(p.descricao, a.produtos[0].descricao); assert.equal(p.disponivel, false);
    await assert.rejects(a.service.cotar({ itens: [{ produtoId: 1, quantidade: 1 }] }), { status: 422 });
});
