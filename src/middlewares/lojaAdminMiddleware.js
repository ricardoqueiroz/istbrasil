import {createHash,createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import {criarAutenticacaoUsuario} from './authMiddleware.js';
import {criarAutorizacaoTiposUsuario} from './authorizationMiddleware.js';
import {carregarConfiguracaoLojaSessao} from '../config/lojaSessao.js';
import {lerCookieLoja} from './lojaSessaoMiddleware.js';

const mensagens={401:['ADMIN_NAO_AUTENTICADO','Autenticacao administrativa necessaria.'],
    403:['ADMIN_NAO_AUTORIZADO','Operacao administrativa nao permitida.'],
    400:['ADMIN_ENTRADA_INVALIDA','Entrada administrativa invalida.'],
    409:['ADMIN_LIVRO_VINCULADO','O livro possui vinculos que impedem esta operacao.'],
    404:['ADMIN_REGISTRO_NAO_ENCONTRADO','Registro administrativo nao encontrado.'],
    413:['ADMIN_CORPO_EXCESSIVO','Corpo administrativo excede o limite permitido.'],
    415:['ADMIN_MIDIA_INVALIDA','Formato administrativo nao suportado.'],
    412:['ADMIN_EDICAO_DIVERGENTE','O registro foi alterado. Consulte novamente.'],
    428:['ADMIN_PRECONDICAO_OBRIGATORIA','Informe a revisao atual do registro.'],
    503:['ADMIN_INDISPONIVEL','Administracao temporariamente indisponivel.']};
export const responderErroAdmin=(res,status=503)=>{
    const [codigo,mensagem]=mensagens[status]??mensagens[503];
    return res.status(mensagens[status]?status:503).set('Cache-Control','no-store').json({erro:{codigo,mensagem}});
};
export const tratarErroAdmin=(e,req,res,next)=>{
    if(res.headersSent){res.destroy();return;}
    const conflitos={ADMIN_RASCUNHO_EXISTENTE:'Ja existe PDF em RASCUNHO para este produto. Novo envio nao permitido.',
        ADMIN_PUBLICACAO_CONFLITO:'A publicacao ou a versao mudou. Recarregue e confira o PDF antes de publicar novamente.',
        ADMIN_SKU_DUPLICADO:'SKU comercial ja cadastrado. Informe outro SKU.',
        ADMIN_CONFLITO_COMERCIAL:'Conflito comercial. Confira categoria, vinculos e revisoes.'};
    if(e?.statusAdmin===409&&Object.hasOwn(conflitos,e?.codigoAdmin))
        return res.status(409).set('Cache-Control','no-store').json({erro:{codigo:e.codigoAdmin,mensagem:conflitos[e.codigoAdmin]}});
    if(e?.statusAdmin===400&&e?.codigoAdmin==='ADMIN_PRECO_OBRIGATORIO')
        return res.status(400).set('Cache-Control','no-store').json({erro:{codigo:'ADMIN_PRECO_OBRIGATORIO',mensagem:'Informe o preco legado para cadastrar o livro neste banco.'}});
    return responderErroAdmin(res,[400,404,409,412,413,415,428].includes(e?.statusAdmin)?e.statusAdmin:503);
};
const falhar=()=>{throw Error('CONFIGURACAO_ADMIN_INVALIDA');};
export const carregarConfiguracaoLojaAdmin=(env=process.env)=>{
    const segredo=env.JWT_SECRET,nome=env.COOKIE_NAME||'ist_session';
    if(!['development','test','production'].includes(env.NODE_ENV)
        // Comprimento e bloqueio de exemplos sao requisitos minimos, nao medem
        // entropia. Geracao aleatoria segura e obrigacao operacional documentada.
        ||typeof segredo!=='string'||Buffer.byteLength(segredo)<32||!segredo.trim()
        ||/dev-only|replace-with|change.?me|example|insecure/i.test(segredo)
        ||!/^[A-Za-z0-9_-]{1,64}$/.test(nome)||/^(?:__Host-)?ist-loja(?:-|$)/.test(nome)
        ||env.COOKIE_HTTPONLY==='false'||(env.NODE_ENV==='production'&&env.COOKIE_SECURE!=='true'))falhar();
    const config=carregarConfiguracaoLojaSessao(env);
    return {cookieNome:nome,segredoJwt:segredo,origens:config.origens,segredoCsrf:config.segredoCsrf};
};

// Nao registra endpoints. Emissao usada no futuro GET administrativo protegido.
// Token CSRF curto, ligado ao JWT exato; nao concede autoridade administrativa.
export const criarProtecaoLojaAdmin=({env=process.env,db,agoraMs=Date.now}={})=>{
    const autorizacao=criarAutorizacaoTiposUsuario({...(db?{db}:{}),registrarErro:()=>{}})(1);
    const estados=new WeakMap();
    const mac=(c,token,valor)=>createHmac('sha256',c.segredoCsrf)
        .update('ist-loja/admin/csrf/v1\0').update(createHash('sha256').update(token).digest()).update(valor).digest('base64url');
    const ponte=(req,res,middleware,continuar)=>{
        // Os middlewares existentes podem responder; normalizar sem expor seu erro.
        const facade={status(s){this.codigo=s;return this;},json(){return responderErroAdmin(res,this.codigo>=500?503:this.codigo);}};
        return middleware(req,facade,continuar);
    };
    const entrada=async(req,res,next)=>{
        res.set({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
        let c;try{c=carregarConfiguracaoLojaAdmin(env);}catch{return responderErroAdmin(res,503);}
        const token=lerCookieLoja(req,c.cookieNome);
        if(!token||token.length>8192)return responderErroAdmin(res,401);
        // Cookie unico cru deve corresponder ao cookie administrativo parseado.
        // Nunca aceitar cookie JSON/assinado, Authorization ou sessao de compra.
        if(req.cookies?.[c.cookieNome]!==token)return responderErroAdmin(res,401);
        try{
            await ponte(req,res,criarAutenticacaoUsuario({cookieNome:c.cookieNome,segredo:c.segredoJwt,
                algoritmos:['HS256'],exigirExpiracao:true}),async()=>{
                await ponte(req,res,autorizacao,()=>{
                    estados.set(req,{c,token});next();
                });
            });
        }catch{return responderErroAdmin(res,503);}
    };
    const emitirCsrf=req=>{
        const s=estados.get(req);if(!s)throw Error('ADMIN_NAO_AUTENTICADO');
        const valor=`${agoraMs()+900000}.${randomBytes(32).toString('base64url')}`;
        return `${valor}.${mac(s.c,s.token,valor)}`;
    };
    const protegerEscrita=(req,res,next)=>{
        const s=estados.get(req);if(!s)return responderErroAdmin(res,401);
        if(!['POST','PATCH','PUT','DELETE'].includes(req.method))return responderErroAdmin(res,403);
        if(!s.c.origens.includes(req.get('Origin'))||req.get('Sec-Fetch-Site')==='cross-site')return responderErroAdmin(res,403);
        const texto=req.get('X-CSRF-Token')??'',[fim,nonce,assinatura,...extras]=texto.split('.'),n=Number(fim);
        if(extras.length||!/^\d{13}$/.test(fim??'')||!Number.isSafeInteger(n)||n<=agoraMs()||n>agoraMs()+900000
            ||!/^[A-Za-z0-9_-]{43}$/.test(nonce??'')||!/^[A-Za-z0-9_-]{43}$/.test(assinatura??''))return responderErroAdmin(res,403);
        const esperado=mac(s.c,s.token,`${fim}.${nonce}`);
        if(!timingSafeEqual(Buffer.from(assinatura),Buffer.from(esperado)))return responderErroAdmin(res,403);
        next();
    };
    return {entrada,emitirCsrf,protegerEscrita};
};
