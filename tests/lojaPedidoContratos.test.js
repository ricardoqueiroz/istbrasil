import test from 'node:test';
import assert from 'node:assert/strict';
import {
    CONTRATO_PEDIDO, ESTADOS_PEDIDO, ERROS_PEDIDO, criarErroPedido, erroPedidoPublico,
    normalizarEmailComprador, validarSolicitacaoPedido, validarChaveIdempotencia,
    canonicalizarSolicitacaoPedido, gerarHashSolicitacaoPedido, pedidoPublico
} from '../src/services/lojaPedidoContratos.js';

const chave = 'aabbccdd-1122-4333-8abc-123456789abc';
const solicitacao = (produtoIds = [1, 2], compradorEmail = 'Cliente@example.com') => ({ produtoIds, compradorEmail });
const erroCom = (codigo) => (erro) => erro instanceof Error && erro.codigo === codigo
    && erro.status === ERROS_PEDIDO[codigo].status && erro.message === ERROS_PEDIDO[codigo].mensagem;

test('contrato preserva as decisoes aprovadas sem estado mutavel', () => {
    assert.deepEqual(CONTRATO_PEDIDO, {
        versaoContrato: 1, estadoInicial: 'CRIADO', versaoInicial: 1, ambienteInicial: 'sandbox', moeda: 'BRL',
        maxProdutos: 100, sessaoDuracaoSegundos: 86400, pedidoValidadeSegundos: 1800, cotacaoAtualizacaoSegundos: 300
    });
    assert(Object.isFrozen(CONTRATO_PEDIDO));
    assert(Object.isFrozen(ESTADOS_PEDIDO));
    assert.equal(ESTADOS_PEDIDO.length, 9);
});
for (const ids of [[1], [1, 2], [2147483647]]) test(`aceita solicitacao valida: ${ids}`, () => {
    assert.deepEqual(validarSolicitacaoPedido(solicitacao(ids)), solicitacao(ids));
});
test('normaliza em nova estrutura, ordena numericamente e nao modifica a entrada congelada', () => {
    const entrada = Object.freeze({ produtoIds: Object.freeze([10, 2, 1]), compradorEmail: '  Cliente@EXAMPLE.COM  ' });
    const saida = validarSolicitacaoPedido(entrada);
    assert.deepEqual(saida, solicitacao([1, 2, 10]));
    assert.deepEqual(entrada.produtoIds, [10, 2, 1]);
    assert.notEqual(saida, entrada); assert.notEqual(saida.produtoIds, entrada.produtoIds);
});
test('aceita exatamente 100 produtos distintos', () => {
    const ids = Array.from({ length: 100 }, (_, i) => i + 1);
    assert.deepEqual(validarSolicitacaoPedido(solicitacao(ids)).produtoIds, ids);
});
for (const [nome, ids] of [
    ['duplicados', [1, 1]], ['vazio', []], ['mais de 100', Array.from({ length: 101 }, (_, i) => i + 1)],
    ['selecao ausente', undefined], ['objeto', { 0: 1 }], ['array esparso', new Array(1)]
]) test(`rejeita selecao ${nome}`, () => {
    assert.throws(() => validarSolicitacaoPedido({ produtoIds: ids, compradorEmail: 'Cliente@example.com' }), erroCom('SELECAO_INVALIDA'));
});
for (const id of [0, -1, 1.5, 2147483648, Number.MAX_SAFE_INTEGER, NaN, Infinity, '1', null, {}, true, 1n]) {
    test(`rejeita ID ${String(id)}`, () => assert.throws(() => validarSolicitacaoPedido(solicitacao([id])), erroCom('SELECAO_INVALIDA')));
}
for (const [nome, entrada] of [
    ['nulo', null], ['array', []], ['string', 'pedido'], ['objeto vazio', {}],
    ['sem email', { produtoIds: [1] }], ['sem selecao', { compradorEmail: 'a@example.com' }],
    ['prototipo customizado', Object.assign(Object.create({ herdado: true }), solicitacao())]
]) test(`rejeita envelope ${nome}`, () => {
    assert.throws(() => validarSolicitacaoPedido(entrada), erroCom('SOLICITACAO_INVALIDA'));
});
for (const campo of ['quantidade', 'preco', 'precoCentavos', 'total', 'totalCentavos', 'moeda', 'estado', 'ambiente', 'idempotencia', 'extra']) {
    test(`rejeita campo adicional ${campo}`, () => {
        assert.throws(() => validarSolicitacaoPedido({ ...solicitacao(), [campo]: 1 }), erroCom('SOLICITACAO_INVALIDA'));
    });
}
test('rejeita propriedades ocultas, simbolos e getters sem executa-los', () => {
    const oculto = Object.defineProperty(solicitacao(), 'preco', { value: 1 });
    assert.throws(() => validarSolicitacaoPedido(oculto), erroCom('SOLICITACAO_INVALIDA'));
    const simbolo = { ...solicitacao(), [Symbol('extra')]: 1 };
    assert.throws(() => validarSolicitacaoPedido(simbolo), erroCom('SOLICITACAO_INVALIDA'));
    let executado = false;
    const getter = { compradorEmail: 'a@example.com', get produtoIds() { executado = true; return [1]; } };
    assert.throws(() => validarSolicitacaoPedido(getter), erroCom('SOLICITACAO_INVALIDA')); assert.equal(executado, false);
});
test('rejeita campos extras no array e acesso indireto ao ID', () => {
    const ids = Object.assign([1], { preco: 1 });
    assert.throws(() => validarSolicitacaoPedido(solicitacao(ids)), erroCom('SELECAO_INVALIDA'));
    let executado = false;
    const getter = Object.defineProperty([1], '0', { get() { executado = true; return 1; } });
    assert.throws(() => validarSolicitacaoPedido(solicitacao(getter)), erroCom('SELECAO_INVALIDA')); assert.equal(executado, false);
});

for (const email of ['cliente@example.com', 'Nome.Sobrenome+loja@example.com', "o'neil@example.com", 'cliente@xn--exemplo-9za.com']) {
    test(`aceita email simples suportado ${email}`, () => assert.equal(normalizarEmailComprador(email), email));
}
test('remove espacos externos e preserva a parte local ao normalizar dominio', () => {
    assert.equal(normalizarEmailComprador('  Cliente.Sobrenome+IST@EXAMPLE.COM  '), 'Cliente.Sobrenome+IST@example.com');
});
const emailLimite = 'a'.repeat(64) + '@' + 'b'.repeat(63) + '.' + 'c'.repeat(63) + '.' + 'd'.repeat(61);
test('aceita limite de 254 caracteres', () => { assert.equal(emailLimite.length, 254); assert.equal(normalizarEmailComprador(emailLimite), emailLimite); });
for (const [nome, email] of [
    ['255 caracteres', emailLimite + 'd'], ['local com 65 caracteres', 'a'.repeat(65) + '@example.com'],
    ['label com 64 caracteres', 'a@' + 'b'.repeat(64) + '.com'],
    ['CRLF externo', '\r\na@example.com'], ['CRLF interno', 'a@example.com\r\nBcc:x@example.com'],
    ['tab externo', '\ta@example.com'], ['NUL', 'a\u0000@example.com'], ['DEL', 'a\u007f@example.com'],
    ['controle C1', 'a\u0085@example.com'], ['espaco interno', 'nome sobrenome@example.com'],
    ['nome de apresentacao', 'Nome <a@example.com>'], ['local entre aspas', '"nome"@example.com'],
    ['SMTPUTF8', 'joão@example.com'], ['dominio Unicode', 'a@exémplo.com'], ['literal IP', 'a@[127.0.0.1]'],
    ['dominio sem ponto', 'a@localhost'], ['ponto inicial', '.a@example.com'], ['ponto final', 'a.@example.com'],
    ['pontos consecutivos', 'a..b@example.com'], ['dominio vazio', 'a@'], ['dois arrobas', 'a@@example.com'],
    ['label com hifen inicial', 'a@-example.com'], ['label com hifen final', 'a@example-.com'],
    ['underscore no dominio', 'a@ex_ample.com'], ['string vazia', ''], ['valor nao textual', null]
]) test(`rejeita email: ${nome}`, () => assert.throws(() => normalizarEmailComprador(email), erroCom('EMAIL_INVALIDO')));

test('UUID v4 valido e normalizado para minusculas', () => {
    assert.equal(validarChaveIdempotencia(chave), chave);
    assert.equal(validarChaveIdempotencia(chave.toUpperCase()), chave);
});
for (const valor of [chave.replace('-4333-', '-1333-'), chave.replace('-8abc-', '-7abc-'), chave.replaceAll('-', ''),
    '00000000-0000-0000-0000-000000000000', chave + '\n', ' ' + chave, chave + ' ', '', null, [chave]]) {
    test(`UUID invalido: ${JSON.stringify(valor)}`, () => assert.throws(() => validarChaveIdempotencia(valor), erroCom('IDEMPOTENCIA_INVALIDA')));
}
test('canonicalizacao possui ordem fixa, versao explicita e apenas campos aprovados', () => {
    const texto = canonicalizarSolicitacaoPedido(solicitacao([2, 1], ' Cliente@EXAMPLE.COM '), 'sandbox');
    assert.equal(texto, '{"versaoContrato":1,"compradorEmail":"Cliente@example.com","produtoIds":[1,2],"ambiente":"sandbox"}');
});
test('SHA-256 binario corresponde a vetor conhecido e retorna 32 bytes novos', () => {
    const primeiro = gerarHashSolicitacaoPedido(solicitacao(), 'sandbox');
    const segundo = gerarHashSolicitacaoPedido(solicitacao(), 'sandbox');
    assert(Buffer.isBuffer(primeiro)); assert.equal(primeiro.length, 32); assert.notEqual(primeiro, segundo);
    assert.equal(primeiro.toString('hex'), '7a46e93c9d6afef1698e5dba0a9cb2d0ae1ed2ee6fe8b461c274e16dc5111e8e');
    assert.deepEqual(primeiro, segundo);
});
test('hash independe da ordem dos IDs e da ordem das propriedades do envelope', () => {
    assert.deepEqual(gerarHashSolicitacaoPedido(solicitacao([1, 2]), 'sandbox'), gerarHashSolicitacaoPedido({ compradorEmail: 'Cliente@example.com', produtoIds: [2, 1] }, 'sandbox'));
});
test('normalizacao equivalente do email produz o mesmo hash', () => {
    assert.deepEqual(gerarHashSolicitacaoPedido(solicitacao(), 'sandbox'), gerarHashSolicitacaoPedido(solicitacao([2, 1], ' Cliente@EXAMPLE.COM '), 'sandbox'));
});
for (const [nome, entrada, ambiente] of [
    ['selecao', solicitacao([1]), 'sandbox'], ['email', solicitacao([1, 2], 'outro@example.com'), 'sandbox'],
    ['caixa da parte local', solicitacao([1, 2], 'cliente@example.com'), 'sandbox'], ['ambiente', solicitacao(), 'live']
]) test(`hash muda com ${nome}`, () => {
    assert.notDeepEqual(gerarHashSolicitacaoPedido(solicitacao(), 'sandbox'), gerarHashSolicitacaoPedido(entrada, ambiente));
});
test('ambiente deve ser fornecido explicitamente pelo servidor e nao pelo payload', () => {
    for (const ambiente of [undefined, 'production', 'SANDBOX', ' sandbox ', {}]) assert.throws(() => canonicalizarSolicitacaoPedido(solicitacao(), ambiente), erroCom('ERRO_INTERNO'));
    assert.throws(() => gerarHashSolicitacaoPedido({ ...solicitacao(), ambiente: 'sandbox' }, 'sandbox'), erroCom('SOLICITACAO_INVALIDA'));
});

const dadosInternos = () => ({
    pedido: { id: 100, sessao_id: 50, public_id: chave, estado: 'CRIADO', versao: 1, moeda: 'BRL', total_centavos: '19000',
        criado_em: '2026-10-15T12:00:00.123Z', expira_em: '2026-10-15T12:30:00.123Z',
        comprador_email: 'CANARY_EMAIL@example.invalid', solicitacao_hash: 'CANARY_HASH', token_hash: 'CANARY_TOKEN',
        paypal_id: 'CANARY_PROVIDER', file: '/private/CANARY.pdf' },
    itens: [1, 2].map((id) => ({ id: id + 200, pedido_id: 100, produto_id: id, posicao: id,
        sku_snapshot: `SKU${id}`, titulo_snapshot: `Titulo ${id}`, descricao_snapshot: 'CANARY_DESCRICAO',
        tipo_snapshot: 'LIVRO_DIGITAL', quantidade: 1, preco_unitario_centavos: '9500', subtotal_centavos: 9500n,
        file: '/private/CANARY.pdf', token: 'CANARY_TOKEN' }))
});
test('resposta publica usa whitelist e somente snapshots comerciais', () => {
    const { pedido, itens } = dadosInternos(); const dto = pedidoPublico(pedido, itens);
    assert.deepEqual(Object.keys(dto), ['publicId', 'estado', 'versao', 'moeda', 'totalCentavos', 'criadoEm', 'expiraEm', 'itens']);
    assert.deepEqual(Object.keys(dto.itens[0]), ['produtoId', 'sku', 'titulo', 'tipo', 'quantidade', 'precoUnitarioCentavos', 'subtotalCentavos']);
    assert.deepEqual(dto.itens[0], { produtoId: 1, sku: 'SKU1', titulo: 'Titulo 1', tipo: 'LIVRO_DIGITAL', quantidade: 1, precoUnitarioCentavos: 9500, subtotalCentavos: 9500 });
    assert.equal(dto.totalCentavos, 19000); assert.equal(dto.criadoEm, pedido.criado_em);
    assert(!JSON.stringify(dto).includes('CANARY')); assert(!JSON.stringify(dto).includes('/private'));
});
test('ordena itens por posicao sem modificar linhas internas', () => {
    const { pedido, itens } = dadosInternos(); itens.reverse(); itens.forEach(Object.freeze); Object.freeze(itens); Object.freeze(pedido);
    assert.deepEqual(pedidoPublico(pedido, itens).itens.map((i) => i.produtoId), [1, 2]);
    assert.deepEqual(itens.map((i) => i.produto_id), [2, 1]);
});
test('nao inventa valores obrigatorios ausentes', () => {
    for (const campo of ['public_id', 'estado', 'versao', 'moeda', 'total_centavos', 'criado_em', 'expira_em']) {
        const { pedido, itens } = dadosInternos(); delete pedido[campo];
        assert.throws(() => pedidoPublico(pedido, itens), erroCom('ERRO_INTERNO'));
    }
    for (const campo of ['produto_id', 'posicao', 'sku_snapshot', 'titulo_snapshot', 'tipo_snapshot', 'quantidade', 'preco_unitario_centavos', 'subtotal_centavos']) {
        const { pedido, itens } = dadosInternos(); delete itens[0][campo];
        assert.throws(() => pedidoPublico(pedido, itens), erroCom('ERRO_INTERNO'));
    }
});
test('nao calcula o total oficial na projecao publica', () => {
    const { pedido, itens } = dadosInternos(); pedido.total_centavos = 18000;
    assert.equal(pedidoPublico(pedido, itens).totalCentavos, 18000);
});
for (const valor of [0, -1, 9500.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '18446744073709551615', '95.00', null]) {
    test(`resposta rejeita total nao representavel: ${String(valor)}`, () => {
        const { pedido, itens } = dadosInternos(); pedido.total_centavos = valor;
        assert.throws(() => pedidoPublico(pedido, itens), erroCom('ERRO_INTERNO'));
    });
}
test('aceita centavos ate o limite inteiro seguro sem arredondar', () => {
    const { pedido, itens } = dadosInternos(); pedido.total_centavos = String(Number.MAX_SAFE_INTEGER);
    assert.equal(pedidoPublico(pedido, itens).totalCentavos, Number.MAX_SAFE_INTEGER);
});
test('resposta rejeita moeda, estado, versao ou identificador invalidos', () => {
    for (const [campo, valor] of [['moeda', 'USD'], ['estado', 'FINALIZADO'], ['versao', 0], ['versao', 4294967296], ['public_id', chave + '\n']]) {
        const { pedido, itens } = dadosInternos(); pedido[campo] = valor;
        assert.throws(() => pedidoPublico(pedido, itens), erroCom('ERRO_INTERNO'));
    }
});
test('resposta exige UTC explicito e datas reais coerentes', () => {
    for (const data of ['2026-10-15 12:00:00.123', '2026-10-15T09:00:00.123-03:00', '2026-02-30T12:00:00.123Z', 'nao-data', new Date('2026-10-15T12:00:00Z')]) {
        const { pedido, itens } = dadosInternos(); pedido.criado_em = data;
        assert.throws(() => pedidoPublico(pedido, itens), erroCom('ERRO_INTERNO'));
    }
    const { pedido, itens } = dadosInternos(); pedido.expira_em = pedido.criado_em;
    assert.throws(() => pedidoPublico(pedido, itens), erroCom('ERRO_INTERNO'));
});
test('resposta rejeita itens ausentes, duplicados ou inconsistentes', () => {
    const { pedido } = dadosInternos();
    for (const itens of [undefined, [], [null]]) assert.throws(() => pedidoPublico(pedido, itens), erroCom('ERRO_INTERNO'));
    for (const [campo, valor] of [['produto_id', 2], ['posicao', 2], ['posicao', 0], ['quantidade', 2], ['preco_unitario_centavos', 0], ['subtotal_centavos', 9499], ['titulo_snapshot', null]]) {
        const { pedido, itens } = dadosInternos(); itens[0][campo] = valor;
        assert.throws(() => pedidoPublico(pedido, itens), erroCom('ERRO_INTERNO'));
    }
});
test('todos os estados existentes sao projetados sem alteracao', () => {
    for (const estado of ESTADOS_PEDIDO) {
        const { pedido, itens } = dadosInternos(); pedido.estado = estado;
        assert.equal(pedidoPublico(pedido, itens).estado, estado);
    }
});
test('erros de dominio sao estaveis, seguros e possuem status sem middleware', () => {
    for (const [codigo, definicao] of Object.entries(ERROS_PEDIDO)) {
        const erro = criarErroPedido(codigo); assert(erroCom(codigo)(erro));
        assert(Object.isFrozen(definicao));
        assert.deepEqual(erroPedidoPublico(erro), { erro: { codigo, mensagem: definicao.mensagem } });
    }
});
test('envelope de erro descarta SQL, stack, tokens e mensagens externas', () => {
    const erro = Object.assign(new Error('SELECT segredo /private/CANARY.pdf'), { codigo: 'CONFLITO_IDEMPOTENCIA', status: 200, token: 'CANARY' });
    assert.deepEqual(erroPedidoPublico(erro), { erro: { codigo: 'CONFLITO_IDEMPOTENCIA', mensagem: ERROS_PEDIDO.CONFLITO_IDEMPOTENCIA.mensagem } });
    for (const codigo of ['ER_PARSE_ERROR', '__proto__', undefined]) {
        const publico = erroPedidoPublico({ codigo, message: erro.message, stack: erro.stack });
        assert.deepEqual(publico, { erro: { codigo: 'ERRO_INTERNO', mensagem: ERROS_PEDIDO.ERRO_INTERNO.mensagem } });
        assert(!JSON.stringify(publico).includes('CANARY'));
    }
    assert.equal(criarErroPedido('CODIGO_DESCONHECIDO').codigo, 'ERRO_INTERNO');
});
