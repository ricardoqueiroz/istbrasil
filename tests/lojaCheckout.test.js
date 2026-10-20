import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { ServerResponse } from 'node:http';
import express from 'express';
import { criarLojaCheckoutRouter } from '../src/routes/lojaCheckout.routes.js';
import { criarConfiguracaoLojaSessao } from '../src/config/lojaSessao.js';
import { criarTokenCsrf } from '../src/services/lojaSessaoService.js';
import { criarErroPedido } from '../src/services/lojaPedidoContratos.js';
import { criarLojaPedidoService } from '../src/services/lojaPedidoService.js';
import { criarLojaPagamentoService } from '../src/services/lojaPagamentoService.js';
import { normalizarResultadoPagamento, normalizarReconciliacaoPagamento } from '../src/services/lojaPagamentoContratos.js';
import { criarPagamentoSimulado } from './fixtures/lojaPagamentoSimulado.js';
import { criarBancoPagamentoIsolado } from './fixtures/lojaPagamentoBancoIsolado.js';
import { expandirCatalogoSintetico } from './fixtures/lojaCatalogoComercialFixture.js';

const origem = 'http://localhost:4200';
const config = criarConfiguracaoLojaSessao({ origens: [origem], segredoCsrf: Buffer.alloc(32, 31) });
const envelope = r => normalizarReconciliacaoPagamento({ resultado: normalizarResultadoPagamento(r), observacao: {
    evidencia: 'PRESENTE', associacaoOrdem: r.capturaId ? 'CONFIRMADA' : 'NAO_DEMONSTRADA',
    validacao: r.capturaId ? 'CONSISTENTE' : 'INCONCLUSIVA',
    statusOrdem: r.estado === 'APROVADO' ? 'APPROVED' : r.capturaId ? 'COMPLETED' : 'CREATED',
    statusCaptura: r.estado === 'CAPTURADO' ? 'COMPLETED' : r.estado === 'PENDENTE' ? 'PENDING' : null,
    motivoPendencia: r.estado === 'PENDENTE' ? 'PENDING_REVIEW' : null
} });
// Express completo em memoria. Nenhum listen(), socket TCP ou API externa.
const ambienteHttp = (service, sessoes) => {
    const app = express();
    app.use('/checkout', criarLojaCheckoutRouter({ obterFinanceiro: () => ({ service }),
        env: { IST_LOJA_PAYPAL_ENV: 'sandbox', IST_LOJA_PAYPAL_CLIENT_ID: 'public-fixture-id' },
        obterConfiguracaoSessao: () => config, sessaoService: { async obterSessao(token) {
            const s = sessoes.get(token); if (!s) throw criarErroPedido('SESSAO_INVALIDA'); return s;
        } } }));
    return (acao, body, token, chave, extras = {}) => new Promise((resolve, reject) => {
        const bruto = Buffer.from(JSON.stringify(body)); const req = Readable.from([bruto]);
        const headers = { host: 'localhost', origin: origem, 'content-type': 'application/json',
            'content-length': String(bruto.length), cookie: `ist-loja-dev=${token}`, 'x-ist-loja': '1',
            'x-csrf-token': criarTokenCsrf(token, config.segredoCsrf), ...(chave ? { 'idempotency-key': chave } : {}), ...extras };
        Object.assign(req, { method: 'POST', url: `/checkout/${acao}`, headers, socket: { remoteAddress: '127.0.0.1' } });
        const res = new ServerResponse(req);
        res.end = chunk => {
            try { resolve({ status: res.statusCode, body: chunk ? JSON.parse(chunk.toString()) : null, cache: res.getHeader('cache-control') }); }
            catch (e) { reject(e); } return res;
        };
        app.handle(req, res, reject);
    });
};

test('checkout HTTP protege sessao, CSRF, contrato e nao aceita dinheiro do cliente sem abrir servidor', async () => {
    const token = randomBytes(32).toString('base64url'); const sessao = { id: 1 }; const sessoes = new Map([[token, sessao]]);
    const chamadas = [];
    const enviar = ambienteHttp({
        async criarTentativa(...args) { chamadas.push(args); }, async consultarCheckout() { return { pedido: {}, pagamento: null, ordemId: null }; },
        async capturar(...args) { chamadas.push(args); return { estado: 'PENDENTE' }; }
    }, sessoes);
    const pedidoPublicId = randomUUID(); const chave = randomUUID();
    let r = await enviar('iniciar', { pedidoPublicId, totalCentavos: 1 }, token, chave);
    assert.equal(r.status, 400); assert.equal(chamadas.length, 0);
    r = await enviar('iniciar', { pedidoPublicId }, token, chave, { 'x-csrf-token': 'invalido' });
    assert.equal(r.status, 403); assert.equal(chamadas.length, 0);
    r = await enviar('iniciar', { pedidoPublicId }, token, chave);
    assert.equal(r.status, 200); assert.equal(chamadas[0][0], sessao); assert.deepEqual(chamadas[0][1], { pedidoPublicId });
    assert.equal(chamadas[0][2], chave); assert.equal(r.cache, 'no-store');
    r = await enviar('capturar', { pagamentoPublicId: randomUUID() }, token, chave);
    assert.equal(r.body.estado, 'PENDENTE');
    r = await enviar('configuracao', {}, token);
    assert.deepEqual(r.body, { ambiente: 'sandbox', clientId: 'public-fixture-id' });
    r = await enviar('estado', { pedidoPublicId }, randomBytes(32).toString('base64url'));
    assert.equal(r.status, 401);
});

test('checkout com pedidos, catalogo e financeiro reais em MariaDB descartavel; PayPal simulado',
    { skip: !process.env.IST_LOJA_PAGAMENTOS_MARIADB_BIN }, async t => {
    process.env.NODE_ENV = 'test';
    const { admin, pool, novaCompra } = await criarBancoPagamentoIsolado(t);
    // Esquema de livros sintetico somente nesta instancia descartavel.
    await admin.query(`ALTER TABLE ist_livros ADD title TEXT, ADD description LONGTEXT, ADD price DECIMAL(10,2),
        ADD currency CHAR(3), ADD onsale INT, ADD format VARCHAR(30), ADD inventory VARCHAR(50), ADD file TEXT`);
    await admin.query("INSERT INTO ist_loja_categorias(id,nome,slug) VALUES(1,'Musica','musica')");
    await admin.query(`INSERT INTO ist_livros(id,title,description,price,currency,onsale,format,inventory,file)
        VALUES(1,'Livro EN','{}',95.00,'BRL',1,'E-Book','Em estoque','sintetico-en.pdf'),
              (2,'Livro PT','{}',95.00,'BRL',1,'E-Book','Em estoque','sintetico-pt.pdf')`);
    await admin.query("INSERT INTO ist_loja_produtos(id,categoria_id,livro_id,sku) VALUES(1,1,1,'SKU-EN'),(2,1,2,'SKU-PT')");
    await expandirCatalogoSintetico(admin);
    const sessoes = new Map(); const contexto = { provedor: 'simulado', ambiente: 'sandbox', contaRecebedora: 'recebedor-fixture' };
    // A fixture financeira força BIGINT como string; o pool real da aplicacao nao.
    // Espelhar as opcoes reais nas consultas do catalogo/pedidos, sem alterar a fixture.
    const dbPedidos = { async getConnection() {
        const c = await pool.getConnection();
        return { query: (sql, args) => c.query({ sql, typeCast: (field, next) => {
            if (field.type !== 'LONGLONG') return next();
            const texto = field.string(); if (texto === null) return null;
            const numero = Number(texto); return Number.isSafeInteger(numero) ? numero : texto;
        } }, args),
            beginTransaction: () => c.beginTransaction(), commit: () => c.commit(), rollback: () => c.rollback(),
            release: () => c.release(), destroy: () => c.destroy() };
    } };
    const pedidos = criarLojaPedidoService({ db: dbPedidos, ambiente: 'sandbox' });
    const preparar = async () => {
        const compra = await novaCompra(); const token = randomBytes(32).toString('base64url'); sessoes.set(token, compra.sessao);
        const chave = randomUUID(), entrada = { produtoIds: [1, 2], compradorEmail: 'visitante@example.invalid' };
        const pedido = await pedidos.criarPedido(compra.sessao, entrada, chave);
        assert.equal(pedido.totalCentavos, 19000);
        assert.deepEqual(await pedidos.criarPedido(compra.sessao, entrada, chave), pedido);
        const sim = criarPagamentoSimulado();
        const service = criarLojaPagamentoService({ db: pool, contexto, adaptador: { ...sim.adaptador,
            async reconciliar(args) { return envelope(await sim.adaptador.consultar(args)); } } });
        return { compra, token, pedido, sim, service, enviar: ambienteHttp(service, sessoes), criacao: randomUUID(), captura: randomUUID() };
    };
    for (const [modo, esperado] of [['integral', 'CAPTURADO'], ['pendente', 'PENDENTE'], ['recusada', 'RECUSADO']]) {
        await t.test(`criacao, aprovacao e captura ${esperado}, replay e consulta autorizada`, async () => {
            const m = await preparar(); const entrada = { pedidoPublicId: m.pedido.publicId };
            let r = await m.enviar('iniciar', entrada, m.token, m.criacao);
            assert.equal(r.status, 200); assert.equal(r.body.pedido.totalCentavos, 19000); assert.equal(r.body.pagamento.valorCentavos, 19000);
            assert.ok(r.body.ordemId); const pg = r.body.pagamento;
            r = await m.enviar('iniciar', entrada, m.token, m.criacao); assert.equal(r.body.pagamento.publicId, pg.publicId);
            assert.equal(m.sim.chamadas.criar, 1);
            m.sim.aprovado(pg.publicId); m.sim.modos.captura = modo;
            r = await m.enviar('capturar', { pagamentoPublicId: pg.publicId }, m.token, m.captura);
            assert.equal(r.status, 200); assert.equal(r.body.estado, esperado);
            r = await m.enviar('capturar', { pagamentoPublicId: pg.publicId }, m.token, m.captura);
            assert.equal(r.body.estado, esperado); assert.equal(m.sim.chamadas.capturar, 1);
            r = await m.enviar('estado', entrada, m.token); assert.equal(r.status, 200);
            assert.equal(r.body.pedido.estado === 'PAGO', esperado === 'CAPTURADO');
            assert.doesNotMatch(JSON.stringify(r.body), /token_hash|comprador_email|conta_recebedora|sintetico-.*\.pdf|request_id_provedor/);
            const outro = await novaCompra(); const alheio = randomBytes(32).toString('base64url'); sessoes.set(alheio, outro.sessao);
            for (const acao of ['estado', 'iniciar', 'capturar', 'reconciliar']) {
                const corpo = ['estado', 'iniciar'].includes(acao) ? entrada : { pagamentoPublicId: pg.publicId };
                const bloqueado = await m.enviar(acao, corpo, alheio, randomUUID()); assert.equal(bloqueado.status, 404);
            }
        });
    }
    await t.test('captura antes da aprovacao nao cobra; resposta perdida e reconciliada sem nova captura', async () => {
        const m = await preparar(); const entrada = { pedidoPublicId: m.pedido.publicId };
        const inicial = await m.enviar('iniciar', entrada, m.token, m.criacao); const pg = inicial.body.pagamento;
        let r = await m.enviar('capturar', { pagamentoPublicId: pg.publicId }, m.token, m.captura);
        assert.equal(r.status, 409); assert.equal(m.sim.chamadas.capturar, 0);
        m.sim.aprovado(pg.publicId); m.sim.modos.captura = 'respostaPerdida';
        // Reutilizar a MESMA operacao; a anterior ja existia, sem criar outra chave.
        r = await m.enviar('capturar', { pagamentoPublicId: pg.publicId }, m.token, m.captura);
        assert.equal(r.status, 503);
        r = await m.enviar('reconciliar', { pagamentoPublicId: pg.publicId }, m.token);
        assert.equal(r.status, 200); assert.equal(r.body.estado, 'CAPTURADO'); assert.equal(m.sim.efeitosCaptura, 1);
        assert.equal(m.sim.chamadas.capturar, 1);
    });
    await t.test('produto indisponivel e valores enviados pelo cliente sao rejeitados', async () => {
        const compra = await novaCompra();
        await assert.rejects(pedidos.criarPedido(compra.sessao,
            { produtoIds: [1], compradorEmail: 'visitante@example.invalid', totalCentavos: 1 }, randomUUID()));
        await admin.query('UPDATE ist_loja_produtos SET ativo=0 WHERE id=2');
        try { await assert.rejects(pedidos.criarPedido(compra.sessao, { produtoIds: [1, 2], compradorEmail: 'visitante@example.invalid' }, randomUUID())); }
        finally { await admin.query('UPDATE ist_loja_produtos SET ativo=1 WHERE id=2'); }
    });
    await t.test('preco oficial muda para novo pedido sem alterar snapshots nem replay anterior', async () => {
        const m = await preparar();
        await admin.query('UPDATE ist_loja_produtos SET preco_centavos=11000 WHERE id=1');
        try {
            const chave = randomUUID(); const entrada = { produtoIds: [1, 2], compradorEmail: 'visitante@example.invalid' };
            const novo = await pedidos.criarPedido(m.compra.sessao, entrada, chave);
            assert.equal(novo.totalCentavos, 20500);
            assert.deepEqual(await pedidos.criarPedido(m.compra.sessao, entrada, chave), novo);
            const anterior = await m.enviar('estado', { pedidoPublicId: m.pedido.publicId }, m.token);
            assert.equal(anterior.body.pedido.totalCentavos, 19000);
        } finally { await admin.query('UPDATE ist_loja_produtos SET preco_centavos=9500 WHERE id=1'); }
    });
});
