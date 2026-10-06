import assert from 'node:assert/strict';
import { test } from 'node:test';
import { obterAvaliacaoJuradoCycleAware } from '../src/services/juradoAvaliacaoLeituraService.js';
import { JULGAMENTO_ERROS, JulgamentoContextError } from '../src/services/julgamentoContextService.js';

const evento = { id: 17, slug: 'evento-teste', nome: 'Evento Teste' };
const par = { id_evento: 17, id_ciclo: 20, id_jurado: 10, id_concorrente: 40 };
const ciclo = (campos = {}) => ({
    id_ciclo: 20, id_evento: 17, numero_ciclo: 1, estado: 'aberto',
    id_ciclo_origem: null, id_publicacao_origem: null, motivo_reabertura: null,
    publicado_em: null, ...campos
});
const participante = (campos = {}) => ({
    id_ciclo_concorrente: 30, id_ciclo: 20, id_evento: 17, id_concorrente: 40, id_usuario: 50,
    numero_concorrente: 'SNAP-040', nome_publico: 'Nome congelado',
    id_obra_1: 22, obra_1_publica: 'Obra congelada', link_video_1: 'video-congelado-1',
    id_obra_2: 23, obra_2_publica: 'Segunda congelada', link_video_2: 'video-congelado-2',
    fingerprint: 'a'.repeat(64), estado_participacao: 'incluido', ...campos
});
const criterios = () => [
    { id_criterio_ciclo: 501, id_criterio_origem: 101, id_ciclo: 20, id_evento: 17, nome: 'Primeiro snapshot', descricao: null, ordem: 1, peso: '40.00' },
    { id_criterio_ciclo: 502, id_criterio_origem: 102, id_ciclo: 20, id_evento: 17, nome: 'Segundo snapshot', descricao: 'Descricao congelada', ordem: 2, peso: '60.00' }
];
const tentativa = (campos = {}) => ({
    ...par, id_avaliacao: 60, numero_tentativa: 1, id_avaliacao_origem: null,
    estado: 'rascunho', versao: 3, possivel_desclassificacao: 0, motivo_desclassificacao: null,
    data_inclusao: '2026-10-01 10:00:00', data_atualizacao: '2026-10-02 11:00:00',
    data_conclusao: null, ...campos
});
const nota = (campos = {}) => ({
    id_avaliacao: 60, id_evento: 17, id_ciclo: 20, id_criterio: 101, id_criterio_ciclo: 501, nota: 25, ...campos
});
const notasCompletas = (idAvaliacao = 60) => [
    nota({ id_avaliacao: idAvaliacao }),
    nota({ id_avaliacao: idAvaliacao, id_criterio: 102, id_criterio_ciclo: 502, nota: 75 })
];
const erro = code => error => error instanceof JulgamentoContextError && error.code === code;

function executor(dados = {}) {
    const state = {
        eventos: [evento],
        julgamentos: [{ id_evento: 17, id_ciclo_atual: 20, id_publicacao_vigente: null, quantidade_classificados: null, versao: 1 }],
        ciclos: [ciclo()],
        publicacoes: [],
        usuarios: [{ id_usuario: 10, id_tipo_usuario: 4, id_situacao: 8, id_cargo: 11 }],
        designacoes: [{ id_evento: 17, id_usuario: 10, ativo: 1 }],
        jurados: [{ id_ciclo: 20, id_evento: 17, id_usuario: 10, nome_publico: 'Jurado snapshot', estado_participacao: 'incluido' }],
        participantes: [participante()],
        criterios: criterios(),
        avaliacoes: [],
        notas: [],
        ...dados
    };
    const consultas = [];
    const proibido = () => assert.fail('Service nao pode controlar conexao/transacao');
    return {
        consultas,
        getConnection: proibido, beginTransaction: proibido, commit: proibido,
        rollback: proibido, release: proibido, destroy: proibido,
        async query(sql, params) {
            const normalized = sql.replace(/\s+/g, ' ').trim();
            consultas.push({ sql: normalized, params });
            assert.match(normalized, /^SELECT /);
            assert.doesNotMatch(normalized, /\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP|MAX|COMMIT|ROLLBACK|START TRANSACTION|LOCK IN SHARE MODE)\b/);
            assert.doesNotMatch(normalized, /\bist_eventos_criterios_avaliacao\b|\bist_concorrentes\b|\bist_composicao\b/);
            if (state.falha && normalized.includes(state.falha.trecho)) throw state.falha.error;
            if (normalized.includes('FROM ist_usuarios')) {
                assert.equal(normalized, 'SELECT id_usuario, id_tipo_usuario, id_situacao, id_cargo FROM ist_usuarios WHERE id_usuario = ?');
                return [state.usuarios.filter(u => u.id_usuario === params[0])];
            }
            if (normalized.includes('FROM ist_eventos_jurados')) {
                assert.equal(normalized, 'SELECT id_evento, id_usuario, ativo FROM ist_eventos_jurados WHERE id_evento = ? AND id_usuario = ?');
                return [state.designacoes.filter(j => j.id_evento === params[0] && j.id_usuario === params[1])];
            }
            if (normalized.includes('FROM ist_eventos WHERE')) return [state.eventos.filter(e => e.id === params[0])];
            if (normalized.includes('FROM ist_eventos_julgamentos')) {
                assert.deepEqual(params, [17]);
                return [state.julgamentos];
            }
            if (normalized.includes('FROM ist_eventos_ciclos WHERE')) return [state.ciclos.filter(c => c.id_ciclo === params[0])];
            if (normalized.includes('FROM ist_eventos_publicacoes p')) return [state.publicacoes.filter(p => p.id_publicacao === params[0])];
            if (normalized.includes('FROM ist_eventos_publicacoes WHERE')) return [state.publicacoes.filter(p => p.id_evento === params[0] && p.id_ciclo === params[1])];
            if (normalized.includes('FROM ist_eventos_ciclos_jurados')) {
                assert.match(normalized, /WHERE id_ciclo = \? AND id_usuario = \?$/);
                return [state.jurados.filter(j => j.id_ciclo === params[0] && j.id_usuario === params[1])];
            }
            if (normalized.includes('FROM ist_eventos_ciclos_concorrentes')) {
                assert.match(normalized, /WHERE id_ciclo = \? AND id_concorrente = \?$/);
                return [state.participantes.filter(p => p.id_ciclo === params[0] && p.id_concorrente === params[1])];
            }
            if (normalized.includes('FROM ist_eventos_ciclos_criterios')) {
                assert.match(normalized, /WHERE id_ciclo = \? ORDER BY ordem, id_criterio_ciclo$/);
                return [state.criterios.filter(c => c.id_ciclo === params[0])];
            }
            if (normalized.includes('FROM ist_eventos_avaliacoes_notas')) {
                assert.equal(normalized, 'SELECT id_avaliacao, id_evento, id_ciclo, id_criterio, id_criterio_ciclo, nota FROM ist_eventos_avaliacoes_notas WHERE id_avaliacao = ?');
                return ['notasRetornadas' in state ? state.notasRetornadas : state.notas.filter(n => n.id_avaliacao === params[0])];
            }
            if (normalized.includes('FROM ist_eventos_avaliacoes')) {
                assert.equal(normalized, 'SELECT id_avaliacao, id_evento, id_ciclo, id_jurado, id_concorrente, numero_tentativa, id_avaliacao_origem, estado, versao, possivel_desclassificacao, motivo_desclassificacao, data_inclusao, data_atualizacao, data_conclusao FROM ist_eventos_avaliacoes WHERE id_evento = ? AND id_ciclo = ? AND id_jurado = ? AND id_concorrente = ? ORDER BY numero_tentativa, id_avaliacao');
                return ['avaliacoesRetornadas' in state ? state.avaliacoesRetornadas
                    : state.avaliacoes.filter(a => a.id_evento === params[0] && a.id_ciclo === params[1] && a.id_jurado === params[2] && a.id_concorrente === params[3])];
            }
            assert.fail('SQL nao simulado: ' + normalized);
        }
    };
}
const ler = db => obterAvaliacaoJuradoCycleAware(evento, 40, 10, db);

test('pendente usa ponteiro atual/snapshots e consulta live apenas para autorizacao, sem escrita', async () => {
    const db = executor({
        ciclos: [ciclo(), ciclo({ id_ciclo: 999, numero_ciclo: 99 })],
        avaliacoes: [tentativa({ id_ciclo: 999, numero_tentativa: 99 })],
        notas: notasCompletas()
    });
    const resposta = await ler(db);
    assert.deepEqual(resposta, {
        evento,
        contexto: { idCiclo: 20, numeroCiclo: 1, numeroTentativa: null },
        podeGravar: true,
        autorizacaoGravacao: { estado: 'autorizada', code: null, motivo: null },
        concorrente: {
            idParticipacao: 40, idSnapshot: 30, numeroConcorrente: 'SNAP-040', nome: 'Nome congelado',
            obraPrincipal: { id: 22, titulo: 'Obra congelada' }, linkVideoPrincipal: 'video-congelado-1',
            obraOpcional: { id: 23, titulo: 'Segunda congelada' }, linkVideoOpcional: 'video-congelado-2'
        },
        estado: 'pendente', versao: 0, escala: { min: 0, max: 100, passo: 1 },
        criterios: [
            { idCriterio: 101, idCriterioOrigem: 101, idCriterioCiclo: 501, nome: 'Primeiro snapshot', descricao: null, ordem: 1, peso: '40.00' },
            { idCriterio: 102, idCriterioOrigem: 102, idCriterioCiclo: 502, nome: 'Segundo snapshot', descricao: 'Descricao congelada', ordem: 2, peso: '60.00' }
        ],
        avaliacao: null
    });
    assert.equal(db.consultas.length, 9);
    assert(!db.consultas.some(c => c.sql.includes('FROM ist_eventos_avaliacoes_notas')));
    assert.deepEqual(db.consultas.find(c => c.sql.includes('FROM ist_eventos_avaliacoes ')).params, [17, 20, 10, 40]);
});

for (const [nome, dados, code] of [
    ['julgamento ausente', { julgamentos: [] }, JULGAMENTO_ERROS.JULGAMENTO_NAO_CONFIGURADO],
    ['ponteiro NULL sem fallback', { julgamentos: [{ id_evento: 17, id_ciclo_atual: null, id_publicacao_vigente: null, quantidade_classificados: null, versao: 1 }] }, JULGAMENTO_ERROS.CICLO_ATUAL_AUSENTE],
    ['ciclo apontado ausente', { ciclos: [ciclo({ id_ciclo: 999 })] }, JULGAMENTO_ERROS.CONTEXTO_INCONSISTENTE],
    ['jurado fora do roster', { jurados: [] }, JULGAMENTO_ERROS.JURADO_FORA_ROSTER],
    ['concorrente ausente', { participantes: [] }, JULGAMENTO_ERROS.CONCORRENTE_AUSENTE],
    ['criterios ausentes', { criterios: [] }, JULGAMENTO_ERROS.CRITERIOS_INVALIDOS]
]) test('propaga dominio: ' + nome, async () => {
    await assert.rejects(ler(executor(dados)), erro(code));
});
for (const estado of ['inelegivel', 'retirado']) test('jurado nao incluido: ' + estado, async () => {
    const db = executor({ jurados: [{ id_ciclo: 20, id_evento: 17, id_usuario: 10, nome_publico: 'Jurado', estado_participacao: estado }] });
    await assert.rejects(ler(db), erro(JULGAMENTO_ERROS.JURADO_NAO_INCLUIDO));
    assert(!db.consultas.some(c => c.sql.includes('FROM ist_eventos_avaliacoes ')));
});
for (const estado of ['desistente', 'desclassificado', 'inelegivel']) test('concorrente nao incluido: ' + estado, async () => {
    await assert.rejects(ler(executor({ participantes: [participante({ estado_participacao: estado })] })), erro(JULGAMENTO_ERROS.CONCORRENTE_NAO_INCLUIDO));
});

test('idParticipacao, idSnapshot e idUsuario distintos; jurado vem do argumento autenticado', async () => {
    const db = executor({
        jurados: [{ id_ciclo: 20, id_evento: 17, id_usuario: 11, nome_publico: 'Outro jurado', estado_participacao: 'incluido' }],
        avaliacoes: [tentativa(), tentativa({ id_avaliacao: 61, id_jurado: 11 })]
    });
    const resposta = await obterAvaliacaoJuradoCycleAware(evento, 40, 11, db);
    assert.equal(resposta.avaliacao.idAvaliacao, 61);
    assert.equal(resposta.concorrente.idParticipacao, 40);
    assert.equal(resposta.concorrente.idSnapshot, 30);
    assert.deepEqual(db.consultas.find(c => c.sql.includes('FROM ist_eventos_ciclos_jurados')).params, [20, 11]);
    assert.deepEqual(db.consultas.find(c => c.sql.includes('FROM ist_eventos_avaliacoes ')).params, [17, 20, 11, 40]);
    for (const idErrado of [30, 50]) {
        await assert.rejects(obterAvaliacaoJuradoCycleAware(evento, idErrado, 11, db), erro(JULGAMENTO_ERROS.CONCORRENTE_AUSENTE));
    }
});

for (const [nome, avaliacao, notas, media] of [
    ['rascunho vazio', tentativa(), [], null],
    ['rascunho parcial', tentativa(), [nota()], null],
    ['rascunho completo', tentativa(), notasCompletas(), '55.00'],
    ['concluida completa', tentativa({ estado: 'concluida', data_conclusao: '2026-10-03 12:00:00' }), notasCompletas(), '55.00']
]) test(nome + ': notas e media snapshot', async () => {
    const resposta = await ler(executor({ avaliacoes: [avaliacao], notas }));
    assert.equal(resposta.estado, avaliacao.estado);
    assert.equal(resposta.versao, 3);
    assert.equal(resposta.contexto.numeroTentativa, 1);
    assert.deepEqual(resposta.avaliacao, {
        idAvaliacao: 60,
        notas: notas.map(n => ({ idCriterio: n.id_criterio, idCriterioOrigem: n.id_criterio, idCriterioCiclo: n.id_criterio_ciclo, nota: n.nota })),
        possivelDesclassificacao: false, motivoDesclassificacao: null, media,
        dataInclusao: avaliacao.data_inclusao, dataAtualizacao: avaliacao.data_atualizacao, dataConclusao: avaliacao.data_conclusao
    });
    assert.equal(resposta.podeGravar, avaliacao.estado !== 'concluida');
    assert.deepEqual(resposta.autorizacaoGravacao, avaliacao.estado === 'concluida'
        ? { estado: 'avaliacao_concluida', code: 'AVALIACAO_CONCLUIDA', motivo: 'AVALIACAO_CONCLUIDA' }
        : { estado: 'autorizada', code: null, motivo: null });
});
for (const notas of [[], [nota()]]) test('concluida incompleta com ' + notas.length + ' notas rejeitada', async () => {
    await assert.rejects(ler(executor({
        avaliacoes: [tentativa({ estado: 'concluida', data_conclusao: '2026-10-03 12:00:00' })], notas
    })), erro(JULGAMENTO_ERROS.CONTEXTO_INCONSISTENTE));
});

for (const numero of [2, 3]) test('maior tentativa ' + numero + ' vence versao antiga e so suas notas sao lidas', async () => {
    const atual = tentativa({ id_avaliacao: 61, numero_tentativa: numero, versao: 1, id_avaliacao_origem: 59 });
    const db = executor({
        avaliacoes: [
            atual, tentativa({ estado: 'concluida', versao: 100, data_conclusao: '2026-10-03 12:00:00' }),
            tentativa({ id_avaliacao: 999, id_ciclo: 999, numero_tentativa: 999 }),
            tentativa({ id_avaliacao: 998, id_jurado: 11 }),
            tentativa({ id_avaliacao: 997, id_concorrente: 41 }),
            tentativa({ id_avaliacao: 996, id_evento: 18 })
        ],
        notas: [...notasCompletas(60), ...notasCompletas(61)]
    });
    const resposta = await ler(db);
    assert.equal(resposta.avaliacao.idAvaliacao, 61);
    assert.equal(resposta.versao, 1);
    assert.equal(resposta.contexto.numeroTentativa, numero);
    const consultasNotas = db.consultas.filter(c => c.sql.includes('FROM ist_eventos_avaliacoes_notas'));
    assert.equal(consultasNotas.length, 1);
    assert.deepEqual(consultasNotas[0].params, [61]);
});
test('duas concluidas com lacuna retornam maior tentativa', async () => {
    const db = executor({
        avaliacoes: [
            tentativa({ estado: 'concluida', data_conclusao: '2026-10-03 12:00:00' }),
            tentativa({ id_avaliacao: 61, numero_tentativa: 3, estado: 'concluida', data_conclusao: '2026-10-04 12:00:00', id_avaliacao_origem: 60 })
        ],
        notas: notasCompletas(61)
    });
    assert.equal((await ler(db)).avaliacao.idAvaliacao, 61);
});
for (const [nome, rows] of [
    ['dois rascunhos', [tentativa(), tentativa({ id_avaliacao: 61, numero_tentativa: 3 })]],
    ['rascunho anterior', [tentativa(), tentativa({ id_avaliacao: 61, numero_tentativa: 3, estado: 'concluida' })]],
    ['numero duplicado', [tentativa({ estado: 'concluida' }), tentativa({ id_avaliacao: 61 })]],
    ['numero zero', [tentativa({ numero_tentativa: 0 })]],
    ['versao zero', [tentativa({ versao: 0 })]],
    ['auto origem', [tentativa({ id_avaliacao_origem: 60 })]],
    ['origem posterior', [tentativa({ estado: 'concluida', id_avaliacao_origem: 61 }), tentativa({ id_avaliacao: 61, numero_tentativa: 3 })]],
    ['par divergente retornado', [tentativa({ id_jurado: 11 })]]
]) test('historico invalido propagado: ' + nome, async () => {
    const db = executor({ avaliacoesRetornadas: rows });
    await assert.rejects(ler(db), erro(JULGAMENTO_ERROS.TENTATIVAS_INVALIDAS));
    assert(!db.consultas.some(c => c.sql.includes('FROM ist_eventos_avaliacoes_notas')));
});

for (const [nome, campos] of [
    ['snapshot desconhecido', { id_criterio_ciclo: 999 }],
    ['snapshot ausente', { id_criterio_ciclo: null }],
    ['snapshot string', { id_criterio_ciclo: '501' }],
    ['origem divergente', { id_criterio: 102 }],
    ['origem desconhecida', { id_criterio: 999 }],
    ['avaliacao divergente', { id_avaliacao: 61 }],
    ['evento divergente', { id_evento: 18 }],
    ['ciclo divergente', { id_ciclo: 21 }],
    ['nota negativa', { nota: -1 }],
    ['nota acima de 100', { nota: 101 }],
    ['nota fracionaria', { nota: 25.5 }],
    ['nota string', { nota: '25' }],
    ['nota NULL', { nota: null }]
]) test('nota inconsistente: ' + nome, async () => {
    await assert.rejects(ler(executor({ avaliacoes: [tentativa()], notasRetornadas: [nota(campos)] })), erro(JULGAMENTO_ERROS.CONTEXTO_INCONSISTENTE));
});
test('nota duplicada nao e mascarada nem agregada', async () => {
    await assert.rejects(ler(executor({ avaliacoes: [tentativa()], notas: [nota(), nota()] })), erro(JULGAMENTO_ERROS.CONTEXTO_INCONSISTENTE));
});
for (const rows of [null, {}, [null], [1]]) test('estrutura de notas invalida: ' + JSON.stringify(rows), async () => {
    await assert.rejects(ler(executor({ avaliacoes: [tentativa()], notasRetornadas: rows })), erro(JULGAMENTO_ERROS.CONTEXTO_INCONSISTENTE));
});
test('notas zero e 100 validas; ordenacao deterministica', async () => {
    const db = executor({ avaliacoes: [tentativa()], notas: [
        nota({ id_criterio: 102, id_criterio_ciclo: 502, nota: 100 }), nota({ nota: 0 })
    ] });
    const resposta = await ler(db);
    assert.equal(resposta.avaliacao.media, '60.00');
    assert.deepEqual(resposta.avaliacao.notas.map(n => n.idCriterio), [101, 102]);
});
test('media usa pesos decimais snapshot com arredondamento de duas casas', async () => {
    const config = criterios();
    config[0].peso = '33.33'; config[1].peso = '66.67';
    const resposta = await ler(executor({
        criterios: config, avaliacoes: [tentativa()],
        notas: [nota({ nota: 0 }), nota({ id_criterio: 102, id_criterio_ciclo: 502, nota: 1 })]
    }));
    assert.equal(resposta.avaliacao.media, '0.67');
});
test('criterios sao ordenados e identificam origem separada do snapshot', async () => {
    const resposta = await ler(executor({ criterios: criterios().reverse() }));
    assert.deepEqual(resposta.criterios.map(c => [c.idCriterio, c.idCriterioOrigem, c.idCriterioCiclo]), [[101, 101, 501], [102, 102, 502]]);
});
test('configuracao snapshot invalida nao e substituida por live', async () => {
    const config = criterios(); config[0].peso = '39.00';
    await assert.rejects(ler(executor({ criterios: config })), erro(JULGAMENTO_ERROS.CRITERIOS_INVALIDOS));
});

for (const [nome, campos] of [
    ['sinal 2', { possivel_desclassificacao: 2 }],
    ['sinal string', { possivel_desclassificacao: '1' }],
    ['sinal boolean', { possivel_desclassificacao: true }],
    ['sinal NULL', { possivel_desclassificacao: null }],
    ['motivo sem sinal', { motivo_desclassificacao: 'Motivo' }],
    ['sinal sem motivo', { possivel_desclassificacao: 1 }],
    ['motivo vazio', { possivel_desclassificacao: 1, motivo_desclassificacao: ' ' }],
    ['motivo excessivo', { possivel_desclassificacao: 1, motivo_desclassificacao: 'x'.repeat(2001) }],
    ['inclusao NULL', { data_inclusao: null }],
    ['atualizacao invalida', { data_atualizacao: 'invalida' }],
    ['Date invalido', { data_atualizacao: new Date(NaN) }],
    ['dia inexistente', { data_inclusao: '2026-02-30 10:00:00' }],
    ['hora invalida', { data_inclusao: '2026-10-01 25:00:00' }],
    ['rascunho com conclusao', { data_conclusao: '2026-10-03 12:00:00' }],
    ['concluida sem data', { estado: 'concluida' }],
    ['concluida com data invalida', { estado: 'concluida', data_conclusao: 'invalida' }]
]) test('efetiva invalida: ' + nome, async () => {
    await assert.rejects(ler(executor({ avaliacoes: [tentativa(campos)], notas: notasCompletas() })), erro(JULGAMENTO_ERROS.CONTEXTO_INCONSISTENTE));
});
test('datas mysql2 Date e motivo persistido valido sao preservados sem normalizar', async () => {
    const a = tentativa({
        data_inclusao: new Date('2026-10-01T10:00:00Z'), data_atualizacao: new Date('2026-10-02T10:00:00Z'),
        possivel_desclassificacao: 1, motivo_desclassificacao: ' Motivo capturado '
    });
    const resposta = await ler(executor({ avaliacoes: [a] }));
    assert.equal(resposta.avaliacao.dataInclusao, a.data_inclusao);
    assert.equal(resposta.avaliacao.dataAtualizacao, a.data_atualizacao);
    assert.equal(resposta.avaliacao.possivelDesclassificacao, true);
    assert.equal(resposta.avaliacao.motivoDesclassificacao, ' Motivo capturado ');
});

test('material opcional ausente e campos ausentes do snapshot nao sao inventados', async () => {
    const resposta = await ler(executor({ participantes: [participante({ id_obra_2: null, obra_2_publica: null, link_video_2: null })] }));
    assert.equal(resposta.concorrente.obraOpcional, null);
    assert.equal(resposta.concorrente.linkVideoOpcional, null);
    assert.deepEqual(Object.keys(resposta.concorrente).sort(), [
        'idParticipacao', 'idSnapshot', 'numeroConcorrente', 'nome', 'obraPrincipal',
        'linkVideoPrincipal', 'obraOpcional', 'linkVideoOpcional'
    ].sort());
    assert.doesNotMatch(JSON.stringify(resposta), /cidade|dataInscricao|idUsuario|fingerprint/);
});
test('ciclo selado pode ser lido, mas nunca concede gravacao', async () => {
    const data = '2026-10-03 12:00:00';
    const resposta = await ler(executor({
        ciclos: [ciclo({ estado: 'selado', publicado_em: data })],
        publicacoes: [{ id_publicacao: 70, id_evento: 17, id_ciclo: 20, versao: 1, publicado_em: data,
            ciclo_evento: 17, numero_ciclo: 1, estado_ciclo: 'selado', ciclo_publicado_em: data }]
    }));
    assert.equal(resposta.podeGravar, false);
    assert.deepEqual(resposta.autorizacaoGravacao, {
        estado: 'ciclo_fechado', code: 'CONTEXTO_NAO_GRAVAVEL', motivo: 'CONTEXTO_NAO_GRAVAVEL'
    });
});
test('evento numerico compativel com resolver e evento inexistente distinto', async () => {
    assert.deepEqual((await obterAvaliacaoJuradoCycleAware(17, 40, 10, executor())).evento, evento);
    await assert.rejects(obterAvaliacaoJuradoCycleAware(17, 40, 10, executor({ eventos: [] })), erro(JULGAMENTO_ERROS.EVENTO_INEXISTENTE));
});
for (const valor of [null, undefined, 0, -1, 1.5, '40', {}, 4294967296]) {
    test('idParticipacao invalido nao consulta: ' + JSON.stringify(valor), async () => {
        const db = executor();
        await assert.rejects(obterAvaliacaoJuradoCycleAware(evento, valor, 10, db), erro(JULGAMENTO_ERROS.CONTEXTO_INCONSISTENTE));
        assert.equal(db.consultas.length, 0);
    });
}
for (const valor of [null, undefined, 0, -1, 1.5, '10', {}, 2147483648]) {
    test('idUsuarioAutenticado invalido nao consulta: ' + JSON.stringify(valor), async () => {
        const db = executor();
        await assert.rejects(obterAvaliacaoJuradoCycleAware(evento, 40, valor, db), erro(JULGAMENTO_ERROS.CONTEXTO_INCONSISTENTE));
        assert.equal(db.consultas.length, 0);
    });
}
for (const entrada of [null, {}, 'evento', { ...evento, id: '17' }]) test('evento invalido nao consulta: ' + JSON.stringify(entrada), async () => {
    const db = executor();
    await assert.rejects(obterAvaliacaoJuradoCycleAware(entrada, 40, 10, db), erro(JULGAMENTO_ERROS.CONTEXTO_INCONSISTENTE));
    assert.equal(db.consultas.length, 0);
});
for (const trecho of [
    'FROM ist_eventos_julgamentos', 'FROM ist_eventos_ciclos WHERE',
    'FROM ist_eventos_ciclos_jurados', 'FROM ist_eventos_ciclos_concorrentes',
    'FROM ist_eventos_ciclos_criterios', 'FROM ist_eventos_avaliacoes WHERE',
    'FROM ist_eventos_avaliacoes_notas'
]) test('SQL propagado sem converter em ausencia: ' + trecho, async () => {
    const original = new Error('Infraestrutura indisponivel');
    const db = executor({ avaliacoes: [tentativa()], falha: { trecho, error: original } });
    await assert.rejects(ler(db), error => error === original);
});
test('leitura nao modifica fixtures nem seus arrays', async () => {
    const dados = { avaliacoes: [tentativa()], notas: notasCompletas().reverse(), criterios: criterios().reverse(), participantes: [participante()] };
    const anterior = structuredClone(dados);
    await ler(executor(dados));
    assert.deepEqual(dados, anterior);
});

test('live revogado preserva DTO historico, mas politica nega gravacao em ciclo aberto', async () => {
    const db = executor({ usuarios: [{ id_usuario: 10, id_tipo_usuario: 4, id_situacao: 9, id_cargo: 11 }] });
    const dto = await ler(db);
    assert.equal(dto.concorrente.nome, 'Nome congelado');
    assert.equal(dto.podeGravar, false);
    assert.deepEqual(dto.autorizacaoGravacao, {
        estado: 'jurado_inelegivel', code: 'ACESSO_OPERACIONAL_NEGADO', motivo: 'ACESSO_OPERACIONAL_NEGADO'
    });
    assert.equal(db.consultas.filter(q => q.sql.includes('FROM ist_eventos_jurados')).length, 0);
});
test('designacao inativa nega gravacao sem alterar snapshots e sem locks no reader', async () => {
    const dto = await ler(executor({ designacoes: [{ id_evento: 17, id_usuario: 10, ativo: 0 }] }));
    assert.equal(dto.podeGravar, false);
    assert.equal(dto.autorizacaoGravacao.estado, 'jurado_inelegivel');
});
test('falha SQL na consulta live permanece erro explicito, nao podeGravar=false', async () => {
    const error = new Error('driver unavailable');
    await assert.rejects(ler(executor({ falha: { trecho: 'FROM ist_usuarios', error } })), e => e === error);
});
