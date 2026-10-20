import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import mysql from 'mysql2/promise';
import {expandirCatalogoSintetico} from './fixtures/lojaCatalogoComercialFixture.js';
import {criarPagamentoSimulado} from './fixtures/lojaPagamentoSimulado.js';
import {criarLojaArquivoService} from '../src/services/lojaArquivoService.js';
import {criarLojaPedidoService} from '../src/services/lojaPedidoService.js';
import {criarLojaPagamentoService} from '../src/services/lojaPagamentoService.js';
import {avaliarElegibilidadeFinanceiraNaConexao} from '../src/services/lojaDownloadFinanceiroService.js';
import {criarLojaDownloadDireitosService} from '../src/services/lojaDownloadDireitosService.js';
import {criarLojaDownloadAutorizacaoService} from '../src/services/lojaDownloadAutorizacaoService.js';
import {hashTokenSessao} from '../src/services/lojaSessaoService.js';
import {criarDiagnosticoFinanceiroTeste} from './fixtures/lojaFinanceiroDiagnostico.js';

test('B3-B3 percurso integrado real em MariaDB com provedor exclusivamente simulado',{
    skip:!process.env.IST_LOJA_PAGAMENTOS_MARIADB_BIN&&!process.env.IST_R2_10339_MANIFEST,timeout:180000
},async t=>{
    process.env.NODE_ENV='test';
    const antigo=Boolean(process.env.IST_R2_10339_MANIFEST);
    const {criarBancoPagamentoIsolado}=await import(antigo?'./fixtures/lojaCatalogoMariaDB10339.js':'./fixtures/lojaPagamentoBancoIsolado.js');
    const fx=await criarBancoPagamentoIsolado(t),a=fx.admin;
    const [[ident]]=await a.query('SELECT VERSION() versao,DATABASE() banco,@@port porta,@@datadir datadir,@@foreign_key_checks fk,@@check_constraint_checks ck');
    assert.match(ident.versao,antigo?/^10\.3\.39-MariaDB/:/^13\.0\.2-MariaDB/);assert.equal(Number(ident.fk),1);assert.equal(Number(ident.ck),1);
    const cfg=a.config??a.connection.config;
    const pool=fx.pool??mysql.createPool({host:cfg.host,port:cfg.port,user:cfg.user,password:cfg.password,database:ident.banco,dateStrings:true,supportBigNumbers:true,bigNumberStrings:true,connectionLimit:10});
    if(!fx.pool)t.after(()=>pool.end());
    const [[ambienteF2]]=await a.query('SELECT @@tx_isolation isolamento,@@max_connections maxConexoes,@@innodb_lock_wait_timeout lockWaitTimeout');
    t.diagnostic('F2_AMBIENTE='+JSON.stringify({...ambienteF2,versao:ident.versao,poolLimite:(pool.pool??pool).config.connectionLimit}));
    await a.query(`ALTER TABLE ist_livros ADD title TEXT,ADD description LONGTEXT,ADD price DECIMAL(5,2),ADD currency CHAR(3),
        ADD onsale INT,ADD format VARCHAR(32),ADD inventory VARCHAR(32),ADD file TEXT,ADD language VARCHAR(5)`);
    await a.query("INSERT INTO ist_loja_categorias(id,nome,slug) VALUES(1,'Sintetico','sintetico')");
    for(const id of [1,2,3])await a.execute(`INSERT INTO ist_livros(id,title,description,price,currency,onsale,format,inventory,file)
        VALUES(?,?,'{}',?,'BRL',1,'E-Book','Em estoque',NULL)`,[id,`Sintetico ${id}`,id===3?'1.00':'95.00']);
    await a.query("INSERT INTO ist_loja_produtos(id,categoria_id,livro_id,sku) VALUES(1,1,1,'SINT-1'),(2,1,2,'SINT-2'),(6,1,3,'IST-SANDBOX-CHECKOUT-001')");
    await expandirCatalogoSintetico(a,{publicar:false});
    const db={async getConnection(){const c=await pool.getConnection();return {
        query:(sql,args)=>c.query({sql,typeCast:(f,next)=>{if(f.type!=='LONGLONG')return next();const s=f.string();return s===null?null:Number.isSafeInteger(Number(s))?Number(s):s;}},args),
        execute:(...args)=>c.execute(...args),beginTransaction:()=>c.beginTransaction(),commit:()=>c.commit(),rollback:()=>c.rollback(),release:()=>c.release(),destroy:()=>c.destroy()
    };}};
    const agora=()=>new Date('2026-01-01T12:00:00.000Z'),contexto={provedor:'paypal',ambiente:'sandbox',contaRecebedora:'RECEBEDOR-SINTETICO'};
    const raiz=await mkdtemp(path.join(tmpdir(),'ist-homologacao-direitos-'));t.after(()=>rm(raiz,{recursive:true}));
    const arquivos=criarLojaArquivoService({db:pool,raizPrivada:raiz,agora}),logico=randomUUID();
    const publicar=async(nome,esperada=null)=>{
        await writeFile(path.join(raiz,nome),'%PDF-1.7\nHOMOLOGACAO EXCLUSIVAMENTE SINTETICA\n%%EOF');
        const v=await arquivos.registrarRascunho({produtoId:1,registroPublicId:randomUUID(),arquivoLogicoId:logico,caminhoRelativo:nome});
        await arquivos.publicar({produtoId:1,versaoPublicId:v.versaoPublicId,publicacaoAtualEsperada:esperada});return v;
    };
    const v1=await publicar('v1.pdf');
    const pedidos=criarLojaPedidoService({db,agora,contextoComercial:{ambienteBackend:'test',ambientePaypal:'sandbox'}});
    let casoAtual='preparacao';
    const diagnostico=criarDiagnosticoFinanceiroTeste({db:pool,registrar:s=>t.diagnostic(s),obterCaso:()=>casoAtual});
    const direitos=criarLojaDownloadDireitosService({db:diagnostico.db,agora});
    t.after(()=>t.diagnostic('F2_POOL='+JSON.stringify(diagnostico.resumo())));
    const repeticoes=Number(process.env.IST_D6_F2_REPETICOES??1);
    assert(Number.isInteger(repeticoes)&&repeticoes>=1&&repeticoes<=10);
    const compra=async(produtoId=1)=>{
        const c=await fx.novaCompra();await a.execute("UPDATE ist_loja_sessoes SET criada_em='2026-01-01',expira_em='2026-01-02' WHERE id=?",[c.sessao.id]);
        const chave=randomUUID(),entrada={produtoIds:[produtoId],compradorEmail:'sintetico@example.invalid'};
        const pedido=await pedidos.criarPedido(c.sessao,entrada,chave);
        const [[p]]=await a.execute('SELECT id FROM ist_loja_pedidos WHERE public_id=?',[pedido.publicId]);
        const sim=criarPagamentoSimulado({agora});
        const adaptador={...sim.adaptador,async reconciliar(args){
            const resultado=await sim.adaptador.consultar(args);return {resultado,observacao:{evidencia:'PRESENTE',associacaoOrdem:'CONFIRMADA',validacao:'CONSISTENTE',
                statusOrdem:'COMPLETED',statusCaptura:resultado.estado==='CAPTURADO'?'COMPLETED':'PENDING',motivoPendencia:resultado.estado==='PENDENTE'?'PENDING_REVIEW':null}};
        }};
        const financeiro=criarLojaPagamentoService({db:pool,contexto,adaptador,agora});
        return {...c,pedido,pedidoId:p.id,sim,financeiro,chave,entrada};
    };
    const dados=async x=>{
        const [ds]=await a.execute(`SELECT d.* FROM ist_loja_download_direitos d JOIN ist_loja_pedido_itens i ON i.id=d.pedido_item_id WHERE i.pedido_id=? ORDER BY d.id`,[x.pedidoId]);
        const [es]=await a.execute(`SELECT e.* FROM ist_loja_download_direito_eventos e JOIN ist_loja_download_direitos d ON d.id=e.direito_id
            JOIN ist_loja_pedido_itens i ON i.id=d.pedido_item_id WHERE i.pedido_id=? ORDER BY e.direito_versao`,[x.pedidoId]);return {ds,es};
    };
    const capturar=async(x,modo='integral')=>{
        const pg=await x.financeiro.criarTentativa(x.sessao,{pedidoPublicId:x.pedido.publicId},randomUUID());x.pg=pg;
        x.sim.aprovado(pg.publicId);x.sim.modos.captura=modo;
        return x.financeiro.capturar(x.sessao,{pagamentoPublicId:pg.publicId},randomUUID());
    };
    const reavaliar=async x=>{
        diagnostico.iniciarOperacao();
        try{return await direitos.reavaliarDireitosDoPedido(x.pedidoId,contexto);}
        catch(e){await diagnostico.registrarErroFacade(e);throw e;}
    };
    const financeiroSnapshot=async x=>{
        const rows=[];for(const tabela of ['ist_loja_pedidos','ist_loja_pedido_itens','ist_loja_pagamentos','ist_loja_pagamento_operacoes'])
            rows.push((await a.execute(`SELECT * FROM ${tabela} WHERE ${tabela==='ist_loja_pedidos'?'id':'pedido_id'}=? ORDER BY id`,[x.pedidoId]))[0]);
        rows.push((await a.execute(`SELECT e.* FROM ist_loja_pagamento_eventos e JOIN ist_loja_pagamentos p ON p.id=e.pagamento_id WHERE p.pedido_id=? ORDER BY e.id`,[x.pedidoId]))[0]);
        return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
    };
    // Parar a rodada imediatamente se aparecer defeito; nao mascarar alterando producao.
    const caso=async(nome,fn)=>{casoAtual=nome;let falhou=false;await t.test(nome,async()=>{try{await fn();}catch(e){falhou=true;throw e;}});if(falhou)throw Error('HOMOLOGACAO_INTERROMPIDA: analisar falha antes de prosseguir.');};
    let pago;
    await caso('publicacao -> pedido -> captura do nucleo -> avaliador -> ativacao atomica',async()=>{
        pago=await compra();let r=await dados(pago);assert.equal(r.ds[0].estado,'AGUARDANDO_CONFIRMACAO');assert.equal(r.es[0].origem,'PEDIDO');assert.equal(r.es[0].direito_versao,1);
        assert.equal((await capturar(pago)).estado,'CAPTURADO');const antes=await financeiroSnapshot(pago);
        const result=await reavaliar(pago);assert.equal(result.avaliacao.classificacao,'ELEGIVEL');assert.equal(result.transicoes.length,1);
        r=await dados(pago);assert.equal(r.ds[0].estado,'ATIVO');assert.equal(r.es[1].estado_anterior,'AGUARDANDO_CONFIRMACAO');assert.equal(r.es[1].estado_novo,'ATIVO');
        assert.equal(r.es[1].direito_versao,2);assert.equal(r.es[1].origem,'FINANCEIRO');assert.equal(r.es[1].motivo_codigo,'CAPTURA_CONFIRMADA');
        assert.deepEqual((await reavaliar(pago)).transicoes,[]);assert.deepEqual(await dados(pago),r);assert.equal(await financeiroSnapshot(pago),antes);
    });
    for(const [modo,estado]of [['pendente','PENDENTE'],['recusada','RECUSADO'],['valorDivergente','REVISAO'],['moedaDivergente','REVISAO'],['recebedorDivergente','REVISAO']])await caso(`captura simulada ${modo} nao ativa`,async()=>{
        const x=await compra();assert.equal((await capturar(x,modo)).estado,estado);const antes=await financeiroSnapshot(x),r=await reavaliar(x);
        assert.equal(r.avaliacao.elegivel,false);assert.notEqual((await dados(x)).ds[0].estado,'ATIVO');assert.equal(await financeiroSnapshot(x),antes);
        if(modo==='pendente')assert.equal(r.transicoes.length,0);
    });
    await caso('PENDING -> COMPLETED por reconciliacao do nucleo sem segunda captura',async()=>{
        const x=await compra();await capturar(x,'pendente');assert.equal((await reavaliar(x)).transicoes.length,0);
        x.sim.concluirPendente(x.pg.publicId);assert.equal((await x.financeiro.reconciliar(x.sessao,{pagamentoPublicId:x.pg.publicId})).estado,'CAPTURADO');
        assert.equal((await reavaliar(x)).avaliacao.elegivel,true);assert.equal((await dados(x)).ds[0].estado,'ATIVO');assert.equal(x.sim.chamadas.capturar,1);
    });
    await caso('nova publicacao nao troca PDF adquirido nem replay do pedido',async()=>{
        const antes=await dados(pago),pedidoAtual=await pedidos.criarPedido(pago.sessao,pago.entrada,pago.chave);
        await publicar('v2.pdf',v1.versaoPublicId);
        assert.deepEqual(await pedidos.criarPedido(pago.sessao,pago.entrada,pago.chave),pedidoAtual);assert.deepEqual((await reavaliar(pago)).transicoes,[]);
        assert.deepEqual(await dados(pago),antes);
    });
    for(const motivo of ['reembolso-parcial','reembolso-total','disputa','contradicao','insuficiente',...Array(repeticoes-1).fill('disputa')])await caso(`direito ATIVO diante de ${motivo} fica bloqueado`,async()=>{
        const x=await compra();await capturar(x);await reavaliar(x);
        if(motivo==='disputa')assert.equal((await dados(x)).ds[0].estado,'ATIVO');
        const [[pg]]=await a.execute('SELECT id FROM ist_loja_pagamentos WHERE public_id=?',[x.pg.publicId]);
        if(motivo.startsWith('reembolso'))await a.execute('UPDATE ist_loja_pagamentos SET reembolsado_centavos=? WHERE id=?',[motivo==='reembolso-parcial'?50:9500,pg.id]);
        if(motivo==='contradicao')await a.execute('UPDATE ist_loja_pagamentos SET capturado_centavos=9499 WHERE id=?',[pg.id]);
        if(motivo==='insuficiente')await a.execute("UPDATE ist_loja_pagamento_operacoes SET resultado_json=NULL WHERE pagamento_id=? AND acao='CAPTURAR'",[pg.id]);
        if(motivo==='disputa'){
            const envelope={resultado:{estado:'DESCONHECIDO',referencia:x.pg.publicId,ordemId:null,capturaId:null,valorCentavos:null,moeda:null,contaRecebedora:null,ambiente:'sandbox',capturadoEm:null},
                observacao:{evidencia:'PRESENTE',associacaoOrdem:'CONFIRMADA',validacao:'INCONCLUSIVA',statusOrdem:'COMPLETED',statusCaptura:'PENDING',motivoPendencia:'BUYER_COMPLAINT'}};
            await a.execute(`INSERT INTO ist_loja_pagamento_eventos(pagamento_id,provedor,ambiente,conta_recebedora,origem,evento_id,tipo,conteudo_hash,
                evidencia_json,estado,recebido_em,autenticado_em,atualizado_em,processado_em) VALUES(?,'paypal','sandbox',?,'RECONCILIACAO',?,'DESCONHECIDO',?,?,'PROCESSADO','2026-01-01 12:00:00','2026-01-01 12:00:00','2026-01-01 12:00:00','2026-01-01 12:00:00')`,
            [pg.id,contexto.contaRecebedora,randomUUID(),Buffer.alloc(32,1),JSON.stringify(envelope)]);
        }
        const antes=await financeiroSnapshot(x),r=await reavaliar(x);assert.equal(r.avaliacao.elegivel,false);assert.equal((await dados(x)).ds[0].estado,'SUSPENSO');assert.equal(await financeiroSnapshot(x),antes);
        if(motivo==='disputa'){
            assert(r.avaliacao.evidenciaAdversaPersistida.length>0);
            const d=await dados(x);assert.equal(d.es.at(-1).estado_novo,'SUSPENSO');assert.equal(d.es.at(-1).origem,'FINANCEIRO');
            // Sessao legitima somente sintetica para confirmar bloqueio D6-B1.
            const token=randomBytes(32).toString('base64url');
            const [[sessaoOriginal]]=await a.execute('SELECT token_hash FROM ist_loja_sessoes WHERE id=?',[x.sessao.id]);
            await a.execute('UPDATE ist_loja_sessoes SET token_hash=? WHERE id=?',[hashTokenSessao(token),x.sessao.id]);
            const c=await pool.getConnection();
            try{await c.query('SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED');await c.beginTransaction();
                await assert.rejects(criarLojaDownloadAutorizacaoService({db:pool,contextoEsperado:contexto,agora})
                    .autorizarArquivoNaConexao(c,token,d.ds[0].public_id),{codigo:'DIREITO_INDISPONIVEL'});
            }finally{await c.rollback();await c.query('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ');c.release();
                await a.execute('UPDATE ist_loja_sessoes SET token_hash=? WHERE id=?',[sessaoOriginal.token_hash,x.sessao.id]);}
        }
        const estavel=await dados(x);assert.deepEqual((await reavaliar(x)).transicoes,[]);assert.deepEqual(await dados(x),estavel);
    });
    await caso('CHECK, FKs compostas, UNIQUE e isolamento ativos na instancia identificada',async()=>{
        const [dds]=await a.query("SELECT id,produto_id,arquivo_versao_id FROM ist_loja_download_direitos ORDER BY id LIMIT 1");const d=dds[0];
        await assert.rejects(a.execute('UPDATE ist_loja_download_direitos SET estado=\'INVALIDO\' WHERE id=?',[d.id]));
        await assert.rejects(a.execute('UPDATE ist_loja_download_direitos SET produto_id=2 WHERE id=?',[d.id]),{code:'ER_NO_REFERENCED_ROW_2'});
        const [[q]]=await a.execute('SELECT COUNT(*) n FROM ist_loja_download_direito_eventos WHERE direito_id=?',[d.id]);assert(Number(q.n)>=2);
        await assert.rejects(a.execute(`INSERT INTO ist_loja_download_direito_eventos(direito_id,direito_versao,estado_anterior,estado_novo,origem,motivo_codigo,ocorrido_em)
            SELECT direito_id,direito_versao,estado_anterior,estado_novo,origem,motivo_codigo,ocorrido_em
            FROM ist_loja_download_direito_eventos WHERE direito_id=? LIMIT 1`,[d.id]),{code:'ER_DUP_ENTRY'});
        await assert.rejects(a.execute('UPDATE ist_loja_download_direitos SET arquivo_versao_id=4294967295 WHERE id=?',[d.id]),{code:'ER_NO_REFERENCED_ROW_2'});
        const [[fks]]=await a.query(`SELECT COUNT(*) n FROM information_schema.table_constraints WHERE constraint_schema=DATABASE()
            AND table_name IN ('ist_loja_arquivo_versoes','ist_loja_download_direitos','ist_loja_download_direito_eventos') AND constraint_type='FOREIGN KEY'`);
        assert.equal(Number(fks.n),4);
    });
    await caso('deadlock InnoDB real entre duas conexoes e rollback sem alterar direitos',async()=>{
        const outro=await compra(),id1=(await dados(pago)).ds[0].id,id2=(await dados(outro)).ds[0].id;
        const antes1=await dados(pago),antes2=await dados(outro),c1=await pool.getConnection(),c2=await pool.getConnection();
        try{
            await c1.beginTransaction();await c2.beginTransaction();
            // Inversao deliberada somente no teste para provocar o detector InnoDB.
            await c1.query('SELECT id FROM ist_loja_download_direitos WHERE id=? FOR UPDATE',[id1]);
            await c2.query('SELECT id FROM ist_loja_download_direitos WHERE id=? FOR UPDATE',[id2]);
            const r=await Promise.allSettled([
                c1.query('SELECT id FROM ist_loja_download_direitos WHERE id=? FOR UPDATE',[id2]),
                c2.query('SELECT id FROM ist_loja_download_direitos WHERE id=? FOR UPDATE',[id1])]);
            assert.equal(r.filter(x=>x.status==='rejected'&&x.reason.errno===1213).length,1);
            assert.equal(r.filter(x=>x.status==='fulfilled').length,1);
        }finally{await c1.rollback();await c2.rollback();c1.release();c2.release();}
        assert.deepEqual(await dados(pago),antes1);assert.deepEqual(await dados(outro),antes2);
        assert.deepEqual((await reavaliar(pago)).transicoes,[]);
    });
    await caso('Sandbox sem arquivo e historico sem direitos nao recebem backfill; Live bloqueado',async()=>{
        const x=await compra(6);await capturar(x);assert.equal((await reavaliar(x)).avaliacao.elegivel,false);assert.deepEqual((await dados(x)).ds,[]);
        await assert.rejects(direitos.reavaliarDireitosDoPedido(pago.pedidoId,{...contexto,ambiente:'live'}),{codigo:'CONTEXTO_DIVERGENTE'});
    });
    t.diagnostic(`HOMOLOGACAO_INTEGRADA: ${ident.versao}; schema ${ident.banco}; porta ${ident.porta}; FK=${ident.fk}; CHECK=${ident.ck}.`);
});
