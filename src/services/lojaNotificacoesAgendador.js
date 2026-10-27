import {criarProcessadorNotificacoes} from './lojaNotificacoesWorker.js';
import {criarEnvioRecuperacaoSmtp} from './mailService.js';

const ativos=new WeakMap();
export const iniciarNotificacoesLoja=({db,env=process.env,agendar=setInterval,cancelar=clearInterval,
    criarEnvio=criarEnvioRecuperacaoSmtp,criarProcessador=criarProcessadorNotificacoes,registrar=m=>console.warn(m)}={})=>{
    const log=c=>{try{registrar(c);}catch{}};
    const resumoVazio=r=>r&&typeof r==='object'
        &&['reservadas','enviadas','falhas','incertas','semReserva'].every(k=>r[k]===0)
        &&Object.keys(r).length===5;
    const inativo=()=>({ativo:false,parar:async()=>{}});
    if(env.IST_LOJA_NOTIFICACOES_ATIVAS!=='true'||env.NODE_ENV==='test')return inativo();
    if(ativos.has(db))return ativos.get(db);
    let timer,emCurso=null,encerrado=false,controle,parada;
    try{
        if(!['production','development'].includes(env.NODE_ENV)||env.LOJA_AMBIENTE!=='sandbox'
            ||env.IST_LOJA_PAYPAL_ENV!=='sandbox')throw Error();
        const enviar=criarEnvio({env,classificarNaoAceito:true});
        const worker=criarProcessador({db,enviar,ambiente:'sandbox'});
        const ciclo=()=>{
            if(encerrado||emCurso)return;
            controle=new AbortController();
            emCurso=Promise.resolve().then(()=>worker.processar({limite:10,signal:controle.signal}))
                .then(r=>{if(!resumoVazio(r))log('NOTIFICACOES_RESUMO '+JSON.stringify(r));})
                .catch(()=>log('NOTIFICACOES_CICLO_INDISPONIVEL')).finally(()=>{emCurso=null;});
        };
        timer=agendar(ciclo,60000);timer?.unref?.();
        const handle={ativo:true,parar:()=>parada??=(async()=>{
            encerrado=true;cancelar(timer);controle?.abort();await emCurso;ativos.delete(db);
        })()};
        ativos.set(db,handle);return handle;
    }catch{if(timer)cancelar(timer);log('NOTIFICACOES_DESATIVADAS_CONFIGURACAO');return inativo();}
};
