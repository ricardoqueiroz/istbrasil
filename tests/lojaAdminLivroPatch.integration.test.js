import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,createHash,randomUUID} from 'node:crypto';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import mysql from 'mysql2/promise';
import {pool as poolPadrao} from '../src/config/db.js';
import {criarLojaAdminRouter} from '../src/routes/lojaAdmin.routes.js';
import {expandirCatalogoSintetico} from './fixtures/lojaCatalogoComercialFixture.js';

// Executar somente mediante autorizacao: a fixture cria instancia/schema sinteticos.
// Nao carrega dumps, .env para destino SQL, PDFs ou configuracao do pool padrao.
test('PATCH editorial: HTTP e SQL reais exclusivamente descartaveis', {timeout:120000},async t=>{
    const antigo=Boolean(process.env.IST_R2_10339_MANIFEST),limpezas=[];
    const manifesto=process.env.IST_R2_10339_MANIFEST,bin=process.env.IST_LOJA_PAGAMENTOS_MARIADB_BIN;
    assert.ok(Boolean(manifesto)!==Boolean(bin),'Selecionar exatamente uma fixture explicita, sem fallback');
    const barreiras=new Set(),conexoes=new Set();
    let pool,servidor,concorrencia=null,injetarErro=false;
    const originais=new Map();
    for(const nome of ['query','execute','getConnection']){
        originais.set(nome,poolPadrao[nome]);
        poolPadrao[nome]=()=>{throw Error('POOL_PERSISTENTE_PROIBIDO');};
    }
    t.after(async()=>{
        try {
            for(const b of barreiras)b.resolve();
            for(const c of conexoes)c.destroy();
            if(servidor){servidor.closeAllConnections();await new Promise((r,j)=>servidor.close(e=>e?j(e):r()));}
            if(pool)await pool.end();
        } finally {
            try {for(const limpar of limpezas)await limpar();}
            finally {for(const [nome,fn]of originais)poolPadrao[nome]=fn;}
        }
    });
    const {criarBancoPagamentoIsolado}=await import(antigo
        ? './fixtures/lojaCatalogoMariaDB10339.js':'./fixtures/lojaPagamentoBancoIsolado.js');
    const fx=await criarBancoPagamentoIsolado({after:fn=>limpezas.push(fn),diagnostic:v=>t.diagnostic(v)});
    const a=fx.admin;
    const [[identidade]]=await a.query('SELECT VERSION() versao,DATABASE() banco,@@port porta,@@datadir datadir');
    assert.match(identidade.versao,antigo?/^10\.3\.39-MariaDB(?:-|$)/:/^13\.0\.2-MariaDB(?:-|$)/);
    assert.match(identidade.banco,/^ist_loja_67_3_[0-9a-f]{12}$/);
    const cfg=a.config??a.connection.config;
    assert.equal(cfg.host,'127.0.0.1');
    assert.equal(Number(cfg.port),antigo?13339:Number(identidade.porta));
    // Configuracao somente da conexao autenticada/identificada pela fixture.
    // Pool novo nao depende de DB_*; nunca imprimir cfg ou password.
    pool=mysql.createPool({host:cfg.host,port:cfg.port,user:cfg.user,password:cfg.password,
        database:identidade.banco,dateStrings:true,connectionLimit:4,connectTimeout:2000});
    const [[p]]=await pool.query('SELECT DATABASE() banco,@@port porta,@@datadir datadir');
    const normalizarPorta=valor=>{
        assert.ok(typeof valor==='number'||(typeof valor==='string'&&/^[0-9]+$/.test(valor)),
            'Porta ausente ou com representacao invalida');
        const numero=Number(valor);
        assert.ok(Number.isInteger(numero)&&numero>=1&&numero<=65535,'Porta fora do intervalo TCP');
        return numero;
    };
    const portaFixture=normalizarPorta(identidade.porta),portaPool=normalizarPorta(p.porta);
    assert.deepEqual({...p,porta:portaPool},{banco:identidade.banco,porta:portaFixture,datadir:identidade.datadir});
    const identificarConexao=async c=>{
        const [[v]]=await c.query(`SELECT CONNECTION_ID() id,CURRENT_USER() usuario,
            DATABASE() banco,@@port porta,@@datadir datadir,VERSION() versao,@@hostname hostname`);
        assert.equal(v.banco,identidade.banco);assert.equal(normalizarPorta(v.porta),portaFixture);
        assert.equal(v.datadir,identidade.datadir);assert.equal(v.versao,identidade.versao);
        assert.ok(Number.isSafeInteger(Number(v.id))&&Number(v.id)>0);
        return v;
    };
    const observador=await identificarConexao(a);
    assert.equal(observador.usuario.split('@')[0],cfg.user,'USUARIO_OBSERVADOR_DIVERGENTE');
    const [[privilegio]]=await a.query(`SELECT COUNT(*) quantidade FROM information_schema.USER_PRIVILEGES
        WHERE PRIVILEGE_TYPE='PROCESS' AND GRANTEE=CONCAT(
            QUOTE(SUBSTRING_INDEX(CURRENT_USER(),'@',1)),'@',QUOTE(SUBSTRING_INDEX(CURRENT_USER(),'@',-1)))`);
    assert.equal(Number(privilegio.quantidade),1,'OBSERVADOR_SEM_PROCESS_EXPLICITO');
    t.diagnostic(`OBSERVADOR: conexao ${Number(observador.id)}; identidade efetiva validada; PROCESS confirmado.`);
    // Fixture ja possui FK para id; nao modificar essa PK. Colunas latin1 explicitas.
    await a.query(`ALTER TABLE ist_livros ADD title TINYTEXT CHARACTER SET latin1 COLLATE latin1_general_ci NULL,
        ADD description LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
        ADD author VARCHAR(100) NULL,
        ADD language VARCHAR(6) CHARACTER SET latin1 NULL,
        ADD format ENUM('E-Book','Livro Físico') CHARACTER SET latin1 NULL,
        ADD category VARCHAR(50) CHARACTER SET latin1 NOT NULL,
        ADD img TINYTEXT CHARACTER SET latin1 NULL,ADD price DECIMAL(5,2) NOT NULL,
        ADD sku VARCHAR(50) CHARACTER SET latin1 NULL,ADD file TINYTEXT CHARACTER SET latin1 NULL,
        ADD currency VARCHAR(3) DEFAULT 'BRL',ADD onsale TINYINT DEFAULT 1,
        ADD inventory VARCHAR(32) DEFAULT 'Em estoque',ADD tax DECIMAL(5,2) DEFAULT 0`);
    await expandirCatalogoSintetico(a,{publicar:false});
    await a.query('ALTER TABLE ist_loja_produtos ADD autor VARCHAR(100) NULL');
    await a.query('CREATE TABLE ist_usuarios(id_usuario INT PRIMARY KEY,id_tipo_usuario INT NOT NULL) ENGINE=InnoDB');
    await a.query('INSERT INTO ist_usuarios(id_usuario,id_tipo_usuario) VALUES(7,1),(8,2)');
    for(const id of [1,2])await a.execute(`INSERT INTO ist_livros
        (id,title,description,language,format,category,img,price,sku,file,pertence_editora_ist)
        VALUES(?,'Editorial original','Descricao omitida',NULL,'E-Book','Musica','privado/SEGREDO.png',
        95.00,'SKU-LEGADO','privado/SEGREDO.pdf',NULL)`,[id]);
    await a.query("INSERT INTO ist_loja_categorias(id,nome,slug) VALUES(1,'Sintetica','sintetica')");
    await a.query(`INSERT INTO ist_loja_produtos(id,categoria_id,livro_id,sku,tipo,titulo,descricao,
        preco_centavos,moeda,em_venda,disponivel) VALUES(6,1,1,'COMERCIAL','DIGITAL','Comercial','{}',9500,'BRL',1,1)`);
    await a.execute(`INSERT INTO ist_loja_arquivo_versoes(id,public_id,produto_id,arquivo_logico_id,numero_versao,
        caminho_relativo,tamanho_bytes,sha256,mime,estado,publicacao_atual,criado_em,publicado_em)
        VALUES(1,?,6,?,1,'privado/SEGREDO.pdf',32,UNHEX(REPEAT('ab',32)),'application/pdf','PUBLICADA',1,'2026-01-01','2026-01-01')`,[randomUUID(),randomUUID()]);
    const compra=await fx.novaCompra({estado:'PAGO'});
    await a.execute(`INSERT INTO ist_loja_pedido_itens(pedido_id,produto_id,posicao,sku_snapshot,titulo_snapshot,
        descricao_snapshot,tipo_snapshot,quantidade,preco_unitario_centavos,subtotal_centavos)
        VALUES(?,6,1,'COMERCIAL','Historico','{}','E-Book',1,9500,9500)`,[compra.pedidoId]);
    const [pagamento]=await a.execute(`INSERT INTO ist_loja_pagamentos(public_id,pedido_id,provedor,ambiente,
        conta_recebedora,estado,reserva_ativa,moeda,valor_centavos,capturado_centavos,ordem_externa_id,
        captura_externa_id,criado_em,atualizado_em,expira_em)
        VALUES(?,?,'paypal','sandbox','CONTA-SINTETICA','CAPTURADO',1,'BRL',9500,9500,'ORDEM-SINTETICA',
        'CAPTURA-SINTETICA','2026-01-01','2026-01-01','2026-01-02')`,[randomUUID(),compra.pedidoId]);
    await a.execute(`INSERT INTO ist_loja_pagamento_operacoes(pagamento_id,pedido_id,acao,chave_idempotencia,
        solicitacao_hash,request_id_provedor,estado,tentativas,criado_em,atualizado_em)
        VALUES(?,?,'CAPTURAR',?,UNHEX(SHA2('sintetico',256)),?,'SUCESSO',1,'2026-01-01','2026-01-01')`,
    [pagamento.insertId,compra.pedidoId,randomUUID(),randomUUID()]);
    await a.execute(`INSERT INTO ist_loja_pagamento_eventos(pagamento_id,provedor,ambiente,conta_recebedora,
        origem,evento_id,tipo,conteudo_hash,evidencia_json,estado,recebido_em,autenticado_em,atualizado_em,processado_em)
        VALUES(?,'paypal','sandbox','CONTA-SINTETICA','API',?,'CAPTURADO',UNHEX(SHA2('sintetico',256)),
        '{}','PROCESSADO','2026-01-01','2026-01-01','2026-01-01','2026-01-01')`,[pagamento.insertId,randomUUID()]);
    const tabelas=['ist_loja_categorias','ist_loja_produtos','ist_loja_arquivo_versoes','ist_loja_sessoes',
        'ist_loja_pedidos','ist_loja_pedido_itens','ist_loja_pagamentos','ist_loja_pagamento_operacoes','ist_loja_pagamento_eventos',
        'ist_loja_download_direitos','ist_loja_download_direito_eventos'];
    const hashComercial=async()=>{
        const dados=[];for(const nome of tabelas)dados.push((await a.query(`SELECT * FROM ${nome} ORDER BY id`))[0]);
        return createHash('sha256').update(JSON.stringify(dados)).digest('hex');
    };
    const comercialOriginal=await hashComercial();
    const livro=async id=>(await a.execute('SELECT * FROM ist_livros WHERE id=?',[id]))[0][0];
    const eventos=[];
    // Somente identificadores e estados; nunca registrar SQL, linhas ou credenciais.
    const diagnostico=(estado,tipo,thread,detalhes={})=>{
        if(estado)t.diagnostic(`CONCORRENCIA: ${JSON.stringify({tipo,conexao:thread,...detalhes})}`);
    };
    const sinal=()=>{
        let resolver;const promise=new Promise(r=>{resolver=r;});
        const s={promise,resolve:v=>{barreiras.delete(s);resolver(v);}};barreiras.add(s);return s;
    };
    const aguardar=async promise=>{
        let timer;const timeout=new Promise((_,j)=>{timer=setTimeout(()=>j(Error('BARREIRA_TIMEOUT')),8000);});
        try{return await Promise.race([promise,timeout]);}finally{clearTimeout(timer);}
    };
    const db={query:(...args)=>pool.query(...args),getConnection:async()=>{
        const c=await pool.getConnection();conexoes.add(c);
        let thread;
        try {
            const id=await identificarConexao(c);thread=Number(id.id);
            assert.equal(id.usuario,observador.usuario,'USUARIO_CONEXAO_DIVERGENTE');
            assert.equal(id.hostname,observador.hostname,'INSTANCIA_CONEXAO_DIVERGENTE');
            assert.ok(Number.isSafeInteger(thread)&&thread>0);
            await c.query('SET SESSION innodb_lock_wait_timeout=15');
        }catch(e){conexoes.delete(c);c.destroy();throw e;}
        const lifecycle=tipo=>diagnostico(concorrencia,tipo,thread,
            {esperaComprovada:Boolean(concorrencia?.comprovado)});
        return {query:async(sql,args)=>{
            const disputa=concorrencia,locking=/FOR UPDATE/.test(sql);
            let papel;
            if(/FOR UPDATE/.test(sql)){
                assert.match(sql,/FROM ist_livros WHERE id=\? FOR UPDATE$/);
                if(disputa){
                    disputa.ids.push(thread);
                    assert.ok(disputa.ids.length<=2,'CONEXAO_CONCORRENTE_INESPERADA');
                    papel=disputa.ids.length===1?'A':'B';
                }
            }
            if(/ist_loja_produtos/.test(sql))assert.doesNotMatch(sql,/FOR UPDATE|LOCK IN SHARE MODE/);
            let r;
            try {
                const pendente=c.query(sql,args);
                if(locking&&disputa){
                    diagnostico(disputa,'LOCKING_READ_INVOCADO',thread,{papel});
                    if(papel==='B')disputa.bEnviado.resolve();
                }
                r=await pendente;
            }catch(e){
                if(locking&&disputa){
                    disputa[`${papel}Rejeitado`]=true;
                    diagnostico(disputa,'LOCKING_READ_REJEITADO',thread,{papel});
                }
                throw e;
            }
            eventos.push({thread,sql});
            if(locking&&disputa){
                disputa[`${papel}Concluido`]=true;
                diagnostico(disputa,'LOCKING_READ_CONCLUIDO',thread,
                    {papel,linhas:r[0].length,antesDaProva:!disputa.comprovado});
            }
            if(locking&&disputa&&papel==='A'){
                const [[transacao]]=await c.query('SELECT CONNECTION_ID() id,@@in_transaction ativa');
                assert.equal(Number(transacao.id),thread,'IDENTIDADE_A_DIVERGENTE');
                diagnostico(disputa,'TRANSACAO_A_APOS_LOCK',thread,{ativa:Number(transacao.ativa)===1});
                assert.equal(Number(transacao.ativa),1,'TRANSACAO_A_INATIVA_APOS_LOCK');
                disputa.aBloqueou.resolve();
                await aguardar(disputa.liberarA.promise);
                diagnostico(disputa,'BARREIRA_A_LIBERADA',thread,{esperaComprovada:Boolean(disputa.comprovado)});
            }
            if(sql.startsWith('UPDATE ist_livros')&&injetarErro){
                injetarErro=false;
                const [[local]]=await c.execute('SELECT title FROM ist_livros WHERE id=?',[args.at(-1)]);
                assert.equal(local.title,'UPDATE antes do erro');
                eventos.push({thread,sql:'UPDATE_CONFIRMADO_ANTES_ERRO'});
                try {await c.query('SELECT coluna_inexistente_sintetica FROM ist_livros');}
                catch(e){assert.equal(e.code,'ER_BAD_FIELD_ERROR');eventos.push({thread,sql:'ERRO_SQL_REAL'});throw e;}
                throw Error('ERRO_SQL_NAO_OCORREU');
            }
            return r;
        },commit:async()=>{lifecycle('COMMIT_INVOCADO');await c.commit();eventos.push({thread,sql:'COMMIT_CONFIRMADO'});lifecycle('COMMIT_CONFIRMADO');},
        rollback:async()=>{lifecycle('ROLLBACK_INVOCADO');await c.rollback();eventos.push({thread,sql:'ROLLBACK_CONFIRMADO'});lifecycle('ROLLBACK_CONFIRMADO');},
        release:()=>{lifecycle('CONEXAO_LIBERADA');conexoes.delete(c);c.release();},
        destroy:()=>{lifecycle('CONEXAO_DESCARTADA');conexoes.delete(c);c.destroy();}};
    }};
    const env={NODE_ENV:'test',COOKIE_NAME:'ist_session',JWT_SECRET:randomBytes(32).toString('hex'),
        LOJA_CSRF_SECRET:randomBytes(32).toString('base64url'),LOJA_ORIGENS_PERMITIDAS:'http://localhost:4200'};
    const app=express();app.use(cookieParser());app.use('/api/admin/loja',criarLojaAdminRouter({db,env}));
    servidor=await new Promise((r,j)=>{const s=app.listen(0,'127.0.0.1',()=>r(s));s.once('error',j);});
    const base=`http://127.0.0.1:${servidor.address().port}/api/admin/loja/livros/`;
    // Uma assinatura por identidade durante a rodada: nao depende do segundo do iat.
    const cookies=new Map();
    const cookie=id=>{
        if(!cookies.has(id))cookies.set(id,'ist_session='+jwt.sign(
            {id_usuario:id,id_tipo_usuario:1},env.JWT_SECRET,{expiresIn:3600}));
        return cookies.get(id);
    };
    const pedido=async(id,op={})=>{
        const headers={Cookie:cookie(7),...op.headers};for(const [k,v]of Object.entries(headers))if(v===null)delete headers[k];
        const r=await fetch(base+id,{method:op.method??'GET',headers,body:op.body===undefined?undefined:JSON.stringify(op.body),signal:AbortSignal.timeout(20000)});
        const texto=await r.text();assert.equal(r.headers.get('cache-control'),'no-store');
        assert.doesNotMatch(texto,/SEGREDO|privado\/|coluna_inexistente|ER_BAD_FIELD|stack|SELECT/);
        return {r,body:JSON.parse(texto)};
    };
    const contexto=async id=>{const x=await pedido(id);assert.equal(x.r.status,200);return {tag:x.body.item.revisao,csrf:x.r.headers.get('x-csrf-token'),item:x.body.item};};
    const patch=(id,body,ctx,headers={})=>pedido(id,{method:'PATCH',body,headers:{Origin:env.LOJA_ORIGENS_PERMITIDAS,
        'X-CSRF-Token':ctx.csrf,'If-Match':ctx.tag,'Content-Type':'application/json',...headers}});
    await t.test('PATCH parcial persiste e preserva todos os omitidos, legados e tabelas externas',async()=>{
        const antes=await livro(1),ctx=await contexto(1);
        const x=await patch(1,{title:'Título editado',category:'Música'},ctx);assert.equal(x.r.status,200);
        const depois=await livro(1);assert.equal(depois.title,'Título editado');assert.equal(depois.category,'Música');
        for(const [k,v]of Object.entries(antes))if(!['title','category'].includes(k))assert.deepEqual(depois[k],v,k);
        assert.equal(x.body.item.img,null);assert.notEqual(x.body.item.revisao,ctx.tag);
        assert.equal((await contexto(1)).tag,x.body.item.revisao);assert.equal(await hashComercial(),comercialOriginal);
    });
    await t.test('NULL permitido, livro sem produto e no-op sem UPDATE',async()=>{
        let ctx=await contexto(2);
        let x=await patch(2,{language:'pt-br',img:'assets/images/capa.png',pertenceEditoraIst:true},ctx);assert.equal(x.r.status,200);
        assert.equal(x.body.item.produtoId,null);ctx=await contexto(2);
        x=await patch(2,{language:null,img:null,pertenceEditoraIst:null},ctx);assert.equal(x.r.status,200);
        const estado=await livro(2);assert.equal(estado.language,null);assert.equal(estado.img,null);assert.equal(estado.pertence_editora_ist,null);
        ctx=await contexto(2);eventos.length=0;
        x=await patch(2,{title:estado.title},ctx);assert.equal(x.r.status,200);assert.equal(x.body.item.revisao,ctx.tag);
        assert(!eventos.some(e=>e.sql.startsWith('UPDATE')));assert.equal(await hashComercial(),comercialOriginal);
    });
    await t.test('rejeicoes de seguranca, corpo e If-Match nao alteram registros',async()=>{
        const antes=await livro(1),ctx=await contexto(1);
        for(const [body,headers,status]of [
            [{title:'X'},{Cookie:null},401],[{title:'X'},{Cookie:cookie(8)},403],
            [{title:'X'},{Origin:'https://evil.invalid'},403],[{title:'X'},{'X-CSRF-Token':'invalido'},403],
            [{format:'Livro Físico'},{},400],[{description:'X'},{},400],[{price:1},{},400],
            [{title:'X'},{'If-Match':null},428],[{title:'X'},{'If-Match':'invalido'},400],
            [{title:'X'},{'If-Match':'"'+'0'.repeat(64)+'"'},412]
        ])assert.equal((await patch(1,body,ctx,headers)).r.status,status);
        assert.deepEqual(await livro(1),antes);assert.equal(await hashComercial(),comercialOriginal);
        assert.equal((await patch(999,{title:'X'},ctx)).r.status,404);
    });
    await t.test('rollback real apos UPDATE confirmado na mesma conexao',async()=>{
        const ctx=await contexto(1),antes=await livro(1);eventos.length=0;injetarErro=true;
        try {
            const x=await patch(1,{title:'UPDATE antes do erro'},ctx);assert.equal(x.r.status,503);
            assert.equal(x.body.erro.codigo,'ADMIN_INDISPONIVEL');
            const update=eventos.find(e=>e.sql==='UPDATE_CONFIRMADO_ANTES_ERRO');assert(update);
            assert(eventos.some(e=>e.thread===update.thread&&e.sql==='ERRO_SQL_REAL'));
            assert(eventos.some(e=>e.thread===update.thread&&e.sql==='ROLLBACK_CONFIRMADO'));
            assert(!eventos.some(e=>e.sql==='COMMIT_CONFIRMADO'));
            assert.deepEqual(await livro(1),antes);assert.equal((await contexto(1)).tag,ctx.tag);
            assert.equal(await hashComercial(),comercialOriginal);
        }finally{injetarErro=false;}
    });
    await t.test('duas conexoes: espera InnoDB comprovada, COMMIT A e 412 B',async()=>{
        // PROCESS foi verificado explicitamente; consulta vazia verifica disponibilidade.
        const esperaSql=`SELECT r.trx_mysql_thread_id AS solicitante,b.trx_mysql_thread_id AS bloqueador
            FROM information_schema.INNODB_LOCK_WAITS w
            JOIN information_schema.INNODB_TRX r ON r.trx_id=w.requesting_trx_id
            JOIN information_schema.INNODB_TRX b ON b.trx_id=w.blocking_trx_id
            WHERE r.trx_mysql_thread_id=? AND b.trx_mysql_thread_id=?`;
        // Todas as leituras destas tabelas, inclusive diagnosticos, passam aqui.
        // Relogio monotônico evita intervalo menor que 200 ms por ajuste do relogio
        // civil ou disparo antecipado do timer. Nunca utilizar o tempo como prova.
        let ultimaLeituraInnoDB=process.hrtime.bigint();
        const lerInnoDB=async(sql,args,timeout)=>{
            try{return await a.query({sql,timeout},args);}
            finally{ultimaLeituraInnoDB=process.hrtime.bigint();}
        };
        const aguardarCache=async()=>{
            const intervalo=200_000_000n;
            while(process.hrtime.bigint()-ultimaLeituraInnoDB<intervalo&&!t.signal.aborted){
                const restante=intervalo-(process.hrtime.bigint()-ultimaLeituraInnoDB);
                if(restante>0n)await new Promise(r=>setTimeout(r,Math.ceil(Number(restante)/1e6)));
            }
        };
        try {await lerInnoDB(esperaSql,[0,0],3000);}
        catch {assert.fail('METADADOS_INNODB_INDISPONIVEIS: nao e possivel comprovar o lock');}
        const ctx=await contexto(1);eventos.length=0;
        const estado={ids:[],comprovado:false,aBloqueou:sinal(),bEnviado:sinal(),liberarA:sinal()};concorrencia=estado;
        const abortar=()=>{
            for(const s of [estado.liberarA,estado.aBloqueou,estado.bEnviado])s.resolve();
        };
        t.signal.addEventListener('abort',abortar,{once:true});
        let reqA,reqB;
        try {
            reqA=patch(1,{title:'Concorrente A'},ctx);reqA.catch(()=>{});
            await aguardar(estado.aBloqueou.promise);
            reqB=patch(1,{title:'Concorrente B'},ctx);reqB.catch(()=>{});
            await aguardar(estado.bEnviado.promise);
            // Exigir tambem 200 ms completos apos a invocacao de B, mesmo se
            // a consulta preliminar ocorreu ha mais tempo.
            ultimaLeituraInnoDB=process.hrtime.bigint();
            const [idA,idB]=estado.ids;assert.notEqual(idA,idB);
            assert.ok([idA,idB].every(id=>Number.isSafeInteger(id)&&id>0),'IDENTIDADES_A_B_INVALIDAS');
            let ultimoDiagnostico;
            let comprovado=false;const limite=Date.now()+6000;
            while(Date.now()<limite&&!t.signal.aborted){
                // Inclui a primeira observacao apos B; nenhuma leitura do cache
                // ocorre neste intervalo. As duas consultas formam um unico ciclo.
                await aguardarCache();
                if(Date.now()>=limite||t.signal.aborted)break;
                const [rows]=await lerInnoDB(esperaSql,[idB,idA],Math.min(2000,limite-Date.now()));
                // Observacao complementar, nunca substitui a relacao de espera acima.
                if(Date.now()>=limite||t.signal.aborted)break;
                const [transacoes]=await lerInnoDB(`SELECT trx_mysql_thread_id AS conexao,trx_state AS estado
                    FROM information_schema.INNODB_TRX WHERE trx_mysql_thread_id IN (?,?)`,[idA,idB],Math.min(2000,limite-Date.now()));
                const descrever=id=>{
                    const trx=transacoes.find(r=>Number(r.conexao)===id);
                    const estadoSeguro=['RUNNING','LOCK WAIT','ROLLING BACK','COMMITTING'].includes(trx?.estado)
                        ?trx.estado:(trx?'OUTRO':null);
                    return {conexao:id,presente:Boolean(trx),estado:estadoSeguro};
                };
                const espera=rows.some(r=>Number(r.solicitante)===idB&&Number(r.bloqueador)===idA);
                const observacao=JSON.stringify({A:descrever(idA),B:descrever(idB),esperaBA:espera,
                    bConcluido:Boolean(estado.BConcluido),bRejeitado:Boolean(estado.BRejeitado)});
                if(observacao!==ultimoDiagnostico){
                    t.diagnostic(`INNODB_A_B: ${observacao}`);ultimoDiagnostico=observacao;
                }
                if(espera){comprovado=true;estado.comprovado=true;break;}
                if(estado.BConcluido||estado.BRejeitado)break;
                // O proximo ciclo aguarda 200 ms desde o FIM do diagnostico SQL.
            }
            assert.equal(comprovado,true,'ESPERA_INNODB_NAO_COMPROVADA');
            assert(!eventos.some(e=>e.thread===idB&&e.sql.endsWith('FOR UPDATE')));
            estado.liberarA.resolve();
            const [x,y]=await Promise.all([reqA,reqB]);assert.equal(x.r.status,200);assert.equal(y.r.status,412);
            assert.equal((await livro(1)).title,'Concorrente A');
            assert(eventos.some(e=>e.thread===idA&&e.sql==='COMMIT_CONFIRMADO'));
            assert(!eventos.some(e=>e.thread===idB&&e.sql.startsWith('UPDATE')));
            assert.equal(eventos.filter(e=>e.sql.startsWith('UPDATE')).length,1);
            assert.equal((await contexto(1)).tag,x.body.item.revisao);
            assert.equal(await hashComercial(),comercialOriginal);
            t.diagnostic(`LOCK_REAL: conexoes independentes A=${idA}, B=${idB}; INNODB_LOCK_WAITS confirmou B aguardando A.`);
        }finally{
            // Liberar A antes de aguardar HTTP/SQL; manter diagnosticos ate as duas
            // requisicoes terminarem. Fetch e lock wait conservam seus limites.
            abortar();t.signal.removeEventListener('abort',abortar);
            await Promise.allSettled([reqA,reqB].filter(Boolean));
            concorrencia=null;
        }
    });
    t.diagnostic(`ADMIN_LIVRO_PATCH_SQL: ${identidade.versao}; host ${cfg.host}; porta ${cfg.port}; schema ${identidade.banco}; dados sinteticos; pool padrao bloqueado.`);
});
