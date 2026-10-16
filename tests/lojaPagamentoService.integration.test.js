import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { criarLojaPagamentoService } from '../src/services/lojaPagamentoService.js';
import { criarFalhaPagamento } from '../src/services/lojaPagamentoContratos.js';
import { criarPagamentoSimulado } from './fixtures/lojaPagamentoSimulado.js';
import { criarBancoPagamentoIsolado } from './fixtures/lojaPagamentoBancoIsolado.js';

const contexto = { provedor: 'simulado', ambiente: 'sandbox', contaRecebedora: 'recebedor-fixture' };
const codigo = codigo => ({ codigo });
const adiar = () => { let resolver; const promessa = new Promise(r => { resolver = r; }); return { promessa, resolver }; };

test('nucleo transacional em MariaDB descartavel e adaptador exclusivo de testes', {
    skip: !process.env.IST_LOJA_PAGAMENTOS_MARIADB_BIN, timeout: 180000
}, async t => {
    const anterior = process.env.NODE_ENV; process.env.NODE_ENV = 'test';
    t.after(() => { if (anterior === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = anterior; });
    const banco = await criarBancoPagamentoIsolado(t);
    const { pool, admin, novaCompra } = banco;
    const montar = (opcoes = {}) => {
        const sim = criarPagamentoSimulado(opcoes);
        const service = criarLojaPagamentoService({ db: opcoes.db ?? pool, adaptador: sim.adaptador,
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
        const service = criarLojaPagamentoService({ db: pool, contexto, adaptador }); const pg = await criar(service, compra);
        const conteudo = JSON.stringify({ pg, dados: await ler(pg) }); assert.doesNotMatch(conteudo, /SEGREDO_FIXTURE|PAN_FIXTURE/);
        assert.doesNotMatch(JSON.stringify(pg), /request_id|recebedor|solicitacao_hash|ordem_externa|comprador_email|execucao_token/);
    });
    for (const falha of [null, Object.assign(new Error('segredo externo'), { codigo: 'APROVACAO_PENDENTE' })]) {
        await t.test(`excecao arbitraria do adaptador nao simula erro de dominio: ${falha === null ? 'null' : 'codigo'}`, async () => {
            const compra = await novaCompra(); const sim = criarPagamentoSimulado();
            const service = criarLojaPagamentoService({ db: pool, contexto, adaptador: { ...sim.adaptador, async criar() { throw falha; } } });
            await assert.rejects(criar(service, compra), e => e.codigo === 'RESULTADO_DESCONHECIDO' && !e.message.includes('segredo externo'));
            const [[p]] = await admin.query('SELECT estado,reserva_ativa FROM ist_loja_pagamentos WHERE pedido_id=?', [compra.pedidoId]);
            assert.equal(p.estado, 'DESCONHECIDO'); assert.equal(p.reserva_ativa, 1);
        });
    }
    for (const estado of ['CANCELADO', 'EXPIRADO']) await t.test(`encerramento externo definitivo ${estado} libera somente a tentativa`, async () => {
        const compra = await novaCompra(); const { sim, service } = montar(); const pg = await criar(service, compra);
        sim.encerrar(pg.publicId, estado); assert.equal((await reconciliar(service, compra, pg)).estado, estado);
        const dados = await ler(pg); assert.equal(dados.p.reserva_ativa, null); assert.notEqual(dados.pedido.estado, 'PAGO');
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
        const service = criarLojaPagamentoService({ db: pool, contexto, adaptador }); await criar(service, a);
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
        const s = () => criarLojaPagamentoService({ db: pool, contexto, adaptador });
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
        const s = criarLojaPagamentoService({ db: pool, contexto, adaptador });
        assert.equal((await reconciliar(s, compra, pg)).estado, 'REVISAO');
        const dados = await ler(pg); assert.equal(dados.p.ordem_externa_id, antes.p.ordem_externa_id);
        assert.equal(dados.p.reserva_ativa, 1); assert.notEqual(dados.pedido.estado, 'PAGO');
    });
    await t.test('colisao UNIQUE entre IDs parciais bloqueia a segunda tentativa para revisao', async () => {
        const adaptador = { async criar(args) { return { estado: 'DESCONHECIDO', referencia: args.referencia,
            ambiente: args.ambiente, ordemId: 'ordem-parcial-colisao' }; }, async consultar() {}, async capturar() {} };
        const s = criarLojaPagamentoService({ db: pool, contexto, adaptador });
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
            const s = criarLojaPagamentoService({ db: pool, contexto, adaptador });
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
        const pg = await criar(criarLojaPagamentoService({ db: pool, contexto, adaptador }), compra, chave);
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
        const s = criarLojaPagamentoService({ db: pool, contexto, adaptador });
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
        const s = criarLojaPagamentoService({ db: pool, contexto, adaptador });
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
        const novo = () => criarLojaPagamentoService({ db: pool, contexto, adaptador });
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
        const s = criarLojaPagamentoService({ db: pool, contexto, adaptador, timeoutMs: 10, execucaoMs: 1000 });
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
        const novo = adaptador => criarLojaPagamentoService({ db: pool, contexto, adaptador }); const chave = randomUUID();
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
        const s = criarLojaPagamentoService({ db: pool, contexto, adaptador });
        assert.equal((await capturar(s, compra, pg)).estado, 'DESCONHECIDO');
        assert.equal((await ler(pg)).p.reserva_ativa, 1);
        const novo = criarLojaPagamentoService({ db: pool, contexto, adaptador: { ...adaptador, async consultar(args) {
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
        const s = criarLojaPagamentoService({ db: pool, contexto, adaptador });
        if (caso === 'pendente') assert.equal((await capturar(s, compra, pg)).estado, 'PENDENTE');
        else await assert.rejects(capturar(s, compra, pg), codigo('RESULTADO_DESCONHECIDO'));
        const dados = await ler(pg); assert.equal(dados.p.reserva_ativa, 1); assert.equal(String(dados.p.capturado_centavos), '0');
        assert.equal(dados.p.capturado_em, null); assert.equal(dados.pedido.pagamento_confirmado_em, null);
        await assert.rejects(criar(service, compra), codigo('TENTATIVA_ATIVA'));
    });
    await t.test('colisao de ID de captura recusada provoca revisao sem liberar reserva', async () => {
        const recusar = async () => {
            const compra = await novaCompra(); const { sim, service } = montar(); const pg = await criar(service, compra); sim.aprovado(pg.publicId);
            const s = criarLojaPagamentoService({ db: pool, contexto, adaptador: { ...sim.adaptador, async capturar(args) {
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
        await capturar(criarLojaPagamentoService({ db: pool, contexto, adaptador }), compra, pg);
        const antes = await ler(pg);
        const s = criarLojaPagamentoService({ db: pool, contexto, adaptador: { ...adaptador, async consultar() {
            return { ...fato, estado: 'RECUSADO', [campo]: 'divergente' };
        } } });
        assert.equal((await reconciliar(s, compra, pg)).estado, 'REVISAO');
        const dados = await ler(pg); assert.equal(dados.p.captura_externa_id, antes.p.captura_externa_id);
        assert.equal(dados.p.ordem_externa_id, antes.p.ordem_externa_id); assert.equal(dados.p.reserva_ativa, 1);
        assert.equal(String(dados.p.capturado_centavos), '0');
    });
    await t.test('recusa identificada antes de qualquer captura autorizada exige revisao', async () => {
        const compra = await novaCompra(); const { sim, service } = montar(); const pg = await criar(service, compra);
        const s = criarLojaPagamentoService({ db: pool, contexto, adaptador: { ...sim.adaptador, async consultar(args) {
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
        await capturar(criarLojaPagamentoService({ db: pool, contexto, adaptador }), compra, pg);
        // Contradicao controlada exclusivamente na fixture descartavel.
        await admin.query('UPDATE ist_loja_pagamentos SET capturado_centavos=19000,capturado_em=atualizado_em WHERE public_id=?', [pg.publicId]);
        const s = criarLojaPagamentoService({ db: pool, contexto, adaptador: { ...adaptador, async consultar() {
            return { ...fato, estado: 'RECUSADO' };
        } } });
        assert.equal((await reconciliar(s, compra, pg)).estado, 'REVISAO');
        const dados = await ler(pg); assert.equal(String(dados.p.capturado_centavos), '19000');
        assert.equal(dados.p.reserva_ativa, 1); assert.equal(dados.pedido.pagamento_confirmado_em, null);
        assert.equal(dados.p.motivo_revisao, 'RECUSA_CONTRADITORIA');
    });
    await t.test('importacao/servico nao habilitam simulador em producao nem em live', async () => {
        const sim = criarPagamentoSimulado(); process.env.NODE_ENV = 'production';
        try { assert.throws(() => criarLojaPagamentoService({ db: pool, contexto, adaptador: sim.adaptador }), codigo('CONFIGURACAO_INVALIDA')); }
        finally { process.env.NODE_ENV = 'test'; }
        assert.throws(() => criarLojaPagamentoService({ db: pool, contexto: { ...contexto, ambiente: 'live' }, adaptador: sim.adaptador }), codigo('CONFIGURACAO_INVALIDA'));
    });
});
