import {hashTokenSessao} from '../services/lojaSessaoService.js';
import {lerCookieLoja,criarProtecaoLoja} from './lojaSessaoMiddleware.js';
import {cookiesRecuperacao,csrfRecuperacaoValido} from './lojaRecuperacaoCsrf.js';
import {hashSessaoRecuperada,normalizarAutoridadeDownload} from '../services/lojaDownloadAutoridade.js';

export const erroDownload = codigo => Object.assign(new Error(codigo),{codigo});
export const responderDownload = (res,status,body) => {
    res.removeHeader('ETag');res.removeHeader('Last-Modified');
    res.status(status).type('application/json');
    res.end(res.req.method==='HEAD'?undefined:JSON.stringify(body));
};
export const criarMiddlewareDownloads = ({sessaoService,recuperacaoService,obterConfiguracaoSessao,agoraMs=Date.now}) => {
    const sessoes=new Map(),ips=new Map(),ativos=new Map();let ultimaLimpeza=0;
    const consumir=(map,chave,limite)=>{
        const now=agoraMs();
        if(now-ultimaLimpeza>=60000){
            for(const m of [sessoes,ips])for(const [k,v]of m)if(v.ate<=now)m.delete(k);
            ultimaLimpeza=now;
        }
        let r=map.get(chave);
        if(!r||r.ate<=now){if(map.size>=10000&&!r)throw erroDownload('LIMITE_REQUISICOES');r={ate:now+60000,n:0};map.set(chave,r);}
        if(++r.n>limite)throw erroDownload('LIMITE_REQUISICOES');
    };
    const protecao=criarProtecaoLoja({service:sessaoService,obterConfiguracao:obterConfiguracaoSessao});
    const origem=(req,config)=>{
        if(req.get('Sec-Fetch-Site')==='cross-site')throw erroDownload('ORIGEM_INVALIDA');
        const origin=req.get('Origin');
        let autorizada=origin;
        if(!origin&&req.get('Referer'))try{autorizada=new URL(req.get('Referer')).origin;}catch{}
        if(!config.origens.includes(autorizada))throw erroDownload('ORIGEM_INVALIDA');
        return origin;
    };
    const entrada=(req,res,next)=>{
        res.set({'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});
        res.vary('Cookie');res.vary('Origin');
        const config=obterConfiguracaoSessao();
        const origin=origem(req,config);
        if(origin)res.set({'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Credentials':'true'});
        if(req.method==='OPTIONS'){
            const metodo=req.get('Access-Control-Request-Method'),headers=(req.get('Access-Control-Request-Headers')??'').toLowerCase().split(',').map(x=>x.trim()).filter(Boolean);
            if(!origin||!['GET','HEAD','POST'].includes(metodo)||headers.some(h=>!['x-ist-loja','x-csrf-token','content-type'].includes(h)))throw erroDownload('ORIGEM_INVALIDA');
            res.vary('Access-Control-Request-Headers');res.set({'Access-Control-Allow-Methods':'GET, HEAD, POST',
                'Access-Control-Allow-Headers':'X-IST-Loja, X-CSRF-Token, Content-Type'});return res.status(204).end();
        }
        if(req.get('X-IST-Loja')!=='1')throw erroDownload('CSRF_INVALIDO');
        next();
    };
    const autenticar=async(req,res,next)=>{
        const config=cookiesRecuperacao(obterConfiguracaoSessao());
        // Presenca, nao validade: RECUPERACAO prevalece ate quando invalida/duplicada.
        const recuperacao=typeof req.headers.cookie==='string'&&req.headers.cookie.split(';')
            .some(p=>p.trim().startsWith(config.cookieRecuperacao+'='));
        const token=lerCookieLoja(req,recuperacao?config.cookieRecuperacao:config.cookie.nome);
        const ip=ips.get(req.ip??'desconhecido');
        if(ip&&ip.ate>agoraMs()&&ip.n>=30)throw erroDownload('LIMITE_REQUISICOES');
        try{
            const a=normalizarAutoridadeDownload({tipo:recuperacao?'RECUPERACAO':'COMPRA',token});
            res.locals.sessaoLoja=await (recuperacao?recuperacaoService:sessaoService).obterSessao(token);
            res.locals.autoridadeDownload=a;
        }
        catch(e){if(e.codigo==='SESSAO_INVALIDA')consumir(ips,req.ip??'desconhecido',30);throw e;}
        res.locals.tokenDownload=recuperacao?res.locals.autoridadeDownload:token;
        res.locals.chaveDownload=recuperacao?'RECUPERACAO:'+hashSessaoRecuperada(token).toString('hex'):hashTokenSessao(token).toString('hex');next();
    };
    const limitar=(tipo,limite)=>(req,res,next)=>{
        consumir(sessoes,`${tipo}:${res.locals.chaveDownload}`,limite);next();
    };
    const entrega=(req,res,next)=>{
        const chave=res.locals.chaveDownload,n=ativos.get(chave)??0;
        if(n>=2)throw erroDownload('LIMITE_REQUISICOES');
        ativos.set(chave,n+1);
        const controller=new AbortController();let liberado=false;
        const liberar=()=>{
            if(liberado)return;liberado=true;
            const atual=(ativos.get(chave)??1)-1;if(atual)ativos.set(chave,atual);else ativos.delete(chave);
            req.off('aborted',abortar);res.off('finish',liberar);res.off('close',abortar);
        };
        const abortar=()=>{controller.abort();liberar();};
        req.once('aborted',abortar);res.once('close',abortar);res.once('finish',liberar);
        res.locals.signalDownload=controller.signal;next();
    };
    const protegerPost=(req,res,next)=>{
        if(res.locals.autoridadeDownload?.tipo!=='RECUPERACAO')return protecao.protegerEscritaLoja(req,res,next);
        const c=cookiesRecuperacao(obterConfiguracaoSessao());
        if(!c.origens.includes(req.get('Origin')))throw erroDownload('ORIGEM_INVALIDA');
        if(!req.is('application/json')||Object.keys(req.query).length)throw erroDownload('SOLICITACAO_INVALIDA');
        if(!csrfRecuperacaoValido(req,c,agoraMs))throw erroDownload('CSRF_INVALIDO');next();
    };
    return {entrada,autenticar,limitar,entrega,protegerPost};
};

export const tratarErroDownload = (e,req,res,next) => {
    if(res.headersSent){if(!res.writableEnded)res.destroy();return;}
    if(res.destroyed)return;
    const codigo=e?.codigo;
    const [status,publico]=codigo==='SESSAO_INVALIDA'?[401,'SESSAO_INVALIDA']
        :['DIREITO_NAO_ENCONTRADO','IDENTIFICADOR_INVALIDO'].includes(codigo)?[404,'DIREITO_NAO_ENCONTRADO']
        :['DIREITO_INDISPONIVEL','FINANCEIRO_INDISPONIVEL','VERSAO_DIVERGENTE'].includes(codigo)?[409,'DIREITO_INDISPONIVEL']
        :['LIMITE_REQUISICOES','CAPACIDADE_ESGOTADA'].includes(codigo)?[429,'LIMITE_REQUISICOES']
        :['ORIGEM_INVALIDA','CSRF_INVALIDO'].includes(codigo)?[403,'SOLICITACAO_NAO_PERMITIDA']
        :codigo==='SOLICITACAO_INVALIDA'||e?.type?[400,'SOLICITACAO_INVALIDA']:[503,'DOWNLOAD_INDISPONIVEL'];
    if(status===429)res.set('Retry-After','60');
    responderDownload(res,status,{erro:{codigo:publico}});
};
