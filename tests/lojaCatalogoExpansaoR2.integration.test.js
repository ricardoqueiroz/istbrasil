import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { criarBancoPagamentoIsolado } from './fixtures/lojaPagamentoBancoIsolado.js';

test('R2: expansao e copia exata em MariaDB descartavel', { timeout: 120000 }, async t => {
    const { admin: c, versao, novaCompra } = await criarBancoPagamentoIsolado(t);
    t.diagnostic(`Versao realmente testada: ${versao}; nao comprova 10.3.39.`);
    await c.query(`ALTER TABLE ist_livros
      ADD onsale TINYINT(1) NOT NULL DEFAULT 1, ADD sku VARCHAR(50) NULL,
      ADD format ENUM('E-Book','Livro Físico') NULL, ADD category VARCHAR(50) NOT NULL DEFAULT 'Musica',
      ADD language VARCHAR(5) NULL, ADD title TINYTEXT NULL,
      ADD description LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
      ADD currency VARCHAR(3) NOT NULL DEFAULT 'BRL', ADD price DECIMAL(5,2) NOT NULL DEFAULT 95,
      ADD tax DECIMAL(5,2) NOT NULL DEFAULT 0,
      ADD file TINYTEXT NULL, ADD img TINYTEXT NULL,
      ADD inventory ENUM('Em estoque','Poucas unidades','Esgotado') NOT NULL DEFAULT 'Em estoque',
      DEFAULT CHARACTER SET latin1 COLLATE latin1_general_ci`);
    // ALTER DEFAULT nao converte as colunas existentes: explicitar o charset real de origem.
    await c.query(`ALTER TABLE ist_livros MODIFY title TINYTEXT CHARACTER SET latin1,
      MODIFY img TINYTEXT CHARACTER SET latin1`);
    const skus = ['9788552911036EN2E', '9788552911036PT2E', 'IST-SANDBOX-CHECKOUT-001'];
    for (let i = 0; i < 3; i++) await c.execute(`INSERT INTO ist_livros
      (id,sku,format,title,description,price,file,img) VALUES (?,?,'E-Book',?,?,?,? ,?)`,
    [i + 1, skus[i], `Título Sebastião ${i} & ação`, '{"Conteúdo":"Música & ação 🎵"}',
        i === 2 ? '1.00' : '95.00', 'sintetico.pdf', 'assets/images/capa.png']);
    await c.query("INSERT INTO ist_livros(id,sku,title,price) VALUES(4,'NAO-CLASSIFICADO','Outro livro',20.00)");
    await c.query("INSERT INTO ist_loja_categorias(id,nome,slug) VALUES(2,'Música','musica'),(5,'Sandbox','sandbox')");
    for (let i = 0; i < 3; i++) await c.execute(`INSERT INTO ist_loja_produtos
      (id,categoria_id,livro_id,sku,ordem) VALUES(?,?,?,?,?)`, [i === 2 ? 6 : i + 1, i === 2 ? 5 : 2, i + 1, skus[i], i + 1]);
    for (let i = 0; i < 2; i++) {
        const compra = await novaCompra({ estado: i ? 'PAGO' : 'AGUARDANDO_PAGAMENTO' });
        await c.execute(`INSERT INTO ist_loja_pedido_itens(pedido_id,produto_id,posicao,sku_snapshot,
          titulo_snapshot,descricao_snapshot,tipo_snapshot,quantidade,preco_unitario_centavos,subtotal_centavos)
          VALUES(?,6,1,?,'Snapshot imutavel','{}','E-Book',1,100,100)`, [compra.pedidoId, skus[2]]);
        const estado = i ? 'CAPTURADO' : 'PENDENTE';
        const [pg] = await c.execute(`INSERT INTO ist_loja_pagamentos
          (public_id,pedido_id,provedor,ambiente,conta_recebedora,estado,reserva_ativa,moeda,
           valor_centavos,capturado_centavos,ordem_externa_id,captura_externa_id,criado_em,atualizado_em,expira_em)
          VALUES(?,?,'paypal','sandbox','CONTA-SINTETICA',?,1,'BRL',100,?,?,?,
           '2026-01-01 00:00:00','2026-01-01 00:00:00','2026-01-02 00:00:00')`,
        [randomUUID(), compra.pedidoId, estado, i ? 100 : 0, `ORDEM${i}`, `CAPTURA${i}`]);
        await c.execute(`INSERT INTO ist_loja_pagamento_operacoes
          (pagamento_id,pedido_id,acao,chave_idempotencia,solicitacao_hash,request_id_provedor,
           estado,tentativas,criado_em,atualizado_em)
          VALUES(?,?,'CAPTURAR',?,UNHEX(SHA2('sintetico',256)),?,'SUCESSO',1,
           '2026-01-01 00:00:00','2026-01-01 00:00:00')`,
        [pg.insertId, compra.pedidoId, randomUUID(), randomUUID()]);
        await c.execute(`INSERT INTO ist_loja_pagamento_eventos
          (pagamento_id,provedor,ambiente,conta_recebedora,origem,evento_id,tipo,conteudo_hash,
           evidencia_json,estado,recebido_em,autenticado_em,atualizado_em,processado_em)
          VALUES(?,'paypal','sandbox','CONTA-SINTETICA','API',?,?,UNHEX(SHA2('sintetico',256)),
           '{}','PROCESSADO','2026-01-01 00:00:00','2026-01-01 00:00:00',
           '2026-01-01 00:00:00','2026-01-01 00:00:00')`, [pg.insertId, randomUUID(), estado]);
    }
    const tabelas = ['ist_loja_sessoes','ist_loja_pedidos','ist_loja_pedido_itens',
        'ist_loja_pagamentos','ist_loja_pagamento_operacoes','ist_loja_pagamento_eventos','ist_loja_categorias'];
    const snapshot = async () => {
        const r = {};
        for (const nome of tabelas) r[nome] = (await c.query(`SELECT * FROM ${nome} ORDER BY id`))[0];
        r.produtos = (await c.query('SELECT id,categoria_id,livro_id,sku,ativo,ordem FROM ist_loja_produtos ORDER BY id'))[0];
        r.livros = (await c.query('SELECT id,onsale,sku,format,category,language,title,description,currency,price,tax,file,img,inventory FROM ist_livros ORDER BY id'))[0];
        return r;
    };
    const antes = await snapshot();
    const sql = (await readFile(new URL('../migrations/ist_loja_catalogo_expansao_r2.sql', import.meta.url), 'utf8'))
        .replace(/^DELIMITER[^\r\n]*$/gm, '');
    const inicio = sql.indexOf('BEGIN NOT ATOMIC');
    await c.query(sql.slice(0, inicio));
    // Divergencia antes do DDL nao pode deixar estrutura parcial.
    await c.query('UPDATE ist_livros SET price=94.99 WHERE id=1');
    await assert.rejects(c.query(sql.slice(inicio).replace(/END\$\$\s*$/, 'END')), /dados ou conversao/);
    const [[ausencia]] = await c.query(`SELECT COUNT(*) AS n FROM information_schema.tables
      WHERE table_schema=DATABASE() AND table_name='ist_loja_perfis_fiscais'`);
    assert.equal(Number(ausencia.n), 0);
    await c.query('UPDATE ist_livros SET price=95.00 WHERE id=1');
    await c.query(sql.slice(inicio).replace(/END\$\$\s*$/, 'END'));
    assert.deepEqual(await snapshot(), antes, 'Dados preexistentes integralmente preservados');
    const [produtos] = await c.query('SELECT id,tipo,preco_centavos,moeda,em_venda,disponivel,perfil_fiscal_id FROM ist_loja_produtos ORDER BY id');
    assert.deepEqual(produtos.map(p => [p.id,p.tipo,Number(p.preco_centavos),p.moeda,p.em_venda,p.disponivel,p.perfil_fiscal_id]),
        [[1,'DIGITAL',9500,'BRL',1,1,null],[2,'DIGITAL',9500,'BRL',1,1,null],[6,'DIGITAL',100,'BRL',1,1,null]]);
    const [[textos]] = await c.query(`SELECT COUNT(*) AS n FROM ist_loja_produtos p JOIN ist_livros l ON l.id=p.livro_id
      WHERE BINARY p.titulo=BINARY CONVERT(l.title USING utf8mb4)
      AND BINARY p.descricao=BINARY l.description AND BINARY p.imagem_url=BINARY CONVERT(l.img USING utf8mb4)`);
    assert.equal(Number(textos.n), 3);
    const [livros] = await c.query('SELECT id,pertence_editora_ist FROM ist_livros ORDER BY id');
    assert.deepEqual(livros.map(l => [l.id,l.pertence_editora_ist]), [[1,1],[2,1],[3,0],[4,null]]);
    assert.equal(Number((await c.query('SELECT COUNT(*) AS n FROM ist_loja_perfis_fiscais'))[0][0].n), 0);
    const estado = await snapshot();
    await assert.rejects(c.query(sql.slice(inicio).replace(/END\$\$\s*$/, 'END')), /estrutura existente/);
    assert.deepEqual(await snapshot(), estado);
    await c.query('START TRANSACTION');
    try {
        await c.query("INSERT INTO ist_loja_produtos(categoria_id,livro_id,sku) VALUES(2,NULL,'SEM-LIVRO-A'),(2,NULL,'SEM-LIVRO-B')");
        await assert.rejects(c.query("INSERT INTO ist_loja_produtos(categoria_id,livro_id,sku) VALUES(2,1,'LIVRO-DUPLICADO')"), { code: 'ER_DUP_ENTRY' });
        await assert.rejects(c.query("INSERT INTO ist_loja_produtos(categoria_id,livro_id,sku) VALUES(2,999,'FK-INVALIDA')"), { code: 'ER_NO_REFERENCED_ROW_2' });
        await assert.rejects(c.query('UPDATE ist_loja_produtos SET perfil_fiscal_id=999 WHERE id=1'), { code: 'ER_NO_REFERENCED_ROW_2' });
        for (const expressao of ["tipo='OUTRO'", 'preco_centavos=0', "moeda='USD'", 'em_venda=2', 'disponivel=2']) {
            await assert.rejects(c.query(`UPDATE ist_loja_produtos SET ${expressao} WHERE id=1`), /CONSTRAINT/);
        }
        await assert.rejects(c.query('UPDATE ist_livros SET pertence_editora_ist=2 WHERE id=1'), /CONSTRAINT/);
    } finally { await c.query('ROLLBACK'); }
    assert.deepEqual(await snapshot(), estado);
    t.diagnostic('IDs/SKUs/vinculos/snapshots preservados; Unicode exato; CHECK/FK/UNIQUE/NULL e rollback aprovados.');
});
