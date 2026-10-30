import test from 'node:test';
import assert from 'node:assert/strict';
import {criarCompositorConfirmacaoCompra} from '../src/services/lojaNotificacoesMensagem.js';
import {comporEmail} from '../src/services/emailTemplateService.js';
import {obterCatalogo} from '../src/config/emailPlaceholders.js';
import {criarProcessadorNotificacoes} from '../src/services/lojaNotificacoesWorker.js';
import {iniciarNotificacoesLoja} from '../src/services/lojaNotificacoesAgendador.js';

const pedidoId='11111111-1111-4111-8111-111111111111',pagamentoId='22222222-2222-4222-8222-222222222222';
const conteudo=`<p>Instituto Sebastião Tapajós</p><p>{{saudacao}} {{comprador_email}}</p>
<p>Pedido: <strong>{{pedido_public_id}}</strong>. Guarde o código: é necessário para recuperar a biblioteca usando o e-mail da compra.</p>
<p>Pedido {{pedido_estado}}. Compra: {{data_compra}}. Pagamento: {{data_pagamento}}.</p>
<p>{{pagamento_estado}}. Referência: {{pagamento_referencia}}. {{ambiente}}</p>
<p>{{itens_compra}}</p><p>Total: {{moeda}} {{total}}</p>
<p><a href="{{link_biblioteca}}">Biblioteca digital</a> <a href="{{link_recuperacao}}">Recuperar acesso por e-mail e pedido</a></p>`;
const fixture=()=>{
 const n={pedido_id:7,pedido_public_id:pedidoId,finalidade:'CONFIRMACAO_COMPRA',ambiente:'sandbox',destinatario:'comprador@example.invalid'};
 const p={id:7,public_id:pedidoId,comprador_email:n.destinatario,estado:'PAGO',ambiente:'sandbox',moeda:'BRL',total_centavos:'19000',criado_em:'2026-01-01T12:00:00.000000Z',pagamento_confirmado_em:'2026-01-01T13:00:00.000000Z'};
 const pagamentos=[{public_id:pagamentoId,provedor:'paypal',ambiente:'sandbox',estado:'CAPTURADO',moeda:'BRL',valor_centavos:'19000',capturado_centavos:'19000',reembolsado_centavos:'0',capturado_em:p.pagamento_confirmado_em}];
 const itens=[{posicao:1,titulo_snapshot:'Título histórico',descricao_snapshot:'Descrição histórica',quantidade:1,preco_unitario_centavos:'9500',subtotal_centavos:'9500'},
  {posicao:2,titulo_snapshot:'Outro e-book',descricao_snapshot:null,quantidade:1,preco_unitario_centavos:'9500',subtotal_centavos:'9500'}];
 const modelo={id_modelo:1,chave:'confirmacao_compra',assunto:'IST — Recibo do pedido {{pedido_public_id}}',conteudo_html:conteudo,id_assinatura:1,ativo:1};
 const assinatura={conteudo_html:'<p>Assinatura Institucional IST</p>',ativo:1};let ausente=false;const consultas=[];
 const c={query:async(sql,args)=>{
  consultas.push(sql);assert.match(sql,/^SELECT /);assert.doesNotMatch(sql,/FOR UPDATE|ist_loja_produtos|ist_livros/);
  if(sql.includes('FROM ist_loja_pedidos')){assert.deepEqual(args,[7]);return [[{...p}]];}
  if(sql.includes('FROM ist_loja_pagamentos'))return [pagamentos.map(x=>({...x}))];
  if(sql.includes('FROM ist_loja_pedido_itens')){assert(sql.includes('ORDER BY posicao'));return [itens.map(x=>({...x}))];}
  if(sql.includes('FROM ist_email_modelos')){assert.deepEqual(args,['confirmacao_compra']);return [ausente?[]:[{...modelo}]];}
  if(sql.includes('FROM ist_email_assinaturas'))return [[{...assinatura}]];
  assert.fail('Consulta fora do contrato');
 }};
 const compor=origemPublica=>criarCompositorConfirmacaoCompra({origemPublica:origemPublica??'https://localhost:8443',ambiente:n.ambiente})(n,c);
 return {n,p,pagamentos,itens,modelo,assinatura,c,compor,consultas,ausente:()=>{ausente=true;}};
};
test('recibo usa snapshots de varios itens, valores exatos, datas, pagamento e assinatura',async()=>{
 const f=fixture(),m=await f.compor();assert.equal(m.to,f.n.destinatario);assert(m.subject.includes(pedidoId));
 for(const valor of ['Título histórico','Descrição histórica','Outro e-book','Quantidade: 1','Preço unitário: BRL 95,00','Subtotal: BRL 95,00','190,00','BRL','PAGO','CAPTURADO','PayPal',pedidoId,pagamentoId,'01/01/2026','09:00:00','10:00:00','America/Sao_Paulo','Olá,','comprador@example.invalid','Assinatura Institucional IST','sem cobrança real'])assert(m.text.includes(valor),valor);
 assert(m.html.includes('<br />'));assert(m.html.includes('<strong>'+pedidoId+'</strong>'));
 assert(m.text.includes('https://localhost:8443/loja/biblioteca'));assert(m.text.includes('https://localhost:8443/loja/biblioteca/recuperar'));
 assert.equal(f.consultas.length,5);assert.deepEqual(Object.keys(m).sort(),['html','subject','text','to']);
});
test('recibo de um produto e quantidades com centavos somam sem ponto flutuante',async()=>{
 const f=fixture();f.itens.splice(1);Object.assign(f.itens[0],{quantidade:3,preco_unitario_centavos:'3333',subtotal_centavos:'9999'});f.p.total_centavos='9999';Object.assign(f.pagamentos[0],{valor_centavos:'9999',capturado_centavos:'9999'});
 const m=await f.compor();assert(m.text.includes('Quantidade: 3'));assert(m.text.includes('BRL 33,33'));assert(m.text.includes('BRL 99,99'));assert(!m.text.includes('Outro e-book'));
});
test('escape de produtos e descricoes; nenhum campo privado e selecionado ou composto',async()=>{
 const f=fixture();f.itens[0].titulo_snapshot='<script>alert("x")</script>';f.itens[0].descricao_snapshot='<img src=x onerror=alert(1)> & detalhe\nSegunda linha';
 f.p.token='SEGREDO_NAO_ENVIAR';f.pagamentos[0].cartao='CARTAO_NAO_ENVIAR';
 const m=await f.compor();assert(!m.html.includes('<script>'));assert(!m.html.includes('<img src="x"'));assert(m.html.includes('&lt;script&gt;'));assert(m.text.includes('Segunda linha'));
 assert(!JSON.stringify(m).includes('NAO_ENVIAR'));assert(!JSON.stringify(m).includes('istbrasil.private'));
});
for(const origem of ['https://localhost:8443','https://istbrasil.org.br'])test('links derivam da origem '+origem,async()=>{
 const f=fixture();if(origem.includes('istbrasil.org')){f.n.ambiente=f.p.ambiente=f.pagamentos[0].ambiente='live';}
 const m=await f.compor(origem);assert(m.text.includes(origem+'/loja/biblioteca/recuperar'));assert(m.html.includes('href="'+origem+'/loja/biblioteca"'));if(f.n.ambiente==='live')assert(!m.text.includes('Sandbox'));
});
for(const origem of [undefined,'http://localhost:4200','https://localhost:8443/caminho','https://usuario:senha@site.invalid'])test('origem invalida sem fallback '+origem,()=>{
 assert.throws(()=>criarCompositorConfirmacaoCompra({origemPublica:origem,ambiente:'sandbox'}),/RECIBO_INDISPONIVEL/);
});
for(const [nome,mudar] of [
 ['pedido nao pago',f=>{f.p.estado='CRIADO';}],['captura pendente',f=>{f.pagamentos[0].estado='PENDENTE';}],
 ['total divergente',f=>{f.p.total_centavos='18000';}],['valor capturado divergente',f=>{f.pagamentos[0].capturado_centavos='100';}],
 ['moeda divergente',f=>{f.pagamentos[0].moeda='USD';}],['titular divergente',f=>{f.p.comprador_email='outro@example.invalid';}],
 ['data divergente',f=>{f.pagamentos[0].capturado_em='2026-01-02T13:00:00.000000Z';}],['referencia invalida',f=>{f.pagamentos[0].public_id='nao-uuid';}],
 ['duas capturas',f=>{f.pagamentos.push({...f.pagamentos[0]});}],['sem itens',f=>{f.itens.length=0;}],
 ['subtotal divergente',f=>{f.itens[0].subtotal_centavos='1';}],['quantidade invalida',f=>{f.itens[0].quantidade=0;}],
 ['posicao duplicada',f=>{f.itens[1].posicao=1;}],['pedido divergente',f=>{f.n.pedido_public_id=pagamentoId;}],
 ['modelo ausente',f=>f.ausente()],['modelo inativo',f=>{f.modelo.ativo=0;}],['modelo incompleto',f=>{f.modelo.conteudo_html='<p>{{pedido_public_id}}</p>';}],
 ['placeholder desconhecido',f=>{f.modelo.conteudo_html+='<p>{{segredo}}</p>';}],['assinatura inativa',f=>{f.assinatura.ativo=0;}],
 ['assinatura com placeholder',f=>{f.assinatura.conteudo_html='<p>{{codigo}}</p>';}]
])test('nao compoe recibo: '+nome,async()=>{const f=fixture();mudar(f);await assert.rejects(f.compor(),e=>e.message==='RECIBO_INDISPONIVEL'&&!e.cause);});
test('limite especial de itens atende multiplos produtos sem mudar limites dos modelos anteriores',async()=>{
 const f=fixture();f.itens[0].descricao_snapshot='Descrição histórica. '.repeat(300);const m=await f.compor();assert(m.text.includes(f.itens[0].descricao_snapshot.trim()));
 f.itens[0].descricao_snapshot='x'.repeat(200001);await assert.rejects(f.compor(),/RECIBO_INDISPONIVEL/);
 assert.throws(()=>comporEmail({modelo:{chave:'confirmacao_email',ativo:true,assunto:'Teste',conteudoHtml:'<p>{{nome}}</p><a href="{{link}}">Entrar</a>'},variaveis:{nome:'x'.repeat(5001),link:'https://site.invalid'}}),{codigo:'VARIAVEL_INVALIDA'});
});
test('contrato completo de placeholders e assinatura, sem fallback ou logs',async()=>{
 const catalogo=obterCatalogo('confirmacao_compra');assert.equal(Object.keys(catalogo).length,14);assert(Object.values(catalogo).every(x=>x.obrigatorio));
 const f=fixture(),logs=[],old={};for(const k of ['log','error','warn','info']){old[k]=console[k];console[k]=(...a)=>logs.push(a);}
 try{await f.compor();f.ausente();await assert.rejects(f.compor());assert.equal(logs.length,0);}finally{Object.assign(console,old);}
});

// Worker real com conexao simulada: unica persistencia gravavel e a outbox.
const workerFixture=()=>{
 const f=fixture();let row={...f.n,id:1,estado:'PENDENTE',tentativas:0,proxima_tentativa_em:true},tx=false,readOnly=false;let envios=0;
 const db={getConnection:async()=>({release(){assert.equal(tx,false);},destroy(){tx=false;},query:async({sql},args)=>{
  if(sql.startsWith('SELECT @@'))return [[{tx:0,ac:1}]];
  if(sql.startsWith('SET TRANSACTION'))return [[]];
  if(sql.startsWith('START TRANSACTION')){assert.equal(tx,false);tx=true;readOnly=sql.endsWith('READ ONLY');return [[]];}
  if(sql==='COMMIT'||sql==='ROLLBACK'){tx=false;return [[]];}
  if(sql.startsWith('SELECT n.*'))return [[...(['PENDENTE','FALHA'].includes(row.estado)&&row.proxima_tentativa_em?[{...row}]:[] )]];
  if(sql.startsWith('SELECT id FROM ist_loja_notificacoes'))return [[...(row.estado==='PROCESSANDO'?[{id:1}]:[])]];
  if(sql.startsWith('UPDATE ist_loja_notificacoes SET estado=\'PROCESSANDO\'')){row.estado='PROCESSANDO';row.tentativas++;row.reserva_token=args[0];return [{affectedRows:1,warningStatus:0}];}
  if(sql.startsWith('UPDATE ist_loja_notificacoes SET estado=?')){row.estado=args[0];row.proxima_tentativa_em=args[2];return [{affectedRows:1,warningStatus:0}];}
  assert(readOnly,'Dados do recibo fora de snapshot READ ONLY');return f.c.query(sql,args);
 }})};
 const make=(send,opcoes={})=>criarProcessadorNotificacoes({...opcoes,db,ambiente:'sandbox',origemPublica:'https://localhost:8443',enviar:async m=>{assert.equal(tx,false);envios++;return send?.(m);}});
 return {...f,make,row,envios:()=>envios};
};
test('worker real gera recibo completo e nao duplica reprocessamento',async()=>{
 const f=workerFixture(),before=JSON.stringify([f.p,f.pagamentos,f.itens]);const w=f.make(m=>{assert(m.html.includes('Título histórico'));assert(m.text.includes('190,00'));});
 assert.equal((await w.processar({limite:1})).enviadas,1);assert.equal(f.row.estado,'ENVIADO');assert.equal((await w.processar()).reservadas,0);assert.equal(f.envios(),1);assert.equal(JSON.stringify([f.p,f.pagamentos,f.itens]),before);
});
test('modelo ausente/inativo e pedido nao pago nunca chegam ao SMTP',async()=>{
 for(const alterar of [f=>f.ausente(),f=>{f.modelo.ativo=0;},f=>{f.p.estado='CRIADO';}]){const f=workerFixture();alterar(f);const w=f.make(()=>assert.fail('SMTP proibido'));assert.equal((await w.processar({limite:1})).falhas,1);assert.equal(f.envios(),0);}
});
test('falha SMTP comprovada nao altera PAGO, e aceite incerto nao e reenviado',async()=>{
 for(const comprovada of [true,false]){const f=workerFixture(),before=JSON.stringify([f.p,f.pagamentos,f.itens]);const w=f.make(()=>{throw {notificacaoNaoEnviada:comprovada};});
 const r=await w.processar({limite:1});assert.equal(comprovada?r.falhas:r.incertas,1);assert.equal(f.p.estado,'PAGO');assert.equal(JSON.stringify([f.p,f.pagamentos,f.itens]),before);
 if(!comprovada){assert.equal(f.row.estado,'INCERTO');assert.equal((await w.processar()).reservadas,0);assert.equal(f.envios(),1);}
 }
});
test('notificacao INCERTO preexistente permanece intocada',async()=>{const f=workerFixture();f.row.estado='INCERTO';const before=JSON.stringify(f.row);assert.equal((await f.make(()=>assert.fail()).processar()).reservadas,0);assert.equal(JSON.stringify(f.row),before);});

test('dois workers sobrepostos nao enviam duas vezes a mesma reserva',async()=>{
 const f=workerFixture();let entrou,liberar;const pronto=new Promise(r=>entrou=r),espera=new Promise(r=>liberar=r);
 const a=f.make(async()=>{entrou();await espera;}).processar({limite:1});await pronto;
 try{assert.equal((await f.make(()=>assert.fail('ENVIO_DUPLICADO')).processar({limite:1})).reservadas,0);}finally{liberar();}
 assert.equal((await a).enviadas,1);assert.equal(f.envios(),1);
});
test('todos os placeholders sao obrigatorios no corpo somente para confirmacao_compra',async()=>{
 for(const nome of Object.keys(obterCatalogo('confirmacao_compra'))){
  const f=fixture();f.modelo.conteudo_html=f.modelo.conteudo_html.replaceAll('{{'+nome+'}}','removido');await assert.rejects(f.compor(),/RECIBO_INDISPONIVEL/);
 }
 const f=fixture();f.modelo.conteudo_html=f.modelo.conteudo_html.replace('{{itens_compra}}','<span title="{{itens_compra}}">oculto</span>');await assert.rejects(f.compor(),/RECIBO_INDISPONIVEL/);
});
test('moeda do pedido, quantidade fracionaria e data nao confirmada sao recusadas',async()=>{
 for(const mudar of [f=>{f.p.moeda='USD';},f=>{f.itens[0].quantidade=1.5;},f=>{f.p.pagamento_confirmado_em=null;}]){
  const f=fixture();mudar(f);await assert.rejects(f.compor(),/RECIBO_INDISPONIVEL/);
 }
});

test('timeout SMTP permanece INCERTO e nao repete envio',async()=>{
 const f=workerFixture();const before=JSON.stringify([f.p,f.pagamentos,f.itens]);
 const w=f.make(()=>new Promise(()=>{}),{timeoutMs:10,reservaMs:2000});assert.equal((await w.processar({limite:1})).incertas,1);
 assert.equal(f.row.estado,'INCERTO');assert.equal((await w.processar()).reservadas,0);assert.equal(f.envios(),1);assert.equal(JSON.stringify([f.p,f.pagamentos,f.itens]),before);
});
test('agendador injeta origem existente sem enviar nem iniciar timer real',async()=>{
 let recebido,envios=0;const h=iniciarNotificacoesLoja({db:{},env:{NODE_ENV:'production',LOJA_AMBIENTE:'sandbox',IST_LOJA_PAYPAL_ENV:'sandbox',IST_LOJA_NOTIFICACOES_ATIVAS:'true',IST_LOJA_RECUPERACAO_ORIGEM_PUBLICA:'https://localhost:8443'},
 criarEnvio:()=>()=>{envios++;},criarProcessador:o=>{recebido=o;return {processar:async()=>({})};},agendar:()=>7,cancelar:()=>{}});
 assert.equal(h.ativo,true);assert.equal(recebido.origemPublica,'https://localhost:8443');assert.equal(recebido.ambiente,'sandbox');assert.equal(envios,0);await h.parar();
});

// A fixture existente cria seu proprio mysqld 10.3.39, sem TCP e com socket
// privado. Nunca fornecer credenciais da homologacao a estes testes.
test('recibo MariaDB 10.3.39: leitura historica pelo worker',{
 skip:process.env.IST_LOJA_MARIADB_NATIVO_10339!=='true',timeout:120000
},async t=>{
 const {criarFixtureDireitos}=await import('./fixtures/lojaDownloadDireitosFixture.js');
 const {registrarConfirmacaoCompraNaConexao}=await import('../src/services/lojaNotificacoesService.js');
 const {a,pool,preparar}=await criarFixtureDireitos(t);
 const prepararModelo=async chave=>{
  assert.equal(chave,'confirmacao_compra');
  return variaveis=>comporEmail({modelo:{chave,ativo:true,assunto:'IST — Recibo {{pedido_public_id}}',conteudoHtml:conteudo,idAssinatura:1},
   assinatura:{ativo:true,conteudoHtml:'<p>Assinatura Institucional IST</p>'},variaveis});
 };
 const compositor=criarCompositorConfirmacaoCompra({origemPublica:'https://localhost:8443',ambiente:'sandbox',prepararModelo});
 const snapshot=async()=>{
  const dados=[];
  for(const tabela of ['ist_loja_pedidos','ist_loja_pedido_itens','ist_loja_pagamentos','ist_loja_pagamento_operacoes','ist_loja_pagamento_eventos','ist_loja_download_direitos','ist_loja_download_direito_eventos'])
   dados.push((await a.query(`SELECT * FROM ${tabela} ORDER BY id`))[0]);
  return JSON.stringify(dados);
 };
 const compra=async()=>{
  const p=await preparar({estadoDireito:'ATIVO'});
  await a.query('UPDATE ist_loja_pedido_itens SET titulo_snapshot=CONCAT(?,posicao),descricao_snapshot=? WHERE pedido_id=?',['Título histórico ','Descrição histórica',p.pedidoId]);
  await a.beginTransaction();
  try{
   const [[pedido]]=await a.query('SELECT * FROM ist_loja_pedidos WHERE id=? FOR UPDATE',[p.pedidoId]);
   await registrarConfirmacaoCompraNaConexao(a,pedido,new Date().toISOString());await a.commit();
   return {...p,publicId:pedido.public_id};
  }catch(e){await a.rollback();throw e;}
 };
 const worker=enviar=>criarProcessadorNotificacoes({db:pool,enviar,ambiente:'sandbox',comporMensagem:compositor});
 await t.test('pedido pago, captura integral, snapshots e valores chegam ao SMTP simulado uma unica vez',async()=>{
  const p=await compra(),antes=await snapshot();let chamadas=0;
  const w=worker(async m=>{
   chamadas++;assert.equal(m.to,'sintetico@example.invalid');
   for(const valor of [p.publicId,'Título histórico 1','Título histórico 2','Descrição histórica','Quantidade: 1','Preço unitário: BRL 1,00','Subtotal: BRL 1,00','2,00','CAPTURADO','PAGO','Assinatura Institucional IST','https://localhost:8443/loja/biblioteca'])assert(m.text.includes(valor),valor);
   assert(m.html.includes('Título histórico 1'));
  });
  assert.equal((await w.processar({limite:1})).enviadas,1);
  assert.equal((await w.processar({limite:1})).reservadas,0);assert.equal(chamadas,1);
  const [[n]]=await a.query('SELECT estado,tentativas FROM ist_loja_notificacoes WHERE pedido_id=?',[p.pedidoId]);
  assert.equal(n.estado,'ENVIADO');assert.equal(n.tentativas,1);assert.equal(await snapshot(),antes);
 });
 await t.test('captura inconsistente impede envio e preserva os registros financeiros',async()=>{
  const p=await compra();
  await a.query('UPDATE ist_loja_pagamentos SET capturado_centavos=199 WHERE id=?',[p.pagamentoId]);
  const antes=await snapshot();let chamadas=0;
  const r=await worker(async()=>{chamadas++;}).processar({limite:1});
  assert.equal(r.falhas,1);assert.equal(chamadas,0);
  const [[n]]=await a.query('SELECT estado FROM ist_loja_notificacoes WHERE pedido_id=?',[p.pedidoId]);
  assert.equal(n.estado,'FALHA');assert.equal(await snapshot(),antes);
 });
});
