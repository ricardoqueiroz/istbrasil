import express from 'express';
import {randomBytes,createHmac} from 'node:crypto';
import {carregarConfiguracaoLojaSessao} from '../config/lojaSessao.js';
import {lerCookieLoja} from '../middlewares/lojaSessaoMiddleware.js';
import {criarTokenCsrf,csrfValido,tokenSessaoValido} from '../services/lojaSessaoService.js';
import {normalizarEmailComprador} from '../services/lojaPedidoContratos.js';
import {criarLojaDownloadRecuperacaoService} from '../services/lojaDownloadRecuperacaoService.js';
import {avaliarElegibilidadeFinanceiraNaConexao} from '../services/lojaDownloadFinanceiroService.js';
import {cookiesRecuperacao,assinarBootstrapRecuperacao,lerBootstrapRecuperacao} from '../middlewares/lojaRecuperacaoCsrf.js';

const erro=codigo=>Object.assign(new Error(codigo),{codigo});
const uniforme=Object.freeze({mensagem:'Se houver direitos elegiveis, enviaremos as instrucoes de recuperacao.'});
const encerrar=c=>{try{c.destroy();}catch{}};
const corpo=(req,chaves)=>req.body&&Object.getPrototypeOf(req.body)===Object.prototype
    &&Object.keys(req.body).length===chaves.length&&chaves.every(k=>Object.hasOwn(req.body,k));

// Somente leitura. Posse e escopo continuam decididos exclusivamente pela B1.
const possuiDireitos=async(db,email,contexto)=>{
    let c,iniciou=false,commit=false;
    try{
        c=await db.getConnection();
        const [[s]]=await c.query('SELECT @@in_transaction tx,@@autocommit ac');
        if(Number(s.tx)!==0||Number(s.ac)!==1)throw Error();
        await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
        await c.beginTransaction();iniciou=true;
        const [ds]=await c.query(`SELECT d.id,p.id pedido_id FROM ist_loja_pedidos p
            JOIN ist_loja_pedido_itens i ON i.pedido_id=p.id
            JOIN ist_loja_download_direitos d ON d.pedido_item_id=i.id AND d.produto_id=i.produto_id
            WHERE p.comprador_email=? AND BINARY p.comprador_email=BINARY ? AND p.ambiente=?
            AND d.estado IN ('ATIVO','AGUARDANDO_CONFIRMACAO') ORDER BY p.id,d.id LIMIT 51`,[email,email,contexto.ambiente]);
        let elegivel=false;
        if(ds.length<=50)for(const pedido of new Set(ds.map(d=>d.pedido_id))){
            let falha=false;
            const a=await avaliarElegibilidadeFinanceiraNaConexao({query:async(...args)=>{
                try{return await c.query(...args);}catch(e){falha=true;throw e;}
            }},pedido,contexto);
            if(falha)throw Error();
            if(a.classificacao==='ELEGIVEL'&&a.elegivel===true){elegivel=true;break;}
        }
        commit=true;await c.commit();iniciou=false;return elegivel;
    }catch{
        if(c&&(commit||!iniciou)){encerrar(c);c=null;}
        else if(c)try{await c.rollback();}catch{encerrar(c);c=null;}
        throw erro('RECUPERACAO_INDISPONIVEL');
    }finally{c?.release();}
};

export const criarLojaDownloadRecuperacaoRouter=({db,env=process.env,
    obterConfiguracao=()=>carregarConfiguracaoLojaSessao(env),service,adaptadorEmail,
    chaveEmail,contextoEsperado,agora=()=>new Date()}={})=>{
    const router=express.Router(),limites=new Map(),tarefas=new Set(),sal=randomBytes(32);
    let servico;
    const config=()=>cookiesRecuperacao(obterConfiguracao());
    const contexto=()=>contextoEsperado??{provedor:'paypal',ambiente:env.IST_LOJA_PAYPAL_ENV,contaRecebedora:env.IST_LOJA_PAYPAL_CONTA_RECEBEDORA};
    const obterService=()=>{
        if(service)return service;
        if(servico)return servico;
        const texto=env.IST_LOJA_DOWNLOAD_RECUPERACAO_CHAVE_EMAIL;
        const chave=chaveEmail??(typeof texto==='string'&&tokenSessaoValido(texto)?Buffer.from(texto,'base64url'):null);
        return servico=criarLojaDownloadRecuperacaoService({db,chaveEmail:chave,contextoEsperado:contexto(),agora});
    };
    const consumirLimite=(chave,max,ms)=>{
        const n=agora().getTime();
        for(const [k,v]of limites)if(v.ate<=n)limites.delete(k);
        let v=limites.get(chave);
        if(!v){if(limites.size>=10000)return false;v={n:0,ate:n+ms};limites.set(chave,v);}
        return ++v.n<=max;
    };
    const assinar=assinarBootstrapRecuperacao;
    const bootstrap=(req,c)=>lerBootstrapRecuperacao(req,c,()=>agora().getTime());
    const responder=(res,status,obj)=>{res.removeHeader('ETag');res.status(status).type('application/json').end(JSON.stringify(obj));};
    router.use((req,res,next)=>{
        res.set({'Cache-Control':'private, no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'});
        res.vary('Origin');res.vary('Cookie');
        const c=config(),origin=req.get('Origin');
        // Somente o GET de bootstrap admite navegacao same-origin sem Origin.
        // Host/protocolo devem corresponder a uma origem configurada; nunca libera POST.
        const getLocal=!origin&&req.method==='GET'&&req.path==='/sessao'
            &&req.get('Sec-Fetch-Site')==='same-origin'
            &&c.origens.includes(`${req.protocol}://${req.get('host')}`);
        if((!c.origens.includes(origin)&&!getLocal)||req.get('Sec-Fetch-Site')==='cross-site')throw erro('ORIGEM_INVALIDA');
        if(origin)res.set({'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Credentials':'true'});
        if(req.method==='OPTIONS'){
            const hs=(req.get('Access-Control-Request-Headers')??'').toLowerCase().split(',').map(x=>x.trim()).filter(Boolean);
            if(!['GET','POST'].includes(req.get('Access-Control-Request-Method'))||hs.some(h=>!['content-type','x-ist-loja','x-csrf-token'].includes(h)))throw erro('ORIGEM_INVALIDA');
            res.set({'Access-Control-Allow-Methods':'GET, POST','Access-Control-Allow-Headers':'Content-Type, X-IST-Loja, X-CSRF-Token'});
            return res.status(204).end();
        }
        if(req.get('X-IST-Loja')!=='1'||Object.keys(req.query).length)throw erro('SOLICITACAO_INVALIDA');
        res.locals.configRecuperacao=c;
        if(req.method==='POST'){
            const b=bootstrap(req,c);
            if(!b||!csrfValido(req.get('X-CSRF-Token'),b.nonce,c.segredoCsrf))throw erro('CSRF_INVALIDO');
            if(!req.is('application/json'))throw erro('SOLICITACAO_INVALIDA');
        }
        next();
    });
    router.use(express.json({limit:'1kb',strict:true}));
    router.get('/sessao',async(req,res)=>{
        if(!consumirLimite('consulta:'+req.ip,30,60000))throw erro('LIMITE_REQUISICOES');
        const c=res.locals.configRecuperacao;let b=bootstrap(req,c);
        if(!b){const nonce=randomBytes(32).toString('base64url'),fim=agora().getTime()+900000,valor=nonce+'.'+fim;
            b={nonce,fim,texto:valor+'.'+assinar(c,valor)};}
        const token=lerCookieLoja(req,c.cookieRecuperacao);let sessao=null;
        if(token!==undefined)try{sessao=await obterService().obterSessao(token);}catch(e){if(e.codigo!=='SESSAO_INVALIDA')throw e;}
        res.cookie(c.cookieCsrf,b.texto,{...c.cookie,nome:undefined,expires:new Date(b.fim)});
        responder(res,200,{sessao:sessao?{autenticada:true,expiraEm:sessao.expiraEm}:{autenticada:false},csrfToken:criarTokenCsrf(b.nonce,c.segredoCsrf)});
    });
    router.post('/solicitar',(req,res)=>{
        if(!corpo(req,['email']))throw erro('SOLICITACAO_INVALIDA');
        let email;try{email=normalizarEmailComprador(req.body.email);}catch{throw erro('SOLICITACAO_INVALIDA');}
        const emailKey=createHmac('sha256',sal).update(email).digest('hex');
        const liberado=consumirLimite('solicitar:'+req.ip,5,900000)&&consumirLimite('email:'+emailKey,3,3600000);
        // Resposta nao aguarda consulta/envio; sem fila, no maximo quatro em voo.
        if(liberado&&tarefas.size<4&&adaptadorEmail?.enviar){
            const tarefa=new Promise(resolve=>setImmediate(resolve)).then(async()=>{
                if(!await possuiDireitos(db,email,contexto()))return;
                const desafio=await obterService().criarDesafio(email);
                await adaptadorEmail.enviar(email,desafio);
            }).catch(()=>{});
            tarefas.add(tarefa);void tarefa.finally(()=>tarefas.delete(tarefa));
        }
        responder(res,202,uniforme);
    });
    router.post('/validar',async(req,res)=>{
        if(!corpo(req,['publicId','segredo'])||typeof req.body.publicId!=='string'||typeof req.body.segredo!=='string')throw erro('SOLICITACAO_INVALIDA');
        if(!consumirLimite('validar:'+req.ip,10,900000))throw erro('LIMITE_REQUISICOES');
        const r=await obterService().consumirDesafio(req.body.publicId,req.body.segredo),c=res.locals.configRecuperacao;
        const expira=new Date(r.sessao.expiraEm),n=agora().getTime();
        if(!tokenSessaoValido(r.token)||!Number.isFinite(expira.getTime())||expira.getTime()<=n||expira.getTime()>n+86400000)throw erro('RECUPERACAO_INDISPONIVEL');
        res.cookie(c.cookieRecuperacao,r.token,{...c.cookie,nome:undefined,expires:expira});
        responder(res,200,{sessao:{autenticada:true,expiraEm:expira.toISOString()}});
    });
    router.post('/revogar',async(req,res)=>{
        if(!corpo(req,[]))throw erro('SOLICITACAO_INVALIDA');
        if(!consumirLimite('revogar:'+req.ip,10,60000))throw erro('LIMITE_REQUISICOES');
        const c=res.locals.configRecuperacao,token=lerCookieLoja(req,c.cookieRecuperacao);
        await obterService().obterSessao(token);await obterService().revogarSessao(token);
        res.clearCookie(c.cookieRecuperacao,{...c.cookie,nome:undefined});responder(res,200,{revogada:true});
    });
    router.use((req,res)=>responder(res,404,{erro:{codigo:'ROTA_NAO_ENCONTRADA'}}));
    router.use((e,req,res,next)=>{
        if(res.headersSent){res.destroy();return;}
        const [status,codigo]=['CSRF_INVALIDO','ORIGEM_INVALIDA'].includes(e?.codigo)?[403,'SOLICITACAO_NAO_PERMITIDA']
            :e?.codigo==='SESSAO_INVALIDA'?[401,'SESSAO_INVALIDA']
            :e?.codigo==='DESAFIO_INVALIDO'?[400,'RECUPERACAO_INVALIDA']
            :e?.codigo==='SOLICITACAO_INVALIDA'||e?.type?[400,'SOLICITACAO_INVALIDA']
            :e?.codigo==='LIMITE_REQUISICOES'?[429,'LIMITE_REQUISICOES']:[503,'RECUPERACAO_INDISPONIVEL'];
        responder(res,status,{erro:{codigo}});
    });
    router.aguardarEnvios=()=>Promise.all([...tarefas]); // Testes, nunca endpoint.
    return router;
};
