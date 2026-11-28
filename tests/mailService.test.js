import test from 'node:test';
import assert from 'node:assert/strict';
import { enviarEmail, mailTransporter, sendAccountMail, sendMail } from '../src/services/mailService.js';
import contactController from '../src/controllers/contactController.js';

function ambiente(t, valor) {
    const anterior = process.env.MAIL_FROM_ADDRESS;
    if (valor === undefined) delete process.env.MAIL_FROM_ADDRESS;
    else process.env.MAIL_FROM_ADDRESS = valor;
    t.after(() => {
        if (anterior === undefined) delete process.env.MAIL_FROM_ADDRESS;
        else process.env.MAIL_FROM_ADDRESS = anterior;
    });
}

function capturarEnvios(t) {
    const anterior = mailTransporter.sendMail;
    const mensagens = [];
    mailTransporter.sendMail = async mensagem => { mensagens.push(mensagem); return { accepted: [mensagem.to] }; };
    t.after(() => { mailTransporter.sendMail = anterior; });
    return mensagens;
}

test('contato usa remetente configurado para todos os assuntos e preserva mensagem e resposta', async t => {
    ambiente(t, 'remetente@example.org');
    const mensagens = capturarEnvios(t);
    for (const assunto of ['Dúvida', 'Solicitação', 'Parceria', 'Outro assunto', 'Outro']) {
        let resposta;
        const req = { body: { name: 'Nome', email: 'pessoa@example.org', subject: assunto, message: 'Linha 1\nLinha 2' } };
        const res = { json: valor => { resposta = valor; } };
        await contactController.sendContact(req, res);
        assert.deepEqual(resposta, { success: true });
        const mensagem = mensagens.at(-1);
        assert.deepEqual(mensagem.from, { name: 'Contato IST Brasil', address: 'remetente@example.org' });
        assert.equal(mensagem.to, 'presidencia@istbrasil.org.br');
        assert.equal(mensagem.subject, `[Fale Conosco] ${assunto}`);
        assert.equal(mensagem.replyTo, 'Nome <pessoa@example.org>');
        assert.equal(mensagem.html, `
                <p><strong>Nome:</strong> Nome</p>
                <p><strong>E-mail:</strong> pessoa@example.org</p>
                <p><strong>Assunto:</strong> ${assunto}</p>
                <hr>
                <p>Linha 1<br>Linha 2</p>
            `);
    }
    assert.equal(mensagens.length, 5);
});

test('envio de conta preserva destinatário e conteúdo com remetente configurado', async t => {
    ambiente(t, 'remetente@example.org');
    const mensagens = capturarEnvios(t);
    await sendAccountMail({ to: 'usuario@example.org', subject: 'Cadastro', html: '<p>Olá</p>' });
    assert.equal(mensagens[0].from.address, 'remetente@example.org');
    assert.equal(mensagens[0].to, 'usuario@example.org');
    assert.equal(mensagens[0].subject, 'Cadastro');
    assert.equal(mensagens[0].html, '<p>Olá</p>');
});

for (const valor of [undefined, '', '   ']) {
    test(`remetente obrigatório ausente (${JSON.stringify(valor)}) impede envio`, async t => {
        ambiente(t, valor);
        const mensagens = capturarEnvios(t);
        await assert.rejects(sendMail({ subject: 'Dúvida', html: '<p>Mensagem</p>' }), /MAIL_FROM_ADDRESS não configurado/);
        await assert.rejects(sendAccountMail({ to: 'usuario@example.org', subject: 'Cadastro', html: '<p>Olá</p>' }), /MAIL_FROM_ADDRESS não configurado/);
        assert.equal(mensagens.length, 0);
    });
}

test('enviarEmail preserva remetente explícito e transporte injetado sem variável de ambiente', async t => {
    ambiente(t, undefined);
    let recebida;
    const transporte = { sendMail: async mensagem => { recebida = mensagem; return 'enviado'; } };
    const resultado = await enviarEmail({ to: 'pessoa@example.org', subject: 'Assunto', text: 'Conteúdo',
        fromName: 'Nome', fromAddress: 'explicito@example.org', replyTo: 'resposta@example.org' }, transporte);
    assert.equal(resultado, 'enviado');
    assert.deepEqual(recebida, { from: { name: 'Nome', address: 'explicito@example.org' }, to: 'pessoa@example.org',
        subject: 'Assunto', text: 'Conteúdo', replyTo: 'resposta@example.org' });
});
