import sanitizeHtml from 'sanitize-html';
import {criarLojaSessaoService,hashTokenSessao,tokenSessaoValido} from './lojaSessaoService.js';
import {uuidPagamento} from './lojaPagamentoContratos.js';
import {avaliarElegibilidadeFinanceiraNaConexao} from './lojaDownloadFinanceiroService.js';

const codigos=new Set(['SESSAO_INVALIDA','ENTRADA_INVALIDA','DIREITO_NAO_ENCONTRADO','DIREITO_INDISPONIVEL',
    'FINANCEIRO_INDISPONIVEL','ARQUIVO_INDISPONIVEL','TRANSACAO_INVALIDA','AUTORIZACAO_INDISPONIVEL']);
const falhar=codigo=>{throw Object.assign(new Error(codigo),{codigo});};
const seguro=e=>{falhar(codigos.has(e?.codigo)?e.codigo:'AUTORIZACAO_INDISPONIVEL');};
const destruir=c=>{try{c.destroy();}catch{}};
const uuid=v=>{try{return uuidPagamento(v);}catch{falhar('ENTRADA_INVALIDA');}};
const inteiro=n=>Number.isInteger(n)&&n>0&&n<=4294967295;
const vinculo=`FROM ist_loja_download_direitos d
    JOIN ist_loja_pedido_itens i ON i.id=d.pedido_item_id AND i.produto_id=d.produto_id
    JOIN ist_loja_pedidos p ON p.id=i.pedido_id
    JOIN ist_loja_sessoes s ON s.id=p.sessao_id
    JOIN ist_loja_arquivo_versoes v ON v.id=d.arquivo_versao_id AND v.produto_id=d.produto_id`;

/** Interno: token vem do leitor de cookie da Loja; contexto somente na composicao.
 * Nenhuma operacao cria sessao, ativa direitos, acessa arquivos ou chama PayPal.
 */
export const criarLojaDownloadAutorizacaoService=({db,contextoEsperado,agora=()=>new Date()}={})=>{
    if(!db?.getConnection||typeof agora!=='function'||contextoEsperado?.provedor!=='paypal'
        ||!['sandbox','live'].includes(contextoEsperado.ambiente)||typeof contextoEsperado.contaRecebedora!=='string'
        ||!/^[A-Za-z0-9-]{1,128}$/.test(contextoEsperado.contaRecebedora))falhar('ENTRADA_INVALIDA');
    const financeiro=Object.freeze({provedor:'paypal',ambiente:contextoEsperado.ambiente,contaRecebedora:contextoEsperado.contaRecebedora});
    const exigirTransacao=async c=>{
        const [[t]]=await c.query('SELECT @@in_transaction transacao,@@tx_isolation isolamento');
        if(Number(t?.transacao)!==1||t.isolamento!=='READ-COMMITTED')falhar('TRANSACAO_INVALIDA');
    };
    const autenticar=async(c,token)=>{
        const sessaoService=criarLojaSessaoService({db:{execute:(...args)=>c.query(...args)},agora});
        const sessao=await sessaoService.obterSessao(token),hash=hashTokenSessao(token);
        const [[s]]=await c.query('SELECT id FROM ist_loja_sessoes WHERE id=? AND token_hash=? FOR UPDATE',[sessao.id,hash]);
        if(!s||s.id!==sessao.id)falhar('SESSAO_INVALIDA');
        // O lock pode ter aguardado revogacao/expiracao: autenticar novamente.
        await sessaoService.obterSessao(token);
        return {id:sessao.id,hash,conferir:()=>sessaoService.obterSessao(token)};
    };
    const localizar=async(c,sessao,publicId)=>{
        const [[d]]=await c.query(`SELECT d.id,d.public_id,d.estado,d.versao,d.pedido_item_id,d.produto_id,d.arquivo_versao_id,
            p.id pedido_id ${vinculo} WHERE d.public_id=? AND p.sessao_id=? AND s.token_hash=?`,[publicId,sessao.id,sessao.hash]);
        if(!d)falhar('DIREITO_NAO_ENCONTRADO');
        return d;
    };
    const comTransacao=async(token,operacao)=>{
        if(!tokenSessaoValido(token))falhar('SESSAO_INVALIDA');
        let c,iniciada=false,commitIniciado=false,isolamentoAnterior;
        try{
            c=await db.getConnection();
            try{
                const [[t]]=await c.query('SELECT @@in_transaction transacao,@@autocommit autocommit,@@tx_isolation isolamento');
                if(Number(t?.transacao)!==0||Number(t?.autocommit)!==1)falhar('TRANSACAO_INVALIDA');
                isolamentoAnterior={'READ-UNCOMMITTED':'READ UNCOMMITTED','READ-COMMITTED':'READ COMMITTED',
                    'REPEATABLE-READ':'REPEATABLE READ','SERIALIZABLE':'SERIALIZABLE'}[t.isolamento];
                if(!isolamentoAnterior)falhar('TRANSACAO_INVALIDA');
                await c.query('SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED');
            }catch(e){destruir(c);c=null;throw e;}
            await c.beginTransaction();iniciada=true;
            const sessao=await autenticar(c,token),resultado=await operacao(c,sessao);
            await sessao.conferir();commitIniciado=true;await c.commit();iniciada=false;
            return resultado;
        }catch(e){
            if(c&&commitIniciado){destruir(c);c=null;}
            else if(c&&iniciada)try{await c.rollback();}catch{destruir(c);c=null;}
            seguro(e);
        }finally{
            if(c){
                try{await c.query(`SET SESSION TRANSACTION ISOLATION LEVEL ${isolamentoAnterior}`);}
                catch{destruir(c);c=null;}
                c?.release();
            }
        }
    };
    const listarDireitosDaSessao=async(token,{limite=20,apos=null}={})=>{
        if(!Number.isInteger(limite)||limite<1||limite>50)falhar('ENTRADA_INVALIDA');
        if(apos!==null)apos=uuid(apos);
        return comTransacao(token,async(c,s)=>{
            const [rows]=await c.query(`SELECT d.public_id,d.estado,i.titulo_snapshot ${vinculo}
                WHERE p.sessao_id=? AND s.token_hash=? AND (? IS NULL OR d.public_id>?)
                ORDER BY d.public_id LIMIT ?`,[s.id,s.hash,apos,apos,limite+1]);
            const pagina=rows.slice(0,limite);
            return {direitos:pagina.map(d=>({publicId:d.public_id,titulo:sanitizeHtml(d.titulo_snapshot,{allowedTags:[],allowedAttributes:{}}),
                estado:d.estado,podeSolicitarArquivo:d.estado==='ATIVO'})),proximoCursor:rows.length>limite?pagina.at(-1).public_id:null};
        });
    };
    const localizarDireitoDaSessao=async(token,publicId)=>{
        publicId=uuid(publicId);
        return comTransacao(token,async(c,s)=>{
            const d=await localizar(c,s,publicId);
            return {direitoId:d.id,publicId:d.public_id,pedidoId:d.pedido_id,itemId:d.pedido_item_id,produtoId:d.produto_id,
                arquivoVersaoId:d.arquivo_versao_id,estado:d.estado,versao:d.versao};
        });
    };
    const autorizar=async(c,token,publicId)=>{
        await exigirTransacao(c);const s=await autenticar(c,token),descoberta=await localizar(c,s,publicId);
        const [[p]]=await c.query('SELECT id FROM ist_loja_pedidos WHERE id=? AND sessao_id=? FOR UPDATE',[descoberta.pedido_id,s.id]);
        if(!p)falhar('DIREITO_NAO_ENCONTRADO');
        await c.query('SELECT id FROM ist_loja_pagamentos WHERE pedido_id=? ORDER BY id FOR UPDATE',[p.id]);
        await c.query('SELECT id FROM ist_loja_pagamento_operacoes WHERE pedido_id=? ORDER BY id FOR UPDATE',[p.id]);
        const [evs]=await c.query(`SELECT e.id FROM ist_loja_pagamento_eventos e JOIN ist_loja_pagamentos pg ON pg.id=e.pagamento_id
            WHERE pg.pedido_id=? ORDER BY e.id`,[p.id]);
        for(const e of evs)await c.query('SELECT id FROM ist_loja_pagamento_eventos WHERE id=? FOR UPDATE',[e.id]);
        const [ids]=await c.query(`SELECT d.id FROM ist_loja_download_direitos d JOIN ist_loja_pedido_itens i ON i.id=d.pedido_item_id
            WHERE i.pedido_id=? ORDER BY d.id`,[p.id]);
        for(const d of ids)await c.query('SELECT id FROM ist_loja_download_direitos WHERE id=? FOR UPDATE',[d.id]);
        const atual=await localizar(c,s,publicId);
        if(atual.pedido_id!==p.id||atual.id!==descoberta.id||atual.arquivo_versao_id!==descoberta.arquivo_versao_id)falhar('DIREITO_INDISPONIVEL');
        if(atual.estado!=='ATIVO')falhar('DIREITO_INDISPONIVEL');
        const avaliacao=await avaliarElegibilidadeFinanceiraNaConexao(c,p.id,financeiro);
        if(avaliacao.classificacao!=='ELEGIVEL'||avaliacao.elegivel!==true)falhar('FINANCEIRO_INDISPONIVEL');
        const ref=avaliacao.referencias?.direitos.find(d=>d.id===atual.id);
        if(!ref||ref.estado!=='ATIVO'||ref.versao!==atual.versao||ref.arquivoVersaoId!==atual.arquivo_versao_id)falhar('DIREITO_INDISPONIVEL');
        const [[v]]=await c.query(`SELECT v.id,v.produto_id,v.caminho_relativo,CAST(v.tamanho_bytes AS CHAR) tamanho_bytes,v.sha256,v.mime
            ${vinculo} WHERE d.public_id=? AND p.sessao_id=? AND s.token_hash=?`,[publicId,s.id,s.hash]);
        if(!v||v.id!==atual.arquivo_versao_id||v.produto_id!==atual.produto_id||!inteiro(v.id)||v.mime!=='application/pdf'
            ||typeof v.caminho_relativo!=='string'||v.caminho_relativo.length>512
            ||!/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\.pdf$/.test(v.caminho_relativo)
            ||!/^[1-9]\d{0,15}$/.test(v.tamanho_bytes)||BigInt(v.tamanho_bytes)>9007199254740991n
            ||!Buffer.isBuffer(v.sha256)||v.sha256.length!==32)falhar('ARQUIVO_INDISPONIVEL');
        await s.conferir();
        return {direitoPublicId:atual.public_id,direitoId:atual.id,direitoVersao:atual.versao,pedidoId:p.id,
            arquivoVersaoId:v.id,caminhoRelativo:v.caminho_relativo,tamanhoBytes:v.tamanho_bytes,sha256:Buffer.from(v.sha256),mime:v.mime};
    };
    const autorizarArquivoNaConexao=async(c,token,publicId)=>{
        if(!tokenSessaoValido(token))falhar('SESSAO_INVALIDA');publicId=uuid(publicId);
        try{return await autorizar(c,token,publicId);}catch(e){seguro(e);}
    };
    return Object.freeze({listarDireitosDaSessao,localizarDireitoDaSessao,autorizarArquivoNaConexao});
};
