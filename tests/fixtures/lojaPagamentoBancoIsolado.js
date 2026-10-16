import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';
import net from 'node:net';
import mysql from 'mysql2/promise';

// Instancia propria: nao importa dotenv, pool da aplicacao nem credenciais reais.
export const criarBancoPagamentoIsolado = async t => {
    const bin = process.env.IST_LOJA_PAGAMENTOS_MARIADB_BIN;
    assert.ok(bin);
    const temp = await realpath(tmpdir());
    const datadir = await mkdtemp(join(temp, 'ist-loja-67-4-'));
    let processo, admin, pool, verificado = false;
    const listener = net.createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
    const port = listener.address().port;
    await new Promise((r, j) => listener.close(e => e ? j(e) : r()));
    assert.ok(port > 1024 && ![3306, 3307].includes(port));
    t.after(async () => {
        if (pool) await pool.end();
        if (admin) {
            if (verificado) { try { await admin.query('SHUTDOWN'); } catch {} }
            try { await admin.end(); } catch {}
        }
        if (processo?.pid && processo.exitCode === null && processo.signalCode === null) {
            const fim = once(processo, 'exit'); const timer = setTimeout(() => processo.kill(), 5000);
            await fim; clearTimeout(timer);
        }
        const alvo = await realpath(datadir);
        assert.equal(dirname(alvo).toLowerCase(), temp.toLowerCase());
        assert.equal(alvo.toLowerCase(), resolve(datadir).toLowerCase());
        assert.match(basename(alvo), /^ist-loja-67-4-[a-z0-9]+$/i);
        await rm(alvo, { recursive: true });
        t.diagnostic('Processo 67.4 encerrado e datadir descartavel removido.');
    });
    const instalador = spawn(join(bin, 'mariadb-install-db.exe'), [`--datadir=${datadir}`, `--port=${port}`, '--silent'],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; instalador.stdout.on('data', b => { log += b; }); instalador.stderr.on('data', b => { log += b; });
    assert.equal((await once(instalador, 'exit'))[0], 0, log);
    processo = spawn(join(bin, 'mariadbd.exe'), ['--no-defaults', `--datadir=${datadir}`, `--port=${port}`,
        '--bind-address=127.0.0.1', '--skip-name-resolve', '--console'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    processo.stdout.on('data', b => { log += b; }); processo.stderr.on('data', b => { log += b; });
    const config = { host: '127.0.0.1', port, user: 'root', password: '', connectTimeout: 1000,
        supportBigNumbers: true, bigNumberStrings: true, dateStrings: true };
    for (let i = 0; i < 100; i++) {
        assert.equal(processo.exitCode, null, log);
        try { admin = await mysql.createConnection(config); break; }
        catch { await new Promise(r => setTimeout(r, 100)); }
    }
    assert.ok(admin, log);
    const [[identidade]] = await admin.query('SELECT @@datadir AS datadir, @@port AS porta, VERSION() AS versao');
    assert.equal((await realpath(identidade.datadir)).toLowerCase(), datadir.toLowerCase());
    assert.equal(Number(identidade.porta), port); assert.match(identidade.versao, /MariaDB/); verificado = true;
    t.diagnostic(`MariaDB isolado: ${identidade.versao}; 127.0.0.1:${port}; TEMP confirmado.`);
    // Prefixo ja permitido pela migration 67.3 imutavel; instancia/datadir sao 67.4.
    const banco = `ist_loja_67_3_${randomBytes(6).toString('hex')}`;
    await admin.query(`CREATE DATABASE ${banco} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    await admin.query(`USE ${banco}`);
    await admin.query('CREATE TABLE ist_livros (id INT PRIMARY KEY) ENGINE=InnoDB');
    for (const nome of ['ist_loja_catalogo.sql', 'ist_loja_pedidos_fundacao.sql']) {
        const sql = await readFile(new URL(`../../migrations/${nome}`, import.meta.url), 'utf8');
        for (const ddl of sql.match(/CREATE TABLE [\s\S]*?\) ENGINE=InnoDB[^;]*;/g)) await admin.query(ddl);
    }
    const sql = await readFile(new URL('../../migrations/ist_loja_pagamentos_fundacao.sql', import.meta.url), 'utf8');
    await admin.query(sql.replace(/^DELIMITER[^\r\n]*$/gm, '').replace(/END\$\$\s*$/, 'END'));
    pool = mysql.createPool({ ...config, database: banco, connectionLimit: 8 });
    const novaCompra = async (opcoes = {}) => {
        const agora = new Date(); const criado = new Date(agora.getTime() - 1000).toISOString().slice(0, 23).replace('T', ' ');
        const sessaoExpira = new Date(agora.getTime() + 86400000 - 2000).toISOString().slice(0, 23).replace('T', ' ');
        const pedidoExpira = new Date(agora.getTime() + (opcoes.expirado ? -100 : 1800000)).toISOString().slice(0, 23).replace('T', ' ');
        const [s] = await admin.query('INSERT INTO ist_loja_sessoes (token_hash,criada_em,expira_em) VALUES (?,?,?)', [randomBytes(32), criado, sessaoExpira]);
        const publicId = randomUUID();
        const [p] = await admin.query(`INSERT INTO ist_loja_pedidos (public_id,sessao_id,comprador_email,estado,ambiente,moeda,total_centavos,
            idempotencia_criacao,solicitacao_hash,criado_em,atualizado_em,expira_em) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [publicId, s.insertId, 'fixture@example.invalid', opcoes.estado ?? 'CRIADO', opcoes.ambiente ?? 'sandbox', 'BRL', 19000,
            randomUUID(), randomBytes(32), criado, criado, pedidoExpira]);
        return { sessao: { id: s.insertId }, pedidoPublicId: publicId, pedidoId: p.insertId };
    };
    return { admin, pool, novaCompra, versao: identidade.versao };
};
