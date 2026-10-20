import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {criarLojaDownloadAutorizacaoService} from '../src/services/lojaDownloadAutorizacaoService.js';
import {lerCookieLoja} from '../src/middlewares/lojaSessaoMiddleware.js';
import {criarFixtureDireitos,contextoDireitos as contexto} from './fixtures/lojaDownloadDireitosFixture.js';
import {criarLojaDownloadDireitosService} from '../src/services/lojaDownloadDireitosService.js';

const agora=()=>new Date('2026-01-01T13:00:00.000Z');
test('configuracao e entradas invalidas nao abrem conexao; cookies duplicados sao rejeitados pelo contrato existente',async()=>{
    assert.throws(()=>criarLojaDownloadAutorizacaoService(),{codigo:'ENTRADA_INVALIDA'});
    let chamadas=0;const svc=criarLojaDownloadAutorizacaoService({db:{getConnection(){chamadas++;throw Error();}},contextoEsperado:contexto});
    const token=randomBytes(32).toString('base64url');
    for(const t of [undefined,'', 'invalido',lerCookieLoja({headers:{cookie:`ist-loja-dev=${token}; ist-loja-dev=${token}`}},'ist-loja-dev')])
        await assert.rejects(svc.listarDireitosDaSessao(t),{codigo:'SESSAO_INVALIDA'});
    for(const limite of [0,51,1.5])await assert.rejects(svc.listarDireitosDaSessao(token,{limite}),{codigo:'ENTRADA_INVALIDA'});
    await assert.rejects(svc.localizarDireitoDaSessao(token,'SKU'),{codigo:'ENTRADA_INVALIDA'});assert.equal(chamadas,0);
});

test('D6-B1 autorizacao interna em MariaDB descartavel',{
    skip:!process.env.IST_LOJA_PAGAMENTOS_MARIADB_BIN&&!process.env.IST_R2_10339_MANIFEST,timeout:180000
},async t=>{
    const f=await criarFixtureDireitos(t),{a,pool}=f;
    const preparar=async(opcoes={})=>{
        const x=await f.preparar(opcoes),token=randomBytes(32).toString('base64url');
        await a.execute('UPDATE ist_loja_sessoes SET token_hash=? WHERE id=?',[createHash('sha256').update(token).digest(),x.sessaoId]);
        const {direitos}=await f.ler(x);return {...x,token,publicId:direitos[0]?.public_id};
    };
    const svc=(db=pool,clock=agora,c=contexto)=>criarLojaDownloadAutorizacaoService({db,contextoEsperado:c,agora:clock});
    const autorizar=async(x,s=svc())=>{
        const c=await pool.getConnection();try{
            await c.query('SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED');await c.beginTransaction();
            return await s.autorizarArquivoNaConexao(c,x.token,x.publicId);
        }finally{await c.rollback();c.release();}
    };
    const snapshot=async x=>{
        const rs=[];
        for(const [tab,col,n]of [['ist_loja_sessoes','id',x.sessaoId],['ist_loja_pedidos','id',x.pedidoId],['ist_loja_pedido_itens','pedido_id',x.pedidoId],
            ['ist_loja_pagamentos','pedido_id',x.pedidoId],['ist_loja_pagamento_operacoes','pedido_id',x.pedidoId],['ist_loja_pagamento_eventos','pagamento_id',x.pagamentoId]])
            rs.push((await a.query(`SELECT * FROM ${tab} WHERE ${col}=? ORDER BY id`,[n]))[0]);
        rs.push(await f.ler(x));rs.push((await a.query('SELECT * FROM ist_loja_arquivo_versoes ORDER BY id'))[0]);
        return createHash('sha256').update(JSON.stringify(rs)).digest('hex');
    };
    await t.test('listagem e localizacao pertencem a sessao, nao expõem dados privados e nao escrevem',async()=>{
        const x=await preparar({estadoDireito:'ATIVO'}),antes=await snapshot(x),s=svc();
        const r=await s.listarDireitosDaSessao(x.token);assert.equal(r.direitos.length,2);assert(r.direitos.every(d=>d.estado==='ATIVO'&&d.podeSolicitarArquivo));
        assert.deepEqual(Object.keys(r.direitos[0]),['publicId','titulo','estado','podeSolicitarArquivo']);
        assert.doesNotMatch(JSON.stringify(r),/caminho|sha256|email|pagamento|captura|pedidoId|arquivoVersaoId|token/);
        assert.equal((await s.localizarDireitoDaSessao(x.token,x.publicId)).pedidoId,x.pedidoId);
        assert.deepEqual(await s.listarDireitosDaSessao(x.token),r);assert.equal(await snapshot(x),antes);
    });
    await t.test('token falsificado, sessao expirada e revogada nao autorizam',async()=>{
        const x=await preparar({estadoDireito:'ATIVO'});
        await assert.rejects(svc().listarDireitosDaSessao(randomBytes(32).toString('base64url')),{codigo:'SESSAO_INVALIDA'});
        await assert.rejects(autorizar(x,svc(pool,()=>new Date('2026-01-02T00:00:00.000Z'))),{codigo:'SESSAO_INVALIDA'});
        await a.execute("UPDATE ist_loja_sessoes SET revogada_em='2026-01-01 12:30:00' WHERE id=?",[x.sessaoId]);const antes=await snapshot(x);
        await assert.rejects(autorizar(x),{codigo:'SESSAO_INVALIDA'});assert.equal(await snapshot(x),antes);
    });
    await t.test('inexistente e outra sessao produzem o mesmo erro; SQL inclui sessao e token_hash',async()=>{
        const x=await preparar({estadoDireito:'ATIVO'}),y=await preparar({estadoDireito:'ATIVO'}),calls=[];
        const db={async getConnection(){const c=await pool.getConnection();return {
            query:(sql,p)=>{calls.push([sql,p]);return c.query(sql,p);},beginTransaction:()=>c.beginTransaction(),commit:()=>c.commit(),rollback:()=>c.rollback(),release:()=>c.release(),destroy:()=>c.destroy()
        };}};
        for(const id of [y.publicId,randomUUID()])await assert.rejects(svc(db).localizarDireitoDaSessao(x.token,id),{codigo:'DIREITO_NAO_ENCONTRADO'});
        for(const [sql]of calls.filter(([sql])=>sql.includes('WHERE d.public_id=?'))){assert.match(sql,/p\.sessao_id=\?/);assert.match(sql,/s\.token_hash=\?/);}
        await assert.rejects(autorizar({...x,publicId:y.publicId}),{codigo:'DIREITO_NAO_ENCONTRADO'});
    });
    await t.test('paginacao limitada e deterministica, sem cursor interno ou duplicatas',async()=>{
        const x=await preparar(),s=svc(),primeira=await s.listarDireitosDaSessao(x.token,{limite:1});
        assert.equal(primeira.direitos.length,1);assert.equal(primeira.proximoCursor,primeira.direitos[0].publicId);
        const segunda=await s.listarDireitosDaSessao(x.token,{limite:1,apos:primeira.proximoCursor});
        assert.equal(segunda.direitos.length,1);assert.equal(segunda.proximoCursor,null);assert.notEqual(segunda.direitos[0].publicId,primeira.direitos[0].publicId);
        assert.deepEqual(await s.listarDireitosDaSessao(x.token,{limite:1}),primeira);
    });
    for(const estadoDireito of ['AGUARDANDO_CONFIRMACAO','SUSPENSO','REVOGADO'])await t.test(`estado ${estadoDireito} nunca autoriza nem sofre transicao`,async()=>{
        const x=await preparar({estadoDireito}),antes=await snapshot(x);
        await assert.rejects(autorizar(x),{codigo:'DIREITO_INDISPONIVEL'});assert.equal(await snapshot(x),antes);
    });
    await t.test('ATIVO com captura consistente e versao retirada retorna somente metadados internos',async()=>{
        const x=await preparar({estadoDireito:'ATIVO'}),antes=await snapshot(x),c=await pool.getConnection();
        try{
            await c.query('SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED');await c.beginTransaction();
            const r=await svc().autorizarArquivoNaConexao(c,x.token,x.publicId);
            assert.equal(r.mime,'application/pdf');assert.equal(r.arquivoVersaoId,1);assert.equal(r.tamanhoBytes,'32');assert.equal(r.sha256.length,32);
            assert.equal(r.caminhoRelativo,'sintetico-1.pdf');assert.equal(Number((await c.query('SELECT @@in_transaction n'))[0][0].n),1);
            assert.deepEqual(await svc().autorizarArquivoNaConexao(c,x.token,x.publicId),r);
        }finally{await c.rollback();c.release();}
        assert.equal(await snapshot(x),antes);
    });
    for(const caso of ['adverso','insuficiente','recebedor','live'])await t.test(`ATIVO nao basta: ${caso}`,async()=>{
        const x=await preparar({estadoDireito:'ATIVO'});
        if(caso==='adverso')await a.execute('UPDATE ist_loja_pagamentos SET reembolsado_centavos=50 WHERE id=?',[x.pagamentoId]);
        if(caso==='insuficiente')await a.execute('UPDATE ist_loja_pagamento_operacoes SET resultado_json=NULL WHERE id=?',[x.operacaoId]);
        const s=svc(pool,agora,caso==='live'?{...contexto,ambiente:'live'}:caso==='recebedor'?{...contexto,contaRecebedora:'OUTRO'}:contexto),antes=await snapshot(x);
        await assert.rejects(autorizar(x,s),{codigo:'FINANCEIRO_INDISPONIVEL'});assert.equal(await snapshot(x),antes);
    });
    await t.test('historico e Sandbox sem direito nao recebem backfill',async()=>{
        const x=await preparar({semDireitos:true}),antes=await snapshot(x);
        assert.deepEqual(await svc().listarDireitosDaSessao(x.token),{direitos:[],proximoCursor:null});
        await assert.rejects(svc().localizarDireitoDaSessao(x.token,randomUUID()),{codigo:'DIREITO_NAO_ENCONTRADO'});assert.equal(await snapshot(x),antes);
    });
    await t.test('erro SQL e estado transacional invalido sao sanitizados e nao geram autorizacao',async()=>{
        const x=await preparar({estadoDireito:'ATIVO'}),c=await pool.getConnection();
        try{
            await assert.rejects(svc().autorizarArquivoNaConexao(c,x.token,x.publicId),{codigo:'TRANSACAO_INVALIDA'});
            await c.query('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ');await c.beginTransaction();
            await assert.rejects(svc().autorizarArquivoNaConexao(c,x.token,x.publicId),{codigo:'TRANSACAO_INVALIDA'});await c.rollback();
            await c.query('SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED');await c.beginTransaction();
            const erro={query(sql,p){if(sql.includes('FROM ist_loja_pagamentos'))throw Error('SQL senha /privado token');return c.query(sql,p);}};
            await assert.rejects(svc().autorizarArquivoNaConexao(erro,x.token,x.publicId),e=>e.codigo==='AUTORIZACAO_INDISPONIVEL'&&!/senha|privado|token/.test(e.message));
        }finally{await c.rollback();c.release();}
    });
    await t.test('revogacao enquanto aguarda lock e revalidada pelo servico de sessao existente',async()=>{
        const x=await preparar({estadoDireito:'ATIVO'}),w=await pool.getConnection();let terminou=false;
        try{
            await w.beginTransaction();await w.query("UPDATE ist_loja_sessoes SET revogada_em='2026-01-01 12:30:00' WHERE id=?",[x.sessaoId]);
            const exec=autorizar(x).then(()=>({autorizado:true}),e=>({codigo:e.codigo})).then(r=>{terminou=true;return r;});
            await new Promise(r=>setTimeout(r,80));assert.equal(terminou,false);await w.commit();assert.deepEqual(await exec,{codigo:'SESSAO_INVALIDA'});
        }finally{await w.rollback();w.release();}
    });
    await t.test('autorizacao concorrente com suspensao aguarda e nega estado atualizado',async()=>{
        const x=await preparar({estadoDireito:'ATIVO'});await a.execute('UPDATE ist_loja_pagamentos SET reembolsado_centavos=50 WHERE id=?',[x.pagamentoId]);
        let liberar,atingiu,pausar=true;const espera=new Promise(r=>liberar=r),pronto=new Promise(r=>atingiu=r);
        const db={async getConnection(){const c=await pool.getConnection();return {
            query:async(sql,p)=>{if(pausar&&sql.startsWith('UPDATE ist_loja_download_direitos')){pausar=false;atingiu();await espera;}return c.query(sql,p);},
            beginTransaction:()=>c.beginTransaction(),commit:()=>c.commit(),rollback:()=>c.rollback(),release:()=>c.release(),destroy:()=>c.destroy()
        };}};
        const writer=criarLojaDownloadDireitosService({db,agora}).reavaliarDireitosDoPedido(x.pedidoId,contexto);await pronto;
        let terminou=false;const exec=autorizar(x).then(()=>({autorizado:true}),e=>({codigo:e.codigo})).then(r=>{terminou=true;return r;});
        try{await new Promise(r=>setTimeout(r,80));assert.equal(terminou,false);}finally{liberar();}
        await writer;assert.deepEqual(await exec,{codigo:'DIREITO_INDISPONIVEL'});
    });
    t.diagnostic(`D6-B1: ${f.identidade.versao}; schema ${f.identidade.banco}; porta ${f.identidade.porta}; sem leitura de PDFs ou escrita da autorizacao.`);
});
