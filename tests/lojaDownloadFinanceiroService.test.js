import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { avaliarElegibilidadeFinanceiraNaConexao as avaliar } from '../src/services/lojaDownloadFinanceiroService.js';

const ctx={provedor:'paypal',ambiente:'sandbox',contaRecebedora:'RECEBEDOR-SINTETICO'};
const dt='2026-01-01T12:00:00.000000Z',inicio='2026-01-01T00:00:00.000000Z';
const base=()=>{
    const r={estado:'CAPTURADO',referencia:'11111111-1111-4111-8111-111111111111',ordemId:'ORDEM-SINTETICA',capturaId:'CAPTURA-SINTETICA',
        valorCentavos:'100',moeda:'BRL',ambiente:'sandbox',contaRecebedora:ctx.contaRecebedora,capturadoEm:'2026-01-01T12:00:00.000Z'};
    return {p:{id:1,sessao_id:1,estado:'PAGO',ambiente:'sandbox',moeda:'BRL',total_centavos:'100',versao:2,motivo_revisao:null,criado_em:inicio,pagamento_confirmado_em:dt},
        pagamentos:[{id:1,public_id:r.referencia,pedido_id:1,...{provedor:'paypal',ambiente:'sandbox',conta_recebedora:ctx.contaRecebedora},estado:'CAPTURADO',versao:2,motivo_revisao:null,
            ordem_externa_id:r.ordemId,captura_externa_id:r.capturaId,valor_centavos:'100',capturado_centavos:'100',reembolsado_centavos:'0',criado_em:inicio,capturado_em:dt}],
        ops:[{id:1,pedido_id:1,pagamento_id:1,acao:'CAPTURAR',estado:'SUCESSO',versao:2,envio_iniciado_em:inicio,concluido_em:dt,resultado_json:JSON.stringify(r)}],
        eventos:[],itens:[{id:1,produto_id:1,posicao:1,tipo_snapshot:'DIGITAL',quantidade:1,preco_unitario_centavos:'100',subtotal_centavos:'100'}],
        direitos:[{id:1,pedido_item_id:1,produto_id:1,arquivo_versao_id:1,estado:'AGUARDANDO_CONFIRMACAO',versao:1,versao_id:1,versao_produto_id:1,versao_estado:'RETIRADA',versao_publicada_em:inicio}],r};
};
const envelope=r=>({resultado:r,observacao:{evidencia:'PRESENTE',associacaoOrdem:'CONFIRMADA',validacao:'CONSISTENTE',statusOrdem:'COMPLETED',statusCaptura:'COMPLETED',motivoPendencia:null}});
const evento=(b,e,origem='RECONCILIACAO')=>b.eventos.push({id:b.eventos.length+1,pagamento_id:1,provedor:'paypal',ambiente:'sandbox',conta_recebedora:ctx.contaRecebedora,
    origem,tipo:'CAPTURADO',estado:'PROCESSADO',evidencia_json:JSON.stringify(e)});
const banco=b=>{const calls=[];return {calls,async query(sql,args){calls.push([sql,args]);assert.match(sql,/^SELECT /);assert.doesNotMatch(sql,/FOR UPDATE|LOCK IN SHARE|\*/);
    if(sql.includes('@@in_transaction'))return [[{em_transacao:1}]];
    if(sql.includes('FROM ist_loja_pedidos'))return [[b.p].filter(Boolean)];
    if(sql.includes('FROM ist_loja_pagamentos WHERE'))return [b.pagamentos];
    if(sql.includes('FROM ist_loja_pagamento_operacoes'))return [b.ops];
    if(sql.includes('FROM ist_loja_pagamento_eventos'))return [b.eventos];
    if(sql.includes('FROM ist_loja_pedido_itens'))return [b.itens];
    if(sql.includes('FROM ist_loja_download_direitos'))return [b.direitos];
    throw Error('Consulta inesperada');
}};};
const alterarResultado=(b,changes)=>{b.ops[0].resultado_json=JSON.stringify({...b.r,...changes});};
const casos=[
    ['pedido nao pago',b=>{b.p.estado='AGUARDANDO_PAGAMENTO';b.p.pagamento_confirmado_em=null;b.pagamentos=[];b.ops=[];},'PENDENTE'],
    ['captura pendente',b=>{b.p.estado='AGUARDANDO_PAGAMENTO';b.p.pagamento_confirmado_em=null;Object.assign(b.pagamentos[0],{estado:'PENDENTE',capturado_centavos:'0',capturado_em:null});b.ops[0].resultado_json=JSON.stringify({...b.r,estado:'PENDENTE',capturadoEm:null});},'PENDENTE'],
    ['captura negada',b=>{b.p.estado='AGUARDANDO_PAGAMENTO';b.p.pagamento_confirmado_em=null;Object.assign(b.pagamentos[0],{estado:'RECUSADO',capturado_centavos:'0',capturado_em:null});b.ops[0].estado='RECUSADA';alterarResultado(b,{estado:'RECUSADO',capturadoEm:null});},'PENDENTE'],
    ['revisao financeira',b=>{b.p.estado='REVISAO';b.p.motivo_revisao='SINTETICO';},'REVISAO'],
    ['identificador externo ausente',b=>{b.pagamentos[0].captura_externa_id=null;},'INCONSISTENTE'],
    ['valor insuficiente',b=>{b.pagamentos[0].capturado_centavos='99';},'INCONSISTENTE'],
    ['valor excessivo',b=>{b.pagamentos[0].capturado_centavos='101';},'INCONSISTENTE'],
    ['moeda incorreta',b=>{b.p.moeda='USD';},'INCONSISTENTE'],
    ['ambiente incorreto',b=>{b.pagamentos[0].ambiente='live';},'INCONSISTENTE'],
    ['recebedor esperado divergente',b=>{b.pagamentos[0].conta_recebedora='OUTRO';},'INCONSISTENTE'],
    ['recebedor observado ausente',b=>alterarResultado(b,{contaRecebedora:null}),'INCONSISTENTE'],
    ['recebedor observado divergente',b=>alterarResultado(b,{contaRecebedora:'OUTRO'}),'INCONSISTENTE'],
    ['capturas distintas nao somam quitacao',b=>{b.pagamentos.push({...b.pagamentos[0],id:2,public_id:randomUUID(),captura_externa_id:'OUTRA'});},'INCONSISTENTE'],
    ['captura duplicada',b=>{b.pagamentos.push({...b.pagamentos[0],id:2});},'INCONSISTENTE'],
    ['operacao ausente',b=>{b.ops=[];},'INCONSISTENTE'],
    ['operacao incerta',b=>{b.ops[0].estado='DESCONHECIDA';},'PENDENTE'],
    ['resultado JSON invalido',b=>{b.ops[0].resultado_json='{';},'INCONSISTENTE'],
    ['resultado ausente',b=>{b.ops[0].resultado_json=null;},'INCONSISTENTE'],
    ['referencia divergente',b=>alterarResultado(b,{referencia:'OUTRO'}),'INCONSISTENTE'],
    ['ordem divergente',b=>alterarResultado(b,{ordemId:'OUTRA'}),'INCONSISTENTE'],
    ['instante divergente',b=>alterarResultado(b,{capturadoEm:'2026-01-01T11:00:00.000Z'}),'INCONSISTENTE'],
    ['confirmacao ausente',b=>{b.p.pagamento_confirmado_em=null;},'INCONSISTENTE'],
    ['envio ausente',b=>{b.ops[0].envio_iniciado_em=null;},'INCONSISTENTE'],
    ['reconciliacao contraditoria',b=>{const e=envelope(b.r);e.observacao.evidencia='CONTRADITORIA';e.observacao.validacao='DIVERGENTE';evento(b,e);},'INCONSISTENTE'],
    ['reconciliacao incompleta',b=>{const e=envelope(b.r);e.observacao.validacao='INCONCLUSIVA';evento(b,e);},'INCONSISTENTE'],
    ['reembolso parcial',b=>{b.pagamentos[0].reembolsado_centavos='50';},'ADVERSO'],
    ['reembolso total',b=>{b.pagamentos[0].reembolsado_centavos='100';b.pagamentos[0].estado='REEMBOLSADO';},'ADVERSO'],
    ['estorno conhecido',b=>{b.pagamentos[0].estado='ESTORNADO';},'ADVERSO'],
    ['disputa representada no motivo normalizado',b=>{const e=envelope({...b.r,estado:'PENDENTE',capturadoEm:null});e.observacao.statusCaptura='PENDING';e.observacao.motivoPendencia='BUYER_COMPLAINT';e.observacao.validacao='INCONCLUSIVA';evento(b,e);},'ADVERSO'],
    ['chargeback representado no motivo normalizado',b=>{const e=envelope({...b.r,estado:'PENDENTE',capturadoEm:null});e.observacao.statusCaptura='PENDING';e.observacao.motivoPendencia='CHARGEBACK';e.observacao.validacao='INCONCLUSIVA';evento(b,e);},'ADVERSO'],
    ['reembolso na observacao',b=>{const e=envelope({...b.r,estado:'DESCONHECIDO',capturadoEm:null});e.observacao.statusCaptura='REFUNDED';e.observacao.validacao='INCONCLUSIVA';evento(b,e);},'ADVERSO'],
    ['soma inconsistente',b=>{b.itens[0].subtotal_centavos='99';},'INCONSISTENTE'],
    ['quantidade nao suportada',b=>{b.itens[0].quantidade=2;},'INCONSISTENTE'],
    ['direito produto incorreto',b=>{b.direitos[0].produto_id=2;},'INCONSISTENTE'],
    ['direito sem versao',b=>{b.direitos[0].versao_id=null;},'INCONSISTENTE'],
    ['versao de outro produto',b=>{b.direitos[0].versao_produto_id=2;},'INCONSISTENTE'],
    ['versao nunca publicada',b=>{b.direitos[0].versao_estado='RASCUNHO';b.direitos[0].versao_publicada_em=null;},'INCONSISTENTE'],
    ['versao publicada depois da compra',b=>{b.direitos[0].versao_publicada_em=dt;},'INCONSISTENTE'],
    ['reconciliacao sem envelope',b=>{evento(b,b.r);},'INCONSISTENTE'],
    ['historico sem direito',b=>{b.direitos=[];},'INCONSISTENTE'],
    ['evento webhook pendente nao e quitacao',b=>{evento(b,{},'WEBHOOK');b.eventos[0].estado='RECEBIDO';},'PENDENTE'],
    ['evento financeiro invalido',b=>{evento(b,{});},'INCONSISTENTE']
];
test('captura valida e repeticao sem alteracoes, sem efeitos colaterais ou dados sensiveis',async()=>{
    const b=base(),c=banco(b),antes=structuredClone(b),r=await avaliar(c,1,ctx);
    assert.equal(r.classificacao,'ELEGIVEL');assert.equal(r.elegivel,true);assert.deepEqual(await avaliar(c,1,ctx),r);assert.deepEqual(b,antes);
    assert.equal(r.limiteEvidencia,'SOMENTE_PERSISTENCIA_LOCAL');
    assert.doesNotMatch(JSON.stringify(r),/RECEBEDOR|CAPTURA-SINTETICA|ORDEM-SINTETICA|resultado_json|email|caminho/);
});
for(const [nome,mudar,esperado]of casos)test(nome,async()=>{const b=base();mudar(b);const r=await avaliar(banco(b),1,ctx);assert.equal(r.classificacao,esperado);assert.equal(r.elegivel,false);});
test('reconciliacao consistente na operacao e evento',async()=>{
    const b=base();b.ops[0].resultado_json=JSON.stringify(envelope(b.r));evento(b,envelope(b.r));assert.equal((await avaliar(banco(b),1,ctx)).elegivel,true);
});
test('PENDING historico superado por COMPLETED nao bloqueia; adverso antigo nao e apagado',async()=>{
    const b=base(),e=envelope({...b.r,estado:'PENDENTE',capturadoEm:null});e.observacao.statusCaptura='PENDING';evento(b,e);b.eventos[0].tipo='PENDENTE';evento(b,envelope(b.r));
    assert.equal((await avaliar(banco(b),1,ctx)).elegivel,true);
    e.observacao.motivoPendencia='CHARGEBACK';b.eventos[0].evidencia_json=JSON.stringify(e);assert.equal((await avaliar(banco(b),1,ctx)).classificacao,'ADVERSO');
});
test('assinatura de webhook nao substitui resultado observado nem e interpretada como JSON normalizado',async()=>{
    const b=base();evento(b,{resource:{id:'CAPTURA-SINTETICA'}},'WEBHOOK');assert.equal((await avaliar(banco(b),1,ctx)).elegivel,true);
    b.ops[0].resultado_json=null;assert.equal((await avaliar(banco(b),1,ctx)).elegivel,false);
});
test('Sandbox em contexto Live e negado; contexto invalido nao consulta SQL',async()=>{
    assert.equal((await avaliar(banco(base()),1,{...ctx,ambiente:'live'})).elegivel,false);
    assert.equal((await avaliar({query(){throw Error('NAO DEVERIA CONSULTAR');}},1,{})).classificacao,'INCONSISTENTE');
});
test('sem transacao e erro SQL sao sanitizados e nunca encerram conexao',async()=>{
    const c={query:async()=>[[{em_transacao:0}]]};assert.equal((await avaliar(c,1,ctx)).elegivel,false);
    const r=await avaliar({query(){throw Error('senha /privado token');}},1,ctx);assert.doesNotMatch(JSON.stringify(r),/senha|privado|token/);
});
test('estado do direito nao e reescrito; versao retirada nao substitui o arquivo adquirido',async()=>{
    for(const estado of ['ATIVO','SUSPENSO','REVOGADO']){const b=base();b.direitos[0].estado=estado;const r=await avaliar(banco(b),1,ctx);
        assert.equal(r.elegivel,true);assert.equal(r.referencias.direitos[0].estado,estado);}
});

for(const [classificacao,esperado]of [['REEMBOLSO_CONFIRMADO','ADVERSO'],['RISCO_DISPUTA','REVISAO'],
    ['DISPUTA_ENCERRADA','REVISAO'],['INCOMPLETA','REVISAO'],['CONTRADITORIA','INCONSISTENTE']])test(`D8 evidencia normalizada ${classificacao} bloqueia sem reescrever direitos`,async()=>{
    const b=base(),antes=structuredClone(b.direitos);
    evento(b,{contrato:'IST_EVIDENCIA_ADVERSA_V1',eventoOrigem:'WH-TESTE',hashOrigem:'a'.repeat(64),contexto:ctx,
        tipo:classificacao==='REEMBOLSO_CONFIRMADO'?'REEMBOLSO':'DISPUTA',recursoId:'RECURSO123',capturaId:b.r.capturaId,
        classificacao,valorCentavos:'50',moeda:'BRL'});
    b.eventos[0].tipo='EVIDENCIA_ADVERSA';
    assert.equal((await avaliar(banco(b),1,ctx)).classificacao,esperado);assert.deepEqual(b.direitos,antes);
});
test('D8 evidencia normalizada invalida nunca permite elegibilidade',async()=>{
    const b=base();evento(b,{});b.eventos[0].tipo='EVIDENCIA_ADVERSA';
    assert.equal((await avaliar(banco(b),1,ctx)).classificacao,'INCONSISTENTE');
});

test('avaliador em MariaDB descartavel: SQL real, somente leitura e integridade',{
    skip:!process.env.IST_LOJA_PAGAMENTOS_MARIADB_BIN&&!process.env.IST_R2_10339_MANIFEST,timeout:120000
},async t=>{
    const antigo=Boolean(process.env.IST_R2_10339_MANIFEST);
    const {criarBancoPagamentoIsolado}=await import(antigo?'./fixtures/lojaCatalogoMariaDB10339.js':'./fixtures/lojaPagamentoBancoIsolado.js');
    const {admin:a,versao}=await criarBancoPagamentoIsolado(t);
    assert.match(versao,antigo?/^10\.3\.39-MariaDB/:/^13\.0\.2-MariaDB/);
    const fonte=await readFile(new URL('../migrations/ist_loja_downloads_fundacao.sql',import.meta.url),'utf8');
    await a.query('ALTER TABLE ist_loja_pedido_itens ADD UNIQUE KEY uq_lpi_id_produto_download(id,produto_id)');
    for(const ddl of fonte.match(/CREATE TABLE ist_loja_(?:arquivo_versoes|download_direitos|download_direito_eventos) \([\s\S]*?\) ENGINE=InnoDB[^;]*;/g))await a.query(ddl);
    await a.query("INSERT INTO ist_loja_categorias(id,nome,slug) VALUES(1,'Sintetico','sintetico')");await a.query('INSERT INTO ist_livros(id) VALUES(1)');
    await a.query("INSERT INTO ist_loja_produtos(id,categoria_id,livro_id,sku) VALUES(1,1,1,'SINTETICO')");
    await a.execute("INSERT INTO ist_loja_sessoes(id,token_hash,criada_em,expira_em) VALUES(1,?,'2026-01-01','2026-01-02')",[Buffer.alloc(32,1)]);
    const b=base();
    await a.execute(`INSERT INTO ist_loja_pedidos(id,public_id,sessao_id,comprador_email,estado,ambiente,moeda,total_centavos,
        idempotencia_criacao,solicitacao_hash,criado_em,atualizado_em,expira_em,pagamento_confirmado_em)
        VALUES(1,?,1,'sintetico@example.invalid','PAGO','sandbox','BRL',100,?,?,'2026-01-01','2026-01-01 12:00:00','2026-01-02','2026-01-01 12:00:00')`,[randomUUID(),randomUUID(),Buffer.alloc(32,2)]);
    await a.query("INSERT INTO ist_loja_pedido_itens(id,pedido_id,produto_id,posicao,sku_snapshot,titulo_snapshot,tipo_snapshot,quantidade,preco_unitario_centavos,subtotal_centavos) VALUES(1,1,1,1,'SINTETICO','Sintetico','DIGITAL',1,100,100)");
    await a.execute(`INSERT INTO ist_loja_pagamentos(id,public_id,pedido_id,provedor,ambiente,conta_recebedora,estado,reserva_ativa,moeda,
        valor_centavos,capturado_centavos,ordem_externa_id,captura_externa_id,criado_em,atualizado_em,expira_em,capturado_em,encerrado_em)
        VALUES(1,?,1,'paypal','sandbox',?,'CAPTURADO',NULL,'BRL',100,100,?,?,'2026-01-01','2026-01-01 12:00:00','2026-01-02','2026-01-01 12:00:00','2026-01-01 12:00:00')`,[b.r.referencia,ctx.contaRecebedora,b.r.ordemId,b.r.capturaId]);
    await a.execute(`INSERT INTO ist_loja_pagamento_operacoes(id,pagamento_id,pedido_id,acao,chave_idempotencia,solicitacao_hash,
        request_id_provedor,estado,resultado_json,criado_em,atualizado_em,envio_iniciado_em,concluido_em)
        VALUES(1,1,1,'CAPTURAR',?,?,?,'SUCESSO',?,'2026-01-01','2026-01-01 12:00:00','2026-01-01','2026-01-01 12:00:00')`,[randomUUID(),Buffer.alloc(32,3),randomUUID(),JSON.stringify(b.r)]);
    await a.execute(`INSERT INTO ist_loja_arquivo_versoes(id,public_id,produto_id,arquivo_logico_id,numero_versao,caminho_relativo,
        tamanho_bytes,sha256,mime,estado,criado_em,publicado_em,retirado_em)
        VALUES(1,?,1,?,1,'sintetico.pdf',32,?,'application/pdf','RETIRADA','2026-01-01','2026-01-01','2026-01-01')`,[randomUUID(),randomUUID(),Buffer.alloc(32,4)]);
    await a.execute("INSERT INTO ist_loja_download_direitos(id,public_id,pedido_item_id,produto_id,arquivo_versao_id,criado_em,atualizado_em) VALUES(1,?,1,1,1,'2026-01-01','2026-01-01')",[randomUUID()]);
    const somenteLeitura={query(sql,args){assert.match(sql,/^SELECT /);assert.doesNotMatch(sql,/FOR UPDATE|LOCK IN SHARE/);return a.query(sql,args);}};
    await t.test('captura consistente, repeticao e nenhuma mutacao em transacao READ ONLY',async()=>{
        await a.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');try{
            const r=await avaliar(somenteLeitura,1,ctx);assert.equal(r.elegivel,true);assert.deepEqual(await avaliar(somenteLeitura,1,ctx),r);
            assert.equal(Number((await a.query('SELECT @@in_transaction n'))[0][0].n),1);
        }finally{await a.rollback();}
    });
    const variantes=[
        ['valor divergente',"UPDATE ist_loja_pagamentos SET capturado_centavos=99 WHERE id=1",'INCONSISTENTE'],
        ['reembolso parcial',"UPDATE ist_loja_pagamentos SET reembolsado_centavos=50 WHERE id=1",'ADVERSO'],
        ['revisao',"UPDATE ist_loja_pedidos SET estado='REVISAO',motivo_revisao='SINTETICO' WHERE id=1",'REVISAO'],
        ['historico sem direito','DELETE FROM ist_loja_download_direitos WHERE id=1','INCONSISTENTE'],
        ['resultado invalido',"UPDATE ist_loja_pagamento_operacoes SET resultado_json='{}' WHERE id=1",'INCONSISTENTE'],
        ['operacao incerta',"UPDATE ist_loja_pagamento_operacoes SET estado='DESCONHECIDA' WHERE id=1",'PENDENTE']
    ];
    for(const [nome,sql,esperado]of variantes)await t.test(nome,async()=>{
        await a.beginTransaction();try{await a.query(sql);const r=await avaliar(somenteLeitura,1,ctx);assert.equal(r.classificacao,esperado);assert.equal(r.elegivel,false);}finally{await a.rollback();}
    });
    await t.test('reconciliacao real persistida e observacao adversa',async()=>{
        await a.beginTransaction();try{
            await a.execute('UPDATE ist_loja_pagamento_operacoes SET resultado_json=? WHERE id=1',[JSON.stringify(envelope(b.r))]);
            assert.equal((await avaliar(somenteLeitura,1,ctx)).elegivel,true);
            const e=envelope({...b.r,estado:'DESCONHECIDO',capturadoEm:null});e.observacao.statusCaptura='PARTIALLY_REFUNDED';e.observacao.validacao='INCONCLUSIVA';
            await a.execute(`INSERT INTO ist_loja_pagamento_eventos(pagamento_id,provedor,ambiente,conta_recebedora,origem,evento_id,tipo,
                conteudo_hash,evidencia_json,estado,recebido_em,autenticado_em,atualizado_em,processado_em)
                VALUES(1,'paypal','sandbox',?,'RECONCILIACAO',?,'DESCONHECIDO',?,?,'PROCESSADO','2026-01-01','2026-01-01','2026-01-01','2026-01-01')`,
            [ctx.contaRecebedora,randomUUID(),createHash('sha256').update(JSON.stringify(e)).digest(),JSON.stringify(e)]);
            assert.equal((await avaliar(somenteLeitura,1,ctx)).classificacao,'ADVERSO');
        }finally{await a.rollback();}
    });
    t.diagnostic(`Avaliador somente SELECT homologado em ${versao}; nenhum pedido real ou PDF acessado.`);
});
