import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, basename, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import { criarLojaPedidoService } from '../src/services/lojaPedidoService.js';

// Opt-in exclusivo para instancia temporaria. Nao usa DB_* nem o pool recuperado.
test('pedidos em MariaDB temporário isolado', { skip: !process.env.IST_LOJA_TEST_PORT }, async t => {
    const port = Number(process.env.IST_LOJA_TEST_PORT);
    const datadir = resolve(process.env.IST_LOJA_TEST_DATADIR ?? '');
    assert.ok(Number.isInteger(port) && port > 1024 && port <= 65535 && port !== 3306);
    assert.match(basename(datadir), /^ist-loja-65-4-[a-z0-9-]+$/i);
    assert.equal(dirname(datadir).toLowerCase(), resolve(tmpdir()).toLowerCase());
    const admin = await mysql.createConnection({ host: '127.0.0.1', port, user: 'root', password: '', connectTimeout: 3000 });
    t.after(() => admin.end());
    const [[servidor]] = await admin.query('SELECT @@datadir AS datadir, VERSION() AS versao');
    assert.equal(resolve(servidor.datadir).toLowerCase(), datadir.toLowerCase());
    assert.match(servidor.versao, /MariaDB/);
    t.diagnostic(`Servidor isolado: ${servidor.versao}; porta ${port}`);
    const banco = `ist_loja_65_4_${randomBytes(6).toString('hex')}`;
    await admin.query(`CREATE DATABASE ${banco} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    await admin.query(`USE ${banco}`);
    await admin.query(`CREATE TABLE ist_livros (id INT PRIMARY KEY, title TEXT, description LONGTEXT,
        price DECIMAL(10,2), currency CHAR(3), onsale INT, format VARCHAR(32), inventory VARCHAR(32),
        file TEXT) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    // DDL real das duas migrations, aplicado SOMENTE na instancia descartavel.
    for (const arquivo of ['ist_loja_catalogo.sql', 'ist_loja_pedidos_fundacao.sql']) {
        const sql = await readFile(new URL(`../migrations/${arquivo}`, import.meta.url), 'utf8');
        const tabelas = sql.match(/CREATE TABLE [\s\S]*?\) ENGINE=InnoDB[^;]*;/g);
        assert.equal(tabelas.length, arquivo === 'ist_loja_catalogo.sql' ? 2 : 3);
        for (const tabela of tabelas) await admin.query(tabela);
    }
    for (const id of [1, 2]) await admin.query(`INSERT INTO ist_livros VALUES (?, ?, ?, '95.00', 'BRL', 1, 'E-Book', 'Em estoque', '/fixture/privado.pdf')`,
        [id, `Livro fixture ${id}`, '{"Content":"PDF & música"}']);
    await admin.query("INSERT INTO ist_loja_categorias (id,nome,slug,categoria_pai_id) VALUES (1,'Livros digitais','livros-digitais',NULL),(2,'Música','musica',1)");
    await admin.query("INSERT INTO ist_loja_produtos (id,categoria_id,livro_id,sku) VALUES (1,2,1,'FIXTURE-1'),(2,2,2,'FIXTURE-2')");
    const db = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: '', database: banco, connectionLimit: 5 });
    t.after(() => db.end());
    const service = criarLojaPedidoService({ db });
    const dados = { produtoIds: [1, 2], compradorEmail: 'fixture@example.com' };
    const novaSessao = async () => {
        const criada = new Date(); const expira = new Date(criada.getTime() + 86400_000);
        const sqlData = d => d.toISOString().slice(0, 23).replace('T', ' ');
        const [r] = await admin.query('INSERT INTO ist_loja_sessoes (token_hash,criada_em,expira_em) VALUES (?,?,?)', [randomBytes(32), sqlData(criada), sqlData(expira)]);
        return { id: r.insertId };
    };
    const contar = async (sessao, chave) => {
        const [[r]] = await admin.query('SELECT COUNT(*) AS quantidade FROM ist_loja_pedidos WHERE sessao_id=? AND idempotencia_criacao=?', [sessao.id, chave]);
        return r.quantidade;
    };
    const poolAdaptado = adaptar => ({ async getConnection() {
        const c = await db.getConnection();
        return adaptar({ query: (...args) => c.query(...args), beginTransaction: () => c.beginTransaction(),
            commit: () => c.commit(), rollback: () => c.rollback(), release: () => c.release(), destroy: () => c.destroy() });
    } });

    await t.test('dois produtos, snapshots, FK e soma persistida de 19000', async () => {
        const sessao = await novaSessao(); const chave = randomUUID();
        const r = await service.criarPedido(sessao, dados, chave);
        assert.equal(r.totalCentavos, 19000); assert.equal(r.itens.length, 2);
        const [[soma]] = await admin.query(`SELECT COUNT(*) AS quantidade, SUM(i.subtotal_centavos) AS total
            FROM ist_loja_pedido_itens i JOIN ist_loja_pedidos p ON p.id=i.pedido_id WHERE p.public_id=?`, [r.publicId]);
        assert.equal(soma.quantidade, 2); assert.equal(Number(soma.total), 19000);
        assert.deepEqual(await service.criarPedido(sessao, dados, chave), r);
    });
    await t.test('concorrência real com mesma chave cria somente um pedido', async () => {
        const sessao = await novaSessao(); const chave = randomUUID();
        const respostas = await Promise.all(Array.from({ length: 5 }, () => service.criarPedido(sessao, dados, chave)));
        assert.equal(new Set(respostas.map(r => r.publicId)).size, 1); assert.equal(await contar(sessao, chave), 1);
    });
    await t.test('concorrência real com chaves diferentes preserva ambos os pedidos', async () => {
        const sessao = await novaSessao();
        const respostas = await Promise.all([service.criarPedido(sessao, dados, randomUUID()), service.criarPedido(sessao, dados, randomUUID())]);
        assert.notEqual(respostas[0].publicId, respostas[1].publicId);
    });
    await t.test('falha no segundo item reverte pedido e primeiro item', async () => {
        const sessao = await novaSessao(); const chave = randomUUID();
        const adaptado = poolAdaptado(c => ({ ...c, async query(sql, params) {
            if (sql.startsWith('INSERT INTO ist_loja_pedido_itens') && params[2] === 2) throw new Error('falha fixture');
            return c.query(sql, params);
        } }));
        await assert.rejects(criarLojaPedidoService({ db: adaptado }).criarPedido(sessao, dados, chave), { codigo: 'ERRO_INTERNO' });
        assert.equal(await contar(sessao, chave), 0);
        assert.equal((await service.criarPedido(sessao, dados, chave)).totalCentavos, 19000);
    });
    await t.test('COMMIT real confirmado no servidor mas confirmação perdida é reconciliado', async () => {
        const sessao = await novaSessao(); const chave = randomUUID(); let falhou = false;
        const adaptado = poolAdaptado(c => ({ ...c, async commit() {
            await c.commit();
            if (!falhou) { falhou = true; throw Object.assign(new Error('confirmação perdida'), { code: 'ECONNRESET' }); }
        } }));
        const r = await criarLojaPedidoService({ db: adaptado }).criarPedido(sessao, dados, chave);
        assert.equal(r.totalCentavos, 19000); assert.equal(await contar(sessao, chave), 1);
    });
    await t.test('COMMIT não enviado é indeterminado sem recriação automática', async () => {
        const sessao = await novaSessao(); const chave = randomUUID(); let falhou = false;
        const adaptado = poolAdaptado(c => ({ ...c, async commit() {
            if (!falhou) { falhou = true; throw Object.assign(new Error('sem confirmação'), { code: 'ECONNRESET' }); }
            return c.commit();
        } }));
        await assert.rejects(criarLojaPedidoService({ db: adaptado }).criarPedido(sessao, dados, chave), { codigo: 'CONTENCAO_TEMPORARIA' });
        assert.equal(await contar(sessao, chave), 0);
    });
    await t.test('colisão real de public_id não é confundida com idempotência', async () => {
        const sessao = await novaSessao(); const existente = await service.criarPedido(sessao, dados, randomUUID());
        const chave = randomUUID();
        await assert.rejects(criarLojaPedidoService({ db, gerarUuid: () => existente.publicId }).criarPedido(sessao, dados, chave), { codigo: 'ERRO_INTERNO' });
        assert.equal(await contar(sessao, chave), 0);
    });
    await t.test('lock wait timeout real provoca rollback e retentativa com a mesma chave', async () => {
        const sessao = await novaSessao(); const chave = randomUUID();
        const bloqueador = await db.getConnection(); let liberado = false; let timeouts = 0;
        try {
            await bloqueador.beginTransaction();
            await bloqueador.query('SELECT id FROM ist_loja_sessoes WHERE id=? FOR UPDATE', [sessao.id]);
            const adaptado = poolAdaptado(async c => {
                await c.query('SET SESSION innodb_lock_wait_timeout = 1');
                return { ...c, async query(sql, params) {
                    try { return await c.query(sql, params); }
                    catch (erro) {
                        if (erro.code === 'ER_LOCK_WAIT_TIMEOUT') {
                            timeouts++;
                            if (!liberado) { await bloqueador.rollback(); liberado = true; }
                        }
                        throw erro;
                    }
                } };
            });
            const r = await criarLojaPedidoService({ db: adaptado }).criarPedido(sessao, dados, chave);
            assert.equal(timeouts, 1); assert.equal(r.totalCentavos, 19000); assert.equal(await contar(sessao, chave), 1);
        } finally { if (!liberado) await bloqueador.rollback(); bloqueador.release(); }
    });
});
