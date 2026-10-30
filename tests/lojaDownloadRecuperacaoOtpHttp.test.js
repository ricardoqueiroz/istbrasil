import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {readFile} from 'node:fs/promises';
import {randomBytes,randomUUID} from 'node:crypto';
import {criarFixtureDireitos,contextoDireitos} from './fixtures/lojaDownloadDireitosFixture.js';
import {criarLojaDownloadRecuperacaoService} from '../src/services/lojaDownloadRecuperacaoService.js';
import {criarLojaDownloadRecuperacaoRouter} from '../src/routes/lojaDownloadRecuperacao.routes.js';
import {comporEmailRecuperacao} from '../src/services/lojaDownloadRecuperacaoSmtp.js';
import {criarEnvioRecuperacaoSmtp} from '../src/services/mailService.js';
import {prepararEmailPorChave} from '../src/services/emailTemplateService.js';
import {criarConfiguracaoLojaSessao} from '../src/config/lojaSessao.js';
const origem='https://loja.example.invalid',base='/api/loja/downloads/recuperacao';
const ler=nome=>readFile(new URL(`../migrations/${nome}`,import.meta.url),'utf8');
const html='<p>Pedido {{pedido_public_id}}. Código {{codigo}}, válido por {{validade_minutos}} minutos.</p><a href="{{link_acesso}}">Acessar</a>';
test('B7-C5 HTTP/modelo/SMTP simulado e MariaDB isolado',{
    skip:process.env.IST_LOJA_MARIADB_NATIVO_10339!=='true',timeout:240000
},async t=>{
    const f=await criarFixtureDireitos(t),{a,pool}=f;
    for(const ddl of (await ler('ist_loja_download_recuperacao_fundacao.sql')).match(/CREATE TABLE ist_loja_[\s\S]*?\) ENGINE=InnoDB[^;]*;/g))await a.query(ddl);
    await a.query("SET @ist_b7c3_schema=DATABASE(),@ist_b7c3_autorizacao='FUNDACAO_OTP_B7_C3'");
    await a.query((await ler('ist_loja_download_recuperacao_otp_fundacao.sql')).replace(/^DELIMITER[^\r\n]*$/gm,'').replace(/END\$\$\s*$/,'END'));
    let contador=0;
    const montar=async(t,{smtpFalha=false,sortearCodigo=()=>12345,incerto=false,padrao=false}={})=>{
        const i=++contador,email=`http${i}@example.invalid`,x=await f.preparar({estadoDireito:'ATIVO'});
        await a.query('UPDATE ist_loja_pedidos SET comprador_email=? WHERE id=?',[email,x.pedidoId]);
        const [[p]]=await a.query('SELECT public_id FROM ist_loja_pedidos WHERE id=?',[x.pedidoId]);
        const clock={n:Date.parse('2026-01-01T13:00:00Z')},agora=()=>new Date(clock.n),mensagens=[],avisos=[];
        const modelo={atual:{id_modelo:1,chave:'recuperacao_biblioteca_codigo',assunto:'IST — Código de acesso à sua biblioteca digital',conteudo_html:html,id_assinatura:1,ativo:1}};
        const bancoModelos={query:async sql=>{
            if(sql.includes('ist_email_modelos'))return [modelo.atual?[{...modelo.atual}]:[]];
            assert(sql.includes('ist_email_assinaturas'));return [[{conteudo_html:'<p>Assinatura administrativa IST</p>',ativo:1}]];
        }};
        const chave=randomBytes(32),config=criarConfiguracaoLojaSessao({producao:true,origens:[origem],segredoCsrf:randomBytes(32)});
        const otp={chaveCodigo:randomBytes(32),chaveLimites:randomBytes(32),sortearCodigo};
        const s=criarLojaDownloadRecuperacaoService({db:pool,chaveEmail:chave,contextoEsperado:contextoDireitos,agora,
            otp});
        const env={SMTP_HOST:'smtp.example.invalid',SMTP_PORT:'587',SMTP_SECURE:'false',SMTP_REJECT_UNAUTHORIZED:'true',
            MAIL_FROM_NAME:'IST Loja',MAIL_FROM_ADDRESS:'contato@example.invalid',IST_LOJA_RECUPERACAO_SMTP_AUTENTICACAO:'relay',
            IST_LOJA_RECUPERACAO_EMAIL_ATIVO:'true',IST_LOJA_RECUPERACAO_ORIGEM_PUBLICA:origem,
            IST_LOJA_DOWNLOAD_RECUPERACAO_CHAVE_EMAIL:chave.toString('base64url'),
            IST_LOJA_DOWNLOAD_RECUPERACAO_CHAVE_OTP:otp.chaveCodigo.toString('base64url'),
            IST_LOJA_DOWNLOAD_RECUPERACAO_CHAVE_LIMITES:otp.chaveLimites.toString('base64url')};
        const adaptadorEmail=comporEmailRecuperacao({env,obterConfiguracao:()=>config,avisar:c=>avisos.push(c),
            prepararModelo:key=>prepararEmailPorChave(key,{db:bancoModelos}),
            criarEnvio:op=>criarEnvioRecuperacaoSmtp({...op,criarTransporte:tls=>{
                assert.equal(tls.requireTLS,true);assert.equal(tls.tls.rejectUnauthorized,true);
                return {sendMail:async m=>{mensagens.push(m);if(smtpFalha)throw Error('SEGREDO-SMTP');return {accepted:[m.to]};}};
            }})});
        const service=incerto?{...s,validarCodigoDoPedido:async()=>{throw Object.assign(Error('incerto'),{codigo:'RESULTADO_DESCONHECIDO'});}}:s;
        const router=criarLojaDownloadRecuperacaoRouter({db:pool,env,service:padrao?undefined:service,adaptadorEmail,agora,obterConfiguracao:()=>config,contextoEsperado:contextoDireitos});
        const app=express();app.set('trust proxy','loopback');app.use(base,router);
        const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
        t.after(async()=>{await router.aguardarEnvios();server.closeAllConnections();await new Promise(r=>server.close(r));});
        const jar=new Map();let csrf;
        const enviar=async(path,{body,headers={}}={})=>{
            const r=await fetch(`http://127.0.0.1:${server.address().port}${base}${path}`,{method:body===undefined?'GET':'POST',
                headers:{Origin:origem,'X-IST-Loja':'1','X-Forwarded-For':`127.1.0.${i}`,Cookie:[...jar].map(([k,v])=>`${k}=${v}`).join('; '),
                    ...(body===undefined?{}:{'Content-Type':'application/json','X-CSRF-Token':csrf??''}),...headers},
                ...(body===undefined?{}:{body:JSON.stringify(body)})});
            const cookies=r.headers.getSetCookie();for(const c of cookies){const [k,v]=c.split(';')[0].split('=');jar.set(k,v);}
            const text=await r.text(),dto=JSON.parse(text);if(dto.csrfToken)csrf=dto.csrfToken;
            await router.aguardarEnvios();return {status:r.status,dto,text,cookies,headers:r.headers};
        };
        assert.equal((await enviar('/sessao')).status,200);
        const solicitar=(extra={})=>enviar('/solicitar-codigo',{body:{email,pedidoPublicId:p.public_id,...extra}});
        const validar=(codigo='012345')=>enviar('/validar-codigo',{body:{pedidoPublicId:p.public_id,codigo}});
        const registro=async()=>((await a.query('SELECT * FROM ist_loja_download_recuperacoes WHERE pedido_id=? ORDER BY id DESC',[x.pedidoId]))[0][0]);
        return {s,x,email,pedido:p.public_id,modelo,mensagens,avisos,clock,enviar,solicitar,validar,registro,jar};
    };
    await t.test('composicao administrativa HTML/texto/assinatura e cookie seguro; escopo do pedido',async t=>{
        const h=await montar(t),r=await h.solicitar();assert.equal(r.status,202);assert(!r.text.includes('012345'));assert(!r.text.includes('entrega'));
        assert.equal(h.mensagens.length,1);const m=h.mensagens[0];
        assert.equal(m.to,h.email);assert(m.html.includes('012345'));assert(m.html.includes('Assinatura administrativa IST'));
        assert(m.text.includes('012345'));assert(m.text.includes(origem+'/loja/recuperar'));assert(!m.subject.includes('012345'));
        const outro=await f.preparar({estadoDireito:'ATIVO'});await a.query('UPDATE ist_loja_pedidos SET comprador_email=? WHERE id=?',[h.email,outro.pedidoId]);
        const v=await h.validar();assert.equal(v.status,200);assert.equal(v.dto.sessao.autenticada,true);
        const cookie=v.cookies.find(c=>c.startsWith('__Host-ist-loja-recuperacao='));assert(cookie);
        for(const atributo of ['Secure','HttpOnly','SameSite=Lax','Path=/'])assert(cookie.includes(atributo));
        const token=h.jar.get('__Host-ist-loja-recuperacao');assert.deepEqual((await h.s.obterSessao(token)).direitos.map(d=>d.direitoId),h.x.direitos);
        assert.equal((await h.validar()).status,400);
    });
    await t.test('configuracao padrao das chaves OTP funciona sem alterar env instalado',async t=>{
        const h=await montar(t,{padrao:true});assert.equal((await h.solicitar()).status,202);
        assert.equal(h.mensagens.length,1);
        const codigo=h.mensagens[0].text.match(/Código (\d{6})/)[1];
        assert.equal((await h.validar(codigo)).status,200);
    });
    await t.test('endpoint LINK nao consome desafio OTP',async t=>{
        const h=await montar(t);await h.solicitar();const antes=await h.registro();
        const r=await h.enviar('/validar',{body:{publicId:antes.public_id,segredo:'012345'}});
        assert.equal(r.status,400);assert.equal(r.cookies.length,0);assert.deepEqual(await h.registro(),antes);
        assert.equal((await h.validar()).status,200);
    });
    await t.test('inelegivel e falha SMTP preservam mesma resposta publica, sem retry',async t=>{
        const h=await montar(t),ok=await h.solicitar(),outro=await montar(t,{smtpFalha:true}),falha=await outro.solicitar();
        assert.deepEqual(ok.dto,falha.dto);assert.equal(outro.mensagens.length,1);assert.deepEqual(outro.avisos,['RECUPERACAO_EMAIL_ENVIO_INDISPONIVEL']);
        const z=await montar(t),nao=await z.solicitar({email:'outro@example.invalid'});assert.deepEqual(nao.dto,ok.dto);assert.equal(z.mensagens.length,0);
    });
    for(const variante of ['ausente','inativo','invalido','codigo-no-assunto'])await t.test(`modelo ${variante} preserva desafio anterior`,async t=>{
        let numero=0;const h=await montar(t,{sortearCodigo:()=>numero++===0?12345:123456});await h.solicitar();const antes=await h.registro();h.clock.n+=61000;
        if(variante==='ausente')h.modelo.atual=null;
        else if(variante==='inativo')h.modelo.atual.ativo=0;
        else if(variante==='invalido')h.modelo.atual.conteudo_html='<p>{{desconhecido}}</p>';
        else h.modelo.atual.assunto='Acesso 123456'; // Preflight passa; composicao efetiva falha antes de invalidar.
        assert.equal((await h.solicitar()).status,202);assert.equal(h.mensagens.length,1);assert.deepEqual(await h.registro(),antes);
    });
    await t.test('CSRF, origem e contrato estrito impedem chamadas indevidas',async t=>{
        const h=await montar(t),body={email:h.email,pedidoPublicId:h.pedido};
        for(const headers of [{'X-CSRF-Token':'errado'},{Origin:'https://invalida.example.invalid'},{'Sec-Fetch-Site':'cross-site'}])
            assert.equal((await h.enviar('/solicitar-codigo',{body,headers})).status,403);
        assert.equal((await h.validar(12345)).status,400);assert.equal(h.mensagens.length,0);
    });
    await t.test('cinco codigos errados, expiracao e commit incerto nao emitem cookie',async t=>{
        const h=await montar(t);await h.solicitar();for(let i=0;i<5;i++)assert.equal((await h.validar('999999')).status,400);
        assert.notEqual((await h.registro()).invalidado_em,null);assert(!h.jar.has('__Host-ist-loja-recuperacao'));
        const z=await montar(t);await z.solicitar();z.clock.n+=600000;const expirado=await z.validar();assert.equal(expirado.status,400);assert.equal(expirado.cookies.length,0);
        const incerto=await montar(t,{incerto:true});await incerto.solicitar();const r=await incerto.validar();assert.equal(r.status,503);assert.equal(r.cookies.length,0);
    });
});
