// Capa editorial publica: nunca utiliza nomes/caminhos fornecidos pelo navegador.
import multer from 'multer';
import sharp from 'sharp';
import {randomUUID} from 'node:crypto';
import {lstat,open,unlink} from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {criarConfiguracaoCapasLoja,URL_CAPAS_LIVROS} from '../config/lojaArmazenamento.js';

export const MAX_CAPA_BYTES=5*1024*1024;
const raiz=fileURLToPath(new URL('../../',import.meta.url));
const invalidar=(statusAdmin=400)=>Object.assign(Error('CAPA_INVALIDA'),{statusAdmin});
const formatos=new Set(['jpeg','png','webp']);
// Configuracao administrativa, nunca um caminho recebido por HTTP. Nao segue links.
const semLinks=async alvo=>{
    let atual=path.parse(alvo).root;
    for(const parte of alvo.slice(atual.length).split(path.sep).filter(Boolean)){
        atual=path.join(atual,parte);const st=await lstat(atual);
        if(!st.isDirectory()||st.isSymbolicLink())throw invalidar(503);
    }
    return alvo;
};
// Expose only public cover images, never a root received from HTTP.
export const criarEntregaCapasLivros=({raizProjeto=raiz,env=process.env,
    configuracaoCapas=criarConfiguracaoCapasLoja({env,raizProjeto})}={})=>async(req,res)=>{
    const ausente=()=>res.status(404).set('Cache-Control','no-store').end();
    if(!['GET','HEAD'].includes(req.method)||!/^\/[A-Za-z0-9_-]+\.(?:webp|png|jpe?g|avif|gif)$/i.test(req.path))return ausente();
    try{
        const compartilhado=await configuracaoCapas.obterRaizValidada();
        if(compartilhado){
            try{
                await enviarImagem(res,path.join(compartilhado,req.path.slice(1)));return;
            }catch(e){if(e.code!=='ENOENT')throw e;}
        }
        let diretorio=await semLinks(raizProjeto);
        for(const parte of ['src','assets','images','livros']){
            diretorio=path.join(diretorio,parte);
            const st=await lstat(diretorio);
            if(!st.isDirectory()||st.isSymbolicLink())return ausente();
        }
        await enviarImagem(res,path.join(diretorio,req.path.slice(1)));
    }catch{return ausente();}
};
const enviarImagem=async(res,arquivo)=>{
    const st=await lstat(arquivo);
    if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size>MAX_CAPA_BYTES)throw invalidar(404);
    // Manter o descritor aberto evita uma segunda abertura por sendFile apos validar.
    const h=await open(arquivo,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
    try{
        const aberto=await h.stat();
        if(!aberto.isFile()||aberto.ino!==st.ino||aberto.dev!==st.dev||aberto.nlink!==1||aberto.size>MAX_CAPA_BYTES)throw invalidar(404);
        const bytes=await h.readFile();
        const meta=await sharp(bytes,{limitInputPixels:40_000_000}).metadata();
        const tipos={jpeg:'image/jpeg',png:'image/png',webp:'image/webp',avif:'image/avif',gif:'image/gif'};
        if(!tipos[meta.format])throw invalidar(404);
        res.set('X-Content-Type-Options','nosniff').type(tipos[meta.format]).send(bytes);
    }finally{await h.close();}
};
const receber=multer({storage:multer.memoryStorage(),
    limits:{fileSize:MAX_CAPA_BYTES,files:1,fields:0,parts:1},
    fileFilter:(_req,file,cb)=>cb(['image/jpeg','image/png','image/webp'].includes(file.mimetype)?null:invalidar(),true)
}).single('capa');

export const receberCapaAdmin=(req,res,next)=>{
    if(!/^multipart\/form-data\s*;/i.test(req.get('Content-Type')??''))return next(invalidar(415));
    receber(req,res,e=>next(e?invalidar(e.code==='LIMIT_FILE_SIZE'?413:400):undefined));
};
const diretorioSeguro=async(configuracaoCapas)=>{
    try{return {publico:URL_CAPAS_LIVROS.slice(1,-1),fisico:await configuracaoCapas.obterRaizValidada()};}
    catch{throw invalidar(503);}
};
export const armazenarCapaAdmin=async(buffer,{env=process.env,raizProjeto=raiz,
    configuracaoCapas=criarConfiguracaoCapasLoja({env,raizProjeto})}={})=>{
    if(!Buffer.isBuffer(buffer)||!buffer.length)throw invalidar();
    if(buffer.length>MAX_CAPA_BYTES)throw invalidar(413);
    let imagem;
    try{
        const metadados=await sharp(buffer,{limitInputPixels:40_000_000}).metadata();
        const troca=[5,6,7,8].includes(metadados.orientation);
        const largura=troca?metadados.height:metadados.width,altura=troca?metadados.width:metadados.height;
        if(!formatos.has(metadados.format)||!largura||!altura||largura<186||altura<260
            ||(metadados.pages??1)!==1)throw invalidar();
        imagem=await sharp(buffer,{limitInputPixels:40_000_000}).rotate().webp({quality:85}).toBuffer();
        if(imagem.length>MAX_CAPA_BYTES)throw invalidar(413);
    }catch(e){throw e.statusAdmin?e:invalidar();}
    const {publico,fisico}=await diretorioSeguro(configuracaoCapas);
    const nome=randomUUID()+'.webp',destino=path.join(fisico,nome);
    let arquivo,criado=false;
    try{
        arquivo=await open(destino,'wx',0o644);criado=true;
        await arquivo.writeFile(imagem);await arquivo.sync();await arquivo.close();arquivo=null;
    }catch(e){
        if(arquivo)await arquivo.close().catch(()=>{});
        if(criado)await unlink(destino).catch(()=>{}); // somente arquivo novo desta chamada
        throw invalidar(503);
    }
    return {img:publico+'/'+nome};
};
