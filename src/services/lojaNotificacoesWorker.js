import {randomBytes} from 'node:crypto';
import {criarCompositorConfirmacaoCompra} from './lojaNotificacoesMensagem.js';

const erro=()=>Error('NOTIFICACOES_INDISPONIVEIS');
const data=ms=>new Date(ms).toISOString().slice(0,23).replace('T',' ');
export const criarProcessadorNotificacoes=({db,enviar,ambiente,agora=Date.now,timeoutMs=20000,reservaMs=60000,origemPublica,comporMensagem}={})=>{
    if(!db?.getConnection||typeof enviar!=='function'||ambiente!=='sandbox'||typeof agora!=='function'
        ||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000
        ||!Number.isInteger(reservaMs)||reservaMs<timeoutMs+1000||reservaMs>300000)throw erro();
    const compor=comporMensagem??criarCompositorConfirmacaoCompra({origemPublica,ambiente});
    if(typeof compor!=='function')throw erro();
    const transacao=async(fn,somenteLeitura=false)=>{
        let c,iniciada=false,commit=false,timer,expirou=false;
        const query=(sql,args)=>c.query({sql,timeout:5000},args);
        try{
            const aquisicao=Promise.resolve().then(()=>db.getConnection()).then(conexao=>{
                if(expirou){conexao.release();throw erro();}return conexao;
            });
            try{c=await Promise.race([aquisicao,new Promise((_,j)=>{timer=setTimeout(()=>{expirou=true;j(erro());},5000);})]);}
            finally{clearTimeout(timer);}
            const [[s]]=await query('SELECT @@in_transaction tx,@@autocommit ac');
            if(Number(s.tx)!==0||Number(s.ac)!==1)throw erro();
            await query(somenteLeitura?'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ':'SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
            await query(somenteLeitura?'START TRANSACTION READ ONLY':'START TRANSACTION READ WRITE');iniciada=true;
            const r=await fn({query});commit=true;await query('COMMIT');return r;
        }catch{
            if(c){if(commit||!iniciada){c.destroy();c=null;}else try{await query('ROLLBACK');}catch{c.destroy();c=null;}}
            throw erro();
        }finally{c?.release();}
    };
    const reservar=()=>transacao(async c=>{
        const instante=agora(),hoje=data(instante);
        const [[n]]=await c.query(`SELECT n.*,(SELECT p.public_id FROM ist_loja_pedidos p WHERE p.id=n.pedido_id) AS pedido_public_id
            FROM ist_loja_notificacoes n WHERE ambiente=? AND finalidade='CONFIRMACAO_COMPRA'
            AND ((estado='PROCESSANDO' AND reserva_ate<=?) OR (estado IN ('PENDENTE','FALHA') AND tentativas<5
                AND proxima_tentativa_em IS NOT NULL AND proxima_tentativa_em<=?)) ORDER BY id LIMIT 1 FOR UPDATE`,[ambiente,hoje,hoje]);
        if(!n)return null;
        if(n.estado==='PROCESSANDO'){
            await c.query(`UPDATE ist_loja_notificacoes SET estado='INCERTO',reserva_token=NULL,reserva_ate=NULL,
                proxima_tentativa_em=NULL,ultimo_erro_codigo='RESERVA_EXPIRADA',atualizado_em=? WHERE id=?`,[hoje,n.id]);
            return {expirada:true};
        }
        const token=randomBytes(32);
        const [r]=await c.query(`UPDATE ist_loja_notificacoes SET estado='PROCESSANDO',tentativas=tentativas+1,
            reserva_token=?,reserva_ate=?,processamento_em=?,atualizado_em=?,proxima_tentativa_em=NULL,
            ultimo_erro_codigo=NULL WHERE id=? AND estado=?`,[token,data(instante+reservaMs),hoje,hoje,n.id,n.estado]);
        if(r.affectedRows!==1||r.warningStatus)throw erro();
        return {...n,reserva_token:token,tentativas:Number(n.tentativas)+1};
    });
    const concluir=(n,estado,codigo)=>transacao(async c=>{
        const instante=agora(),hoje=data(instante);
        const proxima=estado==='FALHA'&&n.tentativas<5?data(instante+Math.min(3600000,60000*2**(n.tentativas-1))):null;
        const [r]=await c.query(`UPDATE ist_loja_notificacoes SET estado=?,reserva_token=NULL,reserva_ate=NULL,
            concluido_em=?,proxima_tentativa_em=?,ultimo_erro_codigo=?,atualizado_em=?
            WHERE id=? AND ambiente=? AND estado='PROCESSANDO' AND reserva_token=? AND reserva_ate>?`,
        [estado,estado==='ENVIADO'?hoje:null,proxima,codigo,hoje,n.id,ambiente,n.reserva_token,hoje]);
        if(r.warningStatus)throw erro();
        return r.affectedRows===1;
    });
    const possui= n=>transacao(async c=>{
        const [[r]]=await c.query(`SELECT id FROM ist_loja_notificacoes WHERE id=? AND ambiente=? AND estado='PROCESSANDO'
            AND reserva_token=? AND reserva_ate>? FOR UPDATE`,[n.id,ambiente,n.reserva_token,data(agora())]);
        return Boolean(r);
    });
    return Object.freeze({async processar({limite=10,signal}={}){
        if(!Number.isInteger(limite)||limite<1||limite>100)throw erro();
        const resumo={reservadas:0,enviadas:0,falhas:0,incertas:0,semReserva:0};
        for(let i=0;i<limite&&!signal?.aborted;i++){
            const n=await reservar();if(!n)break;
            if(n.expirada){resumo.incertas++;continue;}
            resumo.reservadas++;
            let estado='INCERTO',codigo='SMTP_INDETERMINADO',mensagem;
            try{mensagem=await transacao(c=>compor(n,c),true);}catch{estado='FALHA';codigo='MENSAGEM_INVALIDA';}
            if(mensagem){
                if(!await possui(n)){resumo.semReserva++;continue;}
                if(signal?.aborted){estado='FALHA';codigo='CANCELADO_ANTES_ENVIO';}
                else{
                    let timer,abortar;
                    try{
                        // The transport may finish after timeout: never retry that outcome.
                        const cancelada=new Promise((_,j)=>{abortar=()=>j(Error('ENVIO_CANCELADO'));signal?.addEventListener('abort',abortar,{once:true});});
                        await Promise.race([Promise.resolve().then(()=>{
                            if(signal?.aborted)throw Object.assign(Error(),{notificacaoNaoEnviada:true});
                            return enviar(mensagem);
                        }),cancelada,new Promise((_,j)=>{timer=setTimeout(()=>j(Error('ENVIO_TIMEOUT')),timeoutMs);})]);
                        estado='ENVIADO';codigo=null;
                    }catch(e){if(e?.notificacaoNaoEnviada===true){estado='FALHA';codigo='SMTP_NAO_ACEITO';}}
                    finally{clearTimeout(timer);signal?.removeEventListener('abort',abortar);}
                }
            }
            if(await concluir(n,estado,codigo))resumo[estado==='ENVIADO'?'enviadas':estado==='FALHA'?'falhas':'incertas']++;
            else resumo.semReserva++;
        }
        return resumo;
    }});
};
