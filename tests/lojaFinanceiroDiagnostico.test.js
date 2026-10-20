import test from 'node:test';
import assert from 'node:assert/strict';
import {criarDiagnosticoFinanceiroTeste} from './fixtures/lojaFinanceiroDiagnostico.js';

test('instrumentacao preserva erro original e registra codigo/SQLSTATE sem SQL ou segredos',async()=>{
    const linhas=[],original=Object.assign(Error('SENHA token cookie /privado'),{code:'ER_LOCK_DEADLOCK',errno:1213,sqlState:'40001',sql:'SELECT SEGREDO'});
    let rollback=0,liberou=0;
    const diag=criarDiagnosticoFinanceiroTeste({registrar:s=>linhas.push(s),obterCaso:()=> 'disputa sintetica',db:{async getConnection(){return {
        async query(sql){if(sql.startsWith('SELECT @@'))return [[{transacao:1,autocommit:1,isolamento:'READ-COMMITTED'}]];throw original;},
        async beginTransaction(){},async rollback(){rollback++;},release(){liberou++;}
    };}}});
    diag.iniciarOperacao();const c=await diag.db.getConnection();await c.beginTransaction();
    await assert.rejects(c.query('UPDATE ist_loja_download_direitos SET segredo=?',['SENHA']),e=>e===original);
    await c.rollback();c.release();
    assert.equal(rollback,1);assert.equal(liberou,1);assert.doesNotMatch(linhas.join('\n'),/SENHA|token|cookie|privado|SEGREDO|UPDATE ist_|SELECT /);
    const r=JSON.parse(linhas[0].split('F2_DIAGNOSTICO=')[1]);assert.equal(r.sqlstate,'40001');assert.equal(r.errno,1213);assert.equal(r.deadlock,true);
    assert.equal(r.tentativa,1);assert.equal(r.sql.transacao,1);assert.equal(diag.resumo().ativasFinais,0);
});
test('falha ao adquirir conexao e encerramento sao diagnosticados sem tentar reparo',async()=>{
    const linhas=[],original=Object.assign(Error('SENHA'),{code:'ECONNRESET'});
    const d=criarDiagnosticoFinanceiroTeste({registrar:x=>linhas.push(x),db:{async getConnection(){throw original;}}});
    await assert.rejects(d.db.getConnection(),e=>e===original);const r=JSON.parse(linhas[0].split('=')[1]);
    assert.equal(r.etapa,'ADQUIRIR_CONEXAO');assert.equal(r.conexaoEncerrada,true);assert.doesNotMatch(linhas[0],/SENHA/);
});
