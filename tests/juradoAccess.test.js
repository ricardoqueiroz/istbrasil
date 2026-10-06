import assert from 'node:assert/strict';
import { once } from 'node:events';
import { after, before, beforeEach, test } from 'node:test';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import { pool as db } from '../src/config/db.js';
import juradoRoutes from '../src/routes/jurado.routes.js';
import adminRoutes from '../src/routes/admin.routes.js';
import { calcularMediaPonderada, validarPayloadAvaliacao } from '../src/services/juradoAvaliacaoService.js';
import { JuradoAvaliacaoError, salvarAvaliacaoJurado as salvarAvaliacaoServico } from '../src/services/juradoAvaliacaoService.js';

const queryOriginal = db.query;
const getConnectionOriginal = db.getConnection;
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
let criteriosAvaliacao;
let avaliacoes;
let notasAvaliacao;
let eventosTransacao;
let falhaTransacao;
let antesTransacao;
let proximoIdAvaliacao;
let snapshotsFila;
let consultasNavegacao;
let ciclosNavegacao;
let julgamentosNavegacao;
let publicacoesNavegacao;
const contextoNavegacao = (id = 1) => ({
    idCiclo: id * 100, numeroCiclo: 1, estadoCiclo: 'aberto', versaoJulgamento: 1
});
const respostaAusente = { status: 404, body: { code: 'CONCORRENTE_AUSENTE', message: 'Recurso indispon\u00edvel neste contexto.' } };
const respostaFalhaNavegacao = { message: 'N\u00e3o foi poss\u00edvel consultar a navega\u00e7\u00e3o do jurado.' };

// Fixtures congelados na primeira requisicao. Alteracoes live posteriores nao os recompoem.
const congelarFixturesNavegacao = () => {
    if (snapshotsFila) return;
    snapshotsFila = participacoes.filter(p => participacaoElegivel(p, p.id_evento)).map(p => ({
        id_ciclo_concorrente: p.id_concorrente + 1000, id_ciclo: p.id_evento * 100, id_evento: p.id_evento,
        id_concorrente: p.id_concorrente, id_usuario: p.id_usuario, numero_concorrente: p.numero_concorrente,
        nome_publico: usuariosFila.find(u => u.id_usuario === p.id_usuario).nome,
        id_obra_1: p.id_obra_1, obra_1_publica: composicoes.find(o => o.id_obra === p.id_obra_1).titulo
            ?? composicoes.find(o => o.id_obra === p.id_obra_1).obra,
        link_video_1: p.link_video_1, id_obra_2: p.id_obra_2,
        obra_2_publica: p.id_obra_2 === null ? null : (composicoes.find(o => o.id_obra === p.id_obra_2).titulo
            ?? composicoes.find(o => o.id_obra === p.id_obra_2).obra),
        link_video_2: p.link_video_2, fingerprint: 'a'.repeat(64), estado_participacao: 'incluido'
    }));
};
const consultarNavegacaoSimulada = async (sql, params) => {
    consultasNavegacao.push({ sql, params });
    assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|ALTER|FOR UPDATE)\b/);
    if (falharBanco) throw criarErroBanco('ER_SIMULADO');
    if (sql.startsWith('SELECT id, slug, nome') || sql.startsWith('SELECT e.id, e.slug, e.nome')) {
        const tamanho = consultas.length;
        try {
            const [rows] = await db.query(sql, params);
            return [rows.map(({ id, slug, nome }) => ({ id, slug, nome }))];
        }
        finally { consultas.length = tamanho; }
    }
    if (sql.includes('FROM ist_eventos_julgamentos')) return [julgamentosNavegacao.filter(j => j.id_evento === params[0])];
    if (sql.includes('FROM ist_eventos_ciclos WHERE')) return [ciclosNavegacao.filter(c => c.id_ciclo === params[0])];
    if (sql.includes('FROM ist_eventos_publicacoes p')) {
        return [publicacoesNavegacao.filter(p => p.id_publicacao === params[0]).map(p => {
            const c = ciclosNavegacao.find(ciclo => ciclo.id_ciclo === p.id_ciclo);
            return { ...p, ciclo_evento: c.id_evento, numero_ciclo: c.numero_ciclo,
                estado_ciclo: c.estado, ciclo_publicado_em: c.publicado_em };
        })];
    }
    if (sql.includes('FROM ist_eventos_publicacoes')) return [
        publicacoesNavegacao.filter(p => p.id_evento === params[0] && p.id_ciclo === params[1])
    ];
    if (sql.includes('FROM ist_eventos_ciclos_jurados')) return [[{
        id_ciclo: params[0], id_evento: ciclosNavegacao.find(c => c.id_ciclo === params[0]).id_evento, id_usuario: params[1],
        nome_publico: 'Jurado congelado', estado_participacao: 'incluido'
    }]];
    if (sql.includes('FROM ist_eventos_ciclos_concorrentes')) {
        if (sql.startsWith('SELECT COUNT')) {
            if (falharFila === 'count') throw criarErroBanco('ER_SIMULADO');
            assert.deepEqual(params.slice(1), [julgamentosNavegacao.find(j => j.id_evento === params[0]).id_ciclo_atual, 'incluido']);
            return [[{ total: snapshotsFila.filter(p => p.id_evento === params[0] && p.id_ciclo === params[1]
                && p.estado_participacao === params[2]).length }]];
        }
        if (sql.includes('LIMIT ? OFFSET ?')) {
            if (falharFila === 'select') throw criarErroBanco('ER_SIMULADO');
            const order = sql.match(/ORDER BY (numero_concorrente|nome_publico) (ASC|DESC), id_concorrente ASC/);
            assert.ok(order);
            assert.deepEqual(params.slice(1, 3), [julgamentosNavegacao.find(j => j.id_evento === params[0]).id_ciclo_atual, 'incluido']);
            const rows = snapshotsFila.filter(p => p.id_evento === params[0] && p.id_ciclo === params[1]
                && p.estado_participacao === params[2]);
            rows.sort((a, b) => String(a[order[1]]).localeCompare(String(b[order[1]])) * (order[2] === 'ASC' ? 1 : -1)
                || a.id_concorrente - b.id_concorrente);
            return [rows.slice(params[4], params[4] + params[3])];
        }
        if (falharFila === 'detalhe') throw criarErroBanco('ER_SIMULADO');
        return [snapshotsFila.filter(p => p.id_ciclo === params[0] && p.id_concorrente === params[1])];
    }
    throw new Error('Consulta cycle-aware nao simulada: ' + sql);
};

const participacaoElegivel = (participacao, idEvento) => participacao.id_evento === idEvento
    && participacao.aceite_regulamento === 1
    && typeof participacao.numero_concorrente === 'string' && participacao.numero_concorrente.trim()
    && participacao.id_obra_1 !== null
    && typeof participacao.link_video_1 === 'string' && participacao.link_video_1.trim()
    && usuariosFila.some((inscrito) => inscrito.id_usuario === participacao.id_usuario)
    && composicoes.some((obra) => obra.id_obra === participacao.id_obra_1);

const criarErroBanco = (code) => Object.assign(new Error('Falha SQL simulada'), { code });

const criarConexaoSimulada = () => {
    let snapshot;
    let navegacao = false;
    const restaurar = () => {
        if (snapshot) {
            avaliacoes = structuredClone(snapshot.avaliacoes);
            notasAvaliacao = structuredClone(snapshot.notas);
        }
    };
    return {
        async beginTransaction() {
            eventosTransacao.push('BEGIN');
            if (antesTransacao) antesTransacao();
            snapshot = { avaliacoes: structuredClone(avaliacoes), notas: structuredClone(notasAvaliacao) };
        },
        async commit() {
            eventosTransacao.push('COMMIT');
            if (falhaTransacao === 'commit') throw criarErroBanco('ER_SIMULADO');
        },
        async rollback() {
            eventosTransacao.push('ROLLBACK');
            if (falhaTransacao === 'rollback') throw criarErroBanco('ER_SIMULADO');
            restaurar();
        },
        release() { eventosTransacao.push('RELEASE'); },
        destroy() { eventosTransacao.push('DESTROY'); restaurar(); },
        async query(sql, params = []) {
            const consulta = sql.replace(/\s+/g, ' ').trim();
            if (consulta === 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ') {
                navegacao = true;
                congelarFixturesNavegacao();
                return [[], []];
            }
            if (navegacao && consulta.startsWith('START TRANSACTION')) return [[], []];
            if (navegacao) return consultarNavegacaoSimulada(consulta, params);
            eventosTransacao.push(consulta);
            assert.doesNotMatch(consulta, /ON DUPLICATE KEY|FROM ist_eventos WHERE.*FOR UPDATE|UPDATE ist_eventos_criterios|INSERT INTO ist_eventos_criterios/);
            if (falhaTransacao === 'rollback') throw criarErroBanco('ER_SIMULADO');
            if (consulta.startsWith('SELECT id_tipo_usuario, id_situacao, id_cargo')) {
                assert.match(consulta, /WHERE id_usuario = \? LOCK IN SHARE MODE$/);
                return [[usuario].filter((item) => item?.id_usuario === params[0])];
            }
            if (consulta.startsWith('SELECT ativo FROM ist_eventos_jurados')) {
                assert.match(consulta, /LOCK IN SHARE MODE$/);
                return [designacoes.filter((item) => item.id_evento === params[0] && item.id_usuario === params[1])];
            }
            if (consulta.startsWith('SELECT c.id_concorrente, c.numero_concorrente FROM ist_concorrentes c')) {
                assert.match(consulta, /c\.id_evento = \?.*c\.id_concorrente = \? LOCK IN SHARE MODE$/);
                assert.doesNotMatch(consulta, /JOIN|id_tipo_usuario|id_situacao/);
                return [participacoes.filter((item) => participacaoElegivel(item, params[0]) && item.id_concorrente === params[1])];
            }
            if (consulta.startsWith('SELECT id_criterio, nome, descricao, ordem, peso, ativo')) {
                assert.match(consulta, /WHERE id_evento = \? ORDER BY ordem, id_criterio LOCK IN SHARE MODE$/);
                return [criteriosAvaliacao.filter((item) => item.id_evento === params[0]).sort((primeiro, segundo) => primeiro.ordem - segundo.ordem)];
            }
            if (consulta.startsWith('SELECT id_avaliacao FROM ist_eventos_avaliacoes')) {
                assert.doesNotMatch(consulta, /FOR UPDATE|LOCK IN SHARE MODE/);
                return [avaliacoes.filter((item) => item.id_evento === params[0] && item.id_jurado === params[1] && item.id_concorrente === params[2]).map((item) => ({ id_avaliacao: item.id_avaliacao }))];
            }
            if (consulta.startsWith('SELECT id_avaliacao, id_evento, id_concorrente')) {
                assert.match(consulta, /WHERE id_avaliacao = \? AND id_evento = \? AND id_concorrente = \? AND id_jurado = \? FOR UPDATE$/);
                return [avaliacoes.filter((item) => item.id_avaliacao === params[0] && item.id_evento === params[1] && item.id_concorrente === params[2] && item.id_jurado === params[3])];
            }
            if (consulta.startsWith('INSERT INTO ist_eventos_avaliacoes ')) {
                assert.doesNotMatch(consulta, /media|ON DUPLICATE/);
                if (falhaTransacao === 'duplicate') throw criarErroBanco('ER_DUP_ENTRY');
                if (falhaTransacao === 'deadlock') throw criarErroBanco('ER_LOCK_DEADLOCK');
                if (falhaTransacao === 'timeout') throw criarErroBanco('ER_LOCK_WAIT_TIMEOUT');
                assert.match(consulta, /VALUES \(\?, \?, \?, \?, \?, \?, 1, CASE/);
                const avaliacao = criarAvaliacao({ id_avaliacao: proximoIdAvaliacao++, id_evento: params[0], id_concorrente: params[1], id_jurado: params[2], estado: params[3], possivel_desclassificacao: params[4], motivo_desclassificacao: params[5], data_conclusao: params[3] === 'concluida' ? '2026-10-03 12:00:00' : null });
                avaliacoes.push(avaliacao);
                if (falhaTransacao === 'header') throw criarErroBanco('ER_SIMULADO');
                return [{ insertId: avaliacao.id_avaliacao, affectedRows: 1 }];
            }
            if (consulta.startsWith('UPDATE ist_eventos_avaliacoes ')) {
                assert.doesNotMatch(consulta, /media/);
                assert.match(consulta, /estado = 'rascunho' AND versao = \?$/);
                const avaliacao = avaliacoes.find((item) => item.id_avaliacao === params[5] && item.id_evento === params[6] && item.id_jurado === params[7] && item.id_concorrente === params[8] && item.estado === 'rascunho' && item.versao === params[9]);
                if (!avaliacao) return [{ affectedRows: 0 }];
                Object.assign(avaliacao, { estado: params[0], possivel_desclassificacao: params[1], motivo_desclassificacao: params[2], versao: params[3], data_atualizacao: '2026-10-03 12:00:00', data_conclusao: params[4] === 'concluida' ? '2026-10-03 12:00:00' : null });
                return [{ affectedRows: 1 }];
            }
            if (consulta.startsWith('DELETE FROM ist_eventos_avaliacoes_notas')) {
                assert.equal(consulta, 'DELETE FROM ist_eventos_avaliacoes_notas WHERE id_avaliacao = ? AND id_evento = ?');
                notasAvaliacao = notasAvaliacao.filter((item) => item.id_avaliacao !== params[0] || item.id_evento !== params[1]);
                if (falhaTransacao === 'delete') throw criarErroBanco('ER_SIMULADO');
                return [{ affectedRows: 1 }];
            }
            if (consulta.startsWith('INSERT INTO ist_eventos_avaliacoes_notas')) {
                assert.doesNotMatch(consulta, /media|ON DUPLICATE/);
                assert.equal(params.length % 4, 0);
                const ids = [];
                for (let indice = 0; indice < params.length; indice += 4) {
                    notasAvaliacao.push({ id_avaliacao: params[indice], id_criterio: params[indice + 1], id_evento: params[indice + 2], nota: params[indice + 3] });
                    ids.push(params[indice + 1]);
                    if (falhaTransacao === 'notas') throw criarErroBanco('ER_SIMULADO');
                }
                assert.deepEqual(ids, [...ids].sort((primeiro, segundo) => primeiro - segundo));
                return [{ affectedRows: params.length / 4 }];
            }
            return db.query(sql, params);
        }
    };
};

before(async () => {
    db.getConnection = async () => criarConexaoSimulada();
    db.query = async (sql, params = []) => {
        const consulta = sql.replace(/\s+/g, ' ').trim();
        consultas.push({ sql: consulta, params });
        if (falharBanco) throw new Error('Falha simulada de SQL');

        if (consulta.startsWith('SELECT c.id_concorrente AS id_participacao')) {
            assert.equal(params.length, 3);
            assert.ok([10, 11].includes(params[0]));
            assert.match(consulta, /a\.id_evento = c\.id_evento AND a\.id_concorrente = c\.id_concorrente AND a\.id_jurado = \?/);
            assert.match(consulta, /n\.id_evento = c\.id_evento/);
            assert.match(consulta, /WHERE c\.id_evento = \?.*AND c\.id_concorrente = \? ORDER BY/);
            assert.match(consulta, /ORDER BY cr\.ordem, cr\.id_criterio$/);
            assert.doesNotMatch(consulta, /SELECT \*|u\.nome|cpf|email|telefone|curriculo|data_nascimento/);
            const participacao = participacoes.find((item) => participacaoElegivel(item, params[1]) && item.id_concorrente === params[2]);
            if (!participacao) return [[]];
            const avaliacao = avaliacoes.find((item) => item.id_jurado === params[0] && item.id_evento === params[1] && item.id_concorrente === params[2]);
            const notas = notasAvaliacao.filter((item) => item.id_avaliacao === avaliacao?.id_avaliacao);
            const criterios = criteriosAvaliacao.filter((item) => item.id_evento === params[1]);
            return [(criterios.length ? criterios : [{ id_criterio: null, nome: null, descricao: null, ordem: null, peso: null, ativo: null }]).map((criterio) => {
                const nota = notas.find((item) => item.id_criterio === criterio.id_criterio && item.id_evento === params[1]);
                return { ...criterio, ...(avaliacao || { id_avaliacao: null, estado: null, versao: null, possivel_desclassificacao: null, motivo_desclassificacao: null, data_inclusao: null, data_atualizacao: null, data_conclusao: null }), id_participacao: participacao.id_concorrente, numero_concorrente: participacao.numero_concorrente, id_criterio_nota: nota?.id_criterio ?? null, nota: nota?.nota ?? null, quantidade_notas: notas.length };
            })];
        }

        if (consulta === 'SELECT id, slug, nome FROM ist_eventos WHERE slug = ?') {
            return [eventos.filter((evento) => evento.slug === params[0])];
        }
        if (consulta.startsWith('SELECT e.id, e.slug, e.nome')) {
            assert.match(consulta, /INNER JOIN ist_eventos_jurados j ON j\.id_usuario = u\.id_usuario/);
            assert.match(consulta, /INNER JOIN ist_eventos e ON e\.id = j\.id_evento/);
            for (const campo of ['u.id_usuario', 'u.id_tipo_usuario', 'u.id_situacao', 'u.id_cargo', 'j.ativo']) {
                assert.ok(consulta.includes(`${campo} = ?`));
            }
            assert.deepEqual(params.slice(0, 5), [usuario?.id_usuario ?? 10, 4, 8, 11, 1]);
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
        const selectDetalhe = selectFila && consulta.endsWith('AND c.id_concorrente = ?');
        if (countFila || selectFila) {
            assert.match(consulta, /INNER JOIN ist_usuarios u ON u\.id_usuario = c\.id_usuario/);
            assert.match(consulta, /INNER JOIN ist_composicao obra1 ON obra1\.id_obra = c\.id_obra_1/);
            assert.match(consulta, /LEFT JOIN ist_composicao obra2 ON obra2\.id_obra = c\.id_obra_2/);
            for (const criterio of [
                'c.id_evento = ?', 'c.aceite_regulamento = 1',
                'c.numero_concorrente IS NOT NULL', "TRIM(c.numero_concorrente) <> ''",
                'c.id_obra_1 IS NOT NULL', 'c.link_video_1 IS NOT NULL', "TRIM(c.link_video_1) <> ''"
            ]) assert.ok(consulta.includes(criterio));
            assert.doesNotMatch(consulta, /SELECT \*|cpf|identidade|email|telefone|logradouro|data_nascimento|curriculo|senha|token|id_tipo_usuario|id_situacao|confirmacao_inscricao_enviada/);
            assert.equal(params.length, countFila ? 1 : selectDetalhe ? 2 : 3);
            if (falharFila === (countFila ? 'count' : selectDetalhe ? 'detalhe' : 'select')) throw new Error('Falha simulada de SQL na fila');

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
            const rows = elegiveis.map((participacao) => {
                const inscrito = usuariosFila.find((item) => item.id_usuario === participacao.id_usuario);
                const principal = composicoes.find((obra) => obra.id_obra === participacao.id_obra_1);
                const opcional = composicoes.find((obra) => obra.id_obra === participacao.id_obra_2);
                return {
                    ...inscrito, ...participacao,
                    titulo_obra_1: principal.titulo ?? principal.obra,
                    titulo_obra_2: opcional ? opcional.titulo ?? opcional.obra : null
                };
            });
            if (selectDetalhe) {
                assert.doesNotMatch(consulta, /COUNT\(|ORDER BY|LIMIT|OFFSET/);
                return [rows.filter((row) => row.id_concorrente === params[1])];
            }
            const count = consultas.find(({ sql: sqlCount }) => sqlCount.startsWith('SELECT COUNT(*) AS total FROM ist_concorrentes c'));
            assert.equal(count.sql.slice(count.sql.indexOf('FROM ist_concorrentes')),
                consulta.slice(consulta.indexOf('FROM ist_concorrentes')).split(' ORDER BY ')[0]);
            const ordenacao = consulta.match(/ORDER BY (c\.numero_concorrente|c\.data_cadastro|u\.nome) (ASC|DESC), c\.id_concorrente ASC LIMIT \? OFFSET \?$/);
            assert.ok(ordenacao);
            const campo = ordenacao[1].split('.')[1];
            const direcao = ordenacao[2] === 'ASC' ? 1 : -1;
            rows.sort((primeira, segunda) => String(primeira[campo]).localeCompare(String(segunda[campo])) * direcao
                || primeira.id_concorrente - segunda.id_concorrente);
            return [rows.slice(params[2], params[2] + params[1])];
        }
        throw new Error(`Consulta não simulada: ${consulta}`);
    };

    const app = express();
    app.use(cookieParser());
    app.use(express.json());
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
    consultasNavegacao = [];
    snapshotsFila = null;
    ciclosNavegacao = eventos.map(e => ({
        id_ciclo: e.id * 100, id_evento: e.id, numero_ciclo: 1, estado: 'aberto',
        id_ciclo_origem: null, id_publicacao_origem: null, publicado_em: null, motivo_reabertura: null
    }));
    julgamentosNavegacao = eventos.map(e => ({
        id_evento: e.id, id_ciclo_atual: e.id * 100, id_publicacao_vigente: null,
        quantidade_classificados: null, versao: 1
    }));
    publicacoesNavegacao = [];
    falharBanco = false;
    participacoes = [criarParticipacao()];
    usuariosFila = [{
        id_usuario: 20, id_tipo_usuario: 3, id_situacao: 99,
        nome: 'Concorrente Teste', cidade: null, uf: null,
        cpf: 'dado-privado', identidade: 'dado-privado', email: 'privado@example.com',
        telefone_celular: 'dado-privado', logradouro: 'dado-privado', senha: 'dado-privado', token_confirmacao: 'dado-privado',
        data_nascimento: 'dado-privado', curriculo: 'dado-privado'
    }];
    composicoes = [
        { id_obra: 22, titulo: null, obra: 'Obra Principal' },
        { id_obra: 40, titulo: 'Obra Opcional', obra: 'Nome Original' }
    ];
    falharFila = null;
    criteriosAvaliacao = [104, 101, 103, 102].map((id_criterio) => ({ id_criterio, id_evento: 1, nome: `Criterio ${id_criterio}`, descricao: null, ordem: id_criterio - 100, peso: '25.00', ativo: 1 }));
    avaliacoes = [];
    notasAvaliacao = [];
    eventosTransacao = [];
    falhaTransacao = null;
    antesTransacao = null;
    proximoIdAvaliacao = 500;
});

after(async () => {
    db.query = queryOriginal;
    db.getConnection = getConnectionOriginal;
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

const requisitar = async (path, sessao = token, opcoes = {}) => {
    const headers = { ...(sessao === null ? {} : { Cookie: `${cookieName}=${sessao}` }), ...(opcoes.method ? { 'Content-Type': 'application/json' } : {}) };
    const response = await fetch(`${baseUrl}${path}`, { ...opcoes, headers });
    return { status: response.status, body: await response.json() };
};

const criarAvaliacao = (campos = {}) => ({ id_avaliacao: 500, id_evento: 1, id_concorrente: 17, id_jurado: 10, estado: 'rascunho', versao: 1, possivel_desclassificacao: 0, motivo_desclassificacao: null, data_inclusao: '2026-10-03 11:00:00', data_atualizacao: '2026-10-03 11:00:00', data_conclusao: null, ...campos });
const payloadAvaliacao = (campos = {}) => ({ versao: 0, estado: 'rascunho', notas: [], possivelDesclassificacao: false, motivoDesclassificacao: null, ...campos });
const notasCompletas = (nota = 80) => [104, 101, 103, 102].map((idCriterio) => ({ idCriterio, nota }));

const criarParticipacao = (campos = {}) => ({
    id_concorrente: 17, id_usuario: 20, id_evento: 1,
    numero_concorrente: 'FVST2-001', id_obra_1: 22,
    link_video_1: 'https://youtu.be/abcdefghijk', id_obra_2: null, link_video_2: null,
    aceite_regulamento: 1, confirmacao_inscricao_enviada: 0,
    data_cadastro: '2026-10-02T12:00:00.000Z', ...campos
});

const caminhoFila = '/api/jurado/eventos/festival-teste/concorrentes';
const caminhoDetalhe = `${caminhoFila}/17`;
const caminhoAvaliacao = `${caminhoDetalhe}/avaliacao`;
const gravarAvaliacao = (payload, sessao = token, path = caminhoAvaliacao) => requisitar(path, sessao, { method: 'PUT', body: JSON.stringify(payload) });

for (const path of ['/api/jurado/acessos', '/api/jurado/eventos/festival-teste', caminhoFila, caminhoDetalhe]) {
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
        body: { eventos: [{ id: 1, slug: 'festival-teste', nome: 'Festival Teste', contexto: contextoNavegacao() }] }
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
        body: { evento: { id: 1, slug: 'festival-teste', nome: 'Festival Teste' }, contexto: contextoNavegacao() }
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

for (const path of ['/api/jurado/acessos', '/api/jurado/eventos/festival-teste', caminhoFila, caminhoDetalhe]) {
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
            contexto: contextoNavegacao(),
            concorrentes: [{
                idParticipacao: 17, idSnapshot: 1017, numeroConcorrente: 'FVST2-001', nome: 'Concorrente Teste',
                obraPrincipal: { id: 22, titulo: 'Obra Principal' },
                linkVideoPrincipal: 'https://youtu.be/abcdefghijk', obraOpcional: null, linkVideoOpcional: null
            }],
            pagination: { page: 1, limit: 25, total: 1, totalPages: 1 }
        }
    });
    assert.deepEqual(consultasNavegacao.find(q => q.sql.startsWith('SELECT COUNT')).params, [1, 100, 'incluido']);
    assert.deepEqual(consultasNavegacao.find(q => q.sql.includes('LIMIT ? OFFSET ?')).params, [1, 100, 'incluido', 25, 0]);
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
    assert.deepEqual(consultasNavegacao.findLast(q => q.sql.startsWith('SELECT COUNT')).params, [2, 200, 'incluido']);
    assert.deepEqual(consultasNavegacao.findLast(q => q.sql.includes('LIMIT ? OFFSET ?')).params, [2, 200, 'incluido', 25, 0]);
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
        assert.equal(resposta.body.concorrentes[0].cidade, undefined);
        assert.equal(resposta.body.concorrentes[0].uf, undefined);
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
    assert.deepEqual(consultasNavegacao.find(q => q.sql.includes('LIMIT ? OFFSET ?')).params, [1, 100, 'incluido', 2, 2]);
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
    { sort: 'numeroConcorrente', coluna: 'numero_concorrente', idsAsc: [17, 18, 19] },
    { sort: 'nome', coluna: 'nome_publico', idsAsc: [19, 18, 17] }
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
            const consultaFila = consultasNavegacao.find(({ sql }) => sql.includes('LIMIT ? OFFSET ?'));
            assert.ok(consultaFila.sql.includes(`ORDER BY ${coluna} ${order.toUpperCase()}, id_concorrente ASC`));
        });

        test(`fila: empate de ${sort} usa idParticipacao ASC com order ${order}`, async () => {
            participacoes = [19, 17, 18].map((id) => criarParticipacao({ id_concorrente: id }));
            const resposta = await requisitar(`${caminhoFila}?sort=${sort}&order=${order}`);
            assert.equal(resposta.status, 200);
            assert.deepEqual(resposta.body.concorrentes.map((item) => item.idParticipacao), [17, 18, 19]);
            const consultaFila = consultasNavegacao.find(({ sql }) => sql.includes('LIMIT ? OFFSET ?'));
            assert.ok(consultaFila.sql.includes(`ORDER BY ${coluna} ${order.toUpperCase()}, id_concorrente ASC`));
        });
    }
}

for (const query of ['sort=dataInscricao', 'sort=cpf', 'sort=__proto__', 'sort=nome%3BDROP%20TABLE%20ist_usuarios', 'sort=nome&sort=dataInscricao', 'order=invalid', 'order=desc%3BDROP', 'order=asc&order=desc']) {
    test(`fila: rejeita ordenacao arbitraria ${query}`, async () => {
        assert.equal((await requisitar(`${caminhoFila}?${query}`)).status, 400);
        assert.equal(consultas.length, 2);
    });
}

test('fila: nao implementa busca ou filtro por atributos do inscrito', async () => {
    const resposta = await requisitar(`${caminhoFila}?search=nao-corresponde&idTipoUsuario=2&idSituacao=8`);
    assert.equal(resposta.status, 200);
    assert.equal(resposta.body.pagination.total, 1);
    assert.deepEqual(consultasNavegacao.find(q => q.sql.startsWith('SELECT COUNT')).params, [1, 100, 'incluido']);
});

for (const etapa of ['count', 'select']) {
    test(`fila: falha de ${etapa} retorna 500 neutro`, async () => {
        falharFila = etapa;
        const consoleErrorOriginal = console.error;
        console.error = () => {};
        try {
            const resposta = await requisitar(caminhoFila);
            assert.equal(resposta.status, 500);
            assert.deepEqual(resposta.body, respostaFalhaNavegacao);
            assert.doesNotMatch(JSON.stringify(resposta.body), /SQL|stack|Falha simulada/);
        } finally {
            console.error = consoleErrorOriginal;
        }
    });
}

test('detalhe: autorizado recebe somente o mesmo contrato publico da fila', async () => {
    const fila = await requisitar(caminhoFila);
    consultas = [];
    const detalhe = await requisitar(caminhoDetalhe);
    assert.equal(detalhe.status, 200);
    assert.deepEqual(detalhe.body, { evento: fila.body.evento, contexto: fila.body.contexto, concorrente: fila.body.concorrentes[0] });
    assert.equal(consultas.length, 2);
    assert.deepEqual(consultasNavegacao.at(-1).params, [100, 17]);
    assert.match(consultasNavegacao.at(-1).sql, /FROM ist_eventos_ciclos_concorrentes/);
    assert.doesNotMatch(JSON.stringify(detalhe.body), /dado-privado|cpf|identidade|email|telefone|logradouro|senha|token|curriculo|data_nascimento/);
});

for (const id of ['0', '-1', 'abc', '1.5', '1e2', '9007199254740992', '17%20OR%201=1']) {
    test(`detalhe: ID ${id} invalido retorna 400 sem consulta individual`, async () => {
        assert.equal((await requisitar(`${caminhoFila}/${id}`)).status, 400);
        assert.equal(consultas.length, 2);
    });
}

test('detalhe: inexistente e de outro evento retornam exatamente o mesmo 404', async () => {
    const inexistente = await requisitar(`${caminhoFila}/99`);
    assert.deepEqual(inexistente, respostaAusente);
    assert.equal(consultas.length, 2);
    participacoes.push(criarParticipacao({ id_concorrente: 28, id_evento: 2 }));
    consultas = [];
    assert.deepEqual(await requisitar(`${caminhoFila}/28?id_evento=2`), inexistente);
    assert.equal(consultas.length, 2);
    assert.deepEqual(consultasNavegacao.at(-1).params, [100, 28]);
});

test('detalhe: evento do slug autorizado governa a consulta mesmo com query forjada', async () => {
    designacoes.push({ id_evento: 2, id_usuario: 10, ativo: 1 });
    participacoes.push(criarParticipacao({ id_concorrente: 28, id_evento: 2 }));
    const resposta = await requisitar('/api/jurado/eventos/outro-evento/concorrentes/28?id_evento=1');
    assert.equal(resposta.status, 200);
    assert.equal(resposta.body.evento.id, 2);
    assert.equal(resposta.body.concorrente.idParticipacao, 28);
    assert.deepEqual(consultasNavegacao.at(-1).params, [200, 28]);
});

for (const [campo, valor] of [
    ['aceite_regulamento', 0], ['numero_concorrente', null], ['numero_concorrente', ''],
    ['numero_concorrente', '   '], ['id_obra_1', null], ['link_video_1', null],
    ['link_video_1', ''], ['link_video_1', '   ']
]) {
    test(`detalhe: ${campo}=${JSON.stringify(valor)} retorna 404 uniforme`, async () => {
        participacoes[0][campo] = valor;
        assert.deepEqual(await requisitar(caminhoDetalhe), respostaAusente);
        assert.equal(consultas.length, 2);
    });
}

test('detalhe: nao exige tipo/situacao do concorrente, email enviado ou video opcional', async () => {
    usuariosFila[0].id_tipo_usuario = 1;
    usuariosFila[0].id_situacao = null;
    participacoes[0].id_obra_2 = 40;
    composicoes[1].titulo = null;
    const resposta = await requisitar(caminhoDetalhe);
    assert.equal(resposta.status, 200);
    assert.deepEqual(resposta.body.concorrente.obraPrincipal, { id: 22, titulo: 'Obra Principal' });
    assert.deepEqual(resposta.body.concorrente.obraOpcional, { id: 40, titulo: 'Nome Original' });
    assert.equal(resposta.body.concorrente.linkVideoOpcional, null);
});

test('detalhe: evento inexistente e recusado antes da consulta individual', async () => {
    assert.equal((await requisitar('/api/jurado/eventos/inexistente/concorrentes/17')).status, 404);
    assert.equal(consultas.length, 1);
});

for (const estado of ['ausente', 'inativa', 'tipo', 'situacao', 'cargo']) {
    test(`detalhe: cadeia rejeita autorizacao ${estado}`, async () => {
        if (estado === 'ausente') designacoes = [];
        else if (estado === 'inativa') designacoes[0].ativo = 0;
        else usuario[{ tipo: 'id_tipo_usuario', situacao: 'id_situacao', cargo: 'id_cargo' }[estado]] = 99;
        assert.equal((await requisitar(caminhoDetalhe)).status, 403);
        assert.equal(consultas.length, 2);
    });
}

test('detalhe: falha do lookup retorna 500 sem expor SQL', async () => {
    falharFila = 'detalhe';
    const consoleErrorOriginal = console.error;
    console.error = () => {};
    try {
        const resposta = await requisitar(caminhoDetalhe);
        assert.deepEqual(resposta, { status: 500, body: respostaFalhaNavegacao });
    } finally {
        console.error = consoleErrorOriginal;
    }
});

test('navegacao real: mudancas live de material e membership nao alteram fila/detalhe congelados', async () => {
    const antes = await requisitar(caminhoFila);
    const snapshotsAntes = structuredClone(snapshotsFila);
    participacoes[0].aceite_regulamento = 0;
    participacoes[0].link_video_1 = 'https://example.invalid/changed-live';
    usuariosFila[0].nome = 'Nome live alterado';
    composicoes[0].titulo = 'Obra live alterada';
    participacoes.push(criarParticipacao({ id_concorrente: 99 }));
    assert.deepEqual(await requisitar(caminhoFila), antes);
    assert.deepEqual((await requisitar(caminhoDetalhe)).body.concorrente, antes.body.concorrentes[0]);
    assert.deepEqual(await requisitar(`${caminhoFila}/99`), respostaAusente);
    assert.deepEqual(snapshotsFila, snapshotsAntes);
    assert(consultasNavegacao.every(q => !/\bFROM ist_concorrentes\b|\bJOIN ist_composicao\b/.test(q.sql)));
});

test('navegacao real: reabertura usa ciclo atual 2 e preserva material/publicacao do ciclo 1', async () => {
    await requisitar(caminhoFila);
    const historico = structuredClone(snapshotsFila);
    const primeiro = ciclosNavegacao[0];
    primeiro.estado = 'selado';
    primeiro.publicado_em = '2026-10-06 12:00:00';
    publicacoesNavegacao.push({
        id_publicacao: 7001, id_evento: 1, id_ciclo: 100, versao: 1, publicado_em: primeiro.publicado_em
    });
    const publicacaoAntes = structuredClone(publicacoesNavegacao);
    ciclosNavegacao.push({
        id_ciclo: 101, id_evento: 1, numero_ciclo: 2, estado: 'aberto',
        id_ciclo_origem: 100, id_publicacao_origem: 7001, publicado_em: null, motivo_reabertura: 'Fixture formal'
    });
    julgamentosNavegacao[0].id_ciclo_atual = 101;
    julgamentosNavegacao[0].id_publicacao_vigente = 7001;
    julgamentosNavegacao[0].versao = 2;
    snapshotsFila.push({ ...historico[0], id_ciclo: 101, id_ciclo_concorrente: 2017, nome_publico: 'Snapshot ciclo 2' });
    const fila = await requisitar(`${caminhoFila}?idCiclo=100`);
    const detalhe = await requisitar(caminhoDetalhe);
    assert.deepEqual(fila.body.contexto, { idCiclo: 101, numeroCiclo: 2, estadoCiclo: 'aberto', versaoJulgamento: 2 });
    assert.equal(fila.body.concorrentes[0].nome, 'Snapshot ciclo 2');
    assert.equal(detalhe.body.concorrente.idSnapshot, 2017);
    assert.deepEqual(snapshotsFila.filter(p => p.id_ciclo === 100), historico);
    assert.deepEqual(publicacoesNavegacao, publicacaoAntes);
});

test('navegacao real: snapshot inelegivel nao recebe material nem ganha membership por elegibilidade live', async () => {
    const fila = await requisitar(caminhoFila);
    participacoes.push(criarParticipacao({ id_concorrente: 99 }));
    snapshotsFila.push({ ...snapshotsFila[0], id_ciclo_concorrente: 1099, id_concorrente: 99,
        estado_participacao: 'inelegivel', id_obra_1: null, link_video_1: null });
    const antes = structuredClone(snapshotsFila);
    assert.deepEqual(await requisitar(caminhoFila), fila);
    assert.deepEqual(await requisitar(`${caminhoFila}/99`), respostaAusente);
    designacoes[0].ativo = 0;
    assert.equal((await requisitar(caminhoDetalhe)).status, 403);
    assert.deepEqual(snapshotsFila, antes);
});

const assertSemEscrita = () => assert.equal(eventosTransacao.filter((sql) => /^(INSERT|UPDATE|DELETE)\b/.test(sql)).length, 0);

test('avaliacao GET: pendente tem contrato exato, criterios ordenados e nenhuma escrita', async () => {
    const resposta = await requisitar(caminhoAvaliacao);
    assert.equal(resposta.status, 200);
    assert.deepEqual(resposta.body, {
        evento: { id: 1, slug: 'festival-teste', nome: 'Festival Teste' },
        concorrente: { idParticipacao: 17, numeroConcorrente: 'FVST2-001' },
        estado: 'pendente', versao: 0, escala: { min: 0, max: 100, passo: 1 },
        criterios: [101, 102, 103, 104].map((idCriterio) => ({ idCriterio, nome: `Criterio ${idCriterio}`, descricao: null, ordem: idCriterio - 100, peso: '25.00' })),
        avaliacao: null
    });
    assert.equal(consultas.length, 3);
    assert.deepEqual(consultas[2].params, [10, 1, 17]);
    assert.deepEqual(avaliacoes, []);
    assert.deepEqual(eventosTransacao, []);
});

for (const [estado, completa, media] of [['rascunho', false, null], ['rascunho', true, '80.00'], ['concluida', true, '80.00']]) {
    test(`avaliacao GET: ${estado} ${completa ? 'completa' : 'parcial'} retorna media ${media}`, async () => {
        avaliacoes = [criarAvaliacao({ estado, data_conclusao: estado === 'concluida' ? '2026-10-03 12:00:00' : null })];
        notasAvaliacao = (completa ? [101, 102, 103, 104] : [101]).map((id_criterio) => ({ id_avaliacao: 500, id_evento: 1, id_criterio, nota: 80 }));
        const resposta = await requisitar(caminhoAvaliacao);
        assert.equal(resposta.status, 200);
        assert.equal(resposta.body.estado, estado);
        assert.equal(resposta.body.versao, 1);
        assert.equal(resposta.body.avaliacao.media, media);
        assert.equal(resposta.body.avaliacao.notas.length, completa ? 4 : 1);
        assert.equal(resposta.body.avaliacao.idAvaliacao, 500);
        assert.deepEqual(Object.keys(resposta.body.avaliacao).sort(), ['idAvaliacao', 'notas', 'possivelDesclassificacao', 'motivoDesclassificacao', 'media', 'dataInclusao', 'dataAtualizacao', 'dataConclusao'].sort());
        assert.doesNotMatch(JSON.stringify(resposta.body), /cpf|email|telefone|curriculo|dado-privado|linkVideo|obraPrincipal/);
        assert.deepEqual(eventosTransacao, []);
    });
}

test('avaliacao GET: isolamento de evento, jurado e query forjada', async () => {
    avaliacoes = [criarAvaliacao({ id_avaliacao: 501, id_jurado: 11 })];
    notasAvaliacao = [{ id_avaliacao: 501, id_criterio: 101, id_evento: 1, nota: 90 }];
    const primeiro = await requisitar(`${caminhoAvaliacao}?id_jurado=11&id_evento=2`);
    assert.equal(primeiro.body.avaliacao, null);
    usuario.id_usuario = 11;
    designacoes = [{ id_evento: 1, id_usuario: 11, ativo: 1 }];
    const outroToken = jwt.sign({ id_usuario: 11, id_tipo_usuario: 4 }, jwtSecret, { expiresIn: '5m' });
    const segundo = await requisitar(caminhoAvaliacao, outroToken);
    assert.equal(segundo.body.avaliacao.idAvaliacao, 501);
    assert.deepEqual(segundo.body.avaliacao.notas, [{ idCriterio: 101, nota: 90 }]);
});

for (const estado of ['inexistente', 'outro-evento', 'inelegivel']) {
    test(`avaliacao GET/PUT: participacao ${estado} retorna mesmo 404 sem escrita`, async () => {
        if (estado === 'inexistente') participacoes = [];
        if (estado === 'outro-evento') participacoes[0].id_evento = 2;
        if (estado === 'inelegivel') participacoes[0].aceite_regulamento = 0;
        const esperado = { status: 404, body: { message: 'Concorrente indispon\u00edvel.' } };
        assert.deepEqual(await requisitar(caminhoAvaliacao), esperado);
        assert.deepEqual(await gravarAvaliacao(payloadAvaliacao()), esperado);
        assertSemEscrita();
        assert.ok(eventosTransacao.includes('ROLLBACK'));
    });
}

for (const valor of ['0', '-1', 'abc', '1.5']) {
    test(`avaliacao GET/PUT: PK ${valor} invalida retorna 400`, async () => {
        const path = `${caminhoFila}/${valor}/avaliacao`;
        assert.equal((await requisitar(path)).status, 400);
        assert.equal((await gravarAvaliacao(payloadAvaliacao(), token, path)).status, 400);
        assert.deepEqual(eventosTransacao, []);
    });
}

for (const metodo of ['GET', 'PUT']) {
    test(`avaliacao ${metodo}: sem sessao passa pela cadeia antes do banco`, async () => {
        const resposta = metodo === 'GET' ? await requisitar(caminhoAvaliacao, null) : await gravarAvaliacao(payloadAvaliacao(), null);
        assert.equal(resposta.status, 401);
        assert.deepEqual(consultas, []);
        assert.deepEqual(eventosTransacao, []);
    });
}

for (const caso of ['sem-ativos', 'peso-zero', 'peso-negativo', 'peso-acima', 'peso-invalido', 'peso-numero', 'soma-menor', 'soma-maior']) {
    test(`avaliacao GET/PUT: configuracao ${caso} retorna 409 neutro e nao persiste`, async () => {
        if (caso === 'sem-ativos') criteriosAvaliacao.forEach((item) => { item.ativo = 0; });
        else criteriosAvaliacao[0].peso = { 'peso-zero': '0.00', 'peso-negativo': '-1.00', 'peso-acima': '100.01', 'peso-invalido': 'NaN', 'peso-numero': 25, 'soma-menor': '24.99', 'soma-maior': '25.01' }[caso];
        const esperado = { status: 409, body: { message: 'Configura\u00e7\u00e3o de avalia\u00e7\u00e3o indispon\u00edvel' } };
        assert.deepEqual(await requisitar(caminhoAvaliacao), esperado);
        assert.deepEqual(await gravarAvaliacao(payloadAvaliacao()), esperado);
        assertSemEscrita();
        assert.deepEqual(avaliacoes, []);
    });
}

for (const caso of ['inativo', 'inexistente', 'outro-evento', 'nota-invalida', 'concluida-incompleta']) {
    test(`avaliacao GET: notas persistidas ${caso} nao sao mascaradas`, async () => {
        avaliacoes = [criarAvaliacao()];
        notasAvaliacao = [{ id_avaliacao: 500, id_evento: 1, id_criterio: 101, nota: 80 }];
        if (caso === 'inativo') {
            criteriosAvaliacao.find((item) => item.id_criterio === 101).ativo = 0;
            criteriosAvaliacao.find((item) => item.id_criterio === 102).peso = '50.00';
        }
        if (caso === 'inexistente') notasAvaliacao[0].id_criterio = 999;
        if (caso === 'outro-evento') notasAvaliacao[0].id_evento = 2;
        if (caso === 'nota-invalida') notasAvaliacao[0].nota = 101;
        if (caso === 'concluida-incompleta') { avaliacoes[0].estado = 'concluida'; avaliacoes[0].data_conclusao = '2026-10-03'; }
        assert.equal((await requisitar(caminhoAvaliacao)).status, 409);
    });
}

test('avaliacao PUT: primeira criacao vazia, locks minimos e versao inicial 1', async () => {
    const resposta = await gravarAvaliacao(payloadAvaliacao());
    assert.equal(resposta.status, 200);
    assert.equal(resposta.body.estado, 'rascunho');
    assert.equal(resposta.body.versao, 1);
    assert.deepEqual(resposta.body.avaliacao.notas, []);
    assert.equal(resposta.body.avaliacao.media, null);
    assert.equal(resposta.body.avaliacao.dataConclusao, null);
    assert.equal(avaliacoes.length, 1);
    assert.equal(notasAvaliacao.length, 0);
    assert.deepEqual(eventosTransacao.filter((sql) => sql.endsWith('LOCK IN SHARE MODE')).map((sql) => sql.match(/FROM (\w+)/)[1]), ['ist_usuarios', 'ist_eventos_jurados', 'ist_concorrentes', 'ist_eventos_criterios_avaliacao']);
    assert.ok(eventosTransacao.indexOf('COMMIT') < eventosTransacao.indexOf('RELEASE'));
    assert.doesNotMatch(eventosTransacao.join('\n'), /UPDATE ist_eventos_avaliacoes SET|FOR UPDATE.*ist_eventos\b|ON DUPLICATE|media/);
});

test('avaliacao PUT: versao correta incrementa uma vez, inclusive payload identico', async () => {
    assert.equal((await gravarAvaliacao(payloadAvaliacao())).body.versao, 1);
    assert.equal((await gravarAvaliacao(payloadAvaliacao({ versao: 1 }))).body.versao, 2);
    assert.equal(avaliacoes[0].versao, 2);
    const snapshot = structuredClone(avaliacoes);
    eventosTransacao = [];
    assert.equal((await gravarAvaliacao(payloadAvaliacao({ versao: 1 }))).status, 409);
    assert.deepEqual(avaliacoes, snapshot);
    assertSemEscrita();
});

test('avaliacao PUT: primeiro save exige versao zero', async () => {
    assert.equal((await gravarAvaliacao(payloadAvaliacao({ versao: 1 }))).status, 409);
    assertSemEscrita();
    assert.deepEqual(avaliacoes, []);
});

test('avaliacao PUT: substitui notas anteriores e aceita rascunho parcial e completo', async () => {
    const primeiro = await gravarAvaliacao(payloadAvaliacao({ notas: notasCompletas() }));
    assert.equal(primeiro.status, 200);
    assert.equal(primeiro.body.avaliacao.media, '80.00');
    const parcial = await gravarAvaliacao(payloadAvaliacao({ versao: 1, notas: [{ idCriterio: 103, nota: 0 }] }));
    assert.equal(parcial.body.versao, 2);
    assert.deepEqual(parcial.body.avaliacao.notas, [{ idCriterio: 103, nota: 0 }]);
    assert.equal(parcial.body.avaliacao.media, null);
    assert.equal(notasAvaliacao.length, 1);
    const vazio = await gravarAvaliacao(payloadAvaliacao({ versao: 2 }));
    assert.equal(vazio.body.versao, 3);
    assert.deepEqual(notasAvaliacao, []);
});

test('avaliacao PUT: conclui somente com todas as notas, data e media derivadas', async () => {
    const resposta = await gravarAvaliacao(payloadAvaliacao({ estado: 'concluida', notas: notasCompletas(100) }));
    assert.equal(resposta.status, 200);
    assert.equal(resposta.body.estado, 'concluida');
    assert.equal(resposta.body.versao, 1);
    assert.equal(resposta.body.avaliacao.media, '100.00');
    assert.ok(resposta.body.avaliacao.dataConclusao);
    assert.equal(Object.prototype.hasOwnProperty.call(avaliacoes[0], 'media'), false);
});

for (const caso of ['identico', 'diferente', 'stale', 'payload-invalido']) {
    test(`avaliacao PUT: concluida rejeita ${caso} antes da versao ou validacao`, async () => {
        avaliacoes = [criarAvaliacao({ estado: 'concluida', versao: 3, data_conclusao: '2026-10-03' })];
        const payload = caso === 'payload-invalido' ? {} : payloadAvaliacao({ versao: caso === 'stale' ? 0 : 3, estado: caso === 'identico' ? 'concluida' : 'rascunho', notas: notasCompletas() });
        const resposta = await gravarAvaliacao(payload);
        assert.deepEqual(resposta, { status: 409, body: { message: 'Avalia\u00e7\u00e3o conclu\u00edda n\u00e3o pode ser alterada.' } });
        assertSemEscrita();
        assert.equal(avaliacoes[0].versao, 3);
    });
}

test('avaliacao PUT: protege overflow de INT UNSIGNED', async () => {
    avaliacoes = [criarAvaliacao({ versao: 4294967295 })];
    assert.equal((await gravarAvaliacao(payloadAvaliacao({ versao: 4294967295 }))).status, 409);
    assertSemEscrita();
    assert.equal(avaliacoes[0].versao, 4294967295);
});

for (const nota of [-1, 101, 80.5, '80', null, true]) {
    test(`avaliacao PUT: rejeita nota ${JSON.stringify(nota)} sem coercao ou escrita`, async () => {
        assert.equal((await gravarAvaliacao(payloadAvaliacao({ notas: [{ idCriterio: 101, nota }] }))).status, 400);
        assertSemEscrita();
    });
}

for (const caso of ['duplicado', 'inexistente', 'outro-evento', 'inativo', 'id-string', 'campo-extra', 'conclusao-incompleta']) {
    test(`avaliacao PUT: notas ${caso} invalidas retornam 400`, async () => {
        let notas = [{ idCriterio: 101, nota: 80 }];
        if (caso === 'duplicado') notas.push({ idCriterio: 101, nota: 90 });
        if (caso === 'inexistente') notas[0].idCriterio = 999;
        if (caso === 'outro-evento') { criteriosAvaliacao.push({ id_criterio: 202, id_evento: 2, nome: 'Outro', descricao: null, ordem: 1, peso: '100.00', ativo: 1 }); notas[0].idCriterio = 202; }
        if (caso === 'inativo') { criteriosAvaliacao.find((item) => item.id_criterio === 101).ativo = 0; criteriosAvaliacao.find((item) => item.id_criterio === 102).peso = '50.00'; }
        if (caso === 'id-string') notas[0].idCriterio = '101';
        if (caso === 'campo-extra') notas[0].peso = 100;
        assert.equal((await gravarAvaliacao(payloadAvaliacao({ notas, estado: caso === 'conclusao-incompleta' ? 'concluida' : 'rascunho' }))).status, 400);
        assertSemEscrita();
    });
}

for (const campo of ['id_evento', 'id_jurado', 'id_usuario', 'tipo', 'cargo', 'situacao', 'media']) {
    test(`avaliacao PUT: campo extra ${campo} nao escolhe identidade ou autoridade`, async () => {
        assert.equal((await gravarAvaliacao(payloadAvaliacao({ [campo]: 999 }))).status, 400);
        assertSemEscrita();
    });
}

for (const campos of [{ versao: '0' }, { versao: -1 }, { versao: 4294967296 }, { estado: 'pendente' }, { notas: {} }, { notas: null }, { possivelDesclassificacao: 1 }, { motivoDesclassificacao: {} }]) {
    test(`avaliacao PUT: tipos/campos invalidos ${JSON.stringify(campos)}`, async () => {
        assert.equal((await gravarAvaliacao(payloadAvaliacao(campos))).status, 400);
        assertSemEscrita();
    });
}

for (const motivo of [null, '', '   ', 'x'.repeat(2001)]) {
    test(`avaliacao PUT: sinalizacao com motivo ${motivo === null ? 'null' : `tamanho ${motivo.length}`} e rejeitada`, async () => {
        assert.equal((await gravarAvaliacao(payloadAvaliacao({ possivelDesclassificacao: true, motivoDesclassificacao: motivo }))).status, 400);
        assertSemEscrita();
    });
}

test('avaliacao PUT: motivo Unicode conta caracteres, trim e sinalizacao nao altera media', async () => {
    const motivo = '\u{1F3B5}'.repeat(2000);
    const resposta = await gravarAvaliacao(payloadAvaliacao({ notas: notasCompletas(0), possivelDesclassificacao: true, motivoDesclassificacao: `  ${motivo}  ` }));
    assert.equal(resposta.status, 200);
    assert.equal(resposta.body.avaliacao.motivoDesclassificacao, motivo);
    assert.equal(resposta.body.avaliacao.possivelDesclassificacao, true);
    assert.equal(resposta.body.avaliacao.media, '0.00');
    const normalizada = await gravarAvaliacao(payloadAvaliacao({ versao: 1, motivoDesclassificacao: 'descartado' }));
    assert.equal(normalizada.body.avaliacao.motivoDesclassificacao, null);
    assert.equal(avaliacoes[0].motivo_desclassificacao, null);
});

for (const caso of ['tipo', 'situacao', 'cargo', 'designacao', 'sem-designacao', 'participacao']) {
    test(`avaliacao PUT: revalidacao corrente detecta ${caso} alterado apos middleware`, async () => {
        antesTransacao = () => {
            if (caso === 'tipo') usuario.id_tipo_usuario = 3;
            if (caso === 'situacao') usuario.id_situacao = 9;
            if (caso === 'cargo') usuario.id_cargo = 10;
            if (caso === 'designacao') designacoes[0].ativo = 0;
            if (caso === 'sem-designacao') designacoes = [];
            if (caso === 'participacao') participacoes[0].link_video_1 = '   ';
        };
        assert.equal((await gravarAvaliacao(payloadAvaliacao())).status, caso === 'participacao' ? 404 : 403);
        assertSemEscrita();
        assert.ok(eventosTransacao.includes('ROLLBACK'));
    });
}

test('avaliacao PUT: isolamento entre jurados cria avaliacoes independentes', async () => {
    const primeira = await gravarAvaliacao(payloadAvaliacao({ notas: [{ idCriterio: 101, nota: 60 }] }));
    usuario.id_usuario = 11;
    designacoes = [{ id_evento: 1, id_usuario: 11, ativo: 1 }];
    const outroToken = jwt.sign({ id_usuario: 11, id_tipo_usuario: 4 }, jwtSecret, { expiresIn: '5m' });
    const segunda = await gravarAvaliacao(payloadAvaliacao({ notas: [{ idCriterio: 101, nota: 90 }] }), outroToken);
    assert.equal(segunda.status, 200);
    assert.notEqual(primeira.body.avaliacao.idAvaliacao, segunda.body.avaliacao.idAvaliacao);
    assert.deepEqual(avaliacoes.map((item) => item.id_jurado), [10, 11]);
    assert.equal((await requisitar(caminhoAvaliacao, outroToken)).body.avaliacao.notas[0].nota, 90);
});

for (const etapa of ['header', 'delete', 'notas', 'commit', 'duplicate', 'deadlock', 'timeout']) {
    test(`avaliacao PUT: falha ${etapa} faz rollback integral sem retry`, async () => {
        falhaTransacao = etapa;
        if (['delete', 'notas', 'commit'].includes(etapa)) {
            avaliacoes = [criarAvaliacao()];
            notasAvaliacao = [{ id_avaliacao: 500, id_evento: 1, id_criterio: 101, nota: 50 }];
        }
        const snapshot = structuredClone({ avaliacoes, notasAvaliacao });
        const logOriginal = console.error;
        console.error = () => {};
        try {
            const resposta = await gravarAvaliacao(payloadAvaliacao({ versao: avaliacoes.length ? 1 : 0, notas: notasCompletas() }));
            assert.equal(resposta.status, ['duplicate', 'deadlock', 'timeout'].includes(etapa) ? 409 : 500);
            assert.doesNotMatch(JSON.stringify(resposta.body), /SQL|stack|ER_|Falha/);
            assert.deepEqual({ avaliacoes, notasAvaliacao }, snapshot);
            assert.equal(eventosTransacao.filter((item) => item === 'BEGIN').length, 1);
            assert.equal(eventosTransacao.filter((item) => item === 'ROLLBACK').length, 1);
            assert.ok(eventosTransacao.indexOf('ROLLBACK') < eventosTransacao.indexOf('RELEASE'));
            if (etapa === 'duplicate') assert.equal(eventosTransacao.filter((item) => item.startsWith('UPDATE')).length, 0);
        } finally { console.error = logOriginal; }
    });
}

test('avaliacao PUT: rollback falho descarta conexao e nao a devolve ao pool', async () => {
    falhaTransacao = 'rollback';
    const logOriginal = console.error;
    console.error = () => {};
    try {
        assert.equal((await gravarAvaliacao(payloadAvaliacao())).status, 500);
        assert.ok(eventosTransacao.includes('ROLLBACK'));
        assert.ok(eventosTransacao.includes('DESTROY'));
        assert.equal(eventosTransacao.includes('RELEASE'), false);
    } finally { console.error = logOriginal; }
});

test('avaliacao GET/PUT: pesos desiguais produzem half-up exato com duas casas', async () => {
    criteriosAvaliacao = criteriosAvaliacao.filter((item) => [101, 102].includes(item.id_criterio));
    criteriosAvaliacao.find((item) => item.id_criterio === 101).peso = '50.50';
    criteriosAvaliacao.find((item) => item.id_criterio === 102).peso = '49.50';
    const resposta = await gravarAvaliacao(payloadAvaliacao({ notas: [{ idCriterio: 101, nota: 1 }, { idCriterio: 102, nota: 0 }] }));
    assert.equal(resposta.status, 200);
    assert.equal(resposta.body.avaliacao.media, '0.51');
    assert.equal((await requisitar(caminhoAvaliacao)).body.avaliacao.media, '0.51');
    assert.equal(Object.keys(avaliacoes[0]).includes('media'), false);
});

test('avaliacao funcoes puras: extremos, ausencia, NaN/Infinity e nota zero', () => {
    const criterios = [101, 102].map((idCriterio) => ({ idCriterio, peso: '50.00' }));
    assert.equal(calcularMediaPonderada(criterios, [{ idCriterio: 101, nota: 0 }, { idCriterio: 102, nota: 0 }]), '0.00');
    assert.equal(calcularMediaPonderada(criterios, [{ idCriterio: 101, nota: 100 }, { idCriterio: 102, nota: 100 }]), '100.00');
    assert.equal(calcularMediaPonderada(criterios, [{ idCriterio: 101, nota: 0 }]), null);
    for (const nota of [NaN, Infinity, -Infinity]) {
        assert.throws(() => validarPayloadAvaliacao(payloadAvaliacao({ notas: [{ idCriterio: 101, nota }] }), criterios), { status: 400 });
    }
    assert.deepEqual(validarPayloadAvaliacao(payloadAvaliacao({ notas: [{ idCriterio: 101, nota: 0 }] }), criterios).notas, [{ idCriterio: 101, nota: 0 }]);
});

const prepararAvaliacaoEditavel = () => {
    avaliacoes = [criarAvaliacao()];
    notasAvaliacao = [{ id_avaliacao: 500, id_evento: 1, id_criterio: 101, nota: 50 }];
    return structuredClone({ avaliacoes, notasAvaliacao });
};

const assertSemCommitEEstadoPreservado = (snapshot) => {
    assert.equal(eventosTransacao.includes('COMMIT'), false);
    assert.deepEqual({ avaliacoes, notasAvaliacao }, snapshot);
};

const assertRejeicaoEditavelSemEscrita = (snapshot) => {
    assertSemEscrita();
    assertSemCommitEEstadoPreservado(snapshot);
    assert.equal(eventosTransacao.filter((item) => item === 'ROLLBACK').length, 1);
    assert.equal(eventosTransacao.filter((item) => item === 'RELEASE').length, 1);
    assert.ok(eventosTransacao.indexOf('ROLLBACK') < eventosTransacao.indexOf('RELEASE'));
};

const comPoolAvaliacaoSimulado = async (getConnection, executar) => {
    const getConnectionAnterior = db.getConnection;
    const logAnterior = console.error;
    db.getConnection = getConnection;
    console.error = () => {};
    try {
        return await executar();
    } finally {
        db.getConnection = getConnectionAnterior;
        console.error = logAnterior;
    }
};

for (const [nome, payload] of [['null', null], ['array', []], ['string', 'invalido'], ['numero', 1]]) {
    test(`avaliacao PUT servico: raiz ${nome} invalida em avaliacao editavel`, async () => {
        const snapshot = prepararAvaliacaoEditavel();
        await assert.rejects(
            salvarAvaliacaoServico(eventos[0], 17, 10, payload, db),
            (error) => error instanceof JuradoAvaliacaoError && error.status === 400
        );
        assert.ok(eventosTransacao.some((sql) => sql.endsWith('FOR UPDATE')));
        assertRejeicaoEditavelSemEscrita(snapshot);
    });
}

for (const campo of ['versao', 'estado', 'notas', 'possivelDesclassificacao', 'motivoDesclassificacao']) {
    test(`avaliacao PUT: campo obrigatorio ${campo} ausente em avaliacao editavel`, async () => {
        const snapshot = prepararAvaliacaoEditavel();
        const payload = payloadAvaliacao({ versao: 1 });
        delete payload[campo];
        assert.equal((await gravarAvaliacao(payload)).status, 400);
        assertRejeicaoEditavelSemEscrita(snapshot);
    });
}

test('avaliacao PUT: versao fracionaria em avaliacao editavel nao persiste', async () => {
    const snapshot = prepararAvaliacaoEditavel();
    assert.equal((await gravarAvaliacao(payloadAvaliacao({ versao: 1.5 }))).status, 400);
    assertRejeicaoEditavelSemEscrita(snapshot);
});

for (const idCriterio of [0, -1, 1.5]) {
    test(`avaliacao PUT: idCriterio ${idCriterio} invalido nao persiste`, async () => {
        const snapshot = prepararAvaliacaoEditavel();
        const payload = payloadAvaliacao({ versao: 1, notas: [{ idCriterio, nota: 80 }] });
        assert.equal((await gravarAvaliacao(payload)).status, 400);
        assertRejeicaoEditavelSemEscrita(snapshot);
    });
}

for (const [campo, item] of [['idCriterio', { nota: 80 }], ['nota', { idCriterio: 101 }]]) {
    test(`avaliacao PUT: item sem ${campo} nao persiste`, async () => {
        const snapshot = prepararAvaliacaoEditavel();
        assert.equal((await gravarAvaliacao(payloadAvaliacao({ versao: 1, notas: [item] }))).status, 400);
        assertRejeicaoEditavelSemEscrita(snapshot);
    });
}

for (const caso of ['id-duplicado', 'ordem-duplicada', 'id-invalido', 'ordem-invalida', 'ativo-invalido']) {
    test(`avaliacao GET/PUT: guarda defensiva da configuracao ${caso}`, async () => {
        if (caso === 'id-duplicado') criteriosAvaliacao[0].id_criterio = criteriosAvaliacao[1].id_criterio;
        if (caso === 'ordem-duplicada') criteriosAvaliacao[0].ordem = criteriosAvaliacao[1].ordem;
        if (caso === 'id-invalido') criteriosAvaliacao[0].id_criterio = 0;
        if (caso === 'ordem-invalida') criteriosAvaliacao[0].ordem = 0;
        if (caso === 'ativo-invalido') criteriosAvaliacao[0].ativo = 2;
        assert.equal((await requisitar(caminhoAvaliacao)).status, 409);
        assert.deepEqual(eventosTransacao, []);
        const snapshot = structuredClone({ avaliacoes, notasAvaliacao });
        assert.equal((await gravarAvaliacao(payloadAvaliacao())).status, 409);
        assertRejeicaoEditavelSemEscrita(snapshot);
    });
}

test('avaliacao PUT: getConnection falho retorna 500 sem rollback ou release', async () => {
    const snapshot = prepararAvaliacaoEditavel();
    let tentativas = 0;
    await comPoolAvaliacaoSimulado(async () => {
        tentativas += 1;
        throw criarErroBanco('ER_SIMULADO');
    }, async () => {
        const resposta = await gravarAvaliacao(payloadAvaliacao({ versao: 1 }));
        assert.equal(resposta.status, 500);
        assert.doesNotMatch(JSON.stringify(resposta.body), /SQL|stack|ER_|Falha/);
    });
    assert.equal(tentativas, 1);
    assert.deepEqual(eventosTransacao, []);
    assertSemEscrita();
    assertSemCommitEEstadoPreservado(snapshot);
});

test('avaliacao PUT: BEGIN falho tenta rollback e libera sem executar SQL', async () => {
    const snapshot = prepararAvaliacaoEditavel();
    await comPoolAvaliacaoSimulado(async () => {
        const connection = criarConexaoSimulada();
        connection.beginTransaction = async () => {
            eventosTransacao.push('BEGIN');
            throw criarErroBanco('ER_SIMULADO');
        };
        return connection;
    }, async () => {
        const resposta = await gravarAvaliacao(payloadAvaliacao({ versao: 1 }));
        assert.equal(resposta.status, 500);
        assert.doesNotMatch(JSON.stringify(resposta.body), /SQL|stack|ER_|Falha/);
    });
    assert.deepEqual(eventosTransacao, ['BEGIN', 'ROLLBACK', 'RELEASE']);
    assertSemEscrita();
    assertSemCommitEEstadoPreservado(snapshot);
});

test('avaliacao PUT: avaliacao descoberta ausente no reread causa 409 sem mutacao', async () => {
    const snapshot = prepararAvaliacaoEditavel();
    let descobertas = 0;
    let rereads = 0;
    await comPoolAvaliacaoSimulado(async () => {
        const connection = criarConexaoSimulada();
        const consultar = connection.query.bind(connection);
        connection.query = async (sql, params) => {
            const retorno = await consultar(sql, params);
            if (sql.trim().startsWith('SELECT id_avaliacao FROM ist_eventos_avaliacoes')) {
                descobertas += 1;
                assert.deepEqual(retorno[0], [{ id_avaliacao: 500 }]);
            }
            if (sql.trim().startsWith('SELECT id_avaliacao, id_evento, id_concorrente')) {
                rereads += 1;
                assert.deepEqual(params, [500, 1, 17, 10]);
                return [[]];
            }
            return retorno;
        };
        return connection;
    }, async () => {
        assert.equal((await gravarAvaliacao(payloadAvaliacao({ versao: 1 }))).status, 409);
    });
    assert.equal(descobertas, 1);
    assert.equal(rereads, 1);
    assertRejeicaoEditavelSemEscrita(snapshot);
});

test('avaliacao PUT: UPDATE sem linha afetada causa 409 sem substituir notas', async () => {
    const snapshot = prepararAvaliacaoEditavel();
    let tentativasUpdate = 0;
    await comPoolAvaliacaoSimulado(async () => {
        const connection = criarConexaoSimulada();
        const consultar = connection.query.bind(connection);
        connection.query = async (sql, params) => {
            const consulta = sql.replace(/\s+/g, ' ').trim();
            if (consulta.startsWith('UPDATE ist_eventos_avaliacoes ')) {
                assert.match(consulta, /estado = 'rascunho' AND versao = \?$/);
                assert.deepEqual(params, ['rascunho', 0, null, 2, 'rascunho', 500, 1, 10, 17, 1]);
                tentativasUpdate += 1;
                eventosTransacao.push(consulta);
                return [{ affectedRows: 0 }];
            }
            return consultar(sql, params);
        };
        return connection;
    }, async () => {
        assert.equal((await gravarAvaliacao(payloadAvaliacao({ versao: 1, notas: notasCompletas() }))).status, 409);
    });
    assert.equal(tentativasUpdate, 1);
    assert.equal(eventosTransacao.filter((sql) => /^(INSERT|DELETE)\b/.test(sql)).length, 0);
    assert.equal(eventosTransacao.filter((sql) => /^UPDATE\b/.test(sql)).length, 1);
    assert.equal(eventosTransacao.filter((item) => item === 'ROLLBACK').length, 1);
    assert.equal(eventosTransacao.filter((item) => item === 'RELEASE').length, 1);
    assert.ok(eventosTransacao.indexOf('ROLLBACK') < eventosTransacao.indexOf('RELEASE'));
    assertSemCommitEEstadoPreservado(snapshot);
});