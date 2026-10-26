import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {lstat,realpath,access} from 'node:fs/promises';
import {constants,readFileSync} from 'node:fs';
import {parse} from 'dotenv';
import {criarConfiguracaoArquivosLoja} from './lojaArquivos.js';
import {BASE_IMPLANTACAO_IST,limitesArmazenamentoImplantacao} from './lojaImplantacao.js';

const projeto=fileURLToPath(new URL('../../',import.meta.url));
export const URL_CAPAS_LIVROS='/assets/images/livros/';
export const CONTRATO_ARMAZENAMENTO=Object.freeze({versao:1,variaveis:['PRODUCTS_LIVROS_PATH','CAPAS_LIVROS_STORAGE_PATH']});
const limitesPadrao=()=>process.platform==='linux'?limitesArmazenamentoImplantacao(BASE_IMPLANTACAO_IST):{raizesPublicas:[],diretoriosDescartaveis:[]};
const erro=nome=>Object.assign(Error(`${nome}: configuracao de armazenamento ausente ou invalida.`),{codigo:'CONFIGURACAO_ARMAZENAMENTO_INVALIDA'});
const contem=(a,b)=>{const r=path.relative(a,b);return r===''||(!path.isAbsolute(r)&&r!=='..'&&!r.startsWith('..'+path.sep));};
const validarLimites=async(p,limites,nome)=>{
    if(!limites||!Array.isArray(limites.raizesPublicas)||!Array.isArray(limites.diretoriosDescartaveis))throw erro(nome);
    for(const raiz of [...limites.raizesPublicas,...limites.diretoriosDescartaveis]){
        if(typeof raiz!=='string'||!path.isAbsolute(raiz))throw erro(nome);
        // Resolve even absent leaves against their existing canonical ancestor.
        let atual=path.resolve(raiz),faltantes=[];
        for(;;){
            try{
                const s=await lstat(atual);
                if(!s.isDirectory()&&!s.isSymbolicLink())throw erro(nome);
                const canonica=path.resolve(await realpath(atual),...faltantes.reverse());
                if(contem(raiz,p)||contem(p,raiz)||contem(canonica,p)||contem(p,canonica))throw erro(nome);
                break;
            }catch(e){
                if(e.code!=='ENOENT')throw e;
                // Broken symlinks are uncertainty, never a missing safe directory.
                try{if((await lstat(atual)).isSymbolicLink())throw erro(nome);}catch(x){if(x.code!=='ENOENT')throw x;}
                const pai=path.dirname(atual);if(pai===atual)throw erro(nome);
                faltantes.push(path.basename(atual));atual=pai;
            }
        }
    }
};
export const caminhoOficial=(env,nome)=>{
    const v=env[nome];
    if(typeof v!=='string'||!v.trim()||v!==v.trim()||v.includes('\0')||!path.isAbsolute(v)
        ||(process.platform==='win32'&&!/^[a-z]:[\\/]/i.test(v)))throw erro(nome);
    const p=path.resolve(v);if(p===path.parse(p).root)throw erro(nome);return p;
};
// Only the two storage keys override inherited process values. No global dotenv override.
export const carregarCaminhosDoEnv=({arquivo=process.env.DOTENV_CONFIG_PATH??new URL('../../.env',import.meta.url),env=process.env}={})=>{
    if(typeof arquivo==='string'&&!path.isAbsolute(arquivo))throw erro('ENV_ARMAZENAMENTO');
    let dados;try{dados=parse(readFileSync(arquivo));}catch{throw erro('ENV_ARMAZENAMENTO');}
    const nomes=['PRODUCTS_LIVROS_PATH','CAPAS_LIVROS_STORAGE_PATH'];
    for(const nome of nomes)caminhoOficial(dados,nome);
    for(const nome of nomes)env[nome]=dados[nome];
    return env;
};
export const criarConfiguracaoCapasLoja=({env=process.env,raizProjeto=projeto,limites=limitesPadrao()}={})=>({
    async obterRaizValidada(){
        try{
            const p=caminhoOficial(env,'CAPAS_LIVROS_STORAGE_PATH');
            await validarLimites(p,limites,'CAPAS_LIVROS_STORAGE_PATH');
            const segmentos=p.replaceAll('\\','/');
            if(/\/(?:src\/assets|\.deploy\/releases)(?:\/|$)/i.test(segmentos))throw erro('CAPAS_LIVROS_STORAGE_PATH');
            const privado=env.PRODUCTS_LIVROS_PATH===undefined?null:caminhoOficial(env,'PRODUCTS_LIVROS_PATH');
            if(privado&&(contem(privado,p)||contem(p,privado)))throw erro('CAPAS_LIVROS_STORAGE_PATH');
            if(contem(p,raizProjeto)||['src','public','dist','.deploy'].some(x=>contem(path.join(raizProjeto,x),p)))throw erro('CAPAS_LIVROS_STORAGE_PATH');
            let atual=path.parse(p).root;
            for(const parte of p.slice(atual.length).split(path.sep).filter(Boolean)){
                atual=path.join(atual,parte);const s=await lstat(atual);
                if(!s.isDirectory()||s.isSymbolicLink())throw erro('CAPAS_LIVROS_STORAGE_PATH');
            }
            if(path.relative(await realpath(p),p)!=='')throw erro('CAPAS_LIVROS_STORAGE_PATH');
            await access(p,constants.R_OK|constants.W_OK|constants.X_OK);return p;
        }catch{throw erro('CAPAS_LIVROS_STORAGE_PATH');}
    }
});
export const criarArmazenamentoLoja=({env=process.env,raizProjeto=projeto,limites=limitesPadrao()}={})=>{
    const pdf=caminhoOficial(env,'PRODUCTS_LIVROS_PATH');
    caminhoOficial(env,'CAPAS_LIVROS_STORAGE_PATH');
    const capas=criarConfiguracaoCapasLoja({env:{...env},raizProjeto,limites});
    const arquivos=criarConfiguracaoArquivosLoja({raizPrivada:pdf,raizProjeto,raizesPublicas:limites.raizesPublicas});
    return {capas,arquivos,async validar(){
        try{await validarLimites(pdf,limites,'PRODUCTS_LIVROS_PATH');const p=await arquivos.obterRaizValidada();await access(p,constants.R_OK|constants.W_OK|constants.X_OK);}
        catch{throw erro('PRODUCTS_LIVROS_PATH');}
        await capas.obterRaizValidada();
    }};
};
