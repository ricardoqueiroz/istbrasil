import {criarEnvioRecuperacaoSmtp} from './mailService.js';
import {criarAdaptadorEmailRecuperacao} from './lojaDownloadRecuperacaoEmail.js';
import {carregarConfiguracaoLojaSessao} from '../config/lojaSessao.js';

// Composicao apenas; sem DNS, verify SMTP, SQL ou envio na inicializacao.
export const comporEmailRecuperacao=({env=process.env,criarEnvio=criarEnvioRecuperacaoSmtp,
    obterConfiguracao=()=>carregarConfiguracaoLojaSessao(env),avisar=()=>{}}={})=>{
    if(env.IST_LOJA_RECUPERACAO_EMAIL_ATIVO!=='true')return undefined;
    try {
        const origem=env.IST_LOJA_RECUPERACAO_ORIGEM_PUBLICA,u=new URL(origem);
        const chave=env.IST_LOJA_DOWNLOAD_RECUPERACAO_CHAVE_EMAIL;
        if(u.protocol!=='https:'||u.origin!==origem||u.username||u.password
            ||!obterConfiguracao().origens.includes(origem)||typeof chave!=='string'
            ||!/^[A-Za-z0-9_-]{43}$/.test(chave)||Buffer.from(chave,'base64url').toString('base64url')!==chave)throw Error();
        const enviar=criarEnvio({env});
        return criarAdaptadorEmailRecuperacao({origemPublica:origem,producao:true,enviarEmail:async mensagem=>{
            try{await enviar(mensagem);}catch{
                try{avisar('RECUPERACAO_EMAIL_ENVIO_INDISPONIVEL');}catch{}
                throw new Error('ENVIO_RECUPERACAO_INDISPONIVEL');
            }
        }});
    } catch {
        // Nunca passar a excecao de bibliotecas/configuracao ao logger.
        try{avisar('RECUPERACAO_EMAIL_DESATIVADO_CONFIGURACAO_INVALIDA');}catch{}
        return undefined;
    }
};
