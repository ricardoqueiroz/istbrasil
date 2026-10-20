import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, symlink, rename, mkdir, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import mysql from 'mysql2/promise';
import { criarLojaArquivoService } from '../src/services/lojaArquivoService.js';

const pdf = Buffer.from('%PDF-1.7\nCONTEUDO SINTETICO SEM DADOS REAIS\n%%EOF\n');
const rejeita = (promise, codigo) => assert.rejects(promise, e => e.codigo === codigo && e.message === codigo);
const config = () => ({ db: { getConnection() { throw Error('SQL_PROIBIDO'); } }, raizPrivada: tmpdir() });

test('fabrica exige configuracao explicita e nao abre conexao ao importar/criar', () => {
    assert.throws(() => criarLojaArquivoService(), /CONFIGURACAO_INVALIDA/);
    assert.throws(() => criarLojaArquivoService({ ...config(), raizPrivada: 'relativo' }), /CONFIGURACAO_INVALIDA/);
    assert.deepEqual(Object.keys(criarLojaArquivoService(config())), ['registrarRascunho','publicar']);
});
test('entradas internas invalidas falham antes de arquivo ou SQL', async () => {
    const s = criarLojaArquivoService(config());
    for (const caminhoRelativo of ['/absoluto.pdf','../fora.pdf','a\\b.pdf','a%2fb.pdf','a.pdf?token=SEGREDO','a.pdf\n','https://externo/a.pdf']) {
        await rejeita(s.registrarRascunho({ registroPublicId: randomUUID(),produtoId:1,caminhoRelativo,arquivoLogicoId:randomUUID() }), 'ENTRADA_INVALIDA');
    }
    await rejeita(s.publicar({ produtoId:1,versaoPublicId:randomUUID() }), 'ENTRADA_INVALIDA');
});
test('arquivo ausente e conteudo nao PDF sao sanitizados sem SQL', async t => {
    const raiz = await mkdtemp(path.join(tmpdir(),'ist-arquivo-unit-'));
    t.after(() => rm(raiz,{recursive:true}));
    const s = criarLojaArquivoService({ ...config(), raizPrivada:raiz });
    const entrada = caminhoRelativo => ({registroPublicId:randomUUID(),produtoId:1,caminhoRelativo,arquivoLogicoId:randomUUID()});
    await rejeita(s.registrarRascunho(entrada('ausente.pdf')),'ARQUIVO_AUSENTE');
    await writeFile(path.join(raiz,'invalido.pdf'),'HTML NAO E PDF');
    await rejeita(s.registrarRascunho(entrada('invalido.pdf')),'PDF_INVALIDO');
    await writeFile(path.join(raiz,'binario.pdf'),Buffer.from([0x25,0x50,0x44,0x46,0x2d,0xb1,0x2e,0xb7]));
    await rejeita(s.registrarRascunho(entrada('binario.pdf')),'PDF_INVALIDO');
    await writeFile(path.join(raiz,'grande.pdf'),pdf);
    await rejeita(criarLojaArquivoService({...config(),raizPrivada:raiz,maxBytes:8}).registrarRascunho(entrada('grande.pdf')),'ARQUIVO_INVALIDO');
});
test('junction/symlink no caminho e rejeitado antes do acesso ao banco', async t => {
    const raiz = await mkdtemp(path.join(tmpdir(),'ist-arquivo-links-'));
    t.after(() => rm(raiz,{recursive:true}));
    await mkdir(path.join(raiz,'real'));await writeFile(path.join(raiz,'real','arquivo.pdf'),pdf);
    await symlink(path.join(raiz,'real'),path.join(raiz,'atalho'),process.platform==='win32'?'junction':'dir');
    await rejeita(criarLojaArquivoService({...config(),raizPrivada:raiz}).registrarRascunho({registroPublicId:randomUUID(),produtoId:1,caminhoRelativo:'atalho/arquivo.pdf',arquivoLogicoId:randomUUID()}),'CAMINHO_INSEGURO');
    await rejeita(criarLojaArquivoService({...config(),raizPrivada:path.join(raiz,'atalho')}).registrarRascunho({registroPublicId:randomUUID(),produtoId:1,caminhoRelativo:'arquivo.pdf',arquivoLogicoId:randomUUID()}),'CAMINHO_INSEGURO');
    await link(path.join(raiz,'real','arquivo.pdf'),path.join(raiz,'hardlink.pdf'));
    await rejeita(criarLojaArquivoService({...config(),raizPrivada:raiz}).registrarRascunho({registroPublicId:randomUUID(),produtoId:1,caminhoRelativo:'hardlink.pdf',arquivoLogicoId:randomUUID()}),'ARQUIVO_INVALIDO');
});

test('servico interno em MariaDB descartavel com PDFs exclusivamente sinteticos', {timeout:180000}, async t => {
    const antigo=Boolean(process.env.IST_R2_10339_MANIFEST);
    const {criarBancoPagamentoIsolado}=await import(antigo?'./fixtures/lojaCatalogoMariaDB10339.js':'./fixtures/lojaPagamentoBancoIsolado.js');
    const fixture=await criarBancoPagamentoIsolado(t), c=fixture.admin;
    const [[identidade]]=await c.query('SELECT DATABASE() banco,@@port porta,@@datadir datadir');
    assert.match(identidade.banco,/^ist_loja_67_3_[0-9a-f]{12}$/);
    if(antigo)assert.equal(identidade.datadir,'/var/lib/mysql/');else assert(![3306,3307].includes(Number(identidade.porta)));
    const cfg=c.config??c.connection.config;
    const pool=fixture.pool??mysql.createPool({host:cfg.host,port:cfg.port,user:cfg.user,password:cfg.password,database:identidade.banco,dateStrings:true,supportBigNumbers:true,bigNumberStrings:true,connectionLimit:8});
    if(!fixture.pool)t.after(()=>pool.end());
    // Apenas montar o schema de fixture homologado; nao executar migrations.
    await c.query('ALTER TABLE ist_livros ADD format VARCHAR(32) NULL');
    await c.query('ALTER TABLE ist_loja_produtos ADD tipo VARCHAR(16) NULL');
    const fonte=await readFile(new URL('../migrations/ist_loja_downloads_fundacao.sql',import.meta.url),'utf8');
    const ddl=fonte.match(/CREATE TABLE ist_loja_arquivo_versoes \([\s\S]*?\) ENGINE=InnoDB[^;]*;/)[0];await c.query(ddl);
    await c.query("INSERT INTO ist_loja_categorias(id,nome,slug) VALUES(1,'Sintetico','sintetico')");
    await c.query("INSERT INTO ist_livros(id,format) VALUES(1,'E-Book'),(2,'E-Book'),(3,'Livro Fisico')");
    await c.query("INSERT INTO ist_loja_produtos(id,categoria_id,livro_id,sku,tipo) VALUES(1,1,1,'SINT-1','DIGITAL'),(2,1,2,'SINT-2','DIGITAL'),(3,1,3,'SINT-3','MERCADORIA')");
    const raiz=await mkdtemp(path.join(tmpdir(),'ist-arquivo-db-'));t.after(()=>rm(raiz,{recursive:true}));
    let segundo=0;const agora=()=>new Date(Date.UTC(2026,0,1,0,0,segundo++));
    const criar=(db=pool)=>criarLojaArquivoService({db,raizPrivada:raiz,agora});
    const s=criar(), logico=randomUUID();
    const entrada=async(nome,produtoId=1,arquivoLogicoId=logico)=>{
        await writeFile(path.join(raiz,nome),pdf);
        return {registroPublicId:randomUUID(),produtoId,caminhoRelativo:nome,arquivoLogicoId};
    };
    const e1=await entrada('v1.pdf');let v1,v2;
    await t.test('registro valido tamanho SHA-256 e ausencia de inferencia por nome/file',async()=>{
        v1=await s.registrarRascunho(e1);assert.equal(v1.numeroVersao,1);assert.equal(v1.estado,'RASCUNHO');
        const [[r]]=await c.execute('SELECT * FROM ist_loja_arquivo_versoes WHERE public_id=?',[v1.versaoPublicId]);
        assert.equal(String(r.tamanho_bytes),String(pdf.length));assert(r.sha256.equals(createHash('sha256').update(pdf).digest()));
        assert.equal(r.produto_id,1);assert.equal(r.caminho_relativo,'v1.pdf');
    });
    await t.test('registro idempotente e identidade divergente',async()=>{
        assert.deepEqual(await s.registrarRascunho(e1),v1);
        await rejeita(s.registrarRascunho({...e1,arquivoLogicoId:randomUUID()}),'CONFLITO_IDEMPOTENCIA');
        await rejeita(s.registrarRascunho({...e1,registroPublicId:randomUUID()}),'CAMINHO_REUTILIZADO');
    });
    await t.test('produto inexistente, nao digital e identidade logica divergente',async()=>{
        await rejeita(s.registrarRascunho(await entrada('inexistente.pdf',999,randomUUID())),'PRODUTO_INDISPONIVEL');
        await rejeita(s.registrarRascunho(await entrada('mercadoria.pdf',3,randomUUID())),'PRODUTO_INDISPONIVEL');
        await rejeita(s.registrarRascunho(await entrada('outra-identidade.pdf',1,randomUUID())),'CONFLITO_IDENTIDADE_LOGICA');
    });
    await t.test('publicacao inicial, repeticao e substituicao conservam versao anterior',async()=>{
        const p1={produtoId:1,versaoPublicId:v1.versaoPublicId,publicacaoAtualEsperada:null};
        const publicado=await s.publicar(p1);assert.equal(publicado.estado,'PUBLICADA');assert.deepEqual(await s.publicar(p1),publicado);
        v2=await s.registrarRascunho(await entrada('v2.pdf'));assert.equal(v2.numeroVersao,2);
        await rejeita(s.publicar({produtoId:1,versaoPublicId:v2.versaoPublicId,publicacaoAtualEsperada:null}),'CONFLITO_PUBLICACAO');
        await s.publicar({produtoId:1,versaoPublicId:v2.versaoPublicId,publicacaoAtualEsperada:v1.versaoPublicId});
        const [r]=await c.query('SELECT estado,publicacao_atual FROM ist_loja_arquivo_versoes WHERE produto_id=1 ORDER BY id');assert.deepEqual(r.map(x=>x.estado),['RETIRADA','PUBLICADA']);
        await rejeita(s.publicar(p1),'CONFLITO_PUBLICACAO');
    });
    const envolver=(hook,commit)=>({async getConnection(){const c=await pool.getConnection();return {
        query:(...args)=>c.query(...args),execute:async(...args)=>{await hook?.(...args);return c.execute(...args);},beginTransaction:()=>c.beginTransaction(),
        commit:()=>commit?commit(c):c.commit(),rollback:()=>c.rollback(),release:()=>c.release(),destroy:()=>c.destroy()
    };}});
    await t.test('falha durante troca causa rollback completo',async()=>{
        const v=await s.registrarRascunho(await entrada('rollback.pdf'));
        const db=envolver(sql=>{if(sql.startsWith("UPDATE ist_loja_arquivo_versoes SET estado='PUBLICADA'"))throw Error('SEGREDO /caminho/privado');});
        await rejeita(criar(db).publicar({produtoId:1,versaoPublicId:v.versaoPublicId,publicacaoAtualEsperada:v2.versaoPublicId}),'ERRO_PERSISTENCIA');
        const [[atual]]=await c.query('SELECT public_id FROM ist_loja_arquivo_versoes WHERE produto_id=1 AND publicacao_atual=1');assert.equal(atual.public_id,v2.versaoPublicId);
        const [[alvo]]=await c.execute('SELECT estado FROM ist_loja_arquivo_versoes WHERE public_id=?',[v.versaoPublicId]);assert.equal(alvo.estado,'RASCUNHO');
    });
    await t.test('COMMIT confirmado com resposta perdida e reconciliado sem novo INSERT',async()=>{
        const e=await entrada('commit-perdido.pdf');let primeira=true;
        const db=envolver(null,async c=>{await c.commit();if(primeira){primeira=false;throw Error('RESPOSTA_PERDIDA');}});
        const r=await criar(db).registrarRascunho(e);assert.equal(r.versaoPublicId,e.registroPublicId);
        const [[q]]=await c.execute('SELECT COUNT(*) n FROM ist_loja_arquivo_versoes WHERE public_id=?',[e.registroPublicId]);assert.equal(Number(q.n),1);
    });
    await t.test('COMMIT nao efetivado fica desconhecido sem nova insercao',async()=>{
        const e=await entrada('commit-ausente.pdf');
        const db=envolver(null,async c=>{await c.rollback();throw Error('SEM_COMMIT');});
        await rejeita(criar(db).registrarRascunho(e),'RESULTADO_DESCONHECIDO');
        assert.equal(Number((await c.execute('SELECT COUNT(*) n FROM ist_loja_arquivo_versoes WHERE public_id=?',[e.registroPublicId]))[0][0].n),0);
    });
    await t.test('COMMIT perdido em publicacao nao repete efeitos',async()=>{
        const v=await s.registrarRascunho(await entrada('publicacao-perdida.pdf'));let primeira=true;
        const db=envolver(null,async c=>{await c.commit();if(primeira){primeira=false;throw Error('SEM_RESPOSTA');}});
        const r=await criar(db).publicar({produtoId:1,versaoPublicId:v.versaoPublicId,publicacaoAtualEsperada:v2.versaoPublicId});
        assert.equal(r.estado,'PUBLICADA');v2=r;
    });
    await t.test('publicacoes concorrentes com mesma expectativa nao sobrescrevem vencedor',async()=>{
        const a=await s.registrarRascunho(await entrada('concorrente-a.pdf')),b=await s.registrarRascunho(await entrada('concorrente-b.pdf'));
        const r=await Promise.allSettled([a,b].map(v=>s.publicar({produtoId:1,versaoPublicId:v.versaoPublicId,publicacaoAtualEsperada:v2.versaoPublicId})));
        assert.equal(r.filter(x=>x.status==='fulfilled').length,1);assert.equal(r.find(x=>x.status==='rejected').reason.codigo,'CONFLITO_PUBLICACAO');
    });
    await t.test('registros concorrentes da mesma identidade convergem e numeracao e serializada',async()=>{
        const e=await entrada('registro-concorrente.pdf');
        const repetidos=await Promise.all([s.registrarRascunho(e),s.registrarRascunho(e)]);assert.deepEqual(repetidos[0],repetidos[1]);
        const entradas=await Promise.all(['numero-a.pdf','numero-b.pdf'].map(nome=>entrada(nome)));
        const r=await Promise.all(entradas.map(e=>s.registrarRascunho(e)));assert.equal(new Set(r.map(x=>x.numeroVersao)).size,2);
        const [[q]]=await c.execute('SELECT COUNT(*) n FROM ist_loja_arquivo_versoes WHERE public_id=?',[e.registroPublicId]);assert.equal(Number(q.n),1);
    });
    await t.test('mesmo caminho e conteudo pode ser compartilhado explicitamente entre produtos',async()=>{
        const e=await entrada('compartilhado.pdf');await s.registrarRascunho(e);
        const r=await s.registrarRascunho({...e,produtoId:2,registroPublicId:randomUUID(),arquivoLogicoId:randomUUID()});assert.equal(r.produtoId,2);
    });
    await t.test('arquivo que muda durante SQL provoca rollback sem registro',async()=>{
        const e=await entrada('mudou-na-insercao.pdf');let alterado=false;
        const db=envolver(async sql=>{if(!alterado&&sql.startsWith('INSERT INTO ist_loja_arquivo_versoes')){alterado=true;await writeFile(path.join(raiz,e.caminhoRelativo),Buffer.from('%PDF-1.7\nOUTRO CONTEUDO\n'));}});
        await rejeita(criar(db).registrarRascunho(e),'ARQUIVO_ALTERADO');
        assert.equal(Number((await c.execute('SELECT COUNT(*) n FROM ist_loja_arquivo_versoes WHERE public_id=?',[e.registroPublicId]))[0][0].n),0);
    });
    await t.test('deadlock retorna erro sanitizado sem retry interno ou registro',async()=>{
        const e=await entrada('deadlock.pdf');let tentativas=0;
        const db=envolver(sql=>{if(sql.startsWith('INSERT INTO ist_loja_arquivo_versoes')){tentativas++;throw Object.assign(Error('SQL SEGREDO'),{errno:1213});}});
        await rejeita(criar(db).registrarRascunho(e),'CONTENCAO_TEMPORARIA');assert.equal(tentativas,1);
    });
    await t.test('arquivo modificado e caminho reutilizado com conteudo divergente sao rejeitados',async()=>{
        await writeFile(path.join(raiz,'v1.pdf'),Buffer.from('%PDF-1.7\nCONTEUDO ALTERADO\n'));
        const [[identidade2]]=await c.query('SELECT arquivo_logico_id FROM ist_loja_arquivo_versoes WHERE produto_id=2 LIMIT 1');
        await rejeita(s.registrarRascunho({...e1,produtoId:2,arquivoLogicoId:identidade2.arquivo_logico_id,registroPublicId:randomUUID()}),'CAMINHO_REUTILIZADO');
        await rejeita(s.publicar({produtoId:1,versaoPublicId:v1.versaoPublicId,publicacaoAtualEsperada:null}),'ARQUIVO_ALTERADO');
    });
    await t.test('troca do arquivo entre hash e persistencia e detectada',async()=>{
        const e=await entrada('trocado.pdf');let trocou=false;
        const db=envolver(async sql=>{if(!trocou&&sql.startsWith('SELECT GET_LOCK')){trocou=true;await rename(path.join(raiz,'trocado.pdf'),path.join(raiz,'antigo.pdf'));await writeFile(path.join(raiz,'trocado.pdf'),pdf);}});
        await rejeita(criar(db).registrarRascunho(e),'ARQUIVO_ALTERADO');
        assert.equal(Number((await c.execute('SELECT COUNT(*) n FROM ist_loja_arquivo_versoes WHERE public_id=?',[e.registroPublicId]))[0][0].n),0);
    });
    await t.test('constraints permanecem habilitadas e nenhuma concessao/pedido e criado',async()=>{
        const [[r]]=await c.query('SELECT @@foreign_key_checks fk,@@check_constraint_checks ck');assert.equal(Number(r.fk),1);assert.equal(Number(r.ck),1);
        for(const tabela of ['ist_loja_pedidos','ist_loja_pedido_itens','ist_loja_pagamentos']) {
            const [[q]]=await c.query('SELECT COUNT(*) n FROM '+tabela);assert.equal(Number(q.n),0,tabela);
        }
        const [[tabelas]]=await c.query("SELECT COUNT(*) n FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name IN ('ist_loja_download_direitos','ist_loja_download_direito_eventos')");
        assert.equal(Number(tabelas.n),0,'Servico nao cria estruturas de direitos');
    });
    t.diagnostic('Versao efetiva: '+fixture.versao+'; somente schema '+identidade.banco+' e PDFs sinteticos TEMP.');
});
