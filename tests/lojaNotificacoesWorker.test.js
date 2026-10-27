import test from 'node:test';
import assert from 'node:assert/strict';
import {comporConfirmacaoCompra} from '../src/services/lojaNotificacoesMensagem.js';
import {criarEnvioRecuperacaoSmtp} from '../src/services/mailService.js';
import {iniciarNotificacoesLoja} from '../src/services/lojaNotificacoesAgendador.js';
import {criarProcessadorNotificacoes} from '../src/services/lojaNotificacoesWorker.js';

const env={SMTP_HOST:'smtp.example.invalid',SMTP_PORT:'587',SMTP_SECURE:'false',SMTP_REJECT_UNAUTHORIZED:'true',
    MAIL_FROM_NAME:'IST teste',MAIL_FROM_ADDRESS:'teste@example.invalid',IST_LOJA_RECUPERACAO_SMTP_AUTENTICACAO:'relay'};
const pedidoPublicId='11111111-1111-4111-8111-111111111111';
const mensagem=comporConfirmacaoCompra({pedido_id:7,pedido_public_id:pedidoPublicId,ambiente:'sandbox',finalidade:'CONFIRMACAO_COMPRA',destinatario:'caixa@example.invalid'});
test('68.2 composicao usa destinatario persistido, identifica Sandbox e biblioteca sem anexos',()=>{
    assert.equal(mensagem.to,'caixa@example.invalid');assert.match(mensagem.text,/PayPal Sandbox — sem cobrança real/);
    assert(mensagem.text.includes(pedidoPublicId));assert.match(mensagem.text,/https:\/\/istbrasil.org.br\/loja\/biblioteca/);
    assert.doesNotMatch(mensagem.text,/\.pdf|token=|segredo=|istbrasil\.private/);
    assert.deepEqual(Object.keys(mensagem).sort(),['subject','text','to']);
    assert.throws(()=>comporConfirmacaoCompra({pedido_id:7,ambiente:'live',finalidade:'CONFIRMACAO_COMPRA',destinatario:'x@example.invalid'}));
});
test('68.2 SMTP simulado aceita somente ACK e classifica rejeicao comprovada sem vazar detalhes',async()=>{
    let chamadas=0;
    const envio=resultado=>criarEnvioRecuperacaoSmtp({env,classificarNaoAceito:true,criarTransporte:op=>{
        assert.equal(op.requireTLS,true);assert.equal(op.tls.rejectUnauthorized,true);
        return {sendMail:async m=>{chamadas++;assert(!m.attachments);return resultado(m);}};
    }});
    await envio(m=>({accepted:[m.to]}))(mensagem);
    for(const e of [{code:'EAUTH'},{code:'EDNS'},{command:'CONN',code:'ETIMEDOUT'},{command:'DATA',responseCode:550}]){
        await assert.rejects(envio(()=>{throw {...e,message:'SEGREDO'};})(mensagem),x=>x.notificacaoNaoEnviada===true&&!x.message.includes('SEGREDO'));
    }
    for(const e of [{code:'ETIMEDOUT',command:'DATA'},{command:'QUIT',responseCode:550},{}]){
        await assert.rejects(envio(()=>{throw e;})(mensagem),x=>x.notificacaoNaoEnviada!==true);
    }
    await assert.rejects(envio(()=>({accepted:[]}))(mensagem),x=>x.notificacaoNaoEnviada!==true);assert.equal(chamadas,9);
});
test('68.2 configuracao desativada nao cria transporte, timer, SQL ou PayPal Live',async()=>{
    const proibido=()=>assert.fail('EFEITO_PROIBIDO'),db={getConnection:proibido};
    for(const flag of [undefined,'false','TRUE','1'])assert.equal(iniciarNotificacoesLoja({db,
        env:{NODE_ENV:'production',IST_LOJA_NOTIFICACOES_ATIVAS:flag},criarEnvio:proibido,agendar:proibido}).ativo,false);
    assert.equal(iniciarNotificacoesLoja({db,env:{NODE_ENV:'test',IST_LOJA_NOTIFICACOES_ATIVAS:'true'},criarEnvio:proibido,agendar:proibido}).ativo,false);
    assert.throws(()=>criarProcessadorNotificacoes({db,enviar:proibido,ambiente:'live'}));
});

test('68.3 reserva usa UUID publico persistido, envia fora da transacao e nao escreve financeiro',async()=>{
    let tx=false,envios=0,liberadas=0;
    const db={async getConnection(){return {release(){assert.equal(tx,false);liberadas++;},destroy(){assert.fail('DESCARTE_INESPERADO');},
        async query({sql},args){
            if(sql.startsWith('SELECT @@'))return [[{tx:0,ac:1}]];
            if(sql.startsWith('SET TRANSACTION'))return [[]];
            if(sql==='START TRANSACTION READ WRITE'){assert.equal(tx,false);tx=true;return [[]];}
            if(sql==='COMMIT'){assert.equal(tx,true);tx=false;return [[]];}
            if(sql.startsWith('SELECT n.*')){
                assert(sql.includes('p.public_id FROM ist_loja_pedidos p WHERE p.id=n.pedido_id'));
                assert.equal(args[0],'sandbox');
                return [[{id:1,pedido_id:7,pedido_public_id:pedidoPublicId,ambiente:'sandbox',
                    finalidade:'CONFIRMACAO_COMPRA',destinatario:'caixa@example.invalid',estado:'PENDENTE',tentativas:0}]];
            }
            if(sql.startsWith('SELECT id FROM ist_loja_notificacoes'))return [[{id:1}]];
            if(sql.startsWith('UPDATE ist_loja_notificacoes'))return [{affectedRows:1,warningStatus:0}];
            assert.fail('SQL_NAO_PREVISTO');
        }};}};
    const w=criarProcessadorNotificacoes({db,ambiente:'sandbox',enviar:async m=>{
        assert.equal(tx,false);envios++;assert.equal(m.to,'caixa@example.invalid');
        assert(m.text.includes(pedidoPublicId));assert(!m.attachments);
    }});
    const r=await w.processar({limite:1});assert.equal(r.enviadas,1);assert.equal(envios,1);assert.equal(liberadas,3);
});
test('68.2 agendador unico por pool, lote limitado, sem ciclo imediato e parada aborta e aguarda',async()=>{
    let ciclo,signal,liberar,chamadas=0,cancelamentos=0;
    const db={},config={NODE_ENV:'production',LOJA_AMBIENTE:'sandbox',IST_LOJA_PAYPAL_ENV:'sandbox',IST_LOJA_NOTIFICACOES_ATIVAS:'true'};
    const op={db,env:config,registrar:()=>{},criarEnvio:()=>()=>{},agendar:fn=>{ciclo=fn;return 7;},cancelar:()=>cancelamentos++,
        criarProcessador:()=>({processar:async o=>{chamadas++;assert.equal(o.limite,10);signal=o.signal;await new Promise(r=>{liberar=r;});return {};}})};
    const h=iniciarNotificacoesLoja(op);assert.equal(h,iniciarNotificacoesLoja(op));assert.equal(chamadas,0);
    ciclo();await Promise.resolve();ciclo();assert.equal(chamadas,1);
    const parada=h.parar();assert(signal.aborted);liberar();await parada;await h.parar();assert.equal(cancelamentos,1);
});

test('resumo zerado e silencioso, mas qualquer contador positivo continua registrado',async()=>{
    const config={NODE_ENV:'production',LOJA_AMBIENTE:'sandbox',IST_LOJA_PAYPAL_ENV:'sandbox',IST_LOJA_NOTIFICACOES_ATIVAS:'true'};
    const logs=[],resultados=[{reservadas:0,enviadas:0,falhas:0,incertas:0,semReserva:0},
        {reservadas:1,enviadas:1,falhas:0,incertas:0,semReserva:0}];let ciclo;
    const h=iniciarNotificacoesLoja({db:{},env:config,registrar:m=>logs.push(m),criarEnvio:()=>()=>{},
        criarProcessador:()=>({processar:async()=>resultados.shift()}),agendar:fn=>{ciclo=fn;return 7;},cancelar:()=>{}});
    ciclo();await new Promise(r=>setImmediate(r));assert.deepEqual(logs,[]);
    ciclo();await new Promise(r=>setImmediate(r));assert.equal(logs.length,1);assert.match(logs[0],/"reservadas":1/);
    await h.parar();
});
