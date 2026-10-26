import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { criarLojaPagamentoService } from '../src/services/lojaPagamentoService.js';
import { criarFalhaPagamento, normalizarResultadoPagamento, normalizarReconciliacaoPagamento, hashPagamento } from '../src/services/lojaPagamentoContratos.js';
import { criarPagamentoSimulado } from './fixtures/lojaPagamentoSimulado.js';
import { criarBancoPagamentoIsolado } from './fixtures/lojaPagamentoBancoIsolado.js';

const contexto = { provedor: 'simulado', ambiente: 'sandbox', contaRecebedora: 'recebedor-fixture' };
const codigo = codigo => ({ codigo });
const adiar = () => { let resolver; const promessa = new Promise(r => { resolver = r; }); return { promessa, resolver }; };
// Adaptacao somente local: nenhum fallback e adicionado ao servico de producao.
const envelopeTeste = resultado => normalizarReconciliacaoPagamento({ resultado: normalizarResultadoPagamento(resultado), observacao: {
    evidencia: 'PRESENTE', associacaoOrdem: resultado.capturaId ? 'CONFIRMADA' : 'NAO_DEMONSTRADA',
    validacao: resultado.capturaId && resultado.estado !== 'DESCONHECIDO' ? 'CONSISTENTE' : 'INCONCLUSIVA',
    statusOrdem: resultado.estado === 'APROVADO' ? 'APPROVED' : resultado.capturaId ? 'COMPLETED' : 'CREATED',
    statusCaptura: resultado.estado === 'CAPTURADO' ? 'COMPLETED' : resultado.estado === 'PENDENTE' ? 'PENDING' : null,
    motivoPendencia: resultado.estado === 'PENDENTE' ? 'PENDING_REVIEW' : null
} });
const comReconciliacaoTeste = adaptador => ({ ...adaptador,
    async reconciliar(args) { return envelopeTeste(await adaptador.consultar(args)); } });

// Double em memoria da conexao mysql2. Nao interpreta SQL em um servidor,
// nao simula locks InnoDB e nao comprova concorrencia real/compatibilidade SQL.
const montarSemBanco = (opcoes = {}) => {
    let instante = Date.parse('2026-10-18T12:00:00.000Z');
    const inicio = '2026-10-18T11:59:00.000Z', fim = '2026-10-18T12:20:00.000Z';
    const pgPublicId = randomUUID(), pedidoPublicId = randomUUID();
    const clonar = v => Buffer.isBuffer(v) ? Buffer.from(v) : Array.isArray(v) ? v.map(clonar)
        : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clonar(x)])) : v;
    const data = (k, v) => typeof v === 'string' && (k.endsWith('_em') || k === 'execucao_ate')
        && /^\d{4}-\d{2}-\d{2} /.test(v) ? `${v.replace(' ', 'T')}Z` : v;
    let estado = {
        ist_loja_sessoes: [{ id: 1, criada_em: inicio, expira_em: '2026-10-19T11:59:00.000Z', revogada_em: null },
            { id: 2, criada_em: inicio, expira_em: '2026-10-19T11:59:00.000Z', revogada_em: null }],
        ist_loja_pedidos: [{ id: 1, public_id: pedidoPublicId, sessao_id: 1, estado: 'AGUARDANDO_PAGAMENTO',
            comprador_email:'comprador.real@example.invalid',
            ambiente: 'sandbox', moeda: 'BRL', total_centavos: '19000', versao: 1,
            criado_em: inicio, atualizado_em: inicio, expira_em: fim, pagamento_confirmado_em: null }],
        ist_loja_pagamentos: [{ id: 1, public_id: pgPublicId, pedido_id: 1, ...contexto,
            conta_recebedora: contexto.contaRecebedora, estado: 'PENDENTE', reserva_ativa: 1,
            valor_centavos: '19000', capturado_centavos: '0', moeda: 'BRL', versao: 1,
            ordem_externa_id: 'ORDEMTESTE', captura_externa_id: null, capturado_em: null,
            criado_em: inicio, atualizado_em: inicio, expira_em: fim, encerrado_em: null }],
        ist_loja_pagamento_operacoes: [{ id: 1, pagamento_id: 1, pedido_id: 1, acao: 'CAPTURAR',
            chave_idempotencia: randomUUID(), request_id_provedor: randomUUID(), solicitacao_hash: Buffer.alloc(32),
            estado: 'SUCESSO', tentativas: 1, versao: 1, execucao_token: null, execucao_ate: null,
            criado_em: inicio, atualizado_em: inicio, envio_iniciado_em: inicio, concluido_em: inicio }],
        ist_loja_pagamento_eventos: [],ist_loja_notificacoes:[]
    };
    let abertas = 0, conexoes = 0, descartadas = 0, falhou = false;
    const consultas = [];
    const db = { async getConnection() {
        conexoes++; let copia = null;
        const encerrar = () => { if (copia) { copia = null; abertas--; } };
        return {
            async beginTransaction() { assert.equal(copia, null); copia = clonar(estado); abertas++; },
            async commit() {
                if (opcoes.commitIncerto !== undefined && !falhou && copia.ist_loja_pedidos[0].estado === 'PAGO'
                    && estado.ist_loja_pedidos[0].estado !== 'PAGO') {
                    falhou = true; if (opcoes.commitIncerto) estado = copia; encerrar(); throw new Error('fixture-commit-perdido');
                }
                estado = copia; encerrar();
            },
            async rollback() { encerrar(); },
            destroy() { descartadas++; encerrar(); },
            release() { assert.equal(copia, null, 'nao devolver transacao aberta'); },
            async query(sql, params = []) {
                consultas.push(sql);
                if (sql.startsWith('SET TRANSACTION')) return [[]];
                if(sql.includes('p.id AS pagamentoId'))return [estado.ist_loja_pagamentos.filter(p=>p.provedor===params[0]
                    &&p.ambiente===params[1]&&p.conta_recebedora===params[2]
                    &&(p.ordem_externa_id===params[3]||p.captura_externa_id===params[5]))
                    .map(p=>({pagamentoId:p.id,pedidoId:p.pedido_id,sessaoId:1,ordem_externa_id:p.ordem_externa_id,captura_externa_id:p.captura_externa_id}))];
                assert.ok(copia);
                if(sql==='SELECT @@in_transaction AS em_transacao')return [[{em_transacao:1}]];
                if(sql.includes('FROM ist_loja_pagamento_eventos'))return [clonar(copia.ist_loja_pagamento_eventos.filter(e=>
                    e.provedor===params[0]&&e.ambiente===params[1]&&e.conta_recebedora===params[2]&&e.origem==='WEBHOOK'&&e.evento_id===params[3]))];
                if (sql.startsWith('SELECT pedido_id')) return [copia.ist_loja_pagamentos.filter(p => p.public_id === params[0]).map(p => ({ pedido_id: p.pedido_id }))];
                if (sql.includes('FROM ist_loja_sessoes')) return [clonar(copia.ist_loja_sessoes.filter(s => s.id === params[0]))];
                if (sql.includes('FROM ist_loja_pedidos')) return [clonar(copia.ist_loja_pedidos.filter(p =>
                    (p.id === params[0] || p.public_id === params[0]) && p.sessao_id === params[1]))];
                if (sql.startsWith('SELECT')) {
                    const tabela = sql.includes('FROM ist_loja_pagamento_operacoes') ? 'ist_loja_pagamento_operacoes' : 'ist_loja_pagamentos';
                    return [clonar(copia[tabela].filter(p => p.pedido_id === params[0]))];
                }
                if (sql.startsWith('UPDATE')) {
                    const tabela = /^UPDATE ([a-z_]+)/.exec(sql)[1];
                    const nomes = [...sql.split('WHERE')[0].matchAll(/([a-z_]+)=\?/g)].map(m => m[1]);
                    const campos = Object.fromEntries(nomes.map((k, i) => [k, data(k, params[i])]));
                    if(opcoes.falhaDepoisOutbox&&tabela==='ist_loja_pagamento_operacoes'&&campos.estado==='SUCESSO'
                        &&copia.ist_loja_notificacoes.length)throw Error('fixture-erro-apos-outbox');
                    if (opcoes.colisao && tabela === 'ist_loja_pagamentos' && campos.captura_externa_id) {
                        throw Object.assign(new Error('fixture-duplicado'), { code: 'ER_DUP_ENTRY', sqlMessage: 'uq_lpg_captura_externa' });
                    }
                    if (opcoes.falhaPago && !falhou && tabela === 'ist_loja_pedidos' && campos.estado === 'PAGO') {
                        falhou = true; throw new Error('fixture-SQL-segredo');
                    }
                    const linha = copia[tabela].find(p => tabela==='ist_loja_pagamento_eventos'
                        ? p.id===params.at(-3)&&p.estado===params.at(-2)
                            &&(p.execucao_token===params.at(-1)||Buffer.isBuffer(p.execucao_token)&&p.execucao_token.equals(params.at(-1)))
                        : p.id === params.at(-2) && p.versao === params.at(-1));
                    if (!linha) return [{ affectedRows: 0 }];
                    Object.assign(linha, campos, { versao: linha.versao + 1 });
                    return [{ affectedRows: 1, warningStatus: 0 }];
                }
                const m = /^INSERT INTO ([a-z_]+)\s*\(([^)]+)\)/.exec(sql); assert.ok(m, 'comando inesperado no double');
                if(m[1]==='ist_loja_notificacoes'&&opcoes.falhaOutbox)throw Error('fixture-schema-outbox-ausente');
                const linha = { id: copia[m[1]].length + 1, versao: 1, tentativas: 0,execucao_token:null,execucao_ate:null,
                    ...Object.fromEntries(m[2].split(',').map((k, i) => [k, data(k, params[i])])) };
                if(m[1]==='ist_loja_notificacoes'&&copia[m[1]].some(n=>n.pedido_id===linha.pedido_id&&n.finalidade===linha.finalidade))
                    throw Object.assign(Error('fixture-UNIQUE'),{code:'ER_DUP_ENTRY'});
                copia[m[1]].push(linha); return [{ insertId: linha.id, affectedRows:1, warningStatus: 0 }];
            }
        };
    } };
    const resultado = (extras = {}) => ({ estado: 'CAPTURADO', referencia: pgPublicId, ambiente: 'sandbox',
        ordemId: 'ORDEMTESTE', capturaId: 'CAPTURATESTE', valorCentavos: '19000', moeda: 'BRL',
        contaRecebedora: contexto.contaRecebedora, capturadoEm: '2026-10-18T12:00:00.000Z', ...extras });
    const chamadas = { reconciliar: [], consultar: 0, capturar: 0, criar: 0 };
    const adaptador = {
        async criar() { chamadas.criar++; assert.fail('criacao externa proibida'); },
        async consultar() { chamadas.consultar++; assert.equal(abertas, 0); return resultado({ estado: 'APROVADO', capturaId: null, capturadoEm: null }); },
        async capturar() { chamadas.capturar++; assert.equal(abertas, 0); return resultado(); },
        async reconciliar(args) {
            assert.equal(abertas, 0); chamadas.reconciliar.push(args);
            return opcoes.responder ? opcoes.responder(args, resultado) : envelopeTeste(resultado());
        }
    };
    if (opcoes.semCapacidade) delete adaptador.reconciliar;
    const service = criarLojaPagamentoService({ db, adaptador, contexto, agora: () => new Date(instante), timeoutMs: 30, execucaoMs: 1000 });
    return { service, resultado, chamadas, consultas, adaptador, db, pgPublicId, pedidoPublicId,
        reconciliar: (sessao = { id: 1 }, entrada = { pagamentoPublicId: pgPublicId }) => service.reconciliar(sessao, entrada),
        get estado() { return estado; }, get abertas() { return abertas; }, get conexoes() { return conexoes; }, get descartadas() { return descartadas; },
        avancar(ms) { instante += ms; },
        pg: () => estado.ist_loja_pagamentos[0], op: () => estado.ist_loja_pagamento_operacoes[0], pedido: () => estado.ist_loja_pedidos[0]
    };
};

test('simulado B2 reconciliacao sem banco', async t => {
    await t.test('capacidade ausente falha antes de reservar ou abrir conexao', async () => {
        const m = montarSemBanco({ semCapacidade: true });
        await assert.rejects(m.reconciliar(), codigo('CONFIGURACAO_INVALIDA'));
        assert.equal(m.conexoes, 0); assert.equal(m.op().estado, 'SUCESSO');
    });
    await t.test('usa contexto persistido, confirma atomicamente no double e nao duplica quitacao', async () => {
        const m = montarSemBanco(); const r = await m.reconciliar();
        assert.equal(r.estado, 'CAPTURADO'); assert.equal(r.pedidoEstado, 'PAGO');
        const a = m.chamadas.reconciliar[0];
        assert.equal(a.referencia, m.pgPublicId); assert.equal(a.ordemId, 'ORDEMTESTE'); assert.equal(a.capturaId, null);
        assert.equal(a.valorCentavos, '19000'); assert.equal(a.moeda, 'BRL'); assert.equal(a.provedor, contexto.provedor);
        assert.equal(a.ambiente, 'sandbox'); assert.equal(a.contaRecebedora, contexto.contaRecebedora);
        assert.equal(m.pg().reserva_ativa, null); assert.equal(m.op().execucao_token, null); assert.equal(m.abertas, 0);
        assert.equal(m.chamadas.consultar, 0); assert.equal(m.chamadas.capturar, 0); assert.equal(m.chamadas.criar, 0);
        const e = m.estado.ist_loja_pagamento_eventos.find(x => x.origem === 'RECONCILIACAO');
        const evidencia = JSON.parse(e.evidencia_json);
        assert.equal(evidencia.observacao.statusCaptura, 'COMPLETED'); assert.deepEqual(e.conteudo_hash, hashPagamento(evidencia));
        assert.deepEqual(JSON.parse(m.op().resultado_json), evidencia);
        const antes = JSON.stringify(m.estado); assert.deepEqual(await m.reconciliar(), r);
        assert.equal(JSON.stringify(m.estado), antes); assert.equal(m.chamadas.reconciliar.length, 1);
        for (const campo of ['resultado', 'observacao', 'ordemId', 'capturaId', 'contaRecebedora']) assert.equal(Object.hasOwn(r, campo), false);
    });
    await t.test('rejeita autoridade financeira do chamador e pagamento de outra sessao', async () => {
        const m = montarSemBanco();
        await assert.rejects(m.reconciliar({ id: 1 }, { pagamentoPublicId: m.pgPublicId, valorCentavos: '1' }), codigo('SOLICITACAO_INVALIDA'));
        await assert.rejects(m.reconciliar({ id: 2 }), codigo('PEDIDO_NAO_ENCONTRADO'));
        assert.equal(m.chamadas.reconciliar.length, 0); assert.equal(m.op().tentativas, 1);
    });
    await t.test('PENDENTE guarda Capture ID e motivo; null posterior nao apaga ID', async () => {
        let id = 'CAPTURATESTE';
        const m = montarSemBanco({ responder: (a, resultado) => {
            const e = envelopeTeste(resultado({ estado: 'PENDENTE', capturaId: id, capturadoEm: null }));
            e.observacao.associacaoOrdem = 'CONFIRMADA'; e.observacao.validacao = 'CONSISTENTE'; return e;
        } });
        assert.equal((await m.reconciliar()).estado, 'PENDENTE'); assert.equal(m.pg().captura_externa_id, id);
        assert.equal(m.pg().reserva_ativa, 1); assert.equal(m.pedido().pagamento_confirmado_em, null);
        assert.equal(JSON.parse(m.op().resultado_json).observacao.motivoPendencia, 'PENDING_REVIEW');
        id = null; assert.equal((await m.reconciliar()).estado, 'PENDENTE'); assert.equal(m.pg().captura_externa_id, 'CAPTURATESTE');
        assert.equal(m.pg().capturado_centavos, '0');
    });
    for (const modo of ['inconclusiva', 'ausente', 'contraditoria', 'consistenteDesconhecido', 'statusIncompativel']) {
        await t.test(`barreira: ${modo} nunca reconhece dinheiro ou quita pedido`, async () => {
            const m = montarSemBanco({ responder: (a, resultado) => {
                const e = envelopeTeste(resultado());
                if (modo === 'inconclusiva') e.observacao.validacao = 'INCONCLUSIVA';
                if (modo === 'ausente') e.observacao = { evidencia: 'AUSENTE', associacaoOrdem: 'NAO_DEMONSTRADA',
                    validacao: 'INCONCLUSIVA', statusOrdem: null, statusCaptura: null, motivoPendencia: null };
                if (modo === 'contraditoria') Object.assign(e.observacao, { evidencia: 'CONTRADITORIA', associacaoOrdem: 'DIVERGENTE', validacao: 'DIVERGENTE' });
                if (modo === 'consistenteDesconhecido') e.resultado = normalizarResultadoPagamento(resultado({ estado: 'DESCONHECIDO', capturadoEm: null }));
                if (modo === 'statusIncompativel') e.observacao.statusCaptura = 'PENDING';
                return e;
            } });
            const r = await m.reconciliar();
            assert.equal(r.estado, modo === 'contraditoria' ? 'REVISAO' : 'PENDENTE');
            assert.equal(m.pg().capturado_centavos, '0'); assert.equal(m.pg().capturado_em, null);
            assert.equal(m.pedido().pagamento_confirmado_em, null); assert.equal(m.pg().reserva_ativa, 1);
            assert.equal(m.op().execucao_token, null);
            if (modo === 'ausente') assert.equal(m.pg().captura_externa_id, null);
        });
    }
    for (const [campo, valor] of [['valorCentavos', '19001'], ['moeda', 'USD'], ['contaRecebedora', 'outro'],
        ['ordemId', 'OUTRAORDEM'], ['referencia', 'OUTRAREFERENCIA'], ['capturaId', 'OUTRACAPTURA']]) {
        await t.test(`divergencia ${campo} nao sobrescreve IDs nem reconhece dinheiro`, async () => {
            const m = montarSemBanco({ responder: (a, resultado) => envelopeTeste(resultado({ [campo]: valor })) });
            m.pg().captura_externa_id = 'CAPTURATESTE';
            assert.equal((await m.reconciliar()).estado, 'REVISAO');
            assert.equal(m.pg().captura_externa_id, 'CAPTURATESTE'); assert.equal(m.pg().ordem_externa_id, 'ORDEMTESTE');
            assert.equal(m.pg().capturado_centavos, '0'); assert.equal(m.pedido().pagamento_confirmado_em, null);
        });
    }
    for (const tipo of ['rede', 'timeout', '404', 'envelopeInvalido', 'parcial']) {
        await t.test(`falha GET ${tipo} conserva pendencia e sanitiza evidencia`, async () => {
            const m = montarSemBanco({ responder: async (a, resultado) => {
                if (tipo === 'rede') throw new Error('fixture-segredo private@example.invalid');
                if (tipo === 'timeout') return new Promise(() => {});
                if (tipo === 'envelopeInvalido') return { ...envelopeTeste(resultado()), segredo: 'fixture-segredo' };
                if (tipo === 'parcial') throw criarFalhaPagamento({ categoria: 'INFRAESTRUTURA', envio: 'ENVIADO',
                    resultado: { estado: 'DESCONHECIDO', referencia: a.referencia, ambiente: a.ambiente, ordemId: a.ordemId } });
                return { resultado: { estado: 'DESCONHECIDO', referencia: a.referencia, ambiente: a.ambiente },
                    observacao: { evidencia: 'AUSENTE', associacaoOrdem: 'NAO_DEMONSTRADA', validacao: 'INCONCLUSIVA',
                        statusOrdem: null, statusCaptura: null, motivoPendencia: null } };
            } });
            if (['rede', 'timeout', 'envelopeInvalido'].includes(tipo)) await assert.rejects(m.reconciliar(), codigo('RESULTADO_DESCONHECIDO'));
            else assert.equal((await m.reconciliar()).estado, 'PENDENTE');
            assert.equal(m.pg().estado, 'PENDENTE'); assert.equal(m.pg().reserva_ativa, 1);
            assert.equal(m.op().estado, 'DESCONHECIDA'); assert.equal(m.op().execucao_token, null); assert.equal(m.abertas, 0);
            assert.ok(m.estado.ist_loja_pagamento_eventos.some(e => e.origem === 'RECONCILIACAO'));
            for (const secreto of ['fixture-segredo', 'private@example.invalid']) assert.equal(JSON.stringify(m.estado).includes(secreto), false);
        });
    }
    await t.test('captura tardia mantem REVISAO e fato observado, sem quitar', async () => {
        const m = montarSemBanco(); m.avancar(25 * 60 * 1000);
        assert.equal((await m.reconciliar()).estado, 'REVISAO'); assert.equal(m.pg().capturado_centavos, '19000');
        assert.equal(m.pg().motivo_revisao, 'CAPTURA_TARDIA_OU_INESPERADA'); assert.equal(m.pedido().pagamento_confirmado_em, null);
    });
    await t.test('PENDENTE previamente identificado pode ser confirmado pela mesma captura', async () => {
        const m = montarSemBanco(); m.pg().captura_externa_id = 'CAPTURATESTE';
        assert.equal((await m.reconciliar()).estado, 'CAPTURADO'); assert.equal(m.pg().captura_externa_id, 'CAPTURATESTE');
    });
    await t.test('provedor ou total persistido incompatíveis impedem consulta externa', async () => {
        const m = montarSemBanco(); m.pg().provedor = 'outro';
        await assert.rejects(m.reconciliar(), codigo('PEDIDO_NAO_ENCONTRADO')); assert.equal(m.chamadas.reconciliar.length, 0);
        const n = montarSemBanco(); n.pedido().total_centavos = '19001';
        assert.equal((await n.reconciliar()).estado, 'REVISAO'); assert.equal(n.chamadas.reconciliar.length, 0);
    });
    await t.test('colisao UNIQUE simulada provoca revisao sem liberar reserva', async () => {
        const m = montarSemBanco({ colisao: true });
        assert.equal((await m.reconciliar()).estado, 'REVISAO');
        assert.equal(m.pg().motivo_revisao, 'IDENTIFICADOR_EXTERNO_DUPLICADO'); assert.equal(m.pg().reserva_ativa, 1);
        assert.equal(m.pg().captura_externa_id, null); assert.equal(m.pg().capturado_centavos, '0');
    });
    await t.test('falha SQL simulada reverte aplicacao e permite nova consulta sem captura', async () => {
        const m = montarSemBanco({ falhaPago: true });
        await assert.rejects(m.reconciliar(), codigo('RESULTADO_DESCONHECIDO'));
        assert.equal(m.pg().estado, 'PENDENTE'); assert.equal(m.pg().capturado_centavos, '0');
        assert.equal(m.pedido().pagamento_confirmado_em, null);
        assert.equal((await m.reconciliar()).estado, 'CAPTURADO'); assert.equal(m.chamadas.capturar, 0);
    });
    for (const persistiu of [true, false]) await t.test(`COMMIT incerto simulado persistiu=${persistiu}`, async () => {
        const m = montarSemBanco({ commitIncerto: persistiu });
        if (persistiu) assert.equal((await m.reconciliar()).estado, 'CAPTURADO');
        else {
            await assert.rejects(m.reconciliar(), codigo('RESULTADO_DESCONHECIDO')); assert.equal(m.pg().estado, 'PENDENTE');
        }
        assert.equal((await m.reconciliar()).estado, 'CAPTURADO'); assert.ok(m.descartadas >= 1); assert.equal(m.abertas, 0);
        assert.equal(m.chamadas.capturar, 0);
    });
    await t.test('execucao concorrente valida e rejeitada; nenhum POST de reconciliacao', async () => {
        const entrou = adiar(), liberar = adiar();
        const m = montarSemBanco({ responder: async (a, resultado) => { entrou.resolver(); await liberar.promessa; return envelopeTeste(resultado()); } });
        const primeira = m.reconciliar(); await entrou.promessa;
        try { await assert.rejects(m.reconciliar(), codigo('OPERACAO_EM_ANDAMENTO')); }
        finally { liberar.resolver(); }
        await primeira; assert.equal(m.chamadas.reconciliar.length, 1); assert.equal(m.chamadas.capturar, 0);
    });
    await t.test('trabalhador antigo nao sobrescreve reconciliacao posterior', async () => {
        const entrou = adiar(), liberar = adiar(); let n = 0;
        const m = montarSemBanco({ responder: async (a, resultado) => {
            if (++n === 1) { entrou.resolver(); await liberar.promessa; }
            return envelopeTeste(resultado());
        } });
        const primeira = m.reconciliar(); await entrou.promessa; m.avancar(2000);
        assert.equal((await m.reconciliar()).estado, 'CAPTURADO');
        const antes = JSON.stringify(m.estado); liberar.resolver(); await primeira;
        assert.equal(JSON.stringify(m.estado), antes); assert.equal(m.chamadas.capturar, 0);
    });
    await t.test('aprovacao antes de capturar preserva consultar; nao usa reconciliar', async () => {
        const m = montarSemBanco(); m.pg().estado = 'AGUARDANDO_APROVACAO';
        m.op().acao = 'CRIAR'; m.op().envio_iniciado_em = null;
        const r = await m.service.capturar({ id: 1 }, { pagamentoPublicId: m.pgPublicId }, randomUUID());
        assert.equal(r.estado, 'CAPTURADO'); assert.equal(m.chamadas.consultar, 1); assert.equal(m.chamadas.capturar, 1);
        assert.equal(m.chamadas.reconciliar.length, 0);
    });
    await t.test('recuperacao automatica existente continua consultar sem novo metodo', async () => {
        const m = montarSemBanco(); m.pg().estado = 'DESCONHECIDO'; m.op().estado = 'DESCONHECIDA';
        m.op().solicitacao_hash = hashPagamento({ versao: 1, acao: 'CAPTURAR', pagamentoPublicId: m.pgPublicId, ...contexto });
        const r = await m.service.capturar({ id: 1 }, { pagamentoPublicId: m.pgPublicId }, m.op().chave_idempotencia);
        assert.equal(r.estado, 'DESCONHECIDO'); assert.equal(m.chamadas.consultar, 1);
        assert.equal(m.chamadas.capturar, 0); assert.equal(m.chamadas.reconciliar.length, 0);
    });
});

test('68.1 outbox em integracao simulada do nucleo financeiro, sem banco ou SMTP',async t=>{
    const notificacoes=m=>m.estado.ist_loja_notificacoes;
    await t.test('confirmacao cria destinatario persistido, finalidade, ambiente e estado inicial',async()=>{
        const m=montarSemBanco();await m.reconciliar();
        assert.equal(notificacoes(m).length,1);
        const n=notificacoes(m)[0];assert.equal(n.pedido_id,m.pedido().id);
        assert.equal(n.destinatario,m.pedido().comprador_email);assert.equal(n.ambiente,m.pedido().ambiente);
        assert.equal(n.finalidade,'CONFIRMACAO_COMPRA');assert.equal(n.estado,'PENDENTE');assert.equal(n.tentativas,0);
        assert.match(n.public_id,/^[a-f0-9-]{36}$/);assert.equal(n.criado_em,n.atualizado_em);
        assert(!Object.keys(n).some(k=>/senha|pdf|caminho|credencial|download/.test(k)));
        const antes=JSON.stringify(m.estado);await m.reconciliar();await m.reconciliar();
        assert.equal(JSON.stringify(m.estado),antes);
    });
    await t.test('PENDENTE e evidencia divergente nao criam notificacao',async()=>{
        const pendente=montarSemBanco({responder:(_a,r)=>envelopeTeste(r({estado:'PENDENTE',capturadoEm:null}))});
        await pendente.reconciliar();assert.equal(pendente.pedido().estado,'AGUARDANDO_PAGAMENTO');assert.equal(notificacoes(pendente).length,0);
        const divergente=montarSemBanco({responder:(_a,r)=>envelopeTeste(r({valorCentavos:'1'}))});
        await divergente.reconciliar();assert.equal(divergente.pedido().estado,'REVISAO');assert.equal(notificacoes(divergente).length,0);
    });
    await t.test('erro depois do INSERT reverte pedido, dinheiro e outbox; tabela ausente nao e ignorada',async()=>{
        for(const opcoes of [{falhaDepoisOutbox:true},{falhaOutbox:true}]){
            const m=montarSemBanco(opcoes);await assert.rejects(m.reconciliar(),codigo('RESULTADO_DESCONHECIDO'));
            assert(m.consultas.some(q=>q.startsWith('INSERT INTO ist_loja_notificacoes')));
            assert.equal(m.pedido().estado,'AGUARDANDO_PAGAMENTO');assert.equal(m.pedido().pagamento_confirmado_em,null);
            assert.equal(m.pg().capturado_centavos,'0');assert.equal(notificacoes(m).length,0);assert.equal(m.abertas,0);
        }
    });
    await t.test('captura repetida conserva uma notificacao',async()=>{
        const m=montarSemBanco();m.pg().estado='AGUARDANDO_APROVACAO';m.op().acao='CRIAR';m.op().envio_iniciado_em=null;
        const entrada={pagamentoPublicId:m.pgPublicId},chave=randomUUID();
        await m.service.capturar({id:1},entrada,chave);await m.service.capturar({id:1},entrada,chave);
        assert.equal(notificacoes(m).length,1);assert.equal(m.chamadas.capturar,1);
    });
    await t.test('webhook repetido e reconciliacao posterior conservam uma notificacao',async()=>{
        const m=montarSemBanco(),w={eventoId:'EVENTO-68-1',tipo:'PAYMENT.CAPTURE.COMPLETED',
            ordemId:'ORDEMTESTE',capturaId:'CAPTURATESTE',hash:Buffer.alloc(32,8)};
        await m.service.reconciliarWebhook(w);await m.service.reconciliarWebhook(w);await m.reconciliar();
        await m.service.reconciliarWebhook({...w,eventoId:'OUTRO-EVENTO-68-1',hash:Buffer.alloc(32,10)});
        assert.equal(notificacoes(m).length,1);assert.equal(m.chamadas.reconciliar.length,1);
        assert.equal(m.estado.ist_loja_pagamento_eventos.filter(e=>e.evento_id===w.eventoId).length,1);
    });
    await t.test('concorrencia simulada reserva uma execucao e nao duplica notificacao',async()=>{
        const entrou=adiar(),liberar=adiar();
        const m=montarSemBanco({responder:async(_a,r)=>{entrou.resolver();await liberar.promessa;return envelopeTeste(r());}});
        const a=m.reconciliar();await entrou.promessa;
        try{await assert.rejects(m.reconciliar(),codigo('OPERACAO_EM_ANDAMENTO'));}finally{liberar.resolver();}
        await a;await m.reconciliar();assert.equal(notificacoes(m).length,1);
    });
    await t.test('pedido historico PAGO nao recebe backfill, nem por webhook',async()=>{
        const m=montarSemBanco();m.pedido().estado='PAGO';m.pedido().pagamento_confirmado_em='2026-10-18T12:00:00.000Z';
        m.pg().estado='CAPTURADO';m.pg().reserva_ativa=null;m.pg().capturado_centavos='19000';
        m.pg().captura_externa_id='CAPTURATESTE';m.pg().capturado_em=m.pedido().pagamento_confirmado_em;
        await m.reconciliar();
        await m.service.reconciliarWebhook({eventoId:'HISTORICO-68-1',tipo:'PAYMENT.CAPTURE.COMPLETED',
            ordemId:'ORDEMTESTE',capturaId:'CAPTURATESTE',hash:Buffer.alloc(32,9)});
        assert.equal(notificacoes(m).length,0);assert.equal(m.chamadas.reconciliar.length,0);
    });
    for(const persistiu of [true,false])await t.test(`COMMIT incerto conserva atomicidade e nao duplica, persistiu=${persistiu}`,async()=>{
        const m=montarSemBanco({commitIncerto:persistiu});
        if(persistiu)await m.reconciliar();else await assert.rejects(m.reconciliar(),codigo('RESULTADO_DESCONHECIDO'));
        assert.equal(notificacoes(m).length,persistiu?1:0);
        await m.reconciliar();assert.equal(notificacoes(m).length,1);
    });
});

test('nucleo transacional em MariaDB descartavel e adaptador exclusivo de testes', {
    skip: !process.env.IST_LOJA_PAGAMENTOS_MARIADB_BIN, timeout: 180000
}, async t => {
    const anterior = process.env.NODE_ENV; process.env.NODE_ENV = 'test';
    t.after(() => { if (anterior === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = anterior; });
    const banco = await criarBancoPagamentoIsolado(t);
    const { pool, admin, novaCompra } = banco;
    const criarServico = opcoes => criarLojaPagamentoService({ ...opcoes, adaptador: comReconciliacaoTeste(opcoes.adaptador) });
    const montar = (opcoes = {}) => {
        const sim = criarPagamentoSimulado(opcoes);
        const service = criarServico({ db: opcoes.db ?? pool, adaptador: sim.adaptador,
            contexto: opcoes.contexto ?? contexto, ...(opcoes.agora ? { agora: opcoes.agora } : {}),
            timeoutMs: opcoes.timeoutMs ?? 1000, execucaoMs: opcoes.execucaoMs ?? 5000 });
        return { sim, service };
    };
    const criar = (s, compra, chave = randomUUID()) => s.criarTentativa(compra.sessao, { pedidoPublicId: compra.pedidoPublicId }, chave);
    const capturar = (s, compra, pg, chave = randomUUID()) => s.capturar(compra.sessao, { pagamentoPublicId: pg.publicId }, chave);
    const reconciliar = (s, compra, pg) => s.reconciliar(compra.sessao, { pagamentoPublicId: pg.publicId });
    const ler = async pg => {
        const [[p]] = await admin.query('SELECT * FROM ist_loja_pagamentos WHERE public_id=?', [pg.publicId]);
        const [[pedido]] = await admin.query('SELECT * FROM ist_loja_pedidos WHERE id=?', [p.pedido_id]);
        const [operacoes] = await admin.query('SELECT * FROM ist_loja_pagamento_operacoes WHERE pagamento_id=? ORDER BY id', [p.id]);
        const [eventos] = await admin.query('SELECT * FROM ist_loja_pagamento_eventos WHERE pagamento_id=? ORDER BY id', [p.id]);
        return { p, pedido, operacoes, eventos };
    };
    const adaptarPool = adaptar => ({ async getConnection() {
        const c = await pool.getConnection();
        return adaptar({ query: (...args) => c.query(...args), beginTransaction: () => c.beginTransaction(),
            commit: () => c.commit(), rollback: () => c.rollback(), release: () => c.release(), destroy: () => c.destroy() });
    } });

    const prepararRecuperacao = async () => {
        let instante = Date.now(); let responder; let consultas = 0;
        const agora = () => new Date(instante);
        const contextoAuto = { ...contexto, contaRecebedora: `auto-${randomUUID()}` };
        const sim = criarPagamentoSimulado({ agora });
        const adaptador = { ...sim.adaptador, async reconciliar(args) {
            consultas++;
            const resultado = await sim.adaptador.consultar(args);
            return responder ? responder(args, resultado) : envelopeTeste(resultado);
        } };
        const novo = (opcoes = {}) => criarLojaPagamentoService({ db: pool, contexto: contextoAuto, adaptador, agora, ...opcoes });
        const service = novo(), compra = await novaCompra(), pg = await criar(service, compra);
        sim.aprovado(pg.publicId); sim.modos.captura = 'pendente';
        await capturar(service, compra, pg);
        return { service, novo, sim, compra, pg, contextoAuto, get consultas() { return consultas; },
            avancar(ms = 61000) { instante += ms; }, responder(fn) { responder = fn; },
            async recuperar(s = service) { return s.recuperarPendencias(); } };
    };
    for (const estadoSessao of ['expirada', 'revogada']) await t.test(`recuperacao interna com sessao ${estadoSessao} confirma sem recaptura`, async () => {
        const m = await prepararRecuperacao();
        if (estadoSessao === 'revogada') await admin.query('UPDATE ist_loja_sessoes SET revogada_em=criada_em WHERE id=?', [m.compra.sessao.id]);
        else await admin.query('UPDATE ist_loja_sessoes SET expira_em=DATE_ADD(criada_em,INTERVAL 1 SECOND) WHERE id=?', [m.compra.sessao.id]);
        m.sim.concluirPendente(m.pg.publicId); m.avancar();
        const r = await m.recuperar(); assert.equal(r.length, 1); assert.equal(r[0].resultado.estado, 'CAPTURADO');
        const dados = await ler(m.pg); assert.equal(dados.pedido.estado, 'PAGO');
        assert.equal(m.sim.chamadas.capturar, 1); assert.equal(m.consultas, 1);
        assert.deepEqual(await m.recuperar(), []); assert.equal(m.consultas, 1);
        assert.equal(dados.eventos.filter(e => e.tipo === 'RECUPERACAO_AUTOMATICA').length, 1);
    });
    await t.test('recuperacao falha GET preserva pendencia, IDs e backoff persistido', async () => {
        const m = await prepararRecuperacao(); const antes = await ler(m.pg);
        m.responder(() => { throw new Error('segredo nao persistir'); }); m.avancar();
        const r = await m.recuperar(); assert.equal(r[0].erro, 'RESULTADO_DESCONHECIDO');
        const depois = await ler(m.pg); assert.equal(depois.p.estado, 'PENDENTE');
        assert.equal(depois.p.captura_externa_id, antes.p.captura_externa_id); assert.equal(depois.p.ordem_externa_id, antes.p.ordem_externa_id);
        assert.equal(depois.pedido.pagamento_confirmado_em, null); assert.equal(depois.p.reserva_ativa, 1);
        assert.deepEqual(depois.operacoes.map(o => o.id), antes.operacoes.map(o => o.id));
        const op = depois.operacoes.find(o => o.acao === 'CAPTURAR');
        assert.equal(op.estado, 'DESCONHECIDA'); assert.ok(op.proxima_tentativa_em > op.atualizado_em);
        assert.deepEqual(await m.recuperar(), []); assert.equal(m.consultas, 1);
        assert.equal(m.sim.chamadas.capturar, 1); assert.doesNotMatch(JSON.stringify(depois), /segredo nao persistir/);
    });
    await t.test('recuperacao contraditoria entra em revisao sem registrar dinheiro', async () => {
        const m = await prepararRecuperacao();
        m.responder((a, r) => normalizarReconciliacaoPagamento({ resultado: { ...r, estado: 'CAPTURADO', capturadoEm: new Date().toISOString() },
            observacao: { evidencia: 'CONTRADITORIA', associacaoOrdem: 'DIVERGENTE', validacao: 'DIVERGENTE',
                statusOrdem: 'COMPLETED', statusCaptura: 'COMPLETED', motivoPendencia: null } }));
        m.avancar(); assert.equal((await m.recuperar())[0].resultado.estado, 'REVISAO');
        const d = await ler(m.pg); assert.equal(String(d.p.capturado_centavos), '0'); assert.equal(d.pedido.pagamento_confirmado_em, null);
        assert.deepEqual(await m.recuperar(), []); assert.equal(m.consultas, 1);
    });
    await t.test('recuperacao de captura tardia conserva revisao e evidencia', async () => {
        const m = await prepararRecuperacao(); m.sim.concluirPendente(m.pg.publicId); m.avancar(1900000);
        assert.equal((await m.recuperar())[0].resultado.estado, 'REVISAO');
        const d = await ler(m.pg); assert.equal(String(d.p.capturado_centavos), '19000');
        assert.equal(d.p.motivo_revisao, 'CAPTURA_TARDIA_OU_INESPERADA'); assert.equal(d.pedido.pagamento_confirmado_em, null);
    });
    await t.test('recuperacao concorrente reserva uma vez e nao mantem locks durante consulta', async () => {
        const m = await prepararRecuperacao(); const entrou = adiar(), liberar = adiar();
        m.responder(async (a, r) => { entrou.resolver(); await liberar.promessa; return envelopeTeste(r); }); m.avancar();
        const primeira = m.recuperar(); await entrou.promessa;
        try { assert.deepEqual(await m.recuperar(m.novo()), []); }
        finally { liberar.resolver(); }
        await primeira; assert.equal(m.consultas, 1); assert.equal(m.sim.chamadas.capturar, 1);
    });
    await t.test('recuperacao com token vencido nao sobrescreve trabalhador posterior', async () => {
        const m = await prepararRecuperacao(); const entrou = adiar(), liberar = adiar(); let n = 0;
        m.responder(async (a, r) => { if (++n === 1) { entrou.resolver(); await liberar.promessa; } return envelopeTeste(r); });
        m.avancar(); const antiga = m.recuperar(); await entrou.promessa; m.avancar();
        m.sim.concluirPendente(m.pg.publicId);
        try { assert.equal((await m.recuperar(m.novo()))[0].resultado.estado, 'CAPTURADO'); }
        finally { liberar.resolver(); }
        const antes = await ler(m.pg); await antiga; assert.deepEqual(await ler(m.pg), antes);
        assert.equal(m.sim.chamadas.capturar, 1);
    });
    await t.test('recuperacao limita dez reservas automaticas e intervalo de um minuto ate uma hora', async () => {
        const m = await prepararRecuperacao(); assert.deepEqual(await m.recuperar(), []);
        for (let i = 0; i < 10; i++) {
            m.avancar(i === 0 ? 61000 : Math.min(3600000, 60000 * 2 ** (i - 1)) + 1000);
            assert.equal((await m.recuperar())[0].resultado.estado, 'PENDENTE');
            assert.deepEqual(await m.recuperar(), []);
        }
        m.avancar(3601000);
        assert.equal((await m.recuperar())[0].resultado.intervencao, 'RECUPERACAO_LIMITE');
        assert.deepEqual(await m.recuperar(), []); assert.equal(m.consultas, 10);
        const d = await ler(m.pg); assert.equal(d.p.estado, 'PENDENTE'); assert.equal(d.p.reserva_ativa, 1);
        assert.equal(d.eventos.filter(e => e.tipo === 'RECUPERACAO_AUTOMATICA').length, 10);
        assert.equal(d.eventos.filter(e => e.tipo === 'RECUPERACAO_INTERVENCAO').length, 1);
        const op = d.operacoes.find(o => o.acao === 'CAPTURAR'); assert.equal(op.tentativas, 11);
        assert.equal(m.sim.chamadas.capturar, 1);
        await assert.rejects(m.service.recuperarPendencias({ limite: 11 }), codigo('SOLICITACAO_INVALIDA'));
    });
    for (const persistiu of [true, false]) await t.test(`recuperacao retoma COMMIT incerto persistiu=${persistiu}`, async () => {
        const m = await prepararRecuperacao(); let falhou = false;
        const db = adaptarPool(c => { let pago = false; return { ...c,
            async query(sql, params) { if (sql.startsWith('UPDATE ist_loja_pedidos') && params[0] === 'PAGO') pago = true; return c.query(sql, params); },
            async commit() { if (pago && !falhou) { falhou = true; if (persistiu) await c.commit(); throw new Error('commit perdido'); } return c.commit(); }
        }; });
        m.sim.concluirPendente(m.pg.publicId); m.avancar(); await m.recuperar(m.novo({ db }));
        if (!persistiu) { assert.equal((await ler(m.pg)).p.estado, 'PENDENTE'); m.avancar(); await m.recuperar(m.novo()); }
        assert.equal((await ler(m.pg)).pedido.estado, 'PAGO'); assert.equal(m.sim.chamadas.capturar, 1);
    });
    await t.test('recuperacao sem ordem sinaliza intervencao e nao recria ordem', async () => {
        const m = await prepararRecuperacao();
        await admin.query('UPDATE ist_loja_pagamentos SET ordem_externa_id=NULL,captura_externa_id=NULL WHERE public_id=?', [m.pg.publicId]);
        m.avancar(); assert.equal((await m.recuperar())[0].resultado.intervencao, 'RECUPERACAO_SEM_ORDEM');
        assert.deepEqual(await m.recuperar(), []); assert.equal(m.consultas, 0); assert.equal(m.sim.chamadas.criar, 1);
    });
    await t.test('recuperacao isola provedor ambiente e recebedor', async () => {
        const m = await prepararRecuperacao(); m.avancar();
        for (const extra of [{ provedor: 'outro' }, { ambiente: 'live' }, { contaRecebedora: 'outro' }]) {
            const outro = m.novo({ contexto: { ...m.contextoAuto, ...extra }, adaptador: {
                criar() { assert.fail(); }, consultar() { assert.fail(); }, capturar() { assert.fail(); }, reconciliar() { assert.fail(); }
            } });
            assert.deepEqual(await outro.recuperarPendencias(), []);
        }
        assert.equal(m.consultas, 0);
    });
    await t.test('recuperacao interrompe lote apos falha de autenticacao', async () => {
        const m = await prepararRecuperacao();
        m.responder(() => { throw criarFalhaPagamento({ categoria: 'AUTENTICACAO', envio: 'NAO_ENVIADO' }); });
        // Segunda pendencia no mesmo contexto, para comprovar interrupcao antes do proximo GET.
        const compra = await novaCompra(), pg = await criar(m.service, compra); m.sim.aprovado(pg.publicId);
        await capturar(m.service, compra, pg); m.avancar();
        const r = await m.recuperar(); assert.equal(r.length, 1); assert.equal(r[0].erro, 'RESULTADO_DESCONHECIDO');
        assert.equal(m.consultas, 1); assert.equal((await ler(pg)).p.estado, 'PENDENTE');
    });

    const webhook = async (m, tipo = 'PAYMENT.CAPTURE.PENDING') => {
        const d = await ler(m.pg);
        const w = { eventoId: `WH-${randomUUID()}`, tipo, ordemId: d.p.ordem_externa_id, capturaId: d.p.captura_externa_id };
        return { ...w, hash: hashPagamento(w) };
    };
    for (const tipo of ['PENDING', 'DENIED']) await t.test(`webhook ${tipo} usa reconciliacao persistida e deduplica com sessao revogada`, async () => {
        const m = await prepararRecuperacao(); const w = await webhook(m, `PAYMENT.CAPTURE.${tipo}`);
        await admin.query('UPDATE ist_loja_sessoes SET revogada_em=criada_em WHERE id=?', [m.compra.sessao.id]);
        await m.service.reconciliarWebhook(w); const antes = await ler(m.pg);
        assert.equal(antes.p.estado, 'PENDENTE'); assert.equal(antes.pedido.pagamento_confirmado_em, null);
        const eventos = antes.eventos.filter(e => e.origem === 'WEBHOOK');
        assert.equal(eventos.length, 1); assert.equal(eventos[0].estado, 'PROCESSADO'); assert.equal(eventos[0].tentativas, 1);
        assert.equal(eventos[0].execucao_token, null);
        await m.service.reconciliarWebhook(w); assert.deepEqual(await ler(m.pg), antes);
        assert.equal(m.consultas, 1); assert.equal(m.sim.chamadas.capturar, 1);
    });
    await t.test('webhook COMPLETED confirma com sessao expirada e evento antigo nao regride pagamento', async () => {
        const m = await prepararRecuperacao(); const w = await webhook(m, 'PAYMENT.CAPTURE.COMPLETED');
        await admin.query('UPDATE ist_loja_sessoes SET expira_em=DATE_ADD(criada_em,INTERVAL 1 SECOND) WHERE id=?', [m.compra.sessao.id]);
        m.avancar(); m.sim.concluirPendente(m.pg.publicId);
        await m.service.reconciliarWebhook(w); const antes = await ler(m.pg);
        assert.equal(antes.p.estado, 'CAPTURADO'); assert.equal(antes.pedido.estado, 'PAGO');
        assert.equal(antes.eventos.find(e => e.evento_id === w.eventoId).estado, 'PROCESSADO');
        await m.service.reconciliarWebhook(await webhook(m)); const depois = await ler(m.pg);
        assert.deepEqual(depois.p, antes.p); assert.deepEqual(depois.pedido, antes.pedido);
        assert.equal(m.consultas, 1); assert.equal(m.sim.chamadas.capturar, 1);
    });
    await t.test('webhook GET temporariamente indisponivel retoma mesmo evento sem duplicar operacao', async () => {
        const m = await prepararRecuperacao(); const w = await webhook(m);
        m.responder(() => { throw new Error('fixture-private'); });
        await assert.rejects(m.service.reconciliarWebhook(w), codigo('RESULTADO_DESCONHECIDO'));
        const antes = await ler(m.pg); assert.equal(antes.p.estado, 'PENDENTE');
        assert.equal(antes.eventos.find(e => e.evento_id === w.eventoId).estado, 'RECEBIDO');
        m.responder(null); await m.service.reconciliarWebhook(w); const depois = await ler(m.pg);
        const e = depois.eventos.filter(e => e.evento_id === w.eventoId);
        assert.equal(e.length, 1); assert.equal(e[0].estado, 'PROCESSADO'); assert.equal(e[0].tentativas, 2);
        assert.deepEqual(depois.operacoes.map(o => o.id), antes.operacoes.map(o => o.id));
        assert.equal(m.sim.chamadas.capturar, 1);
    });
    await t.test('webhook desconhecido ou IDs contraditorios nao modifica pagamento', async () => {
        const m = await prepararRecuperacao(); const w = await webhook(m); const antes = await ler(m.pg);
        for (const extra of [{ ordemId: 'ORDEM-INEXISTENTE', capturaId: 'CAPTURA-INEXISTENTE' }, { capturaId: 'CAPTURA-DIVERGENTE' }]) {
            await assert.rejects(m.service.reconciliarWebhook({ ...w, ...extra }), codigo('RESULTADO_DESCONHECIDO'));
        }
        assert.deepEqual(await ler(m.pg), antes); assert.equal(m.consultas, 0);
    });
    await t.test('webhook concorrente com agendador e duplicata usa mesmo controle de execucao', async () => {
        const m = await prepararRecuperacao(); const w = await webhook(m); const entrou = adiar(), liberar = adiar();
        m.responder(async (a, r) => { entrou.resolver(); await liberar.promessa; return envelopeTeste(r); }); m.avancar();
        const primeiro = m.service.reconciliarWebhook(w); await entrou.promessa;
        try {
            await assert.rejects(m.service.reconciliarWebhook(w), codigo('OPERACAO_EM_ANDAMENTO'));
            assert.deepEqual(await m.recuperar(m.novo()), []);
        } finally { liberar.resolver(); }
        await primeiro; assert.equal(m.consultas, 1); assert.equal(m.sim.chamadas.capturar, 1);
        const e = (await ler(m.pg)).eventos.filter(e => e.origem === 'WEBHOOK'); assert.equal(e.length, 1);
    });
    await t.test('webhook finalizacao e quitacao revertem juntas em falha SQL e reentrega recupera', async () => {
        const m = await prepararRecuperacao(); const w = await webhook(m, 'PAYMENT.CAPTURE.COMPLETED'); let falhou = false;
        const db = adaptarPool(c => ({ ...c, async query(sql, params) {
            if (!falhou && sql.startsWith('UPDATE ist_loja_pagamento_eventos') && params[0] === 'PROCESSADO') {
                falhou = true; throw new Error('falha SQL simulada');
            }
            return c.query(sql, params);
        } }));
        m.sim.concluirPendente(m.pg.publicId);
        await assert.rejects(m.novo({ db }).reconciliarWebhook(w), codigo('RESULTADO_DESCONHECIDO'));
        const antes = await ler(m.pg); assert.equal(antes.p.estado, 'PENDENTE'); assert.equal(antes.pedido.pagamento_confirmado_em, null);
        assert.equal(antes.eventos.find(e => e.evento_id === w.eventoId).estado, 'RECEBIDO');
        await m.service.reconciliarWebhook(w); assert.equal((await ler(m.pg)).pedido.estado, 'PAGO');
        assert.equal(m.sim.chamadas.capturar, 1);
    });

    await t.test('cria tentativa e operacao antes da chamada, usando somente total persistido', async () => {
        const compra = await novaCompra();
        const { sim, service } = montar({ aoChamar: async (metodo, args) => {
            if (metodo !== 'criar') return;
            const [[r]] = await admin.query(`SELECT p.estado,o.estado AS operacao,o.request_id_provedor FROM ist_loja_pagamentos p
                JOIN ist_loja_pagamento_operacoes o ON o.pagamento_id=p.id WHERE p.public_id=?`, [args.referencia]);
            assert.equal(r.estado, 'CRIANDO'); assert.equal(r.operacao, 'EM_EXECUCAO');
            assert.equal(r.request_id_provedor, args.requestId); assert.equal(args.valorCentavos, '19000');
        } });
        const r = await criar(service, compra); assert.equal(r.estado, 'AGUARDANDO_APROVACAO'); assert.equal(r.valorCentavos, 19000);
        assert.equal(r.pedidoEstado, 'AGUARDANDO_PAGAMENTO'); assert.equal(sim.chamadas.criar, 1);
        const dados = await ler(r); assert.equal(dados.p.reserva_ativa, 1); assert.equal(dados.operacoes[0].estado, 'SUCESSO');
    });
    await t.test('rejeita campos financeiros do chamador e nao chama adaptador', async () => {
        const compra = await novaCompra(); const { sim, service } = montar();
        await assert.rejects(service.criarTentativa(compra.sessao, { pedidoPublicId: compra.pedidoPublicId, valorCentavos: 1 }, randomUUID()), codigo('SOLICITACAO_INVALIDA'));
        assert.equal(sim.chamadas.criar, 0);
    });
    await t.test('pedido inexistente e pedido de outra sessao sao indistinguiveis', async () => {
        const a = await novaCompra(); const b = await novaCompra(); const { sim, service } = montar();
        await assert.rejects(service.criarTentativa(a.sessao, { pedidoPublicId: randomUUID() }, randomUUID()), codigo('PEDIDO_NAO_ENCONTRADO'));
        await assert.rejects(service.criarTentativa(b.sessao, { pedidoPublicId: a.pedidoPublicId }, randomUUID()), codigo('PEDIDO_NAO_ENCONTRADO'));
        assert.equal(sim.chamadas.criar, 0);
    });
    await t.test('sessao revogada ou expirada rejeitada sob bloqueio', async () => {
        for (const acao of ['revogada', 'expirada']) {
            const compra = await novaCompra(); const { service } = montar();
            if (acao === 'revogada') await admin.query('UPDATE ist_loja_sessoes SET revogada_em=criada_em WHERE id=?', [compra.sessao.id]);
            else await admin.query('UPDATE ist_loja_sessoes SET expira_em=DATE_ADD(criada_em, INTERVAL 1000 MICROSECOND) WHERE id=?', [compra.sessao.id]);
            await assert.rejects(criar(service, compra), codigo('SESSAO_INVALIDA'));
        }
    });
    for (const opcoes of [{ expirado: true }, { estado: 'PAGO' }, { estado: 'REVISAO' }, { estado: 'CANCELADO' }, { ambiente: 'live' }]) {
        await t.test(`pedido indisponivel: ${JSON.stringify(opcoes)}`, async () => {
            const compra = await novaCompra(opcoes); const { sim, service } = montar();
            await assert.rejects(criar(service, compra), codigo(opcoes.expirado ? 'PEDIDO_EXPIRADO' : 'PEDIDO_INDISPONIVEL'));
            assert.equal(sim.chamadas.criar, 0);
        });
    }
    await t.test('repeticao da criacao nao grava novamente nem chama provedor', async () => {
        const compra = await novaCompra(); const { sim, service } = montar(); const chave = randomUUID();
        const pg = await criar(service, compra, chave); const antes = await ler(pg);
        assert.deepEqual(await criar(service, compra, chave), pg); assert.deepEqual(await ler(pg), antes);
        assert.equal(sim.chamadas.criar, 1);
    });
    await t.test('mesma chave com contexto divergente conflita', async () => {
        const compra = await novaCompra(); const chave = randomUUID(); const { service } = montar();
        await criar(service, compra, chave);
        const outro = montar({ contexto: { ...contexto, contaRecebedora: 'outra-conta' } });
        await assert.rejects(criar(outro.service, compra, chave), codigo('CONFLITO_IDEMPOTENCIA'));
        assert.equal(outro.sim.chamadas.criar, 0);
    });
    await t.test('duas tentativas concorrentes com chaves diferentes reservam apenas uma', async () => {
        const compra = await novaCompra(); const { sim, service } = montar();
        const r = await Promise.allSettled([criar(service, compra), criar(service, compra)]);
        assert.equal(r.filter(r => r.status === 'fulfilled').length, 1);
        assert.equal(r.find(r => r.status === 'rejected').reason.codigo, 'TENTATIVA_ATIVA');
        const [[n]] = await admin.query('SELECT COUNT(*) AS n FROM ist_loja_pagamentos WHERE pedido_id=?', [compra.pedidoId]);
        assert.equal(Number(n.n), 1); assert.equal(sim.chamadas.criar, 1);
    });
    await t.test('mesma chave concorrente nao duplica chamada de criacao', async () => {
        const compra = await novaCompra(); const { sim, service } = montar(); const chave = randomUUID();
        const respostas = await Promise.allSettled([criar(service, compra, chave), criar(service, compra, chave)]);
        assert.ok(respostas.some(r => r.status === 'fulfilled'));
        for (const r of respostas.filter(r => r.status === 'rejected')) assert.equal(r.reason.codigo, 'OPERACAO_EM_ANDAMENTO');
        assert.equal(sim.chamadas.criar, 1);
    });
    await t.test('captura sem aprovacao nao envia chamada financeira; mesma chave pode tentar apos aprovacao', async () => {
        const compra = await novaCompra(); const { sim, service } = montar(); const pg = await criar(service, compra); const chave = randomUUID();
        await assert.rejects(capturar(service, compra, pg, chave), codigo('APROVACAO_PENDENTE'));
        assert.equal(sim.chamadas.capturar, 0); assert.equal((await ler(pg)).operacoes[1].estado, 'PREPARADA');
        sim.aprovado(pg.publicId); assert.equal((await capturar(service, compra, pg, chave)).estado, 'CAPTURADO');
    });
    await t.test('reconciliacao confirma aprovacao sem capturar', async () => {
        const compra = await novaCompra(); const { sim, service } = montar(); const pg = await criar(service, compra);
        sim.aprovado(pg.publicId); assert.equal((await reconciliar(service, compra, pg)).estado, 'APROVADO');
        assert.equal(sim.chamadas.capturar, 0);
    });
    await t.test('captura integral, estado PAGO e evidencia sao atomicos; replay nao recaptura', async () => {
        const compra = await novaCompra(); const { sim, service } = montar(); const pg = await criar(service, compra); sim.aprovado(pg.publicId);
        const chave = randomUUID(); const r = await capturar(service, compra, pg, chave); const dados = await ler(pg);
        assert.equal(r.estado, 'CAPTURADO'); assert.equal(r.pedidoEstado, 'PAGO'); assert.ok(r.pagamentoConfirmadoEm);
        assert.equal(dados.p.reserva_ativa, null); assert.equal(String(dados.p.capturado_centavos), '19000'); assert.equal(dados.operacoes[1].estado, 'SUCESSO');
        assert.deepEqual(await capturar(service, compra, pg, chave), r);
        assert.equal(sim.chamadas.capturar, 1); assert.equal(sim.efeitosCaptura, 1);
        await assert.rejects(capturar(service, compra, pg), codigo('CONFLITO_IDEMPOTENCIA'));
        await assert.rejects(criar(service, compra), codigo('PEDIDO_INDISPONIVEL'));
    });
    await t.test('captura e consulta nao sao autorizadas por UUID publico sozinho', async () => {
        const a = await novaCompra(); const b = await novaCompra(); const { sim, service } = montar(); const pg = await criar(service, a);
        await assert.rejects(capturar(service, b, pg), codigo('PEDIDO_NAO_ENCONTRADO'));
        await assert.rejects(reconciliar(service, b, pg), codigo('PEDIDO_NAO_ENCONTRADO')); assert.equal(sim.chamadas.capturar, 0);
    });
    await t.test('captura pendente retém reserva e reconciliacao posterior confirma', async () => {
        const compra = await novaCompra(); const { sim, service } = montar(); const pg = await criar(service, compra); sim.aprovado(pg.publicId); sim.modos.captura = 'pendente';
        assert.equal((await capturar(service, compra, pg)).estado, 'PENDENTE');
        let dados = await ler(pg); assert.equal(dados.p.reserva_ativa, 1); assert.notEqual(dados.pedido.estado, 'PAGO');
        await assert.rejects(criar(service, compra), codigo('TENTATIVA_ATIVA'));
        sim.concluirPendente(pg.publicId); assert.equal((await reconciliar(service, compra, pg)).estado, 'CAPTURADO');
        assert.equal(sim.chamadas.capturar, 1);
    });
    await t.test('MariaDB: falha GET na reconciliacao preserva PENDENTE e Capture ID sem nova operacao', async () => {
        const compra = await novaCompra(); const { sim, service } = montar();
        const pg = await criar(service, compra); sim.aprovado(pg.publicId); sim.modos.captura = 'pendente';
        assert.equal((await capturar(service, compra, pg)).estado, 'PENDENTE');
        const antes = await ler(pg);
        assert.equal(antes.p.estado, 'PENDENTE');
        assert.ok(antes.p.ordem_externa_id); assert.ok(antes.p.captura_externa_id);
        assert.equal(String(antes.p.valor_centavos), '19000'); assert.equal(antes.p.moeda, 'BRL');
        const chamadasAntes = { ...sim.chamadas }; let consultas = 0;
        const s = criarServico({ db: pool, contexto, adaptador: { ...sim.adaptador, async consultar(args) {
            consultas++;
            assert.equal(args.ordemId, antes.p.ordem_externa_id);
            assert.equal(args.capturaId, antes.p.captura_externa_id);
            throw new Error('falha GET simulada');
        } } });
        await assert.rejects(reconciliar(s, compra, pg), codigo('RESULTADO_DESCONHECIDO'));
        const depois = await ler(pg);
        assert.equal(consultas, 1);
        assert.equal(depois.p.estado, 'PENDENTE'); assert.equal(depois.p.reserva_ativa, 1);
        assert.equal(depois.p.ordem_externa_id, antes.p.ordem_externa_id);
        assert.equal(depois.p.captura_externa_id, antes.p.captura_externa_id);
        assert.equal(String(depois.p.valor_centavos), String(antes.p.valor_centavos));
        assert.equal(depois.p.moeda, antes.p.moeda);
        assert.equal(String(depois.p.capturado_centavos), '0'); assert.equal(depois.p.capturado_em, null);
        assert.equal(depois.pedido.estado, antes.pedido.estado); assert.notEqual(depois.pedido.estado, 'PAGO');
        assert.equal(depois.pedido.pagamento_confirmado_em, null);
        assert.deepEqual(sim.chamadas, chamadasAntes); assert.equal(sim.efeitosCaptura, 0);
        assert.deepEqual(depois.operacoes.map(o => [o.id, o.acao, o.chave_idempotencia, o.request_id_provedor]),
            antes.operacoes.map(o => [o.id, o.acao, o.chave_idempotencia, o.request_id_provedor]));
        const op = depois.operacoes.find(o => o.acao === 'CAPTURAR');
        assert.equal(op.estado, 'DESCONHECIDA'); assert.equal(op.execucao_token, null); assert.equal(op.execucao_ate, null);
        assert.equal(op.tentativas, antes.operacoes.find(o => o.id === op.id).tentativas + 1);
        assert.deepEqual(depois.eventos.slice(0, antes.eventos.length), antes.eventos);
        assert.equal(depois.eventos.length, antes.eventos.length + 1);
        const evento = depois.eventos.at(-1);
        assert.equal(evento.origem, 'RECONCILIACAO'); assert.equal(evento.tipo, 'RESULTADO_DESCONHECIDO');
        assert.deepEqual(evento.conteudo_hash, hashPagamento(JSON.parse(evento.evidencia_json)));
        assert.doesNotMatch(evento.evidencia_json, /falha GET simulada/);
    });
    await t.test('MariaDB: envelope contraditorio bloqueia captura favoravel e revisao repetida e idempotente', async () => {
        const compra = await novaCompra(); const { sim, service } = montar(); const pg = await criar(service, compra);
        const antes = await ler(pg); let consultas = 0;
        const observacao = { evidencia: 'CONTRADITORIA', associacaoOrdem: 'DIVERGENTE', validacao: 'DIVERGENTE',
            statusOrdem: 'COMPLETED', statusCaptura: 'COMPLETED', motivoPendencia: null };
        const adaptador = { ...sim.adaptador, async reconciliar(args) {
            consultas++;
            assert.equal(args.ordemId, antes.p.ordem_externa_id);
            const ordem = await sim.adaptador.consultar(args);
            return normalizarReconciliacaoPagamento({ resultado: { ...ordem, estado: 'CAPTURADO',
                capturaId: `captura-contraditoria-${pg.publicId}`, capturadoEm: new Date().toISOString() }, observacao });
        } };
        const s = criarLojaPagamentoService({ db: pool, contexto, adaptador });
        const resultado = await reconciliar(s, compra, pg); const depois = await ler(pg);
        assert.equal(resultado.estado, 'REVISAO'); assert.equal(resultado.pedidoEstado, 'REVISAO');
        assert.equal(depois.p.motivo_revisao, 'EVIDENCIA_RECONCILIACAO_DIVERGENTE');
        assert.equal(depois.pedido.motivo_revisao, depois.p.motivo_revisao);
        assert.equal(depois.p.reserva_ativa, 1); assert.equal(String(depois.p.capturado_centavos), '0');
        assert.equal(depois.p.capturado_em, null); assert.equal(depois.p.captura_externa_id, null);
        assert.equal(depois.p.ordem_externa_id, antes.p.ordem_externa_id);
        assert.equal(depois.pedido.pagamento_confirmado_em, null);
        assert.equal(sim.chamadas.capturar, 0); assert.equal(sim.efeitosCaptura, 0);
        assert.deepEqual(depois.operacoes.map(o => o.id), antes.operacoes.map(o => o.id));
        assert.equal(depois.operacoes[0].estado, 'REVISAO'); assert.equal(depois.operacoes[0].execucao_token, null);
        assert.equal(depois.operacoes[0].execucao_ate, null);
        assert.deepEqual(JSON.parse(depois.operacoes[0].resultado_json).observacao, observacao);
        assert.deepEqual(depois.eventos.slice(0, antes.eventos.length), antes.eventos);
        const revisao = depois.eventos.find(e => e.tipo === 'REVISAO_FINANCEIRA');
        assert.ok(revisao); assert.equal(JSON.parse(revisao.evidencia_json).motivo, depois.p.motivo_revisao);
        assert.deepEqual(revisao.conteudo_hash, hashPagamento(JSON.parse(revisao.evidencia_json)));
        assert.deepEqual(await reconciliar(s, compra, pg), resultado);
        assert.deepEqual(await ler(pg), depois);
        assert.equal(consultas, 1); assert.equal(sim.chamadas.capturar, 0); assert.equal(sim.chamadas.criar, 1);
    });
    await t.test('recusa definitiva libera reserva, conserva evidencia e permite nova tentativa', async () => {
        const compra = await novaCompra(); const { sim, service } = montar(); const pg = await criar(service, compra); sim.aprovado(pg.publicId); sim.modos.captura = 'recusada';
        assert.equal((await capturar(service, compra, pg)).estado, 'RECUSADO');
        const dados = await ler(pg); assert.equal(dados.p.reserva_ativa, null); assert.notEqual(dados.pedido.estado, 'PAGO');
        assert.notEqual((await criar(service, compra)).publicId, pg.publicId);
    });
    for (const modo of ['timeoutAntes', 'respostaPerdida']) await t.test(`criacao com ${modo} nunca repete chamada financeira`, async () => {
        const compra = await novaCompra(); const { sim, service } = montar(); const chave = randomUUID(); sim.modos.criacao = modo;
        await assert.rejects(criar(service, compra, chave), codigo('RESULTADO_DESCONHECIDO'));
        const [[p]] = await admin.query('SELECT public_id FROM ist_loja_pagamentos WHERE pedido_id=?', [compra.pedidoId]);
        const r = await criar(service, compra, chave);
        assert.equal(r.estado, modo === 'respostaPerdida' ? 'AGUARDANDO_APROVACAO' : 'DESCONHECIDO');
        assert.equal(sim.chamadas.criar, 1); assert.equal((await ler({ publicId: p.public_id })).p.reserva_ativa, 1);
    });
    for (const modo of ['timeoutAntes', 'respostaPerdida', 'semResposta']) await t.test(`captura com ${modo} preserva request_id e nao recaptura`, async () => {
        const compra = await novaCompra(); const { sim, service } = montar({ timeoutMs: 50, execucaoMs: 1000 });
        const pg = await criar(service, compra); sim.aprovado(pg.publicId); sim.modos.captura = modo; const chave = randomUUID();
        await assert.rejects(capturar(service, compra, pg, chave), codigo('RESULTADO_DESCONHECIDO'));
        const dados = await ler(pg); assert.equal(dados.p.estado, 'DESCONHECIDO'); assert.equal(dados.operacoes[1].estado, 'DESCONHECIDA');
        const r = await capturar(service, compra, pg, chave);
        assert.equal(r.estado, modo === 'respostaPerdida' ? 'CAPTURADO' : 'DESCONHECIDO');
        assert.equal((await ler(pg)).operacoes[1].request_id_provedor, dados.operacoes[1].request_id_provedor);
        assert.equal(sim.chamadas.capturar, 1); assert.equal(sim.efeitosCaptura, modo === 'respostaPerdida' ? 1 : 0);
    });
    for (const modo of ['valorDivergente', 'moedaDivergente', 'recebedorDivergente']) await t.test(`divergencia ${modo} fica em revisao, nunca PAGO`, async () => {
        const compra = await novaCompra(); const { sim, service } = montar(); const pg = await criar(service, compra); sim.aprovado(pg.publicId); sim.modos.captura = modo;
        assert.equal((await capturar(service, compra, pg)).estado, 'REVISAO');
        const dados = await ler(pg); assert.equal(dados.pedido.estado, 'REVISAO'); assert.equal(dados.pedido.pagamento_confirmado_em, null);
        assert.equal(dados.p.reserva_ativa, 1); assert.equal(dados.operacoes[1].estado, 'REVISAO');
        assert.ok(dados.eventos.some(e => JSON.parse(e.evidencia_json).motivo === 'DIVERGENCIA_FINANCEIRA'));
        await assert.rejects(criar(service, compra), codigo('PEDIDO_INDISPONIVEL'));
    });
    await t.test('nenhuma transacao SQL aberta nas chamadas ao adaptador', async () => {
        let abertas = 0;
        const db = adaptarPool(c => { let aberta = false; return { ...c,
            async beginTransaction() { await c.beginTransaction(); aberta = true; abertas++; },
            async commit() { await c.commit(); if (aberta) { aberta = false; abertas--; } },
            async rollback() { await c.rollback(); if (aberta) { aberta = false; abertas--; } }
        }; });
        const compra = await novaCompra(); const { sim, service } = montar({ db, aoChamar: async () => { assert.equal(abertas, 0); } });
        const pg = await criar(service, compra); sim.aprovado(pg.publicId); await capturar(service, compra, pg); assert.equal(abertas, 0);
    });
    await t.test('capturas simultaneas da mesma operacao nao duplicam execucao externa', async () => {
        const entrou = adiar(); const liberar = adiar(); const compra = await novaCompra();
        const { sim, service } = montar({ aoChamar: async m => { if (m === 'capturar') { entrou.resolver(); await liberar.promessa; } } });
        const pg = await criar(service, compra); sim.aprovado(pg.publicId); const chave = randomUUID();
        const primeira = capturar(service, compra, pg, chave); await entrou.promessa;
        try { await assert.rejects(capturar(service, compra, pg, chave), codigo('OPERACAO_EM_ANDAMENTO')); }
        finally { liberar.resolver(); }
        await primeira; assert.equal(sim.chamadas.capturar, 1); assert.equal(sim.efeitosCaptura, 1);
    });
    await t.test('lease vencida consulta somente; trabalhador antigo nao sobrescreve reconciliacao', async () => {
        let instante = Date.now(); const agora = () => new Date(instante); const entrou = adiar(); const liberar = adiar();
        const compra = await novaCompra(); const { sim, service } = montar({ agora, execucaoMs: 2000,
            aoChamar: async m => { if (m === 'capturar') { entrou.resolver(); await liberar.promessa; } } });
        const pg = await criar(service, compra); sim.aprovado(pg.publicId); const chave = randomUUID();
        const primeira = assert.rejects(capturar(service, compra, pg, chave), codigo('RESULTADO_DESCONHECIDO')); await entrou.promessa;
        instante += 3000;
        try { assert.equal((await capturar(service, compra, pg, chave)).estado, 'DESCONHECIDO'); }
        finally { liberar.resolver(); }
        await primeira;
        assert.equal((await reconciliar(service, compra, pg)).estado, 'CAPTURADO');
        assert.equal(sim.chamadas.capturar, 1); assert.equal(sim.efeitosCaptura, 1);
    });
    await t.test('captura tardia registra dinheiro e REVISAO sem reabrir pedido', async () => {
        let instante = Date.now(); const agora = () => new Date(instante);
        const compra = await novaCompra(); const { sim, service } = montar({ agora }); const pg = await criar(service, compra); sim.aprovado(pg.publicId);
        sim.modos.captura = 'respostaPerdida'; await assert.rejects(capturar(service, compra, pg), codigo('RESULTADO_DESCONHECIDO'));
        instante += 1900000;
        assert.equal((await reconciliar(service, compra, pg)).estado, 'REVISAO');
        const dados = await ler(pg); assert.equal(String(dados.p.capturado_centavos), '19000'); assert.ok(dados.p.captura_externa_id);
        assert.equal(dados.pedido.estado, 'REVISAO'); assert.equal(dados.pedido.pagamento_confirmado_em, null);
    });
    await t.test('falha parcial de gravacao reverte PAGO e captura local; reconciliacao recupera', async () => {
        let falhar = true;
        const db = adaptarPool(c => ({ ...c, async query(sql, params) {
            if (falhar && sql.startsWith('UPDATE ist_loja_pedidos') && params[0] === 'PAGO') { falhar = false; throw new Error('falha SQL fixture'); }
            return c.query(sql, params);
        } }));
        const compra = await novaCompra(); const { sim, service } = montar({ db }); const pg = await criar(service, compra); sim.aprovado(pg.publicId);
        await assert.rejects(capturar(service, compra, pg), codigo('RESULTADO_DESCONHECIDO'));
        const dados = await ler(pg); assert.notEqual(dados.pedido.estado, 'PAGO'); assert.equal(dados.p.captura_externa_id, null);
        assert.equal((await reconciliar(service, compra, pg)).estado, 'CAPTURADO'); assert.equal(sim.efeitosCaptura, 1);
    });
    for (const persistiu of [true, false]) await t.test(`COMMIT da captura incerto com persistencia=${persistiu}`, async () => {
        let falhou = false;
        const db = adaptarPool(c => { let confirmarPago = false; return { ...c,
            async query(sql, params) { if (sql.startsWith('UPDATE ist_loja_pedidos') && params[0] === 'PAGO') confirmarPago = true; return c.query(sql, params); },
            async commit() {
                if (confirmarPago && !falhou) { falhou = true; if (persistiu) await c.commit(); throw new Error('confirmacao perdida'); }
                return c.commit();
            }
        }; });
        const compra = await novaCompra(); const { sim, service } = montar({ db }); const pg = await criar(service, compra); sim.aprovado(pg.publicId); const chave = randomUUID();
        if (persistiu) assert.equal((await capturar(service, compra, pg, chave)).estado, 'CAPTURADO');
        else await assert.rejects(capturar(service, compra, pg, chave), codigo('RESULTADO_DESCONHECIDO'));
        assert.equal((await capturar(service, compra, pg, chave)).estado, 'CAPTURADO'); assert.equal(sim.efeitosCaptura, 1);
    });
    await t.test('dados privados do adaptador sao descartados de DTO, operacoes e eventos', async () => {
        const compra = await novaCompra(); const sim = criarPagamentoSimulado();
        const adaptador = { ...sim.adaptador, async criar(args) { return { ...await sim.adaptador.criar(args), access_token: 'SEGREDO_FIXTURE', cartao: 'PAN_FIXTURE' }; } };
        const service = criarServico({ db: pool, contexto, adaptador }); const pg = await criar(service, compra);
        const conteudo = JSON.stringify({ pg, dados: await ler(pg) }); assert.doesNotMatch(conteudo, /SEGREDO_FIXTURE|PAN_FIXTURE/);
        assert.doesNotMatch(JSON.stringify(pg), /request_id|recebedor|solicitacao_hash|ordem_externa|comprador_email|execucao_token/);
    });
    for (const falha of [null, Object.assign(new Error('segredo externo'), { codigo: 'APROVACAO_PENDENTE' })]) {
        await t.test(`excecao arbitraria do adaptador nao simula erro de dominio: ${falha === null ? 'null' : 'codigo'}`, async () => {
            const compra = await novaCompra(); const sim = criarPagamentoSimulado();
            const service = criarServico({ db: pool, contexto, adaptador: { ...sim.adaptador, async criar() { throw falha; } } });
            await assert.rejects(criar(service, compra), e => e.codigo === 'RESULTADO_DESCONHECIDO' && !e.message.includes('segredo externo'));
            const [[p]] = await admin.query('SELECT estado,reserva_ativa FROM ist_loja_pagamentos WHERE pedido_id=?', [compra.pedidoId]);
            assert.equal(p.estado, 'DESCONHECIDO'); assert.equal(p.reserva_ativa, 1);
        });
    }
    for (const estado of ['CANCELADO', 'EXPIRADO']) await t.test(`encerramento externo definitivo ${estado} libera somente a tentativa`, async () => {
        const compra = await novaCompra(); const sim = criarPagamentoSimulado();
        // Este cenario declara encerramento definitivo da ordem, nao ausencia de captura como prova.
        // O helper generico conserva INCONCLUSIVA quando nao ha Capture ID.
        const observacao = { evidencia: 'PRESENTE', associacaoOrdem: 'CONFIRMADA', validacao: 'CONSISTENTE',
            statusOrdem: 'VOIDED', statusCaptura: null, motivoPendencia: null };
        const adaptador = { ...sim.adaptador, async reconciliar(args) {
            const resultado = await sim.adaptador.consultar(args);
            assert.equal(resultado.estado, estado);
            assert.equal(resultado.referencia, args.referencia);
            assert.equal(resultado.ordemId, args.ordemId);
            assert.equal(resultado.capturaId, null);
            assert.equal(resultado.capturadoEm, null);
            return normalizarReconciliacaoPagamento({ resultado, observacao });
        } };
        const service = criarLojaPagamentoService({ db: pool, contexto, adaptador });
        const pg = await criar(service, compra);
        sim.encerrar(pg.publicId, estado); assert.equal((await reconciliar(service, compra, pg)).estado, estado);
        const dados = await ler(pg); assert.equal(dados.p.reserva_ativa, null); assert.notEqual(dados.pedido.estado, 'PAGO');
        assert.equal(dados.pedido.pagamento_confirmado_em, null);
        assert.equal(String(dados.p.capturado_centavos), '0');
        assert.equal(dados.p.captura_externa_id, null);
        assert.equal(sim.chamadas.capturar, 0);
        assert.deepEqual(JSON.parse(dados.operacoes[0].resultado_json).observacao, observacao);
    });
    await t.test('alteracao inesperada do total do pedido impede captura e vai para revisao', async () => {
        const compra = await novaCompra(); const { sim, service } = montar(); const pg = await criar(service, compra); sim.aprovado(pg.publicId);
        await admin.query('UPDATE ist_loja_pedidos SET total_centavos=20000 WHERE id=?', [compra.pedidoId]);
        assert.equal((await capturar(service, compra, pg)).estado, 'REVISAO');
        assert.equal(sim.chamadas.capturar, 0); assert.equal((await ler(pg)).pedido.motivo_revisao, 'PEDIDO_DIVERGENTE');
    });
    await t.test('colisao de ID externo nao e replay e preserva evidencia em revisao', async () => {
        const a = await novaCompra(); const b = await novaCompra(); const sim = criarPagamentoSimulado(); let ordemAnterior;
        const adaptador = { ...sim.adaptador, async criar(args) {
            const r = await sim.adaptador.criar(args);
            if (!ordemAnterior) ordemAnterior = r.ordemId;
            return { ...r, ordemId: ordemAnterior };
        } };
        const service = criarServico({ db: pool, contexto, adaptador }); await criar(service, a);
        const pg = await criar(service, b); assert.equal(pg.estado, 'REVISAO'); const dados = await ler(pg);
        assert.equal(dados.p.ordem_externa_id, null); assert.equal(dados.pedido.estado, 'REVISAO');
        assert.ok(dados.eventos.some(e => JSON.parse(e.evidencia_json).motivo === 'IDENTIFICADOR_EXTERNO_DUPLICADO'));
    });
    await t.test('reuso da chave de captura em outra tentativa do pedido conflita', async () => {
        const compra = await novaCompra(); const { sim, service } = montar(); const pg = await criar(service, compra); sim.aprovado(pg.publicId);
        sim.modos.captura = 'recusada'; const chave = randomUUID(); await capturar(service, compra, pg, chave);
        const outro = await criar(service, compra); sim.aprovado(outro.publicId);
        await assert.rejects(capturar(service, compra, outro, chave), codigo('CONFLITO_IDEMPOTENCIA')); assert.equal(sim.chamadas.capturar, 1);
    });
    await t.test('revogacao durante chamada externa nao impede registrar captura autorizada anteriormente', async () => {
        const compra = await novaCompra(); const { sim, service } = montar({ aoChamar: async m => {
            if (m === 'capturar') await admin.query('UPDATE ist_loja_sessoes SET revogada_em=criada_em WHERE id=?', [compra.sessao.id]);
        } });
        const pg = await criar(service, compra); sim.aprovado(pg.publicId);
        assert.equal((await capturar(service, compra, pg)).estado, 'CAPTURADO'); assert.equal((await ler(pg)).pedido.estado, 'PAGO');
        await assert.rejects(reconciliar(service, compra, pg), codigo('SESSAO_INVALIDA'));
    });
    for (const permanente of [false, true]) await t.test(`deadlock simulado tem retry limitado, permanente=${permanente}`, async () => {
        let erros = 0;
        const db = adaptarPool(c => ({ ...c, async query(sql, params) {
            if (sql.includes('FROM ist_loja_sessoes') && (permanente || erros === 0)) {
                erros++; throw Object.assign(new Error('deadlock fixture'), { errno: 1213, code: 'ER_LOCK_DEADLOCK' });
            }
            return c.query(sql, params);
        } }));
        const compra = await novaCompra(); const { sim, service } = montar({ db });
        if (permanente) { await assert.rejects(criar(service, compra), codigo('RESULTADO_DESCONHECIDO')); assert.equal(erros, 3); assert.equal(sim.chamadas.criar, 0); }
        else { assert.equal((await criar(service, compra)).estado, 'AGUARDANDO_APROVACAO'); assert.equal(erros, 1); assert.equal(sim.chamadas.criar, 1); }
    });
    await t.test('conexao devolvida com transacao aberta e descartada antes de ler dados', async () => {
        let descartadas = 0; let entregues = 0; let liberadas = 0;
        const db = { async getConnection() {
            const c = await pool.getConnection(); entregues++;
            await c.beginTransaction(); await c.query('SELECT id FROM ist_loja_sessoes LIMIT 1 FOR UPDATE');
            return { query: (...args) => c.query(...args), beginTransaction: () => c.beginTransaction(), commit: () => c.commit(), rollback: () => c.rollback(),
                destroy() { descartadas++; c.destroy(); }, release() { liberadas++; c.release(); } };
        } };
        const compra = await novaCompra(); const { sim, service } = montar({ db });
        await assert.rejects(criar(service, compra), codigo('ERRO_INTERNO'));
        assert.equal(entregues, 1); assert.equal(descartadas, 1); assert.equal(liberadas, 0); assert.equal(sim.chamadas.criar, 0);
    });
    await t.test('ID parcial persiste e nova instancia reconcilia sem nova criacao', async () => {
        const compra = await novaCompra(); const chave = randomUUID(); let criacoes = 0; let consultas = 0;
        const adaptador = {
            async criar(args) { criacoes++; return { estado: 'DESCONHECIDO', referencia: args.referencia, ambiente: args.ambiente, ordemId: 'ordem-parcial-reinicio' }; },
            async consultar(args) {
                consultas++; assert.equal(args.ordemId, 'ordem-parcial-reinicio');
                return { estado: 'AGUARDANDO_APROVACAO', referencia: args.referencia, ambiente: args.ambiente,
                    ordemId: args.ordemId, capturaId: null, capturadoEm: null,
                    valorCentavos: '19000', moeda: 'BRL', contaRecebedora: contexto.contaRecebedora };
            },
            async capturar() { assert.fail('nao capturar'); }
        };
        const s = () => criarServico({ db: pool, contexto, adaptador });
        const pg = await criar(s(), compra, chave); let dados = await ler(pg);
        assert.equal(pg.estado, 'DESCONHECIDO'); assert.equal(dados.p.ordem_externa_id, 'ordem-parcial-reinicio');
        assert.equal(dados.p.reserva_ativa, 1); assert.equal(dados.operacoes[0].estado, 'DESCONHECIDA');
        assert.equal(JSON.parse(dados.operacoes[0].resultado_json).valorCentavos, null);
        await assert.rejects(criar(s(), compra), codigo('TENTATIVA_ATIVA'));
        assert.equal((await criar(s(), compra, chave)).estado, 'AGUARDANDO_APROVACAO');
        assert.equal(criacoes, 1); assert.equal(consultas, 1);
        dados = await ler(pg); assert.equal(dados.pedido.pagamento_confirmado_em, null);
    });
    for (const campo of ['ordemId', 'referencia', 'contaRecebedora', 'ambiente']) await t.test(`parcial com ${campo} divergente exige revisao`, async () => {
        const compra = await novaCompra(); const { sim, service } = montar(); const pg = await criar(service, compra);
        const antes = await ler(pg);
        const adaptador = { ...sim.adaptador, async consultar(args) {
            return { estado: 'DESCONHECIDO', referencia: args.referencia, ambiente: args.ambiente,
                ordemId: args.ordemId, [campo]: campo === 'ambiente' ? 'live' : 'divergente' };
        } };
        const s = criarServico({ db: pool, contexto, adaptador });
        assert.equal((await reconciliar(s, compra, pg)).estado, 'REVISAO');
        const dados = await ler(pg); assert.equal(dados.p.ordem_externa_id, antes.p.ordem_externa_id);
        assert.equal(dados.p.reserva_ativa, 1); assert.notEqual(dados.pedido.estado, 'PAGO');
    });
    await t.test('colisao UNIQUE entre IDs parciais bloqueia a segunda tentativa para revisao', async () => {
        const adaptador = { async criar(args) { return { estado: 'DESCONHECIDO', referencia: args.referencia,
            ambiente: args.ambiente, ordemId: 'ordem-parcial-colisao' }; }, async consultar() {}, async capturar() {} };
        const s = criarServico({ db: pool, contexto, adaptador });
        await criar(s, await novaCompra()); const compra = await novaCompra(); const pg = await criar(s, compra);
        const dados = await ler(pg); assert.equal(pg.estado, 'REVISAO'); assert.equal(dados.p.ordem_externa_id, null);
        assert.equal(dados.p.reserva_ativa, 1); assert.equal(dados.p.motivo_revisao, 'IDENTIFICADOR_EXTERNO_DUPLICADO');
    });
    for (const [categoria, envio] of [['OPERACAO', 'NAO_ENVIADO'], ['INFRAESTRUTURA', 'ENVIADO'],
        ['OPERACAO', 'INDETERMINADO'], ['AUTENTICACAO', 'INDETERMINADO'], ['AUTENTICACAO', 'NAO_ENVIADO'],
        ['VALIDACAO_LOCAL', 'NAO_ENVIADO'], ['RESPOSTA_INVALIDA', 'ENVIADO']]) {
        await t.test(`falha ${categoria}/${envio} preserva classificacao e nao autoriza nova cobranca`, async () => {
            const compra = await novaCompra(); const chave = randomUUID(); let chamadas = 0;
            const adaptador = { async criar() { chamadas++; throw criarFalhaPagamento({ categoria, envio, segredo: 'nao-persistir' }); },
                async consultar(args) { return { estado: 'DESCONHECIDO', referencia: args.referencia, ambiente: args.ambiente }; }, async capturar() {} };
            const s = criarServico({ db: pool, contexto, adaptador });
            await assert.rejects(criar(s, compra, chave), codigo('RESULTADO_DESCONHECIDO'));
            const pg = await criar(s, compra, chave); const dados = await ler(pg);
            assert.equal(chamadas, 1); assert.equal(dados.p.reserva_ativa, 1); assert.equal(pg.estado, 'DESCONHECIDO');
            const falha = dados.eventos.map(e => JSON.parse(e.evidencia_json).falha).find(Boolean);
            assert.equal(falha.categoria, categoria); assert.equal(falha.envio, envio); assert.equal(falha.metodo, 'criar');
            assert.equal(JSON.stringify(dados).includes('nao-persistir'), false);
            await assert.rejects(criar(s, compra), codigo('TENTATIVA_ATIVA'));
        });
    }
    await t.test('falha com evidencia parcial preserva ID sem completar operacao', async () => {
        const compra = await novaCompra(); const chave = randomUUID();
        const adaptador = { async criar(args) { throw criarFalhaPagamento({ categoria: 'INFRAESTRUTURA', envio: 'ENVIADO',
            resultado: { estado: 'DESCONHECIDO', referencia: args.referencia, ambiente: args.ambiente, ordemId: 'ordem-falha-parcial' } }); },
            async consultar() {}, async capturar() {} };
        const pg = await criar(criarServico({ db: pool, contexto, adaptador }), compra, chave);
        const dados = await ler(pg); assert.equal(dados.p.ordem_externa_id, 'ordem-falha-parcial');
        assert.equal(dados.operacoes[0].estado, 'DESCONHECIDA'); assert.equal(dados.operacoes[0].codigo_erro, 'INFRAESTRUTURA');
        assert.equal(dados.p.reserva_ativa, 1);
    });
    await t.test('recusa comprovada exige resultado completo e conserva classificacao', async () => {
        const compra = await novaCompra(); const { sim, service } = montar(); const pg = await criar(service, compra); sim.aprovado(pg.publicId);
        const adaptador = { ...sim.adaptador, async capturar(args) {
            const r = await sim.adaptador.consultar(args);
            throw criarFalhaPagamento({ categoria: 'RECUSA_DEFINITIVA', envio: 'ENVIADO', resultado: { ...r, estado: 'RECUSADO' } });
        } };
        const s = criarServico({ db: pool, contexto, adaptador });
        assert.equal((await capturar(s, compra, pg)).estado, 'RECUSADO');
        const dados = await ler(pg); assert.equal(dados.p.reserva_ativa, null); assert.notEqual(dados.pedido.estado, 'PAGO');
        assert.equal(dados.operacoes[1].codigo_erro, 'RECUSA_DEFINITIVA');
    });
    for (const malformado of [false, true]) await t.test(`captura incompleta nunca confirma PAGO; malformada=${malformado}`, async () => {
        const compra = await novaCompra(); const { sim, service } = montar(); const pg = await criar(service, compra); sim.aprovado(pg.publicId);
        const adaptador = { ...sim.adaptador, async capturar(args) {
            return { estado: malformado ? 'CAPTURADO' : 'DESCONHECIDO', referencia: args.referencia, ambiente: args.ambiente,
                ordemId: args.ordemId, capturaId: `captura-parcial-${pg.publicId}`, capturadoEm: new Date().toISOString() };
        } };
        const s = criarServico({ db: pool, contexto, adaptador });
        if (malformado) await assert.rejects(capturar(s, compra, pg), codigo('RESULTADO_DESCONHECIDO'));
        else assert.equal((await capturar(s, compra, pg)).estado, 'DESCONHECIDO');
        const dados = await ler(pg); assert.notEqual(dados.pedido.estado, 'PAGO'); assert.equal(dados.pedido.pagamento_confirmado_em, null);
        assert.equal(dados.p.reserva_ativa, 1); assert.equal(String(dados.p.capturado_centavos), '0');
        assert.equal(dados.operacoes[1].estado, 'DESCONHECIDA');
        if (!malformado) assert.equal(dados.p.captura_externa_id, `captura-parcial-${pg.publicId}`);
        else assert.equal(dados.operacoes[1].codigo_erro, 'RESPOSTA_INVALIDA');
    });
    await t.test('captura parcial e reconciliada apos reinicio sem reenviar captura nem perder IDs', async () => {
        const compra = await novaCompra(); const { sim, service } = montar(); const pg = await criar(service, compra); sim.aprovado(pg.publicId);
        let consultas = 0; let capturas = 0; let fato;
        const adaptador = { ...sim.adaptador,
            async capturar(args) {
                capturas++; fato = await sim.adaptador.capturar(args);
                return { estado: 'DESCONHECIDO', referencia: args.referencia, ambiente: args.ambiente,
                    ordemId: fato.ordemId, capturaId: fato.capturaId, valorCentavos: fato.valorCentavos, moeda: fato.moeda };
            },
            async consultar(args) {
                consultas++;
                if (!fato) return sim.adaptador.consultar(args);
                assert.equal(args.ordemId, fato.ordemId); return fato;
            }
        };
        const novo = () => criarServico({ db: pool, contexto, adaptador });
        const chave = randomUUID(); assert.equal((await capturar(novo(), compra, pg, chave)).estado, 'DESCONHECIDO');
        let dados = await ler(pg); assert.equal(dados.p.captura_externa_id, fato.capturaId);
        assert.equal(dados.pedido.pagamento_confirmado_em, null); assert.equal(dados.p.reserva_ativa, 1);
        const requestId = dados.operacoes[1].request_id_provedor;
        assert.equal((await capturar(novo(), compra, pg, chave)).pedidoEstado, 'PAGO');
        dados = await ler(pg); assert.equal(dados.operacoes[1].request_id_provedor, requestId);
        assert.equal(capturas, 1); assert.equal(consultas, 2); assert.equal(sim.efeitosCaptura, 1);
    });
    await t.test('timeout imposto pelo nucleo preserva incerteza e classificacao de infraestrutura', async () => {
        const compra = await novaCompra();
        const adaptador = { async criar() { return new Promise(() => {}); }, async consultar() {}, async capturar() {} };
        const s = criarServico({ db: pool, contexto, adaptador, timeoutMs: 10, execucaoMs: 1000 });
        await assert.rejects(criar(s, compra), codigo('RESULTADO_DESCONHECIDO'));
        const [[pg]] = await admin.query('SELECT public_id FROM ist_loja_pagamentos WHERE pedido_id=?', [compra.pedidoId]);
        const dados = await ler({ publicId: pg.public_id });
        const falha = JSON.parse(dados.operacoes[0].resultado_json).falha;
        assert.equal(falha.categoria, 'INFRAESTRUTURA'); assert.equal(falha.envio, 'INDETERMINADO');
        assert.equal(dados.p.reserva_ativa, 1); assert.equal(dados.operacoes[0].estado, 'DESCONHECIDA');
    });
    await t.test('recusa identificada persiste recurso, zero recebido e replay sem recaptura', async () => {
        const compra = await novaCompra(); const { sim, service } = montar(); const pg = await criar(service, compra); sim.aprovado(pg.publicId);
        let envios = 0; let recusa;
        const adaptador = { ...sim.adaptador, async capturar(args) {
            envios++; recusa = { ...await sim.adaptador.consultar(args), estado: 'RECUSADO', capturaId: `recusa-${pg.publicId}` };
            throw criarFalhaPagamento({ categoria: 'RECUSA_DEFINITIVA', envio: 'ENVIADO', resultado: recusa });
        } };
        const novo = adaptador => criarServico({ db: pool, contexto, adaptador }); const chave = randomUUID();
        const resultado = await capturar(novo(adaptador), compra, pg, chave);
        assert.equal(resultado.estado, 'RECUSADO'); assert.notEqual(resultado.pedidoEstado, 'PAGO');
        let dados = await ler(pg); assert.equal(dados.p.captura_externa_id, recusa.capturaId);
        assert.equal(String(dados.p.capturado_centavos), '0'); assert.equal(dados.p.capturado_em, null);
        assert.equal(dados.pedido.pagamento_confirmado_em, null); assert.equal(dados.p.reserva_ativa, null);
        assert.equal(dados.operacoes[1].estado, 'RECUSADA');
        assert.deepEqual(await capturar(novo(adaptador), compra, pg, chave), resultado); assert.equal(envios, 1);
        const consultar = { ...adaptador, async consultar(args) {
            assert.equal(args.capturaId, recusa.capturaId); assert.equal(args.ordemId, recusa.ordemId); return recusa;
        } };
        assert.equal((await reconciliar(novo(consultar), compra, pg)).estado, 'RECUSADO');
        dados = await ler(pg); assert.equal(dados.p.captura_externa_id, recusa.capturaId); assert.equal(envios, 1);
        assert.notEqual((await criar(service, compra)).publicId, pg.publicId);
    });
    await t.test('ID parcial pode ser reconciliado apos reinicio como recusa definitiva', async () => {
        const compra = await novaCompra(); const { sim, service } = montar(); const pg = await criar(service, compra); sim.aprovado(pg.publicId);
        let fato;
        const adaptador = { ...sim.adaptador, async capturar(args) {
            fato = { ...await sim.adaptador.consultar(args), estado: 'RECUSADO', capturaId: `parcial-recusada-${pg.publicId}` };
            return { estado: 'DESCONHECIDO', referencia: args.referencia, ambiente: args.ambiente, ordemId: args.ordemId, capturaId: fato.capturaId };
        } };
        const s = criarServico({ db: pool, contexto, adaptador });
        assert.equal((await capturar(s, compra, pg)).estado, 'DESCONHECIDO');
        assert.equal((await ler(pg)).p.reserva_ativa, 1);
        const novo = criarServico({ db: pool, contexto, adaptador: { ...adaptador, async consultar(args) {
            assert.equal(args.capturaId, fato.capturaId); return fato;
        } } });
        assert.equal((await reconciliar(novo, compra, pg)).estado, 'RECUSADO');
        const dados = await ler(pg); assert.equal(String(dados.p.capturado_centavos), '0'); assert.equal(dados.p.reserva_ativa, null);
        assert.equal(dados.pedido.pagamento_confirmado_em, null);
    });
    for (const caso of ['incompleta', 'instrumento', 'http422', 'pendente']) await t.test(`recusa nao comprovada: ${caso} conserva reserva`, async () => {
        const compra = await novaCompra(); const { sim, service } = montar(); const pg = await criar(service, compra); sim.aprovado(pg.publicId);
        const adaptador = { ...sim.adaptador, async capturar(args) {
            if (caso === 'instrumento') throw Object.assign(new Error('INSTRUMENT_DECLINED'), { response: { status: 422, data: { details: [{ issue: 'INSTRUMENT_DECLINED' }] } } });
            if (caso === 'http422') throw Object.assign(new Error('HTTP'), { status: 422 });
            if (caso === 'incompleta') return { estado: 'RECUSADO', referencia: args.referencia, ambiente: args.ambiente,
                ordemId: args.ordemId, capturaId: `insuficiente-${pg.publicId}` };
            return { ...await sim.adaptador.consultar(args), estado: 'PENDENTE', capturaId: `pendente-${pg.publicId}` };
        } };
        const s = criarServico({ db: pool, contexto, adaptador });
        if (caso === 'pendente') assert.equal((await capturar(s, compra, pg)).estado, 'PENDENTE');
        else await assert.rejects(capturar(s, compra, pg), codigo('RESULTADO_DESCONHECIDO'));
        const dados = await ler(pg); assert.equal(dados.p.reserva_ativa, 1); assert.equal(String(dados.p.capturado_centavos), '0');
        assert.equal(dados.p.capturado_em, null); assert.equal(dados.pedido.pagamento_confirmado_em, null);
        await assert.rejects(criar(service, compra), codigo('TENTATIVA_ATIVA'));
    });
    await t.test('colisao de ID de captura recusada provoca revisao sem liberar reserva', async () => {
        const recusar = async () => {
            const compra = await novaCompra(); const { sim, service } = montar(); const pg = await criar(service, compra); sim.aprovado(pg.publicId);
            const s = criarServico({ db: pool, contexto, adaptador: { ...sim.adaptador, async capturar(args) {
                return { ...await sim.adaptador.consultar(args), estado: 'RECUSADO', capturaId: 'recusa-colisao-compartilhada' };
            } } });
            return { compra, pg, resultado: await capturar(s, compra, pg) };
        };
        assert.equal((await recusar()).resultado.estado, 'RECUSADO');
        const segundo = await recusar(); const dados = await ler(segundo.pg);
        assert.equal(segundo.resultado.estado, 'REVISAO'); assert.equal(dados.p.captura_externa_id, null);
        assert.equal(dados.p.reserva_ativa, 1); assert.equal(dados.p.motivo_revisao, 'IDENTIFICADOR_EXTERNO_DUPLICADO');
    });
    for (const campo of ['capturaId', 'ordemId', 'referencia']) await t.test(`recusa com ${campo} divergente nao sobrescreve IDs`, async () => {
        const compra = await novaCompra(); const { sim, service } = montar(); const pg = await criar(service, compra); sim.aprovado(pg.publicId);
        let fato;
        const adaptador = { ...sim.adaptador, async capturar(args) {
            fato = { ...await sim.adaptador.consultar(args), estado: 'DESCONHECIDO', capturaId: `identificado-${pg.publicId}` }; return fato;
        } };
        await capturar(criarServico({ db: pool, contexto, adaptador }), compra, pg);
        const antes = await ler(pg);
        const s = criarServico({ db: pool, contexto, adaptador: { ...adaptador, async consultar() {
            return { ...fato, estado: 'RECUSADO', [campo]: 'divergente' };
        } } });
        assert.equal((await reconciliar(s, compra, pg)).estado, 'REVISAO');
        const dados = await ler(pg); assert.equal(dados.p.captura_externa_id, antes.p.captura_externa_id);
        assert.equal(dados.p.ordem_externa_id, antes.p.ordem_externa_id); assert.equal(dados.p.reserva_ativa, 1);
        assert.equal(String(dados.p.capturado_centavos), '0');
    });
    await t.test('recusa identificada antes de qualquer captura autorizada exige revisao', async () => {
        const compra = await novaCompra(); const { sim, service } = montar(); const pg = await criar(service, compra);
        const s = criarServico({ db: pool, contexto, adaptador: { ...sim.adaptador, async consultar(args) {
            return { ...await sim.adaptador.consultar(args), estado: 'RECUSADO', capturaId: 'recusa-sem-envio' };
        } } });
        assert.equal((await reconciliar(s, compra, pg)).estado, 'REVISAO');
        const dados = await ler(pg); assert.equal(dados.p.reserva_ativa, 1); assert.equal(dados.p.captura_externa_id, null);
        assert.equal(dados.p.motivo_revisao, 'RECUSA_CONTRADITORIA');
    });
    await t.test('recusa nao apaga dinheiro previamente observado nem libera nova tentativa', async () => {
        const compra = await novaCompra(); const { sim, service } = montar(); const pg = await criar(service, compra); sim.aprovado(pg.publicId);
        let fato;
        const adaptador = { ...sim.adaptador, async capturar(args) {
            fato = { ...await sim.adaptador.consultar(args), estado: 'DESCONHECIDO', capturaId: `contraditoria-${pg.publicId}` }; return fato;
        } };
        await capturar(criarServico({ db: pool, contexto, adaptador }), compra, pg);
        // Contradicao controlada exclusivamente na fixture descartavel.
        await admin.query('UPDATE ist_loja_pagamentos SET capturado_centavos=19000,capturado_em=atualizado_em WHERE public_id=?', [pg.publicId]);
        const s = criarServico({ db: pool, contexto, adaptador: { ...adaptador, async consultar() {
            return { ...fato, estado: 'RECUSADO' };
        } } });
        assert.equal((await reconciliar(s, compra, pg)).estado, 'REVISAO');
        const dados = await ler(pg); assert.equal(String(dados.p.capturado_centavos), '19000');
        assert.equal(dados.p.reserva_ativa, 1); assert.equal(dados.pedido.pagamento_confirmado_em, null);
        assert.equal(dados.p.motivo_revisao, 'RECUSA_CONTRADITORIA');
    });
    await t.test('importacao/servico nao habilitam simulador em producao nem em live', async () => {
        const sim = criarPagamentoSimulado(); process.env.NODE_ENV = 'production';
        try { assert.throws(() => criarServico({ db: pool, contexto, adaptador: sim.adaptador }), codigo('CONFIGURACAO_INVALIDA')); }
        finally { process.env.NODE_ENV = 'test'; }
        assert.throws(() => criarServico({ db: pool, contexto: { ...contexto, ambiente: 'live' }, adaptador: sim.adaptador }), codigo('CONFIGURACAO_INVALIDA'));
    });
});
