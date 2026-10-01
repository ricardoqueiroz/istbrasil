import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import jwt from 'jsonwebtoken';
import test from 'node:test';
import { pool as db } from '../src/config/db.js';
import {
    atualizarUsuarioAdmin,
    listarOpcoesUsuariosAdmin,
    listarSituacoesUsuarioAdmin,
    listarUsuariosAdmin,
    obterUsuarioAdmin
} from '../src/controllers/admin/usuariosAdminController.js';
import { autenticarUsuario } from '../src/middlewares/authMiddleware.js';
import { autorizarTiposUsuario } from '../src/middlewares/authorizationMiddleware.js';
import adminUsuariosRoutes from '../src/routes/adminUsuarios.routes.js';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-insecure-secret';

const resposta = () => ({
    statusCode: 200,
    body: null,
    status(codigo) {
        this.statusCode = codigo;
        return this;
    },
    json(conteudo) {
        this.body = conteudo;
        return this;
    }
});

const normalizarSql = (sql) => sql.replace(/\s+/g, ' ').trim();

const comQuerySimulada = async (implementacao, executar) => {
    const queryOriginal = db.query;
    db.query = implementacao;
    try {
        return await executar();
    } finally {
        db.query = queryOriginal;
    }
};

const linhaLista = {
    id_usuario: 8,
    nome: 'Maria',
    email: 'maria@example.com',
    id_tipo_usuario: 2,
    tipo: 'Concorrente',
    id_cargo: null,
    cargo: null,
    id_situacao: 3,
    situacao: 'Cadastrado',
    email_confirmado: 1,
    data_cadastro: '2026-09-30T10:00:00.000Z',
    senha: 'não deve vazar',
    token_confirmacao: 'não deve vazar'
};

const payloadAtualizacao = (sobrescritas = {}) => ({
    nome: 'Maria Atualizada',
    cpf: '529.982.247-25',
    identidade: null,
    dataNascimento: '1990-01-01',
    idTipoUsuario: 3,
    idCargo: null,
    idSituacao: 6,
    telefoneCelular: '(93) 99999-9999',
    logradouro: 'Rua Atualizada',
    numero: '10',
    complemento: null,
    bairro: 'Centro',
    cidade: 'Santarém',
    uf: 'PA',
    cep: '68000-000',
    ...sobrescritas
});

const linhaDetalheAtualizada = (sobrescritas = {}) => ({
    ...linhaLista,
    nome: 'Maria Atualizada',
    cpf: '52998224725',
    identidade: null,
    data_nascimento: '1990-01-01',
    telefone_celular: '93999999999',
    logradouro: 'Rua Atualizada',
    numero: '10',
    complemento: null,
    bairro: 'Centro',
    cidade: 'Santarém',
    uf: 'PA',
    cep: '68000000',
    foto: null,
    curriculo: null,
    celular_confirmado: 0,
    data_atualizacao: '2026-10-01T10:00:00.000Z',
    concorrente_usuario_id: null,
    ...sobrescritas
});

const executarAtualizacao = async ({
    idUsuario = 8,
    idAdministrador = 10,
    payload = payloadAtualizacao(),
    usuarioAtual = { id_usuario: 8, id_tipo_usuario: 3, id_situacao: 6 },
    tipoExiste = true,
    cargoExiste = true,
    situacaoExiste = true,
    situacaoTipo = payload.idTipoUsuario,
    cpfDuplicado = false,
    concorrenteExiste = false,
    detalhe = linhaDetalheAtualizada(),
    falharEmUpdate = false
} = {}) => {
    const consultas = [];
    const estado = { iniciou: 0, commits: 0, rollbacks: 0, releases: 0 };
    const connection = {
        async beginTransaction() { estado.iniciou += 1; },
        async commit() { estado.commits += 1; },
        async rollback() { estado.rollbacks += 1; },
        release() { estado.releases += 1; },
        async query(sql, params = []) {
            const consulta = normalizarSql(sql);
            consultas.push({ sql: consulta, params });
            if (consulta.startsWith('SELECT id_usuario, id_tipo_usuario, id_situacao FROM ist_usuarios')) return [usuarioAtual ? [usuarioAtual] : []];
            if (consulta.startsWith('SELECT id_tipo FROM ist_tipo_usuario')) return [tipoExiste ? [{ id_tipo: payload.idTipoUsuario }] : []];
            if (consulta.startsWith('SELECT id_cargo FROM ist_cargo')) return [cargoExiste ? [{ id_cargo: payload.idCargo }] : []];
            if (consulta.startsWith('SELECT id_situacao, id_tipo FROM ist_situacao')) return [situacaoExiste ? [{ id_situacao: payload.idSituacao, id_tipo: situacaoTipo }] : []];
            if (consulta.startsWith('SELECT id_usuario FROM ist_usuarios WHERE cpf')) return [cpfDuplicado ? [{ id_usuario: 99 }] : []];
            if (consulta.startsWith('UPDATE ist_usuarios')) {
                if (falharEmUpdate) throw new Error('Falha simulada');
                return [{ affectedRows: 1 }];
            }
            if (consulta.startsWith('SELECT id_usuario FROM ist_concorrentes')) return [concorrenteExiste ? [{ id_usuario: idUsuario }] : []];
            if (consulta.startsWith('INSERT INTO ist_concorrentes')) return [{ affectedRows: 1 }];
            if (consulta.startsWith('SELECT u.id_usuario')) return [[detalhe]];
            throw new Error(`Consulta não simulada: ${consulta}`);
        }
    };
    const getConnectionOriginal = db.getConnection;
    db.getConnection = async () => connection;
    const res = resposta();
    try {
        await atualizarUsuarioAdmin(
            { params: { id: String(idUsuario) }, usuario: { id_usuario: idAdministrador }, body: payload },
            res
        );
    } finally {
        db.getConnection = getConnectionOriginal;
    }
    return { res, consultas, estado };
};

const executarListagem = async (query = {}, total = 1) => {
    const consultas = [];
    const res = resposta();
    await comQuerySimulada(async (sql, params = []) => {
        const consulta = normalizarSql(sql);
        consultas.push({ sql: consulta, params });
        return consulta.includes('COUNT(*)') ? [[{ total }]] : [[linhaLista]];
    }, () => listarUsuariosAdmin({ query }, res));
    return { res, consultas };
};

const executarCadeiaAdmin = async ({ cookies = {}, tipoAtual = 1 } = {}) => {
    const req = { cookies };
    const res = resposta();
    let etapaSeguinteAlcancada = false;
    let consultas = 0;

    await comQuerySimulada(async () => {
        consultas += 1;
        return [[{ id_tipo_usuario: tipoAtual }]];
    }, () => autenticarUsuario(req, res, () =>
        autorizarTiposUsuario(1)(req, res, () => { etapaSeguinteAlcancada = true; })
    ));

    return { req, res, etapaSeguinteAlcancada, consultas };
};

const tokenAdmin = (idTipoUsuario = 1) => jwt.sign(
    { id_usuario: 10, id_tipo_usuario: idTipoUsuario },
    JWT_SECRET,
    { expiresIn: '5m' }
);

test('todas as rotas administrativas de usuários exigem autenticação e autorização', async () => {
    const rotas = adminUsuariosRoutes.stack.filter((camada) => camada.route);
    assert.deepEqual(rotas.map((camada) => ({
        path: camada.route.path,
        metodo: Object.keys(camada.route.methods)[0]
    })), [
        { path: '/', metodo: 'get' },
        { path: '/opcoes', metodo: 'get' },
        { path: '/situacoes', metodo: 'get' },
        { path: '/:id', metodo: 'get' },
        { path: '/:id', metodo: 'put' }
    ]);
    assert.equal(rotas.every((camada) => camada.route.stack.length === 3), true);

    let nextChamado = false;
    const autorizado = resposta();
    await comQuerySimulada(async () => [[{ id_tipo_usuario: 1 }]], () =>
        autorizarTiposUsuario(1)({ usuario: { id_usuario: 10 } }, autorizado, () => { nextChamado = true; })
    );
    assert.equal(nextChamado, true);

    const negado = resposta();
    await comQuerySimulada(async () => [[{ id_tipo_usuario: 2 }]], () =>
        autorizarTiposUsuario(1)({ usuario: { id_usuario: 10 } }, negado, () => {})
    );
    assert.equal(negado.statusCode, 403);
});

test('cadeia administrativa rejeita requisição sem cookie antes da autorização', async () => {
    const resultado = await executarCadeiaAdmin();
    assert.equal(resultado.res.statusCode, 401);
    assert.equal(resultado.etapaSeguinteAlcancada, false);
    assert.equal(resultado.consultas, 0);
});

test('cadeia administrativa rejeita JWT inválido antes da autorização', async () => {
    const resultado = await executarCadeiaAdmin({ cookies: { ist_session: 'jwt-invalido' } });
    assert.equal(resultado.res.statusCode, 401);
    assert.equal(resultado.etapaSeguinteAlcancada, false);
    assert.equal(resultado.consultas, 0);
});

test('cadeia administrativa válida alcança a etapa seguinte', async () => {
    const resultado = await executarCadeiaAdmin({
        cookies: { ist_session: tokenAdmin() },
        tipoAtual: 1
    });
    assert.equal(resultado.res.statusCode, 200);
    assert.equal(resultado.etapaSeguinteAlcancada, true);
    assert.equal(resultado.consultas, 1);
    assert.deepEqual(resultado.req.usuario, { id_usuario: 10, id_tipo_usuario: 1 });
});

test('tipo administrativo no JWT não prevalece sobre o tipo atual no banco', async () => {
    const resultado = await executarCadeiaAdmin({
        cookies: { ist_session: tokenAdmin(1) },
        tipoAtual: 2
    });
    assert.equal(resultado.res.statusCode, 403);
    assert.equal(resultado.etapaSeguinteAlcancada, false);
    assert.equal(resultado.consultas, 1);
});

test('listagem aplica paginação e limita page size a 100', async () => {
    const { res, consultas } = await executarListagem({ page: '2', limit: '500' }, 250);
    assert.deepEqual(res.body.pagination, { page: 2, limit: 100, total: 250, totalPages: 3 });
    assert.deepEqual(consultas[1].params.slice(-2), [100, 100]);
});

for (const [parametro, valor] of [
    ['page', '0'],
    ['page', '-1'],
    ['page', '1.5'],
    ['limit', '0'],
    ['limit', '-1'],
    ['limit', '1.5']
]) {
    test(`listagem rejeita ${parametro} inválido: ${valor}`, async () => {
        const res = resposta();
        let consultas = 0;
        await comQuerySimulada(async () => { consultas += 1; return [[]]; }, () =>
            listarUsuariosAdmin({ query: { [parametro]: valor } }, res)
        );
        assert.equal(res.statusCode, 400);
        assert.equal(consultas, 0);
    });
}

for (const [parametro, coluna, valor] of [
    ['idTipoUsuario', 'u.id_tipo_usuario = ?', 2],
    ['idCargo', 'u.id_cargo = ?', 4],
    ['idSituacao', 'u.id_situacao = ?', 6]
]) {
    test(`listagem filtra por ${parametro}`, async () => {
        const { consultas } = await executarListagem({ [parametro]: String(valor) });
        assert.match(consultas[0].sql, new RegExp(coluna.replace(/[.?]/g, '\\$&')));
        assert.match(consultas[1].sql, new RegExp(coluna.replace(/[.?]/g, '\\$&')));
        assert.deepEqual(consultas[0].params, [valor]);
        assert.deepEqual(consultas[1].params.slice(0, -2), [valor]);
    });
}

for (const parametro of ['idTipoUsuario', 'idCargo', 'idSituacao']) {
    test(`listagem rejeita filtro ${parametro} inválido`, async () => {
        const res = resposta();
        let consultas = 0;
        await comQuerySimulada(async () => { consultas += 1; return [[]]; }, () =>
            listarUsuariosAdmin({ query: { [parametro]: 'inválido' } }, res)
        );
        assert.equal(res.statusCode, 400);
        assert.equal(consultas, 0);
    });
}

test('COUNT e SELECT compartilham busca por nome ou e-mail e os mesmos filtros', async () => {
    const { consultas } = await executarListagem({
        search: 'maria',
        idTipoUsuario: '2',
        idCargo: '4',
        idSituacao: '6'
    });
    const whereCount = consultas[0].sql.slice(consultas[0].sql.indexOf('WHERE'));
    const whereSelect = consultas[1].sql.slice(
        consultas[1].sql.indexOf('WHERE'),
        consultas[1].sql.indexOf('ORDER BY')
    ).trim();
    assert.equal(whereCount, whereSelect);
    assert.deepEqual(consultas[0].params, ['%maria%', '%maria%', 2, 4, 6]);
    assert.deepEqual(consultas[1].params.slice(0, -2), consultas[0].params);
});

test('ordenação aceita somente campos da whitelist', async () => {
    const invalida = resposta();
    let consultas = 0;
    await comQuerySimulada(async () => { consultas += 1; return [[]]; }, () =>
        listarUsuariosAdmin({ query: { sortField: 'senha' } }, invalida)
    );
    assert.equal(invalida.statusCode, 400);
    assert.equal(consultas, 0);

    const herdada = resposta();
    await comQuerySimulada(async () => { consultas += 1; return [[]]; }, () =>
        listarUsuariosAdmin({ query: { sortField: 'toString' } }, herdada)
    );
    assert.equal(herdada.statusCode, 400);
    assert.equal(consultas, 0);

    const valida = await executarListagem({ sortField: 'tipo', sortOrder: 'desc' });
    assert.match(valida.consultas[1].sql, /ORDER BY tu\.descricao DESC, u\.id_usuario ASC/);
});

test('listagem rejeita sortOrder inválido', async () => {
    const res = resposta();
    let consultas = 0;
    await comQuerySimulada(async () => { consultas += 1; return [[]]; }, () =>
        listarUsuariosAdmin({ query: { sortOrder: 'aleatorio' } }, res)
    );
    assert.equal(res.statusCode, 400);
    assert.equal(consultas, 0);
});

test('opções e situações vêm do banco e situação valida o tipo', async () => {
    const opcoes = resposta();
    let chamada = 0;
    await comQuerySimulada(async () => {
        chamada += 1;
        if (chamada === 1) return [[{ id_tipo: 1, descricao: 'Diretoria' }]];
        if (chamada === 2) return [[{ id_cargo: 2, nome_cargo: 'Tesouraria' }]];
        return [[{ id_situacao: 6, situacao: 'Normal', id_tipo: 3 }]];
    }, () => listarOpcoesUsuariosAdmin({}, opcoes));
    assert.deepEqual(opcoes.body, {
        tiposUsuario: [{ idTipoUsuario: 1, tipo: 'Diretoria' }],
        cargos: [{ idCargo: 2, cargo: 'Tesouraria' }],
        situacoes: [{ idSituacao: 6, situacao: 'Normal', idTipoUsuario: 3 }]
    });

    const invalida = resposta();
    await listarSituacoesUsuarioAdmin({ query: { idTipoUsuario: 'abc' } }, invalida);
    assert.equal(invalida.statusCode, 400);

    const valida = resposta();
    let parametros;
    await comQuerySimulada(async (_sql, params) => {
        parametros = params;
        return [[{ id_situacao: 3, situacao: 'Cadastrado', id_tipo: 2 }]];
    }, () => listarSituacoesUsuarioAdmin({ query: { idTipoUsuario: '2' } }, valida));
    assert.deepEqual(parametros, [2]);
    assert.deepEqual(valida.body, [{ idSituacao: 3, situacao: 'Cadastrado', idTipoUsuario: 2 }]);
});

test('detalhe retorna 404 para usuário inexistente', async () => {
    const res = resposta();
    await comQuerySimulada(async () => [[]], () => obterUsuarioAdmin({ params: { id: '999' } }, res));
    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.body, { message: 'Usuário não encontrado.' });
});

test('detalhe rejeita ID de usuário inválido', async () => {
    const res = resposta();
    let consultas = 0;
    await comQuerySimulada(async () => { consultas += 1; return [[]]; }, () =>
        obterUsuarioAdmin({ params: { id: '0' } }, res)
    );
    assert.equal(res.statusCode, 400);
    assert.equal(consultas, 0);
});

test('detalhe inclui bloco concorrente somente quando o registro existe', async () => {
    const res = resposta();
    await comQuerySimulada(async () => [[{
        ...linhaLista,
        cpf: '12345678901',
        identidade: null,
        data_nascimento: '1990-01-01',
        telefone_celular: '93999999999',
        logradouro: 'Rua A',
        numero: '1',
        complemento: null,
        bairro: 'Centro',
        cidade: 'Santarém',
        uf: 'PA',
        cep: '68000000',
        foto: null,
        curriculo: null,
        celular_confirmado: 0,
        data_atualizacao: null,
        concorrente_usuario_id: 8,
        id_concorrente: 'FVST2-001',
        id_obra_1: 22,
        link_video_1: 'https://youtu.be/abcdefghijk',
        id_obra_2: null,
        link_video_2: null,
        aceite_regulamento: 1,
        confirmacao_inscricao_enviada: 1,
        confirmacao_inscricao_enviada_em: '2026-09-30T12:00:00.000Z',
        concorrente_data_cadastro: '2026-09-30T10:00:00.000Z'
    }]], () => obterUsuarioAdmin({ params: { id: '8' } }, res));

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.concorrente.idConcorrente, 'FVST2-001');
    assert.equal(res.body.concorrente.idObra1, 22);
    assert.equal(res.body.concorrente.aceiteRegulamento, true);
});

test('detalhe de usuário sem registro concorrente omite a propriedade concorrente', async () => {
    const res = resposta();
    await comQuerySimulada(async () => [[{
        ...linhaLista,
        cpf: '12345678901',
        identidade: null,
        data_nascimento: '1990-01-01',
        telefone_celular: '93999999999',
        logradouro: 'Rua A',
        numero: '1',
        complemento: null,
        bairro: 'Centro',
        cidade: 'Santarém',
        uf: 'PA',
        cep: '68000000',
        foto: null,
        curriculo: null,
        celular_confirmado: 0,
        data_atualizacao: null,
        concorrente_usuario_id: null
    }]], () => obterUsuarioAdmin({ params: { id: '8' } }, res));

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.usuario.idUsuario, 8);
    assert.equal(Object.prototype.hasOwnProperty.call(res.body, 'concorrente'), false);
});

test('listagem e detalhe nunca retornam senha ou tokens', async () => {
    const listagem = await executarListagem();
    assert.equal(JSON.stringify(listagem.res.body).includes('senha'), false);
    assert.equal(JSON.stringify(listagem.res.body).includes('token'), false);

    const res = resposta();
    const detalhe = {
        ...linhaLista,
        cpf: '12345678901',
        identidade: null,
        data_nascimento: '1990-01-01',
        telefone_celular: '93999999999',
        logradouro: 'Rua A',
        numero: '1',
        complemento: null,
        bairro: 'Centro',
        cidade: 'Santarém',
        uf: 'PA',
        cep: '68000000',
        foto: null,
        curriculo: null,
        celular_confirmado: 0,
        data_atualizacao: null,
        concorrente_usuario_id: null,
        token_expira_em: 'não deve vazar',
        token_tipo: 'email'
    };
    let sqlExecutado;
    await comQuerySimulada(async (sql) => {
        sqlExecutado = normalizarSql(sql);
        return [[detalhe]];
    }, () => obterUsuarioAdmin({ params: { id: '8' } }, res));

    const json = JSON.stringify(res.body);
    assert.equal(json.includes('senha'), false);
    assert.equal(json.includes('token'), false);
    assert.doesNotMatch(sqlExecutado, /u\.senha|token_confirmacao|token_expira_em|token_tipo/);
});

test('PUT retorna 404 e rollback para usuário inexistente', async () => {
    const resultado = await executarAtualizacao({ usuarioAtual: null });
    assert.equal(resultado.res.statusCode, 404);
    assert.equal(resultado.estado.rollbacks, 1);
    assert.equal(resultado.estado.commits, 0);
});

test('PUT atualiza dados comuns em transação e retorna o contrato administrativo', async () => {
    const resultado = await executarAtualizacao();
    assert.equal(resultado.res.statusCode, 200);
    assert.equal(resultado.res.body.usuario.nome, 'Maria Atualizada');
    assert.equal(resultado.estado.iniciou, 1);
    assert.equal(resultado.estado.commits, 1);
    assert.equal(resultado.estado.releases, 1);
    const update = resultado.consultas.find(({ sql }) => sql.startsWith('UPDATE ist_usuarios'));
    assert.ok(update);
    assert.doesNotMatch(update.sql, /email|senha|token|foto|curriculo/);
});

test('PUT rejeita CPF inválido antes de abrir transação', async () => {
    const resultado = await executarAtualizacao({ payload: payloadAtualizacao({ cpf: '111.111.111-11' }) });
    assert.equal(resultado.res.statusCode, 400);
    assert.equal(resultado.estado.iniciou, 0);
});

test('PUT aceita identidade válida e persiste o valor', async () => {
    const resultado = await executarAtualizacao({ payload: payloadAtualizacao({ identidade: '038088068' }) });
    assert.equal(resultado.res.statusCode, 200);
    const update = resultado.consultas.find(({ sql }) => sql.startsWith('UPDATE ist_usuarios'));
    assert.equal(update.params[2], '038088068');
});

test('PUT aceita identidade null e persiste null', async () => {
    const resultado = await executarAtualizacao({ payload: payloadAtualizacao({ identidade: null }) });
    assert.equal(resultado.res.statusCode, 200);
    const update = resultado.consultas.find(({ sql }) => sql.startsWith('UPDATE ist_usuarios'));
    assert.equal(update.params[2], null);
});

test('PUT aceita identidade vazia e normaliza para null', async () => {
    const resultado = await executarAtualizacao({ payload: payloadAtualizacao({ identidade: '' }) });
    assert.equal(resultado.res.statusCode, 200);
    const update = resultado.consultas.find(({ sql }) => sql.startsWith('UPDATE ist_usuarios'));
    assert.equal(update.params[2], null);
});

test('PUT aceita identidade ausente e normaliza para null', async () => {
    const payload = payloadAtualizacao();
    delete payload.identidade;
    const resultado = await executarAtualizacao({ payload });
    assert.equal(resultado.res.statusCode, 200);
    const update = resultado.consultas.find(({ sql }) => sql.startsWith('UPDATE ist_usuarios'));
    assert.equal(update.params[2], null);
});

test('formulário frontend não exige identidade e normaliza vazio para null', async () => {
    const componente = await readFile(
        new URL('../src/app/pages/admin/cadastros/editar/editar.component.ts', import.meta.url),
        'utf8'
    );
    assert.match(componente, /Identidade \(opcional\)/);
    assert.doesNotMatch(componente, /id="usuarioIdentidade"[^>]*required/);
    assert.doesNotMatch(componente, /!dados\.identidade\.trim\(\)/);
    assert.match(componente, /identidade: this\.formulario\.identidade\.trim\(\) \|\| null/);
});

test('PUT retorna 409 e rollback para CPF duplicado', async () => {
    const resultado = await executarAtualizacao({ cpfDuplicado: true });
    assert.equal(resultado.res.statusCode, 409);
    assert.equal(resultado.estado.rollbacks, 1);
});

for (const [cenario, opcoes, status] of [
    ['tipo inexistente', { tipoExiste: false }, 404],
    ['cargo inexistente', { payload: payloadAtualizacao({ idCargo: 9 }), cargoExiste: false }, 404],
    ['situação inexistente', { situacaoExiste: false }, 404],
    ['situação incompatível', { situacaoTipo: 2 }, 400]
]) {
    test(`PUT rejeita ${cenario}`, async () => {
        const resultado = await executarAtualizacao(opcoes);
        assert.equal(resultado.res.statusCode, status);
        assert.equal(resultado.estado.rollbacks, 1);
    });
}

test('PUT permite cargo null sem consultar ist_cargo', async () => {
    const resultado = await executarAtualizacao();
    assert.equal(resultado.res.statusCode, 200);
    assert.equal(resultado.consultas.some(({ sql }) => sql.includes('FROM ist_cargo')), false);
});

test('PUT permite mudança Externo para Colaborador', async () => {
    const payload = payloadAtualizacao({ idTipoUsuario: 4, idSituacao: 8, idCargo: 2 });
    const detalhe = linhaDetalheAtualizada({ id_tipo_usuario: 4, tipo: 'Colaborador', id_situacao: 8, id_cargo: 2 });
    const resultado = await executarAtualizacao({ payload, detalhe });
    assert.equal(resultado.res.statusCode, 200);
    assert.equal(resultado.res.body.usuario.idTipoUsuario, 4);
});

test('PUT muda Concorrente para Externo sem alterar histórico concorrente', async () => {
    const resultado = await executarAtualizacao({
        usuarioAtual: { id_usuario: 8, id_tipo_usuario: 2, id_situacao: 3 },
        concorrenteExiste: true,
        detalhe: linhaDetalheAtualizada({ concorrente_usuario_id: 8, id_concorrente: 'FVST2-004', aceite_regulamento: 1 })
    });
    assert.equal(resultado.res.statusCode, 200);
    assert.equal(resultado.consultas.some(({ sql }) => /^(UPDATE|DELETE) ist_concorrentes/.test(sql)), false);
    assert.equal(resultado.res.body.concorrente.idConcorrente, 'FVST2-004');
});

test('PUT muda Externo para Concorrente criando somente registro mínimo', async () => {
    const payload = payloadAtualizacao({ idTipoUsuario: 2, idSituacao: 3 });
    const detalhe = linhaDetalheAtualizada({ id_tipo_usuario: 2, tipo: 'Concorrente', id_situacao: 3, concorrente_usuario_id: 8 });
    const resultado = await executarAtualizacao({ payload, detalhe });
    assert.equal(resultado.res.statusCode, 200);
    const insert = resultado.consultas.find(({ sql }) => sql.startsWith('INSERT INTO ist_concorrentes'));
    assert.equal(insert.sql, 'INSERT INTO ist_concorrentes (id_usuario) VALUES (?)');
    assert.deepEqual(insert.params, [8]);
    assert.doesNotMatch(insert.sql, /id_concorrente|aceite|obra|video|confirmacao/);
});

test('PUT retorna a Concorrente reutilizando registro histórico integralmente', async () => {
    const payload = payloadAtualizacao({ idTipoUsuario: 2, idSituacao: 3 });
    const detalhe = linhaDetalheAtualizada({
        id_tipo_usuario: 2,
        tipo: 'Concorrente',
        id_situacao: 3,
        concorrente_usuario_id: 8,
        id_concorrente: 'FVST2-009',
        id_obra_1: 22,
        aceite_regulamento: 1,
        confirmacao_inscricao_enviada: 1
    });
    const resultado = await executarAtualizacao({ payload, concorrenteExiste: true, detalhe });
    assert.equal(resultado.res.statusCode, 200);
    assert.equal(resultado.consultas.some(({ sql }) => sql.startsWith('INSERT INTO ist_concorrentes')), false);
    assert.equal(resultado.res.body.concorrente.idConcorrente, 'FVST2-009');
    assert.equal(resultado.res.body.concorrente.idObra1, 22);
    assert.equal(resultado.res.body.concorrente.aceiteRegulamento, true);
    assert.equal(resultado.res.body.concorrente.confirmacaoInscricaoEnviada, true);
});

test('PUT impede administrador de alterar o próprio tipo', async () => {
    const resultado = await executarAtualizacao({
        idUsuario: 10,
        idAdministrador: 10,
        usuarioAtual: { id_usuario: 10, id_tipo_usuario: 1, id_situacao: 1 }
    });
    assert.equal(resultado.res.statusCode, 403);
});

test('PUT impede administrador de alterar a própria situação', async () => {
    const resultado = await executarAtualizacao({
        idUsuario: 10,
        idAdministrador: 10,
        usuarioAtual: { id_usuario: 10, id_tipo_usuario: 1, id_situacao: 1 },
        payload: payloadAtualizacao({ idTipoUsuario: 1, idSituacao: 2 })
    });
    assert.equal(resultado.res.statusCode, 403);
});

test('PUT permite administrador enviar o mesmo tipo e situação ao atualizar os próprios dados', async () => {
    const payload = payloadAtualizacao({ idTipoUsuario: 1, idSituacao: 1 });
    const resultado = await executarAtualizacao({
        idUsuario: 10,
        idAdministrador: 10,
        usuarioAtual: { id_usuario: 10, id_tipo_usuario: 1, id_situacao: 1 },
        payload
    });
    assert.equal(resultado.res.statusCode, 200);
    assert.equal(resultado.estado.commits, 1);
});

test('PUT rejeita dataAtualizacao como campo não permitido', async () => {
    const resultado = await executarAtualizacao({
        payload: payloadAtualizacao({ dataAtualizacao: '2026-10-01T10:00:00.000Z' })
    });
    assert.equal(resultado.res.statusCode, 400);
    assert.equal(resultado.estado.iniciou, 0);
});

test('PUT rejeita campos proibidos sem abrir transação', async () => {
    for (const campo of [
        'email', 'emailConfirmado', 'celularConfirmado', 'senha', 'foto', 'curriculo',
        'tokenConfirmacao', 'tokenExpiraEm', 'tokenTipo', 'idConcorrente', 'idObra1',
        'idObra2', 'linkVideo1', 'linkVideo2', 'aceiteRegulamento',
        'confirmacaoInscricaoEnviada', 'confirmacaoInscricaoEnviadaEm', 'dataCadastro'
    ]) {
        const resultado = await executarAtualizacao({ payload: payloadAtualizacao({ [campo]: 'proibido' }) });
        assert.equal(resultado.res.statusCode, 400);
        assert.equal(resultado.estado.iniciou, 0);
    }
});

test('PUT executa rollback e não expõe detalhes internos em falha', async () => {
    const consoleErrorOriginal = console.error;
    console.error = () => {};
    let resultado;
    try {
        resultado = await executarAtualizacao({ falharEmUpdate: true });
    } finally {
        console.error = consoleErrorOriginal;
    }
    assert.equal(resultado.res.statusCode, 500);
    assert.equal(resultado.estado.rollbacks, 1);
    assert.equal(resultado.estado.commits, 0);
    assert.deepEqual(resultado.res.body, { message: 'Não foi possível concluir a consulta administrativa.' });
});

test('resposta do PUT não expõe senha, tokens ou segredos', async () => {
    const detalhe = linhaDetalheAtualizada({ senha: 'hash', token_confirmacao: 'token', token_tipo: 'email' });
    const resultado = await executarAtualizacao({ detalhe });
    const json = JSON.stringify(resultado.res.body);
    assert.equal(json.includes('senha'), false);
    assert.equal(json.includes('token'), false);
});
