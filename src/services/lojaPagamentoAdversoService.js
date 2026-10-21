import { createHash } from 'node:crypto';
import { atualizarPagamentoRegistro, inserirPagamentoRegistro } from './lojaPagamentoPersistencia.js';
import { validarTransicaoPagamento, sqlUtcPagamento, classificarFalhaPagamento } from './lojaPagamentoContratos.js';
import { idAdverso, centavosAdversos, validarEvidenciaAdversa } from './lojaPagamentoAdversoContratos.js';
import { suspenderDireitosFinanceirosNaConexao, confirmarSuspensaoFinanceiraNaConexao } from './lojaDownloadDireitosService.js';

const erro = codigo => Object.assign(new Error('Evidencia financeira requer verificacao.'), { codigo });
const destruir = c => { try { c.destroy(); } catch {} };
const ler = s => {
    if (typeof s !== 'string' || Buffer.byteLength(s, 'utf8') > 16384) throw erro('EVIDENCIA_INVALIDA');
    try { return JSON.parse(s); } catch { throw erro('EVIDENCIA_INVALIDA'); }
};
const digest = id => `D8-B2-${createHash('sha256').update(id).digest('hex')}`;
const identidadeReembolso = id => `D8-REFUND-${createHash('sha256').update(id).digest('hex')}`;
const conferirContexto = (r, ctx) => r.provedor === ctx.provedor && r.ambiente === ctx.ambiente
    && r.conta_recebedora === ctx.contaRecebedora;

// Fachada interna explicita. Sem HTTP, timer ou escrita durante importacao.
// Compartilha o pool existente; direitos sao suspensos na mesma transacao.
export const criarLojaPagamentoAdversoService = ({ db, adaptador, contexto, agora }) => {
    const exigirReserva=(atual,e)=>{
        if(e.signal?.aborted)throw erro('D9_CANCELADO');
        if(atual.estado==='PROCESSADO')return; // Somente confirmacao duravel, sem efeitos.
        if(e.execucaoToken||atual.estado==='PROCESSANDO'){
            if(atual.estado!=='PROCESSANDO'||!Buffer.isBuffer(e.execucaoToken)
                ||!Buffer.isBuffer(atual.execucao_token)||!atual.execucao_token.equals(e.execucaoToken)
                ||typeof atual.execucao_prazo!=='string'
                ||atual.execucao_prazo<=sqlUtcPagamento(agora().toISOString())+'000')throw erro('D9_RESERVA_PERDIDA');
        }
    };
    const falhaConsulta=(e,falha)=>{
        if(e.execucaoToken){
            const c=classificarFalhaPagamento(falha).categoria;
            throw erro(c==='AUTENTICACAO'?'D9_AUTENTICACAO':c==='RESPOSTA_INVALIDA'||c==='VALIDACAO_LOCAL'?'D9_CONTRATO_INVALIDO':'D9_TRANSITORIO');
        }
        return revisarSemEfeito(e,'D8_CONSULTA_INDISPONIVEL');
    };
    const chave = eventoId => [contexto.provedor, contexto.ambiente, contexto.contaRecebedora, eventoId];
    const conexao = async () => {
        let c;
        try {
            c = await db.getConnection();
            const [[s]] = await c.query('SELECT @@in_transaction tx,@@autocommit ac');
            if (Number(s?.tx) !== 0 || Number(s?.ac) !== 1) throw erro('CONEXAO_INVALIDA');
            await c.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED'); return c;
        } catch { if(c)destruir(c); throw erro('CONEXAO_INVALIDA'); }
    };
    const observarEvento = async (eventoId,origem='WEBHOOK') => {
        const c = await conexao();
        try {
            const [[e]] = await c.query(`SELECT *,DATE_FORMAT(execucao_ate,'%Y-%m-%d %H:%i:%s.%f') execucao_prazo FROM ist_loja_pagamento_eventos
                WHERE provedor=? AND ambiente=? AND conta_recebedora=? AND origem=? AND evento_id=?`, [...chave(eventoId).slice(0,3),origem,eventoId]);
            if (!e || !e.autenticado_em || !Buffer.isBuffer(e.conteudo_hash) || e.conteudo_hash.length !== 32) throw erro('EVENTO_AUSENTE');
            const n = ler(e.evidencia_json);
            if (n.contrato !== (origem==='WEBHOOK'?'PAYPAL_EVENTO_POS_CAPTURA_V1':'PAYPAL_OBSERVACAO_POS_CAPTURA_V1') || n.eventoId !== eventoId || n.tipo !== e.tipo
                || n.contexto?.provedor !== contexto.provedor || n.contexto.ambiente !== contexto.ambiente
                || n.contexto.contaRecebedora !== contexto.contaRecebedora) throw erro('EVENTO_INVALIDO');
            return { e, n };
        } finally { c.release(); }
    };
    const revisarSemEfeito = async (e, motivo, classificacao = 'INCOMPLETA') => {
        let c, tx = false, commit = false;
        try {
            c = await conexao(); await c.beginTransaction(); tx = true;
            const [[atual]] = await c.query("SELECT *,DATE_FORMAT(execucao_ate,'%Y-%m-%d %H:%i:%s.%f') execucao_prazo FROM ist_loja_pagamento_eventos WHERE id=? FOR UPDATE", [e.id]);
            if (!atual?.conteudo_hash.equals(e.conteudo_hash)||atual.evidencia_json!==e.evidencia_json
                ||atual.evento_id!==e.evento_id||atual.tipo!==e.tipo||atual.origem!==e.origem||!conferirContexto(atual,contexto)) throw erro('EVENTO_DIVERGENTE');
            exigirReserva(atual,e);
            if (atual.estado !== 'PROCESSADO') {
                const [r] = await c.query(`UPDATE ist_loja_pagamento_eventos SET estado='REVISAO',codigo_erro=?,atualizado_em=?,
                    execucao_token=NULL,execucao_ate=NULL,proxima_tentativa_em=NULL
                    WHERE id=? AND estado=?`, [motivo, sqlUtcPagamento(agora().toISOString()), e.id, atual.estado]);
                if (r.affectedRows !== 1 || r.warningStatus) throw erro('ERRO_PERSISTENCIA');
            }
            commit = true; await c.commit(); tx = false;
            return { eventoId: e.evento_id, classificacao, efeitoFinanceiroAplicado: false };
        } catch (falha) {
            if (commit) { destruir(c); c = null; throw erro('RESULTADO_DESCONHECIDO'); }
            if (c && tx) try { await c.rollback(); } catch { destruir(c); c = null; }
            throw erro(falha.codigo ?? 'ERRO_PERSISTENCIA');
        } finally { c?.release(); }
    };
    const localizar = async (capturaId,pagamentoId=null) => {
        const c = await conexao();
        try {
            const [ps] = await c.query(`SELECT p.id,p.pedido_id,p.versao,p.captura_externa_id,p.ordem_externa_id,
                CAST(p.capturado_centavos AS CHAR) capturado_centavos,d.sessao_id,d.versao pedido_versao
                FROM ist_loja_pagamentos p JOIN ist_loja_pedidos d ON d.id=p.pedido_id
                WHERE p.provedor=? AND p.ambiente=? AND p.conta_recebedora=? AND ${pagamentoId===null?'p.captura_externa_id':'p.id'}=? LIMIT 2`,
            [...chave(null).slice(0, 3), pagamentoId??capturaId]);
            return ps.length === 1 ? ps[0] : null;
        } finally { c.release(); }
    };
    const bloquearFinanceiro=async(c,e,pgInicial)=>{
            // Mesma ordem D6/D7; nunca adquirir sessao recuperada a partir daqui.
            const [[s]] = await c.query('SELECT id FROM ist_loja_sessoes WHERE id=? FOR UPDATE', [pgInicial.sessao_id]);
            const [[pedido]] = await c.query(`SELECT id,sessao_id,estado,versao,motivo_revisao,
                DATE_FORMAT(atualizado_em,'%Y-%m-%dT%H:%i:%s.%fZ') atualizado_em FROM ist_loja_pedidos WHERE id=? FOR UPDATE`, [pgInicial.pedido_id]);
            const [ps] = await c.query(`SELECT *,CAST(capturado_centavos AS CHAR) capturado_centavos,
                CAST(reembolsado_centavos AS CHAR) reembolsado_centavos,
                DATE_FORMAT(atualizado_em,'%Y-%m-%dT%H:%i:%s.%fZ') atualizado_em
                FROM ist_loja_pagamentos WHERE pedido_id=? ORDER BY id FOR UPDATE`, [pgInicial.pedido_id]);
            await c.query('SELECT id FROM ist_loja_pagamento_operacoes WHERE pedido_id=? ORDER BY id FOR UPDATE', [pgInicial.pedido_id]);
            const [eventos] = await c.query(`SELECT *,DATE_FORMAT(execucao_ate,'%Y-%m-%d %H:%i:%s.%f') execucao_prazo FROM ist_loja_pagamento_eventos
                WHERE pagamento_id IN (SELECT id FROM ist_loja_pagamentos WHERE pedido_id=?) OR id=? ORDER BY id FOR UPDATE`, [pgInicial.pedido_id, e.id]);
            const original = eventos.find(x => x.id === e.id), pg = ps.find(x => x.id === pgInicial.id);
            if (!s || !pedido || pedido.sessao_id !== s.id || !pg || !conferirContexto(pg, contexto)
                || !original || !conferirContexto(original, contexto) || !original.conteudo_hash.equals(e.conteudo_hash)
                || original.evidencia_json!==e.evidencia_json || original.tipo!==e.tipo || original.evento_id!==e.evento_id
                || original.origem!==e.origem
                || (original.pagamento_id !== null && original.pagamento_id !== pg.id)) throw erro('CONTEXTO_DIVERGENTE');
            return {pedido,pg,eventos,original};
    };
    const confirmar=async(e,pgInicial,efeitos=[])=>{
        let c,tx=false,commit=false;
        try{
            c=await conexao();await c.beginTransaction();tx=true;
            const {pg,eventos,original}=await bloquearFinanceiro(c,e,pgInicial);
            const d=eventos.find(x=>x.evento_id===digest(e.evento_id)&&x.origem==='RECONCILIACAO'&&conferirContexto(x,contexto));
            if(original.estado!=='PROCESSADO'||!d)throw erro('RESULTADO_DESCONHECIDO');
            const f=validarEvidenciaAdversa(ler(d.evidencia_json),pg,contexto);
            if(f.eventoOrigem!==e.evento_id||f.hashOrigem!==e.conteudo_hash.toString('hex'))throw erro('RESULTADO_DESCONHECIDO');
            await confirmarSuspensaoFinanceiraNaConexao(c,pg.pedido_id,efeitos);
            commit=true;await c.commit();tx=false;
            return {eventoId:e.evento_id,classificacao:f.classificacao,reconciliado:true,transicoes:efeitos};
        }catch(falha){
            if(commit){destruir(c);c=null;throw erro('RESULTADO_DESCONHECIDO');}
            if(c&&tx)try{await c.rollback();}catch{destruir(c);c=null;}
            throw erro(falha.codigo??'RESULTADO_DESCONHECIDO');
        }finally{c?.release();}
    };
    const aplicar = async (e, pgInicial, fatoInicial) => {
        let c, tx = false, commit = false, efeitos=[];
        const derivadoId = digest(e.evento_id);
        try {
            c = await conexao(); await c.beginTransaction(); tx = true;
            const {pedido,pg,eventos,original}=await bloquearFinanceiro(c,e,pgInicial);
            if (original.estado === 'PROCESSADO') {
                const d = eventos.find(x => x.evento_id === derivadoId && x.origem === 'RECONCILIACAO' && conferirContexto(x, contexto));
                if (!d) throw erro('HISTORICO_DIVERGENTE');
                const f = validarEvidenciaAdversa(ler(d.evidencia_json), pg, contexto);
                await confirmarSuspensaoFinanceiraNaConexao(c,pg.pedido_id);
                commit = true; await c.commit(); tx = false;
                return { eventoId: e.evento_id, classificacao: f.classificacao, duplicado: true };
            }
            exigirReserva(original,e);
            if (pg.versao !== pgInicial.versao || pedido.versao !== pgInicial.pedido_versao
                || pg.captura_externa_id !== pgInicial.captura_externa_id || pg.ordem_externa_id !== pgInicial.ordem_externa_id
                || pg.capturado_centavos !== pgInicial.capturado_centavos) throw erro('EVIDENCIA_DESATUALIZADA');
            const fato = { ...fatoInicial }, reembolsos = new Map();
            for (const ev of eventos.filter(x => x.pagamento_id === pg.id && x.tipo === 'REEMBOLSO_COMPROVADO' && x.origem === 'RECONCILIACAO')) {
                if (!conferirContexto(ev, contexto)) throw erro('HISTORICO_DIVERGENTE');
                const f = validarEvidenciaAdversa(ler(ev.evidencia_json), pg, contexto);
                if (f.classificacao === 'REEMBOLSO_CONFIRMADO') {
                    if (reembolsos.has(f.recursoId) && reembolsos.get(f.recursoId) !== f.valorCentavos) throw erro('HISTORICO_DIVERGENTE');
                    reembolsos.set(f.recursoId, f.valorCentavos);
                }
            }
            let somaAnterior = 0n; for (const v of reembolsos.values()) somaAnterior += BigInt(v);
            let canonico = null;
            if (fato.classificacao === 'REEMBOLSO_CONFIRMADO') {
                // Fato imutavel global por recurso/contexto. A UNIQUE existente
                // impede contabilizar o mesmo refund em dois pagamentos.
                [[canonico]] = await c.query(`SELECT pagamento_id,evidencia_json FROM ist_loja_pagamento_eventos
                    WHERE provedor=? AND ambiente=? AND conta_recebedora=? AND origem='RECONCILIACAO' AND evento_id=?`,
                chave(identidadeReembolso(fato.recursoId)));
                if (canonico && (canonico.pagamento_id !== pg.id
                    || ler(canonico.evidencia_json).valorCentavos !== fato.valorCentavos)) fato.classificacao = 'CONTRADITORIA';
                const anterior = reembolsos.get(fato.recursoId);
                if ((anterior !== undefined && anterior !== fato.valorCentavos)
                    || !centavosAdversos(pg.reembolsado_centavos) || BigInt(pg.reembolsado_centavos) !== somaAnterior) fato.classificacao = 'CONTRADITORIA';
            }
            let soma = somaAnterior;
            if (fato.classificacao === 'REEMBOLSO_CONFIRMADO') {
                reembolsos.set(fato.recursoId, fato.valorCentavos); soma = 0n;
                for (const v of reembolsos.values()) soma += BigInt(v);
                if (!centavosAdversos(pg.capturado_centavos) || soma > BigInt(pg.capturado_centavos)
                    || !['CAPTURADO','PARCIALMENTE_REEMBOLSADO','REEMBOLSADO','REVISAO'].includes(pg.estado)) fato.classificacao = 'CONTRADITORIA';
            }
            const instante = agora().toISOString(), ctx = { c, instante };
            // DATE_FORMAT possui microssegundos; helper comum usa milissegundos.
            pg.atualizado_em = pg.atualizado_em.replace(/(\.\d{3})000Z$/, '$1Z');
            pedido.atualizado_em = pedido.atualizado_em.replace(/(\.\d{3})000Z$/, '$1Z');
            if (fato.classificacao === 'REEMBOLSO_CONFIRMADO') {
                const estado = pg.estado === 'REVISAO' || pedido.estado === 'REVISAO' ? 'REVISAO'
                    : soma === BigInt(pg.capturado_centavos) ? 'REEMBOLSADO' : 'PARCIALMENTE_REEMBOLSADO';
                validarTransicaoPagamento(pg.estado, estado);
                if (pg.estado !== estado || BigInt(pg.reembolsado_centavos) !== soma) await atualizarPagamentoRegistro(ctx,
                    'ist_loja_pagamentos', pg, { estado, reembolsado_centavos: String(soma) });
                if (pedido.estado !== estado) await atualizarPagamentoRegistro(ctx, 'ist_loja_pedidos', pedido, { estado });
            } else {
                validarTransicaoPagamento(pg.estado, 'REVISAO');
                if (pg.estado !== 'REVISAO') await atualizarPagamentoRegistro(ctx, 'ist_loja_pagamentos', pg,
                    { estado: 'REVISAO', motivo_revisao: 'EVIDENCIA_POS_CAPTURA' });
                if (pedido.estado !== 'REVISAO') await atualizarPagamentoRegistro(ctx, 'ist_loja_pedidos', pedido,
                    { estado: 'REVISAO', motivo_revisao: 'EVIDENCIA_POS_CAPTURA' });
            }
            validarEvidenciaAdversa(fato, pg, contexto);
            const evidencia = JSON.stringify(fato);
            if (Buffer.byteLength(evidencia, 'utf8') > 16384) throw erro('EVIDENCIA_EXCESSIVA');
            const registro = {
                pagamento_id: pg.id, provedor: contexto.provedor, ambiente: contexto.ambiente, conta_recebedora: contexto.contaRecebedora,
                origem: 'RECONCILIACAO', evento_id: derivadoId, tipo: 'EVIDENCIA_ADVERSA', recurso_externo_id: fato.recursoId,
                conteudo_hash: createHash('sha256').update(evidencia).digest(), evidencia_json: evidencia,
                estado: 'PROCESSADO', recebido_em: instante, autenticado_em: instante, atualizado_em: instante, processado_em: instante
            };
            if (fato.classificacao === 'REEMBOLSO_CONFIRMADO' && !canonico) await inserirPagamentoRegistro(ctx, 'ist_loja_pagamento_eventos', {
                ...registro, evento_id: identidadeReembolso(fato.recursoId), tipo: 'REEMBOLSO_COMPROVADO'
            });
            await inserirPagamentoRegistro(ctx, 'ist_loja_pagamento_eventos', registro);
            const [r] = await c.query(`UPDATE ist_loja_pagamento_eventos SET pagamento_id=?,estado='PROCESSADO',codigo_erro=NULL,
                execucao_token=NULL,execucao_ate=NULL,proxima_tentativa_em=NULL,
                atualizado_em=?,processado_em=? WHERE id=? AND estado=? AND conteudo_hash=?`,
            [pg.id, sqlUtcPagamento(instante), sqlUtcPagamento(instante), e.id, original.estado, e.conteudo_hash]);
            if (r.affectedRows !== 1 || r.warningStatus) throw erro('ERRO_PERSISTENCIA');
            const suspensao=await suspenderDireitosFinanceirosNaConexao(c,pg.pedido_id,contexto,new Date(instante));
            efeitos=suspensao.transicoes;
            exigirReserva(original,e); // Expiracao/cancelamento durante SQL reverte tudo.
            commit = true; await c.commit(); tx = false;
            return { eventoId: e.evento_id, classificacao: fato.classificacao, reembolsadoCentavos: pg.reembolsado_centavos,transicoes:efeitos };
        } catch (falha) {
            if (commit) {
                destruir(c); c = null;
                try{return await confirmar(e,pgInicial,efeitos);}catch{throw erro('RESULTADO_DESCONHECIDO');}
            }
            if (c && tx) try { await c.rollback(); } catch { destruir(c); c = null; throw erro('RESULTADO_DESCONHECIDO'); }
            throw erro(falha.codigo ?? 'ERRO_PERSISTENCIA');
        } finally { c?.release(); }
    };
    const reconciliarEventoAdverso = async ({ eventoId, execucaoToken, signal,origem='WEBHOOK' } = {}) => {
        if (!['WEBHOOK','API'].includes(origem)||!idAdverso(eventoId)||(execucaoToken!==undefined&&(!Buffer.isBuffer(execucaoToken)||execucaoToken.length!==16))) throw erro('SOLICITACAO_INVALIDA');
        const { e, n } = await observarEvento(eventoId,origem);
        e.execucaoToken=execucaoToken;e.signal=signal;exigirReserva(e,e);
        if(e.estado==='IGNORADO')return {eventoId,duplicado:true,estado:e.estado};
        if(e.estado==='PROCESSADO'){
            const pg=await localizar(null,e.pagamento_id);
            if(!pg)throw erro('RESULTADO_DESCONHECIDO');
            return {...await confirmar(e,pg),duplicado:true,estado:e.estado};
        }
        if (typeof adaptador.consultarEvidenciaAdversa !== 'function') throw erro('CONFIGURACAO_INVALIDA');
        const tipo = n.reembolsoId ? 'REEMBOLSO' : n.disputaId ? 'DISPUTA' : null;
        if (!tipo || n.correlacao === 'CONTRADITORIA' || n.vinculoInvalido || n.transacoesExcedemLimite) return revisarSemEfeito(e, 'D8_RECURSO_NAO_COMPROVADO');
        let recurso;
        try { recurso = await adaptador.consultarEvidenciaAdversa({ tipo, recursoId: n.recursoId, ambiente: contexto.ambiente,signal }); }
        catch(falha) { return falhaConsulta(e,falha); }
        if (recurso?.tipo !== tipo || recurso.recursoId !== n.recursoId || recurso.vinculoInvalido) return revisarSemEfeito(e, 'D8_EVIDENCIA_CONTRADITORIA', 'CONTRADITORIA');
        // Seller transaction ID e somente candidato; a captura ainda sera
        // consultada e comparada com o pagamento local e o contexto confiavel.
        if(tipo==='DISPUTA'&&[recurso,n.detalhesDisputa].filter(Boolean).some(d=>
            d.identidadeRecebedorInvalida||d.movimentosInvalidos
            ||(d.contaRecebedora!=null&&d.contaRecebedora!==contexto.contaRecebedora)))
            return revisarSemEfeito(e,'D8_EVIDENCIA_CONTRADITORIA','CONTRADITORIA');
        const capturaId = tipo === 'REEMBOLSO' ? recurso.capturaId
            : recurso.transacoesVendedor?.length === 1 ? recurso.transacoesVendedor[0] : null;
        if (!idAdverso(capturaId) || (n.capturaId && n.capturaId !== capturaId)
            || (tipo === 'DISPUTA' && n.transacoesVendedor?.length && !n.transacoesVendedor.includes(capturaId))) return revisarSemEfeito(e, 'D8_EVIDENCIA_CONTRADITORIA', 'CONTRADITORIA');
        const pg = await localizar(capturaId);
        if (!pg || (e.pagamento_id !== null && e.pagamento_id !== pg.id)) return revisarSemEfeito(e, 'D8_SEM_CORRELACAO');
        let captura;
        try { captura = await adaptador.consultarEvidenciaAdversa({ tipo: 'CAPTURA', recursoId: capturaId, ambiente: contexto.ambiente,signal }); }
        catch(falha) { return falhaConsulta(e,falha); }
        let classificacao = 'INCOMPLETA';
        const divergente = captura?.tipo !== 'CAPTURA' || captura.recursoId !== capturaId
            || (captura.contaRecebedora !== null && captura.contaRecebedora !== contexto.contaRecebedora)
            || (captura.ordemId !== null && captura.ordemId !== pg.ordem_externa_id)
            || (captura.moeda !== null && captura.moeda !== 'BRL')
            || (captura.valorCentavos !== null && captura.valorCentavos !== pg.capturado_centavos)
            || (recurso.moeda !== null && recurso.moeda !== 'BRL')
            || (tipo==='DISPUTA'&&(recurso.movimentos??[]).some(m=>m.moeda!==null&&m.moeda!=='BRL'))
            || (n.moeda !== null && recurso.moeda !== null && n.moeda !== recurso.moeda)
            || (n.valorCentavos !== null && recurso.valorCentavos !== null && n.valorCentavos !== recurso.valorCentavos);
        const completa = captura?.contaRecebedora === contexto.contaRecebedora && captura.ordemId === pg.ordem_externa_id
            && captura.moeda === 'BRL' && captura.valorCentavos === pg.capturado_centavos
            && ['COMPLETED','REFUNDED','PARTIALLY_REFUNDED'].includes(captura.estado);
        if (divergente) classificacao = 'CONTRADITORIA';
        else if (completa && tipo === 'REEMBOLSO' && recurso.estado === 'COMPLETED'
            && recurso.moeda === 'BRL' && centavosAdversos(recurso.valorCentavos) && BigInt(recurso.valorCentavos) > 0n) classificacao = 'REEMBOLSO_CONFIRMADO';
        else if (completa && tipo === 'DISPUTA' && ['OPEN','WAITING_FOR_BUYER_RESPONSE','WAITING_FOR_SELLER_RESPONSE',
            'UNDER_REVIEW','RESOLVED','OTHER'].includes(recurso.estado)) classificacao = recurso.estado === 'RESOLVED' ? 'DISPUTA_ENCERRADA' : 'RISCO_DISPUTA';
        const fato = { contrato: 'IST_EVIDENCIA_ADVERSA_V1', eventoOrigem: eventoId, hashOrigem: e.conteudo_hash.toString('hex'),
            contexto: { ...contexto }, tipo, recursoId: recurso.recursoId, capturaId, classificacao,
            valorCentavos: recurso.valorCentavos, moeda: recurso.moeda, estadoRecurso: recurso.estado,
            desfechoDisputa: recurso.desfecho ?? null,origemObservacao:e.origem,
            ...(tipo==='DISPUTA'?{detalhesDisputa:{estagio:recurso.estagio??null,canal:recurso.canal??null,
                estadoTransacao:recurso.estadoTransacao??null,contaRecebedora:recurso.contaRecebedora??null,
                movimentos:recurso.movimentos??[],identidadeEconomica:'NAO_COMPROVADA'}}:{}) };
        return aplicar(e, pg, fato);
    };
    return Object.freeze({ reconciliarEventoAdverso });
};
