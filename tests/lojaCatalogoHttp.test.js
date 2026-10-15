import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { criarLojaRouter, tratarErroLoja } from '../src/routes/loja.routes.js';
import { criarLojaCatalogoService } from '../src/services/lojaCatalogoService.js';

const iniciar = async (t, { globalParser = false, falha = false } = {}) => {
    const categorias = [{ id: 1, nome: 'Música', slug: 'musica', categoria_pai_id: null, ativo: 1, ordem: 1 }];
    const produtos = [1, 2].map((id) => ({ id, sku: `SKU${id}`, categoria_id: 1, ativo: 1, title: 'Livro', description: 'Texto',
        language: 'pt-br', img: 'assets/images/livros/capa.png', price: '95.00', currency: 'BRL', onsale: 1, format: 'E-Book', inventory: 'Em estoque', arquivo_presente: 1 }));
    const service = criarLojaCatalogoService({ db: { async getConnection() {
        if (falha) throw Error('SELECT segredo /privado/livro.pdf');
        return { async query(sql) { return [sql.includes('FROM ist_loja_categorias') ? categorias : sql.includes('FROM ist_loja_produtos') ? produtos : []]; }, async commit() {}, async rollback() {}, release() {} };
    } } });
    const app = express();
    if (globalParser) app.use(express.json());
    app.use('/api/loja', criarLojaRouter({ service })); app.use('/api/loja', tratarErroLoja);
    app.get('/outra', (req, res) => res.json({ preservada: true }));
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    t.after(() => new Promise((resolve, reject) => { server.closeAllConnections(); server.close((e) => e ? reject(e) : resolve()); }));
    const url = `http://127.0.0.1:${server.address().port}`;
    return { get: (path) => fetch(`${url}${path}`), post: (body) => fetch(`${url}/api/loja/cotacao`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) }) };
};

test('GET categorias retorna hierarquia pública', async (t) => { const api = await iniciar(t); const r = await api.get('/api/loja/categorias'); assert.equal(r.status, 200); assert.equal((await r.json())[0].slug, 'musica'); });
test('GET produtos e filtro música', async (t) => { const api = await iniciar(t); for (const path of ['/api/loja/produtos', '/api/loja/produtos?categoria=musica']) { const r = await api.get(path); assert.equal(r.status, 200); assert.equal((await r.json()).length, 2); } });
for (const id of [1, 2]) test(`GET detalhe ${id}`, async (t) => { const api = await iniciar(t); const r = await api.get(`/api/loja/produtos/${id}`); assert.equal(r.status, 200); const p = await r.json(); assert.equal(p.precoCentavos, 9500); assert(!JSON.stringify(p).includes('.pdf')); });
test('GET inexistente retorna 404', async (t) => { const api = await iniciar(t); assert.equal((await api.get('/api/loja/produtos/99')).status, 404); });
test('parâmetros inválidos retornam 400', async (t) => { const api = await iniciar(t); for (const p of ['produtos/1abc', 'produtos/0', 'produtos/2147483648', 'produtos?categoria=musica&categoria=outro', 'produtos?preco=1', 'categorias?extra=1']) assert.equal((await api.get(`/api/loja/${p}`)).status, 400); });
test('POST cotação oficial de 19000 e no-store', async (t) => { const api = await iniciar(t); const r = await api.post({ itens: [{ produtoId: 1, quantidade: 1 }, { produtoId: 2, quantidade: 1 }] }); assert.equal(r.status, 200); assert.equal(r.headers.get('cache-control'), 'no-store'); assert.equal((await r.json()).totalCentavos, 19000); });
for (const [nome, body, status] of [
    ['quantidade', { itens: [{ produtoId: 1, quantidade: 2 }] }, 422],
    ['duplicado', { itens: [{ produtoId: 1, quantidade: 1 }, { produtoId: 1, quantidade: 1 }] }, 422],
    ['preço falso', { itens: [{ produtoId: 1, quantidade: 1, price: 1 }] }, 400],
    ['indisponível', { itens: [{ produtoId: 99, quantidade: 1 }] }, 422]
]) test(`POST rejeita ${nome}`, async (t) => { const api = await iniciar(t); const r = await api.post(body); assert.equal(r.status, status); assert.equal(r.headers.get('cache-control'), 'no-store'); });
for (const globalParser of [false, true]) test(`JSON inválido com parser global=${globalParser}`, async (t) => { const api = await iniciar(t, { globalParser }); const r = await api.post('{'); assert.equal(r.status, 400); assert.equal(r.headers.get('cache-control'), 'no-store'); assert.equal((await r.json()).erro.codigo, 'JSON_INVALIDO'); });
test('erro interno é sanitizado e outras rotas continuam funcionais', async (t) => { const api = await iniciar(t, { falha: true }); const r = await api.get('/api/loja/produtos'); assert.equal(r.status, 500); const body = await r.text(); assert(!body.includes('SELECT')); assert(!body.includes('segredo')); assert(!body.includes('.pdf')); assert.equal((await api.get('/outra')).status, 200); });
test('limite real de 120 por minuto e isolamento das demais rotas', async (t) => { const api = await iniciar(t); for (let i = 0; i < 120; i++) assert.equal((await api.get('/api/loja/categorias')).status, 200); const r = await api.post({ itens: [] }); assert.equal(r.status, 429); assert.equal(r.headers.get('cache-control'), 'no-store'); assert(r.headers.get('retry-after')); assert.equal((await api.get('/outra')).status, 200); });
