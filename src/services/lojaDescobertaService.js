import {randomBytes,createHash} from 'node:crypto';
import {sqlUtcPagamento,classificarFalhaPagamento} from './lojaPagamentoContratos.js';
import {fontesDescoberta,isoDescoberta,erroDescoberta as erro} from './lojaDescobertaContratos.js';

const dia=86400000;
const datas=['inicio_configurado','ultima_inicio','ultima_fim','janela_inicio','janela_fim','execucao_ate'];
const proj=datas.map(k=>`DATE_FORMAT(${k},'%Y-%m-%dT%H:%i:%s.%fZ') ${k}_iso`).join(',');
export const criarLojaDescobertaService=({db,adaptador,contexto,desde,agora=()=>new Date()}={})=>{
    const inicial=isoDescoberta(desde);
    if(!db?.getConnection||typeof adaptador?.listarObservacoesAdversas!=='function'||!inicial
        ||contexto?.provedor!=='paypal'||contexto.ambiente!=='sandbox'||!contexto.contaRecebedora)throw erro('D9_DESCOBERTA_CONFIGURACAO');
    const ctx=[contexto.provedor,contexto.ambiente,contexto.contaRecebedora];
    const confiavel=Object.freeze({provedor:contexto.provedor,ambiente:contexto.ambiente,contaRecebedora:contexto.contaRecebedora});
    const sql=v=>sqlUtcPagamento(v),hoje=()=>agora().toISOString();
    const conectar=async()=>{
        let c;try{
            c=await db.getConnection();const [[s]]=await c.query('SELECT @@in_transaction tx,@@autocommit ac');
            if(Number(s.tx)!==0||Number(s.ac)!==1)throw erro('D9_DESCOBERTA_CONEXAO');
            await c.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');return c;
        }catch{try{c?.destroy();}catch{}throw erro('D9_DESCOBERTA_CONEXAO');}
    };
    const tx=async fn=>{
        const c=await conectar();let commit=false;
        try{await c.beginTransaction();const r=await fn(c);commit=true;await c.commit();return r;}
        catch(e){if(commit){try{c.destroy();}catch{}throw erro('D9_DESCOBERTA_COMMIT_INCERTO');}
            try{await c.rollback();}catch{}throw e.codigo?e:erro('D9_DESCOBERTA_SQL');
        }finally{try{c.release();}catch{}}
    };
    const reservar=async fonte=>{
        if(!fontesDescoberta.includes(fonte))throw erro('D9_DESCOBERTA_FONTE');
        return tx(async c=>{
            const data=hoje();
            await c.query(`INSERT INTO ist_loja_descoberta_checkpoints(provedor,ambiente,conta_recebedora,fonte,estado,
                inicio_configurado,proxima_execucao,atualizado_em) VALUES(?,?,?,?,'PRONTO',?,?,?)
                ON DUPLICATE KEY UPDATE id=id`,[...ctx,fonte,sql(inicial),sql(data),sql(data)]);
            const [[r]]=await c.query(`SELECT *,${proj} FROM ist_loja_descoberta_checkpoints
                WHERE provedor=? AND ambiente=? AND conta_recebedora=? AND fonte=? FOR UPDATE`,[...ctx,fonte]);
            if(isoDescoberta(r.inicio_configurado_iso)!==inicial)throw erro('D9_DESCOBERTA_CONFIGURACAO');
            if(r.estado==='REVISAO')return null;
            if(r.estado==='EXECUTANDO'&&isoDescoberta(r.execucao_ate_iso)>data)return null;
            const [[devida]]=await c.query('SELECT proxima_execucao<=? devida FROM ist_loja_descoberta_checkpoints WHERE id=?',[sql(data),r.id]);
            if(r.estado!=='EXECUTANDO'&&!Number(devida.devida))return null;
            if(r.tentativas>=8){
                await c.query(`UPDATE ist_loja_descoberta_checkpoints SET estado='REVISAO',execucao_token=NULL,execucao_ate=NULL,
                    codigo_erro='D9_DESCOBERTA_LIMITE',atualizado_em=? WHERE id=?`,[sql(data),r.id]);return {bloqueado:true};
            }
            const margem=fonte==='TRANSACOES'?3*3600000:120000;
            const seguro=agora().getTime()-margem,cursor=Date.parse(isoDescoberta(r.ultima_fim_iso)??inicial);
            if(cursor>=seguro)return null;
            const fim=isoDescoberta(r.janela_fim_iso)??new Date(Math.min(cursor+dia,seguro)).toISOString();
            const inicio=isoDescoberta(r.janela_inicio_iso)??new Date(Math.max(Date.parse(inicial),cursor-(fonte==='TRANSACOES'?dia:3600000))).toISOString();
            const token=randomBytes(16),prazo=new Date(agora().getTime()+300000).toISOString();
            await c.query(`UPDATE ist_loja_descoberta_checkpoints SET estado='EXECUTANDO',janela_inicio=?,janela_fim=?,
                execucao_token=?,execucao_ate=?,tentativas=tentativas+1,codigo_erro=NULL,atualizado_em=? WHERE id=?`,[sql(inicio),sql(fim),token,sql(prazo),sql(data),r.id]);
            return {id:r.id,fonte,inicio,fim,token};
        });
    };
    const exigir=async(c,job,signal)=>{
        const [[r]]=await c.query(`SELECT *,${proj} FROM ist_loja_descoberta_checkpoints
            WHERE id=? AND provedor=? AND ambiente=? AND conta_recebedora=? AND fonte=? FOR UPDATE`,[job.id,...ctx,job.fonte]);
        if(signal?.aborted||r?.estado!=='EXECUTANDO'||!r.execucao_token?.equals(job.token)
            ||isoDescoberta(r.execucao_ate_iso)<=hoje()||isoDescoberta(r.janela_inicio_iso)!==job.inicio
            ||isoDescoberta(r.janela_fim_iso)!==job.fim)throw erro('D9_DESCOBERTA_RESERVA_PERDIDA');
        return r;
    };
    const persistirPagina=async(job,observacoes,signal)=>tx(async c=>{
        await exigir(c,job,signal);
        if(!Array.isArray(observacoes)||observacoes.length>100)throw erro('D9_DESCOBERTA_CONTRATO');
        for(const o of observacoes){
            const {observacaoId,...projecao}=o;
            if(o.fonte!==job.fonte||observacaoId!==`D9-OBS-${createHash('sha256').update(JSON.stringify(projecao)).digest('hex')}`)
                throw erro('D9_DESCOBERTA_IDENTIDADE');
            if(o.notificacaoId){
                const [[existe]]=await c.query(`SELECT id FROM ist_loja_pagamento_eventos WHERE provedor=? AND ambiente=?
                    AND conta_recebedora=? AND origem='WEBHOOK' AND evento_id=?`,[...ctx,o.notificacaoId]);
                if(existe)continue;
            }
            const r=o.recurso;
            const n={contrato:'PAYPAL_OBSERVACAO_POS_CAPTURA_V1',eventoId:observacaoId,tipo:'REVISAO_FINANCEIRA',
                contexto:confiavel,origemConsulta:o.fonte,notificacaoId:o.notificacaoId,
                recursoId:r?.recursoId??o.relatorio?.transacaoId??null,reembolsoId:o.tipoRecurso==='REEMBOLSO'?r.recursoId:null,
                disputaId:o.tipoRecurso==='DISPUTA'?r.recursoId:null,capturaId:r?.capturaId??null,
                transacoesVendedor:r?.transacoesVendedor??[],transacoesExcedemLimite:false,
                vinculoInvalido:r?.vinculoInvalido??false,correlacao:'NAO_CORRELACIONADO',
                valorCentavos:r?.valorCentavos??null,moeda:r?.moeda??null,
                detalhesDisputa:o.tipoRecurso==='DISPUTA'?r:null,relatorio:o.relatorio,atualizadoEm:o.atualizadoEm,
                identidadeEconomica:'NAO_COMPROVADA'};
            let pagamentoId=null;
            if(n.reembolsoId&&n.capturaId&&!n.vinculoInvalido){
                const [ps]=await c.query(`SELECT id FROM ist_loja_pagamentos WHERE provedor=? AND ambiente=?
                    AND conta_recebedora=? AND captura_externa_id=? LIMIT 2`,[...ctx,n.capturaId]);
                if(ps.length===1){pagamentoId=ps[0].id;n.correlacao='CORRELACIONADO';}
            }
            const json=JSON.stringify(n),hash=createHash('sha256').update(json).digest();
            if(Buffer.byteLength(json)>16384)throw erro('D9_DESCOBERTA_LIMITE');
            const [[antigo]]=await c.query(`SELECT conteudo_hash FROM ist_loja_pagamento_eventos WHERE provedor=? AND ambiente=?
                AND conta_recebedora=? AND origem='API' AND evento_id=? FOR UPDATE`,[...ctx,observacaoId]);
            if(antigo){if(!antigo.conteudo_hash.equals(hash))throw erro('D9_DESCOBERTA_IDENTIDADE');continue;}
            const tratavel=Boolean(n.reembolsoId||n.disputaId),data=sql(hoje());
            await c.query(`INSERT INTO ist_loja_pagamento_eventos(pagamento_id,provedor,ambiente,conta_recebedora,origem,
                evento_id,tipo,recurso_externo_id,conteudo_hash,evidencia_json,estado,codigo_erro,recebido_em,autenticado_em,atualizado_em)
                VALUES(?,?,?,?,'API',?,'REVISAO_FINANCEIRA',?,?,?,?,?,?,?,?)`,
                [pagamentoId,...ctx,observacaoId,n.recursoId,hash,json,tratavel?'RECEBIDO':'REVISAO',
                    tratavel?null:'D9_OBSERVACAO_SEM_CORRELACAO',data,data,data]);
        }
        await exigir(c,job,signal);
    });
    const concluir=async(job,signal)=>tx(async c=>{
        await exigir(c,job,signal);
        await c.query(`UPDATE ist_loja_descoberta_checkpoints SET estado='PRONTO',ultima_inicio=janela_inicio,ultima_fim=janela_fim,
            janela_inicio=NULL,janela_fim=NULL,execucao_token=NULL,execucao_ate=NULL,tentativas=0,codigo_erro=NULL,proxima_execucao=?,atualizado_em=?
            WHERE id=?`,[sql(new Date(agora().getTime()+(job.fonte==='TRANSACOES'?dia:3600000)).toISOString()),sql(hoje()),job.id]);
    });
    const falhar=async(job,codigo)=>tx(async c=>{
        await exigir(c,job);
        const transitorio=['D9_DESCOBERTA_TRANSITORIA','D9_DESCOBERTA_CONEXAO','D9_DESCOBERTA_SQL','D9_DESCOBERTA_CANCELADA'].includes(codigo);
        const seguro=transitorio?codigo:['D9_DESCOBERTA_PERMISSAO','D9_DESCOBERTA_RETENCAO','D9_DESCOBERTA_PAGINACAO','D9_DESCOBERTA_CONTRATO','D9_DESCOBERTA_LIMITE'].includes(codigo)?codigo:'D9_DESCOBERTA_REVISAO';
        await c.query(`UPDATE ist_loja_descoberta_checkpoints SET estado=?,execucao_token=NULL,execucao_ate=NULL,
            codigo_erro=?,proxima_execucao=?,atualizado_em=? WHERE id=?`,[transitorio?'PRONTO':'REVISAO',seguro,
            sql(new Date(agora().getTime()+300000).toISOString()),sql(hoje()),job.id]);
    });
    const executar=async({fonte,signal}={})=>{
        if(signal?.aborted)return {estado:'CANCELADO'};
        let job;try{
            job=await reservar(fonte);if(!job)return {estado:'SEM_TRABALHO'};
            if(job.bloqueado)return {estado:'PENDENTE_REVISAO',codigo:'D9_DESCOBERTA_LIMITE'};
            const limite=new Date(agora());if(fonte==='TRANSACOES')limite.setUTCFullYear(limite.getUTCFullYear()-3);
            else limite.setTime(limite.getTime()-180*dia);
            if(fonte!=='NOTIFICACOES'&&Date.parse(job.inicio)<limite.getTime())throw erro('D9_DESCOBERTA_RETENCAO');
            const visitadas=new Set();let continuacao;
            for(let pagina=0;pagina<20;pagina++){
                if(signal?.aborted)throw erro('D9_DESCOBERTA_CANCELADA');
                const p=await adaptador.listarObservacoesAdversas({fonte,inicio:job.inicio,fim:job.fim,continuacao,signal});
                await persistirPagina(job,p.observacoes,signal);
                if(!p.proxima){await concluir(job,signal);return {estado:'CONCLUIDO',paginas:pagina+1};}
                if(visitadas.has(p.proxima))throw erro('D9_DESCOBERTA_PAGINACAO');
                visitadas.add(p.proxima);continuacao=p.proxima;
            }throw erro('D9_DESCOBERTA_LIMITE');
        }catch(e){
            const categoria=classificarFalhaPagamento(e).categoria;
            const codigo=categoria==='AUTENTICACAO'?'D9_DESCOBERTA_PERMISSAO':
                categoria==='INFRAESTRUTURA'?'D9_DESCOBERTA_TRANSITORIA':e.codigo??'D9_DESCOBERTA_REVISAO';
            if(job&&codigo!=='D9_DESCOBERTA_COMMIT_INCERTO'){
                try{await falhar(job,codigo);}catch{return {estado:'INDETERMINADO',codigo:'D9_DESCOBERTA_RESERVA_OU_COMMIT'};}
            }
            return {estado:'PENDENTE_REVISAO',codigo:/^D9_DESCOBERTA_[A-Z_]{1,40}$/.test(codigo)?codigo:'D9_DESCOBERTA_REVISAO'};
        }
    };
    return Object.freeze({executar,reservar,persistirPagina,concluir});
};
