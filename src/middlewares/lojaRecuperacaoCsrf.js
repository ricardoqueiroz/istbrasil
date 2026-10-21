import {createHmac,timingSafeEqual} from 'node:crypto';
import {lerCookieLoja} from './lojaSessaoMiddleware.js';
import {tokenSessaoValido,csrfValido} from '../services/lojaSessaoService.js';

export const cookiesRecuperacao=config=>({...config,
    cookieRecuperacao:config.cookie.secure?'__Host-ist-loja-recuperacao':'ist-loja-recuperacao-dev',
    cookieCsrf:config.cookie.secure?'__Host-ist-loja-recuperacao-csrf':'ist-loja-recuperacao-csrf-dev'});
export const assinarBootstrapRecuperacao=(c,valor)=>createHmac('sha256',c.segredoCsrf)
    .update('ist-loja/recuperacao/csrf-bootstrap/v1\0').update(valor).digest('base64url');
export const lerBootstrapRecuperacao=(req,c,agoraMs=Date.now)=>{
    const texto=lerCookieLoja(req,c.cookieCsrf);
    if(typeof texto!=='string')return null;
    const [nonce,exp,mac,...extra]=texto.split('.');
    if(extra.length||!tokenSessaoValido(nonce)||!tokenSessaoValido(mac)||!/^\d{13}$/.test(exp??''))return null;
    const n=agoraMs(),fim=Number(exp);
    if(fim<=n||fim>n+900000||!timingSafeEqual(Buffer.from(mac,'base64url'),
        Buffer.from(assinarBootstrapRecuperacao(c,nonce+'.'+exp),'base64url')))return null;
    return {nonce,texto,fim};
};
export const csrfRecuperacaoValido=(req,c,agoraMs=Date.now)=>{
    const b=lerBootstrapRecuperacao(req,c,agoraMs);
    return Boolean(b&&csrfValido(req.get('X-CSRF-Token'),b.nonce,c.segredoCsrf));
};
