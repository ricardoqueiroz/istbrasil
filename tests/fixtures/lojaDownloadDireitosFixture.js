import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import mysql from 'mysql2/promise';
import assert from 'node:assert/strict';

export const contextoDireitos={provedor:'paypal',ambiente:'sandbox',contaRecebedora:'RECEBEDOR-SINTETICO'};
export const criarFixtureDireitos=async t=>{
    const antigo=Boolean(process.env.IST_R2_10339_MANIFEST);
    const {criarBancoPagamentoIsolado}=await import(antigo?'./lojaCatalogoMariaDB10339.js':'./lojaPagamentoBancoIsolado.js');
    const f=await criarBancoPagamentoIsolado(t),a=f.admin;
    const [[identidade]]=await a.query('SELECT VERSION() versao,DATABASE() banco,@@port porta');
    assert.match(identidade.versao,antigo?/^10\.3\.39-MariaDB/:/^13\.0\.2-MariaDB/);
    const cfg=a.config??a.connection.config;
    const config={host:cfg.host,port:cfg.port,user:cfg.user,password:cfg.password,database:identidade.banco,dateStrings:true,connectionLimit:8};
    const pool=f.pool??mysql.createPool(config);if(!f.pool)t.after(()=>pool.end());
    const fonte=await readFile(new URL('../../migrations/ist_loja_downloads_fundacao.sql',import.meta.url),'utf8');
    await a.query('ALTER TABLE ist_loja_pedido_itens ADD UNIQUE KEY uq_lpi_id_produto_download(id,produto_id)');
    for(const ddl of fonte.match(/CREATE TABLE ist_loja_(?:arquivo_versoes|download_direitos|download_direito_eventos) \([\s\S]*?\) ENGINE=InnoDB[^;]*;/g))await a.query(ddl);
    await a.query("INSERT INTO ist_loja_categorias(id,nome,slug) VALUES(1,'Sintetico','sintetico')");
    await a.query('INSERT INTO ist_livros(id) VALUES(1),(2)');
    await a.query("INSERT INTO ist_loja_produtos(id,categoria_id,livro_id,sku) VALUES(1,1,1,'SINT-1'),(2,1,2,'SINT-2')");
    for(const id of [1,2])await a.execute(`INSERT INTO ist_loja_arquivo_versoes
        (id,public_id,produto_id,arquivo_logico_id,numero_versao,caminho_relativo,tamanho_bytes,sha256,mime,estado,criado_em,publicado_em,retirado_em)
        VALUES(?,?,?, ?,1,?,32,?,'application/pdf','RETIRADA','2026-01-01','2026-01-01','2026-01-01')`,[id,randomUUID(),id,randomUUID(),`sintetico-${id}.pdf`,Buffer.alloc(32,id)]);
    const preparar=async({estadoDireito='AGUARDANDO_CONFIRMACAO',semDireitos=false}={})=>{
        const [s]=await a.execute("INSERT INTO ist_loja_sessoes(token_hash,criada_em,expira_em) VALUES(?,'2026-01-01','2026-01-02')",[randomBytes(32)]);
        const [p]=await a.execute(`INSERT INTO ist_loja_pedidos(public_id,sessao_id,comprador_email,estado,ambiente,moeda,total_centavos,
            idempotencia_criacao,solicitacao_hash,criado_em,atualizado_em,expira_em,pagamento_confirmado_em)
            VALUES(?,?,'sintetico@example.invalid','PAGO','sandbox','BRL',200,?,?,'2026-01-01','2026-01-01 12:00:00','2026-01-02','2026-01-01 12:00:00')`,[randomUUID(),s.insertId,randomUUID(),randomBytes(32)]);
        const pgPublic=randomUUID(),ordem=randomUUID(),captura=randomUUID();
        const [pg]=await a.execute(`INSERT INTO ist_loja_pagamentos(public_id,pedido_id,provedor,ambiente,conta_recebedora,estado,reserva_ativa,moeda,
            valor_centavos,capturado_centavos,ordem_externa_id,captura_externa_id,criado_em,atualizado_em,expira_em,capturado_em,encerrado_em)
            VALUES(?,?,'paypal','sandbox',?,'CAPTURADO',NULL,'BRL',200,200,?,?,'2026-01-01','2026-01-01 12:00:00','2026-01-02','2026-01-01 12:00:00','2026-01-01 12:00:00')`,[pgPublic,p.insertId,contextoDireitos.contaRecebedora,ordem,captura]);
        const resultado={estado:'CAPTURADO',referencia:pgPublic,ordemId:ordem,capturaId:captura,valorCentavos:'200',moeda:'BRL',ambiente:'sandbox',contaRecebedora:contextoDireitos.contaRecebedora,capturadoEm:'2026-01-01T12:00:00.000Z'};
        const [op]=await a.execute(`INSERT INTO ist_loja_pagamento_operacoes(pagamento_id,pedido_id,acao,chave_idempotencia,solicitacao_hash,
            request_id_provedor,estado,resultado_json,criado_em,atualizado_em,envio_iniciado_em,concluido_em)
            VALUES(?,?,'CAPTURAR',?,?,?,'SUCESSO',?,'2026-01-01','2026-01-01 12:00:00','2026-01-01','2026-01-01 12:00:00')`,[pg.insertId,p.insertId,randomUUID(),randomBytes(32),randomUUID(),JSON.stringify(resultado)]);
        await a.execute(`INSERT INTO ist_loja_pagamento_eventos(pagamento_id,provedor,ambiente,conta_recebedora,origem,evento_id,tipo,
            conteudo_hash,evidencia_json,estado,recebido_em,autenticado_em,atualizado_em,processado_em)
            VALUES(?,'paypal','sandbox',?,'API',?,'CAPTURADO',?,?,'PROCESSADO','2026-01-01 12:00:00','2026-01-01 12:00:00','2026-01-01 12:00:00','2026-01-01 12:00:00')`,
        [pg.insertId,contextoDireitos.contaRecebedora,randomUUID(),createHash('sha256').update(JSON.stringify(resultado)).digest(),JSON.stringify(resultado)]);
        const direitos=[];
        for(const produto of [1,2]){
            const [i]=await a.execute(`INSERT INTO ist_loja_pedido_itens(pedido_id,produto_id,posicao,sku_snapshot,titulo_snapshot,tipo_snapshot,quantidade,preco_unitario_centavos,subtotal_centavos)
                VALUES(?,?,?,?,'Sintetico','DIGITAL',1,100,100)`,[p.insertId,produto,produto,`SINT-${produto}`]);
            if(semDireitos)continue;
            const [d]=await a.execute(`INSERT INTO ist_loja_download_direitos(public_id,pedido_item_id,produto_id,arquivo_versao_id,
                criado_em,atualizado_em) VALUES(?,?,?,?,'2026-01-01','2026-01-01')`,[randomUUID(),i.insertId,produto,produto]);
            direitos.push(d.insertId);
            await a.execute(`INSERT INTO ist_loja_download_direito_eventos(direito_id,direito_versao,estado_anterior,estado_novo,origem,motivo_codigo,ocorrido_em)
                VALUES(?,1,NULL,'AGUARDANDO_CONFIRMACAO','PEDIDO','DIREITO_CRIADO','2026-01-01')`,[d.insertId]);
            if(estadoDireito!=='AGUARDANDO_CONFIRMACAO'){
                const campo=estadoDireito==='ATIVO'?'ativado_em':estadoDireito==='SUSPENSO'?'suspenso_em':'revogado_em';
                const motivo=estadoDireito==='ATIVO'?null:'SINTETICO';
                await a.execute(`UPDATE ist_loja_download_direitos SET estado=?,versao=2,${campo}='2026-01-01 12:00:00',
                    atualizado_em='2026-01-01 12:00:00',motivo_codigo=? WHERE id=?`,[estadoDireito,motivo,d.insertId]);
                await a.execute(`INSERT INTO ist_loja_download_direito_eventos(direito_id,direito_versao,estado_anterior,estado_novo,origem,motivo_codigo,ocorrido_em)
                    VALUES(?,2,'AGUARDANDO_CONFIRMACAO',?,'FINANCEIRO',?,'2026-01-01 12:00:00')`,[d.insertId,estadoDireito,motivo??'CAPTURA_CONFIRMADA']);
            }
        }
        return {pedidoId:p.insertId,sessaoId:s.insertId,pagamentoId:pg.insertId,operacaoId:op.insertId,direitos,resultado};
    };
    const ler=async x=>{
        const [direitos]=await a.execute(`SELECT d.* FROM ist_loja_download_direitos d JOIN ist_loja_pedido_itens i ON i.id=d.pedido_item_id WHERE i.pedido_id=? ORDER BY d.id`,[x.pedidoId]);
        const [eventos]=await a.execute(`SELECT e.* FROM ist_loja_download_direito_eventos e JOIN ist_loja_download_direitos d ON d.id=e.direito_id
            JOIN ist_loja_pedido_itens i ON i.id=d.pedido_item_id WHERE i.pedido_id=? ORDER BY e.id`,[x.pedidoId]);
        return {direitos,eventos};
    };
    return {a,pool,config,preparar,ler,identidade};
};
