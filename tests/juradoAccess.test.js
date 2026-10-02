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

for (const path of ['/api/jurado/acessos', '/api/jurado/eventos/festival-teste']) {
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

for (const path of ['/api/jurado/acessos', '/api/jurado/eventos/festival-teste']) {
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