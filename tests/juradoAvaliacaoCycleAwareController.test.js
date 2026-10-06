import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
    criarSalvarAvaliacaoJuradoCycleAwareController, salvarAvaliacaoJuradoCycleAwareController
} from '../src/controllers/juradoAvaliacaoCycleAwareController.js';
import { JuradoAvaliacaoGravacaoError, GRAVACAO_ERROS } from '../src/services/juradoAvaliacaoGravacaoService.js';
import { JulgamentoContextError, JULGAMENTO_ERROS } from '../src/services/julgamentoContextService.js';

const evento = { id: 17, slug: 'evento-teste', nome: 'Evento Teste' };
const body = () => ({
    contexto: { idCiclo: 20, numeroTentativa: null }, versao: 0, estado: 'rascunho',
    notas: [{ idCriterioCiclo: 501, nota: 80 }], possivelDesclassificacao: false, motivoDesclassificacao: null
});
const request = () => ({
    eventoJurado: evento, usuario: { id_usuario: 10 }, params: { idParticipacao: '40' }, query: {}, body: body()
});
const response = () => ({
    statusCode: null, body: null,
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; }
});
const mensagemInterna = { message: 'N\u00e3o foi poss\u00edvel concluir a opera\u00e7\u00e3o de avalia\u00e7\u00e3o.' };
const falha = async (error) => {
    const res = response();
    await criarSalvarAvaliacaoJuradoCycleAwareController({ salvarAvaliacao: async () => { throw error; } })(request(), res);
    return res;
};

test('sucesso encaminha exatamente quatro argumentos e retorna DTO intacto uma unica vez', async () => {
    const req = request();
    const dto = {
        evento, contexto: { idCiclo: 20, numeroCiclo: 1, numeroTentativa: 1 }, versao: 1,
        podeGravar: true, autorizacaoGravacao: { estado: 'autorizada', code: null, motivo: null },
        estado: 'rascunho', avaliacao: { media: null }, criterios: [{ idCriterioCiclo: 501 }]
    };
    const antes = structuredClone(dto);
    let chamadas = 0;
    const controller = criarSalvarAvaliacaoJuradoCycleAwareController({ salvarAvaliacao: async (...args) => {
        chamadas++;
        assert.equal(args.length, 4);
        assert.equal(args[0], req.eventoJurado);
        assert.equal(args[1], 40);
        assert.equal(args[2], 10);
        assert.equal(args[3], req.body);
        return dto;
    } });
    const res = response();
    assert.equal(await controller(req, res), res);
    assert.equal(chamadas, 1);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body, dto);
    assert.deepEqual(dto, antes);
});

for (const valor of ['1', '4294967295']) {
    test(`parsing aceita decimal canonico ${valor}`, async () => {
        const req = request();
        req.params.idParticipacao = valor;
        const res = response();
        await criarSalvarAvaliacaoJuradoCycleAwareController({ salvarAvaliacao: async (_evento, id) => {
            assert.equal(id, Number(valor));
            return {};
        } })(req, res);
        assert.equal(res.statusCode, 200);
    });
}

for (const valor of ['0', '-1', '1.1', '1e2', ' 1', '1 ', '\t1', '+1', '01', '00', '1abc',
    'NaN', 'Infinity', '', '9007199254740992', '4294967296', '9'.repeat(400), 40, null, undefined, ['40']]) {
    test(`parsing rejeita ${JSON.stringify(valor)} sem chamar writer`, async () => {
        const req = request();
        req.params.idParticipacao = valor;
        let chamadas = 0;
        const res = response();
        await criarSalvarAvaliacaoJuradoCycleAwareController({ salvarAvaliacao: async () => { chamadas++; } })(req, res);
        assert.equal(chamadas, 0);
        assert.equal(res.statusCode, 400);
        assert.deepEqual(res.body, { message: 'Participa\u00e7\u00e3o inv\u00e1lida.' });
    });
}

test('ids externos nao substituem identidade autenticada e extras nao sao removidos', async () => {
    const req = request();
    req.body.idJurado = 99;
    req.params.idJurado = '98';
    req.query.idJurado = '97';
    const antes = structuredClone(req.body);
    const res = response();
    await criarSalvarAvaliacaoJuradoCycleAwareController({ salvarAvaliacao: async (_evento, _id, jurado, payload) => {
        assert.equal(jurado, 10);
        assert.equal(payload, req.body);
        assert.deepEqual(payload, antes);
        throw new JuradoAvaliacaoGravacaoError(GRAVACAO_ERROS.PAYLOAD_INVALIDO);
    } })(req, res);
    assert.equal(res.statusCode, 400);
    assert.deepEqual(req.body, antes);
});

test('body legado chega sem contexto, conversao de criterio, versao ou motivo', async () => {
    const req = request();
    req.body = { estado: 'rascunho', notas: [{ idCriterio: 101, nota: 80 }],
        possivelDesclassificacao: false, motivoDesclassificacao: 'nao normalizar' };
    const antes = structuredClone(req.body);
    const res = response();
    await criarSalvarAvaliacaoJuradoCycleAwareController({ salvarAvaliacao: async (_evento, _id, _jurado, payload) => {
        assert.equal(payload, req.body);
        assert.deepEqual(payload, antes);
        throw new JuradoAvaliacaoGravacaoError(GRAVACAO_ERROS.PAYLOAD_INVALIDO);
    } })(req, res);
    assert.equal(res.statusCode, 400);
    assert.deepEqual(req.body, antes);
});

const statusWriter = {
    PAYLOAD_INVALIDO: 400, ACESSO_OPERACIONAL_NEGADO: 403, CICLO_DESATUALIZADO: 409,
    TENTATIVA_DESATUALIZADA: 409, VERSAO_DESATUALIZADA: 409, AVALIACAO_CONCLUIDA: 409,
    CONTEXTO_NAO_GRAVAVEL: 409, CONFLITO_CONCORRENCIA: 409
};
const statusContexto = {
    EVENTO_INEXISTENTE: 404, CONCORRENTE_AUSENTE: 404, JURADO_FORA_ROSTER: 403,
    JURADO_NAO_INCLUIDO: 403, CONCORRENTE_NAO_INCLUIDO: 409, JULGAMENTO_NAO_CONFIGURADO: 404,
    CICLO_ATUAL_AUSENTE: 404, CONTEXTO_INCONSISTENTE: 500, CRITERIOS_INVALIDOS: 500, TENTATIVAS_INVALIDAS: 500
};
test('tabelas de testes cobrem todos os codigos realmente exportados', () => {
    assert.deepEqual(Object.keys(statusWriter).sort(), Object.values(GRAVACAO_ERROS).sort());
    assert.deepEqual(Object.keys(statusContexto).sort(), Object.values(JULGAMENTO_ERROS).sort());
});
for (const [Classe, statuses] of [[JuradoAvaliacaoGravacaoError, statusWriter], [JulgamentoContextError, statusContexto]]) {
    for (const [code, status] of Object.entries(statuses)) {
        test(`${Classe.name} ${code} -> ${status} sanitizado`, async () => {
            const error = new Classe(code, { sql: 'segredo', etapa: 'tabela_interna' });
            error.message = 'segredo SQL constraint';
            error.stack = 'segredo stack';
            const res = await falha(error);
            assert.equal(res.statusCode, status);
            if (status === 500) assert.deepEqual(res.body, mensagemInterna);
            else {
                assert.deepEqual(Object.keys(res.body).sort(), ['code', 'message']);
                assert.equal(res.body.code, code);
                assert.equal(typeof res.body.message, 'string');
                assert.ok(res.body.message.length > 0);
            }
            assert.doesNotMatch(JSON.stringify(res.body), /segredo|SQL|constraint|stack|tabela_interna/);
        });
    }
}

for (const motivo of [undefined, JULGAMENTO_ERROS.CONCORRENTE_NAO_INCLUIDO, 'limite_versao', 'outro']) {
    test(`contexto nao gravavel motivo ${motivo} permanece 409`, async () => {
        const res = await falha(new JuradoAvaliacaoGravacaoError(GRAVACAO_ERROS.CONTEXTO_NAO_GRAVAVEL, { motivo }));
        assert.equal(res.statusCode, 409);
    });
}
test('somente causa conhecida em erro writer reconhecido mapeia jurado nao incluido para 403', async () => {
    const res = await falha(new JuradoAvaliacaoGravacaoError(GRAVACAO_ERROS.CONTEXTO_NAO_GRAVAVEL,
        { motivo: JULGAMENTO_ERROS.JURADO_NAO_INCLUIDO }));
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.code, GRAVACAO_ERROS.CONTEXTO_NAO_GRAVAVEL);
});
test('mensagem nao determina causa nem status', async () => {
    const error = new JuradoAvaliacaoGravacaoError(GRAVACAO_ERROS.CONTEXTO_NAO_GRAVAVEL);
    error.message = 'JURADO_NAO_INCLUIDO';
    assert.equal((await falha(error)).statusCode, 409);
});
for (const error of [
    new Error('segredo'),
    Object.assign(new Error('segredo'), { code: 'ER_LOCK_DEADLOCK', sqlMessage: 'segredo', status: 409 }),
    { code: GRAVACAO_ERROS.PAYLOAD_INVALIDO, statusCode: 400, details: { segredo: true } },
    { code: GRAVACAO_ERROS.CONTEXTO_NAO_GRAVAVEL, details: { motivo: JULGAMENTO_ERROS.JURADO_NAO_INCLUIDO } },
    { code: JULGAMENTO_ERROS.EVENTO_INEXISTENTE, status: 404 },
    new JuradoAvaliacaoGravacaoError('CODIGO_DESCONHECIDO'),
    new JulgamentoContextError('CODIGO_DESCONHECIDO'), null, 'segredo'
]) {
    test(`erro desconhecido ${String(error)} -> 500 neutro`, async () => {
        const res = await falha(error);
        assert.equal(res.statusCode, 500);
        assert.deepEqual(res.body, mensagemInterna);
    });
}
test('falha de logger nao impede resposta 500', async (t) => {
    t.mock.method(console, 'error', () => { throw new Error('logger'); });
    assert.deepEqual((await falha(new Error('infra'))).body, mensagemInterna);
});
test('adapter HTTP sem SQL; rotas reais usam GET/PUT cycle-aware', () => {
    assert.equal(typeof salvarAvaliacaoJuradoCycleAwareController, 'function');
    const source = readFileSync(new URL('../src/controllers/juradoAvaliacaoCycleAwareController.js', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /\.query\s*\(|getConnection|beginTransaction|\.commit\s*\(|\.rollback\s*\(|FOR UPDATE|express/);
    const routes = readFileSync(new URL('../src/routes/jurado.routes.js', import.meta.url), 'utf8');
    assert.match(routes, /juradoAvaliacaoCycleAwareController/);
    assert.match(routes, /obterAvaliacaoJuradoCycleAwareController/);
    assert.match(routes, /salvarAvaliacaoJuradoCycleAwareController/);
});
