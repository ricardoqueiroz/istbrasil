import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {registrarConfirmacaoCompraNaConexao} from '../src/services/lojaNotificacoesService.js';

const instante='2026-10-24T12:00:00.000Z';
const pedido=()=>({id:7,estado:'PAGO',pagamento_confirmado_em:instante,ambiente:'sandbox',comprador_email:'real@example.invalid'});
test('68.1 produtor usa conexao existente, SQL parametrizado e preserva ambiente e destinatario',async()=>{
    for(const ambiente of ['sandbox','live']){
        const comandos=[],p={...pedido(),ambiente};
        const c={query:async(sql,args)=>{comandos.push([sql,args]);return sql.startsWith('SELECT')
            ? [[{em_transacao:1}]]:[{insertId:1,affectedRows:1,warningStatus:0}];}};
        await registrarConfirmacaoCompraNaConexao(c,p,instante);
        assert.equal(comandos.length,2);const [sql,args]=comandos[1];
        assert(!sql.includes(p.comprador_email));assert.match(sql,/INSERT INTO ist_loja_notificacoes/);
        assert.deepEqual(args.slice(1,7),[7,'CONFIRMACAO_COMPRA',ambiente,p.comprador_email,'PENDENTE',0]);
        assert.match(args[0],/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
        assert.equal(p.comprador_email,'real@example.invalid');
    }
});
test('68.1 produtor rejeita pedido nao confirmado, email invalido, ambiente divergente e ausencia de transacao',async()=>{
    let chamadas=0;
    const c={query:async()=>{chamadas++;return [[{em_transacao:0}]];}};
    for(const mudar of [{estado:'CRIADO'},{pagamento_confirmado_em:null},{comprador_email:'segredo\r\nBcc: outro@example.invalid'},
        {comprador_email:'sem-email'},{ambiente:'outro'},{id:0}]){
        await assert.rejects(registrarConfirmacaoCompraNaConexao(c,{...pedido(),...mudar},instante),{codigo:'ERRO_INTERNO'});
    }
    assert.equal(chamadas,0);
    await assert.rejects(registrarConfirmacaoCompraNaConexao(c,pedido(),instante),{codigo:'ERRO_INTERNO'});
    assert.equal(chamadas,1);
});
test('68.1 produtor nao aceita warning ou gravacao incompleta',async()=>{
    for(const r of [{insertId:1,affectedRows:0,warningStatus:0},{insertId:1,affectedRows:1,warningStatus:1}]){
        const c={query:async sql=>sql.startsWith('SELECT')?[[{em_transacao:1}]]:[r]};
        await assert.rejects(registrarConfirmacaoCompraNaConexao(c,pedido(),instante),{codigo:'ERRO_INTERNO'});
    }
});
test('68.1 migration estaticamente preserva tabelas existentes e exige destino explicito',async()=>{
    const sql=await readFile(new URL('../migrations/ist_loja_notificacoes_fundacao.sql',import.meta.url),'utf8');
    assert.match(sql,/@ist_loja_681_schema_esperado/);assert.match(sql,/@ist_loja_681_ddl_autorizado/);
    assert.match(sql,/UNIQUE KEY uq_lnot_pedido_finalidade\(pedido_id,finalidade\)/);
    assert.match(sql,/REFERENCES ist_loja_pedidos\(id\) ON DELETE RESTRICT ON UPDATE RESTRICT/);
    const comandos=sql.split('\n').filter(l=>!l.trim().startsWith('--')).join('\n');
    assert.doesNotMatch(comandos,/^\s*(?:ALTER|DROP|TRUNCATE|INSERT|DELETE|REPLACE|UPDATE)\b/m);
    assert.equal((comandos.match(/CREATE TABLE /g)||[]).length,1);
    const fonte=await readFile(new URL('../src/services/lojaNotificacoesService.js',import.meta.url),'utf8');
    assert.doesNotMatch(fonte,/import .*?(?:mailService|nodemailer|db\.js)|\.(?:commit|rollback|release|beginTransaction)\(/);
});
