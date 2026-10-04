import assert from 'node:assert/strict';
import { once } from 'node:events';
import { after, before, beforeEach, test } from 'node:test';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import { pool as db } from '../src/config/db.js';
import adminRoutes from '../src/routes/admin.routes.js';
import { consultarAndamentoAdmin } from '../src/services/adminAvaliacoesService.js';
import { SQL_JOINS_CONCORRENTE, SQL_ELEGIBILIDADE_CONCORRENTE } from '../src/services/juradoFilaService.js';

const originalQuery = db.query;
const originalConnection = db.getConnection;
const cookieName = process.env.COOKIE_NAME || 'ist_session';
const secret = process.env.JWT_SECRET || 'dev-only-insecure-secret';
const token = jwt.sign({ id_usuario: 1, id_tipo_usuario: 1 }, secret, { expiresIn: '5m' });
const evento = { id: 17, slug: 'evento-teste', nome: 'Evento Teste', privado: 'nao-retornar' };
const caminho = '/api/admin/eventos/evento-teste/avaliacoes';
let usuarioAdmin;
let usuarios;
let assignments;
let participacoes;
let avaliacoes;
let consultas;
let lifecycle;
let failure;
let afterJury;
let server;
let baseUrl;

const participacao = (campos = {}) => ({ id_concorrente: 20, id_evento: 17, id_usuario: 30, numero_concorrente: 'TEST-020', nome: 'Nome Publico', aceite_regulamento: 1, id_obra_1: 22, link_video_1: 'https://youtu.be/abcdefghijk', id_obra_2: null, usuarioExiste: true, obraExiste: true, cpf: 'privado', email: 'privado', telefone: 'privado', endereco: 'privado', token: 'privado', senha: 'privado', ...campos });
const avaliacao = (campos = {}) => ({ id_evento: 17, id_concorrente: 20, id_jurado: 10, estado: 'concluida', possivel_desclassificacao: 0, motivo_desclassificacao: 'nao-retornar', notas: ['nao-retornar'], ...campos });
const elegivel = (row, idEvento) => row.id_evento === idEvento && row.aceite_regulamento === 1
    && typeof row.numero_concorrente === 'string' && row.numero_concorrente.trim()
    && row.id_obra_1 !== null && typeof row.link_video_1 === 'string' && row.link_video_1.trim()
    && row.usuarioExiste && row.obraExiste;

const conexao = () => {
    let snapshot;
    return {
        async query(sql, params = []) {
            const normalized = sql.replace(/\s+/g, ' ').trim();
            consultas.push({ sql: normalized, params });
            assert.doesNotMatch(normalized, /FOR UPDATE|LOCK IN SHARE MODE|INSERT|UPDATE|DELETE|ist_eventos_avaliacoes_notas|\bnota\b|\bmedia\b|motivo_desclassificacao/);
            if (failure === normalized || (failure === 'query' && normalized.startsWith('SELECT'))
                || (failure === 'page-query' && normalized.startsWith('SELECT c.id_concorrente'))
                || (failure === 'headers-query' && normalized.startsWith('SELECT id_evento, id_concorrente'))) throw new Error('Falha interna simulada');
            if (normalized === 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ') {
                lifecycle.push('ISOLATION');
                return [{}];
            }
            if (normalized === 'START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY') {
                lifecycle.push('SNAPSHOT');
                snapshot = structuredClone({ usuarios, assignments, participacoes, avaliacoes });
                return [{}];
            }
            assert.ok(snapshot);
            if (normalized === 'SELECT id, slug, nome FROM ist_eventos WHERE slug = ?') return [params[0] === evento.slug ? [evento] : []];
            if (normalized.startsWith('SELECT j.id_usuario')) {
                assert.deepEqual(params, [evento.id]);
                assert.match(normalized, /j.ativo = 1 AND u.id_tipo_usuario = 4 AND u.id_situacao = 8 AND u.id_cargo = 11$/);
                const rows = snapshot.assignments.filter(item => item.id_evento === params[0] && item.ativo === 1 && snapshot.usuarios.some(user => user.id_usuario === item.id_usuario && user.id_tipo_usuario === 4 && user.id_situacao === 8 && user.id_cargo === 11)).map(item => ({ id_usuario: item.id_usuario }));
                if (afterJury) afterJury();
                return [rows];
            }
            const base = `${SQL_JOINS_CONCORRENTE} WHERE ${SQL_ELEGIBILIDADE_CONCORRENTE}`.replace(/\s+/g, ' ').trim();
            if (normalized.startsWith('SELECT COUNT(*) AS total')) {
                assert.equal(normalized, `SELECT COUNT(*) AS total ${base}`);
                return [[{ total: snapshot.participacoes.filter(row => elegivel(row, params[0])).length }]];
            }
            if (normalized.startsWith('SELECT c.id_concorrente')) {
                assert.ok(normalized.includes(base));
                const order = normalized.match(/ORDER BY (c.numero_concorrente|u.nome) (ASC|DESC), c.id_concorrente ASC LIMIT \? OFFSET \?$/);
                assert.ok(order);
                const field = order[1] === 'u.nome' ? 'nome' : 'numero_concorrente';
                const direction = order[2] === 'DESC' ? -1 : 1;
                return [snapshot.participacoes.filter(row => elegivel(row, params[0])).sort((first, second) => first[field].localeCompare(second[field]) * direction || first.id_concorrente - second.id_concorrente).slice(params[2], params[2] + params[1])];
            }
            if (normalized.startsWith('SELECT id_evento, id_concorrente')) {
                assert.match(normalized, /^SELECT id_evento, id_concorrente, id_jurado, estado, possivel_desclassificacao FROM ist_eventos_avaliacoes WHERE id_concorrente IN \(\?(, \?)*\)$/);
                return [snapshot.avaliacoes.filter(row => params.includes(row.id_concorrente))];
            }
            throw new Error('SQL nao simulado');
        },
        async commit() { lifecycle.push('COMMIT'); if (failure === 'commit') throw new Error('Falha interna simulada'); },
        async rollback() { lifecycle.push('ROLLBACK'); if (['rollback', 'rollback-destroy'].includes(failure)) throw new Error('Falha interna simulada'); },
        release() { lifecycle.push('RELEASE'); if (['release', 'release-destroy'].includes(failure)) throw new Error('Falha de release simulada'); },
        destroy() { lifecycle.push('DESTROY'); if (['rollback-destroy', 'release-destroy'].includes(failure)) throw new Error('Falha de destroy simulada'); }
    };
};

before(async () => {
    db.query = async (sql, params) => {
        consultas.push({ sql, params });
        assert.equal(sql, 'SELECT id_tipo_usuario FROM ist_usuarios WHERE id_usuario = ?');
        return [[usuarioAdmin].filter(Boolean)];
    };
    db.getConnection = async () => { if (failure === 'connection') throw new Error('Falha interna simulada'); return conexao(); };
    const app = express();
    app.use(cookieParser());
    app.use('/api/admin', adminRoutes);
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => {
    usuarioAdmin = { id_tipo_usuario: 1 };
    usuarios = [{ id_usuario: 10, id_tipo_usuario: 4, id_situacao: 8, id_cargo: 11 }];
    assignments = [{ id_evento: 17, id_usuario: 10, ativo: 1 }];
    participacoes = [participacao()];
    avaliacoes = [];
    consultas = [];
    lifecycle = [];
    failure = null;
    afterJury = null;
});

after(async () => {
    db.query = originalQuery;
    db.getConnection = originalConnection;
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

const requisitar = async (suffix = '', sessao = token, path = caminho) => {
    const response = await fetch(baseUrl + path + suffix, { headers: sessao ? { Cookie: `${cookieName}=${sessao}` } : {} });
    return { status: response.status, body: await response.json() };
};

test('sem sessao retorna 401 sem consultas', async () => {
    assert.equal((await requisitar('', null)).status, 401);
    assert.deepEqual(consultas, []);
});

test('JWT invalido retorna 401 sem consultas', async () => {
    assert.equal((await requisitar('', 'invalido')).status, 401);
    assert.deepEqual(consultas, []);
});

test('usuario administrativo removido retorna 401 sem snapshot', async () => {
    usuarioAdmin = null;
    assert.equal((await requisitar()).status, 401);
    assert.deepEqual(lifecycle, []);
});

for (const tipo of [2, 3, 4]) test(`tipo atual ${tipo} nao recebe autoridade administrativa`, async () => {
    usuarioAdmin.id_tipo_usuario = tipo;
    assert.equal((await requisitar()).status, 403);
    assert.deepEqual(lifecycle, []);
});

test('admin recebe contrato exato e defaults com snapshot read-only', async () => {
    const result = await requisitar();
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { evento: { id: 17, slug: evento.slug, nome: evento.nome }, jurados: { totalAtuais: 1 }, data: [{ idParticipacao: 20, numeroConcorrente: 'TEST-020', nome: 'Nome Publico', andamento: { totalJuradosAtuais: 1, concluidasAtuais: 0, rascunhosAtuais: 0, pendentesAtuais: 1 }, historico: { totalAvaliacoesForaDoJuriAtual: 0, concluidas: 0, rascunhos: 0, possuiSinalizacaoPossivelDesclassificacao: false }, sinalizacoes: { possuiAtual: false, possuiHistorica: false, possuiQualquer: false } }], pagination: { page: 1, limit: 25, total: 1, totalPages: 1 } });
    assert.deepEqual(lifecycle, ['ISOLATION', 'SNAPSHOT', 'COMMIT', 'RELEASE']);
    assert.equal(consultas.filter(item => item.sql.startsWith('SELECT')).length, 6);
});

test('slug inexistente retorna 404 e fecha snapshot', async () => {
    assert.equal((await requisitar('', token, '/api/admin/eventos/ausente/avaliacoes')).status, 404);
    assert.deepEqual(lifecycle, ['ISOLATION', 'SNAPSHOT', 'ROLLBACK', 'RELEASE']);
});

for (const estado of ['concluida', 'rascunho']) test(`conta ${estado} atual sem contar ausencia como zero`, async () => {
    avaliacoes = [avaliacao({ estado })];
    const row = (await requisitar()).body.data[0];
    assert.equal(row.andamento.concluidasAtuais, estado === 'concluida' ? 1 : 0);
    assert.equal(row.andamento.rascunhosAtuais, estado === 'rascunho' ? 1 : 0);
    assert.equal(row.andamento.pendentesAtuais, 0);
});

test('juri atual vazio nao inventa jurado ou pendencia', async () => {
    assignments = [];
    const result = await requisitar();
    assert.equal(result.body.jurados.totalAtuais, 0);
    assert.equal(result.body.data[0].andamento.pendentesAtuais, 0);
});

test('juri variavel separa concluida, rascunho e pendente na mesma participacao', async () => {
    usuarios.push({ id_usuario: 11, id_tipo_usuario: 4, id_situacao: 8, id_cargo: 11 }, { id_usuario: 12, id_tipo_usuario: 4, id_situacao: 8, id_cargo: 11 });
    assignments.push({ id_evento: 17, id_usuario: 11, ativo: 1 }, { id_evento: 17, id_usuario: 12, ativo: 1 });
    avaliacoes = [avaliacao(), avaliacao({ id_jurado: 11, estado: 'rascunho' })];
    const result = await requisitar();
    assert.equal(result.body.jurados.totalAtuais, 3);
    assert.deepEqual(result.body.data[0].andamento, { totalJuradosAtuais: 3, concluidasAtuais: 1, rascunhosAtuais: 1, pendentesAtuais: 1 });
});

test('historico nao sinalizado e mantido mesmo sem assignment atual', async () => {
    assignments = [];
    avaliacoes = [avaliacao()];
    const row = (await requisitar()).body.data[0];
    assert.deepEqual(row.historico, { totalAvaliacoesForaDoJuriAtual: 1, concluidas: 1, rascunhos: 0, possuiSinalizacaoPossivelDesclassificacao: false });
    assert.deepEqual(row.sinalizacoes, { possuiAtual: false, possuiHistorica: false, possuiQualquer: false });
});

for (const campo of ['id_situacao', 'id_cargo']) test(`jurado com ${campo} NULL fica no historico`, async () => {
    usuarios[0][campo] = null;
    avaliacoes = [avaliacao()];
    const row = (await requisitar()).body.data[0];
    assert.equal(row.andamento.totalJuradosAtuais, 0);
    assert.equal(row.historico.concluidas, 1);
});

test('pendente negativo retorna inconsistencia 409 sem clamp', async () => {
    avaliacoes = [avaliacao(), avaliacao({ estado: 'rascunho' })];
    assert.deepEqual(await requisitar(), { status: 409, body: { message: 'Dados de acompanhamento indispon\u00edveis.' } });
    assert.ok(lifecycle.includes('ROLLBACK'));
    assert.equal(lifecycle.includes('COMMIT'), false);
});

for (const caso of ['assignment', 'tipo', 'situacao', 'cargo']) {
    for (const estado of ['concluida', 'rascunho']) test(`historico ${estado} com ${caso} alterado nao contamina atual`, async () => {
        if (caso === 'assignment') assignments[0].ativo = 0;
        else usuarios[0][{ tipo: 'id_tipo_usuario', situacao: 'id_situacao', cargo: 'id_cargo' }[caso]] = 99;
        avaliacoes = [avaliacao({ estado, possivel_desclassificacao: 1 })];
        const row = (await requisitar()).body.data[0];
        assert.deepEqual(row.andamento, { totalJuradosAtuais: 0, concluidasAtuais: 0, rascunhosAtuais: 0, pendentesAtuais: 0 });
        assert.deepEqual(row.historico, { totalAvaliacoesForaDoJuriAtual: 1, concluidas: estado === 'concluida' ? 1 : 0, rascunhos: estado === 'rascunho' ? 1 : 0, possuiSinalizacaoPossivelDesclassificacao: true });
        assert.deepEqual(row.sinalizacoes, { possuiAtual: false, possuiHistorica: true, possuiQualquer: true });
    });
}

test('sinalizacao atual e historica preserva uniao sem expor motivo ou dados privados', async () => {
    usuarios.push({ id_usuario: 11, id_tipo_usuario: 4, id_situacao: 8, id_cargo: 11 });
    assignments.push({ id_evento: 17, id_usuario: 11, ativo: 0 });
    avaliacoes = [avaliacao({ estado: 'rascunho', possivel_desclassificacao: 1 }), avaliacao({ id_jurado: 11, possivel_desclassificacao: 1 })];
    const result = await requisitar();
    assert.deepEqual(result.body.data[0].sinalizacoes, { possuiAtual: true, possuiHistorica: true, possuiQualquer: true });
    assert.doesNotMatch(JSON.stringify(result.body), /privado|nao-retornar|cpf|email|telefone|endereco|token|senha|hash|notas|motivo|video|obra|media/i);
});

for (const estado of ['concluida', 'rascunho']) test(`sinalizacao ${estado} atual nao inventa sinal historico`, async () => {
    avaliacoes = [avaliacao({ estado, possivel_desclassificacao: 1 })];
    const row = (await requisitar()).body.data[0];
    assert.deepEqual(row.sinalizacoes, { possuiAtual: true, possuiHistorica: false, possuiQualquer: true });
    assert.equal(row.historico.possuiSinalizacaoPossivelDesclassificacao, false);
});

for (const campos of [{ estado: 'pendente' }, { possivel_desclassificacao: 2 }]) test(`header invalido ${JSON.stringify(campos)} causa inconsistencia controlada`, async () => {
    avaliacoes = [avaliacao(campos)];
    assert.equal((await requisitar()).status, 409);
    assert.ok(lifecycle.includes('ROLLBACK'));
    assert.equal(lifecycle.includes('COMMIT'), false);
});

test('estado desconhecido historico nao e convertido em pendente nem contado', async () => {
    assignments[0].ativo = 0;
    avaliacoes = [avaliacao({ estado: 'arquivada' })];
    assert.equal((await requisitar()).status, 409);
    assert.deepEqual(lifecycle, ['ISOLATION', 'SNAPSHOT', 'ROLLBACK', 'RELEASE']);
});

test('snapshot nao mistura revogacao ou conclusao ocorridas entre consultas', async () => {
    avaliacoes = [avaliacao({ estado: 'rascunho' })];
    afterJury = () => { usuarios[0].id_cargo = 99; avaliacoes[0].estado = 'concluida'; participacoes.push(participacao({ id_concorrente: 21 })); };
    const result = await requisitar();
    assert.equal(result.body.pagination.total, 1);
    assert.deepEqual(result.body.data[0].andamento, { totalJuradosAtuais: 1, concluidasAtuais: 0, rascunhosAtuais: 1, pendentesAtuais: 0 });
});

for (const etapa of ['connection', 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ', 'START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY', 'query', 'page-query', 'headers-query', 'commit']) test(`falha ${etapa} nao vaza dados nem conexao`, async () => {
    failure = etapa;
    const log = console.error;
    console.error = () => {};
    try {
        const result = await requisitar();
        assert.equal(result.status, 500);
        assert.doesNotMatch(JSON.stringify(result.body), /interna|SQL|stack/);
        if (etapa === 'connection') assert.deepEqual(lifecycle, []);
        else assert.equal(lifecycle.at(-1), 'RELEASE');
        if (['START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY', 'query', 'page-query', 'headers-query', 'commit'].includes(etapa)) assert.ok(lifecycle.includes('ROLLBACK'));
        assert.equal(lifecycle.filter(item => item === 'RELEASE').length, etapa === 'connection' ? 0 : 1);
        assert.equal(lifecycle.filter(item => item === 'ROLLBACK').length, ['connection', 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ'].includes(etapa) ? 0 : 1);
    } finally { console.error = log; }
});

test('rollback falho destroi conexao sem release', async () => {
    failure = 'rollback';
    const log = console.error;
    console.error = () => {};
    try {
        assert.equal((await requisitar('', token, '/api/admin/eventos/ausente/avaliacoes')).status, 404);
        assert.ok(lifecycle.includes('DESTROY'));
        assert.equal(lifecycle.includes('RELEASE'), false);
    } finally { console.error = log; }
});

for (const inexistente of [false, true]) test(`release falho descarta conexao e ${inexistente ? 'preserva erro original 404' : 'retorna erro neutro apos commit'}`, async () => {
    failure = 'release';
    const log = console.error;
    console.error = () => {};
    try {
        const result = await requisitar('', token, inexistente ? '/api/admin/eventos/ausente/avaliacoes' : caminho);
        assert.equal(result.status, inexistente ? 404 : 500);
        assert.equal(lifecycle.filter(item => item === 'RELEASE').length, 1);
        assert.equal(lifecycle.filter(item => item === 'DESTROY').length, 1);
        assert.ok(lifecycle.includes(inexistente ? 'ROLLBACK' : 'COMMIT'));
        assert.doesNotMatch(JSON.stringify(result.body), /simulada|SQL|stack|release/);
    } finally { console.error = log; }
});

for (const etapa of ['rollback-destroy', 'release-destroy']) test(`cleanup ${etapa} falho preserva 404 sem double release`, async () => {
    failure = etapa;
    const log = console.error;
    console.error = () => {};
    try {
        const result = await requisitar('', token, '/api/admin/eventos/ausente/avaliacoes');
        assert.equal(result.status, 404);
        assert.equal(lifecycle.filter(item => item === 'ROLLBACK').length, 1);
        assert.equal(lifecycle.filter(item => item === 'DESTROY').length, 1);
        assert.equal(lifecycle.filter(item => item === 'RELEASE').length, etapa === 'release-destroy' ? 1 : 0);
        assert.equal(lifecycle.includes('COMMIT'), false);
    } finally { console.error = log; }
});

test('erro original de SELECT nao e substituido por rollback e destroy falhos', async () => {
    const original = new Error('Falha original de leitura');
    const calls = [];
    const log = console.error;
    console.error = () => {};
    try {
        await assert.rejects(consultarAndamentoAdmin(evento.slug, { page: 1, limit: 25, sortField: 'nome', sortOrder: 'asc' }, {
            getConnection: async () => ({
                query: async (sql) => { calls.push(sql); if (sql.startsWith('SELECT')) throw original; return [{}]; },
                rollback: async () => { calls.push('ROLLBACK'); throw new Error('Falha de rollback'); },
                destroy: () => { calls.push('DESTROY'); throw new Error('Falha de destroy'); },
                release: () => { calls.push('RELEASE'); }
            })
        }), error => error === original);
        assert.equal(calls.includes('RELEASE'), false);
        assert.equal(calls.filter(item => item === 'DESTROY').length, 1);
    } finally { console.error = log; }
});

test('limite administrativo acima de 100 e limitado a 100', async () => {
    assert.equal((await requisitar('?limit=101')).body.pagination.limit, 100);
});

test('paginacao alem do total evita query de headers', async () => {
    const result = await requisitar('?page=2&limit=1');
    assert.deepEqual(result.body.data, []);
    assert.equal(result.body.pagination.total, 1);
    assert.equal(consultas.filter(item => item.sql.startsWith('SELECT')).length, 5);
});

test('evento sem participacoes preserva juri e retorna totalPages zero sem headers', async () => {
    participacoes = [];
    const result = await requisitar();
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.jurados, { totalAtuais: 1 });
    assert.deepEqual(result.body.data, []);
    assert.deepEqual(result.body.pagination, { page: 1, limit: 25, total: 0, totalPages: 0 });
    assert.equal(consultas.some(item => item.sql.startsWith('SELECT id_evento, id_concorrente')), false);
    assert.deepEqual(lifecycle, ['ISOLATION', 'SNAPSHOT', 'COMMIT', 'RELEASE']);
});

test('pagina usa total global e agrega headers somente para IDs da pagina', async () => {
    participacoes = [20, 21, 22].map(id_concorrente => participacao({ id_concorrente, numero_concorrente: `TEST-${id_concorrente}` }));
    avaliacoes = [avaliacao({ id_concorrente: 21, estado: 'rascunho' }), avaliacao({ id_concorrente: 22 })];
    const result = await requisitar('?page=2&limit=1');
    assert.deepEqual(result.body.pagination, { page: 2, limit: 1, total: 3, totalPages: 3 });
    assert.deepEqual(result.body.data.map(row => row.idParticipacao), [21]);
    assert.equal(result.body.data[0].andamento.rascunhosAtuais, 1);
    assert.deepEqual(consultas.find(item => item.sql.startsWith('SELECT id_evento, id_concorrente')).params, [21]);
});

test('cem participacoes mantem cinco SELECTs do service e um lote de headers', async () => {
    participacoes = Array.from({ length: 100 }, (_, indice) => participacao({ id_concorrente: 20 + indice }));
    const result = await requisitar('?limit=100');
    assert.equal(result.body.data.length, 100);
    assert.equal(consultas.filter(item => item.sql.startsWith('SELECT')).length, 6);
    assert.equal(consultas.filter(item => item.sql.startsWith('SELECT j.id_usuario')).length, 1);
    assert.equal(consultas.filter(item => item.sql.startsWith('SELECT id_evento, id_concorrente')).length, 1);
    assert.equal(consultas.find(item => item.sql.startsWith('SELECT id_evento, id_concorrente')).params.length, 100);
});

test('query forjada de evento/jurado nao muda escopo resolvido pelo slug', async () => {
    participacoes.push(participacao({ id_concorrente: 21, id_evento: 18 }));
    assignments.push({ id_evento: 18, id_usuario: 10, ativo: 1 });
    avaliacoes = [avaliacao({ id_evento: 18, id_concorrente: 21 })];
    const result = await requisitar('?id_evento=18&id_jurado=99');
    assert.equal(result.body.evento.id, 17);
    assert.equal(result.body.data.length, 1);
    assert.equal(result.body.data[0].andamento.pendentesAtuais, 1);
});

test('avaliacao de outro evento para participacao paginada retorna 409, nao pendente', async () => {
    avaliacoes = [avaliacao({ id_evento: 18 })];
    const result = await requisitar();
    assert.deepEqual(result, { status: 409, body: { message: 'Dados de acompanhamento indispon\u00edveis.' } });
    assert.ok(lifecycle.includes('ROLLBACK'));
    assert.equal(lifecycle.includes('COMMIT'), false);
});

for (const query of ['page=0', 'page=-1', 'page=1.5', 'page=abc', 'page=', 'page=1&page=2', 'limit=0', 'limit=-1', 'limit=1.5', 'limit=abc', 'limit=1&limit=2', 'page=9007199254740991&limit=100', 'page=1abc', 'limit=25x', 'page=NaN', 'limit=NaN', 'page=Infinity', 'limit=Infinity', 'limit=', 'page=9007199254740992']) test(`paginacao ${query} invalida sem snapshot`, async () => {
    assert.equal((await requisitar('?'+query)).status, 400);
    assert.deepEqual(lifecycle, []);
});

for (const query of ['sortField=cpf', 'sortField=__proto__', 'sortField=nome%3BDROP', 'sortField=nome&sortField=numeroConcorrente', 'sortOrder=invalid', 'sortOrder=asc&sortOrder=desc']) test(`ordenacao ${query} arbitraria nao chega ao SQL`, async () => {
    assert.equal((await requisitar('?'+query)).status, 400);
    assert.deepEqual(lifecycle, []);
});

for (const sortField of ['numeroConcorrente', 'nome']) for (const sortOrder of ['asc', 'desc']) test(`whitelist ${sortField} ${sortOrder} e desempate PK ASC`, async () => {
    participacoes = [22, 20, 21].map(id_concorrente => participacao({ id_concorrente }));
    const result = await requisitar(`?sortField=${sortField}&sortOrder=${sortOrder}`);
    assert.deepEqual(result.body.data.map(row => row.idParticipacao), [20, 21, 22]);
    assert.equal(consultas.filter(item => item.sql.includes('FROM ist_eventos_avaliacoes WHERE')).length, 1);
});

for (const sortField of ['numeroConcorrente', 'nome']) for (const sortOrder of ['asc', 'desc']) test(`ordem efetiva ${sortField} ${sortOrder}`, async () => {
    participacoes = [participacao({ id_concorrente: 20, numero_concorrente: 'A', nome: 'Z' }), participacao({ id_concorrente: 21, numero_concorrente: 'B', nome: 'A' })];
    const result = await requisitar(`?sortField=${sortField}&sortOrder=${sortOrder}`);
    const asc = sortField === 'nome' ? [21, 20] : [20, 21];
    assert.deepEqual(result.body.data.map(row => row.idParticipacao), sortOrder === 'asc' ? asc : [...asc].reverse());
});

for (const [campo, valor] of [['aceite_regulamento', 0], ['numero_concorrente', null], ['numero_concorrente', '   '], ['id_obra_1', null], ['link_video_1', null], ['link_video_1', '   '], ['usuarioExiste', false], ['obraExiste', false], ['id_evento', 18]]) test(`elegibilidade compartilhada exclui ${campo}`, async () => {
    participacoes[0][campo] = valor;
    const result = await requisitar();
    assert.deepEqual(result.body.data, []);
    assert.equal(result.body.pagination.total, 0);
});

test('elegibilidade nao exige tipo/situacao do inscrito nem segunda obra/video', async () => {
    participacoes[0].id_tipo_usuario = 99;
    participacoes[0].id_situacao = null;
    participacoes[0].id_obra_2 = 40;
    participacoes[0].link_video_2 = null;
    const result = await requisitar();
    assert.equal(result.body.pagination.total, 1);
    assert.equal(result.body.data.length, 1);
});

test('service rejeita ordenacao nao whitelistada antes de obter conexao', async () => {
    let connections = 0;
    await assert.rejects(consultarAndamentoAdmin(evento.slug, { page: 1, limit: 25, sortField: 'arbitrario', sortOrder: 'asc' }, { getConnection() { connections++; } }), { status: 400 });
    assert.equal(connections, 0);
});