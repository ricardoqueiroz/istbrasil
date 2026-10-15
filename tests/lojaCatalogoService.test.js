import test from 'node:test';
import assert from 'node:assert/strict';
import { criarLojaCatalogoService, decimalParaCentavos } from '../src/services/lojaCatalogoService.js';

const preparar = () => {
    const categorias = [
        { id: 1, nome: 'Livros digitais', slug: 'livros-digitais', categoria_pai_id: null, ativo: 1, ordem: 1 },
        { id: 2, nome: 'Música', slug: 'musica', categoria_pai_id: 1, ativo: 1, ordem: 1 }
    ];
    const produtos = [1, 2].map((id) => ({ id, sku: `SKU${id}`, categoria_id: 2, ativo: 1,
        title: `Livro ${id}`, description: '<script>alert(1)</script>Texto &amp; música\nSegunda linha',
        language: id === 1 ? 'en-uk' : 'pt-br', img: 'assets/images/livros/capa.png',
        price: '95.00', currency: 'BRL', onsale: 1, format: 'E-Book', inventory: 'Em estoque', arquivo_presente: 1,
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
for (const [campo, valor] of [['ativo', 0], ['onsale', 0], ['format', 'Livro Físico'], ['currency', 'USD'], ['inventory', 'Esgotado'], ['arquivo_presente', 0], ['price', '0.00'], ['price', '-1.00'], ['price', '95.001']]) {
    test(`produto inelegível: ${campo}=${valor}`, async () => {
        const { produtos, service } = preparar(); produtos[0][campo] = valor;
        assert.equal((await service.listarProdutos()).length, 1);
        await assert.rejects(service.cotar({ itens: [{ produtoId: 1, quantidade: 1 }] }), { status: 422 });
    });
}
test('poucas unidades permite venda; imagem não pública é omitida', async () => {
    const { produtos, service } = preparar(); produtos[0].inventory = 'Poucas unidades'; produtos[0].img = '/privado/livro.pdf';
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
