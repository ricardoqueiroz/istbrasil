import assert from 'node:assert/strict';
import test from 'node:test';
import { EmailComposicaoError, comporEmail } from '../src/services/emailTemplateService.js';

const modeloBase = (extra = {}) => ({
    idModelo: 1,
    chave: 'confirmacao_email',
    assunto: 'Confirme seu cadastro',
    conteudoHtml: '<p>Ola {{nome}}</p><p><a href="{{link}}">Confirmar</a></p>',
    idAssinatura: null,
    ativo: true,
    ...extra
});

const variaveisValidas = { nome: 'Joao', link: 'https://istbrasil.org.br/confirmar?token=abc' };

const capturarCodigo = (fn) => {
    try {
        fn();
    } catch (error) {
        assert.ok(error instanceof EmailComposicaoError, `esperava EmailComposicaoError, veio ${error}`);
        return error.codigo;
    }
    return null;
};

test('substitui texto e URL corretamente', () => {
    const { html, assunto } = comporEmail({ modelo: modeloBase(), variaveis: variaveisValidas });
    assert.match(html, /Ola Joao/);
    assert.match(html, /href="https:\/\/istbrasil\.org\.br\/confirmar\?token=abc"/);
    assert.equal(assunto, 'Confirme seu cadastro');
});

test('placeholder repetido e substituido em todas as ocorrencias', () => {
    const modelo = modeloBase({ conteudoHtml: '<p>{{nome}} e {{nome}} novamente</p>' });
    const { html } = comporEmail({ modelo, variaveis: { nome: 'Ana' } });
    assert.match(html, /Ana e Ana novamente/);
});

test('caracteres especiais nao sofrem double escaping', () => {
    const modelo = modeloBase({ conteudoHtml: '<p>{{nome}}</p>' });
    const { html, text } = comporEmail({ modelo, variaveis: { nome: 'A & B < C' } });
    assert.match(html, /A &amp; B &lt; C/);
    assert.doesNotMatch(html, /&amp;amp;/);
    assert.match(text, /A & B < C/);
});

test('XSS em variavel de texto vira conteudo inerte', () => {
    const modelo = modeloBase({ conteudoHtml: '<p>{{nome}}</p>' });
    const { html } = comporEmail({ modelo, variaveis: { nome: 'Joao <script>alert(1)</script>' } });
    assert.doesNotMatch(html, /<script/i);
    assert.match(html, /&lt;script&gt;/);
});

test('assunto aceita placeholder de texto', () => {
    const modelo = modeloBase({ assunto: 'Ola {{nome}}, confirme', conteudoHtml: '<p>corpo</p>' });
    const { assunto } = comporEmail({ modelo, variaveis: { nome: 'Ana' } });
    assert.equal(assunto, 'Ola Ana, confirme');
});

test('assunto rejeita CR/LF na variavel', () => {
    const modelo = modeloBase({ assunto: 'Ola {{nome}}', conteudoHtml: '<p>corpo</p>' });
    const codigo = capturarCodigo(() => comporEmail({ modelo, variaveis: { nome: 'Ana\r\nBcc: x@y.z' } }));
    assert.equal(codigo, 'VARIAVEL_INVALIDA');
});

test('aceita http e https', () => {
    for (const link of ['http://istbrasil.org.br/a', 'https://istbrasil.org.br/a']) {
        const { html } = comporEmail({ modelo: modeloBase(), variaveis: { ...variaveisValidas, link } });
        assert.match(html, /href="http/);
    }
});

test('rejeita protocolos e URLs invalidas', () => {
    for (const link of ['javascript:alert(1)', 'data:text/html,<script>1</script>', 'file:///etc/passwd', '//istbrasil.org.br/a', '/relativo']) {
        const codigo = capturarCodigo(() => comporEmail({ modelo: modeloBase(), variaveis: { ...variaveisValidas, link } }));
        assert.equal(codigo, 'URL_INVALIDA', `esperava URL_INVALIDA para ${link}`);
    }
});

test('placeholder ausente falha', () => {
    const codigo = capturarCodigo(() => comporEmail({ modelo: modeloBase(), variaveis: { nome: 'Joao' } }));
    assert.equal(codigo, 'PLACEHOLDER_AUSENTE');
});

test('placeholder fora do catalogo falha', () => {
    const modelo = modeloBase({ conteudoHtml: '<p>{{senha}}</p>' });
    const codigo = capturarCodigo(() => comporEmail({ modelo, variaveis: { senha: 'x' } }));
    assert.equal(codigo, 'PLACEHOLDER_DESCONHECIDO');
});

test('variavel excedente falha', () => {
    const codigo = capturarCodigo(() => comporEmail({ modelo: modeloBase(), variaveis: { ...variaveisValidas, foo: 'bar' } }));
    assert.equal(codigo, 'VARIAVEL_EXCEDENTE');
});

test('chave sem catalogo falha', () => {
    const modelo = modeloBase({ chave: 'inexistente', conteudoHtml: '<p>oi</p>' });
    const codigo = capturarCodigo(() => comporEmail({ modelo, variaveis: {} }));
    assert.equal(codigo, 'SEM_CATALOGO');
});

test('modelo inativo falha em uso operacional e avisa no preview', () => {
    const modelo = modeloBase({ ativo: false });
    assert.equal(capturarCodigo(() => comporEmail({ modelo, variaveis: variaveisValidas })), 'MODELO_INATIVO');

    const { avisos } = comporEmail({ modelo, variaveis: variaveisValidas, permitirInativo: true });
    assert.ok(avisos.some((aviso) => aviso.codigo === 'modelo_inativo'));
});

test('assinatura ativa e anexada e inativa e omitida com aviso', () => {
    const assinaturaAtiva = { conteudoHtml: '<p>IST Brasil</p>', ativo: true };
    const comAssinatura = comporEmail({ modelo: modeloBase(), assinatura: assinaturaAtiva, variaveis: variaveisValidas });
    assert.match(comAssinatura.html, /IST Brasil/);
    assert.equal(comAssinatura.avisos.length, 0);

    const assinaturaInativa = { conteudoHtml: '<p>Antiga</p>', ativo: false };
    const semAssinatura = comporEmail({ modelo: modeloBase(), assinatura: assinaturaInativa, variaveis: variaveisValidas });
    assert.doesNotMatch(semAssinatura.html, /Antiga/);
    assert.ok(semAssinatura.avisos.some((aviso) => aviso.codigo === 'assinatura_inativa'));
});

test('sem assinatura compoe apenas o modelo', () => {
    const { html, avisos } = comporEmail({ modelo: modeloBase(), assinatura: null, variaveis: variaveisValidas });
    assert.doesNotMatch(html, /margin-top/);
    assert.equal(avisos.length, 0);
});

test('sanitizacao final remove construcoes proibidas do modelo', () => {
    const modelo = modeloBase({ conteudoHtml: '<p onclick="alert(1)">{{nome}}</p><iframe src="https://x"></iframe><p><a href="{{link}}">ir</a></p>' });
    const { html } = comporEmail({ modelo, variaveis: variaveisValidas });
    assert.doesNotMatch(html, /onclick/i);
    assert.doesNotMatch(html, /<iframe/i);
});

test('placeholder de URL fora de href falha', () => {
    const modelo = modeloBase({ conteudoHtml: '<p>Acesse {{link}}</p>' });
    const codigo = capturarCodigo(() => comporEmail({ modelo, variaveis: { link: variaveisValidas.link } }));
    assert.equal(codigo, 'URL_CONTEXTO_INVALIDO');
});

test('placeholder de texto dentro de href falha', () => {
    const modelo = modeloBase({ conteudoHtml: '<p><a href="{{nome}}">x</a></p>' });
    const codigo = capturarCodigo(() => comporEmail({ modelo, variaveis: { nome: 'Joao' } }));
    assert.equal(codigo, 'URL_CONTEXTO_INVALIDO');
});

test('href com placeholder concatenado falha', () => {
    const modelo = modeloBase({ conteudoHtml: '<p><a href="https://x.org/{{link}}">x</a></p>' });
    const codigo = capturarCodigo(() => comporEmail({ modelo, variaveis: { link: variaveisValidas.link } }));
    assert.equal(codigo, 'URL_CONTEXTO_INVALIDO');
});

test('variaveis com chaves perigosas ou valores nao string falham', () => {
    assert.equal(
        capturarCodigo(() => comporEmail({ modelo: modeloBase(), variaveis: { ...variaveisValidas, nome: 123 } })),
        'VARIAVEL_INVALIDA'
    );
    const perigoso = { ...variaveisValidas };
    Object.defineProperty(perigoso, '__proto__', { value: 'x', enumerable: true, configurable: true });
    assert.equal(capturarCodigo(() => comporEmail({ modelo: modeloBase(), variaveis: perigoso })), 'VARIAVEL_INVALIDA');
});

test('gera versao texto legivel com quebras', () => {
    const modelo = modeloBase({ conteudoHtml: '<p>Ola {{nome}}</p><p>Segunda linha</p><p><a href="{{link}}">Confirmar</a></p>' });
    const { text } = comporEmail({ modelo, variaveis: variaveisValidas });
    assert.doesNotMatch(text, /</);
    assert.match(text, /Ola Joao\nSegunda linha/);
});
