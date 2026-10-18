import { CONTRATO_PEDIDO } from './lojaPedidoContratos.js';
import { erroPagamento, instantePagamento, sqlUtcPagamento } from './lojaPagamentoContratos.js';

const destruir = c => { try { c.destroy(); } catch { /* Nunca devolver conexao incerta. */ } };
const hidratar = r => {
    if (!r) return null;
    for (const k of Object.keys(r)) if (k.endsWith('_utc')) {
        const valor = r[k];
        r[k.slice(0, -4)] = valor === null ? null : instantePagamento(valor.replace(/(\.\d{3})000Z$/, '$1Z'));
        delete r[k];
    }
    return r;
};
const datas = colunas => colunas.map(c => `DATE_FORMAT(${c}, '%Y-%m-%dT%H:%i:%s.%fZ') AS ${c}_utc`).join(', ');
const pgDatas = ['criado_em', 'atualizado_em', 'expira_em', 'capturado_em', 'encerrado_em'];
const opDatas = ['criado_em', 'atualizado_em', 'envio_iniciado_em', 'concluido_em', 'execucao_ate', 'proxima_tentativa_em'];

// Injecao obrigatoria: sem import do pool recuperado, dotenv ou efeitos ao importar.
export const criarPersistenciaPagamento = ({ db, agora }) => {
    if (!db?.getConnection || typeof agora !== 'function') throw erroPagamento('CONFIGURACAO_INVALIDA');
    const transacao = async (referencia, fn) => {
        for (let tentativa = 1; tentativa <= 3; tentativa++) {
            let c, iniciada = false, commitIniciado = false;
            try {
                c = await db.getConnection();
                try { await c.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED'); }
                catch (e) { destruir(c); c = null; throw e; }
                iniciada = true;
                await c.beginTransaction();
                const [[s]] = await c.query(`SELECT id, revogada_em, ${datas(['criada_em', 'expira_em'])}
                    FROM ist_loja_sessoes WHERE id=? FOR UPDATE`, [referencia.sessaoId]);
                const sessao = hidratar(s);
                if (!sessao) throw erroPagamento('SESSAO_INVALIDA');
                let pedidoId = referencia.pedidoId;
                if (referencia.pagamentoPublicId) {
                    const [[p]] = await c.query('SELECT pedido_id FROM ist_loja_pagamentos WHERE public_id=?', [referencia.pagamentoPublicId]);
                    if (!p) throw erroPagamento('PEDIDO_NAO_ENCONTRADO');
                    pedidoId = p.pedido_id;
                }
                const campo = pedidoId ? 'id' : 'public_id';
                const [[p]] = await c.query(`SELECT id, public_id, sessao_id, estado, ambiente, moeda,
                    CAST(total_centavos AS CHAR) AS total_centavos, versao,
                    ${datas(['criado_em', 'atualizado_em', 'expira_em', 'pagamento_confirmado_em'])}
                    FROM ist_loja_pedidos WHERE ${campo}=? AND sessao_id=? FOR UPDATE`,
                [pedidoId ?? referencia.pedidoPublicId, sessao.id]);
                if (!p) throw erroPagamento('PEDIDO_NAO_ENCONTRADO');
                const pedido = hidratar(p);
                const [pagamentos] = await c.query(`SELECT *, CAST(valor_centavos AS CHAR) AS valor_centavos,
                    CAST(capturado_centavos AS CHAR) AS capturado_centavos, ${datas(pgDatas)}
                    FROM ist_loja_pagamentos WHERE pedido_id=? ORDER BY id FOR UPDATE`, [pedido.id]);
                const [operacoes] = await c.query(`SELECT *, ${datas(opDatas)} FROM ist_loja_pagamento_operacoes
                    WHERE pedido_id=? ORDER BY id FOR UPDATE`, [pedido.id]);
                const instante = instantePagamento(agora().toISOString());
                if (referencia.verificarSessao !== false && (sessao.revogada_em !== null
                    || sessao.criada_em > instante || sessao.expira_em <= instante
                    || Date.parse(sessao.expira_em) - Date.parse(sessao.criada_em) > CONTRATO_PEDIDO.sessaoDuracaoSegundos * 1000)) {
                    throw erroPagamento('SESSAO_INVALIDA');
                }
                const ctx = { c, sessao, pedido, pagamentos: pagamentos.map(hidratar), operacoes: operacoes.map(hidratar), instante };
                const resultado = await fn(ctx);
                commitIniciado = true;
                await c.commit();
                iniciada = false;
                return resultado;
            } catch (e) {
                if (commitIniciado) { destruir(c); c = null; throw erroPagamento('RESULTADO_DESCONHECIDO'); }
                if (c && iniciada) {
                    try { await c.rollback(); }
                    catch { destruir(c); c = null; throw erroPagamento('RESULTADO_DESCONHECIDO'); }
                }
                if (([1205, 1213].includes(e.errno) || ['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT'].includes(e.code)) && tentativa < 3) continue;
                if (e.codigo) throw e;
                if (e.code === 'ER_DUP_ENTRY' && /uq_lpg_(ordem_externa|captura_externa)/.test(e.sqlMessage ?? '')) {
                    throw Object.assign(erroPagamento('ERRO_INTERNO'), { colisaoIdentificadorExterno: true });
                }
                throw erroPagamento([1205, 1213].includes(e.errno) ? 'RESULTADO_DESCONHECIDO' : 'ERRO_INTERNO');
            } finally { if (c) c.release(); }
        }
    };
    const candidatosRecuperacao = async (contexto, limite) => {
        let c;
        try {
            c = await db.getConnection();
            const [linhas] = await c.query(`SELECT p.id AS pagamentoId, p.pedido_id AS pedidoId,
                d.sessao_id AS sessaoId, o.id AS operacaoId
                FROM ist_loja_pagamentos p JOIN ist_loja_pedidos d ON d.id=p.pedido_id
                JOIN ist_loja_pagamento_operacoes o ON o.pagamento_id=p.id AND o.pedido_id=d.id
                WHERE p.provedor=? AND p.ambiente=? AND p.conta_recebedora=? AND p.reserva_ativa=1
                AND p.estado IN ('CRIANDO','CAPTURANDO','DESCONHECIDO','PENDENTE')
                AND (o.acao='CAPTURAR' OR NOT EXISTS (SELECT 1 FROM ist_loja_pagamento_operacoes x
                    WHERE x.pagamento_id=p.id AND x.acao='CAPTURAR'))
                AND (o.codigo_erro IS NULL OR o.codigo_erro NOT IN ('RECUPERACAO_LIMITE','RECUPERACAO_SEM_ORDEM'))
                AND (o.estado='DESCONHECIDA' OR (o.estado='EM_EXECUCAO' AND o.execucao_ate<=?)
                    OR (p.estado='PENDENTE' AND o.estado='SUCESSO'))
                AND GREATEST(COALESCE(o.proxima_tentativa_em,o.atualizado_em),DATE_ADD(o.atualizado_em,INTERVAL 1 MINUTE))<=?
                ORDER BY COALESCE(o.proxima_tentativa_em,DATE_ADD(o.atualizado_em,INTERVAL 1 MINUTE)),o.id LIMIT ?`,
            [contexto.provedor, contexto.ambiente, contexto.contaRecebedora,
                sqlUtcPagamento(agora().toISOString()), sqlUtcPagamento(agora().toISOString()), limite]);
            return linhas;
        } catch { throw erroPagamento('ERRO_INTERNO'); }
        finally { if (c) c.release(); }
    };
    const contarRecuperacoes = async (ctx, pg, op) => {
        const [[r]] = await ctx.c.query(`SELECT COUNT(*) AS total FROM ist_loja_pagamento_eventos
            WHERE pagamento_id=? AND origem='INTERNO' AND tipo='RECUPERACAO_AUTOMATICA'
            AND JSON_UNQUOTE(JSON_EXTRACT(evidencia_json,'$.operacaoId'))=?`, [pg.id, String(op.id)]);
        return Number(r.total);
    };
    const localizarWebhook = async (contexto, { ordemId, capturaId }) => {
        let c;
        try {
            c = await db.getConnection();
            const [r] = await c.query(`SELECT p.id AS pagamentoId,p.pedido_id AS pedidoId,d.sessao_id AS sessaoId,
                p.ordem_externa_id,p.captura_externa_id FROM ist_loja_pagamentos p
                JOIN ist_loja_pedidos d ON d.id=p.pedido_id
                WHERE p.provedor=? AND p.ambiente=? AND p.conta_recebedora=?
                AND ((? IS NOT NULL AND p.ordem_externa_id=?) OR (? IS NOT NULL AND p.captura_externa_id=?)) LIMIT 2`,
            [contexto.provedor, contexto.ambiente, contexto.contaRecebedora, ordemId, ordemId, capturaId, capturaId]);
            if (r.length !== 1 || (ordemId && r[0].ordem_externa_id && ordemId !== r[0].ordem_externa_id)
                || (capturaId && r[0].captura_externa_id && capturaId !== r[0].captura_externa_id)) throw new Error();
            return r[0];
        } catch { throw erroPagamento('RESULTADO_DESCONHECIDO'); }
        finally { if (c) c.release(); }
    };
    const eventoWebhook = async (ctx, contexto, eventoId) => {
        const [[e]] = await ctx.c.query(`SELECT *, ${datas(['execucao_ate'])} FROM ist_loja_pagamento_eventos
            WHERE provedor=? AND ambiente=? AND conta_recebedora=? AND origem='WEBHOOK' AND evento_id=? FOR UPDATE`,
        [contexto.provedor, contexto.ambiente, contexto.contaRecebedora, eventoId]);
        return hidratar(e);
    };
    const atualizarWebhook = async (ctx, e, campos) => {
        const nomes = Object.keys(campos);
        if (nomes.some(k => !['estado', 'tentativas', 'execucao_token', 'execucao_ate', 'codigo_erro', 'processado_em'].includes(k))) {
            throw erroPagamento('ERRO_INTERNO');
        }
        const valores = nomes.map(k => campos[k] !== null && (k.endsWith('_em') || k === 'execucao_ate')
            ? sqlUtcPagamento(campos[k]) : campos[k]);
        // Eventos nao possuem coluna versao: row lock e token condicionam a atualizacao.
        const [r] = await ctx.c.query(`UPDATE ist_loja_pagamento_eventos SET ${nomes.map(k => `${k}=?`).join(',')},atualizado_em=?
            WHERE id=? AND estado=? AND execucao_token <=> ?`,
        [...valores, sqlUtcPagamento(ctx.instante), e.id, e.estado, e.execucao_token]);
        if (r.affectedRows !== 1 || r.warningStatus) throw erroPagamento('ERRO_INTERNO');
        Object.assign(e, campos);
    };
    return { transacao, candidatosRecuperacao, contarRecuperacoes, localizarWebhook, eventoWebhook, atualizarWebhook };
};

const camposPermitidos = {
    ist_loja_pagamentos: ['estado', 'reserva_ativa', 'encerrado_em', 'ordem_externa_id', 'captura_externa_id', 'capturado_centavos', 'capturado_em', 'motivo_revisao'],
    ist_loja_pagamento_operacoes: ['estado', 'tentativas', 'execucao_token', 'execucao_ate', 'envio_iniciado_em', 'concluido_em', 'resultado_json', 'codigo_erro', 'proxima_tentativa_em'],
    ist_loja_pedidos: ['estado', 'pagamento_confirmado_em', 'motivo_revisao']
};
export const atualizarPagamentoRegistro = async (ctx, tabela, linha, campos) => {
    const nomes = Object.keys(campos);
    if (!Object.hasOwn(camposPermitidos, tabela) || nomes.some(k => !camposPermitidos[tabela].includes(k))
        || ctx.instante < linha.atualizado_em) throw erroPagamento('ERRO_INTERNO');
    const valores = nomes.map(k => campos[k] !== null && (k.endsWith('_em') || k === 'execucao_ate')
        ? sqlUtcPagamento(campos[k]) : campos[k]);
    const [r] = await ctx.c.query(`UPDATE ${tabela} SET ${nomes.map(k => `${k}=?`).join(',')},
        atualizado_em=?, versao=versao+1 WHERE id=? AND versao=?`, [...valores, sqlUtcPagamento(ctx.instante), linha.id, linha.versao]);
    if (r.affectedRows !== 1 || r.warningStatus) throw erroPagamento('ERRO_INTERNO');
    Object.assign(linha, campos, { atualizado_em: ctx.instante, versao: linha.versao + 1 });
};

export const inserirPagamentoRegistro = async (ctx, tabela, campos) => {
    if (!['ist_loja_pagamentos', 'ist_loja_pagamento_operacoes', 'ist_loja_pagamento_eventos'].includes(tabela)) throw erroPagamento('ERRO_INTERNO');
    const nomes = Object.keys(campos);
    if (nomes.some(k => !/^[a-z_]+$/.test(k))) throw erroPagamento('ERRO_INTERNO');
    const valores = nomes.map(k => campos[k] !== null && k.endsWith('_em') ? sqlUtcPagamento(campos[k]) : campos[k]);
    const [r] = await ctx.c.query(`INSERT INTO ${tabela} (${nomes.join(',')}) VALUES (${nomes.map(() => '?').join(',')})`, valores);
    if (!r.insertId || r.warningStatus) throw erroPagamento('ERRO_INTERNO');
    return r.insertId;
};
