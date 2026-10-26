import multer from 'multer';
import {randomUUID} from 'node:crypto';
import {open} from 'node:fs/promises';
import path from 'node:path';
import {MAX_PDF_ADMIN} from './lojaAdminContratos.js';

const falha=(statusAdmin=400)=>Object.assign(Error('PDF_ADMIN_INVALIDO'),{statusAdmin});
export const publicarPdfAdmin=async({db,arquivos,livroId,produtoId,versaoPublicId,publicacaoAtualEsperada})=>{
    // The existing publisher owns the transaction; validate association under its product lock.
    const banco={getConnection:async()=>{
        const c=await db.getConnection();
        return {query:(...a)=>c.query(...a),execute:async(sql,args)=>{
            const r=await c.execute(sql,args);
            if(sql==='SELECT id,tipo,livro_id FROM ist_loja_produtos WHERE id=? FOR UPDATE'
                && Number(r[0][0]?.livro_id)!==livroId)
                throw Object.assign(Error('PRODUTO_INDISPONIVEL'),{codigo:'PRODUTO_INDISPONIVEL'});
            return r;
        },beginTransaction:()=>c.beginTransaction(),commit:()=>c.commit(),rollback:()=>c.rollback(),release:()=>c.release(),destroy:()=>c.destroy()};
    }};
    try{
        const r=await arquivos.criarPublicacao({db:banco,maxBytes:MAX_PDF_ADMIN}).publicar({produtoId,versaoPublicId,publicacaoAtualEsperada});
        return {versaoPublicId:r.versaoPublicId,numeroVersao:r.numeroVersao,estado:r.estado};
    }catch(e){
        const conflitos=['CONFLITO_PUBLICACAO','VERSAO_INEXISTENTE','PRODUTO_INDISPONIVEL'];
        throw Object.assign(falha(conflitos.includes(e?.codigo)?409:503),{codigoAdmin:'ADMIN_PUBLICACAO_CONFLITO'});
    }
};
const receber=multer({storage:multer.memoryStorage(),limits:{fileSize:MAX_PDF_ADMIN,files:1,fields:0,parts:2},
    fileFilter:(_req,file,cb)=>cb(file.mimetype==='application/pdf'?null:falha(),true)}).single('pdf');
export const receberPdfAdmin=(req,res,next)=>{
    if(!/^multipart\/form-data\s*;/i.test(req.get('Content-Type')??''))return next(falha(415));
    receber(req,res,e=>next(e?falha(e.code==='LIMIT_FILE_SIZE'?413:400):undefined));
};

export const registrarPdfAdmin=async({buffer,livroId,produtoId,db,arquivos})=>{
    if(!Buffer.isBuffer(buffer)||buffer.length<8||buffer.length>MAX_PDF_ADMIN
        ||!/^%PDF-(?:1\.[0-7]|2\.0)$/.test(buffer.subarray(0,8).toString('latin1')))throw falha();
    const raiz=await arquivos.obterRaizValidada();
    const relativo=randomUUID()+'.pdf';
    const destino=path.join(raiz,relativo);
    let arquivo;
    try{
        arquivo=await open(destino,'wx',0o600);
        await arquivo.writeFile(buffer);await arquivo.sync();await arquivo.close();arquivo=null;
        // Revalidate the same operational root, also used by D6 downloads.
        if(await arquivos.obterRaizValidada()!==raiz)throw falha(503);
        // Narrow adapter: verify the book/product relationship UNDER the lock
        // already acquired by the existing service. Never lock book before product.
        const dbDoLivro={getConnection:async()=>{
            const c=await db.getConnection();return {
                query:(...a)=>c.query(...a),execute:async(sql,args)=>{
                    const resultado=await c.execute(sql,args);
                    if(sql==='SELECT id,tipo,livro_id FROM ist_loja_produtos WHERE id=? FOR UPDATE'){
                        const row=resultado[0][0];
                        if(!row||Number(row.livro_id)!==livroId)
                            throw Object.assign(Error('PRODUTO_INDISPONIVEL'),{codigo:'PRODUTO_INDISPONIVEL'});
                    }
                    return resultado;
                },beginTransaction:()=>c.beginTransaction(),commit:()=>c.commit(),rollback:()=>c.rollback(),release:()=>c.release(),destroy:()=>c.destroy()
            };
        }};
        let c,logico;
        try{
            c=await db.getConnection();
            const [rows]=await c.query(`SELECT arquivo_logico_id FROM ist_loja_arquivo_versoes
                WHERE produto_id=? ORDER BY numero_versao DESC LIMIT 1`,[produtoId]);
            logico=rows[0]?.arquivo_logico_id??randomUUID();
        }finally{c?.release();}
        const item=await arquivos.criarPublicacao({db:dbDoLivro,maxBytes:MAX_PDF_ADMIN}).registrarRascunho({
            registroPublicId:randomUUID(),produtoId,caminhoRelativo:relativo,arquivoLogicoId:logico});
        return {versaoPublicId:item.versaoPublicId,produtoId:item.produtoId,numeroVersao:item.numeroVersao,estado:item.estado};
    }catch(e){
        if(e?.codigo==='ADMIN_RASCUNHO_EXISTENTE')
            throw Object.assign(falha(409),{codigoAdmin:'ADMIN_RASCUNHO_EXISTENTE'});
        // No deletion after uncertain registration: the service may have committed.
        // Retain the exclusively-created file for reconciliation; never overwrite.
        throw falha(503);
    }finally{if(arquivo)await arquivo.close().catch(()=>{});}
};
