import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {randomBytes,createHash,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {criarConfiguracaoLojaSessao} from '../src/config/lojaSessao.js';
import {criarLojaDownloadRecuperacaoRouter} from '../src/routes/lojaDownloadRecuperacao.routes.js';
import {criarAdaptadorEmailRecuperacao} from '../src/services/lojaDownloadRecuperacaoEmail.js';
import {criarLojaDownloadRecuperacaoService} from '../src/services/lojaDownloadRecuperacaoService.js';
import {criarFixtureDireitos,contextoDireitos} from './fixtures/lojaDownloadDireitosFixture.js';

const origem='http://localhost:4200',chave=randomBytes(32),csrf=randomBytes(32),inicio=Date.parse('2026-01-01T13:00:00.000Z');
test('adaptador exige transporte e origem confiaveis; formato compativel com enviarEmail, sem retorno de segredo',async()=>{
    for(const origemPublica of [undefined,'/relativa','https://site.invalid/caminho','http://site.invalid'])
        assert.throws(()=>criarAdaptadorEmailRecuperacao({origemPublica,enviarEmail(){}}));
    assert.throws(()=>criarAdaptadorEmailRecuperacao({origemPublica:origem}));
    const mensagens=[],d={publicId:randomUUID(),segredo:randomBytes(32).toString('base64url')};
    const a=criarAdaptadorEmailRecuperacao({origemPublica:origem,enviarEmail:async m=>mensagens.push(m)});
    assert.equal(await a.enviar('Teste@EXAMPLE.INVALID',d),undefined);
    assert.deepEqual(Object.keys(mensagens[0]),['to','subject','text']);assert.equal(mensagens[0].to,'Teste@example.invalid');
    const url=new URL(mensagens[0].text.match(/https?:\/\/\S+/)[0]);
    assert.equal(url.origin,origem);assert.equal(url.search,'');assert.equal(url.pathname,'/loja/recuperar');
    assert.equal(new URLSearchParams(url.hash.slice(1)).get('segredo'),d.segredo);
    const b=criarAdaptadorEmailRecuperacao({origemPublica:origem,enviarEmail:async()=>{throw Error(d.segredo);}});
    await assert.rejects(b.enviar('t@example.invalid',d),e=>e.message==='ENVIO_RECUPERACAO_INDISPONIVEL'&&!String(e).includes(d.segredo));
});

test('D7.1-B2 HTTP, envio simulado e persistencia real descartavel',{
    skip:!process.env.IST_LOJA_PAGAMENTOS_MARIADB_BIN&&!process.env.IST_R2_10339_MANIFEST,timeout:240000
},async t=>{
    const f=await criarFixtureDireitos(t),{a,pool}=f;
    await a.query((await readFile(new URL('../migrations/ist_loja_download_recuperacao_fundacao.sql',import.meta.url),'utf8'))
        .replace(/^DELIMITER[^\r\n]*$/gm,'').replace(/END\$\$\s*$/,'END'));
    t.diagnostic(`D7_1_B2_HTTP: ${f.identidade.versao}; schema ${f.identidade.banco}; porta ${f.identidade.porta}; somente emails e dados sinteticos.`);
    const preparar=async(email,estadoDireito='ATIVO')=>{
        const x=await f.preparar({estadoDireito});await a.query('UPDATE ist_loja_pedidos SET comprador_email=? WHERE id=?',[email,x.pedidoId]);return x;
    };
    const snapshot=async()=>{
        const rows=[];for(const tab of ['ist_loja_sessoes','ist_loja_pedidos','ist_loja_pedido_itens','ist_loja_pagamentos',
            'ist_loja_pagamento_operacoes','ist_loja_pagamento_eventos','ist_loja_download_direitos','ist_loja_download_direito_eventos'])
            rows.push((await a.query(`SELECT * FROM ${tab} ORDER BY id`))[0]);
        return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
    };
    const http=async(t,{producao=false,transporte,service,semAdaptador=false}={})=>{
        const mensagens=[],clock={n:inicio},agora=()=>new Date(clock.n),o=producao?'https://loja.example.invalid':origem;
        const config=criarConfiguracaoLojaSessao({producao,origens:[o],segredoCsrf:csrf});
        const interno=service??criarLojaDownloadRecuperacaoService({db:pool,chaveEmail:chave,contextoEsperado:contextoDireitos,agora});
        const router=criarLojaDownloadRecuperacaoRouter({db:pool,service:interno,obterConfiguracao:()=>config,contextoEsperado:contextoDireitos,agora,
            adaptadorEmail:semAdaptador?undefined:criarAdaptadorEmailRecuperacao({origemPublica:o,producao,
                enviarEmail:transporte??(async m=>mensagens.push(m))})});
        const app=express();app.set('trust proxy','loopback');app.use('/api/loja/downloads/recuperacao',router);
        // Global CORS permissivo sentinela: router nao deixa erros vazarem para ele.
        app.use((req,res)=>res.set('Access-Control-Allow-Origin','*').status(599).end());
        const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
        t.after(async()=>{await router.aguardarEnvios();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
        const jar=()=>({cookies:new Map([[config.cookie.nome,randomBytes(32).toString('base64url')]]),csrf:null});
        const enviar=async(j,path='/sessao',{method='GET',body,headers={}}={})=>{
            const r=await fetch('http://127.0.0.1:'+server.address().port+'/api/loja/downloads/recuperacao'+path,{method,
                headers:{Origin:o,'X-IST-Loja':'1',Cookie:[...j.cookies].map(([k,v])=>k+'='+v).join('; '),
                    ...(method==='POST'?{'Content-Type':'application/json','X-CSRF-Token':j.csrf??''}:{}),...headers},
                ...(body!==undefined?{body:typeof body==='string'?body:JSON.stringify(body)}:{})});
            const cookies=r.headers.getSetCookie();for(const c of cookies){const [nome,valor]=c.split(';')[0].split('=');if(valor)j.cookies.set(nome,valor);else j.cookies.delete(nome);}
            const text=await r.text();let dto;try{dto=JSON.parse(text);}catch{}
            if(dto?.csrfToken)j.csrf=dto.csrfToken;
            return {status:r.status,headers:r.headers,cookies,text,dto};
        };
        const bootstrap=async()=>{const j=jar();assert.equal((await enviar(j)).status,200);return j;};
        const solicitar=async(j,email,opcoes={})=>{const r=await enviar(j,'/solicitar',{method:'POST',body:{email},...opcoes});await router.aguardarEnvios();return r;};
        const desafio=()=>{
            const url=new URL(mensagens.at(-1).text.match(/https?:\/\/\S+/)[0]),p=new URLSearchParams(url.hash.slice(1));
            return {publicId:p.get('id'),segredo:p.get('segredo')};
        };
        const validar=(j,d)=>enviar(j,'/validar',{method:'POST',body:d});
        return {mensagens,clock,jar,enviar,bootstrap,solicitar,desafio,validar,config,router};
    };
    await t.test('resposta 202 uniforme para elegivel, sem compras, suspenso e envio desabilitado; sem efeitos financeiros',async t=>{
        await preparar('uniforme@example.invalid');await preparar('suspenso@example.invalid','SUSPENSO');const antes=await snapshot();
        const h=await http(t),j=await h.bootstrap();
        const respostas=[];for(const email of ['uniforme@example.invalid','ausente@example.invalid','suspenso@example.invalid'])respostas.push(await h.solicitar(j,email));
        assert(respostas.every(r=>r.status===202&&r.text===respostas[0].text&&r.cookies.length===0));assert.equal(h.mensagens.length,1);
        const vazio=await http(t,{semAdaptador:true});assert.equal((await vazio.solicitar(await vazio.bootstrap(),'uniforme@example.invalid')).text,respostas[0].text);
        assert.equal(await snapshot(),antes);
    });
    await t.test('tres envios por email/hora; supressao indistinguivel mesmo mudando IP',async t=>{
        await preparar('quota@example.invalid');const h=await http(t),j=await h.bootstrap();let texto;
        for(let n=0;n<4;n++){
            const r=await h.solicitar(j,'quota@example.invalid',{headers:{'X-Forwarded-For':'192.0.2.'+(n+1)}});
            assert.equal(r.status,202);texto??=r.text;assert.equal(r.text,texto);
        }
        assert.equal(h.mensagens.length,3);
    });
    await t.test('cinco solicitacoes por IP/15min; sexta nao cria desafio; janela volta a liberar',async t=>{
        const h=await http(t),j=await h.bootstrap();
        for(let n=0;n<6;n++){await preparar('ip'+n+'@example.invalid');assert.equal((await h.solicitar(j,'ip'+n+'@example.invalid')).status,202);}
        assert.equal(h.mensagens.length,5);h.clock.n+=900001;await h.enviar(j);
        assert.equal((await h.solicitar(j,'ip5@example.invalid')).status,202);assert.equal(h.mensagens.length,6);
    });
    await t.test('falha do transporte nao altera resposta nem emite sessao; erro/segredo nao vazam',async t=>{
        await preparar('falha@example.invalid');const h=await http(t,{transporte:async()=>{throw Error('SEGREDO_TRANSPORTE');}}),j=await h.bootstrap();
        const r=await h.solicitar(j,'falha@example.invalid');assert.equal(r.status,202);assert.doesNotMatch(r.text,/SEGREDO|token|sql|sessao_hash/i);
        assert.equal(r.cookies.length,0);assert.equal((await h.enviar(j)).dto.sessao.autenticada,false);
    });
    await t.test('POST explicito em outro navegador, cookie separado e consulta sem tokens/direitos internos',async t=>{
        const compra=await preparar('dispositivo@example.invalid');const h=await http(t),orig=await h.bootstrap();
        await a.query('UPDATE ist_loja_sessoes SET token_hash=? WHERE id=?',[
            createHash('sha256').update(orig.cookies.get(h.config.cookie.nome)).digest(),compra.sessaoId]);
        const antes=await snapshot();
        await h.solicitar(orig,'dispositivo@example.invalid');const d=h.desafio(),j=await h.bootstrap(),checkout=j.cookies.get(h.config.cookie.nome);
        const r=await h.validar(j,d);assert.equal(r.status,200);assert.equal(r.dto.sessao.autenticada,true);
        assert.equal(r.cookies.length,1);assert.match(r.cookies[0],/^ist-loja-recuperacao-dev=/);
        assert.match(r.cookies[0],/HttpOnly/);assert.match(r.cookies[0],/SameSite=Lax/);assert.match(r.cookies[0],/Path=\//);
        assert.doesNotMatch(r.cookies[0],/Domain=|Secure/);assert.equal(j.cookies.get(h.config.cookie.nome),checkout);
        assert(!r.text.includes(d.segredo));assert.doesNotMatch(r.text,/direitoId|arquivoVersaoId|sessao_hash|token/i);
        assert.equal((await h.enviar(j)).dto.sessao.autenticada,true);
        assert.equal((await h.enviar(orig)).dto.sessao.autenticada,false);
        assert.equal(await snapshot(),antes);
    });
    await t.test('producao: cookie __Host independente, Secure e expiracao absoluta',async t=>{
        await preparar('secure@example.invalid');const h=await http(t,{producao:true}),j=await h.bootstrap();
        await h.solicitar(j,'secure@example.invalid');const r=await h.validar(j,h.desafio());assert.equal(r.status,200);
        assert.match(r.cookies[0],/^__Host-ist-loja-recuperacao=/);assert.match(r.cookies[0],/; Secure/);assert.doesNotMatch(r.cookies[0],/Domain=/);
        assert.equal(Date.parse(r.dto.sessao.expiraEm)-h.clock.n,86400000);
    });
    await t.test('invalido, expirado e replay nunca emitem cookie; cinco falhas bloqueiam segredo correto',async t=>{
        await preparar('invalidos@example.invalid');const h=await http(t),j=await h.bootstrap();
        await h.solicitar(j,'invalidos@example.invalid');const d=h.desafio();
        for(let n=0;n<5;n++){const r=await h.validar(j,{...d,segredo:randomBytes(32).toString('base64url')});assert.equal(r.status,400);assert.equal(r.cookies.length,0);}
        assert.equal((await h.validar(j,d)).status,400);
        await h.solicitar(j,'invalidos@example.invalid');const expirado=h.desafio();h.clock.n+=900001;await h.enviar(j);
        assert.equal((await h.validar(j,expirado)).status,400);
        await h.solicitar(j,'invalidos@example.invalid');const usado=h.desafio();assert.equal((await h.validar(j,usado)).status,200);
        const replay=await h.validar(j,usado);assert.equal(replay.status,400);assert.equal(replay.cookies.length,0);
    });
    await t.test('validacoes concorrentes entregam cookie apenas ao vencedor',async t=>{
        await preparar('concorrencia-http@example.invalid');const h=await http(t),j=await h.bootstrap();await h.solicitar(j,'concorrencia-http@example.invalid');
        const d=h.desafio(),outro=await h.bootstrap(),rs=await Promise.all([h.validar(j,d),h.validar(outro,d)]);
        assert.deepEqual(rs.map(r=>r.status).sort(),[200,400]);assert.equal(rs.reduce((n,r)=>n+r.cookies.length,0),1);
    });
    await t.test('revogacao persistente remove somente cookie recuperado; sessao deixa de autenticar',async t=>{
        await preparar('revogar-http@example.invalid');const h=await http(t),j=await h.bootstrap();await h.solicitar(j,'revogar-http@example.invalid');await h.validar(j,h.desafio());
        const original=j.cookies.get(h.config.cookie.nome),copiado=h.jar();copiado.cookies=new Map(j.cookies);copiado.csrf=j.csrf;
        const r=await h.enviar(j,'/revogar',{method:'POST',body:{}});assert.equal(r.status,200);assert.equal(r.dto.revogada,true);
        assert.match(r.cookies[0],/^ist-loja-recuperacao-dev=;/);assert.equal(j.cookies.get(h.config.cookie.nome),original);
        assert.equal((await h.enviar(copiado)).dto.sessao.autenticada,false);
    });
    await t.test('CSRF obrigatorio; bootstrap adulterado, duplicado ou expirado e origem externa bloqueados',async t=>{
        const h=await http(t),j=await h.bootstrap();
        for(const headers of [{'X-CSRF-Token':''},{Origin:'https://externo.invalid'},{'X-IST-Loja':'0'},
            {Cookie:'ist-loja-recuperacao-csrf-dev=adulterado'},
            {Cookie:[...j.cookies].map(([k,v])=>k+'='+v).join('; ')+'; ist-loja-recuperacao-csrf-dev=duplicado'}]){
            const r=await h.enviar(j,'/solicitar',{method:'POST',body:{email:'csrf@example.invalid'},headers});assert([400,403].includes(r.status));
            assert.equal(r.cookies.length,0);assert.doesNotMatch(r.text,/segredo|SELECT|token/i);
        }
        h.clock.n+=900000;assert.equal((await h.solicitar(j,'csrf@example.invalid')).status,403);
    });
    await t.test('CORS restrito inclusive erros/preflight; nao ha wildcard nem queda no CORS global',async t=>{
        const h=await http(t),j=await h.bootstrap();
        const bom=await h.enviar(j,'/validar',{method:'OPTIONS',headers:{'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'Content-Type,X-CSRF-Token,X-IST-Loja'}});
        assert.equal(bom.status,204);assert.equal(bom.headers.get('access-control-allow-origin'),origem);
        for(const headers of [{Origin:'https://externo.invalid'},{'Access-Control-Request-Method':'DELETE'},{'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'authorization'}]){
            const r=await h.enviar(j,'/validar',{method:'OPTIONS',headers});assert.equal(r.status,403);assert.notEqual(r.headers.get('access-control-allow-origin'),'*');
        }
    });
    await t.test('Host malicioso nao participa do link; GET de scanner e query com token nao consomem',async t=>{
        await preparar('host@example.invalid');const h=await http(t),j=await h.bootstrap();
        await h.solicitar(j,'host@example.invalid',{headers:{Host:'roubo.example.invalid','X-Forwarded-Host':'roubo.example.invalid'}});
        assert(!h.mensagens[0].text.includes('roubo.example.invalid'));assert(h.mensagens[0].text.includes(origem+'/loja/recuperar#'));
        const d=h.desafio(),get=await h.enviar(j,'/validar');assert.equal(get.status,404);
        const query=await h.enviar(j,'/validar?segredo='+d.segredo);assert.equal(query.status,400);assert(!query.text.includes(d.segredo));
        assert.equal((await h.validar(j,d)).status,200);
    });
    await t.test('validacao limitada por IP e sintaxe/corpo excessivo rejeitados',async t=>{
        const h=await http(t),j=await h.bootstrap();
        for(let n=0;n<10;n++)assert.equal((await h.validar(j,{publicId:randomUUID(),segredo:randomBytes(32).toString('base64url')})).status,400);
        assert.equal((await h.validar(j,{publicId:randomUUID(),segredo:'malformado'})).status,429);
        for(const body of [{email:'invalido'},{email:'a@example.invalid',extra:1},'{',JSON.stringify({email:'a'.repeat(2000)})])
            assert.equal((await h.enviar(j,'/solicitar',{method:'POST',body})).status,400);
    });
    await t.test('envio lento nao bloqueia 202; quatro tarefas no maximo, sem fila ou criacao de sessao',async t=>{
        for(let n=0;n<5;n++)await preparar('lento'+n+'@example.invalid');
        let encerrando=false;
        const liberar=[],h=await http(t,{transporte:()=>new Promise(resolve=>encerrando?resolve():liberar.push(resolve))}),j=await h.bootstrap();
        try{
            for(let n=0;n<5;n++){
                const r=await h.enviar(j,'/solicitar',{method:'POST',body:{email:'lento'+n+'@example.invalid'}});
                assert.equal(r.status,202);assert.equal(r.cookies.length,0);
            }
            // Barreira SQL curta, sem sleeps: aguardar os quatro INSERTs confirmados.
            for(let n=0;n<100&&liberar.length<4;n++)await a.query('SELECT 1');
            assert.equal(liberar.length,4);assert.equal((await h.enviar(j)).dto.sessao.autenticada,false);
        }finally{encerrando=true;for(const resolve of liberar)resolve();}
        await h.router.aguardarEnvios();
    });
    await t.test('sessao recuperada expirada ou cookie duplicado nao autentica e nao renova prazo',async t=>{
        await preparar('sessao-expirada@example.invalid');const h=await http(t),j=await h.bootstrap();
        await h.solicitar(j,'sessao-expirada@example.invalid');const r=await h.validar(j,h.desafio());assert.equal(r.status,200);
        const cookie=[...j.cookies].map(([k,v])=>k+'='+v).join('; ')+'; ist-loja-recuperacao-dev=duplicada';
        assert.equal((await h.enviar(j,'/sessao',{headers:{Cookie:cookie}})).dto.sessao.autenticada,false);
        h.clock.n+=86400000;const expirada=await h.enviar(j);assert.equal(expirada.dto.sessao.autenticada,false);
        assert(expirada.cookies.every(c=>!c.startsWith('ist-loja-recuperacao-dev=')));
        assert.equal((await h.enviar(j,'/revogar',{method:'POST',body:{}})).status,401);
    });
    await t.test('COMMIT incerto real apos persistencia: HTTP 503 sem cookie e replay bloqueado',async t=>{
        await preparar('commit-http@example.invalid');
        const db={async getConnection(){const c=await pool.getConnection();let consumo=false;return {
            query:(sql,p)=>{if(sql.includes('SET consumido_em=?'))consumo=true;return c.query(sql,p);},beginTransaction:()=>c.beginTransaction(),rollback:()=>c.rollback(),release:()=>c.release(),destroy:()=>c.destroy(),
            commit:async()=>{await c.commit();if(consumo)throw Error('SEGREDO_COMMIT');}
        };}};
        const service=criarLojaDownloadRecuperacaoService({db,chaveEmail:chave,contextoEsperado:contextoDireitos,agora:()=>new Date(inicio)});
        const h=await http(t,{service}),j=await h.bootstrap();await h.solicitar(j,'commit-http@example.invalid');const d=h.desafio();
        const r=await h.validar(j,d);assert.equal(r.status,503);assert.equal(r.cookies.length,0);assert(!r.text.includes(d.segredo));assert(!r.text.includes('SEGREDO_COMMIT'));
        assert.equal((await h.validar(j,d)).status,400);
    });
});
