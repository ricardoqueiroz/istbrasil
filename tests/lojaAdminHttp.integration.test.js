import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import {randomBytes} from 'node:crypto';
import {criarProtecaoLojaAdmin,tratarErroAdmin} from '../src/middlewares/lojaAdminMiddleware.js';
import {validarEntradaAdmin} from '../src/services/lojaAdminContratos.js';

test('HTTP sintetico Express/cookie-parser: sessao administrativa e CSRF entre requisicoes',async t=>{
    const env={NODE_ENV:'test',COOKIE_NAME:'ist_session',JWT_SECRET:randomBytes(32).toString('hex'),
        LOJA_CSRF_SECRET:randomBytes(32).toString('base64url'),LOJA_ORIGENS_PERMITIDAS:'http://localhost:4200'};
    let tipo=1,consultas=0,falhar=false,tempo=Date.parse('2026-01-01T12:00:00Z');
    const db={query:async(sql,args)=>{
        consultas++;assert.equal(sql,'SELECT id_tipo_usuario FROM ist_usuarios WHERE id_usuario = ?');assert.deepEqual(args,[7]);
        if(falhar)throw Error('SEGREDO_SQL');return [[{id_tipo_usuario:tipo}]];
    }};
    const p=criarProtecaoLojaAdmin({env,db,agoraMs:()=>tempo});
    const app=express();app.use(cookieParser());
    // Rotas exclusivamente deste teste, sem importacao/registro no servidor IST.
    app.use('/__teste-admin',p.entrada);
    app.get('/__teste-admin/contexto',(req,res)=>res.set('X-CSRF-Token',p.emitirCsrf(req)).json({autorizado:true}));
    app.post('/__teste-admin/sonda',p.protegerEscrita,express.json({limit:'1kb'}),(req,res)=>{
        validarEntradaAdmin('situacao','PATCH',req.body);res.json({validado:true});
    });
    app.get('/__teste-admin/ausente',()=>{throw Object.assign(Error('DADO_INTERNO'),{statusAdmin:404});});
    app.use(tratarErroAdmin);
    const servidor=await new Promise((resolve,reject)=>{
        const s=app.listen(0,'127.0.0.1',()=>resolve(s));s.once('error',reject);
    });
    t.after(async()=>{servidor.closeAllConnections();await new Promise(r=>servidor.close(r));});
    const base=`http://127.0.0.1:${servidor.address().port}/__teste-admin`;
    const token=jwt.sign({id_usuario:7,id_tipo_usuario:1},env.JWT_SECRET,{expiresIn:3600});
    const cookie=`ist_session=${token}`;
    const solicitar=async(rota,{method='GET',headers={},body}={})=>{
        const r=await fetch(base+rota,{method,headers,...(body!==undefined?{body:JSON.stringify(body)}:{})});
        const texto=await r.text();assert.equal(r.headers.get('cache-control'),'no-store');
        assert.doesNotMatch(texto,/SEGREDO_SQL|DADO_INTERNO|stack|SELECT|JWT_SECRET/);
        assert(!texto.includes(token));return {r,body:JSON.parse(texto)};
    };
    const n=consultas;
    assert.equal((await solicitar('/contexto')).r.status,401);assert.equal(consultas,n);
    assert.equal((await solicitar('/contexto',{headers:{Cookie:'ist-loja-dev=COMPRA'}})).r.status,401);
    const bootstrap=await solicitar('/contexto',{headers:{Cookie:cookie}});
    assert.equal(bootstrap.r.status,200);assert.deepEqual(bootstrap.body,{autorizado:true});
    const csrf=bootstrap.r.headers.get('x-csrf-token');assert(csrf);
    const headers={Cookie:cookie,Origin:'http://localhost:4200','Content-Type':'application/json','X-CSRF-Token':csrf};
    assert.equal((await solicitar('/sonda',{method:'POST',headers,body:{emVenda:false}})).r.status,200);
    for(const h of [{...headers,'X-CSRF-Token':''},{...headers,Origin:'https://evil.invalid'},
        {...headers,'X-CSRF-Token':csrf.slice(0,-1)+(csrf.endsWith('A')?'B':'A')}])
        assert.equal((await solicitar('/sonda',{method:'POST',headers:h,body:{emVenda:false}})).r.status,403);
    const desconhecido=await solicitar('/sonda',{method:'POST',headers,body:{price:1}});
    assert.equal(desconhecido.r.status,400);assert.equal(desconhecido.body.erro.codigo,'ADMIN_ENTRADA_INVALIDA');
    tipo=2;assert.equal((await solicitar('/contexto',{headers:{Cookie:cookie}})).r.status,403);tipo=1;
    assert.equal((await solicitar('/contexto',{headers:{Cookie:`${cookie}; ${cookie}`}})).r.status,401);
    const ausente=await solicitar('/ausente',{headers:{Cookie:cookie}});assert.equal(ausente.r.status,404);
    assert.equal(ausente.body.erro.codigo,'ADMIN_REGISTRO_NAO_ENCONTRADO');
    falhar=true;assert.equal((await solicitar('/contexto',{headers:{Cookie:cookie}})).r.status,503);falhar=false;
    tempo+=900000;assert.equal((await solicitar('/sonda',{method:'POST',headers,body:{emVenda:false}})).r.status,403);
    const atualizado=await solicitar('/contexto',{headers:{Cookie:cookie}});
    assert.equal((await solicitar('/sonda',{method:'POST',headers:{...headers,'X-CSRF-Token':atualizado.r.headers.get('x-csrf-token')},body:{emVenda:false}})).r.status,200);
    delete env.JWT_SECRET;const antes=consultas;
    assert.equal((await solicitar('/contexto',{headers:{Cookie:cookie}})).r.status,503);assert.equal(consultas,antes);
});
