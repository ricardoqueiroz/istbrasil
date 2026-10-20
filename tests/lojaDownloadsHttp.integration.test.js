import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {criarFixtureDireitos,contextoDireitos} from './fixtures/lojaDownloadDireitosFixture.js';
import {configurarHttpDownloads,pdfSintetico} from './fixtures/lojaDownloadsHttpFixture.js';
import {criarLojaSessaoService} from '../src/services/lojaSessaoService.js';
import {prepararArquivoValidado} from '../src/services/lojaDownloadArquivoService.js';

test('D6-B3 HTTP com autorizacao, preparacao e transicoes reais em MariaDB descartavel',{
    skip:!process.env.IST_LOJA_PAGAMENTOS_MARIADB_BIN&&!process.env.IST_R2_10339_MANIFEST,timeout:180000
},async t=>{
    const f=await criarFixtureDireitos(t),{a,pool}=f;
    const agora=()=>new Date('2026-01-01T13:00:00.000Z');
    for(const id of [1,2])await a.execute('UPDATE ist_loja_arquivo_versoes SET tamanho_bytes=?,sha256=? WHERE id=?',
        [String(pdfSintetico.length),createHash('sha256').update(pdfSintetico).digest(),id]);
    const montar=async(estadoDireito='AGUARDANDO_CONFIRMACAO',opcoes={})=>{
        const x=await f.preparar({estadoDireito});
        const h=await configurarHttpDownloads(t,{opcoes:{db:pool,contextoEsperado:contextoDireitos,agora,
            autorizacaoService:undefined,direitosService:undefined,sessaoService:criarLojaSessaoService({db:pool,agora}),...opcoes}});
        await a.execute('UPDATE ist_loja_sessoes SET token_hash=? WHERE id=?',[createHash('sha256').update(h.token).digest(),x.sessaoId]);
        for(const id of [1,2])await writeFile(path.join(h.raiz,`sintetico-${id}.pdf`),pdfSintetico);
        const d=(await f.ler(x)).direitos[0];
        const get=(options={})=>h.enviar(`/itens/${d.public_id}/arquivo`,options);
        const post=(id=d.public_id,body='{}')=>h.enviar(`/itens/${id}/reavaliar`,{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':h.csrf},body});
        return {...h,x,d,get,post};
    };
    const snapshot=async x=>{
        const rows=[];
        for(const [tab,campo,id]of [['ist_loja_pedidos','id',x.pedidoId],['ist_loja_pedido_itens','pedido_id',x.pedidoId],
            ['ist_loja_pagamentos','pedido_id',x.pedidoId],['ist_loja_pagamento_operacoes','pedido_id',x.pedidoId],['ist_loja_pagamento_eventos','pagamento_id',x.pagamentoId]])
            rows.push((await a.query(`SELECT * FROM ${tab} WHERE ${campo}=? ORDER BY id`,[id]))[0]);
        return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
    };
    const x=await montar();const historico=await snapshot(x.x);
    await t.test('GET lista sem ativar; GET e HEAD pendentes negados sem alteracao',async()=>{
        const antes=JSON.stringify(await f.ler(x.x));
        const r=await x.enviar('/direitos');assert.equal(r.status,200);const b=await r.json();assert.equal(b.direitos.length,2);assert.equal(b.direitos[0].estado,'AGUARDANDO_CONFIRMACAO');
        assert.equal((await x.get()).status,409);const head=await x.get({method:'HEAD'});assert.equal(head.status,409);assert.equal(await head.text(),'');
        assert.equal(JSON.stringify(await f.ler(x.x)),antes);
    });
    await t.test('propriedade SQL real: outro pedido e inexistente nao sofrem transicao',async()=>{
        const outro=await montar(),antes=JSON.stringify(await f.ler(outro.x));
        for(const id of [outro.d.public_id,randomUUID(),'invalido']){
            assert.equal((await x.enviar(`/itens/${id}/arquivo`)).status,404);assert.equal((await x.post(id)).status,404);
        }
        assert.equal(JSON.stringify(await f.ler(outro.x)),antes);
    });
    await t.test('POST com CSRF real ativa uma vez, retorna so publicId e estado',async()=>{
        assert.equal((await x.enviar(`/itens/${x.d.public_id}/reavaliar`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,403);
        const r=await x.post();assert.equal(r.status,200);assert.deepEqual(await r.json(),{publicId:x.d.public_id,estado:'ATIVO'});
        const antes=JSON.stringify(await f.ler(x.x));assert.equal((await x.post()).status,200);assert.equal(JSON.stringify(await f.ler(x.x)),antes);
    });
    await t.test('GET e HEAD entregam versao adquirida retirada; financeiros e direitos intactos',async()=>{
        const antes=JSON.stringify(await f.ler(x.x));const r=await x.get();assert.equal(r.status,200);assert.deepEqual(Buffer.from(await r.arrayBuffer()),pdfSintetico);
        assert.equal(r.headers.get('etag'),null);assert.equal(r.headers.get('cache-control'),'private, no-store');
        const h=await x.get({method:'HEAD'});assert.equal(h.status,200);assert.equal(await h.text(),'');
        assert.equal(JSON.stringify(await f.ler(x.x)),antes);assert.equal(await snapshot(x.x),historico);
    });
    await t.test('sessao real revogada ou expirada nega antes dos bytes',async()=>{
        for(const sql of ["UPDATE ist_loja_sessoes SET revogada_em='2026-01-01 12:30:00' WHERE id=?",
            "UPDATE ist_loja_sessoes SET revogada_em=NULL,criada_em='2025-12-31',expira_em='2026-01-01' WHERE id=?"]){
            await a.execute(sql,[x.x.sessaoId]);assert.equal((await x.get()).status,401);
        }
        await a.execute("UPDATE ist_loja_sessoes SET revogada_em=NULL,criada_em='2026-01-01',expira_em='2026-01-02' WHERE id=?",[x.x.sessaoId]);
    });
    await t.test('evidencia adversa surgida durante leitura bloqueia na segunda avaliacao sem transicao GET',async()=>{
        let h;h=await montar('ATIVO',{prepararArquivo:async(...args)=>{
            const r=await prepararArquivoValidado(...args);await a.execute('UPDATE ist_loja_pagamentos SET reembolsado_centavos=50 WHERE id=?',[h.x.pagamentoId]);return r;
        }});
        const antes=JSON.stringify(await f.ler(h.x));const r=await h.get();assert.equal(r.status,409);assert.doesNotMatch(await r.text(),/%PDF|sha256|caminho/);
        assert.equal(JSON.stringify(await f.ler(h.x)),antes);
        assert.equal((await h.post()).status,200);assert((await f.ler(h.x)).direitos.every(d=>d.estado==='SUSPENSO'));
        assert.equal((await h.post()).status,200);assert.equal((await h.get()).status,409);
    });
    await t.test('revogacao da sessao durante preparacao bloqueia revalidacao final',async()=>{
        let h;h=await montar('ATIVO',{prepararArquivo:async(...args)=>{
            const r=await prepararArquivoValidado(...args);await a.execute("UPDATE ist_loja_sessoes SET revogada_em='2026-01-01 12:30:00' WHERE id=?",[h.x.sessaoId]);return r;
        }});assert.equal((await h.get()).status,401);
    });
    await t.test('erro SQL absorvido pelo avaliador ainda e indisponibilidade tecnica HTTP 503',async()=>{
        const db={getConnection:async()=>{const c=await pool.getConnection();return {
            query:async(sql,...p)=>{if(sql.includes('FROM ist_loja_pagamentos WHERE'))throw Error('SQL PRIVADO');return c.query(sql,...p);},
            beginTransaction:()=>c.beginTransaction(),commit:()=>c.commit(),rollback:()=>c.rollback(),release:()=>c.release(),destroy:()=>c.destroy()
        };}};
        const h=await montar('ATIVO',{db});const r=await h.get();assert.equal(r.status,503);assert.doesNotMatch(await r.text(),/SQL|PRIVADO|%PDF/);
    });
    t.diagnostic(`D6-B3_HTTP_REAL: ${f.identidade.versao}; schema ${f.identidade.banco}; porta ${f.identidade.porta}; somente dados e PDFs sinteticos.`);
});
