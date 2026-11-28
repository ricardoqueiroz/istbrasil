import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcrypt';
import { pool } from '../src/config/db.js';
import { mailTransporter } from '../src/services/mailService.js';
import usuarios from '../src/controllers/usuariosController.js';

const neutra = 'Se for possível concluir o cadastro, enviaremos as instruções para o e-mail informado.';
const body = { cadastroTipo: 'externo', nome: 'Pessoa', email: 'pessoa@example.org', cpf: '12345678901',
    telefone_celular: '11999999999', senha: 'senha123', data_nascimento: '2000-01-01', cep: '01001000',
    logradouro: 'Rua', numero: '1', bairro: 'Centro', cidade: 'Cidade', uf: 'SP' };
const duplicado = chave => Object.assign(new Error('duplicado'), { code: 'ER_DUP_ENTRY', errno: 1062,
    sqlMessage: `Duplicate entry 'valor' for key '${chave}'` });

async function executar(t, { existentes = [], erroInsert, erroConcorrente, concorrente = false } = {}) {
    const eventos = [];
    const original = { query: pool.query, getConnection: pool.getConnection, hash: bcrypt.hash,
        sendMail: mailTransporter.sendMail, from: process.env.MAIL_FROM_ADDRESS };
    t.after(() => {
        pool.query = original.query; pool.getConnection = original.getConnection; bcrypt.hash = original.hash;
        mailTransporter.sendMail = original.sendMail;
        if (original.from === undefined) delete process.env.MAIL_FROM_ADDRESS; else process.env.MAIL_FROM_ADDRESS = original.from;
    });
    process.env.MAIL_FROM_ADDRESS = 'remetente@example.org';
    pool.query = async sql => {
        assert.match(sql, /FROM ist_email_modelos/);
        return [[{ id_modelo: 1, chave: 'confirmacao_email', assunto: 'Confirmação',
            conteudo_html: '<p>Olá {{nome}}</p><a href="{{link}}">Confirmar</a>', id_assinatura: null, ativo: 1 }]];
    };
    bcrypt.hash = async () => 'hash';
    mailTransporter.sendMail = async mensagem => { eventos.push('email'); return { accepted: [mensagem.to] }; };
    const connection = {
        beginTransaction: async () => eventos.push('begin'),
        commit: async () => eventos.push('commit'), rollback: async () => eventos.push('rollback'),
        release: () => eventos.push('release'),
        query: async sql => {
            if (sql.includes('SELECT id_usuario, email, cpf')) return [existentes];
            if (sql.includes('INSERT INTO ist_usuarios')) { eventos.push('insert'); if (erroInsert) throw erroInsert; return [{ insertId: 1 }]; }
            if (sql.includes('FROM ist_eventos')) return [[{ id: 1, slug: 'ii-festival-de-violoes-sebastiao-tapajos' }]];
            if (sql.includes('INSERT INTO ist_concorrentes')) { if (erroConcorrente) throw erroConcorrente; return [{}]; }
            throw new Error('Consulta não simulada');
        }
    };
    pool.getConnection = async () => connection;
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(data) { this.body = data; return this; } };
    await usuarios.cadastrar({ body: { ...body, ...(concorrente ? { cadastroTipo: 'concorrente' } : {}) } }, res);
    return { res, eventos };
}

test('CPF já existente retorna 409, com rollback e sem confirmação', async t => {
    const { res, eventos } = await executar(t, { existentes: [{ cpf: body.cpf, email: 'outro@example.org' }] });
    assert.equal(res.statusCode, 409); assert.equal(res.body.message, 'Este CPF já está cadastrado.');
    assert.deepEqual(eventos, ['begin', 'rollback', 'release']);
});

test('e-mail preexistente tem prioridade mesmo quando CPF também existe', async t => {
    const { res, eventos } = await executar(t, { existentes: [{ cpf: body.cpf, email: body.email }] });
    assert.equal(res.statusCode, 200); assert.equal(res.body.message, neutra);
    assert.deepEqual(eventos, ['begin', 'rollback', 'release']);
});

for (const chave of ['cpf_unico', 'ist_usuarios.cpf_unico']) {
    test(`conflito concorrente da chave ${chave} retorna 409`, async t => {
        const { res, eventos } = await executar(t, { erroInsert: duplicado(chave) });
        assert.equal(res.statusCode, 409); assert.equal(res.body.message, 'Este CPF já está cadastrado.');
        assert.deepEqual(eventos, ['begin', 'insert', 'rollback', 'release']);
    });
}

for (const chave of ['email_unico', 'ist_usuarios.email_unico', 'outro_cpf_unico', 'PRIMARY']) {
    test(`conflito da chave ${chave} não é classificado como CPF`, async t => {
        const { res, eventos } = await executar(t, { erroInsert: duplicado(chave) });
        assert.equal(res.statusCode, 200); assert.equal(res.body.message, neutra);
        assert.deepEqual(eventos, ['begin', 'insert', 'rollback', 'release']);
    });
}

test('cadastro válido confirma transação antes de enviar e-mail', async t => {
    const { res, eventos } = await executar(t);
    assert.equal(res.statusCode, 200); assert.equal(res.body.message, neutra);
    assert.deepEqual(eventos, ['begin', 'insert', 'commit', 'release', 'email']);
});

test('duplicidade em outra inserção da transação não é classificada como CPF', async t => {
    const { res, eventos } = await executar(t, { concorrente: true, erroConcorrente: duplicado('cpf_unico') });
    assert.equal(res.statusCode, 200); assert.equal(res.body.message, neutra);
    assert.deepEqual(eventos, ['begin', 'insert', 'rollback', 'release']);
});
