import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { AsyncLocalStorage } from 'node:async_hooks';
import mysql from 'mysql2/promise';
import { criarLojaPagamentoService } from '../src/services/lojaPagamentoService.js';
import { criarPaypalProvider } from '../src/services/pagamentos/paypalProvider.js';
import { criarProcessadorWebhookPayPal } from '../src/services/lojaPaypalWebhook.js';
import { avaliarElegibilidadeFinanceiraNaConexao } from '../src/services/lojaDownloadFinanceiroService.js';
import { criarLojaDownloadAutorizacaoService } from '../src/services/lojaDownloadAutorizacaoService.js';

test('D8-B2/B3 reconciliacao adversa real, historico preservado e PayPal somente simulado',async t=>{
    const antigo=Boolean(process.env.IST_R2_10339_MANIFEST);
    const {criarBancoPagamentoIsolado}=await import(antigo?'./fixtures/lojaCatalogoMariaDB10339.js':'./fixtures/lojaPagamentoBancoIsolado.js');
    const fx=await criarBancoPagamentoIsolado(t),{admin:a,versao}=fx;
    const config=a.config??a.connection.config;
    const [[{banco}]]=await a.query('SELECT DATABASE() banco');
    const pool=fx.pool??mysql.createPool({host:config.host,port:config.port,user:config.user,password:config.password,
        database:banco,dateStrings:true,supportBigNumbers:true,bigNumberStrings:true,connectionLimit:10});
    if(!fx.pool)t.after(()=>pool.end());
    const contexto={provedor:'paypal',ambiente:'sandbox',contaRecebedora:'QYR5Z8XDVJNXQ'};
    const fonte=await readFile(new URL('../migrations/ist_loja_downloads_fundacao.sql',import.meta.url),'utf8');
    await a.query('ALTER TABLE ist_loja_pedido_itens ADD UNIQUE KEY uq_lpi_id_produto_download(id,produto_id)');
    for(const ddl of fonte.match(/CREATE TABLE ist_loja_(?:arquivo_versoes|download_direitos|download_direito_eventos) \([\s\S]*?\) ENGINE=InnoDB[^;]*;/g))await a.query(ddl);
    await a.query("INSERT INTO ist_loja_categorias(id,nome,slug) VALUES(1,'Sintetico','sintetico')");
    await a.query('INSERT INTO ist_livros(id) VALUES(1)');
    await a.query("INSERT INTO ist_loja_produtos(id,categoria_id,livro_id,sku) VALUES(1,1,1,'SINTETICO')");
    await a.execute(`INSERT INTO ist_loja_arquivo_versoes(id,public_id,produto_id,arquivo_logico_id,numero_versao,caminho_relativo,
        tamanho_bytes,sha256,mime,estado,criado_em,publicado_em,retirado_em)
        VALUES(1,?,1,?,1,'sintetico.pdf',32,?,'application/pdf','RETIRADA','2026-01-01','2026-01-01','2026-01-01')`,[randomUUID(),randomUUID(),randomBytes(32)]);
    let serial=0;
    const criar=async()=>{
        const n=++serial,ordemId=`ORDER${n}`,capturaId=`CAPTURE${n}`,referencia=randomUUID();
        const token=randomBytes(32).toString('base64url'),direitoPublicId=randomUUID();
        const [s]=await a.execute("INSERT INTO ist_loja_sessoes(token_hash,criada_em,expira_em) VALUES(?,'2026-01-01','2026-01-02')",[createHash('sha256').update(token).digest()]);
        const [p]=await a.execute(`INSERT INTO ist_loja_pedidos(public_id,sessao_id,comprador_email,estado,ambiente,moeda,total_centavos,
            idempotencia_criacao,solicitacao_hash,criado_em,atualizado_em,expira_em,pagamento_confirmado_em)
            VALUES(?,?,'sintetico@example.invalid','PAGO','sandbox','BRL',100,?,?,'2026-01-01','2026-01-01 12:00:00','2026-01-02','2026-01-01 12:00:00')`,[randomUUID(),s.insertId,randomUUID(),randomBytes(32)]);
        const [i]=await a.execute(`INSERT INTO ist_loja_pedido_itens(pedido_id,produto_id,posicao,sku_snapshot,titulo_snapshot,tipo_snapshot,
            quantidade,preco_unitario_centavos,subtotal_centavos) VALUES(?,1,1,'SINTETICO','Sintetico','DIGITAL',1,100,100)`,[p.insertId]);
        const [pg]=await a.execute(`INSERT INTO ist_loja_pagamentos(public_id,pedido_id,provedor,ambiente,conta_recebedora,estado,
            reserva_ativa,moeda,valor_centavos,capturado_centavos,ordem_externa_id,captura_externa_id,
            criado_em,atualizado_em,expira_em,capturado_em,encerrado_em)
            VALUES(?,?,'paypal','sandbox',?,'CAPTURADO',NULL,'BRL',100,100,?,?,'2026-01-01','2026-01-01 12:00:00','2026-01-02','2026-01-01 12:00:00','2026-01-01 12:00:00')`,[referencia,p.insertId,contexto.contaRecebedora,ordemId,capturaId]);
        const resultado={estado:'CAPTURADO',referencia,ambiente:'sandbox',ordemId,capturaId,valorCentavos:'100',moeda:'BRL',contaRecebedora:contexto.contaRecebedora,capturadoEm:'2026-01-01T12:00:00.000Z'};
        await a.execute(`INSERT INTO ist_loja_pagamento_operacoes(pedido_id,pagamento_id,acao,chave_idempotencia,solicitacao_hash,
            request_id_provedor,estado,resultado_json,criado_em,atualizado_em,envio_iniciado_em,concluido_em)
            VALUES(?,?,'CAPTURAR',?,?,?,'SUCESSO',?,'2026-01-01','2026-01-01 12:00:00','2026-01-01','2026-01-01 12:00:00')`,[p.insertId,pg.insertId,randomUUID(),randomBytes(32),randomUUID(),JSON.stringify(resultado)]);
        const [d]=await a.execute(`INSERT INTO ist_loja_download_direitos(public_id,pedido_item_id,produto_id,arquivo_versao_id,estado,
            criado_em,atualizado_em,ativado_em) VALUES(?,?,1,1,'ATIVO','2026-01-01','2026-01-01 12:00:00','2026-01-01 12:00:00')`,[direitoPublicId,i.insertId]);
        await a.execute(`INSERT INTO ist_loja_download_direito_eventos(direito_id,direito_versao,estado_anterior,estado_novo,origem,motivo_codigo,ocorrido_em)
            VALUES(?,1,NULL,'ATIVO','FINANCEIRO','SINTETICO','2026-01-01 12:00:00')`,[d.insertId]);
        const execucao=new AsyncLocalStorage(),transacoes=new Map();
        let modo=null,disparou=false,antesGet=null;
        const consultas=[],chamadas=[],respostas=new Map();
        const db={getConnection:async()=>{
            const dono=execucao.getStore()??'ingestao';
            const c=await pool.getConnection();let tx=false,derivou=false;
            const sair=()=>{if(tx){tx=false;transacoes.set(dono,(transacoes.get(dono)??0)-1);}};
            return {beginTransaction:async()=>{await c.beginTransaction();tx=true;transacoes.set(dono,(transacoes.get(dono)??0)+1);},
                query:async(sql,ps=[])=>{
                    consultas.push(sql);
                    if(sql.startsWith('INSERT INTO ist_loja_pagamento_eventos')&&ps.includes('EVIDENCIA_ADVERSA')){
                        derivou=true;if(modo==='sql'&&!disparou){disparou=true;throw Error('SEGREDO-SINTETICO');}
                    }
                    return c.query(sql,ps);
                },commit:async()=>{
                    if(derivou&&modo?.startsWith('commit')&&!disparou){disparou=true;
                        if(modo==='commit-depois'){await c.commit();sair();}throw Error('COMMIT-PERDIDO');}
                    await c.commit();sair();
                },rollback:async()=>{await c.rollback();sair();},destroy:()=>{c.destroy();sair();},release:()=>{assert.equal(tx,false);c.release();}};
        }};
        const captura={id:capturaId,status:'COMPLETED',amount:{value:'1.00',currency_code:'BRL'},payee:{merchant_id:contexto.contaRecebedora},
            supplementary_data:{related_ids:{order_id:ordemId}}};
        respostas.set(`/v2/payments/captures/${capturaId}`,captura);
        const adaptador=criarPaypalProvider({env:{IST_LOJA_PAYPAL_ENV:'sandbox',IST_LOJA_PAYPAL_CLIENT_ID:'fixture',IST_LOJA_PAYPAL_CLIENT_SECRET:'fixture-secret'},
            http:{request:async c=>{
                assert.equal(transacoes.get(execucao.getStore()??'ingestao')??0,0,'GET/OAuth nunca sob transacao da propria chamada');assert.equal(new URL(c.url).origin,'https://api-m.sandbox.paypal.com');
                assert.equal(c.maxRedirects,0);chamadas.push(c);
                const path=new URL(c.url).pathname;
                if(path==='/v1/oauth2/token')return {status:200,data:{token_type:'Bearer',access_token:'fixture-token',expires_in:3600}};
                if(path==='/v1/notifications/verify-webhook-signature')return {status:200,data:{verification_status:'SUCCESS'}};
                assert.equal(c.method,'GET');if(antesGet)await antesGet(path);
                if(!respostas.has(path))return {status:503,data:{}};
                return {status:200,data:respostas.get(path)};
            }}});
        const original=criarLojaPagamentoService({db,adaptador,contexto,agora:()=>new Date('2026-01-04T00:00:00Z')});
        const service={...original,reconciliarEventoAdverso:entrada=>execucao.run(Symbol('chamada'),()=>original.reconciliarEventoAdverso(entrada))};
        const processar=criarProcessadorWebhookPayPal({obterWebhookId:()=> 'WEBHOOK-SINTETICO',obterFinanceiro:()=>({service,adaptador})});
        const headers={'paypal-transmission-id':'TX-SINTETICO','paypal-transmission-time':'2026-01-01T00:00:00Z','paypal-transmission-sig':'SIGNATURE',
            'paypal-auth-algo':'SHA256withRSA','paypal-cert-url':'https://api-m.sandbox.paypal.com/v1/notifications/certs/CERT-SINTETICO'};
        const enviar=async e=>{await processar({corpo:Buffer.from(JSON.stringify(e)),cabecalhos:headers});return e.id;};
        const refund=async(valor='0.50',id=`REFUND${n}`,eventoId=`WH-${randomUUID()}`)=>{
            const resource={id,status:'COMPLETED',amount:{value:valor,currency_code:'BRL'},links:[{rel:'up',method:'GET',href:`https://api-m.sandbox.paypal.com/v2/payments/captures/${capturaId}`} ]};
            respostas.set(`/v2/payments/refunds/${id}`,resource);
            return enviar({id:eventoId,event_type:'PAYMENT.CAPTURE.REFUNDED',resource_type:'refund',resource_version:'2.0',resource});
        };
        const disputa=async(sufixo='CREATED',status='OPEN',desfecho=null,extras={})=>{
            const resource={dispute_id:`PP-D-${n}`,status,disputed_transactions:[{seller_transaction_id:capturaId}],
                dispute_amount:{value:'1.00',currency_code:'BRL'},dispute_outcome:{outcome_code:desfecho},...extras};
            respostas.set(`/v1/customer/disputes/PP-D-${n}`,resource);
            return enviar({id:`WH-${randomUUID()}`,event_type:`CUSTOMER.DISPUTE.${sufixo}`,resource});
        };
        const estado=async()=>{
            const [[r]]=await a.query('SELECT estado,CAST(reembolsado_centavos AS CHAR) reembolso,CAST(capturado_centavos AS CHAR) capturado,captura_externa_id FROM ist_loja_pagamentos WHERE id=?',[pg.insertId]);return r;
        };
        const avaliar=async()=>{await a.beginTransaction();try{return await avaliarElegibilidadeFinanceiraNaConexao(a,p.insertId,contexto);}finally{await a.rollback();}};
        const autorizar=async()=>{
            const svc=criarLojaDownloadAutorizacaoService({db:pool,contextoEsperado:contexto,agora:()=>new Date('2026-01-01T13:00:00Z')});
            const c=await pool.getConnection();
            try{await c.query('SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED');await c.beginTransaction();
                return await svc.autorizarArquivoNaConexao(c,token,direitoPublicId);
            }finally{try{await c.rollback();}finally{c.destroy();}}
        };
        const intactos=async()=>{
            const [ops]=await a.query('SELECT * FROM ist_loja_pagamento_operacoes WHERE pagamento_id=?',[pg.insertId]);
            const [ds]=await a.query('SELECT * FROM ist_loja_download_direitos WHERE id=?',[d.insertId]);
            const [es]=await a.query('SELECT * FROM ist_loja_download_direito_eventos WHERE direito_id=?',[d.insertId]);
            const [is]=await a.query('SELECT * FROM ist_loja_pedido_itens WHERE pedido_id=?',[p.insertId]);
            const [capturas]=await a.query(`SELECT public_id,ordem_externa_id,captura_externa_id,valor_centavos,capturado_centavos,
                criado_em,expira_em,capturado_em,encerrado_em FROM ist_loja_pagamentos WHERE id=?`,[pg.insertId]);
            return JSON.stringify({ops,ds,es,is,capturas});
        };
        const antes=await intactos();
        return {service,refund,disputa,enviar,respostas,captura,estado,avaliar,autorizar,consultas,chamadas,pg:pg.insertId,pedido:p.insertId,
            configurarFalha:m=>{modo=m;},antesGet:f=>{antesGet=f;},validarIntactos:async()=>{
                // B3 acrescenta somente suspensao e seu evento. Historico de
                // captura, operacoes e snapshots continua integralmente imutavel.
                const base=JSON.parse(antes),atual=JSON.parse(await intactos());
                for(const k of ['ops','is','capturas'])assert.deepEqual(atual[k],base[k]);
                assert.equal(atual.ds.length,1);const d=atual.ds[0],b=base.ds[0];
                for(const k of ['id','public_id','pedido_item_id','produto_id','arquivo_versao_id','criado_em','ativado_em','revogado_em'])assert.deepEqual(d[k],b[k]);
                if(d.estado==='ATIVO'){assert.deepEqual(d,b);assert.deepEqual(atual.es,base.es);}
                else{
                    assert.equal(d.estado,'SUSPENSO');assert.equal(d.versao,b.versao+1);assert.ok(d.suspenso_em);
                    assert.equal(atual.es.length,base.es.length+1);assert.deepEqual(atual.es.slice(0,base.es.length),base.es);
                    const ev=atual.es.at(-1);assert.equal(ev.estado_anterior,'ATIVO');assert.equal(ev.estado_novo,'SUSPENSO');assert.equal(ev.origem,'FINANCEIRO');
                }
            }};
    };
    await t.test('parcial, dois recursos distintos e integral; repeticoes nao somam notificacoes',async()=>{
        const c=await criar();assert.equal((await c.avaliar()).classificacao,'ELEGIVEL');
        const e=await c.refund();await c.service.reconciliarEventoAdverso({eventoId:e});
        assert.equal((await c.estado()).reembolso,'50');assert.equal((await c.estado()).estado,'PARCIALMENTE_REEMBOLSADO');
        await c.service.reconciliarEventoAdverso({eventoId:e});
        const repetido=await c.refund();await c.service.reconciliarEventoAdverso({eventoId:repetido});assert.equal((await c.estado()).reembolso,'50');
        const segundo=await c.refund('0.50','REFUND-SEGUNDO');await c.service.reconciliarEventoAdverso({eventoId:segundo});
        assert.equal((await c.estado()).estado,'REEMBOLSADO');assert.equal((await c.estado()).reembolso,'100');
        assert.equal((await c.avaliar()).classificacao,'ADVERSO');await c.validarIntactos();
    });
    await t.test('reembolso integral isolado nao depende do nome do evento',async()=>{
        const c=await criar(),e=await c.refund('1.00');await c.service.reconciliarEventoAdverso({eventoId:e});
        assert.equal((await c.estado()).estado,'REEMBOLSADO');await c.validarIntactos();
    });
    await t.test('autorizacao final D6 nega apos suspensao atomica B3',async()=>{
        for(const disputa of [false,true]){
            const c=await criar();assert.equal((await c.autorizar()).mime,'application/pdf');
            const e=disputa?await c.disputa():await c.refund();await c.service.reconciliarEventoAdverso({eventoId:e});
            await assert.rejects(c.autorizar(),{codigo:'DIREITO_INDISPONIVEL'});await c.validarIntactos();
        }
    });
    await t.test('limite acumulado e mesmo recurso com montante divergente vao para revisao',async()=>{
        for(const repetir of [true,false]){
            const c=await criar();await c.service.reconciliarEventoAdverso({eventoId:await c.refund('0.75')});
            const e=await c.refund('0.50',repetir?undefined:'OUTRO-REFUND');
            assert.equal((await c.service.reconciliarEventoAdverso({eventoId:e})).classificacao,'CONTRADITORIA');
            assert.equal((await c.estado()).reembolso,'75');assert.equal((await c.estado()).estado,'REVISAO');await c.validarIntactos();
        }
    });
    for(const [sufixo,status,desfecho]of [['CREATED','OPEN',null],['UPDATED','UNDER_REVIEW',null],
        ['RESOLVED','RESOLVED','RESOLVED_SELLER_FAVOUR'],['RESOLVED','RESOLVED','RESOLVED_BUYER_FAVOUR']])await t.test(`disputa ${sufixo}/${desfecho??status} e risco, sem inventar chargeback`,async()=>{
        const c=await criar();await c.service.reconciliarEventoAdverso({eventoId:await c.disputa(sufixo,status,desfecho)});
        assert.equal((await c.estado()).estado,'REVISAO');assert.equal((await c.estado()).reembolso,'0');
        assert.equal((await c.avaliar()).classificacao,'REVISAO');await c.validarIntactos();
    });
    await t.test('evento favoravel antigo e resolucao favoravel nao removem risco anterior',async()=>{
        const c=await criar();const aberto=await c.disputa();await c.service.reconciliarEventoAdverso({eventoId:aberto});
        const fechado=await c.disputa('RESOLVED','RESOLVED','RESOLVED_SELLER_FAVOUR');await c.service.reconciliarEventoAdverso({eventoId:fechado});
        await c.service.reconciliarEventoAdverso({eventoId:aberto});
        await c.enviar({id:`WH-ANTIGO-${randomUUID()}`,event_type:'PAYMENT.CAPTURE.COMPLETED',resource:{id:c.captura.id,
            supplementary_data:{related_ids:{order_id:c.captura.supplementary_data.related_ids.order_id}}}});
        assert.equal((await c.avaliar()).elegivel,false);
        assert.equal((await c.estado()).estado,'REVISAO');await c.validarIntactos();
    });
    await t.test('mesmo recurso externo nao e contabilizado em outro pagamento',async()=>{
        const c1=await criar(),c2=await criar();
        await c1.service.reconciliarEventoAdverso({eventoId:await c1.refund('0.50','REFUND-GLOBAL')});
        const r=await c2.service.reconciliarEventoAdverso({eventoId:await c2.refund('0.50','REFUND-GLOBAL')});
        assert.equal(r.classificacao,'CONTRADITORIA');assert.equal((await c2.estado()).reembolso,'0');
        assert.equal((await c1.estado()).reembolso,'50');await c1.validarIntactos();await c2.validarIntactos();
    });
    for(const campo of ['moeda','recebedor','captura','ordem','incompleta'])await t.test(`GET com ${campo} divergente/incompleto nao contabiliza`,async()=>{
        const c=await criar(),e=await c.refund();
        if(campo==='moeda')c.captura.amount.currency_code='USD';
        if(campo==='recebedor')c.captura.payee.merchant_id='OUTRO-RECEBEDOR';
        if(campo==='captura')c.captura.id='OUTRACAPTURA';
        if(campo==='ordem')c.captura.supplementary_data.related_ids.order_id='OUTRAORDEM';
        if(campo==='incompleta')delete c.captura.payee;
        const r=await c.service.reconciliarEventoAdverso({eventoId:e});
        assert.equal(r.classificacao,campo==='incompleta'?'INCOMPLETA':'CONTRADITORIA');
        assert.equal((await c.estado()).reembolso,'0');assert.equal((await c.avaliar()).elegivel,false);await c.validarIntactos();
    });
    await t.test('sem correlacao e reversao sem contrato permanecem em revisao, sem efeito',async()=>{
        const c=await criar();
        for(const e of [{id:'WH-REVERSAO',event_type:'PAYMENT.CAPTURE.REVERSED',resource:{id:c.captura.id}},
            {id:'WH-SEM-CORRELACAO',event_type:'CUSTOMER.DISPUTE.CREATED',resource:{dispute_id:'PP-D-SEM'}}]){
            await c.enviar(e);const r=await c.service.reconciliarEventoAdverso({eventoId:e.id});assert.equal(r.efeitoFinanceiroAplicado,false);
        }
        assert.equal((await c.estado()).estado,'CAPTURADO');await c.validarIntactos();
    });
    await t.test('falha GET nao fabrica perda e permite nova consulta explicita',async()=>{
        const c=await criar(),e=await c.refund(),path=[...c.respostas.keys()].find(x=>x.includes('/refunds/')),r=c.respostas.get(path);
        c.respostas.delete(path);await c.service.reconciliarEventoAdverso({eventoId:e});
        assert.equal((await c.estado()).estado,'CAPTURADO');assert.equal((await c.avaliar()).elegivel,false);
        c.respostas.set(path,r);await c.service.reconciliarEventoAdverso({eventoId:e});assert.equal((await c.estado()).reembolso,'50');await c.validarIntactos();
    });
    for(const falha of ['sql','commit-antes','commit-depois'])await t.test(`rollback/COMMIT incerto ${falha}`,async()=>{
        const c=await criar(),e=await c.refund();c.configurarFalha(falha);
        if(falha==='commit-depois')assert.equal((await c.service.reconciliarEventoAdverso({eventoId:e})).reconciliado,true);
        else {
            await assert.rejects(c.service.reconciliarEventoAdverso({eventoId:e}),{codigo:falha==='sql'?'ERRO_PERSISTENCIA':'RESULTADO_DESCONHECIDO'});
            assert.equal((await c.estado()).reembolso,'0');
        }
        await c.service.reconciliarEventoAdverso({eventoId:e});assert.equal((await c.estado()).reembolso,'50');await c.validarIntactos();
    });
    await t.test('eventos concorrentes serializam; snapshot vencido exige retomada explicita',async()=>{
        const c=await criar(),e1=await c.refund('0.25','CONCORRENTE1'),e2=await c.refund('0.25','CONCORRENTE2');
        const rs=await Promise.allSettled([e1,e2].map(eventoId=>c.service.reconciliarEventoAdverso({eventoId})));
        for(let i=0;i<rs.length;i++)if(rs[i].status==='rejected'){
            assert.equal(rs[i].reason.codigo,'EVIDENCIA_DESATUALIZADA');await c.service.reconciliarEventoAdverso({eventoId:[e1,e2][i]});
        }
        assert.equal((await c.estado()).reembolso,'50');assert.equal((await c.estado()).capturado,'100');await c.validarIntactos();
        assert.equal(c.consultas.some(s=>/^DELETE/.test(s)),false);
    });
    await t.test('D9 vendedor da disputa divergente ou malformado impede vinculo financeiro',async()=>{
        for(const merchant_id of ['OUTRO-RECEBEDOR','../invalido']){
            const c=await criar(),id=await c.disputa();
            const path=[...c.respostas.keys()].find(p=>p.startsWith('/v1/customer/disputes/'));
            c.respostas.get(path).disputed_transactions[0].seller={merchant_id};
            const r=await c.service.reconciliarEventoAdverso({eventoId:id});
            assert.equal(r.efeitoFinanceiroAplicado,false);assert.equal((await c.estado()).reembolso,'0');
            await c.validarIntactos();
        }
    });
    await t.test('D9 movimento sem ID economico repetido entre webhook/GET nao soma; refund mantem identidade D8',async()=>{
        const c=await criar(),refund=await c.refund();await c.service.reconciliarEventoAdverso({eventoId:refund});
        const movimento={party:'SELLER',type:'DEBIT',reason:'DISPUTE_SETTLEMENT',
            amount:{value:'0.50',currency_code:'BRL'},initiated_time:'2026-01-01T00:00:00Z'};
        for(const sufixo of ['CREATED','UPDATED','RESOLVED']){
            const e=await c.disputa(sufixo,sufixo==='RESOLVED'?'RESOLVED':'OPEN','RESOLVED_SELLER_FAVOUR',{
                dispute_life_cycle_stage:'CHARGEBACK',fund_movements:[movimento,movimento]});
            await c.service.reconciliarEventoAdverso({eventoId:e});await c.service.reconciliarEventoAdverso({eventoId:e});
            assert.equal((await c.estado()).reembolso,'50');assert.equal((await c.estado()).capturado,'100');
            const [[ev]]=await a.query("SELECT evidencia_json FROM ist_loja_pagamento_eventos WHERE origem='RECONCILIACAO' AND tipo='EVIDENCIA_ADVERSA' AND evidencia_json LIKE ?",[`%${e}%`]);
            const d=JSON.parse(ev.evidencia_json).detalhesDisputa;
            assert.equal(d.identidadeEconomica,'NAO_COMPROVADA');assert.equal(d.movimentos.length,2);
        }
        await c.validarIntactos();await assert.rejects(c.autorizar(),{codigo:'DIREITO_INDISPONIVEL'});
    });
    t.diagnostic(`D8_B2_B3_FINANCEIRO: ${versao}; GETs simulados fora de transacoes; direitos suspensos atomicamente; captura historica preservada.`);
});
