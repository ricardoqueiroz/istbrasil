import {createHash} from 'node:crypto';
import {tokenSessaoValido} from './lojaSessaoService.js';

/** @typedef {{tipo:'COMPRA'|'RECUPERACAO',token:string}} AutoridadeDownload
 * Somente resolucao interna de cookies. Nao aceitar este objeto de body/query.
 */
const falhar=()=>{throw Object.assign(Error('SESSAO_INVALIDA'),{codigo:'SESSAO_INVALIDA'});};
export const normalizarAutoridadeDownload=entrada=>{
    const a=typeof entrada==='string'?{tipo:'COMPRA',token:entrada}:entrada;
    if(!a||!['COMPRA','RECUPERACAO'].includes(a.tipo)||!tokenSessaoValido(a.token))falhar();
    return Object.freeze({tipo:a.tipo,token:a.token});
};
// Dominio da sessao B1 (nao do desafio). Sem criar/consumir/renovar sessao.
export const hashSessaoRecuperada=token=>{
    if(!tokenSessaoValido(token))falhar();
    return createHash('sha256').update('ist-loja/recuperacao/sessao/v1\0').update(Buffer.from(token,'base64url')).digest();
};
export const bloquearSessaoRecuperada=async(c,token,agora)=>{
    const hash=hashSessaoRecuperada(token);
    const [[r]]=await c.query(`SELECT id,public_id,consumido_em,revogada_em,
        DATE_FORMAT(sessao_criada_em,'%Y-%m-%dT%H:%i:%s.%fZ') criada,
        DATE_FORMAT(sessao_expira_em,'%Y-%m-%dT%H:%i:%s.%fZ') expira
        FROM ist_loja_download_recuperacoes WHERE sessao_hash=? FOR UPDATE`,[hash]);
    const ler=v=>{
        if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}000Z$/.test(v))falhar();
        const n=Date.parse(v);if(!Number.isFinite(n)||new Date(n).toISOString()!==v.slice(0,23)+'Z')falhar();return n;
    };
    if(!r||r.consumido_em===null||r.revogada_em!==null||!Number.isInteger(r.id)||r.id<1||r.id>4294967295)falhar();
    const criada=ler(r.criada),expira=ler(r.expira),d=agora();
    if(!(d instanceof Date)||!Number.isFinite(d.getTime())||criada>d.getTime()||expira<=d.getTime()
       ||expira<=criada||expira-criada>86400000)falhar();
    return {tipo:'RECUPERACAO',id:r.id,hash,conferir:()=>bloquearSessaoRecuperada(c,token,agora)};
};
