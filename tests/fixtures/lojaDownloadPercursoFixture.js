import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import mysql from 'mysql2/promise';
import express from 'express';
import {expandirCatalogoSintetico} from './lojaCatalogoComercialFixture.js';
import {criarPagamentoSimulado} from './lojaPagamentoSimulado.js';
import {criarLojaSessaoService,criarTokenCsrf} from '../../src/services/lojaSessaoService.js';
import {criarConfiguracaoLojaSessao} from '../../src/config/lojaSessao.js';
import {criarConfiguracaoArquivosLoja} from '../../src/config/lojaArquivos.js';
import {criarLojaPedidoService} from '../../src/services/lojaPedidoService.js';
import {criarLojaPagamentoService} from '../../src/services/lojaPagamentoService.js';
import {criarLojaDownloadAutorizacaoService} from '../../src/services/lojaDownloadAutorizacaoService.js';
import {criarLojaDownloadsRouter} from '../../src/routes/lojaDownloads.routes.js';
import {prepararArquivoValidado} from '../../src/services/lojaDownloadArquivoService.js';

export const criarPercursoDownload=async(t,{host='127.0.0.1',porta=0,origens=['http://localhost:4200'],
    relogio=()=>new Date('2026-01-01T12:00:00.000Z'),configurarApp}={})=>{
    process.env.NODE_ENV='test';
    const antigo=Boolean(process.env.IST_R2_10339_MANIFEST);
    const {criarBancoPagamentoIsolado}=await import(antigo?'./lojaCatalogoMariaDB10339.js':'./lojaPagamentoBancoIsolado.js');
    const fx=await criarBancoPagamentoIsolado(t),a=fx.admin;
    const [[identidade]]=await a.query('SELECT VERSION() versao,DATABASE() banco,@@port porta,@@foreign_key_checks fk,@@check_constraint_checks ck');
    assert.match(identidade.versao,antigo?/^10\.3\.39-MariaDB/:/^13\.0\.2-MariaDB/);
    assert.match(identidade.banco,/^ist_loja_67_3_[a-f0-9]{12}$/);assert.equal(Number(identidade.fk),1);assert.equal(Number(identidade.ck),1);
    const c=a.config??a.connection.config;
    const pool=fx.pool??mysql.createPool({host:c.host,port:c.port,user:c.user,password:c.password,database:identidade.banco,dateStrings:true,
        supportBigNumbers:true,bigNumberStrings:true,connectionLimit:10});if(!fx.pool)t.after(()=>pool.end());
    await a.query(`ALTER TABLE ist_livros ADD title TEXT,ADD description LONGTEXT,ADD price DECIMAL(5,2),ADD currency CHAR(3),
        ADD onsale INT,ADD format VARCHAR(32),ADD inventory VARCHAR(32),ADD file TEXT,ADD language VARCHAR(5)`);
    await a.query("INSERT INTO ist_loja_categorias(id,nome,slug) VALUES(1,'Sintetico','sintetico')");
    await a.query("INSERT INTO ist_livros(id,title,description,price,currency,onsale,format,inventory,file) VALUES(1,'Sintetico','{}',95.00,'BRL',1,'E-Book','Em estoque',NULL)");
    await a.query("INSERT INTO ist_loja_produtos(id,categoria_id,livro_id,sku) VALUES(1,1,1,'SINT-1')");
    await expandirCatalogoSintetico(a,{publicar:false});
    const raiz=await mkdtemp(path.join(tmpdir(),'ist-d6b4-percurso-'));t.after(()=>rm(raiz,{recursive:true,force:true}));
    const pdf=Buffer.from('%PDF-1.7\nPERCURSO INTEGRADO EXCLUSIVAMENTE SINTETICO\n%%EOF\n');
    await writeFile(path.join(raiz,'comprado.pdf'),pdf);
    const arquivos=criarConfiguracaoArquivosLoja({raizPrivada:raiz}),agora=relogio;
    const publicacao=arquivos.criarPublicacao({db:pool,agora});
    const versao=await publicacao.registrarRascunho({produtoId:1,registroPublicId:randomUUID(),arquivoLogicoId:randomUUID(),caminhoRelativo:'comprado.pdf'});
    await publicacao.publicar({produtoId:1,versaoPublicId:versao.versaoPublicId,publicacaoAtualEsperada:null});
    const estado={log:[],ativos:new Set(),falharEvento:false,preparar:null,final:null};
    const db={execute:(...args)=>pool.execute(...args),async getConnection(){const c=await pool.getConnection(),id=Symbol();return {
        query:(sql,args)=>{
            if(estado.falharEvento&&sql.startsWith('INSERT INTO ist_loja_download_direito_eventos'))throw Error('FALHA SQL SINTETICA');
            return c.query({sql,typeCast:(f,next)=>{if(f.type!=='LONGLONG')return next();const v=f.string();return v===null?null:Number.isSafeInteger(Number(v))?Number(v):v;}},args);
        },execute:(...args)=>c.execute(...args),
        async beginTransaction(){await c.beginTransaction();estado.ativos.add(id);estado.log.push('BEGIN');},
        async commit(){await c.commit();estado.ativos.delete(id);estado.log.push('COMMIT');},
        async rollback(){await c.rollback();estado.ativos.delete(id);estado.log.push('ROLLBACK');},
        release(){assert(!estado.ativos.has(id));c.release();},destroy(){estado.ativos.delete(id);c.destroy();}
    };}};
    const sessoes=criarLojaSessaoService({db,agora}),pedidos=criarLojaPedidoService({db,agora,contextoComercial:{ambienteBackend:'test',ambientePaypal:'sandbox'}});
    const contexto={provedor:'paypal',ambiente:'sandbox',contaRecebedora:'RECEBEDOR-SINTETICO'};
    const config=criarConfiguracaoLojaSessao({origens,segredoCsrf:Buffer.alloc(32,23)});
    const autoriza=criarLojaDownloadAutorizacaoService({db,contextoEsperado:contexto,agora});
    const app=express();
    await configurarApp?.(app,{db,pool,sessoes,config,agora,contexto});
    app.use((req,res,next)=>{
        const end=res.end;res.end=function(...args){
            if(this.getHeader('Content-Type')==='application/pdf'){
                assert.equal(estado.ativos.size,0,'Nao transmitir sob transacao SQL');estado.log.push('ENVIO');
            }
            return end.apply(this,args);
        };next();
    });
    app.use('/api/loja/downloads',criarLojaDownloadsRouter({db,agora,contextoEsperado:contexto,configuracaoArquivos:arquivos,
        obterConfiguracaoSessao:()=>config,sessaoService:sessoes,
        autorizacaoService:{...autoriza,async autorizarArquivoNaConexao(...args){
            estado.log.push('AUTORIZACAO');if(estado.final)await estado.final();return autoriza.autorizarArquivoNaConexao(...args);
        }},prepararArquivo:async(...args)=>{
            assert.equal(estado.ativos.size,0,'Nao ler PDF sob transacao SQL');estado.log.push('PREPARACAO');
            const r=await prepararArquivoValidado(...args);if(estado.preparar)await estado.preparar();estado.log.push('PDF_VALIDADO');return r;
        }}));
    const server=await new Promise((resolve,reject)=>{const s=app.listen(porta,host,()=>resolve(s));s.once('error',reject);});
    t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
    const base=`http://127.0.0.1:${server.address().port}/api/loja/downloads`;
    const compra=async()=>{
        const sessao=await sessoes.estabelecerSessao();
        const pedido=await pedidos.criarPedido(sessao.sessao,{produtoIds:[1],compradorEmail:'sintetico@example.invalid'},randomUUID());
        const [[p]]=await a.execute('SELECT id FROM ist_loja_pedidos WHERE public_id=?',[pedido.publicId]);
        const sim=criarPagamentoSimulado({agora}),financeiro=criarLojaPagamentoService({db,adaptador:sim.adaptador,contexto,agora});
        return {...sessao,pedido,pedidoId:p.id,sim,financeiro};
    };
    const capturar=async x=>{
        x.pagamento=await x.financeiro.criarTentativa(x.sessao,{pedidoPublicId:x.pedido.publicId},randomUUID());
        x.sim.aprovado(x.pagamento.publicId);const r=await x.financeiro.capturar(x.sessao,{pagamentoPublicId:x.pagamento.publicId},randomUUID());
        assert.equal(r.estado,'CAPTURADO');assert.equal(x.sim.chamadas.capturar,1);
    };
    const dados=async x=>{
        const [direitos]=await a.query(`SELECT d.* FROM ist_loja_download_direitos d JOIN ist_loja_pedido_itens i ON i.id=d.pedido_item_id WHERE i.pedido_id=? ORDER BY d.id`,[x.pedidoId]);
        const [eventos]=await a.query(`SELECT e.* FROM ist_loja_download_direito_eventos e JOIN ist_loja_download_direitos d ON d.id=e.direito_id
            JOIN ist_loja_pedido_itens i ON i.id=d.pedido_item_id WHERE i.pedido_id=? ORDER BY e.id`,[x.pedidoId]);
        return {direitos,eventos};
    };
    const enviar=async(x,metodo='GET',id,extras={})=>{
        const d=id??(await dados(x)).direitos[0].public_id;
        return fetch(base+`/itens/${d}/${metodo==='POST'?'reavaliar':'arquivo'}`,{method:metodo,
            headers:{Origin:'http://localhost:4200','X-IST-Loja':'1',Cookie:`ist-loja-dev=${x.token}`,
                ...(metodo==='POST'?{'Content-Type':'application/json','X-CSRF-Token':criarTokenCsrf(x.token,config.segredoCsrf)}:{}),...extras},
            ...(metodo==='POST'?{body:'{}'}:{})});
    };
    return {a,pool,db,raiz,pdf,arquivos,versao,contexto,agora,estado,identidade,compra,capturar,dados,enviar};
};
