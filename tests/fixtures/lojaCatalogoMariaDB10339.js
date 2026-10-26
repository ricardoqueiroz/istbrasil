import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import {DIRETORIO_10339,validarManifestoNotificacoes10339,verificarObservadorNotificacoes} from './lojaNotificacoesFixture.js';

// Exclusivo do executor WSL revisado. Nao importa dotenv/configuracao da aplicacao.
export const criarBancoPagamentoIsolado = async (t,opcoes={}) => {
    assert(Object.keys(opcoes).every(k=>k==='financeiroOutbox'));
    assert(opcoes.financeiroOutbox===undefined||typeof opcoes.financeiroOutbox==='boolean');
    const financeiro=opcoes.financeiroOutbox===true;
    const caminho = process.env.IST_R2_10339_MANIFEST;
    const diretorio=financeiro?DIRETORIO_10339:'/home/ist_user/.local/state/ist-r2-mariadb10339';
    assert.equal(caminho, `${diretorio}/manifest.json`);
    const lerWSL = p => execFileSync('wsl.exe', ['-d', 'Ubuntu', '-u', 'ist_user', '--exec', 'cat', p],
        { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const manifest = JSON.parse(lerWSL(caminho));
    if(financeiro){
        assert(!process.env.IST_LOJA_PAGAMENTOS_MARIADB_BIN);
        assert.equal(process.env.IST_LOJA_NOTIFICACOES_MARIADB,'10.3.39');
        // Read-only Docker inspection. Fixed resource names, never arguments from a manifest.
        const inspecionar=(tipo,nome)=>JSON.parse(execFileSync('wsl.exe',['-d','Ubuntu','-u','root','--exec','env','-u','DOCKER_HOST','-u','DOCKER_CONTEXT',
            'docker','--host','unix:///var/run/docker.sock',tipo,'inspect',nome],
            {encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']}))[0];
        validarManifestoNotificacoes10339(manifest,inspecionar('container','ist-notificacoes-mariadb10339'),inspecionar('volume','ist-notificacoes-mariadb10339-data'));
    }
    assert.equal(manifest.containerName, financeiro?'ist-notificacoes-mariadb10339':'ist-r2-mariadb10339');
    assert.equal(manifest.imageDigest, 'sha256:a4b57b620852e26f2c306c79fd8a61e22c7cd6e55d0a55d5521854ed2c370102');
    assert.match(manifest.containerId, /^[0-9a-f]{64}$/);
    assert.match(manifest.runId, /^[0-9a-f-]{36}$/);
    assert.equal(manifest.volume, financeiro?'ist-notificacoes-mariadb10339-data':'ist-r2-mariadb10339-data');
    assert.equal(manifest.host, '127.0.0.1');
    if(!financeiro)assert.equal(manifest.port, 13339);
    assert.match(manifest.schema, /^ist_loja_67_3_[0-9a-f]{12}$/);
    const password = lerWSL(`${diretorio}/root-password`).trim();
    assert.match(password, /^[0-9a-f]{64}$/);
    const config = { host: '127.0.0.1', port: manifest.port, user: 'root', password,
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
    t.diagnostic(`Identidade confirmada: ${identidade.versao}; externo 127.0.0.1:${manifest.port}; schema ${manifest.schema}`);
    if(financeiro)await verificarObservadorNotificacoes(admin,t);
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
    if(financeiro){
        const [[destino]]=await admin.query('SELECT DATABASE() banco,@@port porta,@@datadir datadir,@@hostname hostname,VERSION() versao');
        assert.equal(destino.banco,manifest.schema);assert.notEqual(destino.banco,'istbrasil');
        assert.equal(destino.hostname,identidade.hostname);assert.equal(destino.datadir,identidade.datadir);
        assert.equal(Number(destino.porta),3306);assert.equal(destino.versao,identidade.versao);
        await admin.query('SET @ist_loja_681_schema_esperado=?, @ist_loja_681_ddl_autorizado=?',[manifest.schema,'CRIAR_OUTBOX_68_1']);
        const outbox=await readFile(new URL('../../migrations/ist_loja_notificacoes_fundacao.sql',import.meta.url),'utf8');
        await admin.query(outbox.replace(/^DELIMITER[^\r\n]*$/gm,'').replace(/END\$\$\s*$/,'END'));
        const pool=mysql.createPool({...config,database:manifest.schema,connectionLimit:8});
        t.after(()=>pool.end());
        const novaCompra=async(op={})=>{
            const instante=Date.now(),data=ms=>new Date(ms).toISOString().slice(0,23).replace('T',' ');
            const criado=data(instante-1000),sessaoExpira=data(instante+86400000-2000),pedidoExpira=data(instante+(op.expirado?-100:1800000));
            const [s]=await admin.query('INSERT INTO ist_loja_sessoes(token_hash,criada_em,expira_em) VALUES(?,?,?)',[randomBytes(32),criado,sessaoExpira]);
            const publicId=randomUUID();
            const [p]=await admin.query(`INSERT INTO ist_loja_pedidos(public_id,sessao_id,comprador_email,estado,ambiente,moeda,total_centavos,
                idempotencia_criacao,solicitacao_hash,criado_em,atualizado_em,expira_em) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
            [publicId,s.insertId,'fixture@example.invalid',op.estado??'CRIADO',op.ambiente??'sandbox','BRL',19000,randomUUID(),randomBytes(32),criado,criado,pedidoExpira]);
            return {sessao:{id:s.insertId},pedidoPublicId:publicId,pedidoId:p.insertId};
        };
        return {admin,pool,novaCompra,versao:identidade.versao,identidade:destino};
    }
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
