import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { criarBookController } from '../src/controllers/bookController.js';
import { avaliarPoliticaComercial, criarContextoCategorias } from '../src/services/lojaCatalogoService.js';
import { criarBancoPagamentoIsolado } from './fixtures/lojaPagamentoBancoIsolado.js';
import { expandirCatalogoSintetico } from './fixtures/lojaCatalogoComercialFixture.js';

const categorias = () => [
    { id: 1, categoria_pai_id: null, ativo: 1 },
    { id: 2, categoria_pai_id: 1, ativo: 1 }
];
const livro = () => ({ id: 1, pertence_editora_ist: 1, title: 'Livro editorial', description: '{"Texto":"Música & arte"}',
    language: 'pt-br', format: 'E-Book', img: 'assets/images/livros/capa.png', category: 'Música',
    produto_id: 6, sku: 'SKU-PRODUTO', categoria_id: 2, ativo: 1, livro_id: 1, titulo: 'Título comercial',
    descricao: 'Descrição comercial', preco_centavos: '100', moeda: 'BRL', tipo: 'DIGITAL', em_venda: 1,
    disponivel: 1, formato_editorial: 'E-Book', versao_publicada: 1,
    price: '999.99', currency: 'USD', onsale: 0, inventory: 'Esgotado', file: '/privado/segredo.pdf', token: 'SEGREDO' });

const resposta = () => ({ statusCode: 200, status(n) { this.statusCode = n; return this; }, json(body) { this.body = body; return this; } });
const ambiente = (rows = [livro()], cats = categorias(), falha = false) => {
    const chamadas = [];
    const banco = { async getConnection() { return {
        async query(sql, args) {
            chamadas.push(sql);
            if (falha && sql.includes('FROM ist_livros')) throw Error('SELECT /privado/segredo.pdf token=SEGREDO');
            if (sql.includes('FROM ist_loja_categorias')) return [cats];
            if (sql.includes('FROM ist_livros')) {
                assert.match(sql, /WHERE l\.pertence_editora_ist = 1/);
                assert.match(sql, /LEFT JOIN ist_loja_produtos/);
                assert.doesNotMatch(sql, /SELECT\s+\*|l\.(price|currency|onsale|inventory|sku)\b/);
                return [rows.filter(r => r.pertence_editora_ist === 1 && (!args.length || r.id === args[0]))];
            }
            return [[]];
        }, async commit() { chamadas.push('commit'); }, async rollback() { chamadas.push('rollback'); }, release() { chamadas.push('release'); }
    }; } };
    return { controller: criarBookController({ banco }), chamadas };
};
const listar = async (a) => { const res = resposta(); await a.controller.getAllBooks({}, res); return res; };

test('listagem editorial inclui apenas classificados IST, sem depender de venda', async () => {
    const a = ambiente([livro(), { ...livro(), id: 2, pertence_editora_ist: null }, { ...livro(), id: 3, pertence_editora_ist: 0 }]);
    const r = await listar(a);
    assert.equal(r.statusCode, 200); assert.deepEqual(r.body.map(l => l.id), [1]);
    assert.equal(r.body[0].title, 'Livro editorial'); assert.equal(r.body[0].category, 'Música');
    assert.equal(r.body[0].description, livro().description);
    assert.deepEqual(a.chamadas.slice(-2), ['commit', 'release']);
    assert.ok(a.chamadas.includes('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY'));
});
for (const classificacao of [null, 0]) test(`detalhe nao expoe classificacao ${classificacao}`, async () => {
    const a = ambiente([{ ...livro(), pertence_editora_ist: classificacao }]), res = resposta();
    await a.controller.getBookById({ params: { id: '1' } }, res);
    assert.equal(res.statusCode, 404); assert.deepEqual(res.body, { message: 'Livro não encontrado' });
});
test('detalhe preserva objeto e listagem preserva array', async () => {
    const a = ambiente(), res = resposta(); await a.controller.getBookById({ params: { id: '1' } }, res);
    assert.equal(res.statusCode, 200); assert.equal(Array.isArray(res.body), false);
    assert.deepEqual(res.body, (await listar(a)).body[0]);
});
test('livro sem produto permanece no catalogo editorial sem oferta', async () => {
    const r = await listar(ambiente([{ ...livro(), produto_id: null, livro_id: null, sku: null, preco_centavos: null }]));
    assert.equal(r.body.length, 1); assert.equal(r.body[0].comercial, null);
});
test('fora de venda preserva vinculo, SKU e preco sem permitir compra', async () => {
    const r = await listar(ambiente([{ ...livro(), em_venda: 0 }]));
    assert.deepEqual(r.body[0].comercial, { produtoId: 6, sku: 'SKU-PRODUTO', precoCentavos: 100, moeda: 'BRL', podeComprar: false });
});
test('oferta elegivel usa exclusivamente SKU e centavos do produto', async () => {
    const a = ambiente(), anterior = (await listar(a)).body[0];
    assert.deepEqual(anterior.comercial, { produtoId: 6, sku: 'SKU-PRODUTO', precoCentavos: 100, moeda: 'BRL', podeComprar: true });
    const legado = { ...livro(), price: '0.01', currency: 'EUR', onsale: 1, inventory: 'Em estoque' };
    assert.deepEqual((await listar(ambiente([legado]))).body[0], anterior);
});
for (const [nome, alteracoes] of Object.entries({ inativo: { ativo: 0 }, indisponivel: { disponivel: 0 },
    semPreco: { preco_centavos: null }, inseguro: { preco_centavos: '9007199254740992' }, moeda: { moeda: 'USD' },
    semSuporte: { tipo: 'SERVICO' }, arquivo: { versao_publicada: 0 } })) {
    test(`oferta ${nome} reutiliza a mesma politica sem ocultar livro`, async () => {
        const row = { ...livro(), ...alteracoes }, cats = categorias();
        const r = await listar(ambiente([row], cats));
        assert.equal(r.body.length, 1);
        assert.equal(r.body[0].comercial.podeComprar, avaliarPoliticaComercial(row, criarContextoCategorias(cats).caminho).elegivel);
        assert.equal(r.body[0].comercial.podeComprar, false);
    });
}
for (const id of [1, 2]) test(`categoria ${id} inativa impede compra sem ocultar livro`, async () => {
    const cats = categorias(); cats.find(c => c.id === id).ativo = 0;
    assert.equal((await listar(ambiente([livro()], cats))).body[0].comercial.podeComprar, false);
});
test('projecao explicita nao vaza campos privados nem imagem privada', async () => {
    const row = { ...livro(), img: '/privado/capa.png' }, r = (await listar(ambiente([row]))).body[0];
    assert.deepEqual(Object.keys(r), ['id', 'title', 'description', 'language', 'format', 'img', 'category', 'comercial']);
    assert.equal(r.img, null); assert.doesNotMatch(JSON.stringify(r), /privado|segredo|SEGREDO|versao_publicada|em_venda/);
});
test('erros SQL sao sanitizados e liberam a conexao', async () => {
    const a = ambiente([livro()], categorias(), true), r = await listar(a);
    assert.equal(r.statusCode, 404); assert.deepEqual(r.body, { message: 'Erro ao buscar livros' });
    const detalhe = resposta(); await a.controller.getBookById({ params: { id: '1' } }, detalhe);
    assert.equal(detalhe.statusCode, 500); assert.deepEqual(detalhe.body, { message: 'Erro ao buscar livro' });
    assert.deepEqual(a.chamadas.slice(-2), ['rollback', 'release']);
});
test('id invalido nao consulta o banco', async () => {
    for (const id of ['0', '1abc', '2147483648', '1 OR 1=1']) {
        const a = ambiente(), r = resposta(); await a.controller.getBookById({ params: { id } }, r);
        assert.equal(r.statusCode, 404); assert.equal(a.chamadas.length, 0);
    }
});
test('rotas HTTP editoriais preservadas sem download legado', async () => {
    const rotas = await readFile(new URL('../src/routes/book.routes.js', import.meta.url), 'utf8');
    assert.match(rotas, /router\.get\('\/', bookController\.getAllBooks\)/);
    assert.match(rotas, /router\.get\('\/:id', bookController\.getBookById\)/);
    assert.doesNotMatch(rotas, /downloadBook|download\/:sku/);
});

test('API editorial com MariaDB 13.0.2 descartavel, sem servico HTTP',
    { skip: !process.env.IST_LOJA_PAGAMENTOS_MARIADB_BIN }, async t => {
    const { admin, pool } = await criarBancoPagamentoIsolado(t);
    await admin.query(`ALTER TABLE ist_livros ADD title TEXT, ADD description LONGTEXT, ADD language VARCHAR(10),
        ADD format VARCHAR(32), ADD img TEXT, ADD category VARCHAR(100), ADD price DECIMAL(10,2),
        ADD currency CHAR(3), ADD onsale INT, ADD inventory VARCHAR(32), ADD file TEXT`);
    for (const id of [1, 2, 3, 4, 5]) {
        await admin.execute(`INSERT INTO ist_livros(id,title,description,language,format,img,category,price,currency,onsale,inventory,file)
            VALUES(?,?,'{"Texto":"Música & arte"}','pt-br','E-Book','assets/images/livros/capa.png','Música',1.00,'BRL',1,'Em estoque','privado.pdf')`,
        [id, `Editorial ${id}`]);
    }
    await admin.query("INSERT INTO ist_loja_categorias(id,nome,slug) VALUES(1,'Música','musica')");
    await admin.query("INSERT INTO ist_loja_produtos(id,categoria_id,livro_id,sku) VALUES(1,1,1,'SKU-OFICIAL'),(6,1,5,'SKU-FORA-DE-VENDA')");
    await expandirCatalogoSintetico(admin);
    await admin.query('UPDATE ist_livros SET pertence_editora_ist=1 WHERE id IN (1,2,5)');
    await admin.query('UPDATE ist_livros SET pertence_editora_ist=0 WHERE id=3');
    await admin.query('UPDATE ist_loja_produtos SET em_venda=0 WHERE id=6');
    const controller = criarBookController({ banco: pool });
    const r = resposta(); await controller.getAllBooks({}, r);
    assert.equal(r.statusCode, 200); assert.deepEqual(r.body.map(l => l.id), [1, 2, 5]);
    assert.deepEqual(r.body[0].comercial, { produtoId: 1, sku: 'SKU-OFICIAL', precoCentavos: 100, moeda: 'BRL', podeComprar: true });
    assert.equal(r.body[1].comercial, null); assert.equal(r.body[2].comercial.podeComprar, false);
    for (const id of ['3', '4', '999']) {
        const detalhe = resposta(); await controller.getBookById({ params: { id } }, detalhe);
        assert.equal(detalhe.statusCode, 404);
    }
    await admin.query("UPDATE ist_livros SET price=99,currency='USD',onsale=0,inventory='Esgotado' WHERE id=1");
    const detalhe = resposta(); await controller.getBookById({ params: { id: '1' } }, detalhe);
    assert.deepEqual(detalhe.body, r.body[0]);
    assert.doesNotMatch(JSON.stringify(r.body), /privado\.pdf|versao_publicada|preco_centavos|pertence_editora_ist/);
    t.diagnostic('Classificacao, LEFT JOIN opcional e oferta compartilhada validados no MariaDB descartavel.');
});
