import test from 'node:test';
import assert from 'node:assert/strict';
import { realpath, stat } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { criarBancoPagamentoIsolado } from './fixtures/lojaPagamentoBancoIsolado.js';

test('ciclo de vida isolado da fixture MariaDB, sem operacoes financeiras', { timeout: 120000 }, async t => {
    assert.equal(process.env.IST_LOJA_PAGAMENTOS_MARIADB_BIN,
        'C:\\Program Files\\MariaDB 13.0\\bin', 'Executaveis fora da instalacao autorizada.');
    let datadir;
    await t.test('inicializacao, autenticacao e identidade', async contexto => {
        const { admin, versao } = await criarBancoPagamentoIsolado(contexto);
        // Conexao publica ja autenticada; a fixture e a unica responsavel pelo lifecycle.
        const [[identidade]] = await admin.query(`SELECT VERSION() AS versao, @@port AS porta,
            @@datadir AS datadir, @@bind_address AS endereco, DATABASE() AS banco,
            CURRENT_USER() AS usuario, @@global.skip_grant_tables AS semAutenticacao`);
        datadir = await realpath(identidade.datadir);
        contexto.diagnostic(JSON.stringify({ versao: identidade.versao, porta: Number(identidade.porta),
            host: identidade.endereco, datadir, schema: identidade.banco }));
        assert.match(versao, /^13\.0\.2-MariaDB/);
        assert.equal(identidade.versao, versao);
        assert.equal(identidade.endereco, '127.0.0.1');
        assert.ok(Number(identidade.porta) > 1024 && Number(identidade.porta) <= 65535);
        assert.ok(![3306, 3307].includes(Number(identidade.porta)));
        const temporario = await realpath(tmpdir());
        assert.equal(dirname(datadir).toLowerCase(), temporario.toLowerCase());
        assert.equal(datadir.toLowerCase(), resolve(identidade.datadir).toLowerCase());
        assert.match(basename(datadir), /^ist-loja-67-4-[a-z0-9]+$/i);
        assert.equal(Number(identidade.semAutenticacao), 0);
        assert.match(identidade.usuario, /^root@(localhost|127\.0\.0\.1)$/);
        // Apenas contagens: nunca retornar senha, verificador ou JSON de privilegios.
        const [[autenticacao]] = await admin.query(`SELECT COUNT(*) AS total,
            COALESCE(SUM(COALESCE(JSON_VALUE(Priv,'$.plugin'),'') <> 'mysql_native_password'
                OR COALESCE(JSON_VALUE(Priv,'$.authentication_string'),'') NOT REGEXP '^[*][0-9A-F]{40}$'
                OR JSON_CONTAINS_PATH(Priv,'one','$.auth_or')),0) AS invalidos
            FROM mysql.global_priv WHERE User='root'`);
        assert.ok(Number(autenticacao.total) > 0);
        assert.equal(Number(autenticacao.invalidos), 0);
        assert.match(identidade.banco, /^ist_loja_67_3_[0-9a-f]{12}$/);
        const [tabelas] = await admin.query(
            'SELECT table_name AS nome FROM information_schema.tables WHERE table_schema=?', [identidade.banco]);
        assert.deepEqual(tabelas.map(linha => linha.nome).sort(), [
            'ist_livros', 'ist_loja_categorias', 'ist_loja_produtos', 'ist_loja_sessoes',
            'ist_loja_pedidos', 'ist_loja_pedido_itens', 'ist_loja_pagamentos',
            'ist_loja_pagamento_operacoes', 'ist_loja_pagamento_eventos'
        ].sort());
        contexto.diagnostic('Autenticacao administrativa, identidade e schema sintetico confirmados.');
        // O after registrado pela fixture fecha conexoes, encerra o filho e remove o datadir.
    });
    if (datadir) {
        await assert.rejects(stat(datadir), { code: 'ENOENT' }, 'Datadir nao removido pela limpeza normal.');
        t.diagnostic('Ausencia do datadir confirmada apos a limpeza normal da fixture.');
    } else {
        assert.fail('Inicializacao nao concluida; identidade e limpeza nao comprovadas pelo teste.');
    }
});
