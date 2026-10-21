import {randomBytes} from 'node:crypto';
import {sqlUtcPagamento} from './lojaPagamentoContratos.js';

const erro=codigo=>Object.assign(new Error('Processamento adverso indisponivel.'),{codigo});
const tipos="'PAYMENT.CAPTURE.REFUNDED','PAYMENT.CAPTURE.REVERSED','CUSTOMER.DISPUTE.CREATED','CUSTOMER.DISPUTE.UPDATED','CUSTOMER.DISPUTE.RESOLVED'";
const filtro=`((origem='WEBHOOK' AND tipo IN (${tipos})) OR (origem='API' AND tipo='REVISAO_FINANCEIRA' AND evento_id LIKE 'D9-OBS-%'))`;
const repetiveis=['D9_TRANSITORIO','D9_SQL','D9_SNAPSHOT','D9_CANCELADO','D9_RESULTADO_INCERTO'];
const destruir=c=>{try{c?.destroy();}catch{}};

// Fila e reservas no ledger existente. Nenhum GET/efeito financeiro aqui.
export const criarLojaPagamentoAdversoWorker=({db,contexto,reconciliar,agora=()=>new Date(),aleatorio=Math.random}={})=>{
    if(!db?.getConnection||typeof reconciliar!=='function'||contexto?.provedor!=='paypal'
        ||contexto.ambiente!=='sandbox'||!contexto.contaRecebedora)throw erro('CONFIGURACAO_INVALIDA');
    const chave=[contexto.provedor,contexto.ambiente,contexto.contaRecebedora];
    const instante=()=>sqlUtcPagamento(agora().toISOString());
    const conexao=async()=>{
        let c;
        try{
            c=await db.getConnection();
            const [[s]]=await c.query('SELECT @@in_transaction tx,@@autocommit ac');
            if(Number(s.tx)!==0||Number(s.ac)!==1)throw erro('CONEXAO_INVALIDA');
            await c.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');return c;
        }catch{destruir(c);throw erro('CONEXAO_INVALIDA');}
    };
    const ler=async id=>{
        const c=await conexao();try{
            const [[r]]=await c.query(`SELECT *,DATE_FORMAT(execucao_ate,'%Y-%m-%d %H:%i:%s.%f') execucao_prazo,
                DATE_FORMAT(proxima_tentativa_em,'%Y-%m-%d %H:%i:%s.%f') proxima_utc FROM ist_loja_pagamento_eventos WHERE id=?
                AND provedor=? AND ambiente=? AND conta_recebedora=? AND ${filtro}`,[id,...chave]);return r;
        }finally{c.release();}
    };
    const reservar=async()=>{
        let c,tx=false,commit=false,job;
        try{
            c=await conexao();await c.beginTransaction();tx=true;const data=instante();
            const [[pausa]]=await c.query(`SELECT COUNT(*) n FROM ist_loja_pagamento_eventos WHERE provedor=? AND ambiente=?
                AND conta_recebedora=? AND ${filtro} AND estado='REVISAO' AND codigo_erro='D9_AUTENTICACAO'`,chave);
            if(Number(pausa.n)){await c.rollback();tx=false;return {pausado:true};}
            const [[e]]=await c.query(`SELECT * FROM ist_loja_pagamento_eventos WHERE provedor=? AND ambiente=?
                AND conta_recebedora=? AND ${filtro} AND autenticado_em IS NOT NULL
                AND ((estado='RECEBIDO' AND (codigo_erro IS NULL OR codigo_erro IN (${repetiveis.map(()=>'?').join(',')}))
                    AND (proxima_tentativa_em IS NULL OR proxima_tentativa_em<=?))
                    OR (estado='PROCESSANDO' AND execucao_ate<=?))
                ORDER BY COALESCE(proxima_tentativa_em,recebido_em),id LIMIT 1 FOR UPDATE`,[...chave,...repetiveis,data,data]);
            if(!e){await c.rollback();tx=false;return null;}
            if(e.tentativas>=8){
                await c.query(`UPDATE ist_loja_pagamento_eventos SET estado='REVISAO',codigo_erro='D9_LIMITE',
                    execucao_token=NULL,execucao_ate=NULL,proxima_tentativa_em=NULL,atualizado_em=? WHERE id=?`,[data,e.id]);
                commit=true;await c.commit();tx=false;return {intervencao:true};
            }
            const token=randomBytes(16),prazo=sqlUtcPagamento(new Date(agora().getTime()+120000).toISOString());
            const [r]=await c.query(`UPDATE ist_loja_pagamento_eventos SET estado='PROCESSANDO',tentativas=tentativas+1,
                execucao_token=?,execucao_ate=?,proxima_tentativa_em=NULL,codigo_erro=NULL,atualizado_em=?
                WHERE id=? AND estado=? AND conteudo_hash=?`,[token,prazo,data,e.id,e.estado,e.conteudo_hash]);
            if(r.affectedRows!==1||r.warningStatus)throw erro('D9_RESERVA_PERDIDA');
            job={id:e.id,eventoId:e.evento_id,origem:e.origem,hash:e.conteudo_hash,execucaoToken:token,tentativas:e.tentativas+1};
            commit=true;await c.commit();tx=false;return job;
        }catch(falha){
            if(commit){
                destruir(c);c=null;
                if(job){const r=await ler(job.id);if(r?.estado==='PROCESSANDO'&&r.execucao_token?.equals(job.execucaoToken)
                    &&r.conteudo_hash.equals(job.hash)&&r.execucao_prazo>instante()+'000')return job;}
                throw erro('RESULTADO_DESCONHECIDO');
            }
            if(c&&tx)try{await c.rollback();}catch{destruir(c);c=null;}
            throw erro(falha.codigo??'D9_SQL');
        }finally{c?.release();}
    };
    const registrarFalha=async(job,codigo)=>{
        // Estado/codigo sao decididos aqui; nunca persistir mensagem de excecao.
        if(![...repetiveis,'D9_AUTENTICACAO','D9_CONTRATO_INVALIDO','D9_REVISAO'].includes(codigo))codigo='D9_REVISAO';
        const transitorio=['D9_TRANSITORIO','D9_SQL','D9_SNAPSHOT','D9_CANCELADO','D9_RESULTADO_INCERTO'].includes(codigo);
        if(transitorio&&job.tentativas>=8)codigo='D9_LIMITE';
        const repetir=transitorio&&job.tentativas<8,estado=repetir?'RECEBIDO':'REVISAO';
        const minutos=[1,5,15,60,360][Math.min(job.tentativas-1,4)];
        const jitter=aleatorio();if(!Number.isFinite(jitter)||jitter<0||jitter>=1)throw erro('CONFIGURACAO_INVALIDA');
        const proxima=repetir?sqlUtcPagamento(new Date(agora().getTime()+Math.min(360*60000,minutos*60000*(1+jitter*.2))).toISOString()):null;
        let c,tx=false,commit=false;
        try{
            c=await conexao();await c.beginTransaction();tx=true;const data=instante();
            const [r]=await c.query(`UPDATE ist_loja_pagamento_eventos SET estado=?,codigo_erro=?,proxima_tentativa_em=?,
                execucao_token=NULL,execucao_ate=NULL,atualizado_em=? WHERE id=? AND provedor=? AND ambiente=?
                AND conta_recebedora=? AND ${filtro} AND estado='PROCESSANDO' AND execucao_token=?
                AND execucao_ate>? AND conteudo_hash=?`,[estado,codigo,proxima,data,job.id,...chave,job.execucaoToken,data,job.hash]);
            if(r.affectedRows!==1||r.warningStatus)throw erro('D9_RESERVA_PERDIDA');
            commit=true;await c.commit();tx=false;return {estado,codigo};
        }catch(falha){
            if(commit){
                destruir(c);c=null;const r=await ler(job.id);
                if(r?.estado===estado&&r.codigo_erro===codigo&&r.tentativas===job.tentativas
                    &&r.conteudo_hash.equals(job.hash)&&r.execucao_token===null&&r.proxima_utc===(proxima===null?null:proxima+'000'))return {estado,codigo};
                throw erro('RESULTADO_DESCONHECIDO');
            }
            if(c&&tx)try{await c.rollback();}catch{destruir(c);c=null;}
            throw erro(falha.codigo??'D9_SQL');
        }finally{c?.release();}
    };
    const processar=async({limite=10,signal}={})=>{
        if(!Number.isInteger(limite)||limite<1||limite>10)throw erro('SOLICITACAO_INVALIDA');
        const resultados=[];
        for(let i=0;i<limite&&!signal?.aborted;i++){
            const job=await reservar();if(!job)break;
            if(job.pausado||job.intervencao){resultados.push({estado:'REVISAO',codigo:job.pausado?'D9_AUTENTICACAO':'D9_LIMITE'});break;}
            try{
                const r=await reconciliar({eventoId:job.eventoId,origem:job.origem,execucaoToken:job.execucaoToken,signal});
                resultados.push({estado:r.efeitoFinanceiroAplicado===false?'REVISAO':'PROCESSADO'});
            }catch(falha){
                if(falha.codigo==='D9_RESERVA_PERDIDA'){resultados.push({codigo:'D9_RESERVA_PERDIDA'});continue;}
                // A aplicacao D8 ja tenta confirmar COMMIT incerto. Se ainda
                // incerto, nao atualizar/reaplicar: deixar a reserva expirar.
                if(falha.codigo==='RESULTADO_DESCONHECIDO'){resultados.push({codigo:'D9_RESULTADO_INCERTO'});break;}
                const codigo=signal?.aborted?'D9_CANCELADO':falha.codigo==='EVIDENCIA_DESATUALIZADA'?'D9_SNAPSHOT':
                    ['D9_AUTENTICACAO','D9_TRANSITORIO','D9_CONTRATO_INVALIDO'].includes(falha.codigo)?falha.codigo:
                    ['ERRO_PERSISTENCIA','D9_SQL','CONEXAO_INVALIDA'].includes(falha.codigo)?'D9_SQL':'D9_REVISAO';
                try{resultados.push(await registrarFalha(job,codigo));}
                catch{resultados.push({codigo:'D9_RESULTADO_INCERTO'});break;}
                if(codigo==='D9_AUTENTICACAO')break;
            }
        }
        return resultados;
    };
    const diagnosticar=async()=>{
        const c=await conexao();try{
            const [rows]=await c.query(`SELECT estado,codigo_erro,COUNT(*) n,
                SUM(estado='PROCESSANDO' AND execucao_ate<=?) vencidas,
                SUM(proxima_tentativa_em IS NOT NULL) agendadas,
                MAX(DATE_FORMAT(atualizado_em,'%Y-%m-%dT%H:%i:%s.%fZ')) ultimo FROM ist_loja_pagamento_eventos
                WHERE provedor=? AND ambiente=? AND conta_recebedora=? AND ${filtro} GROUP BY estado,codigo_erro`,[instante(),...chave]);
            const r={pendentes:0,processando:0,reservasVencidas:0,reagendados:0,esgotados:0,revisao:0,erros:{},ultimosErros:{}};
            for(const x of rows){
                if(x.estado==='RECEBIDO')r.pendentes+=Number(x.n);
                if(x.estado==='PROCESSANDO')r.processando+=Number(x.n);
                if(x.estado==='REVISAO')r.revisao+=Number(x.n);
                if(x.codigo_erro==='D9_LIMITE')r.esgotados+=Number(x.n);
                r.reservasVencidas+=Number(x.vencidas);r.reagendados+=Number(x.agendadas);
                if(x.codigo_erro){const k=['D9_AUTENTICACAO',...repetiveis,'D9_LIMITE','D9_CONTRATO_INVALIDO'].includes(x.codigo_erro)?x.codigo_erro:'REVISAO';
                    r.erros[k]=(r.erros[k]??0)+Number(x.n);
                    if(!r.ultimosErros[k]||x.ultimo>r.ultimosErros[k])r.ultimosErros[k]=x.ultimo;}
            }return r;
        }finally{c.release();}
    };
    return Object.freeze({processar,diagnosticar,reservar,registrarFalha});
};
