import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {criarEnvioRecuperacaoSmtp,enviarEmail,obterOpcoesSmtpGeral} from '../src/services/mailService.js';
import {comporEmailRecuperacao} from '../src/services/lojaDownloadRecuperacaoSmtp.js';
import {criarLimpezaRecuperacao} from '../src/services/lojaDownloadRecuperacaoLimpeza.js';

export const envSmtp=()=>({SMTP_HOST:'smtp.example.invalid',SMTP_PORT:'587',SMTP_SECURE:'false',SMTP_REJECT_UNAUTHORIZED:'true',
    MAIL_FROM_NAME:'Loja IST',MAIL_FROM_ADDRESS:'biblioteca@example.invalid',IST_LOJA_RECUPERACAO_SMTP_AUTENTICACAO:'relay',
    IST_LOJA_RECUPERACAO_EMAIL_ATIVO:'true',IST_LOJA_RECUPERACAO_ORIGEM_PUBLICA:'https://loja.example.invalid',
    IST_LOJA_DOWNLOAD_RECUPERACAO_CHAVE_EMAIL:randomBytes(32).toString('base64url')});
const obterConfiguracao=()=>({origens:['https://loja.example.invalid']});

for(const porta of ['465','587'])test('SMTP valido '+porta+': TLS certificado e timeouts, sem conexao na criacao',async()=>{
    const env={...envSmtp(),SMTP_PORT:porta,SMTP_SECURE:porta==='465'?'true':'false'};let opcoes,envios=0;
    const envio=criarEnvioRecuperacaoSmtp({env,criarTransporte:o=>{opcoes=o;return{sendMail:async m=>{envios++;
        assert.deepEqual(m.from,{name:env.MAIL_FROM_NAME,address:env.MAIL_FROM_ADDRESS});assert.equal(m.text,'sintetico');return{accepted:[m.to]};}};}});
    assert.equal(envios,0);assert.equal(opcoes.secure,porta==='465');assert.equal(opcoes.requireTLS,true);assert.equal(opcoes.ignoreTLS,false);
    assert.deepEqual(opcoes.tls,{rejectUnauthorized:true,minVersion:'TLSv1.2',servername:env.SMTP_HOST});
    for(const k of ['pool','logger','debug'])assert.equal(opcoes[k],false);assert(opcoes.socketTimeout<=15000);assert(opcoes.connectionTimeout<=10000);
    assert.equal(opcoes.disableFileAccess,true);assert.equal(opcoes.disableUrlAccess,true);
    assert.equal(await envio({to:'teste@example.invalid',subject:'Teste',text:'sintetico'}),undefined);assert.equal(envios,1);
});
test('login exige par de credenciais; relay nao herda autenticacao parcialmente configurada',()=>{
    let config;criarEnvioRecuperacaoSmtp({env:{...envSmtp(),IST_LOJA_RECUPERACAO_SMTP_AUTENTICACAO:'login',SMTP_USER:'usuario',SMTP_PASS:'sintetico'},criarTransporte:o=>{config=o;return{};}});
    assert.deepEqual(config.auth,{user:'usuario',pass:'sintetico'});
    for(const extra of [{SMTP_USER:'usuario'},{SMTP_PASS:'sintetico'},{IST_LOJA_RECUPERACAO_SMTP_AUTENTICACAO:'login'},
        {IST_LOJA_RECUPERACAO_SMTP_AUTENTICACAO:'login',SMTP_USER:'usuario'}])assert.throws(()=>criarEnvioRecuperacaoSmtp({env:{...envSmtp(),...extra}}),/CONFIGURACAO_SMTP/);
});
for(const [campo,valor]of [['SMTP_HOST',undefined],['SMTP_HOST','localhost'],['SMTP_HOST','smtp://host.invalid'],['SMTP_HOST','x..invalid'],
    ['SMTP_PORT','25'],['SMTP_PORT','587 '],['SMTP_SECURE','true'],['SMTP_REJECT_UNAUTHORIZED','false'],
    ['MAIL_FROM_ADDRESS','Nome <email@example.invalid>'],['MAIL_FROM_ADDRESS','a\r\nBcc:b@example.invalid'],['MAIL_FROM_ADDRESS','x@a..invalid'],
    ['MAIL_FROM_NAME',''],['MAIL_FROM_NAME','Nome\nOutro'],['IST_LOJA_RECUPERACAO_SMTP_AUTENTICACAO',undefined]])test('configuracao invalida '+campo+' sem criar transporte',()=>{
    let criado=false;assert.throws(()=>criarEnvioRecuperacaoSmtp({env:{...envSmtp(),[campo]:valor},criarTransporte:()=>{criado=true;}}),/CONFIGURACAO_SMTP/);assert.equal(criado,false);
});
for(const causa of ['CERT_HAS_EXPIRED','DEPTH_ZERO_SELF_SIGNED_CERT','ETIMEDOUT','EAUTH'])test('falha SMTP '+causa+' sanitizada sem retry',async()=>{
    let chamadas=0;const envio=criarEnvioRecuperacaoSmtp({env:envSmtp(),criarTransporte:()=>({sendMail:async()=>{chamadas++;throw Object.assign(Error('TOKEN-CREDENCIAL-SINTETICA'),{code:causa});}})});
    await assert.rejects(envio({to:'t@example.invalid',subject:'Teste',text:'SEGREDO-SINTETICO'}),e=>e.message==='ENVIO_RECUPERACAO_INDISPONIVEL'&&!e.cause);assert.equal(chamadas,1);
});
test('rejeicao ou entrega pendente do relay nao e tratada como sucesso',async()=>{
    for(const resultado of [{accepted:[],rejected:['t@example.invalid']},{accepted:['t@example.invalid'],pending:['t@example.invalid']},{}]){
        const enviar=criarEnvioRecuperacaoSmtp({env:envSmtp(),criarTransporte:()=>({sendMail:async()=>resultado})});
        await assert.rejects(enviar({to:'t@example.invalid',subject:'Teste',text:'sintetico'}),/ENVIO_RECUPERACAO/);
    }
});
test('desabilitado por padrao: nao instancia transporte nem depende de configuracao',()=>{
    for(const valor of [undefined,'false','TRUE','1','true '])assert.equal(comporEmailRecuperacao({env:{IST_LOJA_RECUPERACAO_EMAIL_ATIVO:valor},criarEnvio:()=>assert.fail()}),undefined);
});
test('origem HTTPS fixa e permitida; nao herda Host do pedido ou origem relativa',()=>{
    for(const origem of [undefined,'http://loja.example.invalid','https://loja.example.invalid/path','https://u:p@loja.example.invalid','https://outro.example.invalid']){
        const avisos=[];assert.equal(comporEmailRecuperacao({env:{...envSmtp(),IST_LOJA_RECUPERACAO_ORIGEM_PUBLICA:origem},obterConfiguracao,avisar:x=>avisos.push(x),criarEnvio:()=>assert.fail()}),undefined);
        assert.deepEqual(avisos,['RECUPERACAO_EMAIL_DESATIVADO_CONFIGURACAO_INVALIDA']);
    }
});
test('composicao integra adaptador B2 ao mesmo mailService, sem enviar antes da solicitacao',async()=>{
    const mensagens=[],env=envSmtp();const adaptador=comporEmailRecuperacao({env,obterConfiguracao,
        criarEnvio:({env})=>criarEnvioRecuperacaoSmtp({env,criarTransporte:()=>({sendMail:async m=>{mensagens.push(m);return{accepted:[m.to]};}})})});
    assert.equal(mensagens.length,0);await adaptador.enviar('teste@example.invalid',{publicId:randomUUID(),segredo:randomBytes(32).toString('base64url')});
    assert.equal(mensagens.length,1);assert.equal(mensagens[0].from.address,env.MAIL_FROM_ADDRESS);
    const u=new URL(mensagens[0].text.match(/https:\/\/\S+/)[0]);assert.equal(u.origin,env.IST_LOJA_RECUPERACAO_ORIGEM_PUBLICA);assert.equal(u.search,'');assert(u.hash.includes('segredo='));
});
test('falha de configuracao ou construcao nao derruba API nem vaza detalhes',()=>{
    const avisos=[];assert.equal(comporEmailRecuperacao({env:envSmtp(),obterConfiguracao,criarEnvio:()=>{throw Error('SEGREDO-SINTETICO');},avisar:x=>avisos.push(x)}),undefined);
    assert.equal(avisos.join().includes('SEGREDO'),false);
    assert.equal(comporEmailRecuperacao({env:{...envSmtp(),IST_LOJA_DOWNLOAD_RECUPERACAO_CHAVE_EMAIL:undefined},obterConfiguracao,criarEnvio:()=>assert.fail()}),undefined);
});
test('diagnostico de envio e fixo sem destinatario, segredo ou resposta SMTP',async()=>{
    const avisos=[];let chamadas=0;
    const adaptador=comporEmailRecuperacao({env:envSmtp(),obterConfiguracao,avisar:c=>avisos.push(c),criarEnvio:()=>async()=>{chamadas++;throw Error('DADO-SINTETICO-SENSIVEL');}});
    await assert.rejects(adaptador.enviar('teste@example.invalid',{publicId:randomUUID(),segredo:randomBytes(32).toString('base64url')}),/ENVIO_RECUPERACAO_INDISPONIVEL/);
    assert.deepEqual(avisos,['RECUPERACAO_EMAIL_ENVIO_INDISPONIVEL']);assert.equal(chamadas,1);
});
test('consumidores antigos de enviarEmail preservam formato e transporte injetavel',async()=>{
    let m;await enviarEmail({to:'teste@example.invalid',subject:'Teste',html:'<p>sintetico</p>',fromName:'Nome',fromAddress:'remetente@example.invalid'},
        {sendMail:async x=>{m=x;return{};}});assert.equal(m.html,'<p>sintetico</p>');assert.equal(m.from.address,'remetente@example.invalid');
});
test('Nginx: mesmo location entrega index, headers sempre; fallback geral inalterado',async()=>{
    const nginx=await readFile(new URL('../nginx.conf',import.meta.url),'utf8');
    const bloco=nginx.match(/location ~ \^\/loja\/\(recuperar\|biblioteca\/confirmar\)\/\?\$ \{([\s\S]*?)\}/)?.[1];assert(bloco);
    assert.match(bloco,/try_files \/index\.html =404;/);assert.match(bloco,/Cache-Control "private, no-store, max-age=0" always/);
    assert.match(bloco,/Referrer-Policy "no-referrer" always/);assert.match(bloco,/etag off/);assert.match(bloco,/if_modified_since off/);
    assert.match(nginx,/location \/ \{\s*try_files \$uri \$uri\/ \/index\.html;/);
});
test('limpeza exige autorizacao, schema e lote limitado antes de obter conexao',async()=>{
    let acessos=0;const db={getConnection(){acessos++;throw Error();}};
    assert.throws(()=>criarLimpezaRecuperacao({db}));const limpar=criarLimpezaRecuperacao({db,bancoEsperado:'sintetico'}).limpar;
    for(const op of [{},{confirmarRetencao:true,limite:101},{confirmarRetencao:true,limite:0}])await assert.rejects(limpar(op),{codigo:'LIMPEZA_NAO_AUTORIZADA'});
    assert.equal(acessos,0);
});

const capturaEnv=()=>({...envSmtp(),NODE_ENV:'production',IST_SMTP_CAPTURA_LOCAL:'true',SMTP_HOST:'127.0.0.1',SMTP_PORT:'1025',SMTP_SECURE:'false'});
for(const host of ['127.0.0.1','::1'])test('B7-B6 captura explicita '+host+' reutiliza transporte e contratos',async()=>{
    const env={...capturaEnv(),SMTP_HOST:host};let opcoes,criados=0,envios=0;
    const enviar=criarEnvioRecuperacaoSmtp({env,criarTransporte:o=>{opcoes=o;criados++;return {sendMail:async m=>{envios++;assert.equal(m.to,'teste@example.invalid');assert.equal(m.text,'sintetico');return {accepted:[m.to]};}};}});
    assert.equal(criados,1);assert.equal(envios,0);
    assert.equal(opcoes.host,host);assert.equal(opcoes.port,1025);assert.equal(opcoes.secure,false);assert.equal(opcoes.requireTLS,false);assert.equal(opcoes.ignoreTLS,true);
    assert.deepEqual(opcoes.tls,{rejectUnauthorized:true});assert.equal(opcoes.auth,undefined);assert.equal(opcoes.pool,false);
    const geral=obterOpcoesSmtpGeral(env);for(const k of Object.keys(geral))assert.deepEqual(opcoes[k],geral[k]);
    assert.equal(await enviar({to:'teste@example.invalid',subject:'Teste',text:'sintetico'}),undefined);assert.equal(envios,1);
});
for(const extra of [
    {SMTP_HOST:'smtp.example.invalid'},{SMTP_HOST:'localhost'},{SMTP_HOST:'127.0.0.1.example.invalid'},{SMTP_HOST:'0.0.0.0'},
    {SMTP_HOST:'192.168.1.1'},{SMTP_HOST:'::ffff:127.0.0.1'},{SMTP_HOST:undefined},
    {SMTP_PORT:undefined},{SMTP_PORT:''},{SMTP_PORT:'0'},{SMTP_PORT:'65536'},{SMTP_PORT:'01025'},{SMTP_PORT:'1025 '},
    {SMTP_SECURE:undefined},{SMTP_SECURE:'true'},{SMTP_REJECT_UNAUTHORIZED:'false'},
    {SMTP_USER:'sintetico'},{SMTP_PASS:'sintetico'},{IST_LOJA_RECUPERACAO_SMTP_AUTENTICACAO:'login'},
    {IST_SMTP_CAPTURA_LOCAL:'TRUE'},{IST_SMTP_CAPTURA_LOCAL:'1'}
])test('B7-B6 captura invalida bloqueia transporte geral e estrito: '+JSON.stringify(extra),()=>{
    const env={...capturaEnv(),...extra};let criados=0;
    assert.throws(()=>obterOpcoesSmtpGeral(env),/CONFIGURACAO_SMTP/);
    assert.throws(()=>criarEnvioRecuperacaoSmtp({env,criarTransporte:()=>{criados++;return {};}}),/CONFIGURACAO_SMTP/);assert.equal(criados,0);
});
test('B7-B6 sem opt-in nao libera SMTP local no adaptador estrito',()=>{
    for(const flag of [undefined,'false'])assert.throws(()=>criarEnvioRecuperacaoSmtp({env:{...capturaEnv(),IST_SMTP_CAPTURA_LOCAL:flag}}),/CONFIGURACAO_SMTP/);
});
test('B7-B6 desligado preserva exatamente opcoes anteriores do transporte geral',()=>{
    const env=envSmtp();const antigo={host:env.SMTP_HOST,port:587,secure:false,auth:undefined,tls:{rejectUnauthorized:true}};
    assert.deepEqual(obterOpcoesSmtpGeral(env),antigo);assert.deepEqual(obterOpcoesSmtpGeral({...env,IST_SMTP_CAPTURA_LOCAL:'false'}),antigo);
    assert.deepEqual(obterOpcoesSmtpGeral({}),{host:'localhost',port:587,secure:false,auth:undefined,tls:{rejectUnauthorized:false}});
});
test('B7-B6 excecao local nao relaxa TLS externo',()=>{
    for(const extra of [{SMTP_PORT:'1025'},{SMTP_REJECT_UNAUTHORIZED:'false'},{SMTP_PORT:'465',SMTP_SECURE:'false'}]){
        let criados=0;assert.throws(()=>criarEnvioRecuperacaoSmtp({env:{...envSmtp(),...extra},criarTransporte:()=>{criados++;}}),/CONFIGURACAO_SMTP/);assert.equal(criados,0);
    }
});
test('B7-B6 composicao de recuperacao local nao conecta nem cria sessao, worker ou agendador',()=>{
    let criados=0,envios=0;const resultado=comporEmailRecuperacao({env:capturaEnv(),obterConfiguracao,
        criarEnvio:({env})=>criarEnvioRecuperacaoSmtp({env,criarTransporte:()=>{criados++;return{sendMail:()=>{envios++;assert.fail('ENVIO_NAO_AUTORIZADO');}};}})});
    assert.equal(typeof resultado.enviar,'function');assert.equal(criados,1);assert.equal(envios,0);
});
