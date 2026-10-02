import assert from 'node:assert/strict';
import { once } from 'node:events';
import { after, before, beforeEach, test } from 'node:test';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import { pool as db } from '../src/config/db.js';
import juradoRoutes from '../src/routes/jurado.routes.js';
import adminRoutes from '../src/routes/admin.routes.js';

const queryOriginal = db.query;
const cookieName = process.env.COOKIE_NAME || 'ist_session';
const jwtSecret = process.env.JWT_SECRET || 'dev-only-insecure-secret';
const token = jwt.sign({ id_usuario: 10, id_tipo_usuario: 4 }, jwtSecret, { expiresIn: '5m' });
const eventos = [
    { id: 1, slug: 'festival-teste', nome: 'Festival Teste', status: 'Inscricoes_Abertas' },
    { id: 2, slug: 'outro-evento', nome: 'Outro Evento', status: 'Concluido' }
];

let usuario;
let designacoes;
let consultas;
let falharBanco;
let participacoes;
let usuariosFila;
let composicoes;
let falharFila;
let server;
let baseUrl;

before(async () => {
    db.query = async (sql, params = []) => {
        const consulta = sql.replace(/\s+/g, ' ').trim();
        consultas.push({ sql: consulta, params });
        if (falharBanco) throw new Error('Falha simulada de SQL');

        if (consulta === 'SELECT id, slug, nome FROM ist_eventos WHERE slug = ?') {
            return [eventos.filter((evento) => evento.slug === params[0])];
        }
        if (consulta.startsWith('SELECT e.id, e.slug, e.nome')) {
            assert.match(consulta, /INNER JOIN ist_eventos_jurados j ON j\.id_usuario = u\.id_usuario/);
            assert.match(consulta, /INNER JOIN ist_eventos e ON e\.id = j\.id_evento/);
            for (const campo of ['u.id_usuario', 'u.id_tipo_usuario', 'u.id_situacao', 'u.id_cargo', 'j.ativo']) {
                assert.ok(consulta.includes(`${campo} = ?`));
            }
            assert.deepEqual(params.slice(0, 5), [10, 4, 8, 11, 1]);
            assert.equal(consulta.includes('AND e.id = ?'), params.length === 6);
            assert.doesNotMatch(consulta, /status|data_inicio|data_fim/);

            if (!usuario || usuario.id_usuario !== params[0]
                || usuario.id_tipo_usuario !== params[1]
                || usuario.id_situacao !== params[2]
                || usuario.id_cargo !== params[3]) return [[]];

            return [eventos.filter((evento) => (params.length !== 6 || evento.id === params[5])
                && designacoes.some((designacao) => designacao.id_evento === evento.id
                    && designacao.id_usuario === params[0] && designacao.ativo === params[4]))];
        }
        if (consulta === 'SELECT id_tipo_usuario FROM ist_usuarios WHERE id_usuario = ?') {
            return [usuario ? [{ id_tipo_usuario: usuario.id_tipo_usuario }] : []];
        }
        const countFila = consulta.startsWith('SELECT COUNT(*) AS total FROM ist_concorrentes c');
        const selectFila = consulta.startsWith('SELECT c.id_concorrente, c.numero_concorrente');
        if (countFila || selectFila) {
            assert.match(consulta, /INNER JOIN ist_usuarios u ON u\.id_usuario = c\.id_usuario/);
            assert.match(consulta, /INNER JOIN ist_composicao obra1 ON obra1\.id_obra = c\.id_obra_1/);
            assert.match(consulta, /LEFT JOIN ist_composicao obra2 ON obra2\.id_obra = c\.id_obra_2/);
            for (const criterio of [
                'c.id_evento = ?', 'c.aceite_regulamento = 1',
                'c.numero_concorrente IS NOT NULL', "TRIM(c.numero_concorrente) <> ''",
                'c.id_obra_1 IS NOT NULL', 'c.link_video_1 IS NOT NULL', "TRIM(c.link_video_1) <> ''"
            ]) assert.ok(consulta.includes(criterio));
            assert.doesNotMatch(consulta, /SELECT \*|cpf|identidade|email|telefone|logradouro|senha|token|id_tipo_usuario|id_situacao|confirmacao_inscricao_enviada/);
            assert.equal(params.length, countFila ? 1 : 3);
            if (falharFila === (countFila ? 'count' : 'select')) throw new Error('Falha simulada de SQL na fila');

            const elegiveis = participacoes.filter((participacao) => participacao.id_evento === params[0]
                && participacao.aceite_regulamento === 1
                && typeof participacao.numero_concorrente === 'string' && participacao.numero_concorrente.trim()
                && participacao.id_obra_1 !== null
                && typeof participacao.link_video_1 === 'string' && participacao.link_video_1.trim()
                && usuariosFila.some((inscrito) => inscrito.id_usuario === participacao.id_usuario)
                && composicoes.some((obra) => obra.id_obra === participacao.id_obra_1));
            if (countFila) return [[{ total: elegiveis.length }]];

            assert.match(consulta, /COALESCE\(obra1\.titulo, obra1\.obra\) AS titulo_obra_1/);
            assert.match(consulta, /COALESCE\(obra2\.titulo, obra2\.obra\) AS titulo_obra_2/);
            const count = consultas.find(({ sql: sqlCount }) => sqlCount.startsWith('SELECT COUNT(*) AS total FROM ist_concorrentes c'));
            assert.equal(count.sql.slice(count.sql.indexOf('FROM ist_concorrentes')),
                consulta.slice(consulta.indexOf('FROM ist_concorrentes')).split(' ORDER BY ')[0]);
            const ordenacao = consulta.match(/ORDER BY (c\.numero_concorrente|c\.data_cadastro|u\.nome) (ASC|DESC), c\.id_concorrente ASC LIMIT \? OFFSET \?$/);
            assert.ok(ordenacao);
            const campo = ordenacao[1].split('.')[1];
            const direcao = ordenacao[2] === 'ASC' ? 1 : -1;
            const rows = elegiveis.map((participacao) => {
                const inscrito = usuariosFila.find((item) => item.id_usuario === participacao.id_usuario);
                const principal = composicoes.find((obra) => obra.id_obra === participacao.id_obra_1);
                const opcional = composicoes.find((obra) => obra.id_obra === participacao.id_obra_2);
                return {
                    ...inscrito, ...participacao,
                    titulo_obra_1: principal.titulo ?? principal.obra,
                    titulo_obra_2: opcional ? opcional.titulo ?? opcional.obra : null
                };
            }).sort((primeira, segunda) => String(primeira[campo]).localeCompare(String(segunda[campo])) * direcao
                || primeira.id_concorrente - segunda.id_concorrente);
            return [rows.slice(params[2], params[2] + params[1])];
        }
        throw new Error(`Consulta não simulada: ${consulta}`);
    };

    const app = express();
    app.use(cookieParser());
    app.use('/api/jurado', juradoRoutes);
    app.use('/api/admin', adminRoutes);
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => {
    usuario = { id_usuario: 10, id_tipo_usuario: 4, id_situacao: 8, id_cargo: 11 };
    designacoes = [{ id_evento: 1, id_usuario: 10, ativo: 1 }];
    consultas = [];
    falharBanco = false;
    participacoes = [criarParticipacao()];
    usuariosFila = [{
        id_usuario: 20, id_tipo_usuario: 3, id_situacao: 99,
        nome: 'Concorrente Teste', cidade: null, uf: null,
        cpf: 'dado-privado', identidade: 'dado-privado', email: 'privado@example.com',
        telefone_celular: 'dado-privado', logradouro: 'dado-privado', senha: 'dado-privado', token_confirmacao: 'dado-privado'
    }];
    composicoes = [
        { id_obra: 22, titulo: null, obra: 'Obra Principal' },
        { id_obra: 40, titulo: 'Obra Opcional', obra: 'Nome Original' }
    ];
    falharFila = null;
});

after(async () => {
    db.query = queryOriginal;
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

const requisitar = async (path, sessao = token) => {
    const headers = sessao === null ? {} : { Cookie: `${cookieName}=${sessao}` };
    const response = await fetch(`${baseUrl}${path}`, { headers });
    return { status: response.status, body: await response.json() };
};

const criarParticipacao = (campos = {}) => ({
    id_concorrente: 17, id_usuario: 20, id_evento: 1,
    numero_concorrente: 'FVST2-001', id_obra_1: 22,
    link_video_1: 'https://youtu.be/abcdefghijk', id_obra_2: null, link_video_2: null,
    aceite_regulamento: 1, confirmacao_inscricao_enviada: 0,
    data_cadastro: '2026-10-02T12:00:00.000Z', ...campos
});

const caminhoFila = '/api/jurado/eventos/festival-teste/concorrentes';

for (const path of ['/api/jurado/acessos', '/api/jurado/eventos/festival-teste', caminhoFila]) {
    test(`${path}: sem autenticação retorna 401 antes de consultar banco`, async () => {
        const resposta = await requisitar(path, null);
        assert.equal(resposta.status, 401);
        assert.deepEqual(resposta.body, { message: 'Não autenticado.' });
        assert.equal(consultas.length, 0);
    });

    test(`${path}: JWT inválido retorna 401 antes de consultar banco`, async () => {
        assert.equal((await requisitar(path, 'invalido')).status, 401);
        assert.equal(consultas.length, 0);
    });
}

for (const [campo, valor] of [
    ['id_tipo_usuario', 3], ['id_situacao', 9], ['id_cargo', 10]
]) {
    test(`/acessos: ${campo} incompatível retorna lista vazia`, async () => {
        usuario[campo] = valor;
        assert.deepEqual(await requisitar('/api/jurado/acessos'), { status: 200, body: { eventos: [] } });
    });

    test(`/eventos/:slug: ${campo} incompatível retorna 403`, async () => {
        usuario[campo] = valor;
        assert.equal((await requisitar('/api/jurado/eventos/festival-teste')).status, 403);
    });
}

test('/acessos: nenhuma designação retorna lista vazia', async () => {
    designacoes = [];
    assert.deepEqual(await requisitar('/api/jurado/acessos'), { status: 200, body: { eventos: [] } });
});

test('/acessos: designação inativa não é retornada', async () => {
    designacoes[0].ativo = 0;
    assert.deepEqual(await requisitar('/api/jurado/acessos'), { status: 200, body: { eventos: [] } });
});

test('/acessos: uma designação ativa retorna apenas dados públicos', async () => {
    assert.deepEqual(await requisitar('/api/jurado/acessos'), {
        status: 200,
        body: { eventos: [{ id: 1, slug: 'festival-teste', nome: 'Festival Teste' }] }
    });
});

test('/acessos: duas designações ativas independem de Festival específico', async () => {
    designacoes.push({ id_evento: 2, id_usuario: 10, ativo: 1 });
    const resposta = await requisitar('/api/jurado/acessos');
    assert.equal(resposta.status, 200);
    assert.deepEqual(resposta.body.eventos.map((evento) => evento.id), [1, 2]);
});

test('/eventos/:slug: evento inexistente retorna 404', async () => {
    assert.equal((await requisitar('/api/jurado/eventos/inexistente')).status, 404);
    assert.equal(consultas.length, 1);
});

test('/eventos/:slug: sem designação retorna 403', async () => {
    designacoes = [];
    assert.equal((await requisitar('/api/jurado/eventos/festival-teste')).status, 403);
});

test('/eventos/:slug: designação inativa retorna 403', async () => {
    designacoes[0].ativo = 0;
    assert.equal((await requisitar('/api/jurado/eventos/festival-teste')).status, 403);
});

test('/eventos/:slug: designação de outro evento não concede acesso', async () => {
    assert.equal((await requisitar('/api/jurado/eventos/outro-evento?id_evento=1')).status, 403);
    assert.deepEqual(consultas[1].params, [10, 4, 8, 11, 1, 2]);
});

test('/eventos/:slug: designação correta ativa retorna evento público', async () => {
    assert.deepEqual(await requisitar('/api/jurado/eventos/festival-teste?id_evento=999'), {
        status: 200,
        body: { evento: { id: 1, slug: 'festival-teste', nome: 'Festival Teste' } }
    });
    assert.deepEqual(consultas[1].params, [10, 4, 8, 11, 1, 1]);
});

test('usuário removido do banco não tem acesso mesmo com JWT válido', async () => {
    usuario = null;
    assert.equal((await requisitar('/api/jurado/eventos/festival-teste')).status, 403);
    assert.deepEqual((await requisitar('/api/jurado/acessos')).body, { eventos: [] });
});

for (const campo of ['id_tipo_usuario', 'id_situacao', 'id_cargo']) {
    test(`alteração atual de ${campo} revoga acesso mantendo o mesmo JWT`, async () => {
        assert.equal((await requisitar('/api/jurado/eventos/festival-teste')).status, 200);
        usuario[campo] = 99;
        assert.equal((await requisitar('/api/jurado/eventos/festival-teste')).status, 403);
    });
}

test('revogação da designação é imediata com o mesmo JWT', async () => {
    assert.equal((await requisitar('/api/jurado/eventos/festival-teste')).status, 200);
    designacoes[0].ativo = 0;
    assert.equal((await requisitar('/api/jurado/eventos/festival-teste')).status, 403);
});

test('jurado não herda política de status própria da inscrição', async () => {
    designacoes.push({ id_evento: 2, id_usuario: 10, ativo: 1 });
    assert.equal((await requisitar('/api/jurado/eventos/outro-evento')).status, 200);
});

for (const path of ['/api/jurado/acessos', '/api/jurado/eventos/festival-teste', caminhoFila]) {
    test(`${path}: falha de banco retorna 500 neutro`, async () => {
        falharBanco = true;
        const consoleErrorOriginal = console.error;
        console.error = () => {};
        let resposta;
        try {
            resposta = await requisitar(path);
        } finally {
            console.error = consoleErrorOriginal;
        }
        assert.equal(resposta.status, 500);
        assert.doesNotMatch(JSON.stringify(resposta.body), /SQL|stack|Falha simulada/);
    });
}

test('/admin continua negando tipo 4 mesmo com cargo e designação de jurado', async () => {
    assert.equal((await requisitar('/api/admin/me')).status, 403);
});

test('fila: evento inexistente retorna 404 sem consultar participacoes', async () => {
    assert.equal((await requisitar('/api/jurado/eventos/inexistente/concorrentes')).status, 404);
    assert.equal(consultas.length, 1);
});

for (const estado of ['ausente', 'inativa']) {
    test(`fila: designacao ${estado} retorna 403 antes da consulta`, async () => {
        if (estado === 'ausente') designacoes = [];
        else designacoes[0].ativo = 0;
        assert.equal((await requisitar(caminhoFila)).status, 403);
        assert.equal(consultas.length, 2);
    });
}

for (const campo of ['id_tipo_usuario', 'id_situacao', 'id_cargo']) {
    test(`fila: requisito atual de jurado ${campo} permanece obrigatorio`, async () => {
        usuario[campo] = 99;
        assert.equal((await requisitar(caminhoFila)).status, 403);
        assert.equal(consultas.length, 2);
    });
}

test('fila: contrato publico completo, defaults e fallback sem dados pessoais', async () => {
    assert.deepEqual(await requisitar(caminhoFila), {
        status: 200,
        body: {
            evento: { id: 1, slug: 'festival-teste', nome: 'Festival Teste' },
            concorrentes: [{
                idParticipacao: 17, numeroConcorrente: 'FVST2-001', nome: 'Concorrente Teste',
                cidade: null, uf: null, dataInscricao: '2026-10-02T12:00:00.000Z',
                obraPrincipal: { id: 22, titulo: 'Obra Principal' },
                linkVideoPrincipal: 'https://youtu.be/abcdefghijk', obraOpcional: null, linkVideoOpcional: null
            }],
            pagination: { page: 1, limit: 25, total: 1, totalPages: 1 }
        }
    });
    assert.deepEqual(consultas[2].params, [1]);
    assert.deepEqual(consultas[3].params, [1, 25, 0]);
});

test('fila: isolamento por slug mesmo com id_evento forjado na query', async () => {
    participacoes.push(criarParticipacao({ id_concorrente: 28, id_evento: 2 }));
    designacoes.push({ id_evento: 2, id_usuario: 10, ativo: 1 });
    const primeiro = await requisitar(`${caminhoFila}?id_evento=2`);
    assert.deepEqual(primeiro.body.concorrentes.map((item) => item.idParticipacao), [17]);
    assert.equal(primeiro.body.pagination.total, 1);
    consultas = [];
    const segundo = await requisitar('/api/jurado/eventos/outro-evento/concorrentes?id_evento=1');
    assert.equal(segundo.body.evento.id, 2);
    assert.deepEqual(segundo.body.concorrentes.map((item) => item.idParticipacao), [28]);
    assert.deepEqual(consultas[2].params, [2]);
    assert.deepEqual(consultas[3].params, [2, 25, 0]);
});

test('fila: designacao de outro evento nao concede acesso', async () => {
    assert.equal((await requisitar('/api/jurado/eventos/outro-evento/concorrentes?id_evento=1')).status, 403);
    assert.equal(consultas.length, 2);
});

for (const [campo, valor] of [
    ['aceite_regulamento', 0], ['numero_concorrente', null], ['numero_concorrente', ''],
    ['numero_concorrente', '   '], ['id_obra_1', null], ['link_video_1', null],
    ['link_video_1', ''], ['link_video_1', '   ']
]) {
    test(`fila: exclui ${campo}=${JSON.stringify(valor)} com COUNT consistente`, async () => {
        participacoes[0][campo] = valor;
        const resposta = await requisitar(caminhoFila);
        assert.equal(resposta.status, 200);
        assert.deepEqual(resposta.body.concorrentes, []);
        assert.deepEqual(resposta.body.pagination, { page: 1, limit: 25, total: 0, totalPages: 0 });
    });
}

test('fila: nao exige tipo/situacao atual do inscrito nem confirmacao do email', async () => {
    usuariosFila[0].id_tipo_usuario = 1;
    usuariosFila[0].id_situacao = null;
    participacoes[0].confirmacao_inscricao_enviada = 0;
    const resposta = await requisitar(caminhoFila);
    assert.equal(resposta.status, 200);
    assert.equal(resposta.body.concorrentes.length, 1);
});

for (const video of [null, 'https://youtu.be/lmnopqrstuv']) {
    test(`fila: segunda obra com video ${video === null ? 'ausente' : 'presente'} nao altera elegibilidade`, async () => {
        participacoes[0].id_obra_2 = 40;
        participacoes[0].link_video_2 = video;
        composicoes[1].titulo = null;
        usuariosFila[0].cidade = 'Santarem';
        usuariosFila[0].uf = 'PA';
        const resposta = await requisitar(caminhoFila);
        assert.equal(resposta.status, 200);
        assert.equal(resposta.body.pagination.total, 1);
        assert.deepEqual(resposta.body.concorrentes[0].obraOpcional, { id: 40, titulo: 'Nome Original' });
        assert.equal(resposta.body.concorrentes[0].linkVideoOpcional, video);
        assert.equal(resposta.body.concorrentes[0].cidade, 'Santarem');
        assert.equal(resposta.body.concorrentes[0].uf, 'PA');
    });
}

test('fila: titulo normalizado tem prioridade sobre nome original', async () => {
    composicoes[0].titulo = 'Titulo Normalizado';
    const resposta = await requisitar(caminhoFila);
    assert.equal(resposta.body.concorrentes[0].obraPrincipal.titulo, 'Titulo Normalizado');
});

test('fila: composicao principal inexistente nao diverge entre COUNT e SELECT', async () => {
    participacoes[0].id_obra_1 = 999;
    const resposta = await requisitar(caminhoFila);
    assert.deepEqual(resposta.body.concorrentes, []);
    assert.equal(resposta.body.pagination.total, 0);
});

test('fila: paginacao valida e totalPages usam total completo', async () => {
    participacoes = Array.from({ length: 5 }, (_, indice) => criarParticipacao({
        id_concorrente: 17 + indice, numero_concorrente: `FVST2-00${indice + 1}`
    }));
    const resposta = await requisitar(`${caminhoFila}?page=2&limit=2`);
    assert.deepEqual(resposta.body.concorrentes.map((item) => item.idParticipacao), [19, 20]);
    assert.deepEqual(resposta.body.pagination, { page: 2, limit: 2, total: 5, totalPages: 3 });
    assert.deepEqual(consultas[3].params, [1, 2, 2]);
});

test('fila: pagina alem do total retorna lista vazia com total preservado', async () => {
    const resposta = await requisitar(`${caminhoFila}?page=2&limit=1`);
    assert.deepEqual(resposta.body.concorrentes, []);
    assert.deepEqual(resposta.body.pagination, { page: 2, limit: 1, total: 1, totalPages: 1 });
});

test('fila: aceita limite maximo de 100', async () => {
    const resposta = await requisitar(`${caminhoFila}?limit=100`);
    assert.equal(resposta.status, 200);
    assert.equal(resposta.body.pagination.limit, 100);
});

for (const parametro of ['page', 'limit']) {
    for (const valor of ['0', '-1', 'abc', '1.5', '', 'Infinity', '9007199254740992']) {
        test(`fila: ${parametro}=${valor} retorna 400 sem consultar fila`, async () => {
            assert.equal((await requisitar(`${caminhoFila}?${parametro}=${valor}`)).status, 400);
            assert.equal(consultas.length, 2);
        });
    }
}

for (const query of ['limit=101', 'page=9007199254740991&limit=100', 'page=1&page=2', 'limit=1&limit=2']) {
    test(`fila: paginacao invalida ${query} retorna 400`, async () => {
        assert.equal((await requisitar(`${caminhoFila}?${query}`)).status, 400);
        assert.equal(consultas.length, 2);
    });
}

for (const { sort, coluna, idsAsc } of [
    { sort: 'numeroConcorrente', coluna: 'c.numero_concorrente', idsAsc: [17, 18, 19] },
    { sort: 'dataInscricao', coluna: 'c.data_cadastro', idsAsc: [18, 19, 17] },
    { sort: 'nome', coluna: 'u.nome', idsAsc: [19, 18, 17] }
]) {
    for (const order of ['asc', 'desc']) {
        test(`fila: ordena por ${sort} ${order} com desempate fixo`, async () => {
            usuariosFila.push({ id_usuario: 21, nome: 'Z', cidade: null, uf: null }, { id_usuario: 22, nome: 'A', cidade: null, uf: null });
            participacoes = [
                criarParticipacao({ id_concorrente: 19, id_usuario: 22, numero_concorrente: 'FVST2-003', data_cadastro: '2026-10-02' }),
                criarParticipacao({ id_concorrente: 17, id_usuario: 21, numero_concorrente: 'FVST2-001', data_cadastro: '2026-10-03' }),
                criarParticipacao({ id_concorrente: 18, numero_concorrente: 'FVST2-002', data_cadastro: '2026-10-01' })
            ];
            const resposta = await requisitar(`${caminhoFila}?sort=${sort}&order=${order}`);
            assert.equal(resposta.status, 200);
            assert.deepEqual(resposta.body.concorrentes.map((item) => item.idParticipacao), order === 'asc' ? idsAsc : [...idsAsc].reverse());
            const consultaFila = consultas.find(({ sql }) => sql.startsWith('SELECT c.id_concorrente'));
            assert.ok(consultaFila.sql.includes(`ORDER BY ${coluna} ${order.toUpperCase()}, c.id_concorrente ASC`));
        });

        test(`fila: empate de ${sort} usa idParticipacao ASC com order ${order}`, async () => {
            participacoes = [19, 17, 18].map((id) => criarParticipacao({ id_concorrente: id }));
            const resposta = await requisitar(`${caminhoFila}?sort=${sort}&order=${order}`);
            assert.equal(resposta.status, 200);
            assert.deepEqual(resposta.body.concorrentes.map((item) => item.idParticipacao), [17, 18, 19]);
            const consultaFila = consultas.find(({ sql }) => sql.startsWith('SELECT c.id_concorrente'));
            assert.ok(consultaFila.sql.includes(`ORDER BY ${coluna} ${order.toUpperCase()}, c.id_concorrente ASC`));
        });
    }
}

for (const query of ['sort=cpf', 'sort=__proto__', 'sort=nome%3BDROP%20TABLE%20ist_usuarios', 'sort=nome&sort=dataInscricao', 'order=invalid', 'order=desc%3BDROP', 'order=asc&order=desc']) {
    test(`fila: rejeita ordenacao arbitraria ${query}`, async () => {
        assert.equal((await requisitar(`${caminhoFila}?${query}`)).status, 400);
        assert.equal(consultas.length, 2);
    });
}

test('fila: nao implementa busca ou filtro por atributos do inscrito', async () => {
    const resposta = await requisitar(`${caminhoFila}?search=nao-corresponde&idTipoUsuario=2&idSituacao=8`);
    assert.equal(resposta.status, 200);
    assert.equal(resposta.body.pagination.total, 1);
    assert.deepEqual(consultas[2].params, [1]);
});

for (const etapa of ['count', 'select']) {
    test(`fila: falha de ${etapa} retorna 500 neutro`, async () => {
        falharFila = etapa;
        const consoleErrorOriginal = console.error;
        console.error = () => {};
        try {
            const resposta = await requisitar(caminhoFila);
            assert.equal(resposta.status, 500);
            assert.deepEqual(resposta.body, { message: 'Não foi possível consultar a fila de concorrentes.' });
            assert.doesNotMatch(JSON.stringify(resposta.body), /SQL|stack|Falha simulada/);
        } finally {
            console.error = consoleErrorOriginal;
        }
    });
}