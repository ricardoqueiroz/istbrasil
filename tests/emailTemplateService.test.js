import assert from 'node:assert/strict';
import test from 'node:test';
import { obterCatalogo, CHAVE_RECUPERACAO_BIBLIOTECA_CODIGO, ASSUNTO_RECUPERACAO_BIBLIOTECA_CODIGO } from '../src/config/emailPlaceholders.js';
import { EmailComposicaoError, comporEmail, comporEmailPorChave, comporEmailPorId, obterPlaceholdersDoModelo } from '../src/services/emailTemplateService.js';

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

const variaveisInscricaoFestival = {
    nome: 'Maria da Silva',
    numero_concorrente: '042',
    email: 'maria@example.com',
    telefone: '(93) 99999-9999',
    data_nascimento: '10/05/1990',
    cidade: 'Santarém',
    uf: 'PA',
    musica_1: 'Catraias',
    video_1: 'https://www.youtube.com/watch?v=abcdefghijk',
    musica_2: 'Não informada',
    video_2: 'Não informado'
};

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

test('catalogo da confirmacao de inscricao define todos os placeholders escalares obrigatorios', () => {
    const catalogo = obterCatalogo('confirmacao_inscricao_festival');
    const nomesEsperados = [
        'nome',
        'numero_concorrente',
        'email',
        'telefone',
        'data_nascimento',
        'cidade',
        'uf',
        'musica_1',
        'video_1',
        'musica_2',
        'video_2'
    ];

    assert.ok(catalogo);
    assert.deepEqual(Object.keys(catalogo), nomesEsperados);
    for (const nome of nomesEsperados) {
        assert.equal(catalogo[nome].tipo, 'texto');
        assert.equal(catalogo[nome].obrigatorio, true);
        assert.equal(typeof catalogo[nome].descricao, 'string');
        assert.ok(catalogo[nome].descricao.length > 0);
    }
});

test('compoe confirmacao de inscricao com fallback da segunda musica e escape dos valores', () => {
    const modelo = modeloBase({
        chave: 'confirmacao_inscricao_festival',
        assunto: 'Inscrição de {{nome}} - concorrente {{numero_concorrente}}',
        conteudoHtml: `<p>{{nome}}</p><p>{{numero_concorrente}}</p><p>{{email}}</p>
            <p>{{telefone}}</p><p>{{data_nascimento}}</p><p>{{cidade}}/{{uf}}</p>
            <p>{{musica_1}}</p><p>{{video_1}}</p><p>{{musica_2}}</p><p>{{video_2}}</p>`
    });
    const variaveis = {
        ...variaveisInscricaoFestival,
        nome: 'Maria <script>alert(1)</script> & Silva'
    };

    const { assunto, html, text } = comporEmail({ modelo, variaveis });

    assert.equal(assunto, 'Inscrição de Maria <script>alert(1)</script> & Silva - concorrente 042');
    assert.doesNotMatch(html, /<script>/i);
    assert.match(html, /Maria &lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; Silva/);
    assert.match(html, /Não informada/);
    assert.match(html, /Não informado/);
    assert.match(text, /Catraias/);
    assert.match(text, /Não informada/);
});

const modeloRecuperacao = (extra = {}) => ({
    chave: CHAVE_RECUPERACAO_BIBLIOTECA_CODIGO, assunto: ASSUNTO_RECUPERACAO_BIBLIOTECA_CODIGO, ativo: true,
    conteudoHtml: '<p>Pedido {{pedido_public_id}}</p><p>Código: <strong>{{codigo}}</strong></p><p>Válido por {{validade_minutos}} minutos.</p><p><a href="{{link_acesso}}">Entrar na biblioteca</a></p>',
    idAssinatura: null, ...extra
});
const variaveisRecuperacao = {
    pedido_public_id: '20202020-2020-4020-8020-202020202020', codigo: '000042', validade_minutos: '10',
    link_acesso: 'https://loja.example.invalid/loja/biblioteca/entrar?pid=20202020-2020-4020-8020-202020202020&origem=teste'
};
const comporRecuperacao = (extra = {}) => comporEmail({modelo: modeloRecuperacao(), variaveis: variaveisRecuperacao, ...extra});
test('C2 catalogo registra exatamente quatro placeholders obrigatorios', () => {
    const catalogo=obterCatalogo(CHAVE_RECUPERACAO_BIBLIOTECA_CODIGO);
    assert.deepEqual(Object.keys(catalogo),Object.keys(variaveisRecuperacao));
    for(const [k,v] of Object.entries(catalogo)){assert.equal(v.obrigatorio,true);assert.equal(v.tipo,k==='link_acesso'?'url':'texto');}
});
test('C2 compoe HTML e texto com codigo sintetico, zeros e URL completa', () => {
    const r=comporRecuperacao();assert.equal(r.assunto,ASSUNTO_RECUPERACAO_BIBLIOTECA_CODIGO);
    assert(r.html.includes('<strong>000042</strong>'));assert(r.html.includes('&amp;origem=teste'));
    assert(r.text.includes('000042'));assert(r.text.includes('10 minutos'));assert(r.text.includes(variaveisRecuperacao.pedido_public_id));
    assert(r.text.includes(variaveisRecuperacao.link_acesso));assert(!r.text.includes('<p>'));assert(!r.assunto.includes('000042'));
});
for(const nome of Object.keys(variaveisRecuperacao))test('C2 placeholder obrigatorio no corpo: '+nome,()=>{
    const modelo=modeloRecuperacao();modelo.conteudoHtml=modelo.conteudoHtml.replaceAll('{{'+nome+'}}','ausente');
    assert.equal(capturarCodigo(()=>comporRecuperacao({modelo})),'PLACEHOLDER_OBRIGATORIO_NO_MODELO');
});
for(const nome of Object.keys(variaveisRecuperacao))test('C2 valor obrigatorio ausente: '+nome,()=>{
    const variaveis={...variaveisRecuperacao};delete variaveis[nome];assert.equal(capturarCodigo(()=>comporRecuperacao({variaveis})),'PLACEHOLDER_AUSENTE');
});
test('C2 placeholders desconhecidos rejeitados sem valores no erro',()=>{
    const modelo=modeloRecuperacao();modelo.conteudoHtml+='<p>{{desconhecido}}</p>';
    assert.equal(capturarCodigo(()=>comporRecuperacao({modelo})),'PLACEHOLDER_DESCONHECIDO');
});
for(const [caso,assunto] of ['Código {{codigo}}','Código 000042','', 'Assunto\r\nBcc: teste@example.invalid'].entries())test('C2 assunto nao inclui codigo ou cabecalhos invalidos, caso '+caso,()=>{
    assert.equal(capturarCodigo(()=>comporRecuperacao({modelo:modeloRecuperacao({assunto})})),'ASSUNTO_RECUPERACAO_INVALIDO');
});
test('C2 codigo oculto em atributo nao satisfaz contrato do corpo',()=>{
    const modelo=modeloRecuperacao();modelo.conteudoHtml=modelo.conteudoHtml.replace('<strong>{{codigo}}</strong>','<span title="{{codigo}}">Sem código</span>');
    assert.equal(capturarCodigo(()=>comporRecuperacao({modelo})),'PLACEHOLDER_OBRIGATORIO_NO_MODELO');
});
test('C2 modelo ausente, inativo ou sem corpo nao utiliza fallback',()=>{
    assert.equal(capturarCodigo(()=>comporRecuperacao({modelo:null})),'MODELO_INEXISTENTE');
    assert.equal(capturarCodigo(()=>comporRecuperacao({modelo:modeloRecuperacao({ativo:false})})),'MODELO_INATIVO');
    assert.equal(capturarCodigo(()=>comporRecuperacao({modelo:modeloRecuperacao({conteudoHtml:'<script>removido</script>'})})),'PLACEHOLDER_OBRIGATORIO_NO_MODELO');
    assert(comporRecuperacao({modelo:modeloRecuperacao({ativo:false}),permitirInativo:true}).avisos.some(a=>a.codigo==='modelo_inativo'));
});
test('C2 sanitiza modelo e assinatura administrativa',()=>{
    const r=comporRecuperacao({modelo:modeloRecuperacao({conteudoHtml:modeloRecuperacao().conteudoHtml+'<script>alert(1)</script>'}),assinatura:{ativo:true,conteudoHtml:'<p onclick="alert(1)">Assinatura IST</p>'}});
    assert(r.html.includes('Assinatura IST'));assert(r.text.includes('Assinatura IST'));assert(!/onclick|<script/i.test(r.html));
    assert(!comporRecuperacao({assinatura:{ativo:false,conteudoHtml:'<p>Antiga</p>'}}).html.includes('Antiga'));
});
test('C2 assinatura nao pode introduzir placeholders pendentes',()=>{
    assert.equal(capturarCodigo(()=>comporRecuperacao({assinatura:{ativo:true,conteudoHtml:'<p>{{desconhecido}}</p>'}})),'PLACEHOLDER_NA_ASSINATURA');
});
test('C2 texto inclui URL mesmo com rotulo formatado e entidades',()=>{
    const modelo=modeloRecuperacao({conteudoHtml:modeloRecuperacao().conteudoHtml.replace('Entrar na biblioteca','<strong>Entrar</strong> &amp; consultar')});
    assert(comporRecuperacao({modelo}).text.includes(variaveisRecuperacao.link_acesso));
});
test('C2 modelos antigos preservam subconjuntos e texto anterior',()=>{
    assert.equal(comporEmail({modelo:modeloBase({conteudoHtml:'<p>{{nome}}</p>'}),variaveis:{nome:'Ana'}}).text,'Ana');
    assert.equal(comporEmail({modelo:modeloBase(),variaveis:variaveisValidas}).text,'Ola Joao\nConfirmar');
});
const bancoSintetico=(modelo=modeloRecuperacao(),assinatura=null)=>{
    const chamadas=[];
    return {chamadas,async query(sql,params){chamadas.push({sql,params});
        if(sql.includes('FROM ist_email_assinaturas'))return [assinatura?[{conteudo_html:assinatura.conteudoHtml,ativo:assinatura.ativo}]:[]];
        assert(sql.includes('FROM ist_email_modelos'));
        return [modelo?[{id_modelo:7,chave:modelo.chave,assunto:modelo.assunto,conteudo_html:modelo.conteudoHtml,id_assinatura:modelo.idAssinatura,ativo:modelo.ativo}]:[]];
    }};
};
test('C2 carrega por chave e assinatura exclusivamente pelo banco injetado',async()=>{
    const db=bancoSintetico(modeloRecuperacao({idAssinatura:9}),{ativo:true,conteudoHtml:'<p>Assinatura administrativa</p>'});
    const r=await comporEmailPorChave(CHAVE_RECUPERACAO_BIBLIOTECA_CODIGO,variaveisRecuperacao,{db});
    assert(r.html.includes('Assinatura administrativa'));assert.equal(db.chamadas.length,2);
    assert.deepEqual(db.chamadas[0].params,[CHAVE_RECUPERACAO_BIBLIOTECA_CODIGO]);assert.deepEqual(db.chamadas[1].params,[9]);
    assert(db.chamadas.every(c=>/^SELECT/.test(c.sql)));
});
test('C2 carregador rejeita chave ausente, modelo inativo e invalido',async()=>{
    await assert.rejects(comporEmailPorChave(CHAVE_RECUPERACAO_BIBLIOTECA_CODIGO,variaveisRecuperacao,{db:bancoSintetico(null)}),{codigo:'CHAVE_INEXISTENTE'});
    await assert.rejects(comporEmailPorChave(CHAVE_RECUPERACAO_BIBLIOTECA_CODIGO,variaveisRecuperacao,{db:bancoSintetico(modeloRecuperacao({ativo:false}))}),{codigo:'MODELO_INATIVO'});
    await assert.rejects(comporEmailPorChave(CHAVE_RECUPERACAO_BIBLIOTECA_CODIGO,variaveisRecuperacao,{db:bancoSintetico(modeloRecuperacao({conteudoHtml:'<p>Incompleto</p>'}))}),{codigo:'PLACEHOLDER_OBRIGATORIO_NO_MODELO'});
});
test('C2 preview e metadados usam o contrato e dependencia injetada',async()=>{
    const db=bancoSintetico(modeloRecuperacao({ativo:false}));
    const r=await comporEmailPorId(7,variaveisRecuperacao,{permitirInativo:true,db});assert(r.avisos.some(a=>a.codigo==='modelo_inativo'));
    const meta=await obterPlaceholdersDoModelo(7,{db});assert.deepEqual(meta.placeholders.map(p=>p.nome),Object.keys(variaveisRecuperacao));
    await assert.rejects(obterPlaceholdersDoModelo(7,{db:bancoSintetico(modeloRecuperacao({conteudoHtml:'<p>Incompleto</p>'}))}),{codigo:'PLACEHOLDER_OBRIGATORIO_NO_MODELO'});
});
test('C2 nenhuma composicao ou rejeicao registra codigo em logs',async(t)=>{
    const calls=[];for(const level of ['log','info','warn','error','debug','trace'])t.mock.method(console,level,(...args)=>calls.push(args));
    comporRecuperacao();await comporEmailPorChave(CHAVE_RECUPERACAO_BIBLIOTECA_CODIGO,variaveisRecuperacao,{db:bancoSintetico()});
    try{comporRecuperacao({modelo:modeloRecuperacao({assunto:'Código '+variaveisRecuperacao.codigo})});assert.fail('Era esperada rejeição');}
    catch(e){assert(e instanceof EmailComposicaoError);assert(!JSON.stringify(e).includes(variaveisRecuperacao.codigo));}
    assert.deepEqual(calls,[]);
});
for(const marcador of ['{{CODIGO}}','{{nao-permitido}}','{{constructor}}'])test('C2 rejeita marcador fora do contrato: '+marcador,()=>{
    const modelo=modeloRecuperacao({conteudoHtml:modeloRecuperacao().conteudoHtml+'<p>'+marcador+'</p>'});
    assert.equal(capturarCodigo(()=>comporRecuperacao({modelo})),'PLACEHOLDER_DESCONHECIDO');
});
for(const marcador of ['{{incompleto','incompleto}}'])test('C2 rejeita marcador incompleto: '+marcador,()=>{
    const modelo=modeloRecuperacao({conteudoHtml:modeloRecuperacao().conteudoHtml+'<p>'+marcador+'</p>'});
    assert.equal(capturarCodigo(()=>comporRecuperacao({modelo})),'MODELO_RECUPERACAO_INVALIDO');
});
for(const nome of Object.keys(variaveisRecuperacao))test('C2 rejeita valor obrigatorio vazio: '+nome,()=>{
    assert.equal(capturarCodigo(()=>comporRecuperacao({variaveis:{...variaveisRecuperacao,[nome]:' '}})),'VARIAVEL_INVALIDA');
});
