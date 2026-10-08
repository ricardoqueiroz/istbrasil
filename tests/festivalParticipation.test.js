import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { pool as db } from '../src/config/db.js';
import { FESTIVAL_II } from '../src/config/festival.js';
import { resolverEventoPorSlug } from '../src/services/festivalEventoService.js';
import obraController from '../src/controllers/obraController.js';
import usuariosController from '../src/controllers/usuariosController.js';
import { autenticarUsuario } from '../src/middlewares/authMiddleware.js';
import { execFileSync } from 'node:child_process';

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

const executarAtualizacao = async ({ aceitePersistido, idObra1, idObra2, obraSecundaria, idEvento = 1, concluir = false, sequencia = [], emailPendente = false }) => {
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
            if (consulta.includes('FROM ist_eventos WHERE slug = ?')) {
                return [[{ id: idEvento, slug: params[0], status: 'Inscricoes_Abertas' }]];
            }
            if (consulta.includes('SELECT id_concorrente, numero_concorrente, id_obra_1')) {
                return [[{
                    id_concorrente: 17,
                    numero_concorrente: aceitePersistido ? 'FVST2-001' : null,
                    id_obra_1: idObra1,
                    aceite_regulamento: aceitePersistido ? 1 : 0,
                    confirmacao_inscricao_enviada: emailPendente ? 0 : 1
                }]];
            }
            if (consulta.startsWith('SELECT GET_LOCK') || consulta.startsWith('SELECT RELEASE_LOCK')) {
                return [[{ adquirido: 1, liberado: 1 }]];
            }
            if (consulta.startsWith('SELECT numero_concorrente FROM ist_concorrentes')) {
                return [sequencia.map((numero_concorrente) => ({ numero_concorrente }))];
            }
            if (consulta.includes('FROM ist_composicao WHERE id_obra = ?')) {
                if (params[0] === FESTIVAL_II.idObraPrincipal) {
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
    const queryOriginal = db.query;
    db.getConnection = async () => connection;
    if (emailPendente) {
        db.query = async (sql, params) => {
            const consulta = normalizarSql(sql);
            consultas.push({ sql: consulta, params });
            if (consulta.includes('FROM ist_eventos WHERE slug = ?')) {
                return [[{ id: idEvento, slug: params[0], status: 'Inscricoes_Abertas' }]];
            }
            if (consulta.includes('INNER JOIN ist_concorrentes c')) {
                return [[{ id_concorrente: 17, numero_concorrente: 'FVST2-008', aceite_regulamento: 1, confirmacao_inscricao_enviada: 1 }]];
            }
            throw new Error(`Consulta de e-mail não simulada: ${consulta}`);
        };
    }
    const resposta = criarResposta();
    try {
        await usuariosController.atualizarParticipacaoConcorrente(
            {
                usuario: { id_usuario: 7 },
                body: {
                    linkVideo1: VIDEO_1,
                    idObra2,
                    linkVideo2: idObra2 == null ? null : VIDEO_2,
                    ...(concluir ? { aceiteRegulamento: true } : {})
                }
            },
            resposta
        );
    } finally {
        db.getConnection = getConnectionOriginal;
        db.query = queryOriginal;
    }

    return { resposta, consultas };
};

test('configuração canônica contém slug, prefixo e obra do II Festival', () => {
    assert.deepEqual(FESTIVAL_II, {
        slug: 'ii-festival-de-violoes-sebastiao-tapajos',
        prefixoInscricao: 'FVST2',
        idObraPrincipal: 22,
        idEtapaInscricoes: FESTIVAL_II.idEtapaInscricoes
    });
    assert.equal(Object.isFrozen(FESTIVAL_II), true);
});

test('schema versionado identifica participação por PK e usuário/evento', async () => {
    const [tabela, constraints] = await Promise.all([
        readFile(new URL('../database/istbrasil_table_ist_concorrentes.sql', import.meta.url), 'utf8'),
        readFile(new URL('../database/istbrasil_extra.sql', import.meta.url), 'utf8')
    ]);
    assert.match(tabela, /id_concorrente int\(10\) UNSIGNED NOT NULL/);
    assert.match(tabela, /id_usuario int\(11\) NOT NULL/);
    assert.match(tabela, /id_evento int\(10\) UNSIGNED NOT NULL/);
    assert.match(tabela, /numero_concorrente varchar\(50\) DEFAULT NULL/);
    assert.match(tabela, /INSERT INTO ist_concorrentes \(id_usuario, id_evento, numero_concorrente,/);
    assert.match(tabela, /\(2, 1, 'FVST2-001', 22,/);
    assert.match(constraints, /ADD PRIMARY KEY \(id_concorrente\)/);
    assert.match(constraints, /UNIQUE KEY concorrente_usuario_evento_unico \(id_usuario, id_evento\)/);
    assert.match(constraints, /UNIQUE KEY numero_concorrente_evento_unico \(id_evento, numero_concorrente\)/);
    assert.match(constraints, /MODIFY id_concorrente int\(10\) UNSIGNED NOT NULL AUTO_INCREMENT/);
    assert.match(constraints, /FOREIGN KEY \(id_evento\) REFERENCES ist_eventos \(id\)/);
    assert.match(constraints, /FOREIGN KEY \(id_obra_[12]\) REFERENCES ist_composicao \(id_obra\)/);
});

test('resolvedor consulta o slug e rejeita evento ausente ou indisponível', async () => {
    const consultas = [];
    const executor = {
        query: async (sql, params) => {
            consultas.push({ sql: normalizarSql(sql), params });
            return [[{ id: 5, slug: params[0], status: 'Inscricoes_Abertas' }]];
        }
    };
    assert.equal((await resolverEventoPorSlug(FESTIVAL_II.slug, executor)).id, 5);
    assert.deepEqual(consultas[0].params, [FESTIVAL_II.slug]);
    await assert.rejects(resolverEventoPorSlug(FESTIVAL_II.slug, { query: async () => [[]] }), /indisponível/);
    await assert.rejects(resolverEventoPorSlug(FESTIVAL_II.slug, {
        query: async (_sql, params) => [[{ id: 5, slug: params[0], status: 'Cancelado' }]]
    }), /indisponível/);
});

test('adesão reutiliza somente a participação do mesmo evento e cria a de outro evento', async () => {
    const existentes = new Set([1]);
    const consultas = [];
    let eventoAtual = 1;
    const connection = {
        async beginTransaction() {},
        async commit() {},
        async rollback() {},
        release() {},
        async query(sql, params = []) {
            const consulta = normalizarSql(sql);
            consultas.push({ sql: consulta, params });
            if (consulta.startsWith('SELECT id_usuario, id_tipo_usuario, id_situacao')) {
                return [[{ id_usuario: 7, id_tipo_usuario: 2, id_situacao: 3, nome: 'Teste', foto: null }]];
            }
            if (consulta.includes('FROM ist_eventos WHERE slug = ?')) {
                return [[{ id: eventoAtual, slug: params[0], status: 'Inscricoes_Abertas' }]];
            }
            if (consulta.startsWith('SELECT id_concorrente FROM ist_concorrentes')) {
                return [existentes.has(params[1]) ? [{ id_concorrente: 17 }] : []];
            }
            if (consulta.startsWith('INSERT INTO ist_concorrentes')) {
                existentes.add(params[1]);
                return [{ affectedRows: 1 }];
            }
            throw new Error(`Consulta não simulada: ${consulta}`);
        }
    };
    const getConnectionOriginal = db.getConnection;
    db.getConnection = async () => connection;
    const aderir = async () => {
        const res = {
            statusCode: 200,
            status(codigo) { this.statusCode = codigo; return this; },
            cookie() {},
            json(conteudo) { this.body = conteudo; return this; }
        };
        await usuariosController.aderirAoFestivalComoConcorrente({ usuario: { id_usuario: 7 }, cookies: {} }, res);
        assert.equal(res.statusCode, 200);
    };
    try {
        await aderir();
        eventoAtual = 9;
        await aderir();
        await aderir();
    } finally {
        db.getConnection = getConnectionOriginal;
    }
    assert.deepEqual(consultas.filter(({ sql }) => sql.startsWith('SELECT id_concorrente FROM ist_concorrentes'))
        .map(({ params }) => params), [[7, 1], [7, 9], [7, 9]]);
    assert.deepEqual(consultas.filter(({ sql }) => sql.startsWith('INSERT INTO ist_concorrentes'))
        .map(({ params }) => params), [[7, 9]]);
});

test('conclusão gera FVST2 por evento e grava apenas na PK da participação', async () => {
    const { resposta, consultas } = await executarAtualizacao({
        aceitePersistido: false,
        idObra1: null,
        idObra2: null,
        obraSecundaria: null,
        idEvento: 9,
        concluir: true,
        sequencia: ['FVST2-003', 'FVST2-007']
    });
    assert.equal(resposta.statusCode, 200);
    assert.equal(resposta.body.concorrente.numeroConcorrente, 'FVST2-008');
    assert.deepEqual(consultas.find(({ sql }) => sql.startsWith('SELECT numero_concorrente FROM ist_concorrentes')).params,
        [9, '^FVST2-[0-9]+$']);
    const lock = consultas.find(({ sql }) => sql.startsWith('SELECT GET_LOCK')).params[0];
    assert.match(lock, /:9:FVST2$/);
    assert.deepEqual(consultas.find(({ sql }) => sql.startsWith('SELECT RELEASE_LOCK')).params, [lock]);
    const aceite = consultas.find(({ sql }) => sql.includes('SET numero_concorrente = ?'));
    assert.deepEqual(aceite.params, ['FVST2-008', 17]);
    assert.match(aceite.sql, /WHERE id_concorrente = \?/);
});

test('confirmação carrega snapshot da participação do evento e número público', async () => {
    const { resposta, consultas } = await executarAtualizacao({
        aceitePersistido: false,
        idObra1: null,
        idObra2: null,
        obraSecundaria: null,
        idEvento: 9,
        concluir: true,
        emailPendente: true
    });
    assert.equal(resposta.statusCode, 200);
    assert.equal(resposta.body.concorrente.confirmacaoInscricaoEnviada, true);
    const snapshot = consultas.find(({ sql }) => sql.includes('INNER JOIN ist_concorrentes c'));
    assert.deepEqual(snapshot.params, [7, 9]);
    assert.match(snapshot.sql, /c\.numero_concorrente/);
    assert.match(snapshot.sql, /WHERE u\.id_usuario = \? AND c\.id_evento = \?/);
    const fonte = await readFile(new URL('../src/controllers/usuariosController.js', import.meta.url), 'utf8');
    assert.match(fonte, /numero_concorrente: String\(snapshot\.numero_concorrente/);
    assert.match(fonte, /SET confirmacao_inscricao_enviada = 1,[\s\S]*?WHERE id_concorrente = \?/);
    assert.match(fonte, /\[snapshot\.id_concorrente\]/);
});

test('cadastro público cria participação com evento resolvido, não com ID fornecido pelo cliente', async () => {
    const fonte = await readFile(new URL('../src/controllers/usuariosController.js', import.meta.url), 'utf8');
    assert.match(fonte, /if \(tipo === 'concorrente'\) \{\s*const evento = await resolverEventoPorSlug\(FESTIVAL_II\.slug, connection\)/);
    assert.match(fonte, /INSERT INTO ist_concorrentes\s*\(id_usuario, id_evento\)\s*VALUES \(\?, \?\)/);
    assert.match(fonte, /\[result\.insertId, evento\.id\]/);
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
    assert.equal(resposta.body.concorrente.numeroConcorrente, null);
    assert.equal(Object.hasOwn(resposta.body.concorrente, 'idConcorrente'), false);
    const consultaParticipacao = consultas.find(({ sql }) => sql.includes('SELECT id_concorrente, numero_concorrente, id_obra_1'));
    assert.deepEqual(consultaParticipacao.params, [7, 1]);
    const validacaoObra2 = consultas.find(({ sql }) => sql.includes('AND propria = 1'));
    assert.ok(validacaoObra2);
    assert.equal(validacaoObra2.sql.includes('partitura IS NOT NULL'), false);
    assert.deepEqual(validacaoObra2.params, [40, 22]);
    const atualizacao = consultas.find(({ sql }) => sql.startsWith('UPDATE ist_concorrentes'));
    assert.match(atualizacao.sql, /SET id_obra_1 = \?/);
    assert.equal(atualizacao.params[0], 22);
    assert.match(atualizacao.sql, /WHERE id_concorrente = \?/);
    assert.equal(atualizacao.params.at(-1), 17);
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
    assert.equal(atualizacao.params.at(-1), 17);
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
    assert.match(controladores[1], /FESTIVAL_II\.prefixoInscricao/);
});

// Fase 2: somente mocks; nenhuma consulta é enviada a banco real.
const simularPerfilContextual = async ({ inscrito = true, etapaValida = true, idUsuarioParticipacao = 7, idEventoParticipacao = 1, tipo = 2 } = {}) => {
    const queryOriginal = db.query;
    const consultas = [];
    db.query = async (sql, params) => {
        const consulta = normalizarSql(sql); consultas.push({ sql: consulta, params });
        if (consulta.includes('FROM ist_usuarios')) return [[{ id_usuario: 7, id_tipo_usuario: tipo, nome: 'Concorrente', email: 'teste@example.com', foto: null }]];
        if (consulta.includes('FROM ist_eventos WHERE slug')) return [[{ id: 1, slug: FESTIVAL_II.slug, status: 'Em_Andamento' }]];
        if (consulta.includes('FROM ist_concorrentes c')) return [inscrito ? [{
            concorrente_usuario_id: idUsuarioParticipacao, id_evento: idEventoParticipacao, id_concorrente: 17,
            numero_concorrente: 'FVST2-001', id_obra_1: 22, titulo_obra_1: 'Obra', link_video_1: 'https://youtu.be/abcdefghijk',
            id_obra_2: null, titulo_obra_2: null, link_video_2: null, aceite_regulamento: 1, data_cadastro: '2026-10-01'
        }] : []];
        if (consulta.includes('FROM ist_eventos_etapas')) return [etapaValida ? [{ id: FESTIVAL_II.idEtapaInscricoes, evento_id: 1 }] : [{ id: FESTIVAL_II.idEtapaInscricoes, evento_id: 2 }]];
        throw new Error('Consulta não simulada');
    };
    try {
        const res = criarResposta();
        await usuariosController.obterPerfil({ usuario: { id_usuario: 7 }, query: { id_usuario: 99, id_evento: 99 } }, res);
        return { res, consultas };
    } finally { db.query = queryOriginal; }
};

test('Fase 2 perfil retorna IDs validados e mantém contrato antigo', async () => {
    const { res, consultas } = await simularPerfilContextual();
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.concorrente, {
        idEvento: 1, idConcorrente: 17, idEtapaInscricoes: FESTIVAL_II.idEtapaInscricoes,
        numeroConcorrente: 'FVST2-001', idObra1: 22, tituloObra1: 'Obra', linkVideo1: 'https://youtu.be/abcdefghijk',
        idObra2: null, tituloObra2: null, linkVideo2: null, aceiteRegulamento: true, dataCadastro: '2026-10-01'
    });
    const participacao = consultas.find(c => c.sql.includes('FROM ist_concorrentes c'));
    assert.match(participacao.sql, /WHERE c.id_usuario = \? AND c.id_evento = \?/);
    assert.deepEqual(participacao.params, [7, 1]);
    if (FESTIVAL_II.idEtapaInscricoes !== null) {
        const etapa = consultas.find(c => c.sql.includes('FROM ist_eventos_etapas'));
        assert.deepEqual(etapa.params, [FESTIVAL_II.idEtapaInscricoes, 1]);
        assert.match(etapa.sql, /WHERE id = \? AND evento_id = \?/);
    }
    assert.equal(consultas.some(c => /avaliaco|jurado|julgamento/.test(c.sql)), false);
});

test('Fase 2 etapa configurada de outro evento não habilita contexto', async () => {
    const { res } = await simularPerfilContextual({ etapaValida: false });
    assert.equal(res.statusCode, 200); assert.equal(res.body.concorrente.idEtapaInscricoes, null);
});

test('Fase 2 concorrente sem participação no Festival II recebe null', async () => {
    const { res, consultas } = await simularPerfilContextual({ inscrito: false });
    assert.equal(res.body.concorrente, null);
    assert.equal(consultas.some(c => c.sql.includes('ist_eventos_etapas')), false);
});

for (const caso of [{ idUsuarioParticipacao: 8 }, { idEventoParticipacao: 2 }]) test(`Fase 2 não aceita participação alheia ${JSON.stringify(caso)}`, async () => {
    const { res } = await simularPerfilContextual(caso);
    assert.equal(res.body.concorrente, null);
});

test('Fase 2 externo não consulta participação', async () => {
    const { res, consultas } = await simularPerfilContextual({ tipo: 3 });
    assert.equal(res.body.concorrente, null); assert.equal(consultas.length, 1);
});

test('Fase 2 visitante é barrado pelo middleware existente do perfil', () => {
    const res = criarResposta(); let passou = false;
    autenticarUsuario({ cookies: {} }, res, () => { passou = true; });
    assert.equal(res.statusCode, 401); assert.equal(passou, false);
});

test('Fase 2 configuração de produção exige ID explícito e rejeita valores inválidos', () => {
    for (const [valor, esperado] of [['', null], ['77', 77], ['-1', null], ['1abc', null], ['4294967296', null]]) {
        const resultado = execFileSync(process.execPath, ['--input-type=module', '-e',
            "import { FESTIVAL_II } from './src/config/festival.js'; console.log(JSON.stringify(FESTIVAL_II.idEtapaInscricoes));"],
            { cwd: new URL('../', import.meta.url), env: { ...process.env, NODE_ENV: 'production', FESTIVAL_II_ETAPA_INSCRICOES_ID: valor }, encoding: 'utf8' });
        assert.equal(JSON.parse(resultado.trim()), esperado);
    }
});
