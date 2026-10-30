import path from 'node:path';
import {uuidPagamento} from '../services/lojaPagamentoContratos.js';
import {erroDownload,responderDownload} from '../middlewares/lojaDownloadsMiddleware.js';

const identificador=req=>{try{return uuidPagamento(req.params.direitoPublicId);}catch{throw erroDownload('IDENTIFICADOR_INVALIDO');}};
const semQuery=req=>{if(Object.keys(req.query).length)throw erroDownload('SOLICITACAO_INVALIDA');};
const igual=(a,b)=>['arquivoVersaoId','direitoId','direitoVersao','caminhoRelativo','tamanhoBytes','mime'].every(k=>a[k]===b[k])
    &&Buffer.isBuffer(a.sha256)&&Buffer.isBuffer(b.sha256)&&a.sha256.equals(b.sha256);

export const criarLojaDownloadsController = ({db,obterServicos,prepararArquivo,obterRaiz}) => {
    const autorizar=async(token,id)=>{
        let c,iniciada=false,commit=false,isolamento;let falhaSql=false;
        try{
            c=await db.getConnection();
            const [[s]]=await c.query('SELECT @@in_transaction transacao,@@autocommit autocommit,@@tx_isolation isolamento');
            if(Number(s.transacao)!==0||Number(s.autocommit)!==1)throw erroDownload('TRANSACAO_INVALIDA');
            isolamento={'READ-UNCOMMITTED':'READ UNCOMMITTED','READ-COMMITTED':'READ COMMITTED','REPEATABLE-READ':'REPEATABLE READ','SERIALIZABLE':'SERIALIZABLE'}[s.isolamento];
            if(!isolamento)throw erroDownload('TRANSACAO_INVALIDA');
            await c.query('SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED');
            await c.beginTransaction();iniciada=true;
            const observado={query:async(...args)=>{try{return await c.query(...args);}catch(e){falhaSql=true;throw e;}}};
            const r=await obterServicos().autorizacao.autorizarArquivoNaConexao(observado,token,id);
            commit=true;await c.commit();iniciada=false;return r;
        }catch(e){
            if(c&&(commit||!iniciada)){c.destroy();c=null;}
            else if(c)try{await c.rollback();}catch{c.destroy();c=null;}
            if(falhaSql)throw erroDownload('FALHA_SQL');throw e;
        }finally{
            if(c){try{await c.query(`SET SESSION TRANSACTION ISOLATION LEVEL ${isolamento}`);}
                catch{c.destroy();c=null;throw erroDownload('FALHA_SQL');}c?.release();}
        }
    };
    return {
        listar:async(req,res)=>{
            if(Object.keys(req.query).some(k=>!['limite','apos','pedidoPublicId'].includes(k)))throw erroDownload('SOLICITACAO_INVALIDA');
            const limite=req.query.limite===undefined?20:Number(req.query.limite),apos=req.query.apos??null;
            if((req.query.limite!==undefined&&!/^[1-9]\d?$/.test(req.query.limite))||!Number.isInteger(limite)||limite>50||typeof apos!=='string'&&apos!==null)throw erroDownload('SOLICITACAO_INVALIDA');
            try{if(apos!==null)uuidPagamento(apos);}catch{throw erroDownload('SOLICITACAO_INVALIDA');}
            const pedidoPublicId=req.query.pedidoPublicId??null;
            try{if(pedidoPublicId!==null)uuidPagamento(pedidoPublicId);}catch{throw erroDownload('SOLICITACAO_INVALIDA');}
            responderDownload(res,200,await obterServicos().autorizacao.listarDireitosDaSessao(res.locals.tokenDownload,{limite,apos,pedidoPublicId}));
        },
        reavaliar:async(req,res)=>{
            semQuery(req);const id=identificador(req);
            if(!req.body||Array.isArray(req.body)||Object.keys(req.body).length)throw erroDownload('SOLICITACAO_INVALIDA');
            const {autorizacao,direitos,contexto}=obterServicos(),token=res.locals.tokenDownload;
            const proprio=await autorizacao.localizarDireitoDaSessao(token,id);
            const guarda=res.locals.autoridadeDownload?.tipo==='RECUPERACAO'
                ? {autorizarNaConexao:c=>autorizacao.autorizarReavaliacaoNaConexao(c,token,id,proprio.pedidoId)}:undefined;
            await direitos.reavaliarDireitosDoPedido(proprio.pedidoId,contexto,guarda);
            const atual=await autorizacao.localizarDireitoDaSessao(token,id);
            responderDownload(res,200,{publicId:atual.publicId,estado:atual.estado});
        },
        arquivo:async(req,res)=>{
            semQuery(req);const id=identificador(req),token=res.locals.tokenDownload,signal=res.locals.signalDownload;
            const raizPrivada=await obterRaiz();if(typeof raizPrivada!=='string'||!path.isAbsolute(raizPrivada))throw erroDownload('CONFIGURACAO_INVALIDA');
            const antes=await autorizar(token,id);if(signal.aborted)return;
            const pdf=await prepararArquivo(antes,{raizPrivada,signal});if(signal.aborted)return;
            if(await obterRaiz()!==raizPrivada)throw erroDownload('CONFIGURACAO_INVALIDA');
            const final=await autorizar(token,id);if(signal.aborted)return;
            if(!igual(antes,final))throw erroDownload('VERSAO_DIVERGENTE');
            if(!Buffer.isBuffer(pdf.buffer)||pdf.buffer.length!==Number(final.tamanhoBytes)||pdf.tamanho!==pdf.buffer.length||pdf.mime!=='application/pdf')throw erroDownload('ARQUIVO_INVALIDO');
            res.removeHeader('ETag');res.removeHeader('Last-Modified');
            res.status(200).set({'Content-Type':'application/pdf','Content-Disposition':'attachment; filename="ebook.pdf"',
                'Content-Length':String(pdf.tamanho),'Accept-Ranges':'none'});
            res.end(req.method==='HEAD'?undefined:pdf.buffer);
        }
    };
};
