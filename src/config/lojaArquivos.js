import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {lstat,realpath} from 'node:fs/promises';
import {criarLojaArquivoService} from '../services/lojaArquivoService.js';

const raizProjetoPadrao=fileURLToPath(new URL('../../',import.meta.url));
const falhar=()=>{throw Object.assign(new Error('CONFIGURACAO_INVALIDA'),{codigo:'CONFIGURACAO_INVALIDA'});};
const absoluto=v=>typeof v==='string'&&path.isAbsolute(v)&&!v.includes('\0');
const contem=(a,b)=>{
    const r=path.relative(a,b);
    return r===''||(!path.isAbsolute(r)&&r!=='..'&&!r.startsWith('..'+path.sep));
};
const sobrepoe=(a,b)=>contem(a,b)||contem(b,a);
// Diretorios publicados pelo Express ou copiados/servidos pela configuracao
// versionada Angular/Nginx. Nao considerar todo o repositorio como webroot.
export const raizesPublicasConhecidasLoja=(raizProjeto=raizProjetoPadrao)=>{
    if(!absoluto(raizProjeto))falhar();
    return ['istbrasil.private/documents','istbrasil.private/projetos','istbrasil.private/usuarios/fotos',
        'src/assets','public','dist/sakai-ng','html'].map(p=>path.resolve(raizProjeto,...p.split('/')));
};
// Publicacoes futuras podem ainda nao existir. Resolver o ancestral existente,
// seguindo links publicos conhecidos, e projetar apenas segmentos ausentes.
// Qualquer erro diferente de inexistencia impede comprovar a separacao.
const canonicoPublico=async alvo=>{
    let atual=alvo;const faltantes=[];
    for(;;){
        try{
            const s=await lstat(atual);
            if(!s.isDirectory()&&!s.isSymbolicLink())falhar();
            const canonico=await realpath(atual);
            if(!(await lstat(canonico)).isDirectory())falhar();
            return path.resolve(canonico,...faltantes.reverse());
        }catch(e){
            if(e.code!=='ENOENT')throw e;
            // Um link quebrado e uma configuracao incerta, nao um caminho ausente.
            try{if((await lstat(atual)).isSymbolicLink())falhar();}catch(x){if(x.codigo||x.code!=='ENOENT')throw x;}
            const pai=path.dirname(atual);if(pai===atual)falhar();
            faltantes.push(path.basename(atual));atual=pai;
        }
    }
};
const semLinks=async alvo=>{
    let atual=path.parse(alvo).root;
    for(const parte of alvo.slice(atual.length).split(path.sep).filter(Boolean)){
        atual=path.join(atual,parte);if((await lstat(atual)).isSymbolicLink())falhar();
    }
};

/** Configuracao confiavel unica; nao recebe entrada HTTP, nao le dotenv/cwd.
 * A mesma instancia deve compor download e publicacao.
 */
export const criarConfiguracaoArquivosLoja=({raizPrivada,raizProjeto=raizProjetoPadrao,raizesPublicas=[]}={})=>{
    const extras=Array.isArray(raizesPublicas)?[...raizesPublicas]:null;
    const obterRaizValidada=async()=>{
        try{
            if(!absoluto(raizPrivada)||!extras||extras.some(p=>!absoluto(p)))falhar();
            const privada=path.resolve(raizPrivada);
            if(privada===path.parse(privada).root)falhar();
            await semLinks(privada);
            const canonica=await realpath(privada);
            if(!(await lstat(canonica)).isDirectory())falhar();
            for(const p of [...raizesPublicasConhecidasLoja(raizProjeto),...extras]){
                const publica=path.resolve(p),publicaCanonica=await canonicoPublico(publica);
                if(sobrepoe(privada,publica)||sobrepoe(canonica,publicaCanonica))falhar();
            }
            return canonica;
        }catch{falhar();}
    };
    // Composicao do servico existente, sem alterar regras/SQL ou aceitar segunda
    // raiz. Valida antes de cada operacao, inclusive quando o FS mudar depois.
    const criarPublicacao=(opcoes={})=>{
        if(!opcoes||Object.keys(opcoes).some(k=>!['db','agora','maxBytes'].includes(k)))falhar();
        const dependencias={...opcoes};
        const executar=acao=>async entrada=>{
            const raiz=await obterRaizValidada();
            return criarLojaArquivoService({...dependencias,raizPrivada:raiz})[acao](entrada);
        };
        return Object.freeze({registrarRascunho:executar('registrarRascunho'),publicar:executar('publicar')});
    };
    return Object.freeze({obterRaizValidada,criarPublicacao});
};
