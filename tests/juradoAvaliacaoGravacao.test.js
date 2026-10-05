import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
    salvarAvaliacaoJuradoCycleAware, JuradoAvaliacaoGravacaoError, GRAVACAO_ERROS,
    duplicidadeTentativa
} from '../src/services/juradoAvaliacaoGravacaoService.js';
import { JulgamentoContextError, JULGAMENTO_ERROS } from '../src/services/julgamentoContextService.js';

const evento = { id: 17, slug: 'evento-teste', nome: 'Evento Teste' };
const par = { id_evento: 17, id_ciclo: 20, id_jurado: 10, id_concorrente: 40 };
const data = '2026-10-05 12:00:00';
const tentativa = (campos = {}) => ({
    ...par, id_avaliacao: 60, numero_tentativa: 1, id_avaliacao_origem: null, estado: 'rascunho',
    versao: 3, possivel_desclassificacao: 0, motivo_desclassificacao: null,
    data_inclusao: '2026-10-01 10:00:00', data_atualizacao: '2026-10-02 11:00:00', data_conclusao: null, ...campos
});
const nota = (campos = {}) => ({
    id_avaliacao: 60, id_evento: 17, id_ciclo: 20, id_criterio: 101, id_criterio_ciclo: 501, nota: 25, ...campos
});
const payload = (campos = {}) => ({
    contexto: { idCiclo: 20, numeroTentativa: null }, versao: 0, estado: 'rascunho',
    notas: [], possivelDesclassificacao: false, motivoDesclassificacao: null, ...campos
});
const edicao = (campos = {}) => payload({ contexto: { idCiclo: 20, numeroTentativa: 1 }, versao: 3, ...campos });
const completas = () => [{ idCriterioCiclo: 502, nota: 75 }, { idCriterioCiclo: 501, nota: 25 }];
const erroWriter = code => error => error instanceof JuradoAvaliacaoGravacaoError && error.code === code;
const erroContexto = code => error => error instanceof JulgamentoContextError && error.code === code;
const sqlError = (code = 'ER_TEST', errno = 9999) => Object.assign(new Error('falha simulada'), { code, errno });
const duplicate = key => Object.assign(sqlError('ER_DUP_ENTRY', 1062), { sqlMessage: `Duplicate entry '20-10-40-1' for key '${key}'` });

function fixture(opcoes = {}) {
    const state = {
        eventos: [evento],
        julgamentos: [{ id_evento: 17, id_ciclo_atual: 20, id_publicacao_vigente: null, quantidade_classificados: null, versao: 1 }],
        ciclos: [{ id_ciclo: 20, id_evento: 17, numero_ciclo: 1, estado: 'aberto',
            id_ciclo_origem: null, id_publicacao_origem: null, publicado_em: null, motivo_reabertura: null }],
        usuarios: [{ id_usuario: 10, id_tipo_usuario: 4, id_situacao: 8, id_cargo: 11 }],
        designacoes: [{ id_evento: 17, id_usuario: 10, ativo: 1 }],
        jurados: [{ id_ciclo: 20, id_evento: 17, id_usuario: 10, nome_publico: 'Jurado snapshot', estado_participacao: 'incluido' }],
        participantes: [{ id_ciclo_concorrente: 30, id_ciclo: 20, id_evento: 17, id_concorrente: 40, id_usuario: 50,
            numero_concorrente: 'SNAP-040', nome_publico: 'Nome congelado', id_obra_1: 22, obra_1_publica: 'Obra snapshot',
            link_video_1: 'video-snapshot', id_obra_2: null, obra_2_publica: null, link_video_2: null,
            fingerprint: 'a'.repeat(64), estado_participacao: 'incluido' }],
        criterios: [
            { id_criterio_ciclo: 501, id_criterio_origem: 101, id_ciclo: 20, id_evento: 17,
                nome: 'Primeiro', descricao: null, ordem: 1, peso: '40.00' },
            { id_criterio_ciclo: 502, id_criterio_origem: 102, id_ciclo: 20, id_evento: 17,
                nome: 'Segundo', descricao: null, ordem: 2, peso: '60.00' }
        ],
        publicacoes: [], avaliacoes: [], notas: [], ...opcoes.state
    };
    const calls = [];
    let active = false;
    let backup;
    let wrote = false;
    let acquired = 0;
    const fail = stage => { if (opcoes[stage]) throw opcoes[stage]; };
    const rows = value => [structuredClone(value)];
    const connection = {
        getConnection() { assert.fail('Segunda conexao proibida'); },
        async beginTransaction() {
            calls.push({ sql: 'BEGIN' });
            assert.equal(calls.at(-2).sql, 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
            fail('beginError');
            active = true;
            backup = structuredClone({ avaliacoes: state.avaliacoes, notas: state.notas });
        },
        async commit() {
            calls.push({ sql: 'COMMIT' });
            assert.equal(active, true);
            assert.equal(wrote, true);
            fail('commitError');
            active = false;
        },
        async rollback() {
            calls.push({ sql: 'ROLLBACK' });
            assert.equal(active, true);
            fail('rollbackError');
            state.avaliacoes = backup.avaliacoes;
            state.notas = backup.notas;
            active = false;
        },
        release() { calls.push({ sql: 'RELEASE' }); assert.equal(active, false); fail('releaseError'); },
        destroy() { calls.push({ sql: 'DESTROY' }); active = false; fail('destroyError'); },
        async query(sql, params = []) {
            assert.equal(this, connection);
            const normalized = sql.replace(/\s+/g, ' ').trim();
            const call = { sql: normalized, params: structuredClone(params) };
            calls.push(call);
            if (normalized === 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED') {
                assert.equal(active, false);
                if (calls.length > 1) assert.equal(calls.at(-2).sql, 'RELEASE');
                fail('isolationError');
                return [undefined];
            }
            assert.equal(active, true, 'Toda consulta apos SET deve estar na transacao');
            assert.doesNotMatch(normalized, /\b(MAX|LIMIT|UPSERT|REPLACE|CREATE|ALTER|DROP|TRUNCATE|SET SESSION)\b/);
            assert.doesNotMatch(normalized, /\bist_concorrentes\b|\bist_composicao\b|\bist_eventos_criterios_avaliacao\b/);
            assert.match(normalized, /^(SELECT|INSERT INTO ist_eventos_avaliacoes(?:_notas)? |UPDATE ist_eventos_avaliacoes |DELETE FROM ist_eventos_avaliacoes_notas )/);
            if (opcoes.onQuery) opcoes.onQuery(call, state, { wrote, calls });
            if (opcoes.queryError && normalized.includes(opcoes.queryError.trecho)) throw opcoes.queryError.error;
            if (opcoes.readerError && wrote && normalized.includes('FROM ist_eventos_julgamentos')) throw opcoes.readerError;
            if (normalized.includes('FROM ist_eventos WHERE')) return rows(state.eventos.filter(e => e.id === params[0]));
            if (normalized.includes('FROM ist_eventos_julgamentos')) return rows(state.julgamentos);
            if (normalized.includes('FROM ist_eventos_ciclos WHERE')) return rows(state.ciclos.filter(c => c.id_ciclo === params[0]));
            if (normalized.includes('FROM ist_eventos_publicacoes p')) {
                return rows(state.publicacoes.filter(p => p.id_publicacao === params[0]).map(p => {
                    const c = state.ciclos.find(c => c.id_ciclo === p.id_ciclo);
                    return { ...p, ciclo_evento: c?.id_evento, numero_ciclo: c?.numero_ciclo,
                        estado_ciclo: c?.estado, ciclo_publicado_em: c?.publicado_em };
                }));
            }
            if (normalized.includes('FROM ist_eventos_publicacoes WHERE')) return rows(state.publicacoes.filter(p => p.id_evento === params[0] && p.id_ciclo === params[1]));
            if (normalized.includes('FROM ist_usuarios')) return rows(state.usuarios);
            if (normalized.includes('FROM ist_eventos_jurados')) return rows(state.designacoes);
            if (normalized.includes('FROM ist_eventos_ciclos_jurados')) return rows(state.jurados);
            if (normalized.includes('FROM ist_eventos_ciclos_concorrentes')) return rows(state.participantes);
            if (normalized.includes('FROM ist_eventos_ciclos_criterios')) return rows(state.criterios);
            if (normalized.startsWith('SELECT ') && normalized.includes('FROM ist_eventos_avaliacoes_notas')) {
                assert.doesNotMatch(normalized, /FOR UPDATE/);
                return rows(state.notas.filter(n => n.id_avaliacao === params[0]));
            }
            if (normalized.startsWith('SELECT ') && normalized.includes('FROM ist_eventos_avaliacoes ')) {
                assert.deepEqual(params, [17, 20, 10, 40]);
                const selected = state.avaliacoes.filter(a => a.id_evento === params[0] && a.id_ciclo === params[1]
                    && a.id_jurado === params[2] && a.id_concorrente === params[3]);
                return rows(selected);
            }
            if (normalized.startsWith('INSERT INTO ist_eventos_avaliacoes ')) {
                fail('insertError');
                assert.match(normalized, /numero_tentativa, id_avaliacao_origem, estado, versao/);
                assert.match(normalized, /VALUES \(\?, \?, \?, \?, 1, NULL, \?, 1, \?, \?, CASE/);
                const [id_evento, id_ciclo, id_jurado, id_concorrente, estado, sinal, motivo, estadoData] = params;
                assert.equal(estadoData, estado);
                assert.deepEqual([id_evento, id_ciclo, id_jurado, id_concorrente], [17, 20, 10, 40]);
                state.avaliacoes.push(tentativa({ id_avaliacao: 61, id_evento, id_ciclo, id_jurado, id_concorrente,
                    estado, versao: 1, possivel_desclassificacao: sinal, motivo_desclassificacao: motivo,
                    data_inclusao: data, data_atualizacao: data, data_conclusao: estado === 'concluida' ? data : null }));
                wrote = true;
                return [{ insertId: 61, affectedRows: 1 }];
            }
            if (normalized.startsWith('UPDATE ist_eventos_avaliacoes ')) {
                assert.match(normalized, /WHERE id_avaliacao = \? AND id_evento = \? AND id_ciclo = \? AND id_jurado = \? AND id_concorrente = \? AND numero_tentativa = \? AND estado = 'rascunho' AND versao = \?$/);
                assert.doesNotMatch(normalized.split('WHERE')[0], /id_ciclo\s*=|numero_tentativa\s*=|id_avaliacao_origem\s*=|data_inclusao\s*=/);
                const [estado, versao, sinal, motivo, estadoData, id, idEvento, idCiclo, idJurado, idConcorrente, numero, anterior] = params;
                assert.equal(estadoData, estado);
                const a = state.avaliacoes.find(a => a.id_avaliacao === id);
                assert.deepEqual([a.id_evento, a.id_ciclo, a.id_jurado, a.id_concorrente, a.numero_tentativa, a.versao],
                    [idEvento, idCiclo, idJurado, idConcorrente, numero, anterior]);
                if ('affectedRows' in opcoes) return [{ affectedRows: opcoes.affectedRows }];
                Object.assign(a, { estado, versao, possivel_desclassificacao: sinal, motivo_desclassificacao: motivo,
                    data_atualizacao: data, data_conclusao: estado === 'concluida' ? data : null });
                wrote = true;
                return [{ affectedRows: 1 }];
            }
            if (normalized.startsWith('DELETE FROM')) {
                assert.equal(normalized, 'DELETE FROM ist_eventos_avaliacoes_notas WHERE id_avaliacao = ? AND id_evento = ? AND id_ciclo = ?');
                state.notas = state.notas.filter(n => !(n.id_avaliacao === params[0] && n.id_evento === params[1] && n.id_ciclo === params[2]));
                return [{ affectedRows: 1 }];
            }
            if (normalized.startsWith('INSERT INTO ist_eventos_avaliacoes_notas')) {
                assert.match(normalized, /\(id_avaliacao, id_criterio, id_evento, id_ciclo, id_criterio_ciclo, nota\) VALUES/);
                for (let i = 0; i < params.length; i += 6) {
                    const [id_avaliacao, id_criterio, id_evento, id_ciclo, id_criterio_ciclo, valor] = params.slice(i, i + 6);
                    state.notas.push({ id_avaliacao, id_criterio, id_evento, id_ciclo, id_criterio_ciclo, nota: valor });
                }
                return [{ affectedRows: params.length / 6 }];
            }
            assert.fail('SQL nao simulado: ' + normalized);
        }
    };
    const pool = {
        async getConnection() { acquired++; fail('acquireError'); return connection; },
        query() { assert.fail('Pool nao pode executar consultas da transacao'); }
    };
    return {
        state, calls, connection, pool, get acquired() { return acquired; },
        save: (p = payload(), e = evento, id = 40, usuario = 10) => salvarAvaliacaoJuradoCycleAware(e, id, usuario, p, pool),
        writes: () => calls.filter(c => /^(INSERT|UPDATE|DELETE)/.test(c.sql))
    };
}

test('primeira tentativa: uma connection, isolamento/locks em ordem, reader real e commit antes do retorno', async () => {
    const f = fixture();
    const dto = await f.save(payload({ notas: completas() }));
    assert.equal(f.acquired, 1);
    assert.deepEqual(f.calls.slice(0, 2).map(c => c.sql), ['SET TRANSACTION ISOLATION LEVEL READ COMMITTED', 'BEGIN']);
    const locks = f.calls.filter(c => /FOR UPDATE|LOCK IN SHARE MODE/.test(c.sql));
    assert.deepEqual(locks.map(c => /FROM (\w+)/.exec(c.sql)[1]), [
        'ist_eventos_julgamentos', 'ist_eventos_ciclos', 'ist_usuarios', 'ist_eventos_jurados',
        'ist_eventos_ciclos_jurados', 'ist_eventos_ciclos_concorrentes', 'ist_eventos_ciclos_criterios', 'ist_eventos_avaliacoes'
    ]);
    assert.match(locks[6].sql, /ORDER BY id_criterio_ciclo LOCK IN SHARE MODE$/);
    assert.match(locks[7].sql, /ORDER BY numero_tentativa, id_avaliacao FOR UPDATE$/);
    assert.deepEqual(f.calls.at(-2), { sql: 'COMMIT' });
    assert.deepEqual(f.calls.at(-1), { sql: 'RELEASE' });
    const ultimaConsulta = f.calls.at(-3);
    assert.match(ultimaConsulta.sql, /FROM ist_eventos_avaliacoes_notas/);
    assert.deepEqual(dto.contexto, { idCiclo: 20, numeroCiclo: 1, numeroTentativa: 1 });
    assert.equal(dto.versao, 1);
    assert.equal(dto.estado, 'rascunho');
    assert.equal(dto.avaliacao.media, '55.00');
    assert.equal(dto.podeGravar, false);
    assert.deepEqual(dto.autorizacaoGravacao, { estado: 'nao_avaliada' });
    assert.equal(dto.concorrente.nome, 'Nome congelado');
    assert.equal(f.state.avaliacoes[0].id_avaliacao_origem, null);
    assert.deepEqual(f.state.notas.map(n => [n.id_criterio_ciclo, n.id_criterio]), [[501, 101], [502, 102]]);
});

const invalidos = [
    ['payload null', () => null], ['payload array', () => []], ['contexto ausente', p => { delete p.contexto; return p; }],
    ['contexto null', p => ({ ...p, contexto: null })],
    ['ciclo string', p => ({ ...p, contexto: { idCiclo: '20', numeroTentativa: null } })],
    ['ciclo zero', p => ({ ...p, contexto: { idCiclo: 0, numeroTentativa: null } })],
    ['tentativa zero', p => ({ ...p, contexto: { idCiclo: 20, numeroTentativa: 0 } })],
    ['tentativa string', p => ({ ...p, contexto: { idCiclo: 20, numeroTentativa: '1' } })],
    ['tentativa ausente', p => ({ ...p, contexto: { idCiclo: 20 } })],
    ['versao string', p => ({ ...p, versao: '0' })], ['versao negativa', p => ({ ...p, versao: -1 })],
    ['versao NaN', p => ({ ...p, versao: NaN })], ['versao acima UINT', p => ({ ...p, versao: 4294967296 })],
    ['versao fracionaria', p => ({ ...p, versao: 0.5 })],
    ['token null/versao positiva', p => ({ ...p, versao: 1 })],
    ['token tentativa/versao zero', p => ({ ...p, contexto: { idCiclo: 20, numeroTentativa: 1 } })],
    ['estado pendente', p => ({ ...p, estado: 'pendente' })], ['notas objeto', p => ({ ...p, notas: {} })],
    ['nota null', p => ({ ...p, notas: [null] })], ['nota string', p => ({ ...p, notas: [{ idCriterioCiclo: 501, nota: '25' }] })],
    ['nota fracionaria', p => ({ ...p, notas: [{ idCriterioCiclo: 501, nota: 1.5 }] })],
    ['nota negativa', p => ({ ...p, notas: [{ idCriterioCiclo: 501, nota: -1 }] })],
    ['nota acima 100', p => ({ ...p, notas: [{ idCriterioCiclo: 501, nota: 101 }] })],
    ['nota NaN', p => ({ ...p, notas: [{ idCriterioCiclo: 501, nota: NaN }] })],
    ['id criterio string', p => ({ ...p, notas: [{ idCriterioCiclo: '501', nota: 1 }] })],
    ['id criterio origem extra', p => ({ ...p, notas: [{ idCriterioCiclo: 501, idCriterio: 999, nota: 1 }] })],
    ['peso extra', p => ({ ...p, notas: [{ idCriterioCiclo: 501, peso: '100.00', nota: 1 }] })],
    ['id duplicado', p => ({ ...p, notas: [{ idCriterioCiclo: 501, nota: 1 }, { idCriterioCiclo: 501, nota: 2 }] })],
    ['array esparso', p => ({ ...p, notas: Array(1) })],
    ['boolean string', p => ({ ...p, possivelDesclassificacao: 'false' })],
    ['boolean number', p => ({ ...p, possivelDesclassificacao: 0 })],
    ['false/motivo string', p => ({ ...p, motivoDesclassificacao: '' })],
    ['true/motivo null', p => ({ ...p, possivelDesclassificacao: true })],
    ['true/motivo vazio', p => ({ ...p, possivelDesclassificacao: true, motivoDesclassificacao: '  ' })],
    ['true/motivo extenso', p => ({ ...p, possivelDesclassificacao: true, motivoDesclassificacao: 'a'.repeat(2001) })],
    ['media extra', p => ({ ...p, media: 99 })], ['jurado extra', p => ({ ...p, idJurado: 999 })]
];
for (const [nome, modificar] of invalidos) {
    test(`entrada rejeitada antes da conexao: ${nome}`, async () => {
        const f = fixture();
        await assert.rejects(f.save(modificar(payload())), erroWriter(GRAVACAO_ERROS.PAYLOAD_INVALIDO));
        assert.equal(f.acquired, 0);
        assert.equal(f.calls.length, 0);
    });
}
for (const [id, usuario] of [['40', 10], [0, 10], [40, '10'], [40, 2147483648], [NaN, 10]]) {
    test(`identidade invalida antes da conexao: ${String(id)}/${String(usuario)}`, async () => {
        const f = fixture();
        await assert.rejects(f.save(payload(), evento, id, usuario), erroWriter(GRAVACAO_ERROS.PAYLOAD_INVALIDO));
        assert.equal(f.acquired, 0);
    });
}
test('evento identificado invalido nao adquire conexao', async () => {
    const f = fixture();
    await assert.rejects(f.save(payload(), { ...evento, id: '17' }), erroContexto(JULGAMENTO_ERROS.CONTEXTO_INCONSISTENTE));
    assert.equal(f.acquired, 0);
});
test('evento por ID: identificacao minima depois de BEGIN, julgamento primeiro lock', async () => {
    const f = fixture();
    await f.save(payload(), 17);
    assert.match(f.calls[2].sql, /^SELECT id, slug, nome FROM ist_eventos WHERE id = \?$/);
    assert.match(f.calls[3].sql, /ist_eventos_julgamentos.*FOR UPDATE$/);
});
test('ciclo stale nao seleciona ciclo enviado nem escreve', async () => {
    const f = fixture();
    await assert.rejects(f.save(payload({ contexto: { idCiclo: 999, numeroTentativa: null } })), erroWriter('CICLO_DESATUALIZADO'));
    assert.deepEqual(f.calls.find(c => c.sql.includes('ist_eventos_ciclos WHERE') && c.sql.endsWith('FOR UPDATE')).params, [20]);
    assert.equal(f.writes().length, 0);
});

const negacoes = [
    ['usuario ausente', { usuarios: [] }, 'ACESSO_OPERACIONAL_NEGADO'],
    ['usuario diferente', { usuarios: [{ id_usuario: 11, id_tipo_usuario: 4, id_situacao: 8, id_cargo: 11 }] }, 'ACESSO_OPERACIONAL_NEGADO'],
    ['tipo', { usuarios: [{ id_usuario: 10, id_tipo_usuario: 1, id_situacao: 8, id_cargo: 11 }] }, 'ACESSO_OPERACIONAL_NEGADO'],
    ['situacao', { usuarios: [{ id_usuario: 10, id_tipo_usuario: 4, id_situacao: 1, id_cargo: 11 }] }, 'ACESSO_OPERACIONAL_NEGADO'],
    ['cargo', { usuarios: [{ id_usuario: 10, id_tipo_usuario: 4, id_situacao: 8, id_cargo: 1 }] }, 'ACESSO_OPERACIONAL_NEGADO'],
    ['designacao ausente', { designacoes: [] }, 'ACESSO_OPERACIONAL_NEGADO'],
    ['designacao inativa', { designacoes: [{ id_evento: 17, id_usuario: 10, ativo: 0 }] }, 'ACESSO_OPERACIONAL_NEGADO'],
    ['designacao outro evento', { designacoes: [{ id_evento: 99, id_usuario: 10, ativo: 1 }] }, 'ACESSO_OPERACIONAL_NEGADO'],
    ['roster ausente', { jurados: [] }, 'ACESSO_OPERACIONAL_NEGADO'],
    ['roster retirado', { jurados: [{ id_ciclo: 20, id_evento: 17, id_usuario: 10, nome_publico: 'Jurado', estado_participacao: 'retirado' }] }, 'CONTEXTO_NAO_GRAVAVEL']
];
for (const [nome, state, code] of negacoes) {
    test(`negacao sem DML: ${nome}`, async () => {
        const f = fixture({ state });
        await assert.rejects(f.save(), erroWriter(code));
        assert.equal(f.writes().length, 0);
        assert.deepEqual(f.calls.slice(-2).map(c => c.sql), ['ROLLBACK', 'RELEASE']);
    });
}
test('concorrente ausente preserva erro de contexto', async () => {
    const f = fixture({ state: { participantes: [] } });
    await assert.rejects(f.save(), erroContexto('CONCORRENTE_AUSENTE'));
    assert.equal(f.writes().length, 0);
});
for (const estado of ['desistente', 'desclassificado', 'inelegivel']) {
    test(`concorrente ${estado} nao gravavel`, async () => {
        const f = fixture();
        f.state.participantes[0].estado_participacao = estado;
        await assert.rejects(f.save(), erroWriter('CONTEXTO_NAO_GRAVAVEL'));
        assert.equal(f.writes().length, 0);
    });
}
for (const [nome, modificar, code] of [
    ['julgamento ausente', f => { f.state.julgamentos = []; }, 'JULGAMENTO_NAO_CONFIGURADO'],
    ['ponteiro null', f => { f.state.julgamentos[0].id_ciclo_atual = null; }, 'CICLO_ATUAL_AUSENTE'],
    ['ciclo outro evento', f => { f.state.ciclos[0].id_evento = 99; }, 'CONTEXTO_INCONSISTENTE'],
    ['criterios vazios', f => { f.state.criterios = []; }, 'CRITERIOS_INVALIDOS'],
    ['peso adulterado', f => { f.state.criterios[0].peso = '99.00'; }, 'CRITERIOS_INVALIDOS']
]) {
    test(`contexto invalido: ${nome}`, async () => {
        const f = fixture();
        modificar(f);
        await assert.rejects(f.save(), erroContexto(code));
        assert.equal(f.writes().length, 0);
    });
}
test('ciclo selado com publicacao valida nao permite gravacao', async () => {
    const f = fixture();
    Object.assign(f.state.ciclos[0], { estado: 'selado', publicado_em: data });
    f.state.publicacoes.push({ id_publicacao: 70, id_evento: 17, id_ciclo: 20, versao: 1, publicado_em: data });
    await assert.rejects(f.save(), erroWriter('CONTEXTO_NAO_GRAVAVEL'));
    assert.equal(f.writes().length, 0);
});
for (const [nome, trecho, alterar] of [
    ['julgamento', 'FROM ist_eventos_julgamentos', s => { s.julgamentos[0].versao++; }],
    ['roster', 'FROM ist_eventos_ciclos_jurados', s => { s.jurados[0].nome_publico = 'Diferente'; }],
    ['participante', 'FROM ist_eventos_ciclos_concorrentes', s => { s.participantes[0].nome_publico = 'Diferente'; }],
    ['criterios', 'FROM ist_eventos_ciclos_criterios', s => { s.criterios[0].nome = 'Diferente'; }]
]) {
    test(`helper deve corresponder ao lock: ${nome}`, async () => {
        const f = fixture({ onQuery(call, state) {
            if (call.sql.includes(trecho) && !/FOR UPDATE|LOCK IN SHARE MODE/.test(call.sql)) alterar(state);
        } });
        await assert.rejects(f.save(), erroContexto('CONTEXTO_INCONSISTENTE'));
        assert.equal(f.writes().length, 0);
    });
}
for (const [nome, p] of [
    ['criterio origem em vez de snapshot', payload({ notas: [{ idCriterioCiclo: 101, nota: 80 }] })],
    ['criterio outro ciclo', payload({ notas: [{ idCriterioCiclo: 999, nota: 80 }] })],
    ['conclusao vazia', payload({ estado: 'concluida' })],
    ['conclusao parcial', payload({ estado: 'concluida', notas: [{ idCriterioCiclo: 501, nota: 80 }] })]
]) {
    test(`notas rejeitadas antes do DML: ${nome}`, async () => {
        const f = fixture();
        await assert.rejects(f.save(p), erroWriter('PAYLOAD_INVALIDO'));
        assert.equal(f.writes().length, 0);
    });
}
for (const notas of [[], [{ idCriterioCiclo: 501, nota: 0 }], completas()]) {
    test(`rascunho aceita ${notas.length} notas`, async () => {
        const f = fixture();
        const dto = await f.save(payload({ notas }));
        assert.equal(dto.avaliacao.notas.length, notas.length);
        assert.equal(dto.avaliacao.media, notas.length === 2 ? '55.00' : null);
        assert.equal(dto.avaliacao.dataConclusao, null);
    });
}
test('primeira criacao direta concluida e motivo normalizado, sem decisao institucional', async () => {
    const f = fixture();
    const dto = await f.save(payload({ estado: 'concluida', notas: completas(), possivelDesclassificacao: true, motivoDesclassificacao: '  motivo  ' }));
    assert.equal(dto.estado, 'concluida');
    assert.equal(dto.avaliacao.dataConclusao, data);
    assert.equal(dto.avaliacao.motivoDesclassificacao, 'motivo');
    assert.equal(f.state.participantes[0].estado_participacao, 'incluido');
});
test('limite de motivo usa caracteres Unicode, nao unidades UTF-16', async () => {
    const f = fixture();
    await f.save(payload({ possivelDesclassificacao: true, motivoDesclassificacao: '\u{1f600}'.repeat(2000) }));
    assert.equal(Array.from(f.state.avaliacoes[0].motivo_desclassificacao).length, 2000);
});
for (const [nome, p, a, code] of [
    ['primeira concorrente ja criada', payload(), tentativa(), 'TENTATIVA_DESATUALIZADA'],
    ['numero errado', edicao({ contexto: { idCiclo: 20, numeroTentativa: 2 } }), tentativa(), 'TENTATIVA_DESATUALIZADA'],
    ['versao antiga', edicao({ versao: 2 }), tentativa(), 'VERSAO_DESATUALIZADA'],
    ['concluida', edicao(), tentativa({ estado: 'concluida', data_conclusao: data }), 'AVALIACAO_CONCLUIDA'],
    ['overflow', edicao({ versao: 4294967295 }), tentativa({ versao: 4294967295 }), 'CONTEXTO_NAO_GRAVAVEL']
]) {
    test(`stale/imutabilidade: ${nome}`, async () => {
        const f = fixture({ state: { avaliacoes: [a] } });
        await assert.rejects(f.save(p), erroWriter(code));
        assert.equal(f.writes().length, 0);
    });
}
test('rascunho existente substitui notas, preserva inclusao/origem e incrementa versao', async () => {
    const f = fixture({ state: { avaliacoes: [tentativa()], notas: [nota(), nota({ id_criterio: 102, id_criterio_ciclo: 502 })] } });
    const dto = await f.save(edicao({ notas: [{ idCriterioCiclo: 502, nota: 100 }] }));
    assert.equal(dto.versao, 4);
    assert.equal(dto.avaliacao.notas.length, 1);
    assert.equal(dto.avaliacao.notas[0].idCriterioOrigem, 102);
    assert.equal(dto.avaliacao.dataInclusao, '2026-10-01 10:00:00');
    assert.equal(dto.avaliacao.dataAtualizacao, data);
    assert.equal(f.writes().filter(c => c.sql.startsWith('INSERT INTO ist_eventos_avaliacoes ')).length, 0);
});
test('lista vazia limpa notas; save identico tambem incrementa', async () => {
    const f = fixture({ state: { avaliacoes: [tentativa()], notas: [nota()] } });
    await f.save(edicao());
    assert.deepEqual(f.state.notas, []);
    assert.equal(f.state.avaliacoes[0].versao, 4);
    await f.save(edicao({ versao: 4 }));
    assert.equal(f.state.avaliacoes[0].versao, 5);
});
test('conclusao de rascunho persiste notas e estado atomicamente', async () => {
    const f = fixture({ state: { avaliacoes: [tentativa()] } });
    const dto = await f.save(edicao({ estado: 'concluida', notas: completas() }));
    assert.equal(dto.versao, 4);
    assert.equal(dto.estado, 'concluida');
    assert.equal(dto.avaliacao.dataConclusao, data);
});
test('tentativa N>1 materializada: lacunas aceitas, origem preservada, nenhum N+1', async () => {
    const f = fixture({ state: { avaliacoes: [
        tentativa({ id_avaliacao: 59, numero_tentativa: 1, estado: 'concluida', data_conclusao: data }),
        tentativa({ numero_tentativa: 7, id_avaliacao_origem: 59 })
    ] } });
    const dto = await f.save(edicao({ contexto: { idCiclo: 20, numeroTentativa: 7 } }));
    assert.equal(dto.contexto.numeroTentativa, 7);
    assert.equal(f.state.avaliacoes.length, 2);
    assert.equal(f.state.avaliacoes[1].id_avaliacao_origem, 59);
    assert.equal(f.writes().some(c => c.sql.startsWith('INSERT INTO ist_eventos_avaliacoes ')), false);
});
test('historico completo invalido impede escrita', async () => {
    const f = fixture({ state: { avaliacoes: [tentativa(), tentativa({ id_avaliacao: 61, numero_tentativa: 7 })] } });
    await assert.rejects(f.save(edicao()), erroContexto('TENTATIVAS_INVALIDAS'));
    assert.equal(f.writes().length, 0);
});
for (const [nome, notas] of [
    ['outro evento', [nota({ id_evento: 99 })]], ['outro ciclo', [nota({ id_ciclo: 99 })]],
    ['origem divergente', [nota({ id_criterio: 999 })]], ['snapshot desconhecido', [nota({ id_criterio_ciclo: 999 })]],
    ['nota fora faixa', [nota({ nota: 101 })]], ['duplicada', [nota(), nota()]]
]) {
    test(`notas antigas invalidas impedem DELETE: ${nome}`, async () => {
        const f = fixture({ state: { avaliacoes: [tentativa()], notas } });
        await assert.rejects(f.save(edicao()), erroContexto('CONTEXTO_INCONSISTENTE'));
        assert.equal(f.writes().length, 0);
    });
}
for (const count of [0, 2]) {
    test(`UPDATE affectedRows=${count} nao confirma sucesso`, async () => {
        const f = fixture({ state: { avaliacoes: [tentativa()] }, affectedRows: count });
        await assert.rejects(f.save(edicao()), count === 0 ? erroWriter('VERSAO_DESATUALIZADA') : erroContexto('CONTEXTO_INCONSISTENTE'));
        assert.equal(f.calls.some(c => c.sql.startsWith('DELETE')), false);
        assert.equal(f.calls.some(c => c.sql === 'COMMIT'), false);
    });
}
for (const key of ['uq_avaliacao_tentativa', 'ist_eventos_avaliacoes.uq_avaliacao_tentativa']) {
    test(`duplicate reconhecido somente na primeira criacao: ${key}`, async () => {
        const f = fixture({ insertError: duplicate(key) });
        await assert.rejects(f.save(), erroWriter('CONFLITO_CONCORRENCIA'));
        assert.equal(f.calls.some(c => c.sql === 'COMMIT'), false);
    });
}
for (const error of [
    duplicate('PRIMARY'), duplicate('outra.uq_avaliacao_tentativa'), duplicate('uq_avaliacao_tentativa_extra'),
    { ...duplicate('uq_avaliacao_tentativa'), sqlMessage: 'formato desconhecido uq_avaliacao_tentativa' },
    { ...duplicate('uq_avaliacao_tentativa'), errno: 1 },
    { ...duplicate('uq_avaliacao_tentativa'), code: 'OUTRO' }
]) {
    test(`duplicate nao reconhecido preserva erro: ${error.sqlMessage}/${error.code}/${error.errno}`, async () => {
        assert.equal(duplicidadeTentativa(error), false);
        const f = fixture({ insertError: error });
        await assert.rejects(f.save(), e => e === error);
    });
}
for (const [nome, trecho, p, state] of [
    ['INSERT notas', 'INSERT INTO ist_eventos_avaliacoes_notas', payload({ notas: completas() }), {}],
    ['UPDATE', 'UPDATE ist_eventos_avaliacoes', edicao(), { avaliacoes: [tentativa()] }],
    ['DELETE', 'DELETE FROM', edicao(), { avaliacoes: [tentativa()], notas: [nota()] }],
    ['SELECT inesperado', 'FROM ist_usuarios', payload(), {}],
    ['duplicate de notas nao traduzido', 'INSERT INTO ist_eventos_avaliacoes_notas', payload({ notas: completas() }), {}]
]) {
    test(`falha SQL propagada e rollback: ${nome}`, async () => {
        const error = nome.startsWith('duplicate') ? duplicate('uq_avaliacao_tentativa') : sqlError();
        const f = fixture({ state, queryError: { trecho, error } });
        const inicial = structuredClone({ avaliacoes: f.state.avaliacoes, notas: f.state.notas });
        await assert.rejects(f.save(p), e => e === error);
        assert.deepEqual({ avaliacoes: f.state.avaliacoes, notas: f.state.notas }, inicial);
        assert.deepEqual(f.calls.slice(-2).map(c => c.sql), ['ROLLBACK', 'RELEASE']);
    });
}
test('reader falha depois da persistencia: rollback inclusive avaliacao nova', async () => {
    const error = sqlError();
    const f = fixture({ readerError: error });
    await assert.rejects(f.save(payload({ notas: completas() })), e => e === error);
    assert.deepEqual(f.state.avaliacoes, []);
    assert.deepEqual(f.state.notas, []);
    assert.equal(f.calls.some(c => c.sql === 'COMMIT'), false);
});
for (const [nome, alterar] of [
    ['versao', a => { a.versao++; }], ['tentativa', a => { a.numero_tentativa = 9; }],
    ['estado', a => { a.estado = 'concluida'; a.data_conclusao = data; }],
    ['ID', a => { a.id_avaliacao = 99; }], ['ciclo', a => { a.id_ciclo = 99; }]
]) {
    test(`DTO divergente impede commit: ${nome}`, async () => {
        const f = fixture({ onQuery(call, state, { wrote }) {
            if (wrote && call.sql.includes('FROM ist_eventos_avaliacoes WHERE')) alterar(state.avaliacoes[0]);
        } });
        await assert.rejects(f.save(payload({ notas: completas() })), erroContexto('CONTEXTO_INCONSISTENTE'));
        assert.equal(f.calls.some(c => c.sql === 'COMMIT'), false);
        assert.deepEqual(f.state.avaliacoes, []);
    });
}
test('payload e evento nao sofrem mutacao; input congelado antes de await', async () => {
    const p = payload({ notas: completas() });
    const inicial = structuredClone(p);
    const f = fixture({ onQuery(call) {
        if (call.sql.includes('FROM ist_eventos_julgamentos') && call.sql.endsWith('FOR UPDATE')) {
            p.contexto.idCiclo = 999;
            p.notas[0].nota = 1;
        }
    } });
    const dto = await f.save(p);
    assert.equal(dto.contexto.idCiclo, 20);
    assert.equal(dto.avaliacao.notas[1].nota, inicial.notas[0].nota);
});
for (const stage of ['acquireError', 'isolationError', 'beginError', 'commitError']) {
    test(`falha de lifecycle: ${stage}`, async () => {
        const error = sqlError();
        const f = fixture({ [stage]: error });
        await assert.rejects(f.save(), e => e === error);
        const sqls = f.calls.map(c => c.sql);
        if (stage === 'acquireError') assert.deepEqual(sqls, []);
        if (stage === 'isolationError' || stage === 'beginError') {
            assert.equal(sqls.includes('ROLLBACK'), false);
            assert.equal(sqls.at(-1), 'DESTROY');
        }
        if (stage === 'commitError') {
            assert.deepEqual(sqls.slice(-3), ['COMMIT', 'ROLLBACK', 'DESTROY']);
            assert.equal(sqls.includes('RELEASE'), false);
        }
    });
}
test('rollback failure nao mascara primaryError e destroi uma vez', async t => {
    const logs = [];
    t.mock.method(console, 'error', (...args) => logs.push(args));
    const primary = sqlError();
    const f = fixture({ readerError: primary, rollbackError: sqlError(), destroyError: sqlError() });
    await assert.rejects(f.save(), e => e === primary);
    assert.equal(f.calls.filter(c => c.sql === 'DESTROY').length, 1);
    assert.equal(f.calls.some(c => c.sql === 'RELEASE'), false);
    assert.equal(logs.length, 2);
    assert.doesNotMatch(JSON.stringify(logs), /falha simulada|sqlMessage|nota|cookie|JWT/);
});
for (const destroyFails of [false, true]) {
    test(`release sincrono falha apos commit; sucesso preservado, destroy falha=${destroyFails}`, async t => {
        const logs = [];
        t.mock.method(console, 'error', (...args) => logs.push(args));
        const f = fixture({ releaseError: sqlError(), ...(destroyFails ? { destroyError: sqlError() } : {}) });
        const dto = await f.save();
        assert.equal(dto.versao, 1);
        assert.deepEqual(f.calls.slice(-3).map(c => c.sql), ['COMMIT', 'RELEASE', 'DESTROY']);
        assert.equal(f.calls.some(c => c.sql === 'ROLLBACK'), false);
        assert.equal(f.state.avaliacoes.length, 1);
        assert.equal(logs[0][1].commitConfirmed, true);
        assert.equal(logs.length, destroyFails ? 2 : 1);
    });
}
test('release falha com primaryError: erro original permanece', async t => {
    t.mock.method(console, 'error', () => {});
    const primary = sqlError();
    const f = fixture({ readerError: primary, releaseError: sqlError() });
    await assert.rejects(f.save(), e => e === primary);
    assert.deepEqual(f.calls.slice(-3).map(c => c.sql), ['ROLLBACK', 'RELEASE', 'DESTROY']);
});
for (const [code, errno] of [['ER_LOCK_DEADLOCK', 1213], ['ER_LOCK_WAIT_TIMEOUT', 1205]]) {
    test(`concorrencia conhecida antes de commit: ${code}`, async t => {
        t.mock.method(console, 'error', () => {});
        const f = fixture({ queryError: { trecho: 'FROM ist_usuarios', error: sqlError(code, errno) } });
        await assert.rejects(f.save(), erroWriter('CONFLITO_CONCORRENCIA'));
        assert.deepEqual(f.calls.slice(-2).map(c => c.sql), ['ROLLBACK', 'RELEASE']);
    });
}
test('erro de commit nao vira conflito retryable mesmo com codigo de lock', async () => {
    const primary = sqlError('ER_LOCK_WAIT_TIMEOUT', 1205);
    const f = fixture({ commitError: primary });
    await assert.rejects(f.save(), e => e === primary);
});
for (const destroyFails of [false, true]) {
    test(`logger lanca apos commit e release failure; sucesso preservado, destroy falha=${destroyFails}`, async t => {
        const logger = t.mock.method(console, 'error', () => { throw new Error('logger indisponivel'); });
        const f = fixture({ releaseError: sqlError(), ...(destroyFails ? { destroyError: sqlError() } : {}) });
        const dto = await f.save();
        assert.equal(dto.versao, 1);
        assert.equal(dto.avaliacao.idAvaliacao, 61);
        assert.equal(f.state.avaliacoes.length, 1);
        assert.deepEqual(f.calls.slice(-3).map(c => c.sql), ['COMMIT', 'RELEASE', 'DESTROY']);
        assert.equal(f.calls.some(c => c.sql === 'ROLLBACK'), false);
        assert.equal(f.calls.filter(c => c.sql === 'DESTROY').length, 1);
        assert.equal(logger.mock.callCount(), destroyFails ? 2 : 1);
    });
    test(`logger lanca durante rollback failure; primaryError preservado, destroy falha=${destroyFails}`, async t => {
        const logger = t.mock.method(console, 'error', () => { throw new Error('logger indisponivel'); });
        const primary = sqlError();
        const f = fixture({ readerError: primary, rollbackError: sqlError(), ...(destroyFails ? { destroyError: sqlError() } : {}) });
        await assert.rejects(f.save(), e => e === primary);
        assert.deepEqual(f.calls.slice(-2).map(c => c.sql), ['ROLLBACK', 'DESTROY']);
        assert.equal(f.calls.some(c => c.sql === 'RELEASE' || c.sql === 'COMMIT'), false);
        assert.equal(f.calls.filter(c => c.sql === 'DESTROY').length, 1);
        assert.equal(logger.mock.callCount(), destroyFails ? 2 : 1);
    });
}
test('duplicate reconhecida preserva conflito mesmo com logger indisponivel no cleanup', async t => {
    const logger = t.mock.method(console, 'error', () => { throw new Error('logger indisponivel'); });
    const f = fixture({ insertError: duplicate('uq_avaliacao_tentativa'), releaseError: sqlError() });
    await assert.rejects(f.save(), erroWriter('CONFLITO_CONCORRENCIA'));
    assert.deepEqual(f.calls.slice(-3).map(c => c.sql), ['ROLLBACK', 'RELEASE', 'DESTROY']);
    assert.equal(logger.mock.callCount(), 1);
    assert.equal(f.state.avaliacoes.length, 0);
});
for (const [code, errno] of [['ER_LOCK_DEADLOCK', 1213], ['ER_LOCK_WAIT_TIMEOUT', 1205]]) {
    test(`logger de concorrencia lanca sem substituir dominio: ${code}`, async t => {
        const logger = t.mock.method(console, 'error', () => { throw new Error('logger indisponivel'); });
        const f = fixture({ queryError: { trecho: 'FROM ist_usuarios', error: sqlError(code, errno) } });
        await assert.rejects(f.save(), erroWriter('CONFLITO_CONCORRENCIA'));
        assert.deepEqual(f.calls.slice(-2).map(c => c.sql), ['ROLLBACK', 'RELEASE']);
        assert.equal(logger.mock.callCount(), 1);
    });
}
test('commit failure com cleanup e logger falhando preserva erro de commit', async t => {
    t.mock.method(console, 'error', () => { throw new Error('logger indisponivel'); });
    const primary = sqlError();
    const f = fixture({ commitError: primary, rollbackError: sqlError(), destroyError: sqlError() });
    await assert.rejects(f.save(), e => e === primary);
    assert.deepEqual(f.calls.slice(-3).map(c => c.sql), ['COMMIT', 'ROLLBACK', 'DESTROY']);
    assert.equal(f.calls.filter(c => c.sql === 'DESTROY').length, 1);
    assert.equal(f.calls.some(c => c.sql === 'RELEASE'), false);
});
test('arquivo nao integra HTTP nem modifica outras autoridades; todos os executores sao explicitos', () => {
    const source = readFileSync(new URL('../src/services/juradoAvaliacaoGravacaoService.js', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /express|req\.|res\.|\.status\(|\.json\(/);
    assert.doesNotMatch(source, /FOR UPDATE[^\n]*ist_eventos_avaliacoes_notas|SET SESSION|MAX\(/);
    assert.match(source, /resolverContextoJulgamento\(identificado, connection\)/);
    assert.match(source, /resolverJuradoCiclo\(contexto, idUsuarioAutenticado, connection,/);
    assert.match(source, /resolverConcorrenteCiclo\(contexto, idParticipacao, connection,/);
    assert.match(source, /carregarCriteriosCiclo\(contexto, connection\)/);
    assert.match(source, /obterAvaliacaoJuradoCycleAware\(identificado, idParticipacao, idUsuarioAutenticado, connection\)/);
});
