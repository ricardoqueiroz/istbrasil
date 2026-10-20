import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import mysql from 'mysql2/promise';

const nomes = ['ist_loja_arquivo_versoes', 'ist_loja_download_direitos', 'ist_loja_download_direito_eventos'];
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sqlMigration = async () => (await readFile(new URL('../migrations/ist_loja_downloads_fundacao.sql', import.meta.url), 'utf8'))
    .replace(/^DELIMITER[^\r\n]*$/gm, '').replace(/END\$\$\s*$/, 'END');

test('D5.1 schema completo em MariaDB descartavel, sem servicos ou PDFs', { timeout: 180000 }, async t => {
    const antigo = Boolean(process.env.IST_R2_10339_MANIFEST);
    const { criarBancoPagamentoIsolado } = await import(antigo
        ? './fixtures/lojaCatalogoMariaDB10339.js' : './fixtures/lojaPagamentoBancoIsolado.js');
    const { admin: c, novaCompra, versao } = await criarBancoPagamentoIsolado(t);
    assert.match(versao, antigo ? /^10\.3\.39-MariaDB/ : /^13\.0\.2-MariaDB/);
    const [[identidade]] = await c.query('SELECT DATABASE() banco,@@port porta,@@datadir datadir,@@hostname hostname');
    assert.match(identidade.banco, /^ist_loja_67_3_[0-9a-f]{12}$/);
    if (antigo) { assert.equal(Number(identidade.porta), 3306); assert.equal(identidade.datadir, '/var/lib/mysql/'); }
    else { assert(![3306,3307].includes(Number(identidade.porta))); assert.match(identidade.datadir, /ist-loja-67-4-/); }
    t.diagnostic(`Servidor efetivo ${versao}; schema ${identidade.banco}; porta interna ${identidade.porta}; isolamento validado pela fixture.`);
    const config = c.config ?? c.connection.config;
    const conectar = () => mysql.createConnection({ host: config.host, port: config.port, user: config.user,
        password: config.password, database: identidade.banco, supportBigNumbers: true, bigNumberStrings: true, dateStrings: true });
    const [[checks]] = await c.query('SELECT @@foreign_key_checks fk,@@check_constraint_checks ck');
    assert.equal(Number(checks.fk), 1); assert.equal(Number(checks.ck), 1);
    await c.query("INSERT INTO ist_loja_categorias(id,nome,slug) VALUES(1,'Sintetico','sintetico')");
    await c.query('INSERT INTO ist_livros(id) VALUES(1),(2),(3)');
    await c.query("INSERT INTO ist_loja_produtos(id,categoria_id,livro_id,sku) VALUES(1,1,1,'SINT-1'),(2,1,2,'SINT-2'),(6,1,3,'SINT-SANDBOX')");
    const item = async produto => {
        const compra = await novaCompra();
        const [r] = await c.execute(`INSERT INTO ist_loja_pedido_itens(pedido_id,produto_id,posicao,sku_snapshot,
            titulo_snapshot,descricao_snapshot,tipo_snapshot,quantidade,preco_unitario_centavos,subtotal_centavos)
            VALUES(?,?,1,?,'Titulo sintetico','Musica e acao','E-Book',1,100,100)`, [compra.pedidoId, produto, `SKU-${produto}`]);
        return { id: r.insertId, pedido: compra.pedidoId, produto };
    };
    // Dois historicos sinteticos Sandbox (sem quaisquer dados do banco principal).
    const historicos = [await item(6), await item(6)];
    for (const [i,h] of historicos.entries()) {
        await c.execute('UPDATE ist_loja_pedidos SET estado=? WHERE id=?', [i ? 'PAGO' : 'AGUARDANDO_PAGAMENTO', h.pedido]);
        const [pg] = await c.execute(`INSERT INTO ist_loja_pagamentos(public_id,pedido_id,provedor,ambiente,conta_recebedora,
            estado,reserva_ativa,moeda,valor_centavos,capturado_centavos,ordem_externa_id,captura_externa_id,
            criado_em,atualizado_em,expira_em) VALUES(?,?,'simulado','sandbox','FIXTURE',?,1,'BRL',100,?,?,?,
            '2026-01-01','2026-01-01','2026-01-02')`,
        [randomUUID(),h.pedido,i?'CAPTURADO':'PENDENTE',i?100:0,`ORDEM${i}`,`CAPTURA${i}`]);
        await c.execute(`INSERT INTO ist_loja_pagamento_operacoes(pagamento_id,pedido_id,acao,chave_idempotencia,
            solicitacao_hash,request_id_provedor,estado,criado_em,atualizado_em)
            VALUES(?,?,'CAPTURAR',?,?,?,'SUCESSO','2026-01-01','2026-01-01')`,
        [pg.insertId,h.pedido,randomUUID(),randomBytes(32),randomUUID()]);
        await c.execute(`INSERT INTO ist_loja_pagamento_eventos(pagamento_id,provedor,ambiente,conta_recebedora,origem,
            evento_id,tipo,conteudo_hash,evidencia_json,estado,recebido_em,autenticado_em,atualizado_em)
            VALUES(?,'simulado','sandbox','FIXTURE','API',?,'SINTETICO',?,'{}','PROCESSADO','2026-01-01','2026-01-01','2026-01-01')`,
        [pg.insertId,randomUUID(),randomBytes(32)]);
    }
    const originais = ['ist_livros','ist_loja_categorias','ist_loja_produtos','ist_loja_sessoes','ist_loja_pedidos',
        'ist_loja_pedido_itens','ist_loja_pagamentos','ist_loja_pagamento_operacoes','ist_loja_pagamento_eventos'];
    const snapshot = async tabelas => {
        const r={}; for (const tabela of tabelas) r[tabela]=digest((await c.query(`SELECT * FROM ${tabela} ORDER BY id`))[0]); return r;
    };
    const antes = await snapshot(originais);
    const historicoSnapshot = async () => {
        const r=await snapshot(['ist_livros','ist_loja_produtos','ist_loja_pagamentos','ist_loja_pagamento_operacoes','ist_loja_pagamento_eventos']);
        r.pedidos=digest((await c.query('SELECT * FROM ist_loja_pedidos WHERE id IN (?,?) ORDER BY id',historicos.map(h=>h.pedido)))[0]);
        r.itens=digest((await c.query('SELECT * FROM ist_loja_pedido_itens WHERE id IN (?,?) ORDER BY id',historicos.map(h=>h.id)))[0]);
        return r;
    };
    const historicoAntes=await historicoSnapshot();
    const ddlAntes={};for(const tabela of originais)ddlAntes[tabela]=(await c.query(`SHOW CREATE TABLE ${tabela}`))[0][0]['Create Table'];
    const sql = await sqlMigration();
    await t.test('guard rejeita versao nao homologada e perfil de datadir divergente',async()=>{
        // Injecao de metadados SOMENTE em copias de teste: nao e outro servidor.
        // O SQL integral continua falhando antes de qualquer DDL.
        for(const [nome,copia,motivo] of [
            ['versao',sql.replaceAll('VERSION()',"'99.0.0-MariaDB'"),'versao MariaDB nao homologada'],
            ['datadir',sql.replaceAll('@@datadir',"'/destino-nao-autorizado/'"),'destino nao autorizado']
        ]) await assert.rejects(c.query(copia),e=>e.sqlState==='45000'&&e.message.includes(motivo),nome);
        assert.deepEqual(await snapshot(originais),antes);
    });
    await t.test('guard rejeita autocommit desligado, transacao aberta e modo nao estrito',async()=>{
        for(const caso of ['autocommit','transacao','modo']) {
            const conn=await conectar();
            try {
                if(caso==='autocommit')await conn.query('SET SESSION autocommit=0');
                if(caso==='transacao')await conn.beginTransaction();
                if(caso==='modo')await conn.query("SET SESSION sql_mode='NO_ENGINE_SUBSTITUTION'");
                await assert.rejects(conn.query(sql),e=>e.sqlState==='45000');
            }finally{await conn.rollback();await conn.end();}
        }
        assert.deepEqual(await snapshot(originais),antes);
    });
    await t.test('nome nao autorizado e bloqueado mesmo com variavel de sessao arbitraria',async()=>{
        const negado=`ist_downloads_negado_${randomBytes(6).toString('hex')}`;
        await c.query(`CREATE DATABASE ${negado}`);
        try {
            await c.query(`USE ${negado}`);await c.query('SET @ist_downloads_autorizado=1');
            await assert.rejects(c.query(sql),e=>e.sqlState==='45000'&&e.message.includes('destino nao autorizado'));
            const [[r]]=await c.execute('SELECT COUNT(*) n FROM information_schema.tables WHERE table_schema=?',[negado]);assert.equal(Number(r.n),0);
        }finally{
            await c.query(`USE ${identidade.banco}`);await c.query('SET @ist_downloads_autorizado=NULL');
            const [[i]]=await c.query('SELECT @@port porta,@@hostname hostname');
            assert.equal(String(i.porta),String(identidade.porta));assert.equal(i.hostname,identidade.hostname);
            await c.query(`DROP DATABASE ${negado}`);
        }
    });
    await t.test('nome istbrasil e testado somente dentro da instancia descartavel verificada',async()=>{
        // Nunca usar a instancia Windows 3306: conferencias independentes antes do CREATE.
        assert.equal(config.host,'127.0.0.1');assert(![3306,3307].includes(Number(config.port)));
        if(antigo)assert.equal(Number(config.port),13339);
        else assert.match(identidade.datadir,/ist-loja-67-4-/);
        const [[existe]]=await c.query("SELECT COUNT(*) n FROM information_schema.schemata WHERE schema_name='istbrasil'");
        assert.equal(Number(existe.n),0,'Nao adotar schema preexistente');
        const basicas=['ist_livros','ist_loja_categorias','ist_loja_produtos','ist_loja_sessoes','ist_loja_pedidos','ist_loja_pedido_itens'];
        const estruturas=[];for(const tabela of basicas)estruturas.push((await c.query(`SHOW CREATE TABLE ${tabela}`))[0][0]['Create Table']);
        await c.query('CREATE DATABASE istbrasil CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
        try {
            await c.query('USE istbrasil');for(const estrutura of estruturas)await c.query(estrutura);
            if(antigo)await assert.rejects(c.query(sql),e=>e.sqlState==='45000'&&e.message.includes('destino nao autorizado'));
            else {
                await c.query(sql);
                for(const nome of nomes)assert.equal(Number((await c.query(`SELECT COUNT(*) n FROM ${nome}`))[0][0].n),0);
                const [[r]]=await c.query("SELECT COUNT(*) n FROM information_schema.table_constraints WHERE constraint_schema='istbrasil' AND table_name IN ('ist_loja_arquivo_versoes','ist_loja_download_direitos','ist_loja_download_direito_eventos') AND constraint_type='FOREIGN KEY'");
                assert.equal(Number(r.n),4);
            }
        }finally{
            await c.query(`USE ${identidade.banco}`);
            const [[i]]=await c.query('SELECT @@port porta,@@hostname hostname,@@datadir datadir');
            assert.equal(String(i.porta),String(identidade.porta));assert.equal(i.hostname,identidade.hostname);assert.equal(i.datadir,identidade.datadir);
            await c.query('DROP DATABASE istbrasil');
        }
        t.diagnostic(antigo?'istbrasil em Linux 10.3 recusado: perfil nao e o principal Windows autorizado.'
            :'istbrasil aceito e aplicado somente no datadir TEMP independente; principal nao foi acessado.');
    });
    await t.test('estrutura parcial inesperada interrompe antes do ALTER',async()=>{
        await c.query('CREATE TABLE ist_loja_arquivo_versoes (sentinela INT) ENGINE=InnoDB');
        try {
            await assert.rejects(c.query(sql),e=>e.sqlState==='45000');
            const [indices]=await c.query("SHOW INDEX FROM ist_loja_pedido_itens WHERE Key_name='uq_lpi_id_produto_download'");
            assert.equal(indices.length,0);assert.deepEqual(await snapshot(originais),antes);
        }finally{
            const [[alvo]]=await c.query('SELECT DATABASE() banco,@@port porta');
            assert.equal(alvo.banco,identidade.banco);assert.equal(String(alvo.porta),String(identidade.porta));
            await c.query('DROP TABLE ist_loja_arquivo_versoes');
        }
    });
    await t.test('indice preexistente inesperado e rejeitado sem criar tabelas',async()=>{
        await c.query('ALTER TABLE ist_loja_pedido_itens ADD UNIQUE KEY uq_lpi_id_produto_download(id,produto_id)');
        try{await assert.rejects(c.query(sql),e=>e.sqlState==='45000');}
        finally{await c.query('ALTER TABLE ist_loja_pedido_itens DROP INDEX uq_lpi_id_produto_download');}
    });
    await t.test('migration cria tres tabelas e somente o indice composto existente autorizado', async () => {
        await c.query(sql);
        assert.deepEqual(await snapshot(originais), antes);
        for(const tabela of originais) {
            let ddl=(await c.query(`SHOW CREATE TABLE ${tabela}`))[0][0]['Create Table'];
            if(tabela==='ist_loja_pedido_itens')ddl=ddl.replace(/  UNIQUE KEY `uq_lpi_id_produto_download` \(`id`,`produto_id`\),\n/,'');
            assert.equal(ddl,ddlAntes[tabela],tabela);
        }
        for(const nome of nomes) {
            const [[row]]=await c.query(`SELECT COUNT(*) n FROM ${nome}`);assert.equal(Number(row.n),0);
            const [[meta]]=await c.execute('SELECT ENGINE,ROW_FORMAT,TABLE_COLLATION FROM information_schema.tables WHERE table_schema=? AND table_name=?',[identidade.banco,nome]);
            assert.equal(meta.ENGINE,'InnoDB');assert.equal(meta.ROW_FORMAT,'Dynamic');assert.equal(meta.TABLE_COLLATION,'utf8mb4_unicode_ci');
        }
        const [[fks]]=await c.query("SELECT COUNT(*) n FROM information_schema.table_constraints WHERE constraint_schema=DATABASE() AND table_name IN ('ist_loja_arquivo_versoes','ist_loja_download_direitos','ist_loja_download_direito_eventos') AND constraint_type='FOREIGN KEY'");
        assert.equal(Number(fks.n),4);
    });
    await t.test('reaplicacao recusa antes de nova alteracao',async()=>{
        await assert.rejects(c.query(sql),e=>e.sqlState==='45000');assert.deepEqual(await snapshot(originais),antes);
    });
    const arquivo = async (produto,numero,extra={}) => {
        const registro={public_id:randomUUID(),produto_id:produto,arquivo_logico_id:randomUUID(),numero_versao:numero,
            caminho_relativo:`sinteticos/produto-${produto}-v${numero}.pdf`,tamanho_bytes:123,sha256:randomBytes(32),
            mime:'application/pdf',estado:'RASCUNHO',publicacao_atual:null,criado_em:'2026-01-01 00:00:00.123',...extra};
        const [r]=await c.query('INSERT INTO ist_loja_arquivo_versoes SET ?',registro);return r.insertId;
    };
    const publicar = (conn,id) => conn.execute("UPDATE ist_loja_arquivo_versoes SET estado='PUBLICADA',publicacao_atual=1,publicado_em='2026-01-02' WHERE id=?",[id]);
    const retirar = (conn,id) => conn.execute("UPDATE ist_loja_arquivo_versoes SET estado='RETIRADA',publicacao_atual=NULL,retirado_em='2026-01-03' WHERE id=?",[id]);
    const a=await arquivo(1,1), b=await arquivo(1,2), outro=await arquivo(2,1);
    await t.test('numero da versao por produto e identificador publico sao unicos',async()=>{
        await assert.rejects(arquivo(1,1),e=>e.errno===1062);
        const [[r]]=await c.execute('SELECT public_id FROM ist_loja_arquivo_versoes WHERE id=?',[a]);
        await assert.rejects(arquivo(2,200,{public_id:r.public_id}),e=>e.errno===1062);
    });
    await t.test('rascunho preserva DATETIME(3), BINARY(32), caminho e historicos NULL',async()=>{
        const [[r]]=await c.execute("SELECT DATE_FORMAT(criado_em,'%f') fracao,OCTET_LENGTH(sha256) bytes FROM ist_loja_arquivo_versoes WHERE id=?",[a]);
        assert.equal(r.fracao,'123000');assert.equal(Number(r.bytes),32);
        await publicar(c,a);await assert.rejects(publicar(c,b),e=>e.code==='ER_DUP_ENTRY');
    });
    await t.test('rollback restaura publicacao anterior; troca atomica conserva versao antiga',async()=>{
        await c.beginTransaction();await retirar(c,a);await publicar(c,b);await c.rollback();
        assert.equal((await c.execute('SELECT publicacao_atual FROM ist_loja_arquivo_versoes WHERE id=?',[a]))[0][0].publicacao_atual,1);
        await c.beginTransaction();await retirar(c,a);await publicar(c,b);await c.commit();
        const [r]=await c.query('SELECT id FROM ist_loja_arquivo_versoes WHERE produto_id=1');assert.equal(r.length,2);
    });
    const invalidos=[['tamanho zero',{tamanho_bytes:0}],['tamanho acima de JS seguro',{tamanho_bytes:'9007199254740992'}],
        ['MIME',{mime:'text/html'}],['estado minusculo',{estado:'rascunho'}],['marcador ilegal',{publicacao_atual:2}],
        ['publicada sem data',{estado:'PUBLICADA',publicacao_atual:1}],['publicada sem marcador',{estado:'PUBLICADA',publicado_em:'2026-01-02'}],
        ['data anterior',{estado:'PUBLICADA',publicacao_atual:1,publicado_em:'2025-01-01'}],['produto inexistente',{produto_id:999999}],
        ...['/absoluto.pdf','../segredo.pdf','https://externo/a.pdf','C:/a.pdf','a%2fb.pdf','a\\b.pdf','a.pdf?x=1','a.pdf#x','a.pdf\n'].map(p=>[`caminho ${JSON.stringify(p)}`,{caminho_relativo:p}])];
    let numero=10;
    for(const [nome,extra] of invalidos)await t.test(`rejeita arquivo invalido: ${nome}`,async()=>{
        await assert.rejects(arquivo(2,numero++,extra),e=>[4025,1452].includes(e.errno));
    });
    const comprado=await item(1), concorrente=await item(1);
    const direito = async (it=comprado,arq=a,extra={}) => {
        const [r]=await c.query('INSERT INTO ist_loja_download_direitos SET ?',{
            public_id:randomUUID(),pedido_item_id:it.id,produto_id:it.produto,arquivo_versao_id:arq,
            criado_em:'2026-01-01',atualizado_em:'2026-01-01',...extra});return r.insertId;
    };
    let d;
    await t.test('direito pendente fixa versao retirada e nao infere direitos historicos/Sandbox',async()=>{
        d=await direito();const [[r]]=await c.execute('SELECT estado,versao,arquivo_versao_id FROM ist_loja_download_direitos WHERE id=?',[d]);
        assert.equal(r.estado,'AGUARDANDO_CONFIRMACAO');assert.equal(Number(r.versao),1);assert.equal(Number(r.arquivo_versao_id),Number(a));
        const [[q]]=await c.query('SELECT COUNT(*) n FROM ist_loja_download_direitos WHERE produto_id=6');assert.equal(Number(q.n),0);
    });
    for(const [nome,it,arq] of [['item inexistente',{id:999999,produto:1},a],['versao inexistente',concorrente,999999],
        ['outro produto',concorrente,outro],['produto falso',{...concorrente,produto:2},outro],['direito duplicado',comprado,a]]) {
        await t.test(`FK/UNIQUE rejeita ${nome}`,async()=>{await assert.rejects(direito(it,arq),e=>[1452,1062].includes(e.errno));});
    }
    await t.test('versoes e itens referenciados nao podem ser excluidos',async()=>{
        await assert.rejects(c.execute('DELETE FROM ist_loja_arquivo_versoes WHERE id=?',[a]),e=>e.errno===1451);
        await assert.rejects(c.execute('DELETE FROM ist_loja_pedido_itens WHERE id=?',[comprado.id]),e=>e.errno===1451);
        await assert.rejects(c.query('DELETE FROM ist_loja_produtos WHERE id=1'),e=>e.errno===1451);
    });
    const evento = async (id,v,anterior,novo,extra={}) => c.query('INSERT INTO ist_loja_download_direito_eventos SET ?',{
        direito_id:id,direito_versao:v,estado_anterior:anterior,estado_novo:novo,origem:'FINANCEIRO',
        motivo_codigo:'SINTETICO',ocorrido_em:`2026-01-${String(Math.min(v,28)).padStart(2,'0')}`,...extra});
    await t.test('ciclo pendente/ativo/suspenso/ativo/suspenso/revogado e eventos sequenciais',async()=>{
        await evento(d,1,null,'AGUARDANDO_CONFIRMACAO');
        const estados=['ATIVO','SUSPENSO','ATIVO','SUSPENSO','REVOGADO'];let anterior='AGUARDANDO_CONFIRMACAO';
        for(const [i,estado] of estados.entries()){
            const v=i+2,data=`2026-01-${String(v).padStart(2,'0')}`;
            const campo=estado==='ATIVO'?'ativado_em':estado==='SUSPENSO'?'suspenso_em':'revogado_em';
            await c.beginTransaction();
            try {const [r]=await c.query(`UPDATE ist_loja_download_direitos SET estado=?,${campo}=?,atualizado_em=?,motivo_codigo=?,versao=versao+1 WHERE id=? AND versao=?`,[estado,data,data,estado==='ATIVO'?null:'TESTE',d,v-1]);assert.equal(r.affectedRows,1);await evento(d,v,anterior,estado);await c.commit();}catch(e){await c.rollback();throw e;}
            anterior=estado;
        }
        const [ev]=await c.execute('SELECT direito_versao FROM ist_loja_download_direito_eventos WHERE direito_id=? ORDER BY direito_versao',[d]);assert.deepEqual(ev.map(e=>Number(e.direito_versao)),[1,2,3,4,5,6]);
        await assert.rejects(evento(d,6,'SUSPENSO','REVOGADO'),e=>e.errno===1062);
        await assert.rejects(c.execute('DELETE FROM ist_loja_download_direitos WHERE id=?',[d]),e=>e.errno===1451);
    });
    await t.test('suspensao anterior a ativacao e reativacao preservam datas anteriores',async()=>{
        const id=await direito(concorrente,a,{estado:'SUSPENSO',suspenso_em:'2026-01-02',atualizado_em:'2026-01-02',motivo_codigo:'REVISAO'});
        await c.execute("UPDATE ist_loja_download_direitos SET estado='ATIVO',ativado_em='2026-01-03',atualizado_em='2026-01-03',motivo_codigo=NULL,versao=2 WHERE id=?",[id]);
        assert((await c.execute('SELECT suspenso_em FROM ist_loja_download_direitos WHERE id=?',[id]))[0][0].suspenso_em);
    });
    for(const [nome,extra] of [['ativo sem data',{estado:'ATIVO'}],['suspenso sem motivo',{estado:'SUSPENSO',suspenso_em:'2026-01-01'}],
        ['data futura',{ativado_em:'2026-01-02'}],['versao zero',{versao:0}],['estado desconhecido',{estado:'PAGO'}]]) {
        await t.test(`rejeita direito invalido: ${nome}`,async()=>{const it=await item(2);await assert.rejects(direito(it,outro,extra),e=>e.errno===4025);});
    }
    for(const [nome,extra] of [['estado',{estado_novo:'PAGO'}],['origem',{origem:'WEB'}],['ator administrativo ausente',{origem:'ADMINISTRACAO'}],['direito inexistente',{direito_id:999999}]]) {
        await t.test(`rejeita evento invalido: ${nome}`,async()=>{await assert.rejects(evento(d,99,'ATIVO','SUSPENSO',extra),e=>[4025,1452].includes(e.errno));});
    }
    await t.test('concorrencia de publicacao permite somente um vencedor no UNIQUE',async()=>{
        const x=await arquivo(2,100),y=await arquivo(2,101);const c1=await conectar(),c2=await conectar();
        try{await c1.beginTransaction();await c2.beginTransaction();await publicar(c1,x);
            const disputa=publicar(c2,y).then(()=>({ok:true}),e=>({erro:e}));await c1.commit();const r=await disputa;
            assert.equal(r.erro?.code,'ER_DUP_ENTRY');await c2.rollback();
        }finally{await c1.end();await c2.end();}
    });
    await t.test('concorrencia de direitos permite somente um por item',async()=>{
        const it=await item(1),c1=await conectar(),c2=await conectar();
        const inserir=conn=>conn.execute(`INSERT INTO ist_loja_download_direitos(public_id,pedido_item_id,produto_id,arquivo_versao_id,criado_em,atualizado_em) VALUES(?,?,1,?,'2026-01-01','2026-01-01')`,[randomUUID(),it.id,a]);
        try{await c1.beginTransaction();await c2.beginTransaction();await inserir(c1);
            const disputa=inserir(c2).then(()=>({ok:true}),e=>({erro:e}));await c1.commit();const r=await disputa;
            assert.equal(r.erro?.code,'ER_DUP_ENTRY');await c2.rollback();
        }finally{await c1.end();await c2.end();}
    });
    await t.test('update otimista obsoleto nao altera direito; rollback remove transicao incompleta',async()=>{
        const [r]=await c.execute('UPDATE ist_loja_download_direitos SET versao=versao+1 WHERE id=? AND versao=1',[d]);assert.equal(r.affectedRows,0);
        const antes=await snapshot(nomes);
        await c.beginTransaction();await evento(d,7,'REVOGADO','REVOGADO');await c.rollback();assert.deepEqual(await snapshot(nomes),antes);
    });
    await t.test('catalogo e historicos financeiros sinteticos permanecem identicos',async()=>{
        assert.deepEqual(await historicoSnapshot(),historicoAntes);
    });
    await t.test('restauracao logica completa em segundo schema isolado preserva estrutura e dados',async()=>{
        const restaurado=`ist_loja_67_3_${randomBytes(6).toString('hex')}`;
        assert.match(restaurado,/^ist_loja_67_3_[0-9a-f]{12}$/);assert.notEqual(restaurado,identidade.banco);
        const tabelas=[...originais,...nomes],copias=[];
        for(const tabela of tabelas)copias.push({tabela,ddl:(await c.query(`SHOW CREATE TABLE ${tabela}`))[0][0]['Create Table'],rows:(await c.query(`SELECT * FROM ${tabela} ORDER BY id`))[0]});
        await c.query(`CREATE DATABASE ${restaurado} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
        try{await c.query(`USE ${restaurado}`);
            for(const {tabela,ddl,rows} of copias){await c.query(ddl);for(const row of rows)await c.query(`INSERT INTO ${tabela} SET ?`,row);}
            for(const {tabela,ddl,rows} of copias){assert.equal((await c.query(`SHOW CREATE TABLE ${tabela}`))[0][0]['Create Table'],ddl);assert.equal(digest((await c.query(`SELECT * FROM ${tabela} ORDER BY id`))[0]),digest(rows),tabela);}
        }finally{await c.query(`USE ${identidade.banco}`);const [[i]]=await c.query('SELECT @@port porta,@@hostname hostname');assert.equal(String(i.porta),String(identidade.porta));assert.equal(i.hostname,identidade.hostname);await c.query(`DROP DATABASE ${restaurado}`);}
    });
    t.diagnostic('Garantias testadas: constraints, FKs, UNIQUE concorrente, rollback e restauracao; nao sao servicos financeiros/download implementados.');
});
