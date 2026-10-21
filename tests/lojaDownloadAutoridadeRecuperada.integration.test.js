import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import cookieParser from 'cookie-parser';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {AsyncLocalStorage} from 'node:async_hooks';
import path from 'node:path';
import {criarFixtureDireitos,contextoDireitos} from './fixtures/lojaDownloadDireitosFixture.js';
import {criarLojaDownloadRecuperacaoService} from '../src/services/lojaDownloadRecuperacaoService.js';
import {criarLojaDownloadRecuperacaoRouter} from '../src/routes/lojaDownloadRecuperacao.routes.js';
import {criarLojaDownloadsRouter} from '../src/routes/lojaDownloads.routes.js';
import {criarLojaCheckoutRouter} from '../src/routes/lojaCheckout.routes.js';
import {criarLojaSessaoService,criarTokenCsrf} from '../src/services/lojaSessaoService.js';
import {criarConfiguracaoLojaSessao} from '../src/config/lojaSessao.js';
import {prepararArquivoValidado} from '../src/services/lojaDownloadArquivoService.js';
import {autenticarUsuario} from '../src/middlewares/authMiddleware.js';
import {normalizarAutoridadeDownload} from '../src/services/lojaDownloadAutoridade.js';

const inicio=Date.parse('2026-01-01T13:00:00.000Z'),origem='http://localhost:4200';
const pdf=Buffer.from('%PDF-1.7\nPDF SINTETICO D7-B3\n%%EOF\n'),hashPdf=createHash('sha256').update(pdf).digest();
const defer=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const aguardar=async promise=>{
    let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{
        timer=setTimeout(()=>reject(Error('Barreira concorrente nao atingida')),5000);
    })]);}finally{clearTimeout(timer);}
};
test('autoridades internas explicitas e tipadas; sem selecao por identidade arbitraria',()=>{
    const token=randomBytes(32).toString('base64url');
    assert.deepEqual(normalizarAutoridadeDownload(token),{tipo:'COMPRA',token});
    assert.deepEqual(normalizarAutoridadeDownload({tipo:'RECUPERACAO',token}),{tipo:'RECUPERACAO',token});
    for(const a of [undefined,{tipo:'ADMIN',token},{tipo:'COMPRA',token:'falso'}])assert.throws(()=>normalizarAutoridadeDownload(a),{codigo:'SESSAO_INVALIDA'});
});

test('D7.1-B3 autoridades COMPRA/RECUPERACAO com SQL e PDFs sinteticos reais',{
    skip:!process.env.IST_LOJA_PAGAMENTOS_MARIADB_BIN&&!process.env.IST_R2_10339_MANIFEST,timeout:240000
},async t=>{
    const f=await criarFixtureDireitos(t),{a,pool}=f;
    await a.query((await readFile(new URL('../migrations/ist_loja_download_recuperacao_fundacao.sql',import.meta.url),'utf8'))
        .replace(/^DELIMITER[^\r\n]*$/gm,'').replace(/END\$\$\s*$/,'END'));
    for(const id of [1,2])await a.query('UPDATE ist_loja_arquivo_versoes SET tamanho_bytes=?,sha256=? WHERE id=?',[pdf.length,hashPdf,id]);
    const chave=randomBytes(32),config=criarConfiguracaoLojaSessao({origens:[origem],segredoCsrf:randomBytes(32)});
    const preparar=async(email,estadoDireito='ATIVO')=>{
        const x=await f.preparar({estadoDireito}),token=randomBytes(32).toString('base64url');
        await a.query('UPDATE ist_loja_pedidos SET comprador_email=? WHERE id=?',[email,x.pedidoId]);
        await a.query('UPDATE ist_loja_sessoes SET token_hash=? WHERE id=?',[createHash('sha256').update(token).digest(),x.sessaoId]);
        return {...x,token,direitos:(await f.ler(x)).direitos};
    };
    const montar=async t=>{
        const raiz=await mkdtemp(path.join(tmpdir(),'ist-d71b3-'));
        for(const id of [1,2])await writeFile(path.join(raiz,`sintetico-${id}.pdf`),pdf);
        const porRequisicao=new AsyncLocalStorage();
        const estado={n:inicio,tx:0,traces:[],hook:null,falhaSql:false},agora=()=>new Date(estado.n);
        const db={async getConnection(){const c=await pool.getConnection(),dono=porRequisicao.getStore();let ativa=false;
            const fechar=()=>{if(ativa){estado.tx--;if(dono)dono.tx--;}ativa=false;};return {
            query:async(sql,p)=>{
                if(sql.includes('FOR UPDATE'))estado.traces.push(sql);
                if(estado.falhaSql&&sql.includes('FROM ist_loja_pagamentos WHERE'))throw Error('SQL_PRIVADO_SINTETICO');
                return c.query(sql,p);
            },beginTransaction:async()=>{await c.beginTransaction();ativa=true;estado.tx++;if(dono)dono.tx++;},
            commit:async()=>{await c.commit();fechar();},rollback:async()=>{await c.rollback();fechar();},
            release:()=>c.release(),destroy:()=>{fechar();c.destroy();}
        };}};
        const recuperacao=criarLojaDownloadRecuperacaoService({db:pool,chaveEmail:chave,contextoEsperado:contextoDireitos,agora});
        const sessaoService=criarLojaSessaoService({db:pool,agora});
        const app=express();app.use((req,res,next)=>porRequisicao.run({tx:0},()=>{
            res.once('finish',()=>assert.equal(porRequisicao.getStore()?.tx??0,0));next();
        }));
        app.use('/api/loja/downloads/recuperacao',criarLojaDownloadRecuperacaoRouter({db,service:recuperacao,obterConfiguracao:()=>config,agora}));
        app.use('/api/loja/downloads',criarLojaDownloadsRouter({db,env:{PRODUCTS_PATH:raiz},agora,agoraMs:()=>estado.n,
            contextoEsperado:contextoDireitos,sessaoService,obterConfiguracaoSessao:()=>config,
            prepararArquivo:async(...args)=>{
                assert.equal(porRequisicao.getStore().tx,0,'nenhuma transacao desta requisicao durante preparacao');
                const r=await prepararArquivoValidado(...args);await estado.hook?.();return r;
            }}));
        app.use('/api/loja/checkout',criarLojaCheckoutRouter({sessaoService,obterConfiguracaoSessao:()=>config,
            env:{IST_LOJA_PAYPAL_ENV:'sandbox',IST_LOJA_PAYPAL_CLIENT_ID:'PUBLICO_SINTETICO'},obterFinanceiro:()=>({})}));
        app.use(cookieParser());app.get('/admin-sentinela',autenticarUsuario,(req,res)=>res.json({admin:true}));
        const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
        t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await rm(raiz,{recursive:true});});
        const jar=()=>({cookies:new Map(),csrf:null});
        const enviar=async(j,url='/api/loja/downloads/direitos',{method='GET',body,headers={}}={})=>{
            const r=await fetch(`http://127.0.0.1:${server.address().port}`+url,{method,
                headers:{Origin:origem,'X-IST-Loja':'1',Cookie:[...j.cookies].map(([k,v])=>k+'='+v).join('; '),
                    ...(method==='POST'?{'Content-Type':'application/json','X-CSRF-Token':j.csrf??''}:{}),...headers},
                ...(body!==undefined?{body:JSON.stringify(body)}:{})});
            for(const v of r.headers.getSetCookie()){const [k,val]=v.split(';')[0].split('=');j.cookies.set(k,val);}
            const buffer=Buffer.from(await r.arrayBuffer()),text=buffer.toString('utf8');let dto;try{dto=JSON.parse(text);}catch{}
            if(dto?.csrfToken)j.csrf=dto.csrfToken;
            return {status:r.status,headers:r.headers,buffer,text,dto};
        };
        const compra=x=>({cookies:new Map([[config.cookie.nome,x.token]]),csrf:criarTokenCsrf(x.token,config.segredoCsrf)});
        const recuperar=async email=>{
            const d=await recuperacao.criarDesafio(email),r=await recuperacao.consumirDesafio(d.publicId,d.segredo),j=jar();
            j.cookies.set('ist-loja-recuperacao-dev',r.token);
            assert.equal((await enviar(j,'/api/loja/downloads/recuperacao/sessao')).status,200);
            return {j,token:r.token,sessao:r.sessao};
        };
        const arquivo=(j,id,opcoes)=>enviar(j,`/api/loja/downloads/itens/${id}/arquivo`,opcoes);
        const post=(j,id,headers={})=>enviar(j,`/api/loja/downloads/itens/${id}/reavaliar`,{method:'POST',body:{},headers});
        return {raiz,estado,recuperacao,jar,enviar,compra,recuperar,arquivo,post};
    };
    const negar=(r,status)=>{assert.equal(r.status,status);assert.doesNotMatch(r.text,/%PDF|caminho|sha256|SQL_PRIVADO|sessao_hash|captura/);};
    await t.test('COMPRA preservada; RECUPERACAO lista apenas escopo com paginacao e DTO D6',async t=>{
        const x=await preparar('lista-b3@example.invalid'),h=await montar(t),r=await h.recuperar('lista-b3@example.invalid');
        const original=await h.enviar(h.compra(x));assert.equal(original.status,200);assert.equal(original.dto.direitos.length,2);
        const lista=await h.enviar(r.j);assert.equal(lista.status,200);assert.deepEqual(lista.dto,original.dto);
        assert.deepEqual(Object.keys(lista.dto.direitos[0]),['publicId','titulo','estado','podeSolicitarArquivo']);
        const primeira=await h.enviar(r.j,'/api/loja/downloads/direitos?limite=1');
        const segunda=await h.enviar(r.j,'/api/loja/downloads/direitos?limite=1&apos='+primeira.dto.proximoCursor);
        assert.equal(primeira.dto.direitos.length,1);assert.equal(segunda.dto.direitos.length,1);assert.equal(segunda.dto.proximoCursor,null);
        negar(await h.enviar(r.j,'/api/loja/downloads/direitos?limite=51'),400);
    });
    await t.test('GET/HEAD integrais, versao retirada, sem Range/cache e SQL encerrado antes dos bytes',async t=>{
        const x=await preparar('arquivo-b3@example.invalid'),h=await montar(t),r=await h.recuperar('arquivo-b3@example.invalid'),id=x.direitos[0].public_id;
        const antes=JSON.stringify(await f.ler(x));
        for(const method of ['GET','HEAD']){
            const get=await h.arquivo(r.j,id,{method,headers:{Range:'bytes=0-2','If-Range':'"qualquer"'}});assert.equal(get.status,200);
            assert.deepEqual(get.buffer,method==='GET'?pdf:Buffer.alloc(0));assert.equal(get.headers.get('content-length'),String(pdf.length));
            assert.equal(get.headers.get('cache-control'),'private, no-store');assert.equal(get.headers.get('accept-ranges'),'none');
            assert.equal(get.headers.get('etag'),null);assert.equal(h.estado.tx,0);
        }
        assert.equal(JSON.stringify(await f.ler(x)),antes);
        const locks=h.estado.traces,rec=locks.findIndex(s=>s.includes('ist_loja_download_recuperacoes'));
        assert(rec>=0);assert(rec<locks.findIndex(s=>s.includes('FROM ist_loja_sessoes')));
    });
    await t.test('outro comprador, compra posterior e inexistente produzem o mesmo 404 sem fallback',async t=>{
        await preparar('escopo-b3@example.invalid');const h=await montar(t),r=await h.recuperar('escopo-b3@example.invalid');
        const outro=await preparar('outro-b3@example.invalid'),posterior=await preparar('escopo-b3@example.invalid');let resposta;
        for(const id of [outro.direitos[0].public_id,posterior.direitos[0].public_id,randomUUID()]){
            const get=await h.arquivo(r.j,id);negar(get,404);resposta??=get.text;assert.equal(get.text,resposta);
            negar(await h.post(r.j,id),404);
        }
        assert.equal((await h.enviar(r.j)).dto.direitos.length,2);
        // COMPRA poderia autorizar o outro pedido, mas RECUPERACAO prevalece.
        r.j.cookies.set(config.cookie.nome,outro.token);negar(await h.arquivo(r.j,outro.direitos[0].public_id),404);
        r.j.cookies.delete('ist-loja-recuperacao-dev');assert.equal((await h.arquivo(r.j,outro.direitos[0].public_id)).status,200);
    });
    await t.test('cookie recuperado invalido/duplicado nao cai para compra valida; expiracao e revogacao negam',async t=>{
        const x=await preparar('negacao-b3@example.invalid'),h=await montar(t),r=await h.recuperar('negacao-b3@example.invalid'),id=x.direitos[0].public_id;
        r.j.cookies.set(config.cookie.nome,x.token);
        const valido=r.j.cookies.get('ist-loja-recuperacao-dev');
        r.j.cookies.set('ist-loja-recuperacao-dev','invalido');negar(await h.arquivo(r.j,id),401);
        r.j.cookies.set('ist-loja-recuperacao-dev',valido);
        negar(await h.arquivo(r.j,id,{headers:{Cookie:`ist-loja-recuperacao-dev=${valido}; ist-loja-recuperacao-dev=${valido}; ${config.cookie.nome}=${x.token}`}}),401);
        h.estado.n+=86400000;negar(await h.arquivo(r.j,id),401);h.estado.n=inicio;
        await h.recuperacao.revogarSessao(r.token);negar(await h.arquivo(r.j,id),401);
    });
    await t.test('sessao original expirada nao impede recuperacao; consulta nao ativa e POST exige CSRF recuperado',async t=>{
        const x=await preparar('pendente-b3@example.invalid','AGUARDANDO_CONFIRMACAO'),h=await montar(t),r=await h.recuperar('pendente-b3@example.invalid'),id=x.direitos[0].public_id;
        await a.query("UPDATE ist_loja_sessoes SET expira_em='2026-01-01 12:00:00' WHERE id=?",[x.sessaoId]);
        assert.equal((await h.enviar(r.j)).dto.direitos[0].estado,'AGUARDANDO_CONFIRMACAO');
        for(const method of ['GET','HEAD'])negar(await h.arquivo(r.j,id,{method}),409);
        for(const headers of [{'X-CSRF-Token':''},{'X-CSRF-Token':criarTokenCsrf(x.token,config.segredoCsrf)},
            {Origin:'https://externo.invalid'},{Origin:'',Referer:origem+'/loja'}])negar(await h.post(r.j,id,headers),403);
        h.estado.traces=[];const post=await h.post(r.j,id);assert.equal(post.status,200);assert.deepEqual(post.dto,{publicId:id,estado:'ATIVO'});
        const direitos=(await f.ler(x)).direitos;assert.equal(direitos[0].estado,'ATIVO');assert.equal(direitos[1].estado,'AGUARDANDO_CONFIRMACAO');
        const antes=JSON.stringify(await f.ler(x));assert.equal((await h.post(r.j,id)).status,200);assert.equal(JSON.stringify(await f.ler(x)),antes);
        assert.equal((await h.arquivo(r.j,id)).status,200);
        assert(h.estado.traces[0].includes('ist_loja_download_recuperacoes'));
    });
    for(const estado of ['SUSPENSO','REVOGADO'])await t.test(`${estado} apos recuperacao permanece bloqueado e nao reativa`,async t=>{
        const x=await preparar(estado+'-b3@example.invalid'),h=await montar(t),r=await h.recuperar(estado+'-b3@example.invalid');
        const d=x.direitos[0],campo=estado==='SUSPENSO'?'suspenso_em':'revogado_em';
        await a.query(`UPDATE ist_loja_download_direitos SET estado=?,${campo}='2026-01-01 13:00:00',atualizado_em='2026-01-01 13:00:00',versao=3,motivo_codigo='SINTETICO' WHERE id=?`,[estado,d.id]);
        await a.query(`INSERT INTO ist_loja_download_direito_eventos(direito_id,direito_versao,estado_anterior,estado_novo,origem,motivo_codigo,ocorrido_em)
            VALUES(?,3,'ATIVO',?,'FINANCEIRO','SINTETICO','2026-01-01 13:00:00')`,[d.id,estado]);
        negar(await h.arquivo(r.j,d.public_id),409);const antes=JSON.stringify(await f.ler(x));
        assert.equal((await h.post(r.j,d.public_id)).status,200);assert.equal(JSON.stringify(await f.ler(x)),antes);
    });
    await t.test('PDF adulterado e evidencia financeira insuficiente nunca retornam bytes',async t=>{
        const x=await preparar('integridade-b3@example.invalid'),h=await montar(t),r=await h.recuperar('integridade-b3@example.invalid'),id=x.direitos[0].public_id;
        await writeFile(path.join(h.raiz,'sintetico-1.pdf'),Buffer.alloc(pdf.length,65));
        negar(await h.arquivo(r.j,id),503);await writeFile(path.join(h.raiz,'sintetico-1.pdf'),pdf);
        await a.query('UPDATE ist_loja_pagamentos SET reembolsado_centavos=50 WHERE id=?',[x.pagamentoId]);
        negar(await h.arquivo(r.j,id),409);h.estado.falhaSql=true;negar(await h.arquivo(r.j,id),503);
    });
    await t.test('revogacao confirmada durante preparacao impede autorizacao final sem locks no PDF',async t=>{
        const x=await preparar('revogacao-final@example.invalid'),h=await montar(t),r=await h.recuperar('revogacao-final@example.invalid');
        const pronto=defer(),liberar=defer();h.estado.hook=async()=>{assert.equal(h.estado.tx,0);pronto.resolve();await liberar.promise;};
        const download=h.arquivo(r.j,x.direitos[0].public_id);
        try{await aguardar(pronto.promise);assert.deepEqual(await h.recuperacao.revogarSessao(r.token),{revogada:true});}finally{liberar.resolve();}
        negar(await download,401);assert.equal(h.estado.tx,0);
    });
    await t.test('revogacao concorrente com primeiro lock aguarda; autorizacao observa revogada',async t=>{
        const x=await preparar('revogacao-lock@example.invalid'),h=await montar(t),r=await h.recuperar('revogacao-lock@example.invalid');
        const c=await pool.getConnection();await c.beginTransaction();
        await c.query('SELECT id FROM ist_loja_download_recuperacoes WHERE public_id=? FOR UPDATE',[r.sessao.publicId]);
        const download=h.arquivo(r.j,x.direitos[0].public_id);
        try{
            await c.query("UPDATE ist_loja_download_recuperacoes SET revogada_em='2026-01-01 13:00:00' WHERE public_id=?",[r.sessao.publicId]);await c.commit();
        }finally{await c.rollback();c.release();}
        negar(await download,401);
    });
    await t.test('versao adquirida divergente do escopo nao usa publicacao nova como fallback',async t=>{
        const x=await preparar('versao-b3@example.invalid'),h=await montar(t),r=await h.recuperar('versao-b3@example.invalid');
        await a.query(`INSERT INTO ist_loja_arquivo_versoes(id,public_id,produto_id,arquivo_logico_id,numero_versao,caminho_relativo,
            tamanho_bytes,sha256,mime,estado,criado_em,publicado_em,retirado_em)
            VALUES(101,?,1,?,2,'novo.pdf',?,?, 'application/pdf','RETIRADA','2026-01-01','2026-01-01','2026-01-01')`,[randomUUID(),randomUUID(),pdf.length,hashPdf]);
        await a.query('UPDATE ist_loja_download_direitos SET arquivo_versao_id=101 WHERE id=?',[x.direitos[0].id]);
        negar(await h.arquivo(r.j,x.direitos[0].public_id),404);negar(await h.post(r.j,x.direitos[0].public_id),404);
    });
    await t.test('duas entregas por sessao; terceira recusada; capacidade retorna e rate limit continua',async t=>{
        const x=await preparar('capacidade-b3@example.invalid'),h=await montar(t),r=await h.recuperar('capacidade-b3@example.invalid'),id=x.direitos[0].public_id;
        const pronto=defer(),liberar=defer();let leituras=0;
        h.estado.hook=async()=>{if(++leituras===2)pronto.resolve();await liberar.promise;};
        const downloads=[h.arquivo(r.j,id),h.arquivo(r.j,id)];
        try{await aguardar(pronto.promise);negar(await h.arquivo(r.j,id),429);}finally{liberar.resolve();}
        for(const d of await Promise.all(downloads))assert.equal(d.status,200);h.estado.hook=null;
        assert.equal((await h.arquivo(r.j,id)).status,200);
        for(let n=0;n<6;n++)assert.equal((await h.arquivo(r.j,id)).status,200);
        negar(await h.arquivo(r.j,id),429);h.estado.n+=60001;assert.equal((await h.arquivo(r.j,id)).status,200);
    });
    await t.test('cookie recuperado nao autentica checkout nem administracao',async t=>{
        const x=await preparar('isolamento-b3@example.invalid'),h=await montar(t),r=await h.recuperar('isolamento-b3@example.invalid');
        negar(await h.enviar(r.j,'/api/loja/checkout/configuracao',{method:'POST',body:{}}),401);
        assert.equal((await h.enviar(r.j,'/admin-sentinela')).status,401);
        assert.equal((await h.enviar(h.compra(x),'/api/loja/checkout/configuracao',{method:'POST',body:{}})).status,200);
    });
    t.diagnostic(`D7_1_B3_D6_REAL: ${f.identidade.versao}; schema ${f.identidade.banco}; porta ${f.identidade.porta}; somente PDFs e compras sinteticos.`);
});
