import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomBytes,createHash,createHmac,randomUUID} from 'node:crypto';
import {criarLojaDownloadRecuperacaoService,CONTRATO_RECUPERACAO} from '../src/services/lojaDownloadRecuperacaoService.js';
import {criarFixtureDireitos,contextoDireitos} from './fixtures/lojaDownloadDireitosFixture.js';

const chave=randomBytes(32), inicio=Date.parse('2026-01-01T13:00:00.000Z');
const hash=(tipo,token)=>createHash('sha256').update(`ist-loja/recuperacao/${tipo}/v1\0`).update(Buffer.from(token,'base64url')).digest();
const sql=async()=>(await readFile(new URL('../migrations/ist_loja_download_recuperacao_fundacao.sql',import.meta.url),'utf8'))
    .replace(/^DELIMITER[^\r\n]*$/gm,'').replace(/END\$\$\s*$/,'END');
const make=(db,agora=()=>new Date(inicio))=>criarLojaDownloadRecuperacaoService({db,chaveEmail:chave,contextoEsperado:contextoDireitos,agora});

test('D7.1 configuracao obrigatoria e entradas invalidas sem banco, ambiente ou logs',async()=>{
    assert.throws(()=>criarLojaDownloadRecuperacaoService(),{codigo:'CONFIGURACAO_INVALIDA'});
    const db={getConnection(){throw Error('nao acessar');}};
    for(const chaveEmail of [null,Buffer.alloc(31),'segredo'])assert.throws(()=>criarLojaDownloadRecuperacaoService({db,chaveEmail,contextoEsperado:contextoDireitos}),{codigo:'CONFIGURACAO_INVALIDA'});
    const s=make(db);
    await assert.rejects(s.criarDesafio('invalido'),{codigo:'ENTRADA_INVALIDA'});
    await assert.rejects(s.consumirDesafio('invalido','nao-token'),{codigo:'DESAFIO_INVALIDO'});
    for(const op of ['obterSessao','revogarSessao'])await assert.rejects(s[op]('nao-token'),{codigo:'SESSAO_INVALIDA'});
    assert.deepEqual(CONTRATO_RECUPERACAO,{desafioMs:900000,sessaoMs:86400000,maxTentativas:5,maxCandidatos:50});
});

test('D7.1 fundacao e contratos em MariaDB descartavel',{
    skip:!process.env.IST_LOJA_PAGAMENTOS_MARIADB_BIN&&!process.env.IST_R2_10339_MANIFEST,timeout:240000
},async t=>{
    const f=await criarFixtureDireitos(t),{a,pool}=f;
    const [[identidade]]=await a.query('SELECT VERSION() versao,DATABASE() banco,@@port porta');
    t.diagnostic(`D7_1_B1: ${identidade.versao}; schema ${identidade.banco}; porta ${identidade.porta}; somente dados sinteticos.`);
    const migration=await sql();
    const tabelas=['ist_loja_sessoes','ist_loja_pedidos','ist_loja_pedido_itens','ist_loja_pagamentos',
        'ist_loja_pagamento_operacoes','ist_loja_pagamento_eventos','ist_loja_download_direitos','ist_loja_download_direito_eventos','ist_loja_arquivo_versoes'];
    const snapshot=async()=>{
        const rows=[];for(const nome of tabelas)rows.push((await a.query(`SELECT * FROM ${nome} ORDER BY id`))[0]);
        return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
    };
    const ddl={};for(const nome of tabelas)ddl[nome]=(await a.query(`SHOW CREATE TABLE ${nome}`))[0][0]['Create Table'];
    await t.test('guard rejeita FK/CHECK/modo incompativeis e outro schema antes do DDL',async()=>{
        for(const nome of ['foreign_key_checks','check_constraint_checks']){
            await a.query(`SET SESSION ${nome}=0`);
            try{await assert.rejects(a.query(migration),{sqlState:'45000'});}finally{await a.query(`SET SESSION ${nome}=1`);}
        }
        const [[modo]]=await a.query('SELECT @@sql_mode modo');await a.query("SET SESSION sql_mode=''");
        try{await assert.rejects(a.query(migration),{sqlState:'45000'});}finally{await a.query('SET SESSION sql_mode=?',[modo.modo]);}
        const outro='ist_d71_negado_'+randomBytes(6).toString('hex');
        await a.query(`CREATE DATABASE ${outro}`);await a.query(`USE ${outro}`);
        try{await assert.rejects(a.query(migration),{sqlState:'45000'});
            assert.equal(Number((await a.query('SELECT COUNT(*) n FROM information_schema.tables WHERE table_schema=DATABASE()'))[0][0].n),0);
        }finally{await a.query(`USE ${identidade.banco}`);}
        // Schema negativo pertence ao MESMO datadir descartavel; removido pela fixture.
    });
    await t.test('migration completa, duas tabelas vazias, tres FKs; sem alterar fundacoes',async()=>{
        const antes=await snapshot();await a.query(migration);assert.equal(await snapshot(),antes);
        for(const nome of tabelas)assert.equal((await a.query(`SHOW CREATE TABLE ${nome}`))[0][0]['Create Table'],ddl[nome]);
        for(const nome of ['ist_loja_download_recuperacoes','ist_loja_download_recuperacao_direitos'])assert.equal(Number((await a.query(`SELECT COUNT(*) n FROM ${nome}`))[0][0].n),0);
        const [fks]=await a.query("SELECT constraint_name FROM information_schema.referential_constraints WHERE constraint_schema=DATABASE() AND table_name='ist_loja_download_recuperacao_direitos'");
        assert.equal(fks.length,3);await assert.rejects(a.query(migration),{sqlState:'45000'});
    });
    const preparar=async({email='comprador@example.invalid',estadoDireito='ATIVO',pendente=false}={})=>{
        const x=await f.preparar({estadoDireito});
        await a.execute('UPDATE ist_loja_pedidos SET comprador_email=? WHERE id=?',[email,x.pedidoId]);
        if(pendente)await a.execute("UPDATE ist_loja_pedidos SET estado='AGUARDANDO_PAGAMENTO',pagamento_confirmado_em=NULL WHERE id=?",[x.pedidoId]);
        return x;
    };
    const fluxo=async(email,db=pool)=>{
        const svc=make(db),d=await svc.criarDesafio(email);return {svc,d,consumir:()=>svc.consumirDesafio(d.publicId,d.segredo)};
    };
    const registro=async d=>(await a.execute('SELECT * FROM ist_loja_download_recuperacoes WHERE public_id=?',[d.publicId]))[0][0];
    await t.test('desafio usa segredo de 32 bytes, SHA separado e HMAC de email; sem sessao inicial',async()=>{
        const {d}=await fluxo(' Parte.Local@EXAMPLE.INVALID '),r=await registro(d);
        assert.equal(Buffer.from(d.segredo,'base64url').length,32);assert.deepEqual(r.desafio_hash,hash('desafio',d.segredo));
        assert.deepEqual(r.email_chave,createHmac('sha256',chave).update('ist-loja/recuperacao/email/v1\0').update('Parte.Local@example.invalid').digest());
        assert.equal(r.email_normalizado,'Parte.Local@example.invalid');assert.equal(r.sessao_hash,null);assert.equal(r.consumido_em,null);
        assert.equal(r.tentativas,0);assert.equal(Date.parse(d.expiraEm),inicio+900000);
        assert(!JSON.stringify(r).includes(d.segredo));
    });
    await t.test('token incorreto e malformado contam; quinta tentativa bloqueia definitivamente o desafio',async()=>{
        const {svc,d,consumir}=await fluxo('tentativas@example.invalid');
        for(let n=1;n<=5;n++){
            await assert.rejects(svc.consumirDesafio(d.publicId,n===1?'malformado':randomBytes(32).toString('base64url')),{codigo:'DESAFIO_INVALIDO'});
            assert.equal((await registro(d)).tentativas,n);
        }
        await assert.rejects(consumir(),{codigo:'DESAFIO_INVALIDO'});assert.equal((await registro(d)).tentativas,5);
    });
    await t.test('expiracao de 15 minutos e relogio regressivo bloqueiam sem criar sessao',async()=>{
        const {d}=await fluxo('expirado@example.invalid');
        for(const n of [inicio-1,inicio+900000,inicio+900001])await assert.rejects(make(pool,()=>new Date(n)).consumirDesafio(d.publicId,d.segredo),{codigo:'DESAFIO_INVALIDO'});
        assert.equal((await registro(d)).sessao_hash,null);
    });
    await t.test('email binario: outro comprador, caixa local, pontos e sufixos nao sao equivalentes',async()=>{
        await preparar({email:'Pessoa@example.invalid'});
        for(const email of ['pessoa@example.invalid','outra@example.invalid','Pessoa+tag@example.invalid','Pes.soa@example.invalid']){
            const x=await fluxo(email);await assert.rejects(x.consumir(),{codigo:'SEM_DIREITOS_ELEGIVEIS'});
        }
        const x=await fluxo('Pessoa@EXAMPLE.INVALID'),antes=await snapshot(),r=await x.consumir();
        assert.equal(r.sessao.direitos.length,2);assert.equal(await snapshot(),antes);
        const row=await registro(x.d);assert.equal(row.email_normalizado,null);assert.deepEqual(row.sessao_hash,hash('sessao',r.token));
        assert.notEqual(r.token,x.d.segredo);assert(!row.sessao_hash.equals(row.desafio_hash));
        await assert.rejects(x.svc.obterSessao(x.d.segredo),{codigo:'SESSAO_INVALIDA'});
        await assert.rejects(x.consumir(),{codigo:'DESAFIO_INVALIDO'});
    });
    await t.test('consumo concorrente: uma sessao, um escopo, um unico retorno de token',async()=>{
        await preparar({email:'concorrente@example.invalid'});const x=await fluxo('concorrente@example.invalid');
        const r=await Promise.allSettled([x.consumir(),x.consumir()]);
        assert.equal(r.filter(x=>x.status==='fulfilled').length,1);assert.equal(r.filter(x=>x.status==='rejected'&&x.reason.codigo==='DESAFIO_INVALIDO').length,1);
        const row=await registro(x.d);assert.equal(Number((await a.query('SELECT COUNT(*) n FROM ist_loja_download_recuperacao_direitos WHERE recuperacao_id=?',[row.id]))[0][0].n),2);
    });
    await t.test('suspensos/revogados e pagamento nao elegivel ficam fora; aguardando elegivel nao e ativado',async()=>{
        for(const estadoDireito of ['SUSPENSO','REVOGADO']){
            const email=estadoDireito.toLowerCase()+'@example.invalid';await preparar({email,estadoDireito});
            const x=await fluxo(email),antes=await snapshot();await assert.rejects(x.consumir(),{codigo:'SEM_DIREITOS_ELEGIVEIS'});assert.equal(await snapshot(),antes);
        }
        await preparar({email:'pendente@example.invalid',estadoDireito:'AGUARDANDO_CONFIRMACAO',pendente:true});
        await assert.rejects((await fluxo('pendente@example.invalid')).consumir(),{codigo:'SEM_DIREITOS_ELEGIVEIS'});
        const y=await preparar({email:'aguardando@example.invalid',estadoDireito:'AGUARDANDO_CONFIRMACAO'});
        const antes=await snapshot(),x=await fluxo('aguardando@example.invalid'),r=await x.consumir();
        assert.equal(r.sessao.direitos.length,2);assert.equal(await snapshot(),antes);
        assert((await f.ler(y)).direitos.every(d=>d.estado==='AGUARDANDO_CONFIRMACAO'));
    });
    await t.test('escopo nao cresce com compras posteriores; sessao tem 24h absolutas e revogacao persistente',async()=>{
        await preparar({email:'escopo@example.invalid'});const x=await fluxo('escopo@example.invalid'),r=await x.consumir();
        const primeiro=await x.svc.obterSessao(r.token);await preparar({email:'escopo@example.invalid'});
        assert.deepEqual(await x.svc.obterSessao(r.token),primeiro);
        assert.deepEqual(await make(pool,()=>new Date(inicio+86399999)).obterSessao(r.token),primeiro);
        await assert.rejects(make(pool,()=>new Date(inicio+86400000)).obterSessao(r.token),{codigo:'SESSAO_INVALIDA'});
        assert.deepEqual(await x.svc.revogarSessao(r.token),{revogada:true});
        assert.deepEqual(await x.svc.revogarSessao(r.token),{revogada:false});
        await assert.rejects(x.svc.obterSessao(r.token),{codigo:'SESSAO_INVALIDA'});
        assert.notEqual((await registro(x.d)).revogada_em,null);
    });
    await t.test('CHECK, UNIQUE, FKs e chave composta impedem estruturas invalidas',async()=>{
        await preparar({email:'constraints@example.invalid'});const x=await fluxo('constraints@example.invalid'),r=await x.consumir(),row=await registro(x.d);
        for(const clause of ['tentativas=6',"sessao_expira_em='2026-01-03'",'sessao_hash=desafio_hash',"email_normalizado='vazamento@example.invalid'"])
            await assert.rejects(a.query(`UPDATE ist_loja_download_recuperacoes SET ${clause} WHERE id=?`,[row.id]),e=>e.errno===4025);
        const d=r.sessao.direitos[0];
        await assert.rejects(a.execute('INSERT INTO ist_loja_download_recuperacao_direitos VALUES(?,?,?)',[row.id,d.direitoId,d.arquivoVersaoId]),{code:'ER_DUP_ENTRY'});
        await assert.rejects(a.execute('INSERT INTO ist_loja_download_recuperacao_direitos VALUES(?,?,?)',[row.id,4294967295,1]),{code:'ER_NO_REFERENCED_ROW_2'});
        const y=await fluxo('unico@example.invalid');await assert.rejects(a.query('UPDATE ist_loja_download_recuperacoes SET public_id=? WHERE public_id=?',[x.d.publicId,y.d.publicId]),{code:'ER_DUP_ENTRY'});
    });
    const envolver=(hook)=>({async getConnection(){const c=await pool.getConnection();return {
        query:async(sql,p)=>{await hook?.('query',sql,p);return c.query(sql,p);},
        beginTransaction:()=>c.beginTransaction(),rollback:()=>c.rollback(),release:()=>c.release(),destroy:()=>c.destroy(),
        commit:async()=>{await hook?.('antesCommit');await c.commit();await hook?.('depoisCommit');}
    };}});
    await t.test('falha no escopo ou avaliador SQL faz rollback integral e permite tentativa posterior',async()=>{
        await preparar({email:'rollback@example.invalid'});
        for(const falha of ['INSERT INTO ist_loja_download_recuperacao_direitos','SELECT id,public_id,pedido_id,provedor','SET consumido_em=?']){
            let houve=false,ocorrencias=0;const x=await fluxo('rollback@example.invalid',envolver((etapa,sql)=>{
                if(etapa==='query'&&sql.includes(falha)&&++ocorrencias===(falha.startsWith('INSERT')?2:1)){
                    houve=true;throw Error('SEGREDO_SINTETICO_NAO_EXIBIR');
                }
            }));
            const antes=await snapshot();await assert.rejects(x.consumir(),e=>e.codigo==='RECUPERACAO_INDISPONIVEL'&&!String(e).includes('SEGREDO'));
            assert(houve);const row=await registro(x.d);assert.equal(row.sessao_hash,null);assert.equal(await snapshot(),antes);
            assert.equal(Number((await a.query('SELECT COUNT(*) n FROM ist_loja_download_recuperacao_direitos WHERE recuperacao_id=?',[row.id]))[0][0].n),0);
            assert.equal((await make(pool).consumirDesafio(x.d.publicId,x.d.segredo)).sessao.direitos.length,2);
        }
    });
    await t.test('COMMIT sem ACK: nunca retorna token; antes/depois da persistencia permanecem conservadores',async()=>{
        await preparar({email:'incerto@example.invalid'});
        for(const etapaFalha of ['antesCommit','depoisCommit']){
            const d=await make(pool).criarDesafio('incerto@example.invalid');
            const s=make(envolver(etapa=>{if(etapa===etapaFalha)throw Error('CONEXAO_SINTETICA');}));
            await assert.rejects(s.consumirDesafio(d.publicId,d.segredo),{codigo:'RESULTADO_DESCONHECIDO'});
            const r=await registro(d);
            if(etapaFalha==='depoisCommit'){
                assert(r.sessao_hash);await assert.rejects(make(pool).consumirDesafio(d.publicId,d.segredo),{codigo:'DESAFIO_INVALIDO'});
            }else {assert.equal(r.sessao_hash,null);assert((await make(pool).consumirDesafio(d.publicId,d.segredo)).token);}
        }
    });
    await t.test('teto de 50 candidatos: aceita limite exato e rejeita excesso integralmente',async()=>{
        for(let n=0;n<25;n++)await preparar({email:'limite@example.invalid'});
        const x=await fluxo('limite@example.invalid');assert.equal((await x.consumir()).sessao.direitos.length,50);
        await preparar({email:'limite@example.invalid'});const y=await fluxo('limite@example.invalid'),antes=await snapshot();
        await assert.rejects(y.consumir(),{codigo:'LIMITE_ESCOPO'});assert.equal((await registro(y.d)).sessao_hash,null);assert.equal(await snapshot(),antes);
    });
});
