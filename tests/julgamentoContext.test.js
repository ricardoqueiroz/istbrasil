import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    JULGAMENTO_ERROS, JulgamentoContextError, resolverContextoJulgamento,
    resolverJuradoCiclo, resolverConcorrenteCiclo, carregarCriteriosCiclo,
    validarCriteriosCiclo, interpretarTentativasCiclo
} from '../src/services/julgamentoContextService.js';

const evento = { id: 17, slug: 'evento-teste', nome: 'Evento Teste', status: 'Concluido' };
const contexto = { id_evento: 17, id_ciclo_atual: 20 };
const julgamento = () => ({ id_evento: 17, id_ciclo_atual: 20, id_publicacao_vigente: null, quantidade_classificados: null, versao: 1 });
const ciclo = (campos = {}) => ({ id_ciclo: 20, id_evento: 17, numero_ciclo: 1, estado: 'aberto', id_ciclo_origem: null, id_publicacao_origem: null, publicado_em: null, motivo_reabertura: null, ...campos });
const jurado = (campos = {}) => ({ id_ciclo: 20, id_evento: 17, id_usuario: 10, nome_publico: 'Jurado', estado_participacao: 'incluido', ...campos });
const participante = (campos = {}) => ({
    id_ciclo_concorrente: 30, id_ciclo: 20, id_evento: 17, id_concorrente: 40, id_usuario: 50,
    numero_concorrente: 'TEST-040', nome_publico: 'Participante', id_obra_1: 22,
    obra_1_publica: 'Obra congelada', link_video_1: 'https://example.invalid/video',
    id_obra_2: null, obra_2_publica: null, link_video_2: null,
    fingerprint: 'a'.repeat(64), estado_participacao: 'incluido', ...campos
});
const criterios = () => [1, 2, 3, 4].map(i => ({
    id_criterio_ciclo: 100 + i, id_criterio_origem: i, id_ciclo: 20, id_evento: 17,
    nome: 'Criterio ' + i, descricao: null, ordem: i, peso: '25.00'
}));
const publicacao = (campos = {}) => ({
    id_publicacao: 70, id_evento: 17, id_ciclo: 20, versao: 1, publicado_em: '2026-10-01 10:00:00',
    ciclo_evento: 17, numero_ciclo: 1, estado_ciclo: 'selado', ciclo_publicado_em: '2026-10-01 10:00:00', ...campos
});
const erro = code => error => error instanceof JulgamentoContextError && error.code === code;

function executor(dados = {}) {
    const state = { evento: [evento], julgamento: [julgamento()], ciclos: [ciclo()], publicacoes: [], jurados: [jurado()], participantes: [participante()], criterios: criterios(), ...dados };
    const consultas = [];
    return {
        consultas,
        async query(sql, params) {
            const normalized = sql.replace(/\s+/g, ' ').trim();
            consultas.push({ sql: normalized, params });
            assert.match(normalized, /^SELECT /);
            assert.doesNotMatch(normalized, /\b(MAX|INSERT|UPDATE|DELETE|FOR UPDATE|LOCK IN SHARE MODE|START TRANSACTION|COMMIT|ROLLBACK)\b/);
            assert.doesNotMatch(normalized, /ist_eventos_(jurados|criterios_avaliacao)\b|FROM ist_concorrentes\b|ist_usuarios\b|\.status\b/);
            if (normalized.includes('FROM ist_eventos WHERE')) return [state.evento];
            if (normalized.includes('FROM ist_eventos_julgamentos')) return [state.julgamento];
            if (normalized.includes('FROM ist_eventos_ciclos WHERE')) return [state.ciclos.filter(c => c.id_ciclo === params[0])];
            if (normalized.includes('FROM ist_eventos_publicacoes p')) return [state.publicacoes.filter(p => p.id_publicacao === params[0])];
            if (normalized.includes('FROM ist_eventos_publicacoes WHERE')) return [state.publicacoes.filter(p => p.id_evento === params[0] && p.id_ciclo === params[1]).map(p => ({ id_publicacao: p.id_publicacao }))];
            if (normalized.includes('FROM ist_eventos_ciclos_jurados')) return [state.jurados];
            if (normalized.includes('FROM ist_eventos_ciclos_concorrentes')) return [state.participantes];
            if (normalized.includes('FROM ist_eventos_ciclos_criterios')) return [state.criterios];
            assert.fail('SQL nao simulado: ' + normalized);
        }
    };
}

test('resolve exclusivamente o ponteiro, ignora status live e outro ciclo aberto de numero maior', async () => {
    const db = executor({ ciclos: [ciclo(), ciclo({ id_ciclo: 999, numero_ciclo: 99 })] });
    const result = await resolverContextoJulgamento(evento, db);
    assert.equal(result.id_ciclo_atual, 20);
    assert.equal(result.id_julgamento, 17);
    assert.equal(result.estado_ciclo, 'aberto');
    assert.equal(result.permite_escrita, true);
    assert.equal(result.quantidade_classificados, null);
    assert.equal(db.consultas.length, 3);
    assert.deepEqual(db.consultas[1].params, [20]);
    assert(!db.consultas.some(q => q.sql.includes('FROM ist_eventos WHERE')));
});

test('aceita identificador de evento e distingue evento inexistente', async () => {
    const db = executor();
    assert.equal((await resolverContextoJulgamento(17, db)).slug, evento.slug);
    assert.deepEqual(db.consultas[0].params, [17]);
    await assert.rejects(resolverContextoJulgamento(17, executor({ evento: [] })), erro(JULGAMENTO_ERROS.EVENTO_INEXISTENTE));
});

test('julgamento nao configurado e ponteiro ausente sao erros distintos sem fallback', async () => {
    await assert.rejects(resolverContextoJulgamento(evento, executor({ julgamento: [] })), erro(JULGAMENTO_ERROS.JULGAMENTO_NAO_CONFIGURADO));
    const db = executor({ julgamento: [{ ...julgamento(), id_ciclo_atual: null }] });
    await assert.rejects(resolverContextoJulgamento(evento, db), erro(JULGAMENTO_ERROS.CICLO_ATUAL_AUSENTE));
    assert.equal(db.consultas.length, 1);
});

for (const [nome, dados] of [
    ['ciclo ausente apesar de outro aberto', { ciclos: [ciclo({ id_ciclo: 21 })] }],
    ['evento do ciclo incorreto', { ciclos: [ciclo({ id_evento: 18 })] }],
    ['julgamento de outro evento', { julgamento: [{ ...julgamento(), id_evento: 18 }] }],
    ['versao zero', { julgamento: [{ ...julgamento(), versao: 0 }] }],
    ['classificados zero', { julgamento: [{ ...julgamento(), quantidade_classificados: 0 }] }],
    ['estado inventado', { ciclos: [ciclo({ estado: 'publicado' })] }],
    ['aberto com data de publicacao', { ciclos: [ciclo({ publicado_em: '2026-10-01 10:00:00' })] }],
    ['selado sem data', { ciclos: [ciclo({ estado: 'selado' })] }],
    ['selado sem publicacao correspondente', { ciclos: [ciclo({ estado: 'selado', publicado_em: '2026-10-01 10:00:00' })] }],
    ['ciclo 1 com origem', { ciclos: [ciclo({ id_ciclo_origem: 19 })] }],
    ['reabertura sem origem/publicacao/motivo', { ciclos: [ciclo({ numero_ciclo: 2 })] }],
    ['publicacao no ciclo aberto', { publicacoes: [publicacao()] }],
    ['ponteiro vigente sem publicacao', { julgamento: [{ ...julgamento(), id_publicacao_vigente: 70 }] }]
]) test('contexto inconsistente: ' + nome, async () => {
    await assert.rejects(resolverContextoJulgamento(evento, executor(dados)), erro(JULGAMENTO_ERROS.CONTEXTO_INCONSISTENTE));
});

test('ciclo selado valido tem publicacao e nao permite escrita', async () => {
    const db = executor({
        julgamento: [{ ...julgamento(), id_publicacao_vigente: 70 }],
        ciclos: [ciclo({ estado: 'selado', publicado_em: '2026-10-01 10:00:00' })],
        publicacoes: [publicacao()]
    });
    const result = await resolverContextoJulgamento(evento, db);
    assert.equal(result.permite_escrita, false);
    assert.equal(result.id_publicacao_vigente, 70);
    assert.equal(db.consultas.filter(q => q.sql.includes('FROM ist_eventos_publicacoes p')).length, 1);
});

const reabertura = () => ({
    julgamento: [{ ...julgamento(), id_ciclo_atual: 21, id_publicacao_vigente: 70 }],
    ciclos: [ciclo({ estado: 'selado', publicado_em: '2026-10-01 10:00:00' }),
        ciclo({ id_ciclo: 21, numero_ciclo: 2, id_ciclo_origem: 20, id_publicacao_origem: 70, motivo_reabertura: 'Revisao institucional' })],
    publicacoes: [publicacao()]
});
test('ciclo novo aberto pode coexistir com publicacao anterior vigente', async () => {
    const result = await resolverContextoJulgamento(evento, executor(reabertura()));
    assert.equal(result.id_ciclo_atual, 21);
    assert.equal(result.id_publicacao_origem, 70);
    assert.equal(result.id_publicacao_vigente, 70);
    assert.equal(result.permite_escrita, true);
});

for (const [nome, mudar] of [
    ['origem futura', d => { d.ciclos[0].numero_ciclo = 3; d.ciclos[0].id_ciclo_origem = 19; d.ciclos[0].id_publicacao_origem = 69; d.ciclos[0].motivo_reabertura = 'Origem'; }],
    ['origem outro evento', d => { d.ciclos[0].id_evento = 18; }],
    ['publicacao origem outro ciclo', d => { d.publicacoes[0].id_ciclo = 19; }],
    ['publicacao outro evento', d => { d.publicacoes[0].id_evento = 18; }],
    ['origem nao selada', d => { d.ciclos[0] = ciclo(); }],
    ['motivo vazio', d => { d.ciclos[1].motivo_reabertura = ' '; }]
]) test('reabertura invalida: ' + nome, async () => {
    const dados = reabertura(); mudar(dados);
    await assert.rejects(resolverContextoJulgamento(evento, executor(dados)), erro(JULGAMENTO_ERROS.CONTEXTO_INCONSISTENTE));
});

test('jurado incluido e ausencia do roster', async () => {
    const db = executor();
    assert.equal((await resolverJuradoCiclo(contexto, 10, db, { exigirIncluido: true })).estado_participacao, 'incluido');
    assert.deepEqual(db.consultas[0].params, [20, 10]);
    await assert.rejects(resolverJuradoCiclo(contexto, 10, executor({ jurados: [] })), erro(JULGAMENTO_ERROS.JURADO_FORA_ROSTER));
});
for (const estado of ['inelegivel', 'retirado']) test('jurado distingue estado ' + estado, async () => {
    const db = executor({ jurados: [jurado({ estado_participacao: estado })] });
    assert.equal((await resolverJuradoCiclo(contexto, 10, db)).estado_participacao, estado);
    await assert.rejects(resolverJuradoCiclo(contexto, 10, db, { exigirIncluido: true }), e => erro(JULGAMENTO_ERROS.JURADO_NAO_INCLUIDO)(e) && e.details.estado_participacao === estado);
});

test('concorrente incluido utiliza apenas snapshot e distingue ausencia', async () => {
    const db = executor();
    assert.equal((await resolverConcorrenteCiclo(contexto, 40, db, { exigirIncluido: true })).obra_1_publica, 'Obra congelada');
    assert.deepEqual(db.consultas[0].params, [20, 40]);
    await assert.rejects(resolverConcorrenteCiclo(contexto, 40, executor({ participantes: [] })), erro(JULGAMENTO_ERROS.CONCORRENTE_AUSENTE));
});
for (const estado of ['desistente', 'desclassificado', 'inelegivel']) test('concorrente distingue estado ' + estado, async () => {
    const db = executor({ participantes: [participante({ estado_participacao: estado })] });
    assert.equal((await resolverConcorrenteCiclo(contexto, 40, db)).estado_participacao, estado);
    await assert.rejects(resolverConcorrenteCiclo(contexto, 40, db, { exigirIncluido: true }), e => erro(JULGAMENTO_ERROS.CONCORRENTE_NAO_INCLUIDO)(e) && e.details.estado_participacao === estado);
});
for (const campos of [
    { id_evento: 18 }, { id_ciclo: 21 }, { id_concorrente: 41 }, { id_usuario: 0 },
    { numero_concorrente: ' ' }, { nome_publico: '' }, { id_obra_1: null },
    { obra_1_publica: null }, { link_video_1: ' ' }, { fingerprint: 'invalido' }, { estado_participacao: 'pendente' }
]) test('concorrente rejeita estrutura ' + JSON.stringify(campos), async () => {
    await assert.rejects(resolverConcorrenteCiclo(contexto, 40, executor({ participantes: [participante(campos)] })), erro(JULGAMENTO_ERROS.CONTEXTO_INCONSISTENTE));
});
test('jurado rejeita identidade, vinculo e estado invalido', async () => {
    for (const campos of [{ id_evento: 18 }, { id_ciclo: 21 }, { id_usuario: 11 }, { estado_participacao: 'pendente' }]) {
        await assert.rejects(resolverJuradoCiclo(contexto, 10, executor({ jurados: [jurado(campos)] })), erro(JULGAMENTO_ERROS.CONTEXTO_INCONSISTENTE));
    }
});

test('criterios validos sao ordenados sem mutacao e carregados exclusivamente do snapshot', async () => {
    const rows = criterios().reverse();
    const result = validarCriteriosCiclo(rows, contexto);
    assert.deepEqual(result.map(x => x.ordem), [1, 2, 3, 4]);
    assert.equal(rows[0].ordem, 4);
    const db = executor({ criterios: rows });
    assert.deepEqual(await carregarCriteriosCiclo(contexto, db), result);
    assert.deepEqual(db.consultas[0].params, [20]);
});
for (const [nome, mudar] of [
    ['vazios', r => { r.length = 0; }],
    ['soma 99', r => { r[0].peso = '24.00'; }],
    ['ordem duplicada', r => { r[0].ordem = 2; }],
    ['ordem zero', r => { r[0].ordem = 0; }],
    ['ordem fora tinyint', r => { r[0].ordem = 256; }],
    ['snapshot duplicado', r => { r[0].id_criterio_ciclo = r[1].id_criterio_ciclo; }],
    ['origem duplicada', r => { r[0].id_criterio_origem = r[1].id_criterio_origem; }],
    ['snapshot zero', r => { r[0].id_criterio_ciclo = 0; }],
    ['origem zero', r => { r[0].id_criterio_origem = 0; }],
    ['evento incorreto', r => { r[0].id_evento = 18; }],
    ['ciclo incorreto', r => { r[0].id_ciclo = 21; }],
    ['nome vazio', r => { r[0].nome = ' '; }],
    ['peso zero', r => { r[0].peso = '0.00'; }],
    ['peso excessivo', r => { r[0].peso = '101.00'; }],
    ['peso fracao invalida', r => { r[0].peso = '25.001'; }],
    ['peso numerico nao decimal mysql2', r => { r[0].peso = 25; }]
]) test('criterios invalidos: ' + nome, () => {
    const rows = criterios(); mudar(rows);
    assert.throws(() => validarCriteriosCiclo(rows, contexto), erro(JULGAMENTO_ERROS.CRITERIOS_INVALIDOS));
});

const par = { id_evento: 17, id_ciclo: 20, id_jurado: 10, id_concorrente: 40 };
const tentativa = (campos = {}) => ({ ...par, id_avaliacao: 60, numero_tentativa: 1, estado: 'rascunho', versao: 3, id_avaliacao_origem: null, ...campos });
test('nenhuma avaliacao retorna null', () => {
    assert.equal(interpretarTentativasCiclo([], par), null);
});
for (const estado of ['rascunho', 'concluida']) test('tentativa 1 ' + estado + ' retorna 1', () => {
    const a = tentativa({ estado });
    assert.equal(interpretarTentativasCiclo([a], par), a);
});
for (const numero of [2, 3]) {
    for (const estado of ['rascunho', 'concluida']) test('tentativa 1 concluida e ' + numero + ' ' + estado + ' com origem NULL retorna ' + numero, () => {
        const anterior = tentativa({ estado: 'concluida' });
        const atual = tentativa({ id_avaliacao: 61, numero_tentativa: numero, estado });
        assert.equal(interpretarTentativasCiclo([atual, anterior], par), atual);
    });
}
test('tentativa isolada maior que 1 com origem NULL e estruturalmente legivel', () => {
    const a = tentativa({ numero_tentativa: 3 });
    assert.equal(interpretarTentativasCiclo([a], par), a);
});
test('origem local anterior aceita lacuna sem exigir N-1', () => {
    const anterior = tentativa({ estado: 'concluida' });
    const atual = tentativa({ id_avaliacao: 61, numero_tentativa: 3, id_avaliacao_origem: 60 });
    assert.equal(interpretarTentativasCiclo([atual, anterior], par), atual);
});
test('tentativa efetiva segue numero, nao versao; nao altera array', () => {
    const anterior = tentativa({ estado: 'concluida', versao: 100 });
    const atual = tentativa({ id_avaliacao: 61, numero_tentativa: 2, versao: 1, id_avaliacao_origem: 60 });
    const rows = [atual, anterior];
    assert.equal(interpretarTentativasCiclo(rows, par), atual);
    assert.equal(rows[0], atual);
});
for (const [nome, rows] of [
    ['dois rascunhos', [tentativa(), tentativa({ id_avaliacao: 61, numero_tentativa: 2, id_avaliacao_origem: 60 })]],
    ['rascunho antigo e concluida posterior', [tentativa(), tentativa({ id_avaliacao: 61, numero_tentativa: 3, estado: 'concluida' })]],
    ['tentativa repetida', [tentativa({ estado: 'concluida' }), tentativa({ id_avaliacao: 61 })]],
    ['avaliacao repetida', [tentativa({ estado: 'concluida' }), tentativa({ numero_tentativa: 3 })]],
    ['par incorreto', [tentativa({ id_jurado: 11 })]],
    ['concorrente incorreto', [tentativa({ id_concorrente: 41 })]],
    ['ciclo incorreto', [tentativa({ id_ciclo: 21 })]],
    ['evento incorreto', [tentativa({ id_evento: 18 })]],
    ['versao zero', [tentativa({ versao: 0 })]],
    ['autorreferencia', [tentativa({ id_avaliacao_origem: 60 })]],
    ['origem local posterior', [tentativa({ estado: 'concluida', id_avaliacao_origem: 61 }), tentativa({ id_avaliacao: 61, numero_tentativa: 3 })]],
    ['origem zero', [tentativa({ id_avaliacao_origem: 0 })]],
    ['origem formato invalido', [tentativa({ id_avaliacao_origem: '59' })]],
    ['estado invalido', [tentativa({ estado: 'pendente' })]]
]) test('tentativas invalidas: ' + nome, () => {
    assert.throws(() => interpretarTentativasCiclo(rows, par), erro(JULGAMENTO_ERROS.TENTATIVAS_INVALIDAS));
});
for (const numero of [0, -1, 1.5, '3', null, undefined, NaN, Infinity, 4294967296]) test('numero_tentativa invalido: ' + String(numero), () => {
    assert.throws(() => interpretarTentativasCiclo([tentativa({ numero_tentativa: numero })], par), erro(JULGAMENTO_ERROS.TENTATIVAS_INVALIDAS));
});
for (const item of [null, undefined, 1, 'avaliacao', [], {}]) test('item malformado: ' + JSON.stringify(item), () => {
    assert.throws(() => interpretarTentativasCiclo([tentativa({ estado: 'concluida' }), item], par), erro(JULGAMENTO_ERROS.TENTATIVAS_INVALIDAS));
});
test('lista ou par malformado produz erro de dominio', () => {
    for (const rows of [null, undefined, {}]) {
        assert.throws(() => interpretarTentativasCiclo(rows, par), erro(JULGAMENTO_ERROS.TENTATIVAS_INVALIDAS));
    }
    for (const entrada of [null, undefined, 1, []]) {
        assert.throws(() => interpretarTentativasCiclo([], entrada), erro(JULGAMENTO_ERROS.TENTATIVAS_INVALIDAS));
    }
});

test('erros do executor nao sao ocultados nem transformados em ausencia', async () => {
    const original = new Error('Falha de infraestrutura');
    const db = { query: async () => { throw original; } };
    await assert.rejects(resolverContextoJulgamento(evento, db), e => e === original);
});

test('nao inventa requisitos de obra opcional, URL ou acesso live', async () => {
    const db = executor({ participantes: [participante({ obra_1_publica: '', link_video_1: 'material-nao-vazio', id_obra_2: 23, obra_2_publica: '', link_video_2: '' })] });
    assert.equal((await resolverConcorrenteCiclo(contexto, 40, db)).id_obra_2, 23);
    assert.equal(db.consultas.length, 1);
});

test('publicacao vigente incoerente bloqueia leitura sem decidir politica de comissao', async () => {
    for (const campos of [{ ciclo_evento: 18 }, { estado_ciclo: 'aberto' }, { versao: 0 }, { ciclo_publicado_em: null }]) {
        const dados = reabertura();
        dados.publicacoes[0] = publicacao(campos);
        await assert.rejects(resolverContextoJulgamento(evento, executor(dados)), erro(JULGAMENTO_ERROS.CONTEXTO_INCONSISTENTE));
    }
});

test('soma decimal exata, sem aritmetica de ponto flutuante', () => {
    const rows = criterios().slice(0, 3);
    rows[0].peso = '33.33'; rows[1].peso = '33.33'; rows[2].peso = '33.34';
    assert.equal(validarCriteriosCiclo(rows, contexto).length, 3);
});

for (const numero of [1, 3]) test('tentativa ' + numero + ' pode declarar origem externa nao resolvida sem autorizar carry-forward', () => {
    const row = tentativa({ id_avaliacao: numero === 1 ? 60 : 61, numero_tentativa: numero, id_avaliacao_origem: 59 });
    const rows = numero === 1 ? [row] : [tentativa({ estado: 'concluida' }), row];
    assert.equal(interpretarTentativasCiclo(rows, par), row);
});

test('nao oculta duplicidade de membros retornados pelo executor', async () => {
    await assert.rejects(resolverJuradoCiclo(contexto, 10, executor({ jurados: [jurado(), jurado()] })), erro(JULGAMENTO_ERROS.CONTEXTO_INCONSISTENTE));
    await assert.rejects(resolverConcorrenteCiclo(contexto, 40, executor({ participantes: [participante(), participante()] })), erro(JULGAMENTO_ERROS.CONTEXTO_INCONSISTENTE));
});
