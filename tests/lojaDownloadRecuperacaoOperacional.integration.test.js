import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import express from 'express';
import {criarFixtureDireitos,contextoDireitos} from './fixtures/lojaDownloadDireitosFixture.js';
import {criarLimpezaRecuperacao} from '../src/services/lojaDownloadRecuperacaoLimpeza.js';
import {criarLojaDownloadRecuperacaoRouter} from '../src/routes/lojaDownloadRecuperacao.routes.js';
import {criarConfiguracaoLojaSessao} from '../src/config/lojaSessao.js';
import {criarEnvioRecuperacaoSmtp} from '../src/services/mailService.js';
import {criarAdaptadorEmailRecuperacao} from '../src/services/lojaDownloadRecuperacaoEmail.js';

const DIA=86400000,agora=Date.parse('2026-10-20T12:00:00.000Z'),utc=n=>new Date(n).toISOString().slice(0,23).replace('T',' ');
test('D7.3 SMTP simulado, retencao e preservacao financeira em MariaDB descartavel',{
    skip:!process.env.IST_LOJA_PAGAMENTOS_MARIADB_BIN&&!process.env.IST_R2_10339_MANIFEST,timeout:240000
},async t=>{
    const f=await criarFixtureDireitos(t),{a,pool}=f;
    await a.query((await readFile(new URL('../migrations/ist_loja_download_recuperacao_fundacao.sql',import.meta.url),'utf8'))
        .replace(/^DELIMITER[^\r\n]*$/gm,'').replace(/END\$\$\s*$/,'END'));
    const compra=await f.preparar({estadoDireito:'ATIVO'});
    t.diagnostic(`D7_3_B1_OPERACIONAL: ${f.identidade.versao}; schema ${f.identidade.banco}; porta ${f.identidade.porta}; SMTP simulado, sem banco principal.`);
    const snapshot=async()=>{
        const rows=[];
        for(const tab of ['ist_loja_sessoes','ist_loja_pedidos','ist_loja_pedido_itens','ist_loja_pagamentos','ist_loja_pagamento_operacoes',
            'ist_loja_pagamento_eventos','ist_loja_download_direitos','ist_loja_download_direito_eventos','ist_loja_arquivo_versoes'])
            rows.push((await a.query(`SELECT * FROM ${tab} ORDER BY id`))[0]);
        return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
    };
    const original=await snapshot();
    const inserir=async({desafioExpira,sessaoExpira,revogada}={})=>{
        const consumo=sessaoExpira?sessaoExpira-DIA:null,criacao=consumo??desafioExpira-900000;
        const [r]=await a.query(`INSERT INTO ist_loja_download_recuperacoes(public_id,desafio_hash,email_chave,email_normalizado,criado_em,
            desafio_expira_em,consumido_em,sessao_hash,sessao_criada_em,sessao_expira_em,revogada_em)
            VALUES(?,?,?,?,?,?,?,?,?,?,?)`,[randomUUID(),randomBytes(32),randomBytes(32),consumo?null:'sintetico@example.invalid',utc(criacao),utc(criacao+900000),
            consumo?utc(consumo):null,consumo?randomBytes(32):null,consumo?utc(consumo):null,sessaoExpira?utc(sessaoExpira):null,revogada?utc(revogada):null]);
        if(consumo)for(let k=0;k<compra.direitos.length;k++)await a.query('INSERT INTO ist_loja_download_recuperacao_direitos VALUES(?,?,?)',[r.insertId,compra.direitos[k],k+1]);
        return r.insertId;
    };
    const limpeza=()=>criarLimpezaRecuperacao({db:pool,bancoEsperado:f.identidade.banco,agora:()=>new Date(agora)});
    await t.test('SMTP falha apos desafio; HTTP uniforme, sem sessao, financeiro intacto',async t=>{
        let envios=0;
        const enviar=criarEnvioRecuperacaoSmtp({env:{SMTP_HOST:'smtp.example.invalid',SMTP_PORT:'587',SMTP_SECURE:'false',SMTP_REJECT_UNAUTHORIZED:'true',
            MAIL_FROM_NAME:'Sintetico',MAIL_FROM_ADDRESS:'remetente@example.invalid',IST_LOJA_RECUPERACAO_SMTP_AUTENTICACAO:'relay'},
            criarTransporte:()=>({sendMail:async()=>{envios++;throw Error('CERTIFICADO-INVALIDO-SEGREDO-SINTETICO');}})});
        const config=criarConfiguracaoLojaSessao({producao:false,origens:['http://localhost:4200'],segredoCsrf:randomBytes(32)});
        const router=criarLojaDownloadRecuperacaoRouter({db:pool,chaveEmail:randomBytes(32),contextoEsperado:contextoDireitos,
            obterConfiguracao:()=>config,agora:()=>new Date(agora),
            adaptadorEmail:criarAdaptadorEmailRecuperacao({origemPublica:'https://loja.example.invalid',producao:true,enviarEmail:enviar})});
        const app=express();app.use('/recuperacao',router);const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
        t.after(async()=>{await router.aguardarEnvios();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
        const base='http://127.0.0.1:'+server.address().port+'/recuperacao';
        const b=await fetch(base+'/sessao',{headers:{Origin:'http://localhost:4200','X-IST-Loja':'1'}}),{csrfToken}=await b.json();
        const cookies=b.headers.getSetCookie().map(c=>c.split(';')[0]).join('; '),respostas=[];
        for(const email of ['sintetico@example.invalid','semcompra@example.invalid']){
            const r=await fetch(base+'/solicitar',{method:'POST',headers:{Origin:'http://localhost:4200','X-IST-Loja':'1','X-CSRF-Token':csrfToken,'Content-Type':'application/json',Cookie:cookies},body:JSON.stringify({email})});
            assert.equal(r.status,202);assert.match(r.headers.get('cache-control'),/no-store/);assert.equal(r.headers.getSetCookie().length,0);
            respostas.push(await r.text());await router.aguardarEnvios();
        }
        assert.equal(respostas[0],respostas[1]);assert(!respostas.join().includes('SEGREDO'));assert.equal(envios,1);
        const [[s]]=await a.query('SELECT COUNT(*) n FROM ist_loja_download_recuperacoes WHERE sessao_hash IS NOT NULL');assert.equal(Number(s.n),0);
        assert.equal(await snapshot(),original);
    });
    let remover,manter;
    await t.test('prepara limites 7/90, sessoes validas, revogadas recentes e vinculos sinteticos',async()=>{
        remover=[await inserir({desafioExpira:agora-7*DIA-1}),await inserir({sessaoExpira:agora-90*DIA-1}),
            await inserir({sessaoExpira:agora-92*DIA,revogada:agora-91*DIA})];
        manter=[await inserir({desafioExpira:agora-7*DIA}),await inserir({desafioExpira:agora+300000}),
            await inserir({sessaoExpira:agora+3600000}),await inserir({sessaoExpira:agora-90*DIA}),
            await inserir({sessaoExpira:agora-91*DIA,revogada:agora-89*DIA})];
        assert.equal(await snapshot(),original);
    });
    await t.test('lote limitado e retencao conservadora; direitos e historico permanecem identicos',async()=>{
        const l=limpeza();assert.deepEqual(await l.limpar({confirmarRetencao:true,limite:1}),{recuperacoesRemovidas:1,vinculosRemovidos:0});
        assert.deepEqual(await l.limpar({confirmarRetencao:true}),{recuperacoesRemovidas:2,vinculosRemovidos:4});
        const [rs]=await a.query('SELECT id FROM ist_loja_download_recuperacoes ORDER BY id');
        for(const id of remover)assert(!rs.some(r=>r.id===id));for(const id of manter)assert(rs.some(r=>r.id===id));
        const [[orfaos]]=await a.query(`SELECT COUNT(*) n FROM ist_loja_download_recuperacao_direitos e
            LEFT JOIN ist_loja_download_recuperacoes r ON r.id=e.recuperacao_id WHERE r.id IS NULL`);assert.equal(Number(orfaos.n),0);
        assert.equal(await snapshot(),original);assert.deepEqual(await l.limpar({confirmarRetencao:true}),{recuperacoesRemovidas:0,vinculosRemovidos:0});
    });
    await t.test('falha SQL reverte remocao dos vinculos e nao altera financeiro',async()=>{
        const id=await inserir({sessaoExpira:agora-91*DIA});
        const db={getConnection:async()=>{const c=await pool.getConnection();return{
            query:async(sql,p)=>{if(sql.startsWith('DELETE FROM ist_loja_download_recuperacoes '))throw Error('SQL-SENSIVEL');return c.query(sql,p);},
            beginTransaction:()=>c.beginTransaction(),commit:()=>c.commit(),rollback:()=>c.rollback(),release:()=>c.release(),destroy:()=>c.destroy()};}};
        await assert.rejects(criarLimpezaRecuperacao({db,bancoEsperado:f.identidade.banco,agora:()=>new Date(agora)}).limpar({confirmarRetencao:true}),{codigo:'LIMPEZA_INDISPONIVEL'});
        assert.equal(Number((await a.query('SELECT COUNT(*) n FROM ist_loja_download_recuperacao_direitos WHERE recuperacao_id=?',[id]))[0][0].n),2);
        assert.equal(await snapshot(),original);
    });
    await t.test('schema errado bloqueia antes de DELETE; concorrencia entre chamadas preserva integridade',async()=>{
        await assert.rejects(criarLimpezaRecuperacao({db:pool,bancoEsperado:'nao_autorizado',agora:()=>new Date(agora)}).limpar({confirmarRetencao:true}),{codigo:'LIMPEZA_INDISPONIVEL'});
        const rs=await Promise.all([limpeza().limpar({confirmarRetencao:true}),limpeza().limpar({confirmarRetencao:true})]);
        assert.equal(rs.reduce((n,r)=>n+r.recuperacoesRemovidas,0),1);assert.equal(await snapshot(),original);
    });
    await t.test('COMMIT incerto e erro sanitizado sem repeticao automatica',async()=>{
        let commits=0,destruido=false;
        const db={getConnection:async()=>{const c=await pool.getConnection();return{query:(...a)=>c.query(...a),beginTransaction:()=>c.beginTransaction(),
            commit:async()=>{commits++;await c.commit();throw Error('RESPOSTA-PERDIDA');},rollback:()=>c.rollback(),release:()=>c.release(),destroy:()=>{destruido=true;c.destroy();}};}};
        await assert.rejects(criarLimpezaRecuperacao({db,bancoEsperado:f.identidade.banco,agora:()=>new Date(agora)}).limpar({confirmarRetencao:true}),{codigo:'RESULTADO_LIMPEZA_DESCONHECIDO'});
        assert.equal(commits,1);assert.equal(destruido,true);assert.equal(await snapshot(),original);
    });
});
