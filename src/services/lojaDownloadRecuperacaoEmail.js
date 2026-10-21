import {normalizarEmailComprador} from './lojaPedidoContratos.js';

// Adaptador permanece independente de SMTP; composicao injeta o envio estrito.
export const criarAdaptadorEmailRecuperacao=({enviarEmail,origemPublica,producao=false}={})=>{
    let u;
    try{u=new URL(origemPublica);}catch{throw Error('CONFIGURACAO_EMAIL_INVALIDA');}
    if(typeof producao!=='boolean'||typeof enviarEmail!=='function'||u.origin!==origemPublica||u.username||u.password
       ||(producao?u.protocol!=='https:':!['localhost','127.0.0.1','[::1]'].includes(u.hostname))
       ||!['http:','https:'].includes(u.protocol))throw Error('CONFIGURACAO_EMAIL_INVALIDA');
    return Object.freeze({async enviar(email,desafio){
        try{
            email=normalizarEmailComprador(email);
            if(!/^[0-9a-f-]{36}$/.test(desafio?.publicId??'')||!/^[A-Za-z0-9_-]{43}$/.test(desafio?.segredo??''))throw Error();
            const link=new URL('/loja/recuperar',origemPublica);
            link.hash=new URLSearchParams({id:desafio.publicId,segredo:desafio.segredo}).toString();
            await enviarEmail({to:email,subject:'Recuperacao de acesso aos e-books — Loja IST',
                text:`Para recuperar o acesso, abra ${link.href}\nO link expira em 15 minutos. Sua abertura nao confirma a recuperacao: confirme explicitamente na pagina. Se nao solicitou, ignore esta mensagem.`});
        }catch{throw Error('ENVIO_RECUPERACAO_INDISPONIVEL');}
    }});
};
