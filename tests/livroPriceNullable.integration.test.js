import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';

test('price anulavel: migration e recuperacao em instancia comprovadamente descartavel', {timeout:120000}, async t=>{
    const modulo=process.env.IST_R2_10339_MANIFEST
        ? './fixtures/lojaCatalogoMariaDB10339.js' : './fixtures/lojaPagamentoBancoIsolado.js';
    const {criarBancoPagamentoIsolado}=await import(modulo);
    const {admin:c,versao}=await criarBancoPagamentoIsolado(t);
    const [[destino]]=await c.query('SELECT DATABASE() AS banco,@@port AS porta,@@datadir AS datadir');
    t.diagnostic(`PRICE_ISOLADO: ${versao}; host 127.0.0.1; schema ${destino.banco}; porta interna ${destino.porta}; identidade validada pela fixture.`);
    // A fixture mantem id INT PRIMARY KEY sem AUTO_INCREMENT, diferente do DDL real.
    // Nao modificar a coluna ja referenciada por FK; usar IDs sinteticos explicitos.
    // A coluna price reproduz o DDL original, sem ler registros do export local.
    await c.query(`ALTER TABLE ist_livros
      ADD onsale TINYINT(1) NOT NULL DEFAULT 1, ADD sku VARCHAR(50) DEFAULT NULL,
      ADD format ENUM('E-Book','Livro Físico') DEFAULT NULL, ADD category VARCHAR(50) NOT NULL,
      ADD language VARCHAR(5) DEFAULT NULL, ADD title TINYTEXT DEFAULT NULL,
      ADD description LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL,
      ADD currency VARCHAR(3) NOT NULL DEFAULT 'BRL', ADD price DECIMAL(5,2) NOT NULL,
      ADD tax DECIMAL(5,2) NOT NULL DEFAULT 0.00, ADD file TINYTEXT DEFAULT NULL,
      ADD img TINYTEXT DEFAULT NULL, ADD inventory ENUM('Em estoque','Poucas unidades','Esgotado') NOT NULL DEFAULT 'Em estoque',
      ADD pertence_editora_ist TINYINT(1) DEFAULT NULL,
      ADD CONSTRAINT ck_livro_pertence_editora_ist CHECK(pertence_editora_ist IN (0,1)),
      DEFAULT CHARACTER SET latin1 COLLATE latin1_general_ci, COMMENT='Livros disponíveis à venda'`);
    for(const [i,price] of ['0.00','0.01','95.00','999.99','-999.99'].entries())
        await c.execute("INSERT INTO ist_livros(id,category,title,price) VALUES(?,'Musica','Sintetico',?)",[i+1,price]);
    const sql=(await readFile(new URL('../migrations/ist_livros_price_nullable.sql',import.meta.url),'utf8'))
        .replace(/^DELIMITER[^\r\n]*$/gm,'').replace(/END\$\$\s*$/,'END');
    const rows=async()=>(await c.query('SELECT * FROM ist_livros ORDER BY id'))[0];
    const ddl=async()=>Object.values((await c.query('SHOW CREATE TABLE ist_livros'))[0][0])[1];
    const fk=async()=>(await c.query(`SELECT k.CONSTRAINT_NAME,k.TABLE_NAME,k.COLUMN_NAME,k.ORDINAL_POSITION,
        k.REFERENCED_TABLE_SCHEMA,k.REFERENCED_TABLE_NAME,k.REFERENCED_COLUMN_NAME,
        r.MATCH_OPTION,r.UPDATE_RULE,r.DELETE_RULE
        FROM information_schema.KEY_COLUMN_USAGE k
        JOIN information_schema.REFERENTIAL_CONSTRAINTS r
          ON r.CONSTRAINT_SCHEMA=k.CONSTRAINT_SCHEMA AND r.TABLE_NAME=k.TABLE_NAME
          AND r.CONSTRAINT_NAME=k.CONSTRAINT_NAME
        WHERE k.CONSTRAINT_SCHEMA=DATABASE() AND k.TABLE_NAME='ist_loja_produtos'
          AND k.CONSTRAINT_NAME='fk_loja_produtos_livro' ORDER BY k.ORDINAL_POSITION`))[0]
        .map(r=>({...r,ORDINAL_POSITION:Number(r.ORDINAL_POSITION)}));
    const fkOriginal=await fk();
    assert.equal(fkOriginal.length,1);
    assert.deepEqual(fkOriginal[0],{CONSTRAINT_NAME:'fk_loja_produtos_livro',TABLE_NAME:'ist_loja_produtos',
        COLUMN_NAME:'livro_id',ORDINAL_POSITION:1,REFERENCED_TABLE_SCHEMA:destino.banco,
        REFERENCED_TABLE_NAME:'ist_livros',REFERENCED_COLUMN_NAME:'id',MATCH_OPTION:'NONE',
        UPDATE_RULE:'RESTRICT',DELETE_RULE:'RESTRICT'});
    const before=await rows(), original=await ddl();
    const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
    await t.test('configuracao insegura rejeitada antes de DDL',async()=>{
        await c.query('SET SESSION sql_mode=\'\'');
        await assert.rejects(c.query(sql),/PRICE: configuracao/);
        await c.query("SET SESSION sql_mode='STRICT_ALL_TABLES'");
        assert.equal(await ddl(),original);
    });
    await t.test('destino divergente rejeitado sem DDL',async()=>{
        await c.query('USE mysql');
        try {await assert.rejects(c.query(sql),/PRICE: destino/);}
        finally {await c.query(`USE ${destino.banco}`);}
    });
    await t.test('atributo inesperado rejeitado e preservado',async()=>{
        await c.query("ALTER TABLE ist_livros MODIFY price DECIMAL(5,2) NOT NULL COMMENT 'inesperado'");
        await assert.rejects(c.query(sql),/PRICE: coluna/);
        await c.query('ALTER TABLE ist_livros MODIFY price DECIMAL(5,2) NOT NULL');
    });
    await t.test('precisao divergente e FK/CHECK desabilitados falham fechado',async()=>{
        await c.query('ALTER TABLE ist_livros MODIFY price DECIMAL(6,2) NOT NULL');
        await assert.rejects(c.query(sql),/PRICE: coluna/);
        await c.query('ALTER TABLE ist_livros MODIFY price DECIMAL(5,2) NOT NULL');
        for(const flag of ['foreign_key_checks','check_constraint_checks']){
            await c.query(`SET SESSION ${flag}=0`);
            try {await assert.rejects(c.query(sql),/PRICE: configuracao/);}
            finally {await c.query(`SET SESSION ${flag}=1`);}
        }
        assert.equal(await ddl(),original);
    });
    await t.test('aplicacao preserva todos os registros e apenas altera NULL/default',async()=>{
        await c.query(sql);
        assert.deepEqual(await fk(),fkOriginal);
        assert.deepEqual(await rows(),before);
        assert.equal(await ddl(),original.replace('`price` decimal(5,2) NOT NULL','`price` decimal(5,2) DEFAULT NULL'));
        t.diagnostic(`HASH_HISTORICO: ${hash(before)}; antes e depois identicos.`);
        await assert.rejects(c.query(sql),/PRICE: coluna/);
    });
    await t.test('DDL nao reverte com rollback; recuperacao explicita antes de novos NULLs',async()=>{
        await c.query('ROLLBACK');
        assert.match(await ddl(),/`price` decimal\(5,2\) DEFAULT NULL/);
        // Falha de operacao posterior simulada. Recuperacao somente nesta instancia, sem NULLs.
        await assert.rejects(c.query("SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='FALHA_SIMULADA'"),/FALHA_SIMULADA/);
        await c.query('ALTER TABLE ist_livros MODIFY price DECIMAL(5,2) NOT NULL');
        assert.equal(await ddl(),original);assert.deepEqual(await rows(),before);
        assert.deepEqual(await fk(),fkOriginal);
        await c.query(sql);
        assert.deepEqual(await fk(),fkOriginal);
    });
    await t.test('omissao/NULL aceitos, faixa e escala preservadas',async()=>{
        await c.query("INSERT INTO ist_livros(id,category) VALUES(6,'Sem preco')");
        await c.query("INSERT INTO ist_livros(id,category,price) VALUES(7,'Nulo',NULL)");
        assert.equal((await rows()).filter(r=>r.price===null).length,2);
        for(const [i,price] of ['1000.00','-1000.00'].entries())
            await assert.rejects(c.execute("INSERT INTO ist_livros(id,category,price) VALUES(?,'Fora',?)",[8+i,price]),{code:'ER_WARN_DATA_OUT_OF_RANGE'});
        const [[col]]=await c.query("SELECT NUMERIC_PRECISION AS p,NUMERIC_SCALE AS s FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='ist_livros' AND column_name='price'");
        assert.equal(Number(col.p),5);assert.equal(Number(col.s),2);
        assert.deepEqual((await rows()).slice(0,5),before);
        assert.deepEqual(await fk(),fkOriginal);
    });
});
