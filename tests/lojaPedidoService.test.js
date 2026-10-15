import test from 'node:test';
import assert from 'node:assert/strict';
import { criarLojaPedidoService } from '../src/services/lojaPedidoService.js';
import { prepararItensNaConexao } from '../src/services/lojaCatalogoService.js';

const CHAVE = 'aabbccdd-1122-4333-8abc-123456789abc';
const OUTRA_CHAVE = 'aabbccdd-1122-4333-8abc-123456789abd';
const entrada = (produtoIds = [1, 2], compradorEmail = 'Pessoa@example.com') => ({ produtoIds, compradorEmail });
const formatoBanco = iso => iso.slice(0, 23) + '000Z';
const copiar = linha => ({ ...linha, ...(linha.solicitacao_hash ? { solicitacao_hash: Buffer.from(linha.solicitacao_hash) } : {}) });

// Banco simulado com transacoes, dados pendentes privados e exclusao mutua por
// sessao. Nenhum mock abre conexao real ou aplica escrita no banco recuperado.
const preparar = ({ ambiente = 'sandbox' } = {}) => {
    const pedidos = []; const itens = []; const chamadas = []; const conexoes = [];
    const preparacoes = []; const filas = new Map();
    let agora = new Date('2026-10-15T12:00:00.123Z');
    let hook = async () => {}; let sequencia = 0;
    const sessoes = [1, 2].map(id => ({ id, criada_em_utc: '2026-10-15T00:00:00.123000Z', expira_em_utc: '2026-10-16T00:00:00.123000Z', revogada: 0 }));
    const categorias = [{ id: 1, categoria_pai_id: null, ativo: 1 }, { id: 2, categoria_pai_id: 1, ativo: 1 }];
    const produtos = [1, 2].map(id => ({ id, categoria_id: 2, livro_id: id, sku: `SKU${id}`, ativo: 1 }));
    const livros = [1, 2].map(id => ({ id, title: `Livro ${id}`, description: '{"Content":"PDF & música"}',
        price: '95.00', currency: 'BRL', onsale: 1, format: 'E-Book', inventory: 'Em estoque', arquivo_presente: 1 }));
    const evento = async (tipo, c, extra = {}) => {
        chamadas.push({ tipo, conexao: c?.numero, ...extra });
        await hook({ tipo, c, ...extra });
    };
    const db = { async getConnection() {
        await evento('getConnection');
        const c = { numero: conexoes.length + 1, ativa: false, novosPedidos: [], novosItens: [], liberarLock: null, destruida: false,
            soltar() { if (this.liberarLock) { this.liberarLock(); this.liberarLock = null; } },
            async beginTransaction() { await evento('begin', this); this.ativa = true; },
            async query(sql, params = []) {
                await evento('query', this, { sql, params });
                if (sql.startsWith('SET TRANSACTION')) { assert.equal(this.ativa, false); return [[]]; }
                if (sql.includes('@@in_transaction')) return [[{ em_transacao: this.ativa ? 1 : 0 }]];
                assert.equal(this.ativa, true, 'consulta comercial fora da transacao');
                if (sql.includes('FROM ist_loja_sessoes')) {
                    assert.match(sql, /FOR UPDATE/);
                    const anterior = filas.get(params[0]) ?? Promise.resolve();
                    let liberar; const atual = new Promise(resolve => { liberar = resolve; });
                    filas.set(params[0], anterior.then(() => atual));
                    await anterior; this.liberarLock = liberar;
                    return [sessoes.filter(s => s.id === params[0]).map(copiar)];
                }
                if (sql.includes('FROM ist_loja_pedidos')) return [[...pedidos, ...this.novosPedidos]
                    .filter(p => p.sessao_id === params[0] && p.idempotencia_criacao === params[1]).map(copiar)];
                if (sql.includes('FROM ist_loja_pedido_itens')) return [[...itens, ...this.novosItens]
                    .filter(i => i.pedido_id === params[0]).sort((a, b) => a.posicao - b.posicao).map(copiar)];
                if (sql.startsWith('INSERT INTO ist_loja_pedidos')) {
                    const campos = ['public_id', 'sessao_id', 'comprador_email', 'estado', 'ambiente', 'moeda', 'total_centavos',
                        'idempotencia_criacao', 'solicitacao_hash', 'versao', 'criado_em', 'atualizado_em', 'expira_em'];
                    const p = Object.fromEntries(campos.map((campo, indice) => [campo, params[indice]]));
                    for (const campo of ['criado_em', 'atualizado_em', 'expira_em']) p[campo + '_utc'] = formatoBanco(p[campo].replace(' ', 'T') + 'Z');
                    p.id = ++sequencia; this.novosPedidos.push(copiar(p));
                    return [{ insertId: p.id, affectedRows: 1, warningStatus: 0 }];
                }
                if (sql.startsWith('INSERT INTO ist_loja_pedido_itens')) {
                    const campos = ['pedido_id', 'produto_id', 'posicao', 'sku_snapshot', 'titulo_snapshot', 'descricao_snapshot',
                        'tipo_snapshot', 'quantidade', 'preco_unitario_centavos', 'subtotal_centavos'];
                    this.novosItens.push(Object.fromEntries(campos.map((campo, indice) => [campo, params[indice]])));
                    return [{ affectedRows: 1, warningStatus: 0 }];
                }
                let linhas;
                if (sql.includes('FROM ist_loja_categorias')) linhas = categorias;
                else if (sql.includes('FROM ist_loja_produtos')) linhas = produtos;
                else if (sql.includes('FROM ist_livros')) linhas = livros;
                else throw new Error('SQL inesperado');
                if (sql.includes('WHERE id = ?')) linhas = linhas.filter(l => l.id === params[0]);
                return [linhas.map(copiar)];
            },
            async commit() {
                await evento('commitAntes', this);
                pedidos.push(...this.novosPedidos); itens.push(...this.novosItens);
                this.novosPedidos = []; this.novosItens = []; this.ativa = false; this.soltar();
                await evento('commitDepois', this);
            },
            async rollback() {
                await evento('rollback', this);
                this.novosPedidos = []; this.novosItens = []; this.ativa = false; this.soltar();
            },
            release() { assert.equal(this.ativa, false); chamadas.push({ tipo: 'release', conexao: this.numero }); },
            destroy() {
                chamadas.push({ tipo: 'destroy', conexao: this.numero }); this.destruida = true;
                this.novosPedidos = []; this.novosItens = []; this.ativa = false; this.soltar();
            }
        };
        conexoes.push(c); return c;
    } };
    const opcoes = { db, ambiente, agora: () => new Date(agora), prepararItens: async (c, ids) => {
        preparacoes.push({ conexao: c.numero, ids: [...ids] }); return prepararItensNaConexao(c, ids);
    } };
    const service = criarLojaPedidoService(opcoes);
    return { pedidos, itens, chamadas, conexoes, sessoes, categorias, produtos, livros, preparacoes, opcoes, db,
        hook: fn => { hook = fn; }, avancar: ms => { agora = new Date(agora.getTime() + ms); },
        criar: (dados = entrada(), chave = CHAVE, sessaoId = 1) => service.criarPedido({ id: sessaoId }, dados, chave) };
};
const falhaSql = (code = 'ER_ACCESS_DENIED_ERROR', extra = {}) => Object.assign(new Error('SQL privado, senha, token'), { code, ...extra });
const inserts = a => a.chamadas.filter(e => e.tipo === 'query' && e.sql.startsWith('INSERT'));
const conferirLimpo = a => {
    assert.equal(a.pedidos.length, 0); assert.equal(a.itens.length, 0);
    for (const c of a.conexoes) { assert.equal(c.ativa, false); assert.equal(c.novosItens.length, 0); assert.equal(c.novosPedidos.length, 0); }
};

for (const ids of [[1], [1, 2]]) test(`cria pedido atômico com ${ids.length} produto(s), snapshots e soma oficial`, async () => {
    const a = preparar(); const r = await a.criar(entrada(ids));
    assert.equal(r.estado, 'CRIADO'); assert.equal(r.versao, 1); assert.equal(r.moeda, 'BRL');
    assert.equal(r.totalCentavos, ids.length * 9500); assert.equal(r.itens.length, ids.length);
    assert.equal(r.criadoEm, '2026-10-15T12:00:00.123Z'); assert.equal(r.expiraEm, '2026-10-15T12:30:00.123Z');
    assert.match(r.publicId, /^[0-9a-f-]{14}4[0-9a-f-]{21}$/);
    assert.equal(a.pedidos.length, 1); assert.equal(a.itens.length, ids.length);
    assert.equal(a.itens[0].descricao_snapshot, a.livros[0].description);
    assert.equal(a.pedidos[0].ambiente, 'sandbox'); assert.equal(a.pedidos[0].total_centavos, r.totalCentavos);
    assert.ok(Buffer.isBuffer(a.pedidos[0].solicitacao_hash));
    assert.equal(a.preparacoes[0].conexao, 1);
    assert.match(a.chamadas.find(e => e.tipo === 'query').sql, /^SET TRANSACTION ISOLATION LEVEL READ COMMITTED$/);
    const queries = a.chamadas.filter(e => e.tipo === 'query');
    assert.ok(queries.findIndex(e => e.sql.includes('FROM ist_loja_sessoes')) < queries.findIndex(e => e.sql.includes('LOCK IN SHARE MODE')));
    assert.equal(a.chamadas.at(-1).tipo, 'release');
});
test('pedido limitado à validade restante da sessão', async () => {
    const a = preparar(); a.avancar(11 * 3600_000 + 50 * 60_000);
    assert.equal((await a.criar()).expiraEm, '2026-10-16T00:00:00.123Z');
});
for (const caso of ['ausente', 'expirada', 'revogada', 'futura', 'mais de 24h']) test(`sessão ${caso} rejeitada dentro da transação`, async () => {
    const a = preparar();
    if (caso === 'ausente') a.sessoes.splice(0, 1);
    if (caso === 'expirada') a.avancar(12 * 3600_000);
    if (caso === 'revogada') a.sessoes[0].revogada = 1;
    if (caso === 'futura') a.sessoes[0].criada_em_utc = '2026-10-15T13:00:00.123000Z';
    if (caso === 'mais de 24h') a.sessoes[0].expira_em_utc = '2026-10-17T00:00:00.123000Z';
    await assert.rejects(a.criar(), { codigo: 'SESSAO_INVALIDA' }); conferirLimpo(a);
    assert.equal(a.preparacoes.length, 0);
});
for (const [dados, chave, codigo] of [
    [entrada([], 'Pessoa@example.com'), CHAVE, 'SELECAO_INVALIDA'], [entrada([1, 1]), CHAVE, 'SELECAO_INVALIDA'],
    [entrada([1], 'inválido'), CHAVE, 'EMAIL_INVALIDO'], [entrada(), 'errada', 'IDEMPOTENCIA_INVALIDA'],
    [{ ...entrada(), preco: 1 }, CHAVE, 'SOLICITACAO_INVALIDA'], [{ ...entrada(), token: 'segredo' }, CHAVE, 'SOLICITACAO_INVALIDA']
]) test(`parâmetros inválidos falham antes do pool: ${codigo}`, async () => {
    const a = preparar(); await assert.rejects(a.criar(dados, chave), { codigo }); assert.equal(a.chamadas.length, 0);
});
test('identificação da sessão inválida não abre conexão', async () => {
    const a = preparar(); await assert.rejects(a.criar(entrada(), CHAVE, 0), { codigo: 'SESSAO_INVALIDA' }); assert.equal(a.chamadas.length, 0);
});
test('ambiente é configuração do servidor; inválido não abre conexão', async () => {
    const a = preparar({ ambiente: 'outro' }); await assert.rejects(a.criar(), { codigo: 'ERRO_INTERNO' }); assert.equal(a.chamadas.length, 0);
});
test('repetição normalizada retorna o mesmo pedido sem cotar, inserir ou renovar', async () => {
    const a = preparar(); const inicial = await a.criar(); const n = inserts(a).length;
    a.livros[0].price = '300.00'; a.livros[0].onsale = 0; a.avancar(40 * 60_000);
    const r = await a.criar(entrada([2, 1], ' Pessoa@EXAMPLE.COM '), CHAVE.toUpperCase());
    assert.deepEqual(r, inicial); assert.equal(a.preparacoes.length, 1); assert.equal(inserts(a).length, n);
    assert.equal(a.itens.length, 2); assert.equal(a.pedidos.length, 1);
});
test('repetição pode retornar o estado atual sem recalcular', async () => {
    const a = preparar(); await a.criar(); a.pedidos[0].estado = 'EXPIRADO'; a.pedidos[0].versao = 2;
    const r = await a.criar(); assert.equal(r.estado, 'EXPIRADO'); assert.equal(r.versao, 2); assert.equal(a.preparacoes.length, 1);
});
for (const dados of [entrada([1]), entrada([1, 2], 'Outra@example.com')]) test('mesma chave com payload divergente retorna conflito', async () => {
    const a = preparar(); await a.criar(); await assert.rejects(a.criar(dados), { codigo: 'CONFLITO_IDEMPOTENCIA' });
    assert.equal(a.pedidos.length, 1); assert.equal(a.itens.length, 2); assert.equal(a.preparacoes.length, 1);
});
test('mesma chave em outra sessão tem escopo independente', async () => {
    const a = preparar(); const r1 = await a.criar(); const r2 = await a.criar(entrada(), CHAVE, 2);
    assert.notEqual(r1.publicId, r2.publicId); assert.equal(a.pedidos.length, 2);
});
test('alterar ambiente confiável com a mesma chave é conflito', async () => {
    const a = preparar(); await a.criar();
    await assert.rejects(criarLojaPedidoService({ ...a.opcoes, ambiente: 'live' }).criarPedido({ id: 1 }, entrada(), CHAVE), { codigo: 'CONFLITO_IDEMPOTENCIA' });
});
test('dez chamadas simultâneas com a mesma chave criam um único pedido', async () => {
    const a = preparar(); const respostas = await Promise.all(Array.from({ length: 10 }, () => a.criar()));
    for (const r of respostas) assert.deepEqual(r, respostas[0]);
    assert.equal(a.pedidos.length, 1); assert.equal(a.itens.length, 2); assert.equal(a.preparacoes.length, 1);
});
test('chaves simultâneas diferentes na mesma sessão criam pedidos distintos completos', async () => {
    const a = preparar(); const respostas = await Promise.all([a.criar(), a.criar(entrada(), OUTRA_CHAVE)]);
    assert.notEqual(respostas[0].publicId, respostas[1].publicId); assert.equal(a.pedidos.length, 2); assert.equal(a.itens.length, 4);
});
test('sessões diferentes podem criar pedidos em paralelo', async () => {
    const a = preparar(); const respostas = await Promise.all([a.criar(), a.criar(entrada(), CHAVE, 2)]);
    assert.notEqual(respostas[0].publicId, respostas[1].publicId); assert.equal(a.pedidos.length, 2);
});
test('nova chave utiliza preço oficial alterado e preserva o snapshot anterior', async () => {
    const a = preparar(); await a.criar(); a.livros[0].price = '100.01';
    const r = await a.criar(entrada(), OUTRA_CHAVE); assert.equal(r.totalCentavos, 19501); assert.equal(a.itens[0].preco_unitario_centavos, 9500);
});
test('produto indisponível reverte sem escrever pedido', async () => {
    const a = preparar(); a.livros[0].onsale = 0;
    await assert.rejects(a.criar(), { codigo: 'PRODUTO_INDISPONIVEL' }); conferirLimpo(a);
});
for (const local of ['getConnection', 'begin', 'sessão', 'inserir pedido', 'inserir segundo item', 'reler pedido', 'reler itens']) {
    test(`falha em ${local} não deixa gravação parcial nem erro SQL público`, async () => {
        const a = preparar();
        a.hook(e => {
            if ((e.tipo === local) || (e.tipo === 'query' && (
                (local === 'sessão' && e.sql.includes('FROM ist_loja_sessoes'))
                || (local === 'inserir pedido' && e.sql.startsWith('INSERT INTO ist_loja_pedidos'))
                || (local === 'inserir segundo item' && e.sql.startsWith('INSERT INTO ist_loja_pedido_itens') && e.params[2] === 2)
                || (local === 'reler pedido' && e.sql.includes('FROM ist_loja_pedidos') && e.c.novosPedidos.length)
                || (local === 'reler itens' && e.sql.includes('FROM ist_loja_pedido_itens'))))) throw falhaSql();
        });
        await assert.rejects(a.criar(), e => e.codigo === 'ERRO_INTERNO' && !/SQL|senha|token/.test(e.message) && !e.sqlMessage);
        conferirLimpo(a);
    });
}
for (const code of ['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT']) {
    test(`${code}: rollback completo e nova conexão até sucesso`, async () => {
        const a = preparar(); let falhou = false;
        a.hook(e => { if (!falhou && e.tipo === 'query' && e.sql.startsWith('INSERT INTO ist_loja_pedido_itens') && e.params[2] === 2) { falhou = true; throw falhaSql(code); } });
        const r = await a.criar(); assert.equal(r.totalCentavos, 19000); assert.equal(a.pedidos.length, 1); assert.equal(a.itens.length, 2);
        assert.equal(a.conexoes.length, 2); assert.equal(a.chamadas.filter(e => e.tipo === 'rollback').length, 1);
        assert.ok(a.chamadas.findIndex(e => e.tipo === 'release' && e.conexao === 1) < a.chamadas.findIndex(e => e.tipo === 'begin' && e.conexao === 2));
    });
    test(`${code}: limite total de três tentativas e erro temporário`, async () => {
        const a = preparar(); a.hook(e => { if (e.tipo === 'query' && e.sql.includes('FROM ist_loja_sessoes')) throw falhaSql(code); });
        await assert.rejects(a.criar(), { codigo: 'CONTENCAO_TEMPORARIA' });
        assert.equal(a.conexoes.length, 3); assert.equal(a.chamadas.filter(e => e.tipo === 'rollback').length, 3); conferirLimpo(a);
    });
}
for (const momento of ['commitAntes', 'commitDepois']) test(`COMMIT incerto em ${momento}: reconciliação sem repetir INSERT`, async () => {
    const a = preparar(); let falhou = false;
    a.hook(e => { if (!falhou && e.tipo === momento) { falhou = true; throw falhaSql('PROTOCOL_CONNECTION_LOST'); } });
    if (momento === 'commitDepois') {
        const r = await a.criar(); assert.equal(r.publicId, a.pedidos[0].public_id); assert.equal(a.itens.length, 2);
    } else { await assert.rejects(a.criar(), { codigo: 'CONTENCAO_TEMPORARIA' }); conferirLimpo(a); }
    assert.equal(a.conexoes.length, 2); assert.equal(a.conexoes[0].destruida, true);
    assert.equal(a.preparacoes.length, 1); assert.equal(inserts(a).length, 3);
    assert.equal(a.chamadas.some(e => e.tipo === 'rollback' && e.conexao === 1), false);
});
test('falha na reconciliação devolve erro temporário e permite replay posterior seguro', async () => {
    const a = preparar(); let falhou = false;
    a.hook(e => {
        if (e.tipo === 'commitDepois' && !falhou) { falhou = true; throw falhaSql('ECONNRESET'); }
        if (e.c?.numero === 2 && e.tipo === 'query') throw falhaSql();
    });
    await assert.rejects(a.criar(), { codigo: 'CONTENCAO_TEMPORARIA' }); assert.equal(a.pedidos.length, 1);
    a.hook(() => {}); assert.equal((await a.criar()).publicId, a.pedidos[0].public_id); assert.equal(a.preparacoes.length, 1);
});
test('COMMIT incerto não cria nova chave de idempotência', async () => {
    const a = preparar(); let n = 0;
    a.hook(e => { if (e.tipo === 'commitDepois' && ++n === 1) throw falhaSql(); });
    await a.criar();
    for (const e of a.chamadas.filter(e => e.tipo === 'query' && e.sql.includes('FROM ist_loja_pedidos'))) assert.equal(e.params[1], CHAVE);
});
test('rollback com falha descarta conexão e impede retry', async () => {
    const a = preparar(); a.hook(e => { if (e.tipo === 'rollback' || (e.tipo === 'query' && e.sql.startsWith('INSERT INTO ist_loja_pedido_itens'))) throw falhaSql('ER_LOCK_DEADLOCK'); });
    await assert.rejects(a.criar(), { codigo: 'ERRO_INTERNO' }); assert.equal(a.conexoes.length, 1); assert.equal(a.conexoes[0].destruida, true); conferirLimpo(a);
});
for (const indice of ['uq_loja_pedidos_public_id', 'PRIMARY', 'outra_constraint', undefined]) {
    test(`UNIQUE ${indice} não é tratado como repetição nem retentado`, async () => {
        const a = preparar(); a.hook(e => { if (e.tipo === 'query' && e.sql.startsWith('INSERT INTO ist_loja_pedidos')) throw falhaSql('ER_DUP_ENTRY', { sqlMessage: indice ? `Duplicate entry for key '${indice}'` : 'Duplicate entry' }); });
        await assert.rejects(a.criar(), { codigo: 'ERRO_INTERNO' }); assert.equal(a.conexoes.length, 1); conferirLimpo(a);
    });
}
test('UNIQUE de idempotência dispara reconciliação específica após rollback', async () => {
    const a = preparar(); let falhou = false;
    a.hook(e => { if (!falhou && e.tipo === 'query' && e.sql.startsWith('INSERT INTO ist_loja_pedidos')) {
        falhou = true; throw falhaSql('ER_DUP_ENTRY', { sqlMessage: "Duplicate entry for key 'uq_loja_pedidos_sessao_idempotencia'" });
    } });
    await assert.rejects(a.criar(), { codigo: 'CONTENCAO_TEMPORARIA' }); assert.equal(a.conexoes.length, 2); assert.equal(a.preparacoes.length, 1); conferirLimpo(a);
});
for (const corrupcao of ['quantidade', 'subtotal', 'titulo', 'descricao', 'faltando item', 'total pedido', 'produto inesperado']) {
    test(`integridade persistida: ${corrupcao} provoca rollback`, async () => {
        const a = preparar();
        a.hook(e => {
            if (e.tipo !== 'query' || !e.sql.includes('FROM ist_loja_pedido_itens')) return;
            const item = e.c.novosItens[0];
            if (corrupcao === 'quantidade') item.quantidade = 2;
            if (corrupcao === 'subtotal') item.subtotal_centavos = 1;
            if (corrupcao === 'titulo') item.titulo_snapshot = 'truncado';
            if (corrupcao === 'descricao') item.descricao_snapshot = 'truncado';
            if (corrupcao === 'faltando item') e.c.novosItens.pop();
            if (corrupcao === 'total pedido') item.subtotal_centavos = item.preco_unitario_centavos = 9600;
            if (corrupcao === 'produto inesperado') item.produto_id = 123;
        });
        await assert.rejects(a.criar(), { codigo: 'ERRO_INTERNO' }); conferirLimpo(a);
    });
}
test('sessão que expira durante preparação é rejeitada antes de inserir', async () => {
    const a = preparar(); a.hook(e => { if (e.tipo === 'query' && e.sql.includes('FROM ist_livros')) a.avancar(12 * 3600_000); });
    await assert.rejects(a.criar(), { codigo: 'SESSAO_INVALIDA' }); conferirLimpo(a); assert.equal(inserts(a).length, 0);
});
test('pedido que expira durante escrita não é confirmado', async () => {
    const a = preparar(); a.hook(e => { if (e.tipo === 'query' && e.sql.includes('FROM ist_loja_pedido_itens')) a.avancar(30 * 60_000); });
    await assert.rejects(a.criar(), { codigo: 'CONTENCAO_TEMPORARIA' }); conferirLimpo(a);
});
test('sessão expirada ou revogada impede replay mesmo com pedido existente', async () => {
    const a = preparar(); await a.criar(); a.sessoes[0].revogada = 1;
    await assert.rejects(a.criar(), { codigo: 'SESSAO_INVALIDA' }); assert.equal(a.pedidos.length, 1);
    a.sessoes[0].revogada = 0; a.avancar(12 * 3600_000);
    await assert.rejects(a.criar(), { codigo: 'SESSAO_INVALIDA' }); assert.equal(a.preparacoes.length, 1);
});
test('UUID inválido do gerador falha sem inserir pedido', async () => {
    const a = preparar(); const service = criarLojaPedidoService({ ...a.opcoes, gerarUuid: () => 'inválido' });
    await assert.rejects(service.criarPedido({ id: 1 }, entrada(), CHAVE), { codigo: 'ERRO_INTERNO' }); conferirLimpo(a);
});
test('projeção pública não expõe metadados internos, hash, descrição privada ou e-mail', async () => {
    const a = preparar(); const r = await a.criar();
    assert.deepEqual(Object.keys(r), ['publicId', 'estado', 'versao', 'moeda', 'totalCentavos', 'criadoEm', 'expiraEm', 'itens']);
    assert.deepEqual(Object.keys(r.itens[0]), ['produtoId', 'sku', 'titulo', 'tipo', 'quantidade', 'precoUnitarioCentavos', 'subtotalCentavos']);
    assert.doesNotMatch(JSON.stringify(r), /sessao|hash|token|pagamento|example.com|descricao|pdf/i);
    assert.equal(a.chamadas.some(e => e.tipo === 'query' && /^(UPDATE|DELETE|ALTER|CREATE)/.test(e.sql)), false);
});
test('novo pedido não usa total informado pelo preparador: soma os snapshots oficiais', async () => {
    const a = preparar(); const service = criarLojaPedidoService({ ...a.opcoes, prepararItens: async (c, ids) => ({ ...(await prepararItensNaConexao(c, ids)), totalCentavos: 1 }) });
    assert.equal((await service.criarPedido({ id: 1 }, entrada(), CHAVE)).totalCentavos, 19000);
});
test('após COMMIT não efetivado o cliente pode repetir usando a mesma chave', async () => {
    const a = preparar(); let falhou = false;
    a.hook(e => { if (!falhou && e.tipo === 'commitAntes') { falhou = true; throw falhaSql('ECONNRESET'); } });
    await assert.rejects(a.criar(), { codigo: 'CONTENCAO_TEMPORARIA' }); conferirLimpo(a);
    const r = await a.criar(); assert.equal(r.totalCentavos, 19000); assert.equal(a.pedidos.length, 1);
});
test('sessão expirada enquanto aguardava o lock é rejeitada antes de consultar catálogo', async () => {
    const a = preparar(); a.hook(e => { if (e.tipo === 'query' && e.sql.includes('FROM ist_loja_sessoes')) a.avancar(12 * 3600_000); });
    await assert.rejects(a.criar(), { codigo: 'SESSAO_INVALIDA' }); conferirLimpo(a); assert.equal(a.preparacoes.length, 0);
});
for (const divergente of [false, true]) test(`UNIQUE de idempotência reconcilia pedido externo (divergente=${divergente})`, async () => {
    const a = preparar(); const inicial = await a.criar(); const pedido = a.pedidos.pop(); const itens = a.itens.splice(0);
    let restaurado = false;
    a.hook(e => {
        if (!restaurado && e.tipo === 'query' && e.sql.startsWith('INSERT INTO ist_loja_pedidos')) {
            restaurado = true; a.pedidos.push(pedido); a.itens.push(...itens);
            throw falhaSql('ER_DUP_ENTRY', { sqlMessage: "Duplicate entry for key 'uq_loja_pedidos_sessao_idempotencia'" });
        }
    });
    if (divergente) await assert.rejects(a.criar(entrada([1])), { codigo: 'CONFLITO_IDEMPOTENCIA' });
    else assert.deepEqual(await a.criar(), inicial);
    assert.equal(a.pedidos.length, 1); assert.equal(a.itens.length, 2);
});
test('falha não transitória não é retentada', async () => {
    const a = preparar(); a.hook(e => { if (e.tipo === 'query' && e.sql.includes('FROM ist_loja_sessoes')) throw falhaSql('ECONNRESET'); });
    await assert.rejects(a.criar(), { codigo: 'ERRO_INTERNO' }); assert.equal(a.conexoes.length, 1); conferirLimpo(a);
});
