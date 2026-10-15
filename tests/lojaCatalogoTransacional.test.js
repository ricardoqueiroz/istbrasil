import test from 'node:test';
import assert from 'node:assert/strict';
import { prepararItensNaConexao, criarLojaCatalogoService } from '../src/services/lojaCatalogoService.js';

const preparar = () => {
    // IDs dos pais/livros propositalmente fora da ordem de produtos/travessia.
    const categorias = [
        { id: 30, categoria_pai_id: null, ativo: 1, nome: 'Raiz', slug: 'raiz', ordem: 1 },
        { id: 10, categoria_pai_id: 30, ativo: 1, nome: 'Música', slug: 'musica', ordem: 1 },
        { id: 40, categoria_pai_id: null, ativo: 1, nome: 'Outra', slug: 'outra', ordem: 2 }
    ];
    const produtos = [
        { id: 1, categoria_id: 10, livro_id: 20, sku: 'SKU-EN', ativo: 1, ordem: 2 },
        { id: 2, categoria_id: 10, livro_id: 5, sku: 'SKU-PT', ativo: 1, ordem: 1 }
    ];
    const livros = [20, 5].map(id => ({ id, title: `Título ${id}`, description: '{"Title":"Música & arte","Content":"PDF"}',
        price: '95.00', currency: 'BRL', onsale: 1, format: 'E-Book', inventory: 'Em estoque', arquivo_presente: 1,
        language: 'pt-br', img: 'assets/images/capa.png' }));
    const chamadas = [];
    let antes = () => {};
    let emTransacao = 1;
    let obtidas = 0;
    const conexao = {
        async query(sql, params = []) {
            chamadas.push({ sql, params: [...params] });
            antes(sql, params);
            if (sql.includes('@@in_transaction')) return [[{ em_transacao: emTransacao }]];
            if (/^(SET|START)/.test(sql)) return [[]];
            let linhas;
            if (sql.includes('FROM ist_loja_categorias')) linhas = categorias;
            else if (sql.includes('JOIN ist_livros')) linhas = [...produtos].sort((a, b) => a.ordem - b.ordem)
                .map(p => ({ ...livros.find(l => l.id === p.livro_id), ...p }));
            else if (sql.includes('FROM ist_loja_produtos')) linhas = produtos;
            else if (sql.includes('FROM ist_livros')) linhas = livros;
            else throw new Error('Consulta inesperada');
            if (sql.includes('WHERE id = ?')) linhas = linhas.filter(l => l.id === params[0]);
            return [structuredClone(linhas)];
        },
        async commit() { chamadas.push({ sql: 'commit' }); },
        async rollback() { chamadas.push({ sql: 'rollback' }); },
        release() { chamadas.push({ sql: 'release' }); }
    };
    const service = criarLojaCatalogoService({ db: { getConnection: async () => { obtidas++; return conexao; } }, agora: () => new Date('2026-10-15T12:00:00Z') });
    return { categorias, produtos, livros, chamadas, conexao, service,
        hook: fn => { antes = fn; }, transacao: n => { emTransacao = n; }, obtidas: () => obtidas,
        executar: ids => prepararItensNaConexao(conexao, ids ?? [1, 2]) };
};
const locks = a => a.chamadas.filter(c => c.sql.includes('LOCK IN SHARE MODE'));
const conferirSemGestao = a => {
    assert.equal(a.obtidas(), 0);
    assert.equal(a.chamadas.some(c => /^(SET|START|BEGIN|COMMIT|ROLLBACK|commit|rollback|release)/.test(c.sql)), false);
};

test('snapshots válidos na conexão fornecida, sem gestão de transação/conexão', async () => {
    const a = preparar(); const ids = Object.freeze([2, 1]); const r = await a.executar(ids);
    assert.deepEqual(r, { moeda: 'BRL', totalCentavos: 19000, itens: [1, 2].map((id, indice) => ({
        produto_id: id, sku_snapshot: a.produtos[indice].sku, titulo_snapshot: a.livros[indice].title,
        descricao_snapshot: a.livros[indice].description, tipo_snapshot: 'E-Book', quantidade: 1,
        preco_unitario_centavos: 9500, subtotal_centavos: 9500
    })) });
    assert.deepEqual(ids, [2, 1]); conferirSemGestao(a);
    assert.deepEqual(Object.keys(r.itens[0]), ['produto_id', 'sku_snapshot', 'titulo_snapshot', 'descricao_snapshot', 'tipo_snapshot', 'quantidade', 'preco_unitario_centavos', 'subtotal_centavos']);
});
test('locks separados, por tabela e PK crescente, apenas ancestrais necessários', async () => {
    const a = preparar(); await a.executar([2, 1]);
    assert.deepEqual(locks(a).map(c => [c.sql.match(/FROM (\w+)/)[1], c.params[0]]), [
        ['ist_loja_categorias', 10], ['ist_loja_categorias', 30],
        ['ist_loja_produtos', 1], ['ist_loja_produtos', 2], ['ist_livros', 5], ['ist_livros', 20]
    ]);
    for (const c of locks(a)) { assert.doesNotMatch(c.sql, /JOIN/); assert.match(c.sql, /WHERE id = \?/); }
});
test('transação ativa obrigatória antes de consultar catálogo', async () => {
    const a = preparar(); a.transacao(0);
    await assert.rejects(a.executar(), { codigo: 'ERRO_INTERNO' });
    assert.equal(a.chamadas.length, 1); conferirSemGestao(a);
});
test('conexão inválida rejeitada', async () => {
    await assert.rejects(prepararItensNaConexao(null, [1]), { codigo: 'ERRO_INTERNO' });
});
for (const ids of [[], [0], ['1'], [1, 1], [2147483648], [1.5], null, Array(1), Array.from({ length: 101 }, (_, i) => i + 1)]) {
    test(`seleção interna inválida: ${JSON.stringify(ids)?.slice(0, 30)}`, async () => {
        const a = preparar(); await assert.rejects(prepararItensNaConexao(a.conexao, ids), { codigo: 'SELECAO_INVALIDA' });
        assert.equal(a.chamadas.length, 0);
    });
}
test('cotação pública preserva ordem, DTO, snapshot e gestão própria sem locks', async () => {
    const a = preparar(); const r = await a.service.cotar({ itens: [{ produtoId: 2, quantidade: 1 }, { produtoId: 1, quantidade: 1 }] });
    assert.deepEqual(r.itens.map(i => i.produtoId), [2, 1]); assert.equal(r.totalCentavos, 19000);
    assert.equal(r.geradaEm, '2026-10-15T12:00:00.000Z'); assert.equal(r.itens[0].produto.quantidadeMaxima, 1);
    assert.match(a.chamadas[0].sql, /REPEATABLE READ/); assert.match(a.chamadas[1].sql, /CONSISTENT SNAPSHOT, READ ONLY/);
    assert.deepEqual(a.chamadas.slice(-2).map(c => c.sql), ['commit', 'release']);
    assert.equal(locks(a).length, 0); assert.equal(a.obtidas(), 1);
});
for (const [alvo, campo, valor] of [
    ['produto', 'ativo', 0], ['livro', 'onsale', 0], ['livro', 'format', 'Impresso'], ['livro', 'currency', 'USD'],
    ['livro', 'inventory', 'Esgotado'], ['livro', 'arquivo_presente', 0], ['livro', 'price', '0.00'],
    ['livro', 'price', '-1.00'], ['livro', 'price', '1.001'], ['livro', 'price', 95], ['livro', 'price', '90071992547409.92']
]) {
    test(`regra compartilhada público/interno: ${alvo}.${campo}=${valor}`, async () => {
        const a = preparar(); (alvo === 'produto' ? a.produtos : a.livros)[0][campo] = valor;
        await assert.rejects(a.executar([1]), { codigo: 'PRODUTO_INDISPONIVEL' }); conferirSemGestao(a);
        await assert.rejects(a.service.cotar({ itens: [{ produtoId: 1, quantidade: 1 }] }), { codigo: 'PRODUTO_INDISPONIVEL' });
    });
}
for (const situacao of ['ancestral inativo', 'categoria inativa', 'ciclo', 'órfã']) {
    test(`ancestralidade rejeitada nos dois caminhos: ${situacao}`, async () => {
        const a = preparar();
        if (situacao === 'ancestral inativo') a.categorias[0].ativo = 0;
        if (situacao === 'categoria inativa') a.categorias[1].ativo = 0;
        if (situacao === 'ciclo') a.categorias[0].categoria_pai_id = 10;
        if (situacao === 'órfã') a.categorias[1].categoria_pai_id = 99;
        await assert.rejects(a.executar([1]), { codigo: 'PRODUTO_INDISPONIVEL' });
        await assert.rejects(a.service.cotar({ itens: [{ produtoId: 1, quantidade: 1 }] }), { codigo: 'PRODUTO_INDISPONIVEL' });
    });
}
for (const mudanca of ['novo pai', 'ciclo', 'categoria removida', 'produto recategorizado', 'livro reassociado']) {
    test(`mudança concorrente exige reinício externo: ${mudanca}`, async () => {
        const a = preparar(); let mudou = false;
        a.hook(sql => {
            if (!mudou && sql.includes('LOCK IN SHARE MODE')) {
                mudou = true;
                if (mudanca === 'novo pai') a.categorias[1].categoria_pai_id = 40;
                if (mudanca === 'ciclo') a.categorias[0].categoria_pai_id = 10;
                if (mudanca === 'categoria removida') a.categorias.splice(1, 1);
                if (mudanca === 'produto recategorizado') a.produtos[0].categoria_id = 40;
                if (mudanca === 'livro reassociado') a.produtos[0].livro_id = 5;
            }
        });
        await assert.rejects(a.executar([1]), { codigo: 'CONTENCAO_TEMPORARIA', status: 503 }); conferirSemGestao(a);
    });
}
test('ancestral desativado entre descoberta e locks é revalidado', async () => {
    const a = preparar(); a.hook(sql => { if (sql.includes('LOCK IN SHARE MODE')) a.categorias[0].ativo = 0; });
    await assert.rejects(a.executar([1]), { codigo: 'PRODUTO_INDISPONIVEL' }); conferirSemGestao(a);
});
test('preço alterado antes do lock do livro usa valor oficial atual', async () => {
    const a = preparar(); a.hook(sql => { if (sql.includes('FROM ist_livros')) a.livros[0].price = '100.01'; });
    const r = await a.executar(); assert.equal(r.itens[0].preco_unitario_centavos, 10001); assert.equal(r.totalCentavos, 19501);
});
test('indisponibilidade alterada antes do lock do livro rejeita seleção inteira', async () => {
    const a = preparar(); a.hook(sql => { if (sql.includes('FROM ist_livros')) a.livros[0].inventory = 'Esgotado'; });
    await assert.rejects(a.executar(), { codigo: 'PRODUTO_INDISPONIVEL' }); conferirSemGestao(a);
});
test('SKU alterado antes do lock do produto usa valor atual', async () => {
    const a = preparar(); a.hook(sql => { if (sql.includes('FROM ist_loja_produtos') && sql.includes('LOCK')) a.produtos[0].sku = 'SKU-NOVO'; });
    assert.equal((await a.executar([1])).itens[0].sku_snapshot, 'SKU-NOVO');
});
test('preços mínimos, centavos fracionários decimais e poucas unidades', async () => {
    const a = preparar(); a.livros[0].price = '0.01'; a.livros[1].price = '1.10'; a.livros[0].inventory = 'Poucas unidades';
    const r = await a.executar(); assert.equal(r.totalCentavos, 111); assert.deepEqual(r.itens.map(i => i.subtotal_centavos), [1, 110]);
});
test('soma acima do inteiro seguro é rejeitada mesmo com itens seguros', async () => {
    const a = preparar(); for (const l of a.livros) l.price = '45035996273704.96';
    await assert.rejects(a.executar(), { codigo: 'PRODUTO_INDISPONIVEL' });
});
for (const [campo, valor] of [['sku', ''], ['sku', ' '], ['sku', null], ['sku', 123], ['sku', 'x'.repeat(51)],
    ['title', null], ['title', ''], ['title', '  '], ['title', 123], ['title', 'x'.repeat(65536)],
    ['description', 'x'.repeat(65536)], ['description', '😀'.repeat(16384)], ['description', {}], ['description', '\ud800']]) {
    test(`snapshot inválido ${campo}: ${typeof valor}/${typeof valor === 'string' ? valor.length : ''}`, async () => {
        const a = preparar(); (campo === 'sku' ? a.produtos : a.livros)[0][campo] = valor;
        await assert.rejects(a.executar([1]), { codigo: 'PRODUTO_INDISPONIVEL' }); conferirSemGestao(a);
    });
}
test('limites exatos TEXT em bytes UTF-8 e VARCHAR em caracteres sem truncamento', async () => {
    const a = preparar(); a.produtos[0].sku = '😀'.repeat(50); a.livros[0].title = 'x'.repeat(65535);
    a.livros[0].description = '😀'.repeat(16383) + 'abc';
    const [item] = (await a.executar([1])).itens;
    assert.equal(item.sku_snapshot, a.produtos[0].sku); assert.equal(item.titulo_snapshot, a.livros[0].title);
    assert.equal(item.descricao_snapshot, a.livros[0].description); assert.equal(Buffer.byteLength(item.descricao_snapshot), 65535);
});
test('descrição nula e vazia aceitas; JSON e conteúdo original preservados sem HTML montado', async () => {
    const a = preparar(); a.livros[0].description = null; a.livros[1].description = '';
    assert.deepEqual((await a.executar()).itens.map(i => i.descricao_snapshot), [null, '']);
    const original = '{ "Title": "<img src=x onerror=alert(1)> & música" }'; a.livros[0].description = original;
    assert.equal((await a.executar([1])).itens[0].descricao_snapshot, original); assert.equal(a.livros[0].description, original);
});
for (const entidade of ['produto na descoberta', 'produto no lock', 'livro no lock']) {
    test(`registro ausente: ${entidade}`, async () => {
        const a = preparar();
        if (entidade === 'produto na descoberta') a.produtos.splice(0, 1);
        else a.hook(sql => {
            if (sql.includes('LOCK IN SHARE MODE')) {
                if (entidade === 'produto no lock') a.produtos.splice(0, a.produtos.length);
                if (entidade === 'livro no lock') a.livros.splice(0, a.livros.length);
            }
        });
        await assert.rejects(a.executar([1]), { codigo: 'PRODUTO_INDISPONIVEL' }); conferirSemGestao(a);
    });
}
for (const etapa of ['estado', 'descoberta produto', 'descoberta categorias', 'lock categoria', 'lock produto', 'lock livro']) {
    test(`falha de consulta em ${etapa} propaga sem encerrar transação externa`, async () => {
        const a = preparar(); const erro = Object.assign(new Error('falha simulada'), { code: 'ER_LOCK_DEADLOCK' });
        a.hook(sql => {
            const lock = sql.includes('LOCK IN SHARE MODE');
            if ((etapa === 'estado' && sql.includes('@@in_transaction'))
                || (etapa === 'descoberta produto' && !lock && sql.includes('FROM ist_loja_produtos'))
                || (etapa === 'descoberta categorias' && !lock && sql.includes('FROM ist_loja_categorias'))
                || (etapa === 'lock categoria' && lock && sql.includes('FROM ist_loja_categorias'))
                || (etapa === 'lock produto' && lock && sql.includes('FROM ist_loja_produtos'))
                || (etapa === 'lock livro' && lock && sql.includes('FROM ist_livros'))) throw erro;
        });
        await assert.rejects(a.executar(), e => e === erro); conferirSemGestao(a);
    });
}
