import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { criarPersistenciaPagamento, inserirPagamentoRegistro as inserir, atualizarPagamentoRegistro as atualizar } from './lojaPagamentoPersistencia.js';
import { camposExatos, centavosPagamento, erroPagamento, hashPagamento, idExterno, instantePagamento,
    normalizarResultadoPagamento, normalizarReconciliacaoPagamento, criarFalhaPagamento, classificarFalhaPagamento, pagamentoPublico, uuidPagamento, validarTransicaoPagamento } from './lojaPagamentoContratos.js';

const PG = 'ist_loja_pagamentos';
const OP = 'ist_loja_pagamento_operacoes';
const fechado = p => p.reserva_ativa === null;
const finais = ['CAPTURADO', 'PARCIALMENTE_REEMBOLSADO', 'REEMBOLSADO', 'ESTORNADO', 'REVISAO'];
const falhar = codigo => { throw erroPagamento(codigo); };

/** Nucleo interno. Nenhum provider/pool padrao, HTTP, ativacao por .env ou simulador.
 * sessaoValidada tem a mesma origem confiavel do servico de pedidos (middleware).
 * Reconciliacao nesta etapa e explicita, sem scheduler ou webhook externo.
 */
export const criarLojaPagamentoService = ({ db, adaptador, contexto, agora = () => new Date(),
    timeoutMs = 5000, execucaoMs = 30000 } = {}) => {
    if (!contexto || !/^[a-z][a-z0-9_-]{0,31}$/.test(contexto.provedor)
        || !['sandbox', 'live'].includes(contexto.ambiente) || !idExterno(contexto.contaRecebedora)
        || ['criar', 'consultar', 'capturar'].some(m => typeof adaptador?.[m] !== 'function')
        || (adaptador.somenteTeste && (process.env.NODE_ENV !== 'test' || contexto.ambiente !== 'sandbox'))
        || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000
        || !Number.isInteger(execucaoMs) || execucaoMs <= timeoutMs || execucaoMs > 300000) falhar('CONFIGURACAO_INVALIDA');
    contexto = Object.freeze({ provedor: contexto.provedor, ambiente: contexto.ambiente, contaRecebedora: contexto.contaRecebedora });
    const persistencia = criarPersistenciaPagamento({ db, agora });
    const transacao = persistencia.transacao;
    const referencia = (sessao, entrada) => {
        if (!sessao || !Number.isInteger(sessao.id) || sessao.id < 1 || sessao.id > 4294967295) falhar('SESSAO_INVALIDA');
        return { sessaoId: sessao.id, ...entrada };
    };
    const achar = (ctx, id) => ctx.pagamentos.find(p => p.id === id || p.public_id === id) ?? falhar('PEDIDO_NAO_ENCONTRADO');
    const conferirContexto = p => {
        if (p.provedor !== contexto.provedor || p.ambiente !== contexto.ambiente || p.conta_recebedora !== contexto.contaRecebedora) falhar('PEDIDO_NAO_ENCONTRADO');
    };
    const conferirPedido = (ctx, permitirPago = false) => {
        if (ctx.pedido.ambiente !== contexto.ambiente || ctx.pedido.moeda !== 'BRL'
            || !['CRIADO', 'AGUARDANDO_PAGAMENTO', ...(permitirPago ? ['PAGO'] : [])].includes(ctx.pedido.estado)
            || (!permitirPago && ctx.pedido.pagamento_confirmado_em)) falhar('PEDIDO_INDISPONIVEL');
        if (ctx.pedido.expira_em <= ctx.instante) falhar('PEDIDO_EXPIRADO');
        const total = BigInt(centavosPagamento(ctx.pedido.total_centavos));
        if (total <= 0n || total > BigInt(Number.MAX_SAFE_INTEGER)) falhar('ERRO_INTERNO');
    };
    const conferirHash = (op, hash) => {
        if (!Buffer.isBuffer(op.solicitacao_hash) || op.solicitacao_hash.length !== 32
            || !timingSafeEqual(op.solicitacao_hash, hash)) falhar('CONFLITO_IDEMPOTENCIA');
    };
    const trabalho = (ctx, pg, op) => ({ referencia: { sessaoId: ctx.sessao.id, pedidoId: ctx.pedido.id }, pagamentoId: pg.id, operacaoId: op.id });
    const novoOp = async (ctx, pg, acao, chave, hash) => {
        const op = { pagamento_id: pg.id, pedido_id: ctx.pedido.id, acao, chave_idempotencia: chave,
            solicitacao_hash: hash, request_id_provedor: randomUUID(), estado: 'PREPARADA',
            criado_em: ctx.instante, atualizado_em: ctx.instante };
        op.id = await inserir(ctx, OP, op);
        return op;
    };
    const mudar = async (ctx, pg, estado, campos = {}) => {
        validarTransicaoPagamento(pg.estado, estado);
        await atualizar(ctx, PG, pg, { ...campos, estado });
    };
    const evento = async (ctx, pg, origem, tipo, evidencia) => {
        const json = JSON.stringify(evidencia);
        await inserir(ctx, 'ist_loja_pagamento_eventos', { pagamento_id: pg.id, provedor: pg.provedor,
            ambiente: pg.ambiente, conta_recebedora: pg.conta_recebedora, origem, evento_id: randomUUID(), tipo,
            recurso_externo_id: pg.ordem_externa_id, conteudo_hash: hashPagamento(evidencia), evidencia_json: json,
            estado: 'PROCESSADO', recebido_em: ctx.instante, autenticado_em: ctx.instante,
            atualizado_em: ctx.instante, processado_em: ctx.instante });
    };
    const operacaoCtx = (ctx, job, token) => {
        const pg = achar(ctx, job.pagamentoId); conferirContexto(pg);
        const op = ctx.operacoes.find(o => o.id === job.operacaoId && o.pagamento_id === pg.id);
        if (!op || (token && (op.estado !== 'EM_EXECUCAO' || !Buffer.isBuffer(op.execucao_token)
            || !timingSafeEqual(token, op.execucao_token)))) falhar('OPERACAO_EM_ANDAMENTO');
        return { pg, op };
    };
    const interno = job => ({ ...job.referencia, verificarSessao: false });
    const finalizarWebhook = async (ctx, job, token, concluido) => {
        if (!job.webhook) return;
        const e = await persistencia.eventoWebhook(ctx, contexto, job.webhook.eventoId);
        if (!e || e.estado !== 'PROCESSANDO' || !Buffer.isBuffer(e.execucao_token) || !e.execucao_token.equals(token)) {
            falhar('OPERACAO_EM_ANDAMENTO');
        }
        await persistencia.atualizarWebhook(ctx, e, { estado: concluido ? 'PROCESSADO' : 'RECEBIDO',
            execucao_token: null, execucao_ate: null, codigo_erro: concluido ? null : 'RESULTADO_DESCONHECIDO',
            processado_em: concluido ? ctx.instante : null });
    };
    const chamar = async (metodo, args) => {
        const controller = new AbortController();
        let timer;
        try {
            return await Promise.race([
                Promise.resolve().then(() => adaptador[metodo]({ ...args, signal: controller.signal })),
                new Promise((_, rejeitar) => { timer = setTimeout(() => {
                    rejeitar(criarFalhaPagamento({ categoria: 'INFRAESTRUTURA', envio: 'INDETERMINADO' })); controller.abort();
                }, timeoutMs); })
            ]);
        } finally { clearTimeout(timer); }
    };
    const argsAdaptador = (ctx, pg, op) => ({ referencia: pg.public_id, ordemId: pg.ordem_externa_id, capturaId: pg.captura_externa_id,
        requestId: op.request_id_provedor, valorCentavos: pg.valor_centavos, moeda: pg.moeda,
        ambiente: pg.ambiente, contaRecebedora: pg.conta_recebedora,
        requestIdCriacao: ctx.operacoes.find(o => o.pagamento_id === pg.id && o.acao === 'CRIAR')?.request_id_provedor ?? null,
        requestIdCaptura: ctx.operacoes.find(o => o.pagamento_id === pg.id && o.acao === 'CAPTURAR')?.request_id_provedor ?? null });
    const revisar = async (ctx, pg, op, motivo, resultado = null) => {
        await mudar(ctx, pg, 'REVISAO', { motivo_revisao: motivo });
        await atualizar(ctx, 'ist_loja_pedidos', ctx.pedido, { estado: 'REVISAO', motivo_revisao: motivo });
        await atualizar(ctx, OP, op, { estado: 'REVISAO', execucao_token: null, execucao_ate: null,
            codigo_erro: motivo, concluido_em: ctx.instante, resultado_json: resultado ? JSON.stringify(resultado) : null });
        await evento(ctx, pg, 'INTERNO', 'REVISAO_FINANCEIRA', { motivo, resultado });
        return pagamentoPublico(pg, ctx.pedido);
    };
    const marcarIncerto = async (job, token, falha, reconciliacaoExplicita = false) => transacao(interno(job), async ctx => {
        const pg = achar(ctx, job.pagamentoId);
        const op = ctx.operacoes.find(o => o.id === job.operacaoId);
        // COMMIT pode ter ocorrido: nao regredir resultado ja persistido.
        if (op?.estado !== 'EM_EXECUCAO' || !Buffer.isBuffer(op.execucao_token) || !op.execucao_token.equals(token)) {
            if (op && ['SUCESSO', 'RECUSADA', 'REVISAO'].includes(op.estado)) return pagamentoPublico(pg, ctx.pedido);
            falhar('RESULTADO_DESCONHECIDO');
        }
        if (!finais.includes(pg.estado) && !(reconciliacaoExplicita && pg.estado === 'PENDENTE')) await mudar(ctx, pg, 'DESCONHECIDO');
        await atualizar(ctx, OP, op, { estado: 'DESCONHECIDA', execucao_token: null, execucao_ate: null,
            codigo_erro: falha.categoria, proxima_tentativa_em: job.recuperacao ? op.proxima_tentativa_em : ctx.instante,
            resultado_json: JSON.stringify({ falha }) });
        await evento(ctx, pg, reconciliacaoExplicita ? 'RECONCILIACAO' : 'INTERNO', 'RESULTADO_DESCONHECIDO', { acao: op.acao, falha });
        await finalizarWebhook(ctx, job, token, false);
        return null;
    });
    const associacaoDivergente = (pg, r) => r.referencia !== pg.public_id || r.ambiente !== pg.ambiente
        || (r.contaRecebedora !== null && r.contaRecebedora !== pg.conta_recebedora)
        || (pg.ordem_externa_id && r.ordemId !== null && r.ordemId !== pg.ordem_externa_id)
        || (pg.captura_externa_id && r.capturaId !== null && r.capturaId !== pg.captura_externa_id);
    const divergencia = (pg, r) => associacaoDivergente(pg, r)
        || (r.moeda !== null && r.moeda !== pg.moeda) || (r.valorCentavos !== null && r.valorCentavos !== pg.valor_centavos);
    const pedidoDivergente = (ctx, pg) => pg.valor_centavos !== ctx.pedido.total_centavos
        || pg.moeda !== ctx.pedido.moeda || pg.ambiente !== ctx.pedido.ambiente;

    const aplicar = async (job, token, r, consulta, falha = null, observacao = null) => transacao(interno(job), async ctx => {
        const processar = async () => {
        const { pg, op } = operacaoCtx(ctx, job, token);
        const evidencia = observacao ? normalizarReconciliacaoPagamento({ resultado: r, observacao }) : r;
        // Evidencia normalizada nunca contem token, cartao ou resposta bruta.
        await evento(ctx, pg, consulta ? 'RECONCILIACAO' : 'API', r.estado, evidencia);
        if (falha) await evento(ctx, pg, 'INTERNO', 'FALHA_ADAPTADOR', { falha });
        if (observacao) {
            // Antes de gravar dinheiro observado, revalidar diagnostico E fatos.
            if (pedidoDivergente(ctx, pg)) return revisar(ctx, pg, op, 'PEDIDO_DIVERGENTE', evidencia);
            if (divergencia(pg, r)) return revisar(ctx, pg, op, 'DIVERGENCIA_FINANCEIRA', evidencia);
            if (observacao.evidencia === 'CONTRADITORIA' || observacao.validacao === 'DIVERGENTE'
                || ['INVALIDA', 'DIVERGENTE'].includes(observacao.associacaoOrdem)) {
                return revisar(ctx, pg, op, 'EVIDENCIA_RECONCILIACAO_DIVERGENTE', evidencia);
            }
            const coerente = observacao.evidencia === 'PRESENTE' && observacao.associacaoOrdem === 'CONFIRMADA'
                && observacao.validacao === 'CONSISTENTE';
            if ((r.estado === 'CAPTURADO' && !(coerente && observacao.statusCaptura === 'COMPLETED'))
                || (r.estado === 'PENDENTE' && !(coerente && observacao.statusCaptura === 'PENDING'))
                || (['RECUSADO', 'CANCELADO', 'EXPIRADO'].includes(r.estado) && !coerente)
                || (pg.estado === 'PENDENTE' && ['APROVADO', 'AGUARDANDO_APROVACAO'].includes(r.estado))) {
                r = { ...r, estado: 'DESCONHECIDO', capturadoEm: null };
            }
        }
        if (r.estado === 'CAPTURADO' && !associacaoDivergente(pg, r) && r.capturadoEm >= pg.criado_em) {
            // Mesmo um valor divergente precisa permanecer como fato observado.
            await atualizar(ctx, PG, pg, { captura_externa_id: r.capturaId, capturado_centavos: r.valorCentavos, capturado_em: r.capturadoEm });
        }
        if (pedidoDivergente(ctx, pg)) return revisar(ctx, pg, op, 'PEDIDO_DIVERGENTE', r);
        if (divergencia(pg, r)) return revisar(ctx, pg, op, 'DIVERGENCIA_FINANCEIRA', r);
        if (r.estado === 'DESCONHECIDO') {
            // IDs vem apenas da resposta normalizada da chamada injetada, vinculada
            // a referencia/ambiente e aos fatos observados acima. Ausencia nao confirma valores.
            const ids = observacao?.evidencia === 'AUSENTE' ? {} : { ...(r.ordemId ? { ordem_externa_id: r.ordemId } : {}),
                ...(r.capturaId ? { captura_externa_id: r.capturaId } : {}) };
            if (Object.keys(ids).length) await atualizar(ctx, PG, pg, ids);
            if (!finais.includes(pg.estado) && !(observacao && pg.estado === 'PENDENTE')) await mudar(ctx, pg, 'DESCONHECIDO');
            await atualizar(ctx, OP, op, { estado: 'DESCONHECIDA', execucao_token: null, execucao_ate: null,
                codigo_erro: falha?.categoria ?? 'RESULTADO_DESCONHECIDO',
                proxima_tentativa_em: job.recuperacao ? op.proxima_tentativa_em : ctx.instante,
                resultado_json: JSON.stringify(falha ? { ...evidencia, falha } : evidencia) });
            return pagamentoPublico(pg, ctx.pedido);
        }
        if (r.estado === 'CAPTURADO') {
            const outros = ctx.pagamentos.some(p => p.id !== pg.id && BigInt(p.capturado_centavos) > 0n);
            if (fechado(pg) || op.acao !== 'CAPTURAR' || !op.envio_iniciado_em || outros
                || !['CRIADO', 'AGUARDANDO_PAGAMENTO'].includes(ctx.pedido.estado)
                || ctx.pedido.expira_em <= ctx.instante || r.capturadoEm < pg.criado_em || r.capturadoEm > ctx.instante) {
                return revisar(ctx, pg, op, 'CAPTURA_TARDIA_OU_INESPERADA', evidencia);
            }
            await mudar(ctx, pg, 'CAPTURADO', { ordem_externa_id: r.ordemId, captura_externa_id: r.capturaId,
                capturado_centavos: r.valorCentavos, capturado_em: r.capturadoEm, reserva_ativa: null, encerrado_em: ctx.instante });
            await atualizar(ctx, 'ist_loja_pedidos', ctx.pedido, { estado: 'PAGO', pagamento_confirmado_em: r.capturadoEm });
        } else if (['RECUSADO', 'CANCELADO', 'EXPIRADO'].includes(r.estado)) {
            // Somente o adaptador pode declarar desfecho definitivo sem efeito pendente.
            if (r.estado === 'RECUSADO' && (BigInt(pg.capturado_centavos) !== 0n || pg.capturado_em
                || (r.capturaId && (op.acao !== 'CAPTURAR' || !op.envio_iniciado_em)))) {
                return revisar(ctx, pg, op, 'RECUSA_CONTRADITORIA', evidencia);
            }
            await mudar(ctx, pg, r.estado, { ordem_externa_id: r.ordemId,
                ...(r.estado === 'RECUSADO' && r.capturaId ? { captura_externa_id: r.capturaId } : {}),
                reserva_ativa: null, encerrado_em: ctx.instante });
        } else if (op.acao === 'CAPTURAR' && op.envio_iniciado_em && ['APROVADO', 'AGUARDANDO_APROVACAO'].includes(r.estado)) {
            // Uma consulta ainda aprovada nao prova que a captura anterior falhou.
            await mudar(ctx, pg, 'DESCONHECIDO');
            await atualizar(ctx, OP, op, { estado: 'DESCONHECIDA', execucao_token: null, execucao_ate: null,
                codigo_erro: 'RESULTADO_DESCONHECIDO', resultado_json: JSON.stringify(evidencia) });
            return pagamentoPublico(pg, ctx.pedido);
        } else {
            if (fechado(pg)) return revisar(ctx, pg, op, 'RESPOSTA_APOS_ENCERRAMENTO', evidencia);
            if (r.estado === 'PENDENTE' && (op.acao !== 'CAPTURAR' || !op.envio_iniciado_em)) return revisar(ctx, pg, op, 'CAPTURA_INESPERADA', evidencia);
            await mudar(ctx, pg, r.estado, { ordem_externa_id: r.ordemId,
                ...(r.estado === 'PENDENTE' && r.capturaId ? { captura_externa_id: r.capturaId } : {}) });
        }
        const preparada = op.acao === 'CAPTURAR' && !op.envio_iniciado_em && ['APROVADO', 'AGUARDANDO_APROVACAO'].includes(r.estado);
        await atualizar(ctx, OP, op, { estado: preparada ? 'PREPARADA' : ['RECUSADO', 'CANCELADO', 'EXPIRADO'].includes(r.estado) ? 'RECUSADA' : 'SUCESSO',
            execucao_token: null, execucao_ate: null, resultado_json: JSON.stringify(falha ? { ...evidencia, falha } : evidencia), codigo_erro: falha?.categoria ?? null,
            concluido_em: preparada ? null : ctx.instante });
        return pagamentoPublico(pg, ctx.pedido);
        };
        const dto = await processar();
        const op = ctx.operacoes.find(o => o.id === job.operacaoId);
        await finalizarWebhook(ctx, job, token, ['SUCESSO', 'RECUSADA', 'REVISAO'].includes(op.estado));
        return dto;
    });

    const executar = async (job, reconciliar = false) => {
        const etapa = await transacao(job.referencia, async ctx => {
            const { pg, op } = operacaoCtx(ctx, job);
            let eventoRecebido;
            if (job.webhook) {
                const w = job.webhook;
                if ((w.ordemId && pg.ordem_externa_id && w.ordemId !== pg.ordem_externa_id)
                    || (w.capturaId && pg.captura_externa_id && w.capturaId !== pg.captura_externa_id)) falhar('RESULTADO_DESCONHECIDO');
                eventoRecebido = await persistencia.eventoWebhook(ctx, contexto, w.eventoId);
                if (eventoRecebido && (eventoRecebido.pagamento_id !== pg.id || !eventoRecebido.conteudo_hash.equals(w.hash))) {
                    falhar('RESULTADO_DESCONHECIDO');
                }
                if (eventoRecebido?.estado === 'PROCESSADO') return { dto: pagamentoPublico(pg, ctx.pedido) };
                if (eventoRecebido?.estado === 'PROCESSANDO' && eventoRecebido.execucao_ate > ctx.instante) falhar('OPERACAO_EM_ANDAMENTO');
                if (!eventoRecebido) {
                    await inserir(ctx, 'ist_loja_pagamento_eventos', { pagamento_id: pg.id, provedor: pg.provedor,
                        ambiente: pg.ambiente, conta_recebedora: pg.conta_recebedora, origem: 'WEBHOOK', evento_id: w.eventoId,
                        tipo: w.tipo, recurso_externo_id: w.capturaId ?? w.ordemId, conteudo_hash: w.hash,
                        evidencia_json: JSON.stringify({ eventoId: w.eventoId, tipo: w.tipo, ordemId: w.ordemId, capturaId: w.capturaId }),
                        estado: 'RECEBIDO', recebido_em: ctx.instante, autenticado_em: ctx.instante, atualizado_em: ctx.instante });
                    eventoRecebido = await persistencia.eventoWebhook(ctx, contexto, w.eventoId);
                }
                if (finais.includes(pg.estado)) {
                    await persistencia.atualizarWebhook(ctx, eventoRecebido,
                        { estado: 'PROCESSADO', execucao_token: null, execucao_ate: null, processado_em: ctx.instante });
                    return { dto: pagamentoPublico(pg, ctx.pedido) };
                }
            }
            let agendamento = {};
            if (job.recuperacao) {
                const preferida = ctx.operacoes.find(o => o.pagamento_id === pg.id && o.acao === 'CAPTURAR')
                    ?? ctx.operacoes.find(o => o.pagamento_id === pg.id && o.acao === 'CRIAR');
                const prazo = new Date(Math.max(Date.parse(op.proxima_tentativa_em ?? op.atualizado_em),
                    Date.parse(op.atualizado_em) + 60000)).toISOString();
                const elegivel = op.estado === 'DESCONHECIDA' || (op.estado === 'EM_EXECUCAO' && op.execucao_ate <= ctx.instante)
                    || (pg.estado === 'PENDENTE' && op.estado === 'SUCESSO');
                if (preferida?.id !== op.id || fechado(pg) || !['CRIANDO', 'CAPTURANDO', 'DESCONHECIDO', 'PENDENTE'].includes(pg.estado)
                    || !elegivel || prazo > ctx.instante
                    || ['RECUPERACAO_LIMITE', 'RECUPERACAO_SEM_ORDEM'].includes(op.codigo_erro)) return { ignorada: true };
                const usadas = await persistencia.contarRecuperacoes(ctx, pg, op);
                if (!pg.ordem_externa_id || usadas >= 10 || op.tentativas >= 65535) {
                    const motivo = !pg.ordem_externa_id ? 'RECUPERACAO_SEM_ORDEM' : 'RECUPERACAO_LIMITE';
                    await atualizar(ctx, OP, op, { codigo_erro: motivo });
                    await evento(ctx, pg, 'INTERNO', 'RECUPERACAO_INTERVENCAO', { operacaoId: op.id, motivo });
                    return { intervencao: motivo };
                }
                agendamento = { proxima_tentativa_em: new Date(Date.parse(ctx.instante)
                    + Math.min(3600000, 60000 * 2 ** usadas)).toISOString() };
                await evento(ctx, pg, 'INTERNO', 'RECUPERACAO_AUTOMATICA', { operacaoId: op.id, numero: usadas + 1 });
            }
            if (pedidoDivergente(ctx, pg)) return { dto: await revisar(ctx, pg, op, 'PEDIDO_DIVERGENTE') };
            if (finais.includes(pg.estado) || (!reconciliar && ['SUCESSO', 'RECUSADA', 'REVISAO'].includes(op.estado))) {
                return { dto: pagamentoPublico(pg, ctx.pedido) };
            }
            if (op.estado === 'EM_EXECUCAO' && op.execucao_ate > ctx.instante) falhar('OPERACAO_EM_ANDAMENTO');
            const consulta = reconciliar || ['DESCONHECIDA', 'EM_EXECUCAO'].includes(op.estado);
            if (!consulta) conferirPedido(ctx);
            const token = randomBytes(16);
            if (eventoRecebido) {
                if (eventoRecebido.tentativas >= 65535) falhar('RESULTADO_DESCONHECIDO');
                await persistencia.atualizarWebhook(ctx, eventoRecebido, { estado: 'PROCESSANDO',
                    tentativas: eventoRecebido.tentativas + 1, execucao_token: token,
                    execucao_ate: new Date(Date.parse(ctx.instante) + execucaoMs).toISOString() });
            }
            await atualizar(ctx, OP, op, { estado: 'EM_EXECUCAO', execucao_token: token,
                execucao_ate: new Date(Date.parse(ctx.instante) + execucaoMs).toISOString(), tentativas: op.tentativas + 1,
                ...agendamento,
                ...(!consulta && op.acao === 'CRIAR' ? { envio_iniciado_em: ctx.instante } : {}) });
            return { token, consulta, acao: op.acao, args: { ...argsAdaptador(ctx, pg, op),
                ...(reconciliar ? { provedor: pg.provedor } : {}) } };
        });
        if (etapa.ignorada || etapa.intervencao) return etapa;
        if (etapa.dto) return etapa.dto;
        const { token } = etapa;
        let ultimoResultado = null;
        let ultimaObservacao = null;
        let falhaAdaptador = null;
        let aprovacaoPendente = false;
        const obter = async (metodo, args) => {
            let resposta;
            try { resposta = await chamar(metodo, args); }
            catch (e) { falhaAdaptador = { ...classificarFalhaPagamento(e), metodo }; throw e; }
            try {
                if (metodo === 'reconciliar') {
                    const envelope = normalizarReconciliacaoPagamento(resposta);
                    ultimoResultado = envelope.resultado; ultimaObservacao = envelope.observacao;
                } else ultimoResultado = normalizarResultadoPagamento(resposta);
            }
            catch (e) {
                falhaAdaptador = { categoria: 'RESPOSTA_INVALIDA', envio: 'INDETERMINADO', resultado: null, metodo };
                throw e;
            }
            return ultimoResultado;
        };
        try {
            if (reconciliar) {
                const resultado = await obter('reconciliar', etapa.args);
                return await aplicar(job, token, resultado, true, null, ultimaObservacao);
            }
            if (etapa.consulta) return await aplicar(job, token, await obter('consultar', etapa.args), true);
            if (etapa.acao === 'CRIAR') return await aplicar(job, token, await obter('criar', etapa.args), false);
            const aprovado = await obter('consultar', etapa.args);
            if (aprovado.estado !== 'APROVADO') {
                const dto = await aplicar(job, token, aprovado, true);
                if (aprovado.estado === 'AGUARDANDO_APROVACAO') {
                    aprovacaoPendente = true;
                    falhar('APROVACAO_PENDENTE');
                }
                return dto;
            }
            const permitir = await transacao(job.referencia, async ctx => {
                const { pg, op } = operacaoCtx(ctx, job, token);
                conferirPedido(ctx);
                if (op.execucao_ate <= ctx.instante) falhar('RESULTADO_DESCONHECIDO');
                if (pedidoDivergente(ctx, pg)) return { dto: await revisar(ctx, pg, op, 'PEDIDO_DIVERGENTE', aprovado) };
                if (divergencia(pg, aprovado)) return { dto: await revisar(ctx, pg, op, 'APROVACAO_DIVERGENTE', aprovado) };
                await evento(ctx, pg, 'API', 'APROVADO', aprovado);
                await mudar(ctx, pg, 'APROVADO', { ordem_externa_id: aprovado.ordemId });
                await mudar(ctx, pg, 'CAPTURANDO');
                await atualizar(ctx, OP, op, { envio_iniciado_em: ctx.instante });
                return { args: argsAdaptador(ctx, pg, op) };
            });
            if (permitir.dto) return permitir.dto;
            return await aplicar(job, token, await obter('capturar', permitir.args), false);
        } catch (e) {
            if (aprovacaoPendente) throw erroPagamento('APROVACAO_PENDENTE');
            // Evidencia parcial/recusa comprovada usa as mesmas verificacoes e locks.
            // Uma falha de consulta nunca prova que a operacao financeira anterior nao ocorreu.
            if (falhaAdaptador?.resultado) {
                ultimoResultado = falhaAdaptador.resultado;
                if (reconciliar) {
                    // Erro com fatos parciais nao substitui o envelope exigido.
                    ultimoResultado = { ...ultimoResultado, estado: 'DESCONHECIDO', capturadoEm: null };
                    ultimaObservacao = { evidencia: 'PRESENTE', associacaoOrdem: 'NAO_DEMONSTRADA',
                        validacao: 'INCONCLUSIVA', statusOrdem: null, statusCaptura: null, motivoPendencia: null };
                }
                try { return await aplicar(job, token, ultimoResultado, etapa.consulta, falhaAdaptador, ultimaObservacao); }
                catch (erroAplicacao) { e = erroAplicacao; }
            }
            if (e?.colisaoIdentificadorExterno) {
                try {
                    return await transacao(interno(job), ctx => {
                        const { pg, op } = operacaoCtx(ctx, job, token);
                        return revisar(ctx, pg, op, 'IDENTIFICADOR_EXTERNO_DUPLICADO', ultimaObservacao
                            ? { resultado: ultimoResultado, observacao: ultimaObservacao } : ultimoResultado);
                    });
                } catch { /* Se a revisao nao puder persistir, conservar incerteza. */ }
            }
            // Resposta externa/COMMIT perdido nunca provoca outra chamada financeira.
            try { const conhecido = await marcarIncerto(job, token, falhaAdaptador ?? classificarFalhaPagamento(null), reconciliar); if (conhecido) return conhecido; }
            catch { /* Permanecer indeterminado; nao expor SQL/excecao do adaptador. */ }
            const erro = erroPagamento('RESULTADO_DESCONHECIDO');
            if (job.recuperacao && falhaAdaptador?.categoria === 'AUTENTICACAO') erro.interromperRecuperacao = true;
            throw erro;
        }
    };

    const criarTentativa = async (sessao, entrada, chave) => {
        entrada = camposExatos(entrada, ['pedidoPublicId']); chave = uuidPagamento(chave);
        const ref = referencia(sessao, entrada);
        const hash = hashPagamento({ versao: 1, acao: 'CRIAR', ...entrada, ...contexto });
        const job = await transacao(ref, async ctx => {
            const anterior = ctx.operacoes.find(o => o.acao === 'CRIAR' && o.chave_idempotencia === chave);
            if (anterior) { conferirHash(anterior, hash); return trabalho(ctx, achar(ctx, anterior.pagamento_id), anterior); }
            conferirPedido(ctx);
            if (ctx.pagamentos.some(p => p.reserva_ativa === 1 || finais.includes(p.estado) || BigInt(p.capturado_centavos) > 0n)) falhar('TENTATIVA_ATIVA');
            const pg = { public_id: randomUUID(), pedido_id: ctx.pedido.id, provedor: contexto.provedor,
                ambiente: contexto.ambiente, conta_recebedora: contexto.contaRecebedora, estado: 'CRIANDO', reserva_ativa: 1,
                moeda: ctx.pedido.moeda, valor_centavos: ctx.pedido.total_centavos,
                criado_em: ctx.instante, atualizado_em: ctx.instante, expira_em: ctx.pedido.expira_em };
            pg.id = await inserir(ctx, PG, pg);
            const op = await novoOp(ctx, pg, 'CRIAR', chave, hash);
            await atualizar(ctx, 'ist_loja_pedidos', ctx.pedido, { estado: 'AGUARDANDO_PAGAMENTO' });
            return trabalho(ctx, pg, op);
        });
        return executar(job);
    };
    const capturar = async (sessao, entrada, chave) => {
        entrada = camposExatos(entrada, ['pagamentoPublicId']); chave = uuidPagamento(chave);
        const hash = hashPagamento({ versao: 1, acao: 'CAPTURAR', ...entrada, ...contexto });
        const job = await transacao(referencia(sessao, entrada), async ctx => {
            const pg = achar(ctx, entrada.pagamentoPublicId); conferirContexto(pg);
            const anterior = ctx.operacoes.find(o => o.acao === 'CAPTURAR' && o.chave_idempotencia === chave);
            if (anterior) { conferirHash(anterior, hash); return trabalho(ctx, pg, anterior); }
            if (ctx.operacoes.some(o => o.pagamento_id === pg.id && o.acao === 'CAPTURAR')) falhar('CONFLITO_IDEMPOTENCIA');
            conferirPedido(ctx);
            if (!['AGUARDANDO_APROVACAO', 'APROVADO'].includes(pg.estado) || fechado(pg) || !pg.ordem_externa_id) falhar('TENTATIVA_ATIVA');
            const op = await novoOp(ctx, pg, 'CAPTURAR', chave, hash);
            return trabalho(ctx, pg, op);
        });
        return executar(job);
    };
    const reconciliar = async (sessao, entrada) => {
        entrada = camposExatos(entrada, ['pagamentoPublicId']);
        if (typeof adaptador.reconciliar !== 'function') falhar('CONFIGURACAO_INVALIDA');
        const job = await transacao(referencia(sessao, entrada), async ctx => {
            const pg = achar(ctx, entrada.pagamentoPublicId); conferirContexto(pg);
            const operacoes = ctx.operacoes.filter(o => o.pagamento_id === pg.id);
            const op = operacoes.find(o => o.acao === 'CAPTURAR') ?? operacoes.find(o => o.acao === 'CRIAR');
            if (!op) falhar('ERRO_INTERNO');
            return trabalho(ctx, pg, op);
        });
        return executar(job, true);
    };
    // Chamador interno deve verificar assinatura antes de fornecer esta projecao.
    const reconciliarWebhook = async w => {
        if (!w || !idExterno(w.eventoId) || !['PAYMENT.CAPTURE.COMPLETED', 'PAYMENT.CAPTURE.PENDING', 'PAYMENT.CAPTURE.DENIED'].includes(w.tipo)
            || !Buffer.isBuffer(w.hash) || w.hash.length !== 32 || (!w.ordemId && !w.capturaId)
            || (w.ordemId !== null && !idExterno(w.ordemId)) || (w.capturaId !== null && !idExterno(w.capturaId))) falhar('SOLICITACAO_INVALIDA');
        if (typeof adaptador.reconciliar !== 'function') falhar('CONFIGURACAO_INVALIDA');
        const alvo = await persistencia.localizarWebhook(contexto, w);
        const ref = { sessaoId: alvo.sessaoId, pedidoId: alvo.pedidoId, verificarSessao: false };
        const job = await transacao(ref, async ctx => {
            const pg = achar(ctx, alvo.pagamentoId); conferirContexto(pg);
            const op = ctx.operacoes.find(o => o.pagamento_id === pg.id && o.acao === 'CAPTURAR')
                ?? ctx.operacoes.find(o => o.pagamento_id === pg.id && o.acao === 'CRIAR');
            if (!op) falhar('ERRO_INTERNO');
            return { ...trabalho(ctx, pg, op), referencia: ref, webhook: { ...w } };
        });
        await executar(job, true);
        const concluido = await transacao(ref, async ctx => (await persistencia.eventoWebhook(ctx, contexto, w.eventoId))?.estado === 'PROCESSADO');
        if (!concluido) falhar('RESULTADO_DESCONHECIDO');
    };
    // Entrada interna, sem HTTP, timer, pool padrao ou sessao fornecida pelo comprador.
    const recuperarPendencias = async ({ limite = 10 } = {}) => {
        if (!Number.isInteger(limite) || limite < 1 || limite > 10) falhar('SOLICITACAO_INVALIDA');
        if (typeof adaptador.reconciliar !== 'function') falhar('CONFIGURACAO_INVALIDA');
        const candidatos = await persistencia.candidatosRecuperacao(contexto, limite);
        const resultados = [];
        for (const c of candidatos) {
            try {
                const resultado = await executar({ referencia: { sessaoId: c.sessaoId, pedidoId: c.pedidoId, verificarSessao: false },
                    pagamentoId: c.pagamentoId, operacaoId: c.operacaoId, recuperacao: true }, true);
                resultados.push({ pagamentoId: c.pagamentoId, resultado });
            } catch (e) {
                resultados.push({ pagamentoId: c.pagamentoId, erro: e.codigo ?? 'ERRO_INTERNO' });
                if (e.interromperRecuperacao || !['RESULTADO_DESCONHECIDO', 'OPERACAO_EM_ANDAMENTO'].includes(e.codigo)) break;
            }
        }
        return resultados;
    };
    return Object.freeze({ criarTentativa, capturar, reconciliar, recuperarPendencias, reconciliarWebhook });
};
