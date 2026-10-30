import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {criarBancoPagamentoIsolado} from './fixtures/lojaCatalogoMariaDB10339.js';
const ler=nome=>readFile(new URL(`../migrations/${nome}`,import.meta.url),'utf8');
const executar=sql=>sql.replace(/^DELIMITER[^\r\n]*$/gm,'').replace(/END\$\$\s*$/,'END');
const tabela='ist_loja_download_recuperacoes', limites='ist_loja_download_recuperacao_limites';
test('B7-C3 migration aditiva sem DML financeiro ou alteracao de escopo',async()=>{
    const sql=await ler('ist_loja_download_recuperacao_otp_fundacao.sql');
    assert(!/\b(?:INSERT|UPDATE|DELETE|TRUNCATE)\s+(?:INTO\s+|FROM\s+)?ist_loja_/i.test(sql));
    assert(!/ALTER TABLE ist_loja_download_recuperacao_direitos/.test(sql));
    assert.match(sql,/TIMESTAMPADD\(MINUTE,15,criado_em\)/);
    assert.match(sql,/TIMESTAMPADD\(MINUTE,10,criado_em\)/);
});
test('B7-C3 MariaDB 10.3.39 isolado: constraints, locks, retencao e legado',{
    skip:process.env.IST_LOJA_MARIADB_NATIVO_10339!=='true',timeout:120000
},async t=>{
    assert.equal(process.env.IST_R2_10339_MANIFEST,'NATIVO_DESCARTAVEL_10339');
    const {admin:a,pool}=await criarBancoPagamentoIsolado(t);
    // Reutiliza DDL legado, sem relaxar guardas de nenhuma migration.
    const base=await ler('ist_loja_download_recuperacao_fundacao.sql');
    // Tabelas de referencia minimas: nenhum fluxo financeiro e nenhum dado real.
    await a.query('CREATE TABLE ist_loja_download_direitos(id INT UNSIGNED PRIMARY KEY) ENGINE=InnoDB');
    await a.query('CREATE TABLE ist_loja_arquivo_versoes(id INT UNSIGNED PRIMARY KEY) ENGINE=InnoDB');
    for(const ddl of base.match(/CREATE TABLE ist_loja_[\s\S]*?\) ENGINE=InnoDB[^;]*;/g))await a.query(ddl);
    // pedido sintetico completo criado pela fixture existente.
    const protegidas=['ist_loja_pagamentos','ist_loja_pagamento_operacoes','ist_loja_pagamento_eventos','ist_loja_download_direitos'];
    const snapshot=async()=>{const r=[];for(const nome of protegidas)r.push((await a.query(`SELECT * FROM ${nome} ORDER BY id`))[0]);return r;};
    const protegidoAntes=await snapshot();
    const f=await a.query('SHOW CREATE TABLE ist_loja_pedidos');
    const cols=(await a.query('SELECT * FROM ist_loja_pedidos ORDER BY id'))[0];
    const insert=async(tipo='LINK',pedido=null,minutos=15)=>{
        const [r]=await a.execute(`INSERT INTO ${tabela}
          (public_id,desafio_hash,email_chave,email_normalizado,criado_em,desafio_expira_em${tipo==='LINK'?'':',tipo,pedido_id'})
          VALUES(?,?,?,'sintetico@example.invalid','2026-01-01',TIMESTAMPADD(MINUTE,?,'2026-01-01')${tipo==='LINK'?'':',?,?'})`,
          [randomUUID(),Buffer.from(randomUUID().replaceAll('-',''),'ascii'),Buffer.alloc(32,2),minutos,...(tipo==='LINK'?[]:[tipo,pedido])]);
        return r.insertId;
    };
    const legado=await insert();
    const antes=(await a.query(`SELECT * FROM ${tabela}`))[0];
    const escopo=(await a.query('SHOW CREATE TABLE ist_loja_download_recuperacao_direitos'))[0];
    const migration=executar(await ler('ist_loja_download_recuperacao_otp_fundacao.sql'));
    await t.test('destino sem autorizacao rejeitado antes de escrever',()=>assert.rejects(a.query(migration),{sqlState:'45000'}));
    await a.query("SET @ist_b7c3_schema=DATABASE(), @ist_b7c3_autorizacao='FUNDACAO_OTP_B7_C3'");
    await a.query(migration);
    await t.test('LINK preservado; scope e pedidos intactos',async()=>{
        const novos=(await a.query(`SELECT * FROM ${tabela}`))[0];
        for(const key of Object.keys(antes[0]))assert.deepEqual(novos[0][key],antes[0][key]);
        assert.equal(novos[0].tipo,'LINK');
        assert.deepEqual((await a.query('SHOW CREATE TABLE ist_loja_download_recuperacao_direitos'))[0],escopo);
        assert.deepEqual((await a.query('SHOW CREATE TABLE ist_loja_pedidos'))[0],f[0]);
        assert.deepEqual((await a.query('SELECT * FROM ist_loja_pedidos ORDER BY id'))[0],cols);
    });
    await t.test('validade, tipo, versao e limite legado rejeitam valores invalidos',async()=>{
        await assert.rejects(insert('LINK',null,10));
        await assert.rejects(insert('OTP',null,10));
        await assert.rejects(a.query(`UPDATE ${tabela} SET tentativas=6 WHERE id=?`,[legado]));
        await assert.rejects(a.query(`UPDATE ${tabela} SET versao_protecao=0 WHERE id=?`,[legado]));
        await assert.rejects(a.query(migration),{sqlState:'45000'});
    });
    // Associacao FK real, sem criar pedido: a fixture nao fornece pedido por padrao.
    // Sessao e pedido exclusivamente sinteticos, com contrato da fundacao existente.
    await a.query("INSERT INTO ist_loja_sessoes(token_hash,criada_em,expira_em) VALUES(REPEAT('s',32),'2026-01-01','2026-01-02')");
    const [pedido]=await a.execute(`INSERT INTO ist_loja_pedidos(public_id,sessao_id,comprador_email,estado,ambiente,moeda,total_centavos,idempotencia_criacao,solicitacao_hash,criado_em,atualizado_em,expira_em)
      VALUES(?,LAST_INSERT_ID(),'sintetico@example.invalid','CRIADO','sandbox','BRL',100,?,?,'2026-01-01','2026-01-01','2026-01-02')`,[randomUUID(),randomUUID(),Buffer.alloc(32,3)]);
    const id=await insert('OTP',pedido.insertId,10);
    await t.test('OTP unico aberto por pedido, expiracao nao libera slot implicitamente',async()=>{
        await assert.rejects(insert('OTP',pedido.insertId,10),{code:'ER_DUP_ENTRY'});
        await assert.rejects(a.query(`UPDATE ${tabela} SET desafio_expira_em='2026-01-01 00:15:00' WHERE id=?`,[id]));
        await assert.rejects(a.query(`UPDATE ${tabela} SET invalidado_em='2025-01-01' WHERE id=?`,[id]));
    });
    const c1=await pool.getConnection(),c2=await pool.getConnection();
    try{
        await t.test('lock concorrente, rollback de invalidacao e liberacao explicita do slot',async()=>{
            await c2.query('SET SESSION innodb_lock_wait_timeout=1');
            await c1.beginTransaction();
            await c1.query(`UPDATE ${tabela} SET invalidado_em='2026-01-01 00:01:00' WHERE id=?`,[id]);
            await assert.rejects(c2.query(`SELECT id FROM ${tabela} WHERE id=? FOR UPDATE`,[id]),{code:'ER_LOCK_WAIT_TIMEOUT'});
            await c1.rollback();
            assert.equal((await a.query(`SELECT invalidado_em FROM ${tabela} WHERE id=?`,[id]))[0][0].invalidado_em,null);
            await a.query(`UPDATE ${tabela} SET invalidado_em='2026-01-01 00:01:00' WHERE id=?`,[id]);
            await insert('OTP',pedido.insertId,10);
        });
        await t.test('orcamento persiste, serializa incrementos e retencao protege bloqueios',async()=>{
            await a.query(`INSERT INTO ${limites}(escopo,versao_chave,chave_hash,janela_inicio,janela_fim,atualizado_em,retencao_ate)
              VALUES('IP',1,REPEAT('h',32),'2026-01-01','2026-01-02','2026-01-01','2026-01-10')`);
            await c1.beginTransaction();await c1.query(`UPDATE ${limites} SET falhas=falhas+1`);
            await assert.rejects(c2.query(`UPDATE ${limites} SET falhas=falhas+1`),{code:'ER_LOCK_WAIT_TIMEOUT'});
            await c1.commit();await c2.query(`UPDATE ${limites} SET falhas=falhas+1`);
            assert.equal(Number((await a.query(`SELECT falhas FROM ${limites}`))[0][0].falhas),2);
            await assert.rejects(a.query(`UPDATE ${limites} SET bloqueado_ate='2026-01-09'`));
            const [r]=await a.query(`DELETE FROM ${limites} WHERE retencao_ate<'2026-01-03'`);assert.equal(r.affectedRows,0);
            const [s]=await a.query(`DELETE FROM ${limites} WHERE retencao_ate<'2026-01-11'`);assert.equal(s.affectedRows,1);
        });
        await t.test('consumo unico, invalidacao incompatível com consumo, indices e limpeza',async()=>{
            const [[aberto]]=await a.query(`SELECT id FROM ${tabela} WHERE pedido_otp_aberto=?`,[pedido.insertId]);
            const consumir=`UPDATE ${tabela} SET consumido_em='2026-01-01 00:02:00', email_normalizado=NULL,
              sessao_hash=?,sessao_criada_em='2026-01-01 00:02:00',sessao_expira_em='2026-01-01 01:02:00'
              WHERE id=? AND consumido_em IS NULL AND invalidado_em IS NULL AND tentativas<5`;
            const [primeiro]=await a.execute(consumir,[Buffer.alloc(32,9),aberto.id]);assert.equal(primeiro.affectedRows,1);
            const [segundo]=await a.execute(consumir,[Buffer.alloc(32,8),aberto.id]);assert.equal(segundo.affectedRows,0);
            await assert.rejects(a.query(`UPDATE ${tabela} SET invalidado_em='2026-01-01 00:03:00' WHERE id=?`,[aberto.id]));
            const [indices]=await a.query(`SHOW INDEX FROM ${tabela}`);
            for(const nome of ['uq_ldr_otp_aberto','idx_ldr_tipo_pedido_criado','idx_ldr_pedido'])assert(indices.some(x=>x.Key_name===nome));
            // Mesmo predicado da limpeza legada: desafios 7 dias, sessoes 90 dias.
            const [antes]=await a.query(`DELETE FROM ${tabela} WHERE consumido_em IS NULL AND desafio_expira_em<'2025-12-25'`);
            assert.equal(antes.affectedRows,0);
            await a.query(`DELETE FROM ${tabela} WHERE consumido_em IS NULL AND desafio_expira_em<'2026-01-02'`);
            assert.equal(Number((await a.query(`SELECT COUNT(*) n FROM ${tabela} WHERE id=?`,[aberto.id]))[0][0].n),1);
            assert.deepEqual(await snapshot(),protegidoAntes);
        });
    }finally{await c1.rollback();await c2.rollback();c1.release();c2.release();}
});
