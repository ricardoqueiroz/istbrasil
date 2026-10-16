import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import net from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';

// Opt-in. Nao importa o pool da aplicacao, dotenv ou credenciais DB_*.
// O proprio teste inicializa e encerra outro processo, sem instalar servico.
const bin = process.env.IST_LOJA_PAGAMENTOS_MARIADB_BIN;
const novas = ['ist_loja_pagamentos', 'ist_loja_pagamento_operacoes', 'ist_loja_pagamento_eventos'];
const fundacao = ['ist_loja_sessoes', 'ist_loja_pedidos', 'ist_loja_pedido_itens'];
const criado = '2026-10-16 12:00:00.123';
const expira = '2026-10-16 12:30:00.123';
const dataSql = new URL('../migrations/ist_loja_pagamentos_fundacao.sql', import.meta.url);
const erro = codigo => e => e.code === codigo || e.errno === codigo;
const check = erro(4025);
const duplicado = erro('ER_DUP_ENTRY');
const fk = erro('ER_NO_REFERENCED_ROW_2');
const pausa = ms => new Promise(r => setTimeout(r, ms));

async function executar(exe, args) {
    const p = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let saida = '';
    p.stdout.on('data', b => { saida += b; });
    p.stderr.on('data', b => { saida += b; });
    const [code] = await once(p, 'exit');
    assert.equal(code, 0, saida);
    return saida.trim();
}

async function portaLivre() {
    const s = net.createServer();
    s.listen(0, '127.0.0.1');
    await once(s, 'listening');
    const port = s.address().port;
    await new Promise((r, j) => s.close(e => e ? j(e) : r()));
    assert.ok(port > 1024 && ![3306, 3307].includes(port));
    return port;
}

async function inserir(c, tabela, campos) {
    assert.match(tabela, /^ist_(loja_[a-z_]+|livros)$/);
    const nomes = Object.keys(campos);
    nomes.forEach(n => assert.match(n, /^[a-z_]+$/));
    const [r] = await c.query(`INSERT INTO ${tabela} (${nomes.join(',')}) VALUES (${nomes.map(() => '?').join(',')})`, Object.values(campos));
    return r.insertId;
}

test('fundacao de pagamentos em processo MariaDB descartavel', { skip: !bin, timeout: 180000 }, async t => {
    const temp = await realpath(tmpdir());
    const datadir = await mkdtemp(join(temp, 'ist-loja-67-3-'));
    const port = await portaLivre();
    let servidor, admin, pool;
    let identidadeConfirmada = false;
    let logServidor = '';
    t.after(async () => {
        if (pool) await pool.end();
        if (admin) {
            if (identidadeConfirmada) {
                try { await admin.query('SHUTDOWN'); } catch { /* Servidor pode ter encerrado a conexao. */ }
            }
            try { await admin.end(); } catch { /* Conexao ja encerrada. */ }
        }
        if (servidor && servidor.exitCode === null && servidor.signalCode === null) {
            const encerrado = once(servidor, 'exit');
            const timeout = setTimeout(() => servidor.kill(), 5000);
            await encerrado;
            clearTimeout(timeout);
        }
        // Validar o caminho absoluto real antes da remocao recursiva em Windows.
        const alvo = await realpath(datadir);
        assert.equal(dirname(alvo).toLowerCase(), temp.toLowerCase());
        assert.match(basename(alvo), /^ist-loja-67-3-[a-z0-9]+$/i);
        assert.equal(alvo.toLowerCase(), resolve(datadir).toLowerCase());
        await rm(alvo, { recursive: true });
        t.diagnostic('Processo temporario encerrado; datadir descartavel removido.');
    });

    await executar(join(bin, 'mariadb-install-db.exe'), [`--datadir=${datadir}`, `--port=${port}`, '--silent']);
    servidor = spawn(join(bin, 'mariadbd.exe'), [
        '--no-defaults', `--datadir=${datadir}`, `--port=${port}`, '--bind-address=127.0.0.1',
        '--skip-name-resolve', '--console', '--character-set-server=utf8mb4', '--collation-server=utf8mb4_unicode_ci'
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    servidor.stdout.on('data', b => { logServidor += b; });
    servidor.stderr.on('data', b => { logServidor += b; });
    const conexao = { host: '127.0.0.1', port, user: 'root', password: '', connectTimeout: 1000,
        dateStrings: true, supportBigNumbers: true, bigNumberStrings: true };
    for (let i = 0; i < 100; i++) {
        if (servidor.exitCode !== null) assert.fail(logServidor);
        try { admin = await mysql.createConnection(conexao); break; }
        catch { await pausa(100); }
    }
    assert.ok(admin, logServidor);
    const [[identidade]] = await admin.query('SELECT @@datadir AS datadir, @@port AS porta, VERSION() AS versao');
    assert.equal((await realpath(identidade.datadir)).toLowerCase(), datadir.toLowerCase());
    assert.equal(Number(identidade.porta), port);
    assert.match(identidade.versao, /MariaDB/);
    identidadeConfirmada = true;
    t.diagnostic(`Servidor efetivamente usado: ${identidade.versao}; 127.0.0.1:${port}; datadir TEMP confirmado.`);
    t.diagnostic(/^10\.3\.39-MariaDB/.test(identidade.versao)
        ? 'Execucao real em MariaDB 10.3.39.' : 'NAO comprova MariaDB 10.3.39: versao diferente.');

    const banco = `ist_loja_67_3_${randomBytes(6).toString('hex')}`;
    await admin.query(`CREATE DATABASE ${banco} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    await admin.query(`USE ${banco}`);
    await admin.query("SET SESSION sql_mode = 'STRICT_TRANS_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION'");
    // Fixture minima da dependencia do catalogo. As tres tabelas preservadas
    // abaixo usam os CREATE TABLE reais da migration versionada, sem adaptacao.
    await admin.query('CREATE TABLE ist_livros (id INT PRIMARY KEY) ENGINE=InnoDB');
    const ddlBase = [];
    for (const nome of ['ist_loja_catalogo.sql', 'ist_loja_pedidos_fundacao.sql']) {
        const fonte = await readFile(new URL(`../migrations/${nome}`, import.meta.url), 'utf8');
        const ddl = fonte.match(/CREATE TABLE [\s\S]*?\) ENGINE=InnoDB[^;]*;/g);
        assert.equal(ddl.length, nome.includes('catalogo') ? 2 : 3);
        for (const sql of ddl) { ddlBase.push(sql); await admin.query(sql); }
    }
    await admin.query('INSERT INTO ist_livros VALUES (1)');
    await admin.query("INSERT INTO ist_loja_categorias (id,nome,slug) VALUES (1,'Fixture','fixture')");
    await admin.query("INSERT INTO ist_loja_produtos (id,categoria_id,livro_id,sku) VALUES (1,1,1,'FIXTURE')");
    const sessaoId = await inserir(admin, 'ist_loja_sessoes', {
        token_hash: randomBytes(32), criada_em: criado, expira_em: expira
    });
    const novoPedido = () => inserir(admin, 'ist_loja_pedidos', {
        public_id: randomUUID(), sessao_id: sessaoId, comprador_email: 'fixture@example.invalid',
        estado: 'CRIADO', ambiente: 'sandbox', moeda: 'BRL', total_centavos: 19000,
        idempotencia_criacao: randomUUID(), solicitacao_hash: randomBytes(32),
        criado_em: criado, atualizado_em: criado, expira_em: expira
    });
    const pedidoId = await novoPedido();
    await inserir(admin, 'ist_loja_pedido_itens', {
        pedido_id: pedidoId, produto_id: 1, posicao: 1, sku_snapshot: 'FIXTURE', titulo_snapshot: 'Livro fixture',
        tipo_snapshot: 'E-Book', quantidade: 1, preco_unitario_centavos: 19000, subtotal_centavos: 19000
    });
    const retrato = async (dados = true) => {
        const r = {};
        for (const tabela of fundacao) {
            const [[ddl]] = await admin.query(`SHOW CREATE TABLE ${tabela}`);
            r[tabela] = { ddl: ddl['Create Table'].replace(/AUTO_INCREMENT=\d+\s/g, '') };
            if (dados) [r[tabela].dados] = await admin.query(`SELECT * FROM ${tabela} ORDER BY id`);
        }
        return r;
    };
    const antes = await retrato();
    const sqlCliente = await readFile(dataSql, 'utf8');
    const sqlMigration = sqlCliente.replace(/^DELIMITER[^\r\n]*$/gm, '').replace(/END\$\$\s*$/, 'END');
    assert.ok(!sqlMigration.includes('$$'));
    assert.equal((sqlMigration.match(/CREATE TABLE /g) ?? []).length, 3);
    // Executa o bloco completo, incluindo TODAS as pre-condicoes; nao extrai so CREATEs.
    await admin.query(sqlMigration);
    pool = mysql.createPool({ ...conexao, database: banco, connectionLimit: 4 });
    const pagamento = (p = pedidoId, extra = {}) => ({ public_id: randomUUID(), pedido_id: p, provedor: 'fixture',
        ambiente: 'sandbox', conta_recebedora: 'recebedor-fixture', estado: 'CRIANDO', reserva_ativa: 1,
        moeda: 'BRL', valor_centavos: 19000, criado_em: criado, atualizado_em: criado, expira_em: expira, ...extra });
    const encerrado = (p = pedidoId, extra = {}) => pagamento(p, { estado: 'RECUSADO', reserva_ativa: null, encerrado_em: criado, ...extra });
    const operacao = (pg, p, extra = {}) => ({ pagamento_id: pg, pedido_id: p, acao: 'CRIAR', chave_idempotencia: randomUUID(),
        solicitacao_hash: randomBytes(32), request_id_provedor: randomUUID(), estado: 'PREPARADA', criado_em: criado, atualizado_em: criado, ...extra });
    const evento = (pg = null, extra = {}) => ({ pagamento_id: pg, provedor: 'fixture', ambiente: 'sandbox',
        conta_recebedora: 'recebedor-fixture', origem: 'WEBHOOK', evento_id: randomUUID(), tipo: 'CAPTURA_FIXTURE',
        conteudo_hash: randomBytes(32), evidencia_json: '{"status":"fixture"}', estado: 'RECEBIDO',
        recebido_em: criado, autenticado_em: criado, atualizado_em: criado, ...extra });
    const pg = campos => inserir(admin, novas[0], campos);
    const op = campos => inserir(admin, novas[1], campos);
    const ev = campos => inserir(admin, novas[2], campos);

    await t.test('migration preserva SHOW CREATE e todos os registros das tres tabelas existentes', async () => {
        assert.deepEqual(await retrato(), antes);
    });
    await t.test('tres tabelas InnoDB/DYNAMIC/utf8mb4; FKs e indices reais', async () => {
        const [tabelas] = await admin.query('SELECT TABLE_NAME, ENGINE, ROW_FORMAT, TABLE_COLLATION FROM information_schema.tables WHERE table_schema=? AND TABLE_NAME IN (?,?,?)', [banco, ...novas]);
        assert.equal(tabelas.length, 3);
        for (const r of tabelas) { assert.equal(r.ENGINE, 'InnoDB'); assert.equal(r.ROW_FORMAT, 'Dynamic'); assert.equal(r.TABLE_COLLATION, 'utf8mb4_unicode_ci'); }
        for (const tabela of novas) {
            const [[ddl]] = await admin.query(`SHOW CREATE TABLE ${tabela}`);
            assert.match(ddl['Create Table'], /FOREIGN KEY/);
            assert.match(ddl['Create Table'], /CHECK/);
            const [indices] = await admin.query(`SHOW INDEX FROM ${tabela}`);
            assert.ok(indices.some(i => i.Key_name === 'PRIMARY'));
        }
        const [r] = await admin.query('SELECT INDEX_NAME, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS campos FROM information_schema.statistics WHERE table_schema=? AND table_name=? AND NON_UNIQUE=0 GROUP BY INDEX_NAME', [banco, novas[0]]);
        assert.equal(r.find(i => i.INDEX_NAME === 'uq_lpg_reserva').campos, 'pedido_id,reserva_ativa');
    });
    await t.test('reexecucao rejeitada antes de alterar qualquer estrutura', async () => {
        await assert.rejects(admin.query(sqlMigration), e => e.sqlState === '45000' && /nao repetir/.test(e.sqlMessage));
        assert.deepEqual(await retrato(), antes);
    });
    await t.test('preflight rejeita CHECKs desligados', async () => {
        // Antes do teste, a existencia das tabelas nao pode mascarar essa guarda.
        await admin.query('SET SESSION check_constraint_checks=0');
        try { await assert.rejects(admin.query(sqlMigration), e => e.sqlState === '45000' && /CHECKs/.test(e.sqlMessage)); }
        finally { await admin.query('SET SESSION check_constraint_checks=1'); }
    });
    await t.test('preflight rejeita FKs desligadas', async () => {
        await admin.query('SET SESSION foreign_key_checks=0');
        try { await assert.rejects(admin.query(sqlMigration), e => e.sqlState === '45000' && /FKs/.test(e.sqlMessage)); }
        finally { await admin.query('SET SESSION foreign_key_checks=1'); }
    });
    await t.test('preflight rejeita modo nao estrito', async () => {
        const [[original]] = await admin.query('SELECT @@sql_mode AS modo');
        await admin.query("SET SESSION sql_mode='NO_ENGINE_SUBSTITUTION'");
        try { await assert.rejects(admin.query(sqlMigration), e => e.sqlState === '45000' && /estrito/.test(e.sqlMessage)); }
        finally { await admin.query('SET SESSION sql_mode=?', [original.modo]); }
    });
    await t.test('preflight rejeita transacao aberta e autocommit desabilitado', async () => {
        await admin.beginTransaction();
        try { await assert.rejects(admin.query(sqlMigration), e => e.sqlState === '45000' && /transacao/.test(e.sqlMessage)); }
        finally { await admin.rollback(); }
        await admin.query('SET autocommit=0');
        try { await assert.rejects(admin.query(sqlMigration), e => e.sqlState === '45000' && /autocommit/.test(e.sqlMessage)); }
        finally { await admin.rollback(); await admin.query('SET autocommit=1'); }
    });
    for (const cenario of ['campo divergente', 'fundacao ausente', 'DDL parcial']) {
        await t.test(`preflight aborta sem criar tabelas: ${cenario}`, async () => {
            const outro = `ist_loja_67_3_${randomBytes(6).toString('hex')}`;
            await admin.query(`CREATE DATABASE ${outro} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
            await admin.query(`USE ${outro}`);
            try {
                if (cenario !== 'fundacao ausente') {
                    await admin.query('CREATE TABLE ist_livros (id INT PRIMARY KEY) ENGINE=InnoDB');
                    for (const ddl of ddlBase) await admin.query(cenario === 'campo divergente'
                        ? ddl.replace('total_centavos BIGINT UNSIGNED', 'total_centavos BIGINT') : ddl);
                }
                if (cenario === 'DDL parcial') await admin.query('CREATE TABLE ist_loja_pagamentos (id INT PRIMARY KEY) ENGINE=InnoDB');
                await assert.rejects(admin.query(sqlMigration), e => e.sqlState === '45000'
                    && (cenario === 'campo divergente' ? /Campos/.test(e.sqlMessage)
                        : cenario === 'fundacao ausente' ? /incompleta/.test(e.sqlMessage) : /nao repetir/.test(e.sqlMessage)));
                const [[r]] = await admin.query('SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema=? AND table_name IN (?,?,?)', [outro, ...novas]);
                assert.equal(Number(r.n), cenario === 'DDL parcial' ? 1 : 0);
            } finally { await admin.query(`USE ${banco}`); }
        });
    }
    await t.test('FK rejeita pedido inexistente', async () => {
        await assert.rejects(pg(pagamento(4294967295)), fk);
    });
    await t.test('UNIQUE permite varios encerrados NULL e uma reserva 1', async () => {
        await pg(encerrado()); await pg(encerrado());
        await pg(pagamento());
        await assert.rejects(pg(pagamento()), duplicado);
    });
    for (const campos of [{ reserva_ativa: null }, { reserva_ativa: 0 }, { reserva_ativa: 2 },
        { reserva_ativa: 1, encerrado_em: criado }, { reserva_ativa: null, encerrado_em: null, estado: 'RECUSADO' }]) {
        await t.test(`CHECK reserva nao aceita brecha NULL: ${JSON.stringify(campos)}`, async () => {
            await assert.rejects(pg(pagamento(await novoPedido(), campos)), check);
        });
    }
    for (const estado of ['CRIANDO', 'AGUARDANDO_APROVACAO', 'APROVADO', 'CAPTURANDO', 'PENDENTE', 'DESCONHECIDO']) {
        await t.test(`estado ${estado} nao pode liberar reserva`, async () => {
            const p = await novoPedido(); const id = await pg(pagamento(p, { estado }));
            await assert.rejects(admin.query(`UPDATE ${novas[0]} SET reserva_ativa=NULL, encerrado_em=? WHERE id=?`, [criado, id]), check);
            const [[r]] = await admin.query(`SELECT estado,reserva_ativa FROM ${novas[0]} WHERE id=?`, [id]);
            assert.equal(r.estado, estado); assert.equal(r.reserva_ativa, 1);
        });
    }
    for (const campos of [{ estado: 'invalido' }, { ambiente: 'SANDBOX' }, { moeda: 'USD' },
        { valor_centavos: 0 }, { valor_centavos: '9007199254740992' }, { reembolsado_centavos: 1 },
        { versao: 0 }, { expira_em: criado }, { atualizado_em: '2020-01-01 00:00:00.000' },
        { provedor: '' }, { conta_recebedora: '' }, { ordem_externa_id: '' }]) {
        await t.test(`CHECK pagamento ${Object.keys(campos).join(',')}`, async () => {
            await assert.rejects(pg(encerrado(pedidoId, campos)), check);
        });
    }
    await t.test('IDs externos unicos por provedor/ambiente/conta, aceitando NULLs', async () => {
        const campos = encerrado(pedidoId, { ordem_externa_id: 'ordem-1', captura_externa_id: 'captura-1' });
        await pg(campos);
        await assert.rejects(pg({ ...campos, public_id: randomUUID(), captura_externa_id: 'outra' }), duplicado);
        await assert.rejects(pg({ ...campos, public_id: randomUUID(), ordem_externa_id: 'outra' }), duplicado);
        for (const extra of [{ provedor: 'outro' }, { ambiente: 'live' }, { conta_recebedora: 'outro' }]) await pg({ ...campos, ...extra, public_id: randomUUID() });
    });
    await t.test('public_id unico', async () => {
        const campos = encerrado(); await pg(campos); await assert.rejects(pg(campos), duplicado);
    });
    await t.test('centavos exatos, sem conversao por timezone da conexao', async () => {
        await admin.query("SET SESSION time_zone='+09:00'");
        try {
            const id = await pg(encerrado(pedidoId, { valor_centavos: '9007199254740991' }));
            const [[r]] = await admin.query(`SELECT valor_centavos, DATE_FORMAT(criado_em,'%Y-%m-%d %H:%i:%s.%f') AS utc FROM ${novas[0]} WHERE id=?`, [id]);
            assert.equal(r.valor_centavos, '9007199254740991'); assert.equal(r.utc, '2026-10-16 12:00:00.123000');
        } finally { await admin.query("SET SESSION time_zone='+00:00'"); }
    });
    await t.test('captura tardia e valor divergente podem ser registrados sem perder evidencia', async () => {
        const id = await pg(encerrado(pedidoId, { estado: 'REVISAO', ordem_externa_id: randomUUID(), captura_externa_id: randomUUID(),
            capturado_centavos: 20000, capturado_em: '2026-10-17 00:00:00.000' }));
        await ev(evento(id, { origem: 'RECONCILIACAO' }));
    });
    await t.test('FK composta de operacao rejeita outro pedido e pagamento inexistente', async () => {
        const id = await pg(encerrado());
        await assert.rejects(op(operacao(id, await novoPedido())), fk);
        await assert.rejects(op(operacao(4294967295, pedidoId)), fk);
    });
    await t.test('idempotencia, acao por tentativa e request_id possuem unicidades distintas', async () => {
        const a = await pg(encerrado()); const b = await pg(encerrado());
        const campos = operacao(a, pedidoId); await op(campos);
        await assert.rejects(op({ ...campos, pagamento_id: b, request_id_provedor: randomUUID() }), duplicado);
        await assert.rejects(op({ ...campos, chave_idempotencia: randomUUID(), request_id_provedor: randomUUID() }), duplicado);
        await assert.rejects(op({ ...campos, pagamento_id: b, chave_idempotencia: randomUUID() }), duplicado);
        await op(operacao(a, pedidoId, { acao: 'CAPTURAR' }));
    });
    for (const campos of [{ acao: 'PAGAR' }, { estado: 'invalido' }, { estado: 'EM_EXECUCAO' },
        { execucao_token: randomBytes(16) }, { execucao_ate: expira }, { versao: 0 },
        { resultado_json: '{invalido' }, { resultado_json: JSON.stringify({ texto: 'x'.repeat(16384) }) },
        { request_id_provedor: '' }]) {
        await t.test(`CHECK operacao ${Object.keys(campos).join(',')}`, async () => {
            await assert.rejects(op(operacao(await pg(encerrado()), pedidoId, campos)), check);
        });
    }
    await t.test('execucao valida e operacao desconhecida permanecem persistidas', async () => {
        const id = await op(operacao(await pg(encerrado()), pedidoId, { estado: 'EM_EXECUCAO', execucao_token: randomBytes(16), execucao_ate: expira }));
        await admin.query(`UPDATE ${novas[1]} SET estado='DESCONHECIDA', execucao_token=NULL, execucao_ate=NULL WHERE id=?`, [id]);
        const [[r]] = await admin.query(`SELECT estado,request_id_provedor FROM ${novas[1]} WHERE id=?`, [id]);
        assert.equal(r.estado, 'DESCONHECIDA'); assert.equal(r.request_id_provedor.length, 36);
    });
    await t.test('evento sem associacao e FK composta impedindo contexto trocado', async () => {
        await ev(evento());
        const id = await pg(encerrado()); await ev(evento(id));
        for (const campos of [{ ambiente: 'live' }, { provedor: 'outro' }, { conta_recebedora: 'outra' }]) await assert.rejects(ev(evento(id, campos)), fk);
    });
    await t.test('evento deduplicado no contexto; diferentes origens/contas independentes', async () => {
        const campos = evento(); await ev(campos); await assert.rejects(ev(campos), duplicado);
        for (const extra of [{ origem: 'API' }, { ambiente: 'live' }, { provedor: 'outro' }, { conta_recebedora: 'outra' }]) await ev({ ...campos, ...extra });
    });
    for (const campos of [{ ambiente: 'invalid' }, { origem: 'CLIENTE' }, { estado: 'PROCESSANDO' },
        { execucao_token: randomBytes(16) }, { execucao_ate: expira }, { evidencia_json: 'invalido' },
        { evidencia_json: JSON.stringify({ texto: 'x'.repeat(16384) }) }, { evento_id: '' },
        { autenticado_em: '2020-01-01 00:00:00.000' }, { atualizado_em: '2020-01-01 00:00:00.000' }]) {
        await t.test(`CHECK evento ${Object.keys(campos).join(',')}`, async () => { await assert.rejects(ev(evento(null, campos)), check); });
    }
    await t.test('evento PROCESSANDO exige lease completa e valida', async () => {
        await ev(evento(null, { estado: 'PROCESSANDO', execucao_token: randomBytes(16), execucao_ate: expira }));
    });
    await t.test('RESTRICT impede exclusao dos pais com dependencias', async () => {
        const id = await pg(encerrado()); await op(operacao(id, pedidoId));
        await assert.rejects(admin.query(`DELETE FROM ${novas[0]} WHERE id=?`, [id]), erro('ER_ROW_IS_REFERENCED_2'));
        await assert.rejects(admin.query('DELETE FROM ist_loja_pedidos WHERE id=?', [pedidoId]), erro('ER_ROW_IS_REFERENCED_2'));
    });

    await t.test('concorrencia real: mesmo pedido permite somente uma reserva', async () => {
        const p = await novoPedido(); const a = await pool.getConnection(); const b = await pool.getConnection();
        try {
            assert.notEqual(a.threadId, b.threadId);
            await a.beginTransaction(); await b.beginTransaction();
            await inserir(a, novas[0], pagamento(p));
            // O segundo INSERT precisa aguardar a primeira transacao real.
            const pendente = inserir(b, novas[0], pagamento(p)).then(() => 'inseriu', e => e);
            assert.equal(await Promise.race([pendente, pausa(100).then(() => 'aguardou')]), 'aguardou');
            await a.commit(); const conflito = await pendente;
            assert.equal(conflito.code, 'ER_DUP_ENTRY'); await b.rollback();
            const [[r]] = await admin.query(`SELECT COUNT(*) AS n FROM ${novas[0]} WHERE pedido_id=? AND reserva_ativa=1`, [p]);
            assert.equal(Number(r.n), 1);
        } finally { await a.rollback(); await b.rollback(); a.release(); b.release(); }
    });
    await t.test('rollback da primeira reserva permite a segunda conexao concluir', async () => {
        const p = await novoPedido(); const a = await pool.getConnection(); const b = await pool.getConnection();
        try {
            await a.beginTransaction(); await b.beginTransaction();
            await inserir(a, novas[0], pagamento(p));
            const pendente = inserir(b, novas[0], pagamento(p));
            await a.rollback(); await pendente; await b.commit();
            const [[r]] = await admin.query(`SELECT COUNT(*) AS n FROM ${novas[0]} WHERE pedido_id=?`, [p]); assert.equal(Number(r.n), 1);
        } finally { await a.rollback(); await b.rollback(); a.release(); b.release(); }
    });
    await t.test('protocolo FOR UPDATE serializa concorrentes antes da criacao', async () => {
        const p = await novoPedido(); const a = await pool.getConnection(); const b = await pool.getConnection();
        try {
            await a.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
            await b.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
            await a.beginTransaction(); await b.beginTransaction();
            await a.query('SELECT id FROM ist_loja_pedidos WHERE id=? FOR UPDATE', [p]);
            const espera = b.query('SELECT id FROM ist_loja_pedidos WHERE id=? FOR UPDATE', [p]);
            assert.equal(await Promise.race([espera.then(() => 'livre'), pausa(100).then(() => 'aguardou')]), 'aguardou');
            const id = await inserir(a, novas[0], pagamento(p)); await a.commit();
            await espera;
            const [[r]] = await b.query(`SELECT id FROM ${novas[0]} WHERE pedido_id=? AND reserva_ativa=1`, [p]);
            assert.equal(r.id, id); await b.commit();
        } finally { await a.rollback(); await b.rollback(); a.release(); b.release(); }
    });
    await t.test('conflito de operacao e rollback nao deixam pagamento parcial', async () => {
        const p = await novoPedido(); const c = await pool.getConnection(); let id;
        try {
            await c.beginTransaction(); id = await inserir(c, novas[0], pagamento(p));
            const campos = operacao(id, p); await inserir(c, novas[1], campos);
            await assert.rejects(inserir(c, novas[1], { ...campos, request_id_provedor: randomUUID() }), duplicado);
            await c.rollback();
            const [[r]] = await admin.query(`SELECT COUNT(*) AS n FROM ${novas[0]} WHERE id=?`, [id]); assert.equal(Number(r.n), 0);
            const [[s]] = await admin.query(`SELECT COUNT(*) AS n FROM ${novas[1]} WHERE pagamento_id=?`, [id]); assert.equal(Number(s.n), 0);
        } finally { await c.rollback(); c.release(); }
    });
    await t.test('schemas da fundacao continuam intactos apos os testes', async () => {
        const depois = await retrato(false);
        for (const tabela of fundacao) assert.equal(depois[tabela].ddl, antes[tabela].ddl);
    });
});
