import { avaliarElegibilidadeFinanceiraNaConexao } from './lojaDownloadFinanceiroService.js';

const erro = codigo => Object.assign(new Error(codigo), { codigo });
const falhar = codigo => { throw erro(codigo); };
const id = n => Number.isInteger(n) && n > 0 && n <= 4294967295;
const destruir = c => { try { c.destroy(); } catch {} };
const transitorio = e => [1205,1213].includes(e?.errno) || ['ER_LOCK_DEADLOCK','ER_LOCK_WAIT_TIMEOUT'].includes(e?.code);
const utc = d => {
    if (!(d instanceof Date) || !Number.isFinite(d.getTime()) || d.getUTCFullYear()<1000 || d.getUTCFullYear()>9999) falhar('RELOGIO_INVALIDO');
    return d.toISOString().slice(0,23).replace('T',' ');
};
const camposDireito = `id,pedido_item_id,produto_id,arquivo_versao_id,estado,versao,motivo_codigo,
    DATE_FORMAT(criado_em,'%Y-%m-%d %H:%i:%s.%f') criado_em,
    DATE_FORMAT(atualizado_em,'%Y-%m-%d %H:%i:%s.%f') atualizado_em,
    DATE_FORMAT(ativado_em,'%Y-%m-%d %H:%i:%s.%f') ativado_em,
    DATE_FORMAT(suspenso_em,'%Y-%m-%d %H:%i:%s.%f') suspenso_em,
    DATE_FORMAT(revogado_em,'%Y-%m-%d %H:%i:%s.%f') revogado_em`;
const decidir = (d,a) => {
    if (['REVOGADO','SUSPENSO'].includes(d.estado)) return null;
    if (a.classificacao==='ELEGIVEL' && a.elegivel===true) return d.estado==='AGUARDANDO_CONFIRMACAO'
        ? { estado:'ATIVO',motivo:'CAPTURA_CONFIRMADA' } : null;
    let motivo=null;
    if(a.evidenciaAdversaPersistida.length)motivo='EVIDENCIA_ADVERSA';
    else if(a.evidenciaContraditoria)motivo='EVIDENCIA_CONTRADITORIA';
    else if(a.classificacao==='REVISAO'||a.motivos.includes('REVISAO_FINANCEIRA'))motivo='REVISAO_FINANCEIRA';
    else if(d.estado==='ATIVO' && !a.elegivel)motivo='EVIDENCIA_INSUFICIENTE';
    return motivo ? {estado:'SUSPENSO',motivo} : null;
};

// Fachada D6 e integracao D8 usam avaliacao real e linhas bloqueadas.
// Nao recebe decisao financeira por HTTP, nao abre transacao e nao faz COMMIT.
const aplicarTransicoesNaConexao = async (c,avaliacao,contexto) => {
    const efeitos=[];
    for(const d of contexto.direitos){
        const ref=avaliacao.referencias.direitos.find(x=>x.id===d.id);
        if(!ref||ref.versao!==d.versao||ref.estado!==d.estado||ref.arquivoVersaoId!==d.arquivo_versao_id
            ||ref.itemId!==d.pedido_item_id||ref.produtoId!==d.produto_id)falhar('AVALIACAO_DIVERGENTE');
        const alvo=decidir(d,avaliacao);if(!alvo)continue;
        if(!id(d.versao)||d.versao===4294967295)falhar('LIMITE_VERSAO');
        const data=contexto.instante,versao=d.versao+1;
        // Nao apagar timestamps historicos nem mudar a versao de PDF adquirida.
        const [r]=await c.query(`UPDATE ist_loja_download_direitos SET estado=?,versao=versao+1,atualizado_em=?,
            ativado_em=?,suspenso_em=?,motivo_codigo=? WHERE id=? AND versao=? AND estado=? AND arquivo_versao_id=?`,
        [alvo.estado,data,alvo.estado==='ATIVO'?data:d.ativado_em,alvo.estado==='SUSPENSO'?data:d.suspenso_em,
            alvo.estado==='ATIVO'?null:alvo.motivo,d.id,d.versao,d.estado,d.arquivo_versao_id]);
        if(r.affectedRows!==1||r.warningStatus)falhar('CONFLITO_VERSAO');
        const [e]=await c.query(`INSERT INTO ist_loja_download_direito_eventos
            (direito_id,direito_versao,estado_anterior,estado_novo,origem,motivo_codigo,ocorrido_em)
            VALUES(?,?,?,?,'FINANCEIRO',?,?)`,[d.id,versao,d.estado,alvo.estado,alvo.motivo,data]);
        if(e.affectedRows!==1||e.warningStatus)falhar('ERRO_PERSISTENCIA');
        efeitos.push({direitoId:d.id,versao,anterior:d.estado,estado:alvo.estado,motivo:alvo.motivo,arquivoVersaoId:d.arquivo_versao_id});
    }
    return efeitos;
};

// Chamador ja detem sessao -> pedido -> pagamentos -> operacoes -> eventos.
// Compartilhado com a fachada D6, sem reacquirir locks anteriores da cadeia.
const bloquearDireitosNaConexao = async(c,pedidoId)=>{
    const [ids]=await c.query(`SELECT d.id FROM ist_loja_download_direitos d JOIN ist_loja_pedido_itens i ON i.id=d.pedido_item_id
        WHERE i.pedido_id=? ORDER BY d.id`,[pedidoId]);
    const direitos=[];
    for(const x of ids){
        const [[d]]=await c.query(`SELECT ${camposDireito} FROM ist_loja_download_direitos WHERE id=? FOR UPDATE`,[x.id]);
        if(!d)falhar('DIREITO_DIVERGENTE');direitos.push(d);
    }
    for(const d of direitos){
        const [eventos]=await c.query(`SELECT direito_versao,estado_novo FROM ist_loja_download_direito_eventos
            WHERE direito_id=? ORDER BY direito_versao FOR UPDATE`,[d.id]);
        if(!eventos.length||eventos.at(-1).direito_versao!==d.versao||eventos.at(-1).estado_novo!==d.estado)falhar('HISTORICO_DIREITO_INCONSISTENTE');
    }
    return direitos;
};

// Interface interna D8: conexao transacional obrigatoria. Nao aceita uma decisao
// financeira pronta; reavalia a persistencia real na mesma conexao. Nunca ativa.
export const suspenderDireitosFinanceirosNaConexao = async(c,pedidoId,esperado,instante)=>{
    const [[tx]]=await c.query('SELECT @@in_transaction transacao');
    if(Number(tx?.transacao)!==1||!id(pedidoId))falhar('TRANSACAO_INVALIDA');
    const direitos=await bloquearDireitosNaConexao(c,pedidoId);
    let falhaLeitura;
    const avaliacao=await avaliarElegibilidadeFinanceiraNaConexao({query:async(...args)=>{
        try{return await c.query(...args);}catch(e){falhaLeitura=e;throw e;}
    }},pedidoId,esperado);
    if(falhaLeitura)throw falhaLeitura;
    if(!avaliacao.referencias||avaliacao.referencias.pedidoId!==pedidoId
        ||avaliacao.referencias.direitos.length!==direitos.length)falhar('AVALIACAO_INDISPONIVEL');
    if(avaliacao.elegivel||!['ADVERSO','REVISAO','INCONSISTENTE'].includes(avaliacao.classificacao))falhar('EVIDENCIA_ADVERSA_AUSENTE');
    const data=utc(instante);
    if(direitos.some(d=>data+'000'<d.atualizado_em))falhar('RELOGIO_REGRESSIVO');
    return {avaliacao,transicoes:await aplicarTransicoesNaConexao(c,avaliacao,{direitos,instante:data})};
};

// Somente confirmacao de resultado persistido, inclusive COMMIT incerto. Nunca
// corrige historico, altera estado ou transforma prova ausente em sucesso.
export const confirmarSuspensaoFinanceiraNaConexao = async(c,pedidoId,efeitos=[])=>{
    const [[tx]]=await c.query('SELECT @@in_transaction transacao');
    if(Number(tx?.transacao)!==1||!id(pedidoId))falhar('TRANSACAO_INVALIDA');
    const direitos=await bloquearDireitosNaConexao(c,pedidoId);
    if(direitos.some(d=>!['SUSPENSO','REVOGADO'].includes(d.estado)))falhar('SUSPENSAO_NAO_CONFIRMADA');
    for(const x of efeitos){
        const d=direitos.find(d=>d.id===x.direitoId);
        const [[e]]=await c.query(`SELECT estado_anterior,estado_novo,origem,motivo_codigo
            FROM ist_loja_download_direito_eventos WHERE direito_id=? AND direito_versao=?`,[x.direitoId,x.versao]);
        if(!d||d.versao<x.versao||d.arquivo_versao_id!==x.arquivoVersaoId||!e
            ||e.estado_anterior!==x.anterior||e.estado_novo!==x.estado||e.origem!=='FINANCEIRO'||e.motivo_codigo!==x.motivo)falhar('SUSPENSAO_NAO_CONFIRMADA');
    }
};

export const criarLojaDownloadDireitosService = ({db,agora=()=>new Date()}={}) => {
    if(!db?.getConnection||typeof agora!=='function')falhar('CONFIGURACAO_INVALIDA');
    const conexaoLimpa=async()=>{
        let c=await db.getConnection();
        try{
            await c.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
            const [[s]]=await c.query('SELECT @@in_transaction transacao,@@autocommit autocommit');
            if(Number(s?.transacao)!==0||Number(s?.autocommit)!==1)falhar('CONEXAO_INVALIDA');
            return c;
        }catch(e){destruir(c);throw e;}
    };
    const bloquear=async(c,pedidoId,esperado)=>{
        // Descoberta sem lock nao constitui autorizacao; revalidada apos sessao.
        const [[descoberta]]=await c.query('SELECT sessao_id FROM ist_loja_pedidos WHERE id=?',[pedidoId]);
        if(!descoberta||!id(descoberta.sessao_id))falhar('PEDIDO_AUSENTE');
        const [[s]]=await c.query('SELECT id FROM ist_loja_sessoes WHERE id=? FOR UPDATE',[descoberta.sessao_id]);
        if(!s)falhar('PEDIDO_AUSENTE');
        // Avaliacao financeira nao depende de login ou de sessao ainda nao expirada.
        const [[p]]=await c.query('SELECT id,sessao_id,ambiente FROM ist_loja_pedidos WHERE id=? FOR UPDATE',[pedidoId]);
        if(!p||p.sessao_id!==s.id)falhar('PEDIDO_DIVERGENTE');
        if(p.ambiente!==esperado.ambiente)falhar('CONTEXTO_DIVERGENTE');
        await c.query('SELECT id FROM ist_loja_pagamentos WHERE pedido_id=? ORDER BY id FOR UPDATE',[pedidoId]);
        await c.query('SELECT id FROM ist_loja_pagamento_operacoes WHERE pedido_id=? ORDER BY id FOR UPDATE',[pedidoId]);
        const [evs]=await c.query(`SELECT e.id FROM ist_loja_pagamento_eventos e JOIN ist_loja_pagamentos p ON p.id=e.pagamento_id
            WHERE p.pedido_id=? ORDER BY e.id`,[pedidoId]);
        for(const e of evs)await c.query('SELECT id FROM ist_loja_pagamento_eventos WHERE id=? FOR UPDATE',[e.id]);
        const direitos=await bloquearDireitosNaConexao(c,pedidoId);
        return {pedido:p,direitos};
    };
    const reconciliar=async(pedidoId,esperado,efeitos,guarda)=>{
        let c,iniciada=false,commitIniciado=false;
        try{
            c=await conexaoLimpa();await c.beginTransaction();iniciada=true;
            const permitidos=await guarda(c);
            const bloqueados=await bloquear(c,pedidoId,esperado);
            for(const x of efeitos){
                const d=bloqueados.direitos.find(d=>d.id===x.direitoId);
                const [[e]]=await c.query(`SELECT estado_anterior,estado_novo,origem,motivo_codigo FROM ist_loja_download_direito_eventos
                    WHERE direito_id=? AND direito_versao=?`,[x.direitoId,x.versao]);
                if(!d||d.versao<x.versao||d.arquivo_versao_id!==x.arquivoVersaoId||!e||e.estado_anterior!==x.anterior
                    ||e.estado_novo!==x.estado||e.origem!=='FINANCEIRO'||e.motivo_codigo!==x.motivo
                    ||(d.versao===x.versao&&d.estado!==x.estado))falhar('RESULTADO_DESCONHECIDO');
            }
            const avaliacao=await avaliarElegibilidadeFinanceiraNaConexao(c,pedidoId,esperado);
            if(!avaliacao.referencias)falhar('RESULTADO_DESCONHECIDO');
            await guarda(c);
            // Retornar observacao atual; uma suspensao posterior nunca e sobrescrita.
            commitIniciado=true;await c.commit();iniciada=false;
            return {avaliacao,transicoes:efeitos,direitos:bloqueados.direitos.filter(d=>!permitidos||permitidos.has(d.id))
                .map(d=>({id:d.id,estado:d.estado,versao:d.versao})),reconciliado:true};
        }catch{if(c&&commitIniciado){destruir(c);c=null;}else if(c&&iniciada)try{await c.rollback();}catch{destruir(c);c=null;}falhar('RESULTADO_DESCONHECIDO');}
        finally{c?.release();}
    };
    const reavaliarDireitosDoPedido=async(pedidoId,contextoEsperado,{autorizarNaConexao}={})=>{
        if(!id(pedidoId)||!contextoEsperado||contextoEsperado.provedor!=='paypal'||!['sandbox','live'].includes(contextoEsperado.ambiente)
            ||typeof contextoEsperado.contaRecebedora!=='string'||!/^[A-Za-z0-9-]{1,128}$/.test(contextoEsperado.contaRecebedora))falhar('CONTEXTO_INVALIDO');
        const esperado=Object.freeze({provedor:'paypal',ambiente:contextoEsperado.ambiente,contaRecebedora:contextoEsperado.contaRecebedora});
        if(autorizarNaConexao!==undefined&&typeof autorizarNaConexao!=='function')falhar('AUTORIZACAO_INVALIDA');
        let permissao;
        // Guarda interna opcional: nunca fornecida por body/query. Primeiro lock
        // e da recuperacao, inclusive em retry e reconciliacao de COMMIT incerto.
        const guarda=async c=>{
            if(!autorizarNaConexao)return null;
            const ids=await autorizarNaConexao(c);
            if(!Array.isArray(ids)||!ids.length||ids.length>50||ids.some(n=>!id(n))||new Set(ids).size!==ids.length)falhar('AUTORIZACAO_INVALIDA');
            const assinatura=[...ids].sort((a,b)=>a-b).join(',');
            if(permissao!==undefined&&permissao!==assinatura)falhar('AUTORIZACAO_INVALIDA');
            permissao=assinatura;return new Set(ids);
        };
        for(let tentativa=1;tentativa<=3;tentativa++){
            let c,iniciada=false,commitIniciado=false,efeitos=[],avaliacao;
            try{
                c=await conexaoLimpa();await c.beginTransaction();iniciada=true;
                const permitidos=await guarda(c);
                const ctx=await bloquear(c,pedidoId,esperado);
                await guarda(c);
                // B1 sanitiza erros SQL; preservar apenas a categoria para rollback/retry.
                let falhaLeitura;
                avaliacao=await avaliarElegibilidadeFinanceiraNaConexao({query:async(...args)=>{
                    try{return await c.query(...args);}catch(e){falhaLeitura=e;throw e;}
                }},pedidoId,esperado);
                if(falhaLeitura)throw falhaLeitura;
                if(!avaliacao.referencias||avaliacao.referencias.pedidoId!==pedidoId)falhar('AVALIACAO_INDISPONIVEL');
                if(avaliacao.referencias.direitos.length!==ctx.direitos.length)falhar('AVALIACAO_DIVERGENTE');
                ctx.instante=utc(agora());
                if(ctx.direitos.some(d=>ctx.instante+'000'<d.atualizado_em))falhar('RELOGIO_REGRESSIVO');
                const direitosAlvo=ctx.direitos.filter(d=>!permitidos||permitidos.has(d.id));
                if(permitidos&&direitosAlvo.length!==permitidos.size)falhar('AUTORIZACAO_INVALIDA');
                efeitos=await aplicarTransicoesNaConexao(c,avaliacao,{...ctx,direitos:direitosAlvo});
                await guarda(c);
                commitIniciado=true;await c.commit();iniciada=false;
                return {avaliacao,transicoes:efeitos,direitos:direitosAlvo.map(d=>{
                    const x=efeitos.find(x=>x.direitoId===d.id);return {id:d.id,estado:x?.estado??d.estado,versao:x?.versao??d.versao};
                }),reconciliado:false};
            }catch(e){
                if(commitIniciado){destruir(c);c=null;return reconciliar(pedidoId,esperado,efeitos,guarda);}
                if(c&&iniciada)try{await c.rollback();}catch{destruir(c);c=null;falhar('RESULTADO_DESCONHECIDO');}
                if(transitorio(e)){if(tentativa<3)continue;falhar('CONTENCAO_TEMPORARIA');}
                if(e?.codigo)throw erro(e.codigo);falhar('ERRO_PERSISTENCIA');
            }finally{c?.release();}
        }
    };
    return Object.freeze({reavaliarDireitosDoPedido});
};
