import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, realpath, rm, lstat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import net from 'node:net';
import mysql from 'mysql2/promise';

// Instancia propria: nao importa dotenv, pool da aplicacao nem credenciais reais.
export const criarBancoPagamentoIsolado = async t => {
    const bin = process.env.IST_LOJA_PAGAMENTOS_MARIADB_BIN;
    assert.ok(bin && isAbsolute(bin), 'Diretorio absoluto MariaDB obrigatorio.');
    const basedir = dirname(await realpath(bin));
    const versaoHeader = await readFile(join(basedir, 'include/mysql/server/mysql_version.h'), 'utf8');
    assert.match(versaoHeader, /^#define MYSQL_SERVER_VERSION\s+"13\.0\.2-MariaDB"/m,
        'Bootstrap desta fixture limitado ao MariaDB 13.0.2.');
    const scripts = await Promise.all(['mariadb_system_tables.sql', 'mariadb_system_tables_data.sql']
        .map(nome => readFile(join(basedir, 'share', nome), 'utf8')));
    // Nunca herdar DB_*, PayPal, MYSQL_DEBUG ou segredos do processo de testes.
    const ambienteFilho = {};
    for (const nome of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP']) {
        if (process.env[nome]) ambienteFilho[nome] = process.env[nome];
    }
    const senha = randomBytes(32).toString('hex');
    const primeiroHash = createHash('sha1').update(senha).digest();
    const verificador = '*' + createHash('sha1').update(primeiroHash).digest('hex').toUpperCase();
    primeiroHash.fill(0);
    const temp = await realpath(tmpdir());
    const datadir = await mkdtemp(join(temp, 'ist-loja-67-4-'));
    const donoDiretorio=await lstat(datadir,{bigint:true});
    let processo, admin, pool, verificado = false;
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
        assert.ok(!processo||processo.exitCode!==null||processo.signalCode!==null,'Processo proprio ainda ativo; preservar datadir.');
        const atual=await lstat(datadir,{bigint:true});
        assert.ok(atual.isDirectory()&&!atual.isSymbolicLink());
        assert.equal(atual.dev,donoDiretorio.dev);assert.equal(atual.ino,donoDiretorio.ino);
        assert.equal(dirname(alvo).toLowerCase(), temp.toLowerCase());
        assert.equal(alvo.toLowerCase(), resolve(datadir).toLowerCase());
        assert.match(basename(alvo), /^ist-loja-67-4-[a-z0-9]+$/i);
        await rm(alvo, { recursive: true });
        t.diagnostic('Processo 67.4 encerrado e datadir descartavel removido.');
    });
    const listener = net.createServer(); listener.listen(0, '127.0.0.1');
    let port;
    try { await once(listener, 'listening'); port = listener.address().port; }
    finally { if (listener.listening) await new Promise((r, j) => listener.close(e => e ? j(e) : r())); }
    assert.ok(port > 1024 && ![3306, 3307].includes(port));
    // Bootstrap oficial sem instalador: sem servico, my.ini, alteracao de ACL ou limpeza implicita.
    // --console e saidas descartadas impedem repasse de SQL/verificadores em erros.
    const opcoesComuns = ['--no-defaults', `--basedir=${basedir}`, `--datadir=${datadir}`,
        `--tmpdir=${datadir}`, '--console', '--skip-stack-trace', '--general-log=0', '--slow-query-log=0', '--skip-log-bin'];
    let sqlBootstrap = 'CREATE DATABASE mysql;\nUSE mysql;\n' + scripts.join('\n') + '\n'
        + `UPDATE mysql.global_priv SET Priv=JSON_SET(JSON_REMOVE(Priv,'$.auth_or'),`
        + `'$.plugin','mysql_native_password','$.authentication_string','${verificador}',`
        + "'$.password_last_changed',UNIX_TIMESTAMP()) WHERE User='root';\n"
        + "DELETE FROM mysql.global_priv WHERE User='';\n"
        + "IF NOT EXISTS (SELECT 1 FROM mysql.global_priv WHERE User='root' AND Host='127.0.0.1') "
        + 'OR EXISTS (SELECT 1 FROM mysql.global_priv WHERE User=\'root\' AND ('
        + `COALESCE(JSON_VALUE(Priv,'$.authentication_string'),'') <> '${verificador}' `
        + "OR COALESCE(JSON_VALUE(Priv,'$.plugin'),'') <> 'mysql_native_password' "
        + "OR JSON_CONTAINS_PATH(Priv,'one','$.auth_or'))) "
        + "THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='BOOTSTRAP_AUTH_INVALIDA'; END IF;\n-- end.";
    try {
        processo = spawn(join(bin, 'mariadbd.exe'), [...opcoesComuns, '--bootstrap', '--skip-networking',
            '--named-pipe=OFF'], { windowsHide: true, env: ambienteFilho, stdio: ['pipe', 'ignore', 'ignore'] });
        const fim = once(processo, 'exit');
        const envio = new Promise((r, j) => {
            processo.stdin.once('error', j);
            processo.stdin.end(sqlBootstrap, 'utf8', r);
        });
        const [[codigo, sinal]] = await Promise.all([fim, envio]);
        if (codigo !== 0 || sinal) throw new Error('bootstrap');
    } catch {
        throw new Error('Bootstrap MariaDB recusado; TCP e SQL financeiro nao iniciados.');
    } finally { sqlBootstrap = null; }
    processo = spawn(join(bin, 'mariadbd.exe'), ['--no-defaults', `--datadir=${datadir}`, `--port=${port}`,
        `--basedir=${basedir}`, '--bind-address=127.0.0.1', '--skip-name-resolve', '--named-pipe=OFF',
        '--console', '--skip-stack-trace', '--general-log=0', '--slow-query-log=0', '--skip-log-bin'],
    { windowsHide: true, env: ambienteFilho, stdio: 'ignore' });
    await once(processo, 'spawn');
    const config = { host: '127.0.0.1', port, user: 'root', password: senha, connectTimeout: 1000,
        supportBigNumbers: true, bigNumberStrings: true, dateStrings: true };
    for (let i = 0; i < 100; i++) {
        assert.equal(processo.exitCode, null, 'MariaDB de teste encerrou durante a inicializacao.');
        try { admin = await mysql.createConnection(config); break; }
        catch { await new Promise(r => setTimeout(r, 100)); }
    }
    assert.ok(admin, 'Conexao autenticada com MariaDB de teste indisponivel.');
    const [[identidade]] = await admin.query('SELECT @@datadir AS datadir, @@port AS porta, VERSION() AS versao');
    assert.equal((await realpath(identidade.datadir)).toLowerCase(), datadir.toLowerCase());
    assert.equal(Number(identidade.porta), port); assert.match(identidade.versao, /^13\.0\.2-MariaDB/); verificado = true;
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
    const [[destino]]=await admin.query('SELECT DATABASE() banco,@@port porta,@@datadir datadir,@@hostname hostname,VERSION() versao');
    assert.equal(destino.banco,banco);assert.notEqual(destino.banco,'istbrasil');
    assert.equal(Number(destino.porta),port);assert.equal((await realpath(destino.datadir)).toLowerCase(),datadir.toLowerCase());
    assert.match(destino.versao,/^13\.0\.2-MariaDB/);
    await admin.query('SET @ist_loja_681_schema_esperado=?, @ist_loja_681_ddl_autorizado=?',[banco,'CRIAR_OUTBOX_68_1']);
    const outbox=await readFile(new URL('../../migrations/ist_loja_notificacoes_fundacao.sql',import.meta.url),'utf8');
    await admin.query(outbox.replace(/^DELIMITER[^\r\n]*$/gm,'').replace(/END\$\$\s*$/,'END'));
    t.diagnostic(`OUTBOX_IDENTIDADE: ${destino.versao}; schema ${banco}; 127.0.0.1:${port}; hostname ${destino.hostname}; PID proprio ${processo.pid}; datadir exclusivo confirmado.`);
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
    return { admin, pool, novaCompra, versao: identidade.versao,identidade:destino };
};
