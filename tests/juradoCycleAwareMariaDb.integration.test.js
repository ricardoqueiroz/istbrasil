import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import http from 'node:http';
import { after, before, test } from 'node:test';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import mysql from 'mysql2/promise';
import { pool as applicationPool } from '../src/config/db.js';
import {
    resolverContextoJulgamento, resolverJuradoCiclo, resolverConcorrenteCiclo,
    carregarCriteriosCiclo, interpretarTentativasCiclo
} from '../src/services/julgamentoContextService.js';
import { obterAvaliacaoJuradoCycleAware as leitura } from '../src/services/juradoAvaliacaoLeituraService.js';
import { salvarAvaliacaoJuradoCycleAware as gravar } from '../src/services/juradoAvaliacaoGravacaoService.js';
import {
    avaliarAutorizacaoGravacao, carregarElegibilidadeLiveGravacao
} from '../src/services/juradoAvaliacaoAutorizacaoService.js';
import {
    listarAcessosJuradoCycleAware as acessos, obterEventoJuradoCycleAware as evento,
    listarConcorrentesJuradoCycleAware as fila, obterConcorrenteJuradoCycleAware as detalhe
} from '../src/services/juradoNavegacaoCycleAwareService.js';

// Run with node --test and IST_MARIADB_INTEGRATION=1, IST_A2_ARTIFACTS_DIR,
// IST_A2_CREDENTIALS_FILE pointing to the approved external artifacts and protected credentials.
// Normal unit runs skip explicitly; writer SAVEPOINTs never commit the outer test transaction.
const enabled = process.env.IST_MARIADB_INTEGRATION === '1';
const integration = (name, fn) => test(name, { skip: !enabled }, fn);
const schema = 'ist_7k7b2d2_maria_20261006_r1';
const hostname = 'd80798447c0f';
const slugA = 'ii-festival-de-violoes-sebastiao-tapajos';
const slugB = 'crossdb-sintetico-102';
const slugC = 'crossdb-sintetico-103';
const code = expected => error => error.code === expected;
let pool, contextA, contextB, contextC, baseline, a2Context, a2Runner, mysqlState;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = rows => rows.map(row => JSON.stringify(Object.fromEntries(Object.entries(row).sort()))).sort();

async function readonly(fn) {
    const c = await pool.getConnection();
    try {
        await c.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
        return await fn(c);
    } finally {
        try { await c.rollback(); } finally { c.release(); }
    }
}

async function snapshot(c) {
    const [tables] = await c.query('SELECT TABLE_NAME AS name FROM information_schema.tables WHERE table_schema=DATABASE() ORDER BY TABLE_NAME');
    const data = {};
    for (const { name } of tables) {
        assert.match(name, /^ist_[a-z_]+$/);
        const [rows] = await c.query(`SELECT * FROM \`${name}\``);
        const [ddl] = await c.query(`SHOW CREATE TABLE \`${name}\``);
        data[name] = { rows: canonical(rows), ddl };
    }
    return data;
}

before(async () => {
    if (!enabled) return;
    assert.ok(process.env.IST_A2_ARTIFACTS_DIR, 'IST_A2_ARTIFACTS_DIR is required');
    assert.ok(process.env.IST_A2_CREDENTIALS_FILE, 'IST_A2_CREDENTIALS_FILE is required');
    const require = createRequire(import.meta.url);
    a2Runner = require(`${process.env.IST_A2_ARTIFACTS_DIR}\\runner.cjs`);
    const { scan } = require(`${process.env.IST_A2_ARTIFACTS_DIR}\\sql-tools.cjs`);
    const { validateManifest } = require(`${process.env.IST_A2_ARTIFACTS_DIR}\\identity-contract.cjs`);
    const manifestBytes = readFileSync(`${process.env.IST_A2_ARTIFACTS_DIR}\\artifacts-manifest.json`);
    const manifest = validateManifest(manifestBytes, hash);
    for (const [name, expected] of Object.entries(manifest.artifacts)) {
        const bytes = readFileSync(`${process.env.IST_A2_ARTIFACTS_DIR}\\${name}`);
        assert.equal(hash(bytes), expected.sha256);
        assert.equal(bytes.length, expected.bytes);
    }
    assert.equal(hash(readFileSync(manifest.migration.path)), manifest.migration.sha256);
    assert.equal(hash(readFileSync(manifest.a1.path)), manifest.a1.sha256);
    a2Context = {
        manifest, manifestHash: hash(manifestBytes),
        ddl: scan(readFileSync(`${process.env.IST_A2_ARTIFACTS_DIR}\\legacy-ddl.sql`, 'utf8')),
        migration: scan(readFileSync(manifest.migration.path, 'utf8')),
        a1: JSON.parse(readFileSync(manifest.a1.path))
    };
    const { auditSchema } = require(`${process.env.IST_A2_ARTIFACTS_DIR}\\schema-contract.cjs`);
    const evidence = readFileSync(`${process.env.IST_A2_ARTIFACTS_DIR}\\execution-maria-12.json`);
    assert.equal(hash(evidence), '1040d780ba5779b6bd78fe4231ab2893d64e7dc6e81963d8175539d2cafedd16');
    a2Runner.validatePreviousEvidence(evidence, {
        target: 'maria', containerId: 'd80798447c0f3d837c3cbafbba06175fb0636e2fd1e27a8fca0a741e993ad4a1',
        schema, checkpoint: 'J_POST_FIXTURES', manifestSha256: a2Context.manifestHash,
        previousEvidenceSha256: '997f225230f2f41139cca801c8bcd9c34fcc7fb7de41fe4fb4d384850685da42'
    }, a2Runner.protocolArtifacts(`${process.env.IST_A2_ARTIFACTS_DIR}\\execution-maria-12.json`));
    const credentials = JSON.parse(readFileSync(process.env.IST_A2_CREDENTIALS_FILE));
    pool = mysql.createPool({
        host: '127.0.0.1', port: 13317, database: schema, user: 'root',
        password: credentials['ist-7k7b2d2-mariadb10339-20261006-r1'].rootPassword,
        dateStrings: true, timezone: 'Z', multipleStatements: false, connectionLimit: 2
    });
    await readonly(async c => {
        const [[identity]] = await c.query('SELECT VERSION() AS version, @@hostname AS hostname, DATABASE() AS db');
        assert.equal(identity.version, '10.3.39-MariaDB-1:10.3.39+maria~ubu2004');
        assert.equal(identity.hostname, hostname);
        assert.equal(identity.db, schema);
        await auditSchema(c, a2Context, true);
        const state = await a2Runner.stateHash(c, a2Context);
        assert.equal(state.fingerprint, JSON.parse(evidence).stateHash);
        baseline = await snapshot(c);
        contextA = await resolverContextoJulgamento(101, c);
        contextB = await resolverContextoJulgamento(102, c);
        contextC = await resolverContextoJulgamento(103, c);
    });
    const mysqlTarget = a2Context.a1.resources.find(t => t.family === 'mysql');
    const c = await mysql.createConnection({
        host: '127.0.0.1', port: 13316, database: mysqlTarget.schema, user: 'root',
        password: credentials[mysqlTarget.name].rootPassword, dateStrings: true, timezone: 'Z'
    });
    try { mysqlState = await a2Runner.stateHash(c, a2Context); assert.equal(mysqlState.tables, 0); }
    finally { await c.end(); }
});

after(async () => {
    if (!pool) return;
    try {
        await readonly(async c => {
            assert.deepEqual(await snapshot(c), baseline, 'All fixture rows and SHOW CREATE definitions must be restored');
            const [[counts]] = await c.query(`SELECT
                SUM(CONSTRAINT_TYPE='PRIMARY KEY') AS pk, SUM(CONSTRAINT_TYPE='UNIQUE') AS uq,
                SUM(CONSTRAINT_TYPE='FOREIGN KEY') AS fk, SUM(CONSTRAINT_TYPE='CHECK') AS ck
                FROM information_schema.table_constraints WHERE constraint_schema=DATABASE()`);
            assert.deepEqual(counts, { pk: '22', uq: '30', fk: '48', ck: '27' });
        });
        const credentials = JSON.parse(readFileSync(process.env.IST_A2_CREDENTIALS_FILE));
        const t = a2Context.a1.resources.find(t => t.family === 'mysql');
        const c = await mysql.createConnection({
            host: '127.0.0.1', port: 13316, database: t.schema, user: 'root',
            password: credentials[t.name].rootPassword, dateStrings: true, timezone: 'Z'
        });
        try { assert.deepEqual(await a2Runner.stateHash(c, a2Context), mysqlState); }
        finally { await c.end(); }
    } finally { await pool.end(); }
});

integration('A: real context resolves current cycles, eligible snapshot roster and criteria', async () => {
    await readonly(async c => {
        assert.equal(contextA.numero_ciclo, 1);
        assert.equal(contextA.permite_escrita, true);
        assert.equal(contextB.permite_escrita, false);
        assert.equal(contextC.id_ciclo_atual, 8001);
        assert.equal(contextC.numero_ciclo, 2);
        assert.equal((await resolverJuradoCiclo(contextA, 1001, c, { exigirIncluido: true })).estado_participacao, 'incluido');
        await assert.rejects(resolverJuradoCiclo(contextA, 1003, c), code('JURADO_FORA_ROSTER'));
        const criteria = await carregarCriteriosCiclo(contextA, c);
        assert.equal(criteria.length, 4);
        assert.equal(criteria.reduce((n, r) => n + Number(r.peso), 0), 100);
        assert(criteria.every(r => r.id_ciclo === contextA.id_ciclo_atual));
    });
});
integration('B: open-cycle access, paginated queue and frozen detail use SQL membership', async () => {
    const access = await acessos(1001, pool);
    assert.deepEqual(access.eventos.map(e => e.id), [101, 102, 103]);
    assert.equal((await evento(slugA, 1001, pool)).contexto.idCiclo, contextA.id_ciclo_atual);
    const queue = await fila(slugA, 1001, { page: 1, limit: 100 }, pool);
    assert.equal(queue.pagination.total, 100);
    assert.equal(queue.concorrentes.length, 100);
    assert(!queue.concorrentes.some(p => [3103, 3104].includes(p.idParticipacao)));
    const dto = await detalhe(slugA, 3001, 1001, pool);
    assert.equal(dto.concorrente.obraPrincipal.titulo, 'Obra sintetica principal');
    assert.equal(dto.concorrente.linkVideoPrincipal, 'https://example.invalid/synthetic-video-1');
    assert.equal((await fila(slugA, 1001, { page: 2, limit: 100 }, pool)).concorrentes.length, 0);
});
integration('B: legacy draft/completed, effective attempt, snapshot notes and weighted 0-100 DTO', async () => {
    await readonly(async c => {
        const draft = await leitura(101, 3001, 1001, c);
        const completed = await leitura(101, 3002, 1001, c);
        assert.equal(draft.estado, 'rascunho');
        assert.equal(completed.estado, 'concluida');
        assert.equal(draft.podeGravar, true);
        assert.equal(draft.autorizacaoGravacao.estado, 'autorizada');
        assert.equal(completed.podeGravar, false);
        assert.equal(completed.autorizacaoGravacao.code, 'AVALIACAO_CONCLUIDA');
        assert.equal(draft.contexto.numeroTentativa, 1);
        assert.equal(completed.contexto.numeroTentativa, 1);
        assert.equal(draft.avaliacao.notas.length, 1);
        assert.equal(completed.avaliacao.notas.length, 4);
        assert.equal(draft.avaliacao.media, null);
        assert.equal(completed.avaliacao.media, '75.00');
        assert.equal(draft.avaliacao.notas[0].nota, 75);
        assert(completed.avaliacao.notas.every(n => n.nota === 75));
        for (const dto of [draft, completed]) {
            assert.deepEqual(dto.escala, { min: 0, max: 100, passo: 1 });
            assert(dto.avaliacao.notas.every(n => dto.criterios.some(k =>
                k.idCriterioCiclo === n.idCriterioCiclo && k.idCriterioOrigem === n.idCriterioOrigem)));
        }
        const [attempts] = await c.query('SELECT * FROM ist_eventos_avaliacoes WHERE id_avaliacao=6001');
        assert.equal(interpretarTentativasCiclo(attempts, {
            id_evento: 101, id_ciclo: contextA.id_ciclo_atual, id_jurado: 1001, id_concorrente: 3001
        }).id_avaliacao, 6001);
    });
});
integration('C/D: sealed publication history and reopened cycle 2 resolve without mixing cycle 1', async () => {
    await readonly(async c => {
        assert.equal(contextB.estado_ciclo, 'selado');
        assert.equal(contextB.id_publicacao_vigente, 7001);
        const sealed = await leitura(102, 3101, 1001, c);
        assert.equal(sealed.contexto.idCiclo, contextB.id_ciclo_atual);
        assert.equal(sealed.podeGravar, false);
        assert.equal(sealed.autorizacaoGravacao.estado, 'ciclo_fechado');
        assert.equal(contextC.id_publicacao_vigente, 7002);
        assert.equal(contextC.id_publicacao_origem, 7002);
        const oldContext = { id_evento: 103, id_ciclo_atual: contextC.id_ciclo_origem };
        const oldCriteria = await carregarCriteriosCiclo(oldContext, c);
        const currentCriteria = await carregarCriteriosCiclo(contextC, c);
        assert(oldCriteria.every(o => currentCriteria.every(n => n.id_criterio_ciclo !== o.id_criterio_ciclo)));
        assert.deepEqual(oldCriteria.map(r => r.nome), currentCriteria.map(r => r.nome));
        const dto = await leitura(103, 3102, 1001, c);
        assert.equal(dto.contexto.idCiclo, 8001);
        assert.equal(dto.contexto.numeroTentativa, null);
        assert.equal(dto.estado, 'pendente');
        assert.equal(dto.podeGravar, true);
        const [[history]] = await c.query('SELECT estado FROM ist_eventos_ciclos WHERE id_ciclo=?', [contextC.id_ciclo_origem]);
        assert.equal(history.estado, 'selado');
    });
    assert.equal((await evento(slugC, 1001, pool)).contexto.numeroCiclo, 2);
});
integration('E: live revocation denies navigation while frozen roster remains readable', async () => {
    await readonly(async c => {
        assert.equal((await resolverJuradoCiclo(contextB, 1002, c, { exigirIncluido: true })).estado_participacao, 'incluido');
        assert.equal((await leitura(102, 3101, 1002, c)).estado, 'pendente');
        const revoked = await leitura(101, 3001, 1002, c);
        assert.equal(revoked.podeGravar, false);
        assert.equal(revoked.autorizacaoGravacao.estado, 'jurado_inelegivel');
    });
    assert.deepEqual((await acessos(1002, pool)).eventos, []);
    await assert.rejects(evento(slugA, 1002, pool), code('ACESSO_OPERACIONAL_NEGADO'));
});
integration('F: absent and explicitly ineligible participants never gain frozen membership', async () => {
    await readonly(async c => {
        await assert.rejects(resolverConcorrenteCiclo(contextA, 3103, c, { exigirIncluido: true }), code('CONCORRENTE_AUSENTE'));
        await assert.rejects(resolverConcorrenteCiclo(contextA, 3104, c, { exigirIncluido: true }), code('CONCORRENTE_NAO_INCLUIDO'));
    });
    for (const id of [3103, 3104])
        await assert.rejects(detalhe(slugA, id, 1001, pool), code('CONCORRENTE_AUSENTE'));
});

integration('shared authorization: real A/B/C, live revocation, exclusion and completed decisions match reader', async () => {
    await readonly(async c => {
        const decision = async (idEvento, idParticipacao, idUsuario) => {
            const contexto = await resolverContextoJulgamento(idEvento, c);
            const par = { id_evento: idEvento, id_ciclo: contexto.id_ciclo_atual,
                id_jurado: idUsuario, id_concorrente: idParticipacao };
            return avaliarAutorizacaoGravacao({
                contexto, idUsuario, idParticipacao,
                live: () => carregarElegibilidadeLiveGravacao(c, idEvento, idUsuario),
                jurado: () => resolverJuradoCiclo(contexto, idUsuario, c, { exigirIncluido: true }),
                participante: () => resolverConcorrenteCiclo(contexto, idParticipacao, c, { exigirIncluido: true }),
                criterios: () => carregarCriteriosCiclo(contexto, c),
                efetiva: async () => {
                    const [rows] = await c.query(`SELECT * FROM ist_eventos_avaliacoes
                        WHERE id_evento=? AND id_ciclo=? AND id_jurado=? AND id_concorrente=?
                        ORDER BY numero_tentativa, id_avaliacao`,
                    [idEvento, par.id_ciclo, idUsuario, idParticipacao]);
                    return interpretarTentativasCiclo(rows, par);
                }
            });
        };
        for (const [event, participant, juror, estado, podeGravar] of [
            [101, 3001, 1001, 'autorizada', true], [101, 3002, 1001, 'avaliacao_concluida', false],
            [102, 3101, 1001, 'ciclo_fechado', false], [103, 3102, 1001, 'autorizada', true],
            [101, 3001, 1002, 'jurado_inelegivel', false]
        ]) {
            const authorization = await decision(event, participant, juror);
            const dto = await leitura(event, participant, juror, c);
            assert.equal(authorization.estado, estado);
            assert.equal(authorization.podeGravar, podeGravar);
            assert.equal(dto.podeGravar, podeGravar);
            assert.deepEqual(dto.autorizacaoGravacao, {
                estado, code: authorization.code, motivo: authorization.motivo
            });
        }
        assert.equal((await decision(101, 3104, 1001)).code, 'CONCORRENTE_NAO_INCLUIDO');
        assert.equal((await decision(101, 3103, 1001)).code, 'CONCORRENTE_AUSENTE');
        assert.equal((await resolverJuradoCiclo(contextA, 1002, c)).estado_participacao, 'incluido');
    });
});

// The writer owns its transaction. Map only its boundaries to real SAVEPOINT SQL
// inside an outer test transaction; all domain queries and locks reach MariaDB unchanged.
async function isolatedWriter(fn) {
    const c = await pool.getConnection();
    try {
        await c.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
        await c.beginTransaction();
        const adapter = { getConnection: async () => ({
            query: (sql, params) => {
                if (sql === 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED') return Promise.resolve([[], []]);
                return c.query(sql, params);
            },
            beginTransaction: () => c.query('SAVEPOINT cycle_writer'),
            commit: () => c.query('RELEASE SAVEPOINT cycle_writer'),
            rollback: async () => { await c.query('ROLLBACK TO SAVEPOINT cycle_writer'); await c.query('RELEASE SAVEPOINT cycle_writer'); },
            release: () => {},
            destroy: () => c.destroy()
        }) };
        await fn(c, adapter);
    } finally {
        try { await c.rollback(); } finally { c.release(); }
    }
}
const payload = (dto, notes = []) => ({
    contexto: { idCiclo: dto.contexto.idCiclo, numeroTentativa: dto.contexto.numeroTentativa },
    versao: dto.versao, estado: 'rascunho', notas: notes,
    possivelDesclassificacao: false, motivoDesclassificacao: null
});
integration('G: real draft replacement, server criteria, optimistic version and post-write DTO roll back', async () => {
    await isolatedWriter(async (c, adapter) => {
        const before = await leitura(101, 3001, 1001, c);
        const notes = before.criterios.map((k, i) => ({ idCriterioCiclo: k.idCriterioCiclo, nota: [20, 40, 60, 80][i] }));
        const written = await gravar(101, 3001, 1001, payload(before, notes), adapter);
        assert.equal(written.versao, before.versao + 1);
        assert.equal(written.avaliacao.media, '50.00');
        assert.equal(written.avaliacao.notas.length, 4);
        assert.equal(written.avaliacao.idAvaliacao, 6001);
        assert.equal(written.podeGravar, true);
        await assert.rejects(gravar(101, 3001, 1001, payload(before, notes), adapter), code('VERSAO_DESATUALIZADA'));
        const replaced = await gravar(101, 3001, 1001, payload(written, [notes[1]]), adapter);
        assert.equal(replaced.avaliacao.notas.length, 1);
        assert.equal(replaced.avaliacao.notas[0].idCriterioCiclo, notes[1].idCriterioCiclo);
        const [rows] = await c.query('SELECT id_criterio, id_criterio_ciclo, id_ciclo FROM ist_eventos_avaliacoes_notas WHERE id_avaliacao=6001');
        assert.equal(rows.length, 1);
        assert.equal(rows[0].id_criterio, before.criterios[1].idCriterioOrigem);
        assert.equal(rows[0].id_ciclo, contextA.id_ciclo_atual);
    });
    await readonly(async c => assert.equal((await leitura(101, 3001, 1001, c)).versao, 1));
});
integration('G: stale cycle/attempt, sealed cycle, revoked juror, excluded/absent and completed writes reject', async () => {
    await isolatedWriter(async (c, adapter) => {
        const dto = await leitura(101, 3001, 1001, c);
        const base = payload(dto);
        await assert.rejects(gravar(101, 3001, 1001, { ...base, contexto: { ...base.contexto, idCiclo: 8001 } }, adapter), code('CICLO_DESATUALIZADO'));
        await assert.rejects(gravar(101, 3001, 1001, { ...base, contexto: { ...base.contexto, numeroTentativa: 2 } }, adapter), code('TENTATIVA_DESATUALIZADA'));
        const sealed = await leitura(102, 3101, 1001, c);
        await assert.rejects(gravar(102, 3101, 1001, payload(sealed), adapter), code('CONTEXTO_NAO_GRAVAVEL'));
        await assert.rejects(gravar(101, 3001, 1002, base, adapter), code('ACESSO_OPERACIONAL_NEGADO'));
        await assert.rejects(gravar(101, 3103, 1001, base, adapter), code('CONCORRENTE_AUSENTE'));
        await assert.rejects(gravar(101, 3104, 1001, base, adapter), code('CONTEXTO_NAO_GRAVAVEL'));
        const completed = await leitura(101, 3002, 1001, c);
        await assert.rejects(gravar(101, 3002, 1001, payload(completed), adapter), code('AVALIACAO_CONCLUIDA'));
        const foreign = await carregarCriteriosCiclo(contextC, c);
        await assert.rejects(gravar(101, 3001, 1001, payload(dto, [{ idCriterioCiclo: foreign[0].id_criterio_ciclo, nota: 50 }]), adapter), code('PAYLOAD_INVALIDO'));
    });
});
integration('G/D: reopening never implied; old-cycle write rejected and current C reads attempt separately', async () => {
    await isolatedWriter(async (c, adapter) => {
        const current = await leitura(103, 3102, 1001, c);
        const stale = payload(current);
        stale.contexto.idCiclo = contextC.id_ciclo_origem;
        await assert.rejects(gravar(103, 3102, 1001, stale, adapter), code('CICLO_DESATUALIZADO'));
        assert.equal((await resolverContextoJulgamento(103, c)).id_ciclo_atual, 8001);
        const [[count]] = await c.query('SELECT COUNT(*) AS n FROM ist_eventos_ciclos');
        assert.equal(count.n, 4);
    });
});
integration('G: nonuniform frozen weights, live criteria changes and full completion use server snapshot', async () => {
    await isolatedWriter(async (c, adapter) => {
        const criteria = await carregarCriteriosCiclo(contextA, c);
        for (let i = 0; i < criteria.length; i++)
            await c.query('UPDATE ist_eventos_ciclos_criterios SET peso=? WHERE id_criterio_ciclo=?',
                [[10, 20, 30, 40][i], criteria[i].id_criterio_ciclo]);
        await c.query("UPDATE ist_eventos_criterios_avaliacao SET nome=CONCAT('Live criterion ', id_criterio), ativo=0 WHERE id_evento=101");
        const dto = await leitura(101, 3001, 1001, c);
        assert(dto.criterios.every(k => !k.nome.startsWith('Live criterion ')));
        const notes = dto.criterios.map((k, i) => ({ idCriterioCiclo: k.idCriterioCiclo, nota: [20, 40, 60, 80][i] }));
        const written = await gravar(101, 3001, 1001, payload(dto, notes), adapter);
        assert.equal(written.avaliacao.media, '60.00');
        const finished = await gravar(101, 3001, 1001, { ...payload(written, notes), estado: 'concluida' }, adapter);
        assert.equal(finished.estado, 'concluida');
        assert.equal(finished.versao, dto.versao + 2);
        assert.equal(finished.avaliacao.media, '60.00');
        assert.ok(finished.avaliacao.dataConclusao);
        assert.equal(finished.podeGravar, false);
        assert.equal(finished.autorizacaoGravacao.code, 'AVALIACAO_CONCLUIDA');
        await assert.rejects(gravar(101, 3001, 1001, payload(finished, notes), adapter), code('AVALIACAO_CONCLUIDA'));
    });
});
integration('G: sealed B remains history despite live name/work/video updates in rollback scope', async () => {
    await isolatedWriter(async (c, adapter) => {
        const before = await leitura(102, 3101, 1001, c);
        await c.query('UPDATE ist_usuarios SET nome=? WHERE id_usuario=2101', ['Live renamed synthetic']);
        await c.query('UPDATE ist_composicao SET obra=? WHERE id_obra=5001', ['Live changed work']);
        await c.query('UPDATE ist_concorrentes SET link_video_1=? WHERE id_concorrente=3101',
            ['https://example.invalid/live-change']);
        const after = await leitura(102, 3101, 1001, c);
        assert.deepEqual(after, before);
        await assert.rejects(gravar(102, 3101, 1001, payload(after), adapter), code('CONTEXTO_NAO_GRAVAVEL'));
        const [[publication]] = await c.query('SELECT id_ciclo, versao FROM ist_eventos_publicacoes WHERE id_publicacao=7001');
        assert.equal(publication.id_ciclo, contextB.id_ciclo_atual);
        assert.equal(publication.versao, 1);
    });
});
integration('G: real FK prevents a note from pointing to another cycle criterion', async () => {
    await isolatedWriter(async (c) => {
        const foreignCriteria = await carregarCriteriosCiclo(contextC, c);
        await assert.rejects(c.query(`UPDATE ist_eventos_avaliacoes_notas SET id_criterio_ciclo=?
            WHERE id_avaliacao=6001`, [foreignCriteria[0].id_criterio_ciclo]),
        code('ER_NO_REFERENCED_ROW_2'));
        assert.equal((await leitura(101, 3001, 1001, c)).avaliacao.notas.length, 1);
    });
});

// Default production router and real middleware/services; only the application's pool
// is redirected to the identity-checked local database (or existing SAVEPOINT adapter).
async function httpHarness(t, { queries = pool, transactions = pool } = {}) {
    const secret = 'synthetic-maria-cutover-secret';
    const previous = { JWT_SECRET: process.env.JWT_SECRET, COOKIE_NAME: process.env.COOKIE_NAME };
    let router;
    try {
        process.env.JWT_SECRET = secret;
        process.env.COOKIE_NAME = 'maria_cutover_test';
        ({ default: router } = await import('../src/routes/jurado.routes.js'));
    } finally {
        for (const [key, value] of Object.entries(previous))
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    const oldQuery = applicationPool.query, oldConnection = applicationPool.getConnection;
    applicationPool.query = (sql, params) => queries.query(sql, params);
    applicationPool.getConnection = () => transactions.getConnection();
    const app = express();
    app.use(cookieParser());
    app.use(express.json());
    app.use('/api/jurado', router);
    const server = http.createServer(app);
    let closed = false;
    const close = async () => {
        if (closed) return;
        closed = true;
        try {
            await new Promise((resolve, reject) => {
                server.close(error => error ? reject(error) : resolve());
                server.closeAllConnections();
            });
        } finally {
            applicationPool.query = oldQuery;
            applicationPool.getConnection = oldConnection;
        }
    };
    t.after(close);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return { close, request: async (slug, participant, { user = 1001, body } = {}) => {
        const headers = user === null ? {} : {
            Cookie: `maria_cutover_test=${jwt.sign({ id_usuario: user, id_tipo_usuario: 4 }, secret)}`
        };
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api/jurado/eventos/${slug}/concorrentes/${participant}/avaliacao`, {
            headers, method: body === undefined ? 'GET' : 'PUT',
            body: body === undefined ? undefined : JSON.stringify(body)
        });
        return { status: response.status, body: await response.json() };
    } };
}
integration('HTTP GET: real default router reads A draft/completed, B sealed and C current cycle 2', async t => {
    const h = await httpHarness(t);
    try {
        for (const [slug, participant, estado, podeGravar, authorization, cycle] of [
            [slugA, 3001, 'rascunho', true, 'autorizada', contextA.id_ciclo_atual],
            [slugA, 3002, 'concluida', false, 'avaliacao_concluida', contextA.id_ciclo_atual],
            [slugB, 3101, 'pendente', false, 'ciclo_fechado', contextB.id_ciclo_atual],
            [slugC, 3102, 'pendente', true, 'autorizada', 8001]
        ]) {
            const r = await h.request(slug, participant);
            assert.equal(r.status, 200);
            assert.equal(r.body.estado, estado);
            assert.equal(r.body.podeGravar, podeGravar);
            assert.equal(r.body.autorizacaoGravacao.estado, authorization);
            assert.equal(r.body.contexto.idCiclo, cycle);
            if (slug === slugC) {
                assert.equal(r.body.contexto.numeroCiclo, 2);
                assert.equal(r.body.contexto.numeroTentativa, null);
                assert.equal(r.body.avaliacao, null);
                const before = await readonly(c => leitura(103, 3102, 1001, c));
                assert.deepEqual(r.body, before);
            }
        }
        assert.equal((await h.request(slugA, 3001, { user: null })).status, 401);
        assert.equal((await h.request(slugA, 3001, { user: 1002 })).status, 403);
        assert.equal((await h.request(slugA, 3103)).status, 404);
        assert.equal((await h.request(slugA, 3104)).status, 409);
        assert.equal((await h.request('missing-local-event', 3001)).status, 404);
    } finally { await h.close(); }
});
integration('HTTP PUT: real default router replaces draft notes and completes without reopening, inside rollback scope', async t => {
    await isolatedWriter(async (c, adapter) => {
        const initial = await leitura(101, 3001, 1001, c);
        const notes = initial.criterios.map((k, i) => ({ idCriterioCiclo: k.idCriterioCiclo, nota: [20, 40, 60, 80][i] }));
        const h = await httpHarness(t, { queries: c, transactions: adapter });
        try {
            const written = await h.request(slugA, 3001, { body: payload(initial, notes) });
            assert.equal(written.status, 200);
            assert.equal(written.body.versao, initial.versao + 1);
            assert.equal(written.body.avaliacao.media, '50.00');
            assert.equal(written.body.avaliacao.notas.length, 4);
            const replaced = await h.request(slugA, 3001, { body: payload(written.body, [notes[1]]) });
            assert.equal(replaced.status, 200);
            assert.equal(replaced.body.avaliacao.notas.length, 1);
            assert.equal(replaced.body.avaliacao.notas[0].idCriterioCiclo, notes[1].idCriterioCiclo);
            const finished = await h.request(slugA, 3001, {
                body: { ...payload(replaced.body, notes), estado: 'concluida' }
            });
            assert.equal(finished.status, 200);
            assert.equal(finished.body.podeGravar, false);
            assert.equal(finished.body.autorizacaoGravacao.estado, 'avaliacao_concluida');
            const rejected = await h.request(slugA, 3001, { body: payload(finished.body) });
            assert.equal(rejected.status, 409);
            assert.equal(rejected.body.code, 'AVALIACAO_CONCLUIDA');
            assert.deepEqual(await leitura(101, 3001, 1001, c), finished.body);
        } finally { await h.close(); }
    });
});
integration('HTTP PUT: stale tokens, B sealed, C reopening, revoked and excluded reject on real SQL with no residues', async t => {
    await isolatedWriter(async (c, adapter) => {
        const draft = await leitura(101, 3001, 1001, c), completed = await leitura(101, 3002, 1001, c);
        const sealed = await leitura(102, 3101, 1001, c), reopened = await leitura(103, 3102, 1001, c);
        const base = payload(draft);
        const h = await httpHarness(t, { queries: c, transactions: adapter });
        try {
            for (const [slug, id, body, status, expectedCode, user = 1001] of [
                [slugA, 3001, { ...base, contexto: { ...base.contexto, idCiclo: 8001 } }, 409, 'CICLO_DESATUALIZADO'],
                [slugA, 3001, { ...base, contexto: { ...base.contexto, numeroTentativa: 2 } }, 409, 'TENTATIVA_DESATUALIZADA'],
                [slugA, 3001, { ...base, versao: draft.versao + 1 }, 409, 'VERSAO_DESATUALIZADA'],
                [slugA, 3002, payload(completed), 409, 'AVALIACAO_CONCLUIDA'],
                [slugB, 3101, payload(sealed), 409, 'CONTEXTO_NAO_GRAVAVEL'],
                [slugC, 3102, { ...payload(reopened), contexto: { idCiclo: contextC.id_ciclo_origem, numeroTentativa: null } }, 409, 'CICLO_DESATUALIZADO'],
                [slugA, 3001, { ...base, notas: [{ idCriterioCiclo: reopened.criterios[0].idCriterioCiclo, nota: 50 }] }, 400, 'PAYLOAD_INVALIDO'],
                [slugA, 3103, base, 404, 'CONCORRENTE_AUSENTE'],
                [slugA, 3104, base, 409, 'CONTEXTO_NAO_GRAVAVEL'],
                [slugA, 3001, base, 403, null, 1002],
                [slugA, 3001, { versao: 1, estado: 'rascunho', notas: [{ idCriterio: 1, nota: 50 }] }, 400, 'PAYLOAD_INVALIDO']
            ]) {
                const r = await h.request(slug, id, { user, body });
                assert.equal(r.status, status);
                if (expectedCode) assert.equal(r.body.code, expectedCode);
            }
            assert.deepEqual(await snapshot(c), baseline);
        } finally { await h.close(); }
    });
});
integration('H: exact rows, historical publications and schema remain identical after writer rollbacks', async () => {
    await readonly(async c => {
        assert.deepEqual(await snapshot(c), baseline);
        const [[publications]] = await c.query('SELECT COUNT(*) AS n FROM ist_eventos_publicacoes');
        assert.equal(publications.n, 2);
        const [[notes]] = await c.query('SELECT COUNT(*) AS n FROM ist_eventos_avaliacoes_notas');
        assert.equal(notes.n, 5);
    });
});
