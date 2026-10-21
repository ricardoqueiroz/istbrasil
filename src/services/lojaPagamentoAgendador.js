import { criarLojaPagamentoService } from './lojaPagamentoService.js';
import { criarPaypalProvider } from './pagamentos/paypalProvider.js';
import { carregarConfiguracaoLojaPedido } from '../config/lojaPedido.js';
import {fontesDescoberta,isoDescoberta} from './lojaDescobertaContratos.js';

export const comporFinanceiroLoja = ({ db, env, criarServico = criarLojaPagamentoService, criarAdaptador = criarPaypalProvider }) => {
    const ambiente = env.IST_LOJA_PAYPAL_ENV, contaRecebedora = env.IST_LOJA_PAYPAL_CONTA_RECEBEDORA;
    if (ambiente !== 'sandbox' || carregarConfiguracaoLojaPedido(env).ambiente !== ambiente
        || !/^[2-9A-HJ-NP-Z]{13}$/.test(contaRecebedora ?? '') || !db?.getConnection) throw new Error('CONFIGURACAO_INVALIDA');
    const adaptador = criarAdaptador({ env: { IST_LOJA_PAYPAL_ENV: ambiente,
        IST_LOJA_PAYPAL_CLIENT_ID: env.IST_LOJA_PAYPAL_CLIENT_ID, IST_LOJA_PAYPAL_CLIENT_SECRET: env.IST_LOJA_PAYPAL_CLIENT_SECRET } });
    return { adaptador, service: criarServico({ db, adaptador, contexto: { provedor: 'paypal', ambiente, contaRecebedora } }) };
};

// Sem pool proprio, timers ou acesso externo durante importacao.
export const iniciarRecuperacaoLoja = ({ db, env = process.env,
    criarServico = criarLojaPagamentoService, criarAdaptador = criarPaypalProvider,
    obterFinanceiro, agendar = setInterval, cancelar = clearInterval, registrar = mensagem => console.warn(mensagem) } = {}) => {
    const log = mensagem => { try { registrar(mensagem); } catch { /* Logging nao derruba a API. */ } };
    const inativo = () => ({ ativo: false, parar: async () => {} });
    if (env.IST_LOJA_RECUPERACAO_ATIVA !== 'true' || env.NODE_ENV === 'test') return inativo();
    let timer, encerrado = false, emCurso = null;
    try {
        const { service } = obterFinanceiro ? obterFinanceiro() : comporFinanceiroLoja({ db, env, criarServico, criarAdaptador });
        if (typeof service?.recuperarPendencias !== 'function') throw new Error();
        const ciclo = () => {
            if (encerrado || emCurso) return;
            emCurso = Promise.resolve().then(() => service.recuperarPendencias({ limite: 10 }))
                .then(resultados => {
                    if (resultados?.some(r => r.erro || r.resultado?.intervencao)) {
                        log('[Loja recuperacao] Ciclo concluido com pendencias; verificar diagnostico interno.');
                    }
                })
                .catch(() => log('[Loja recuperacao] Falha no ciclo; verificar diagnostico interno.'))
                .finally(() => { emCurso = null; });
        };
        timer = agendar(ciclo, 60000);
        timer?.unref?.();
        return { ativo: true, async parar() {
            if (!encerrado) { encerrado = true; cancelar(timer); timer = null; }
            // Sem cancelar operacao financeira em andamento ou fechar pool compartilhado.
            await emCurso;
        } };
    } catch {
        encerrado = true;
        if (timer != null) { try { cancelar(timer); } catch { /* Sem propagar erro de timer. */ } }
        log('[Loja recuperacao] Agendador desativado: configuracao ou inicializacao indisponivel.');
        return inativo();
    }
};

// Flag independente: nao ativa nada em instalacoes que habilitaram apenas C2.
export const iniciarWorkerAdversoLoja=({db,env=process.env,obterFinanceiro,
    agendar=setInterval,cancelar=clearInterval,limitar=setTimeout,deslimitar=clearTimeout,
    registrar=m=>console.warn(m)}={})=>{
    const log=m=>{try{registrar(m);}catch{}};
    if(env.IST_LOJA_ADVERSOS_ATIVA!=='true'||env.NODE_ENV==='test')return {ativo:false,parar:async()=>{}};
    let timer,emCurso=null,encerrado=false,controle,prazo,parada;
    try{
        const {service}=obterFinanceiro?obterFinanceiro():comporFinanceiroLoja({db,env});
        if(typeof service?.processarEventosAdversos!=='function'||typeof service?.diagnosticarEventosAdversos!=='function')throw Error();
        const ciclo=()=>{
            if(encerrado||emCurso)return;
            controle=new AbortController();prazo=limitar(()=>controle.abort(),30000);prazo?.unref?.();
            emCurso=Promise.resolve().then(()=>service.processarEventosAdversos({limite:10,signal:controle.signal}))
                .then(async resultados=>{
                    if(resultados?.some(r=>r.codigo==='D9_AUTENTICACAO'))log('[Loja adversos] Alerta: contexto suspenso por autenticacao/permissao; revisao operacional necessaria.');
                    if(!controle.signal.aborted){const d=await service.diagnosticarEventosAdversos();
                        // Somente contadores e codigos fechados produzidos pelo worker.
                        log('[Loja adversos] '+JSON.stringify(d));}
                }).catch(()=>log('[Loja adversos] Falha tecnica; consultar diagnostico interno.'))
                .finally(()=>{deslimitar(prazo);prazo=null;emCurso=null;});
        };
        timer=agendar(ciclo,60000);timer?.unref?.();
        return {ativo:true,parar(){return parada??= (async()=>{
            encerrado=true;if(timer!=null){cancelar(timer);timer=null;}
            if(!emCurso)return;
            let espera;try{await Promise.race([emCurso,new Promise(r=>{espera=limitar(()=>{
                controle.abort();log('[Loja adversos] Prazo de encerramento atingido; reserva sera recuperada.');r();
            },35000);})]);}finally{deslimitar(espera);deslimitar(prazo);prazo=null;}
        })();}};
    }catch{
        if(timer!=null)cancelar(timer);if(prazo!=null)deslimitar(prazo);
        log('[Loja adversos] Worker desativado: configuracao indisponivel.');
        return {ativo:false,parar:async()=>{}};
    }
};

export const iniciarDescobertaLoja=({db,env=process.env,obterFinanceiro,agendar=setInterval,cancelar=clearInterval,
    limitar=setTimeout,deslimitar=clearTimeout,registrar=m=>console.warn(m)}={})=>{
    const inativo=()=>({ativo:false,parar:async()=>{}}),log=m=>{try{registrar(m);}catch{}};
    if(env.IST_LOJA_DESCOBERTA_ATIVA!=='true'||env.NODE_ENV==='test')return inativo();
    let timer,prazo,controle,emCurso=null,parada,encerrado=false;
    try{
        const desde=isoDescoberta(env.IST_LOJA_DESCOBERTA_DESDE),fontes=(env.IST_LOJA_DESCOBERTA_FONTES??'').split(',');
        if(!desde||fontes.some(f=>!fontesDescoberta.includes(f))||new Set(fontes).size!==fontes.length)throw Error();
        const {service}=obterFinanceiro?obterFinanceiro():comporFinanceiroLoja({db,env});
        if(typeof service?.descobrirEventosAdversos!=='function')throw Error();
        const ciclo=()=>{
            if(encerrado||emCurso)return;
            controle=new AbortController();prazo=limitar(()=>controle.abort(),90000);prazo?.unref?.();
            emCurso=Promise.resolve().then(async()=>{
                for(const fonte of fontes){
                    if(encerrado||controle.signal.aborted)break;
                    const r=await service.descobrirEventosAdversos({fonte,desde,signal:controle.signal});
                    if(r?.estado!=='SEM_TRABALHO')log('[Loja descoberta] '+fonte+': '+
                        (r?.estado==='CONCLUIDO'?'janela concluida.':'pendencia; consultar checkpoint.'));
                }
            }).catch(()=>log('[Loja descoberta] Falha tecnica; verificar configuracao e checkpoint.'))
                .finally(()=>{deslimitar(prazo);prazo=null;emCurso=null;});
        };
        timer=agendar(ciclo,60000);timer?.unref?.();
        return {ativo:true,parar(){return parada??=(async()=>{
            encerrado=true;if(timer!=null){cancelar(timer);timer=null;}
            if(!emCurso)return;let espera;
            try{await Promise.race([emCurso,new Promise(r=>{espera=limitar(()=>{controle.abort();r();},95000);})]);}
            finally{deslimitar(espera);deslimitar(prazo);prazo=null;}
        })();}};
    }catch{if(timer!=null)cancelar(timer);log('[Loja descoberta] Desativada: configuracao explicita incompleta.');return inativo();}
};
