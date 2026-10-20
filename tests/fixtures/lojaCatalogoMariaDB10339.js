import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';

// Exclusivo do executor WSL revisado. Nao importa dotenv/configuracao da aplicacao.
export const criarBancoPagamentoIsolado = async t => {
    const caminho = process.env.IST_R2_10339_MANIFEST;
    assert.equal(caminho, '/home/ist_user/.local/state/ist-r2-mariadb10339/manifest.json');
    const lerWSL = p => execFileSync('wsl.exe', ['-d', 'Ubuntu', '-u', 'ist_user', '--exec', 'cat', p],
        { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const manifest = JSON.parse(lerWSL(caminho));
    assert.equal(manifest.containerName, 'ist-r2-mariadb10339');
    assert.equal(manifest.imageDigest, 'sha256:a4b57b620852e26f2c306c79fd8a61e22c7cd6e55d0a55d5521854ed2c370102');
    assert.match(manifest.containerId, /^[0-9a-f]{64}$/);
    assert.match(manifest.runId, /^[0-9a-f-]{36}$/);
    assert.equal(manifest.volume, 'ist-r2-mariadb10339-data');
    assert.equal(manifest.host, '127.0.0.1');
    assert.equal(manifest.port, 13339);
    assert.match(manifest.schema, /^ist_loja_67_3_[0-9a-f]{12}$/);
    const password = lerWSL('/home/ist_user/.local/state/ist-r2-mariadb10339/root-password').trim();
    assert.match(password, /^[0-9a-f]{64}$/);
    const config = { host: '127.0.0.1', port: 13339, user: 'root', password,
        supportBigNumbers: true, bigNumberStrings: true, dateStrings: true, connectTimeout: 1000 };
    let admin;
    for (let i = 0; i < 60; i++) {
        try { admin = await mysql.createConnection(config); break; }
        catch { await new Promise(r => setTimeout(r, 1000)); }
    }
    assert.ok(admin, 'Instancia 10.3.39 autenticada indisponivel; sem fallback.');
    t.after(() => admin.end());
    // Identidade independente do nome/porta: hostname e o ID do container validado.
    const [[identidade]] = await admin.query(`SELECT VERSION() AS versao, @@hostname AS hostname,
        @@port AS porta, @@datadir AS datadir`);
    assert.match(identidade.versao, /^10\.3\.39-MariaDB(?:-|$)/);
    assert.equal(identidade.hostname, manifest.containerId.slice(0, 12));
    assert.equal(Number(identidade.porta), 3306); // Porta INTERNA; externa e 13339.
    assert.equal(identidade.datadir, '/var/lib/mysql/');
    // Prova efetiva compativel com 10.3: a conexao correta acima funcionou;
    // credencial incorreta deve falhar por autenticacao, nunca por rede/timeout.
    let indevida;
    try {
        await assert.rejects(async () => {
            indevida = await mysql.createConnection({ ...config, password: password + '-incorreta' });
        }, e => e?.code === 'ER_ACCESS_DENIED_ERROR',
        'Credencial incorreta nao foi rejeitada por autenticacao; interromper antes de SQL modificador.');
    } finally { await indevida?.end(); }
    t.diagnostic('Autenticacao efetiva: credencial correta aceita; incorreta rejeitada.');
    t.diagnostic(`Identidade confirmada: ${identidade.versao}; externo 127.0.0.1:13339; schema ${manifest.schema}`);
    // Nenhum SQL de criacao/carga antes de confirmar a identidade acima.
    const [[existente]] = await admin.execute('SELECT COUNT(*) AS n FROM information_schema.schemata WHERE schema_name=?', [manifest.schema]);
    assert.equal(Number(existente.n), 0, 'Schema ja existe; nao reaplicar nem reutilizar.');
    await admin.query(`CREATE DATABASE ${manifest.schema} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    await admin.query(`USE ${manifest.schema}`);
    await admin.query('CREATE TABLE ist_livros (id INT PRIMARY KEY) ENGINE=InnoDB');
    for (const nome of ['ist_loja_catalogo.sql', 'ist_loja_pedidos_fundacao.sql']) {
        const sql = await readFile(new URL(`../../migrations/${nome}`, import.meta.url), 'utf8');
        for (const ddl of sql.match(/CREATE TABLE [\s\S]*?\) ENGINE=InnoDB[^;]*;/g)) await admin.query(ddl);
    }
    const sql = await readFile(new URL('../../migrations/ist_loja_pagamentos_fundacao.sql', import.meta.url), 'utf8');
    await admin.query(sql.replace(/^DELIMITER[^\r\n]*$/gm, '').replace(/END\$\$\s*$/, 'END'));
    const novaCompra = async (opcoes = {}) => {
        const criado = '2026-01-01 00:00:00', expira = '2026-01-02 00:00:00';
        const [s] = await admin.execute('INSERT INTO ist_loja_sessoes(token_hash,criada_em,expira_em) VALUES(?,?,?)',
            [randomBytes(32), criado, expira]);
        const publicId = randomUUID();
        const [p] = await admin.execute(`INSERT INTO ist_loja_pedidos
            (public_id,sessao_id,comprador_email,estado,ambiente,moeda,total_centavos,idempotencia_criacao,
             solicitacao_hash,criado_em,atualizado_em,expira_em) VALUES(?,?,'fixture@example.invalid',?,'sandbox',
             'BRL',100,?,?,?,?,?)`, [publicId, s.insertId, opcoes.estado ?? 'CRIADO', randomUUID(),
            randomBytes(32), criado, criado, expira]);
        return { sessao: { id: s.insertId }, pedidoPublicId: publicId, pedidoId: p.insertId };
    };
    return { admin, novaCompra, versao: identidade.versao };
};
