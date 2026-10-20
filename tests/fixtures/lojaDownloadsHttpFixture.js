import express from 'express';
import cors from 'cors';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {criarConfiguracaoLojaSessao} from '../../src/config/lojaSessao.js';
import {criarTokenCsrf} from '../../src/services/lojaSessaoService.js';
import {criarLojaDownloadsRouter} from '../../src/routes/lojaDownloads.routes.js';
import {criarConfiguracaoArquivosLoja} from '../../src/config/lojaArquivos.js';

export const pdfSintetico=Buffer.from('%PDF-1.7\nPDF HTTP EXCLUSIVAMENTE SINTETICO\n%%EOF\n');
export const origemDownload='http://localhost:4200';
export const configurarHttpDownloads=async(t,{opcoes={},dados,publicarRaiz=false}={})=>{
    const raiz=await mkdtemp(path.join(tmpdir(),'ist-d6b3-'));
    await writeFile(path.join(raiz,'arquivo.pdf'),pdfSintetico);
    const token=randomBytes(32).toString('base64url'),publicId=randomUUID();
    const config=criarConfiguracaoLojaSessao({origens:[origemDownload],segredoCsrf:Buffer.alloc(32,19)});
    const estado={direito:'ATIVO',adverso:false,autorizacoes:0,transicoes:0,tx:0,instante:100000,...dados};
    const erro=codigo=>{throw Object.assign(Error('SEGREDO SQL /privado '+codigo),{codigo});};
    const meta={direitoId:1,direitoVersao:1,pedidoId:1,arquivoVersaoId:1,caminhoRelativo:'arquivo.pdf',
        tamanhoBytes:String(pdfSintetico.length),sha256:createHash('sha256').update(pdfSintetico).digest(),mime:'application/pdf'};
    const proprio=id=>{if(id!==publicId)erro('DIREITO_NAO_ENCONTRADO');};
    const db={async getConnection(){let tx=false;return {
        async query(sql){if(sql.includes('@@in_transaction'))return [[{transacao:tx?1:0,autocommit:1,isolamento:'REPEATABLE-READ'}]];return [[]];},
        async beginTransaction(){tx=true;estado.tx++;},async commit(){tx=false;estado.tx--;},async rollback(){if(tx)estado.tx--;tx=false;},
        release(){},destroy(){if(tx)estado.tx--;tx=false;}
    };}};
    const autorizacao={
        async listarDireitosDaSessao(){return {direitos:[{publicId,titulo:'Sintetico',estado:estado.direito,podeSolicitarArquivo:estado.direito==='ATIVO'}],proximoCursor:null};},
        async localizarDireitoDaSessao(token,id){proprio(id);return {pedidoId:1,publicId,estado:estado.direito};},
        async autorizarArquivoNaConexao(c,token,id){estado.autorizacoes++;proprio(id);
            if(estado.direito!=='ATIVO')erro('DIREITO_INDISPONIVEL');if(estado.adverso)erro('FINANCEIRO_INDISPONIVEL');return {...meta};}
    };
    const app=express();app.set('trust proxy','loopback');
    const configuracaoArquivos=criarConfiguracaoArquivosLoja({raizPrivada:raiz,raizesPublicas:publicarRaiz?[raiz]:[]});
    app.use('/api/loja/downloads',criarLojaDownloadsRouter({db,env:{PRODUCTS_PATH:raiz},
        ...(publicarRaiz?{configuracaoArquivos}:{}),
        contextoEsperado:{provedor:'paypal',ambiente:'sandbox',contaRecebedora:'SINTETICO'},
        obterConfiguracaoSessao:()=>config,agoraMs:()=>estado.instante,
        sessaoService:{async obterSessao(valor){if(valor!==token||estado.sessaoInvalida)erro('SESSAO_INVALIDA');return {id:1};}},
        autorizacaoService:autorizacao,direitosService:{async reavaliarDireitosDoPedido(id){
            if(id!==1)throw Error('Pedido inesperado');estado.transicoes++;
            if(estado.direito==='AGUARDANDO_CONFIRMACAO')estado.direito='ATIVO';
        }},...opcoes}));
    app.use(cors());app.use((req,res)=>res.send('fallback indevido'));
    const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
    t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await rm(raiz,{recursive:true,force:true});});
    const base=`http://127.0.0.1:${server.address().port}/api/loja/downloads`;
    const headers={'Origin':origemDownload,'X-IST-Loja':'1',Cookie:`ist-loja-dev=${token}`};
    const enviar=(url=`/itens/${publicId}/arquivo`,{method='GET',headers:extras={},...rest}={})=>fetch(base+url,{method,headers:{...headers,...extras},...rest});
    return {raiz,token,publicId,config,estado,meta,base,headers,enviar,csrf:criarTokenCsrf(token,config.segredoCsrf),autorizacao};
};
