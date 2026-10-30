import {prepararEmailPorChave} from './emailTemplateService.js';
import {CHAVE_RECUPERACAO_BIBLIOTECA_CODIGO} from '../config/emailPlaceholders.js';
import {normalizarEmailComprador} from './lojaPedidoContratos.js';

// Adaptador permanece independente de SMTP; composicao injeta o envio estrito.
export const criarAdaptadorEmailRecuperacao=({enviarEmail,origemPublica,producao=false,prepararModelo=prepararEmailPorChave}={})=>{
    let u;
    try{u=new URL(origemPublica);}catch{throw Error('CONFIGURACAO_EMAIL_INVALIDA');}
    if(typeof producao!=='boolean'||typeof enviarEmail!=='function'||u.origin!==origemPublica||u.username||u.password
       ||(producao?u.protocol!=='https:':!['localhost','127.0.0.1','[::1]'].includes(u.hostname))
       ||!['http:','https:'].includes(u.protocol))throw Error('CONFIGURACAO_EMAIL_INVALIDA');
    return Object.freeze({async prepararCodigo(){
        try{
            const compor=await prepararModelo(CHAVE_RECUPERACAO_BIBLIOTECA_CODIGO);
            const link=new URL('/loja/recuperar',origemPublica).href;
            const montar=entrega=>{
                if(!/^[0-9a-f-]{36}$/.test(entrega?.pedidoPublicId??'')||!/^\d{6}$/.test(entrega?.codigo??'')
                    ||entrega.validadeMinutos!==10)throw Error('MODELO_RECUPERACAO_INVALIDO');
                const m=compor({pedido_public_id:entrega.pedidoPublicId,codigo:entrega.codigo,
                    validade_minutos:'10',link_acesso:link});
                return {to:normalizarEmailComprador(entrega.email),subject:m.assunto,html:m.html,text:m.text};
            };
            // Preflight antes de qualquer emissao. O codigo efetivo e composto antes da invalidacao.
            montar({email:'sintetico@example.invalid',pedidoPublicId:'00000000-0000-4000-8000-000000000000',codigo:'000000',validadeMinutos:10});
            return Object.freeze({compor:montar,async enviar(mensagem){
                try{await enviarEmail(mensagem);}catch{throw Error('ENVIO_RECUPERACAO_INDISPONIVEL');}
            }});
        }catch{throw Error('MODELO_RECUPERACAO_INDISPONIVEL');}
    },async enviar(email,desafio){
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
