import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,createHash} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import https from 'node:https';
import {criarPercursoDownload} from './fixtures/lojaDownloadPercursoFixture.js';
import {criarNavegadorSintetico} from './fixtures/lojaNavegadorCdp.js';
import {criarLojaDownloadRecuperacaoRouter} from '../src/routes/lojaDownloadRecuperacao.routes.js';
import {comporEmailRecuperacao} from '../src/services/lojaDownloadRecuperacaoSmtp.js';
import {criarEnvioRecuperacaoSmtp} from '../src/services/mailService.js';

const origem='https://localhost:13381',esperar=ms=>new Promise(r=>setTimeout(r,ms));
test('D7.4 Angular real + Nginx TLS + compra e recuperacao SQL sinteticas',{
    skip:!process.env.IST_D74_BACKEND_HOST,timeout:240000
},async t=>{
    const host=process.env.IST_D74_BACKEND_HOST;
    assert.match(host,/^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.1$/,'Somente interface virtual WSL identificada.');
    const mensagens=[],chave=randomBytes(32);let router,clock=Date.now();
    const f=await criarPercursoDownload(t,{host,porta:13382,origens:[origem],relogio:()=>new Date(clock),
        configurarApp:async(app,{db,config,agora,contexto})=>{
            // Apenas o proxy descartavel se conecta a esta interface virtual de teste.
            app.set('trust proxy',true);
            const env={SMTP_HOST:'smtp.example.invalid',SMTP_PORT:'587',SMTP_SECURE:'false',SMTP_REJECT_UNAUTHORIZED:'true',
                MAIL_FROM_NAME:'Loja sintetica',MAIL_FROM_ADDRESS:'teste@example.invalid',IST_LOJA_RECUPERACAO_SMTP_AUTENTICACAO:'relay',
                IST_LOJA_RECUPERACAO_EMAIL_ATIVO:'true',IST_LOJA_RECUPERACAO_ORIGEM_PUBLICA:origem,
                IST_LOJA_DOWNLOAD_RECUPERACAO_CHAVE_EMAIL:chave.toString('base64url')};
            const adaptadorEmail=comporEmailRecuperacao({env,obterConfiguracao:()=>config,
                criarEnvio:({env})=>criarEnvioRecuperacaoSmtp({env,criarTransporte:()=>({sendMail:async m=>{mensagens.push(m);return{accepted:[m.to]};}})})});
            assert(adaptadorEmail);
            router=criarLojaDownloadRecuperacaoRouter({db,chaveEmail:chave,contextoEsperado:contexto,agora,obterConfiguracao:()=>config,adaptadorEmail});
            app.use('/api/loja/downloads/recuperacao',router);
            app.get('/api/usuarios/me',(req,res)=>res.status(401).json({erro:'SESSAO_AUSENTE'}));
        }});
    await f.a.query((await readFile(new URL('../migrations/ist_loja_download_recuperacao_fundacao.sql',import.meta.url),'utf8'))
        .replace(/^DELIMITER[^\r\n]*$/gm,'').replace(/END\$\$\s*$/,'END'));
    const getNginx=path=>new Promise((resolve,reject)=>{
        // Excecao de certificado somente neste TLS sintetico de loopback.
        const req=https.get(origem+path,{rejectUnauthorized:false,timeout:2000},r=>{const partes=[];r.on('data',b=>partes.push(b));r.on('end',()=>resolve({status:r.statusCode,headers:r.headers,html:Buffer.concat(partes).toString()}));});
        req.on('timeout',()=>req.destroy(Error('TIMEOUT_NGINX_TESTE')));req.on('error',reject);
    });
    let pronto=false;
    for(let n=0;n<45;n++){try{if((await getNginx('/api/usuarios/me')).status===401){pronto=true;break;}}catch{}await esperar(1000);}
    assert(pronto,'NGINX_PROXY_BACKEND_INDISPONIVEL: sem alterar Firewall ou rede.');
    t.after(()=>router.aguardarEnvios());
    let compra,direito,link,pagina,browser;
    const caso=async(nome,fn)=>{let falha=false;await t.test(nome,async()=>{try{await fn();}catch(e){
        falha=true;
        // Somente paths/status e marcadores fixos; nunca URL completa, corpo ou cookies.
        const respostas=(browser?.eventos??[]).filter(e=>e.method==='Network.responseReceived').map(e=>{
            const u=new URL(e.params.response.url);return{path:u.pathname,status:e.params.response.status};
        }).filter(r=>r.path.startsWith('/api/loja/'));
        t.diagnostic('D74_DIAGNOSTICO_HTTP='+JSON.stringify(respostas));
        if(pagina)try{t.diagnostic('D74_DIAGNOSTICO_UI='+JSON.stringify(await pagina.avaliar(`({
            aguardando:document.body.textContent.includes('Aguarde'),
            indisponivel:document.body.textContent.includes('indisponível'),
            naoAutorizada:document.body.textContent.includes('Não foi possível autorizar'),
            sessaoExpirada:document.body.textContent.includes('Sessão expirada')})`)));}catch{}
        throw e;
    }});if(falha)throw Error('D74_PERCURSO_INTERROMPIDO');};
    const avaliar=expr=>pagina.avaliar(expr);
    const fetchPagina=path=>avaliar(`fetch(${JSON.stringify(path)},{credentials:'include',headers:{'X-IST-Loja':'1'}}).then(async r=>({status:r.status,tipo:r.headers.get('content-type'),texto:await r.text()}))`);
    await caso('Nginx entrega build Angular real, headers de confirmacao e fallback, sem mounts privados',async()=>{
        for(const rota of ['/loja/recuperar','/loja/biblioteca/confirmar']){
            const r=await getNginx(rota);assert.equal(r.status,200);assert(r.html.includes('<app-root>'));assert(r.html.includes('loja-recuperacao-bootstrap.js'));
            assert.equal(r.headers['cache-control'],'private, no-store, max-age=0');assert.equal(r.headers['referrer-policy'],'no-referrer');
        }
        for(const rota of ['/loja','/loja/biblioteca','/loja/biblioteca/recuperar','/editora','/istbrasil.private/products/livros/sintetico.pdf']){
            const r=await getNginx(rota);assert.equal(r.status,200);assert(r.html.includes('<app-root>'));assert(!r.html.includes('%PDF'));
        }
    });
    await caso('compra convidada, pedido/direito e captura simulada; sessao original indisponivel',async()=>{
        compra=await f.compra();assert.equal((await f.dados(compra)).direitos[0].estado,'AGUARDANDO_CONFIRMACAO');
        await f.capturar(compra);assert.equal(compra.sim.chamadas.capturar,1);direito=(await f.dados(compra)).direitos[0];
        await f.a.query('UPDATE ist_loja_sessoes SET revogada_em=? WHERE id=?',[new Date(clock).toISOString().slice(0,23).replace('T',' '),compra.sessao.id]);
        browser=await criarNavegadorSintetico(t);pagina=await browser.pagina();
        await pagina.navegar('/loja/biblioteca/recuperar');await pagina.aguardar("!!document.querySelector('#recuperacao-email')");
    });
    await caso('formulario Angular solicita, resposta uniforme e SMTP simulado captura link HTTPS',async()=>{
        await avaliar("(()=>{const e=document.querySelector('#recuperacao-email');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'sintetico@example.invalid');e.dispatchEvent(new Event('input',{bubbles:true}));return true;})()");
        await pagina.clicar('Enviar instruções');
        await pagina.aguardar("document.body.textContent.includes('Se houver direitos elegíveis')");
        await router.aguardarEnvios();assert.equal(mensagens.length,1);
        link=new URL(mensagens[0].text.match(/https:\/\/\S+/)[0]);assert.equal(link.origin,origem);assert.equal(link.search,'');
        assert.equal(Number((await f.a.query('SELECT COUNT(*) n FROM ist_loja_download_recuperacoes WHERE consumido_em IS NOT NULL'))[0][0].n),0);
        const requests=browser.eventos.filter(e=>e.method==='Network.responseReceived'&&e.params.response.url.endsWith('/recuperacao/solicitar'));
        assert.equal(requests.at(-1).params.response.status,202);
    });
    await caso('outro contexto abre link; remove fragmento e nao consome automaticamente; headers reais Nginx',async()=>{
        pagina=await browser.pagina();const inicio=browser.eventos.length;
        await pagina.navegar(link.pathname+link.hash);await pagina.aguardar("document.body.textContent.includes('Confirmar recuperação')");
        assert.equal(await avaliar('location.hash'),'');assert.equal(await avaliar('location.search'),'');
        assert.equal(await avaliar(`Object.values(localStorage).concat(Object.values(sessionStorage)).some(v=>String(v).includes(${JSON.stringify(new URLSearchParams(link.hash.slice(1)).get('segredo'))}))`),false);
        assert.equal(Number((await f.a.query('SELECT COUNT(*) n FROM ist_loja_download_recuperacoes WHERE consumido_em IS NOT NULL'))[0][0].n),0);
        const eventos=browser.eventos.slice(inicio).filter(e=>e.sessionId===pagina.sessionId);
        assert(!eventos.some(e=>e.method==='Network.requestWillBeSent'&&e.params.request.method==='POST'&&e.params.request.url.endsWith('/validar')));
        assert(!eventos.some(e=>e.method==='Fetch.requestPaused'&&!e.params.request.url.startsWith(origem+'/')));
        const resposta=eventos.find(e=>e.method==='Network.responseReceived'&&e.params.type==='Document').params.response;
        const hs=Object.fromEntries(Object.entries(resposta.headers).map(([k,v])=>[k.toLowerCase(),v]));
        assert.equal(resposta.status,200);assert.equal(hs['cache-control'],'private, no-store, max-age=0');assert.equal(hs['referrer-policy'],'no-referrer');
        assert(await avaliar("!!document.querySelector('app-loja-recuperacao')"));
    });
    await caso('confirmacao explicita emite sessao; biblioteca real lista apenas direito adquirido',async()=>{
        await pagina.clicar('Confirmar acesso');await pagina.aguardar("location.pathname==='/loja/biblioteca'&&document.body.textContent.includes('Aguardando confirmação')");
        assert.equal(await avaliar("!![...document.querySelectorAll('button')].find(b=>b.textContent.includes('Encerrar sessão recuperada'))"),true);
        assert.equal(Number((await f.a.query('SELECT COUNT(*) n FROM ist_loja_download_recuperacoes WHERE sessao_hash IS NOT NULL'))[0][0].n),1);
        const lista=await fetchPagina('/api/loja/downloads/direitos');assert.equal(lista.status,200);const ds=JSON.parse(lista.texto).direitos;
        assert.equal(ds.length,1);assert.equal(ds[0].publicId,direito.public_id);assert.equal(ds[0].estado,'AGUARDANDO_CONFIRMACAO');
        const posterior=await f.compra();await f.capturar(posterior);
        assert.equal(JSON.parse((await fetchPagina('/api/loja/downloads/direitos')).texto).direitos.length,1);
        const r=await fetchPagina('/api/loja/downloads/itens/'+(await f.dados(posterior)).direitos[0].public_id+'/arquivo');assert.equal(r.status,404);assert(!r.texto.includes('%PDF'));
    });
    await caso('reavaliacao manual com CSRF, download Blob real e SHA-256 exato',async()=>{
        await avaliar("(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('Verificar confirmação'));b.click();return true;})()");
        await pagina.aguardar("!![...document.querySelectorAll('button')].find(b=>b.textContent.trim().startsWith('Baixar '))");
        assert.equal((await f.dados(compra)).direitos[0].estado,'ATIVO');
        await avaliar("(()=>{[...document.querySelectorAll('button')].find(b=>b.textContent.trim().startsWith('Baixar ')).click();return true;})()");
        let arquivo;for(let n=0;n<100;n++){arquivo=(await readdir(browser.downloads)).find(x=>x.endsWith('.pdf'));if(arquivo)break;await esperar(100);}
        assert(arquivo,'Download Blob nao terminou.');const bytes=await readFile(new URL('file:///'+browser.downloads.replaceAll('\\','/')+'/'+arquivo));
        assert.deepEqual(bytes,f.pdf);assert.equal(createHash('sha256').update(bytes).digest('hex'),createHash('sha256').update(f.pdf).digest('hex'));
        t.diagnostic('D74_PDF: bytes identicos e SHA-256 conferido no arquivo baixado pelo Chrome.');
        assert.equal(await avaliar(`Object.values(localStorage).concat(Object.values(sessionStorage)).some(v=>String(v).includes(${JSON.stringify(new URLSearchParams(link.hash.slice(1)).get('segredo'))}))`),false);
    });
    await caso('revogacao pela interface encerra sessao; novo download nega sem bytes PDF',async()=>{
        await pagina.clicar('Encerrar sessão recuperada');await pagina.aguardar("document.body.textContent.includes('Sessão recuperada encerrada')");
        const r=await fetchPagina('/api/loja/downloads/itens/'+direito.public_id+'/arquivo');assert.equal(r.status,401);assert(!r.texto.includes('%PDF'));
        await pagina.navegar('/loja/biblioteca');await pagina.aguardar("document.body.textContent.includes('Sessão expirada ou inválida')");
        assert.equal((await f.dados(compra)).direitos[0].estado,'ATIVO');
    });
    t.diagnostic(`D74_ANGULAR_REAL: ${f.identidade.versao}; schema ${f.identidade.banco}; porta SQL ${f.identidade.porta}; Chrome CDP, Angular real, Nginx TLS local, SMTP simulado.`);
});
