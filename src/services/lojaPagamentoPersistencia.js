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
    return { transacao };
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
