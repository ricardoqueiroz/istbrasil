import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { pool as db } from '../src/config/db.js';
import { OBRA_PRINCIPAL_CONCORRENTE } from '../src/config/festival.js';
import obraController from '../src/controllers/obraController.js';
import usuariosController from '../src/controllers/usuariosController.js';

const VIDEO_1 = 'https://www.youtube.com/watch?v=abcdefghijk';
const VIDEO_2 = 'https://youtu.be/lmnopqrstuv';

const criarResposta = () => {
    const resposta = {
        statusCode: 200,
        body: null,
        status(codigo) {
            this.statusCode = codigo;
            return this;
        },
        json(conteudo) {
            this.body = conteudo;
            return this;
        },
        clearCookie() {}
    };
    return resposta;
};

const normalizarSql = (sql) => sql.replace(/\s+/g, ' ').trim();

const executarAtualizacao = async ({ aceitePersistido, idObra1, idObra2, obraSecundaria }) => {
    const consultas = [];
    const connection = {
        async beginTransaction() {},
        async commit() {},
        async rollback() {},
        release() {},
        async query(sql, params = []) {
            const consulta = normalizarSql(sql);
            consultas.push({ sql: consulta, params });

            if (consulta.startsWith('SELECT id_tipo_usuario FROM ist_usuarios')) {
                return [[{ id_tipo_usuario: 2 }]];
            }
            if (consulta.includes('SELECT id_concorrente, id_obra_1, aceite_regulamento')) {
                return [[{
                    id_concorrente: aceitePersistido ? 'FVST2-001' : null,
                    id_obra_1: idObra1,
                    aceite_regulamento: aceitePersistido ? 1 : 0,
                    confirmacao_inscricao_enviada: 1
                }]];
            }
            if (consulta.includes('FROM ist_composicao WHERE id_obra = ?')) {
                if (params[0] === OBRA_PRINCIPAL_CONCORRENTE.idObra) {
                    return [[{ id_obra: params[0], titulo: 'Título vindo do banco', partitura: null, propria: 1 }]];
                }
                if (aceitePersistido && params[0] === idObra1) {
                    return [[{ id_obra: params[0], titulo: 'Título histórico vindo do banco', partitura: null, propria: 1 }]];
                }
            }
            if (consulta.includes('AND propria = 1') && consulta.includes('AND id_obra <> ?')) {
                return [obraSecundaria ? [obraSecundaria] : []];
            }
            if (consulta.startsWith('UPDATE ist_concorrentes')) {
                return [{ affectedRows: 1 }];
            }
            throw new Error(`Consulta não simulada: ${consulta}`);
        }
    };

    const getConnectionOriginal = db.getConnection;
    db.getConnection = async () => connection;
    const resposta = criarResposta();
    try {
        await usuariosController.atualizarParticipacaoConcorrente(
            {
                usuario: { id_usuario: 7 },
                body: {
                    linkVideo1: VIDEO_1,
                    idObra2,
                    linkVideo2: idObra2 == null ? null : VIDEO_2
                }
            },
            resposta
        );
    } finally {
        db.getConnection = getConnectionOriginal;
    }

    return { resposta, consultas };
};

test('configuração canônica contém somente o ID 22', () => {
    assert.deepEqual(OBRA_PRINCIPAL_CONCORRENTE, { idObra: 22 });
    assert.equal(Object.isFrozen(OBRA_PRINCIPAL_CONCORRENTE), true);
});

test('API obtém metadados da obra principal no banco e mantém elegíveis sem exigir partitura', async () => {
    const executeOriginal = db.execute;
    const consultas = [];
    db.execute = async (sql, params) => {
        const consulta = normalizarSql(sql);
        consultas.push({ sql: consulta, params });
        if (consulta.startsWith('SELECT id_obra, titulo, partitura, propria')) {
            return [[{ id_obra: 22, titulo: 'Título dinâmico', partitura: null, propria: 1 }]];
        }
        return [[{ id_obra: 40, titulo: 'Obra sem partitura', partitura: null }]];
    };

    const resposta = criarResposta();
    try {
        await obraController.getParticipacaoConcorrente({}, resposta);
    } finally {
        db.execute = executeOriginal;
    }

    assert.equal(resposta.statusCode, 200);
    assert.deepEqual(resposta.body.obraPrincipal, { idObra: 22, titulo: 'Título dinâmico', partitura: null });
    assert.deepEqual(resposta.body.obrasElegiveis, [{ idObra: 40, titulo: 'Obra sem partitura', partitura: null }]);
    assert.equal(consultas.some(({ sql }) => sql.includes('partitura IS NOT NULL')), false);
    const consultaElegiveis = consultas.find(({ sql }) => sql.includes('MIN(id_obra) AS id_obra'));
    assert.match(consultaElegiveis.sql, /INNER JOIN \( SELECT titulo, MIN\(id_obra\) AS id_obra/);
    assert.match(consultaElegiveis.sql, /ON escolhida\.id_obra = c\.id_obra/);
    assert.match(consultaElegiveis.sql, /SELECT c\.id_obra, c\.titulo, c\.partitura/);
    assert.deepEqual(consultas[0].params, [22]);
});

test('obra 2 própria com partitura nula é aceita e inscrição aberta grava obra principal 22', async () => {
    const { resposta, consultas } = await executarAtualizacao({
        aceitePersistido: false,
        idObra1: null,
        idObra2: 40,
        obraSecundaria: { id_obra: 40, titulo: 'Obra própria sem partitura' }
    });

    assert.equal(resposta.statusCode, 200);
    assert.equal(resposta.body.concorrente.idObra1, 22);
    const validacaoObra2 = consultas.find(({ sql }) => sql.includes('AND propria = 1'));
    assert.ok(validacaoObra2);
    assert.equal(validacaoObra2.sql.includes('partitura IS NOT NULL'), false);
    assert.deepEqual(validacaoObra2.params, [40, 22]);
    const atualizacao = consultas.find(({ sql }) => sql.startsWith('UPDATE ist_concorrentes'));
    assert.match(atualizacao.sql, /SET id_obra_1 = \?/);
    assert.equal(atualizacao.params[0], 22);
});

test('obra 2 não própria é rejeitada', async () => {
    const { resposta } = await executarAtualizacao({
        aceitePersistido: false,
        idObra1: null,
        idObra2: 40,
        obraSecundaria: null
    });

    assert.equal(resposta.statusCode, 400);
    assert.equal(resposta.body.message, 'A segunda obra informada não é elegível.');
});

test('obra principal não pode ser selecionada como obra 2', async () => {
    const { resposta } = await executarAtualizacao({
        aceitePersistido: false,
        idObra1: null,
        idObra2: 22,
        obraSecundaria: { id_obra: 22, titulo: 'Inválida' }
    });

    assert.equal(resposta.statusCode, 400);
    assert.equal(resposta.body.message, 'A segunda obra deve ser diferente da obra principal.');
});

test('inscrição aceita preserva a obra principal histórica', async () => {
    const { resposta, consultas } = await executarAtualizacao({
        aceitePersistido: true,
        idObra1: 99,
        idObra2: null,
        obraSecundaria: null
    });

    assert.equal(resposta.statusCode, 200);
    assert.equal(resposta.body.concorrente.idObra1, 99);
    assert.equal(resposta.body.concorrente.tituloObra1, 'Título histórico vindo do banco');
    const atualizacao = consultas.find(({ sql }) => sql.startsWith('UPDATE ist_concorrentes'));
    assert.doesNotMatch(atualizacao.sql, /id_obra_1/);
});

test('frontend não fixa obra antiga e fluxos de e-mail e FVST2 permanecem baseados na inscrição', async () => {
    const arquivosFrontend = await Promise.all([
        readFile(new URL('../src/app/pages/cadastro/models/cadastro.model.ts', import.meta.url), 'utf8'),
        readFile(new URL('../src/app/pages/cadastro/cadastro.component.ts', import.meta.url), 'utf8'),
        readFile(new URL('../src/app/pages/cadastro/concorrente/videos/concorrente-videos.component.ts', import.meta.url), 'utf8')
    ]);
    const frontend = arquivosFrontend.join('\n');
    assert.doesNotMatch(frontend, /Catraias|Tema Para Tanya|idObra:\s*63/);

    const configuracao = await readFile(new URL('../src/config/festival.js', import.meta.url), 'utf8');
    const controladores = await Promise.all([
        readFile(new URL('../src/controllers/obraController.js', import.meta.url), 'utf8'),
        readFile(new URL('../src/controllers/usuariosController.js', import.meta.url), 'utf8')
    ]);
    assert.doesNotMatch([configuracao, ...controladores].join('\n'), /Ana Luiza(?:\.pdf)?/);
    assert.match(controladores[1], /c\.id_obra_1[\s\S]*LEFT JOIN ist_composicao obra1 ON obra1\.id_obra = c\.id_obra_1/);
    assert.match(controladores[1], /SELECT GET_LOCK\(\?, 10\) AS adquirido/);
    assert.match(controladores[1], /PREFIXO_INSCRICAO_FESTIVAL = 'FVST2'/);
});
