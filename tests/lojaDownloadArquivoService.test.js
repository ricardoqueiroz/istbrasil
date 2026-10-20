import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {prepararArquivoValidado as preparar} from '../src/services/lojaDownloadArquivoService.js';

const pdf=Buffer.from('%PDF-1.7\nPDF EXCLUSIVAMENTE SINTETICO\n%%EOF\n');
const rejeita=(p,codigo)=>assert.rejects(p,e=>e.codigo===codigo&&e.message===codigo&&Object.keys(e).join(',')==='codigo');
const fixture=async t=>{
    const raiz=await fs.mkdtemp(path.join(tmpdir(),'ist-d6b2-'));
    t.after(()=>fs.rm(raiz,{recursive:true,force:true}));
    const arquivo=path.join(raiz,'arquivo.pdf');await fs.writeFile(arquivo,pdf);
    const meta=(bytes=pdf)=>({arquivoVersaoId:1,caminhoRelativo:'arquivo.pdf',tamanhoBytes:String(bytes.length),
        sha256:createHash('sha256').update(bytes).digest(),mime:'application/pdf'});
    return {raiz,arquivo,meta,config:{raizPrivada:raiz}};
};
const interceptar=(t,transformar)=>{
    const abrir=fs.open.bind(fs);
    t.mock.method(fs,'open',async(...args)=>transformar(await abrir(...args)));
};

test('PDF valido: buffer exato e retorno sem caminhos/hash; uma abertura e um fechamento',async t=>{
    const f=await fixture(t);let aberturas=0,fechamentos=0;
    interceptar(t,h=>{aberturas++;const fechar=h.close.bind(h);h.close=async()=>{fechamentos++;return fechar();};return h;});
    const r=await preparar(f.meta(),f.config);
    assert.deepEqual(Object.keys(r),['buffer','tamanho','mime','nomeDownload']);assert.deepEqual(r.buffer,pdf);
    assert.equal(r.tamanho,pdf.length);assert.equal(r.mime,'application/pdf');assert.equal(r.nomeDownload,'livro.pdf');
    assert.equal(aberturas,1);assert.equal(fechamentos,1);
    // Retorno continua sendo a copia validada mesmo apos alteracao do arquivo original.
    await fs.writeFile(f.arquivo,'ALTERADO');assert.deepEqual(r.buffer,pdf);
});

test('configuracao obrigatoria, sem fallback; metadados seguem exatamente D6-B1',async t=>{
    const f=await fixture(t);
    for(const c of [undefined,{}, {raizPrivada:'.'}, {raizPrivada:path.parse(f.raiz).root}, {...f.config,signal:{}}])
        await rejeita(preparar(f.meta(),c),'CONFIGURACAO_INVALIDA');
    for(const patch of [{arquivoVersaoId:0},{tamanhoBytes:pdf.length},{tamanhoBytes:'01'},{sha256:'hash'},{mime:'text/html'}])
        await rejeita(preparar({...f.meta(),...patch},f.config),'VERSAO_INVALIDA');
});

for(const caminhoRelativo of ['/absoluto.pdf','C:\\privado\\arquivo.pdf','../fora.pdf','a/../fora.pdf','a\\arquivo.pdf',
    'a//arquivo.pdf','arquivo.pdf\0','arquivo.pdf\n','arquivo.pdf?segredo=TOKEN','a%2farquivo.pdf','https://externo/arquivo.pdf'])
    test(`caminho inseguro rejeitado ${JSON.stringify(caminhoRelativo)}`,async t=>{
        const f=await fixture(t);await rejeita(preparar({...f.meta(),caminhoRelativo},f.config),'CAMINHO_INSEGURO');
    });

test('arquivo ausente tem erro sanitizado',async t=>{
    const f=await fixture(t);await fs.unlink(f.arquivo);await rejeita(preparar(f.meta(),f.config),'ARQUIVO_AUSENTE');
});
test('hash divergente fecha descritor e libera capacidade',async t=>{
    const f=await fixture(t);let fechou=0;
    interceptar(t,h=>{const fechar=h.close.bind(h);h.close=async()=>{fechou++;return fechar();};return h;});
    for(let n=0;n<6;n++)await rejeita(preparar({...f.meta(),sha256:Buffer.alloc(32)},f.config),'HASH_DIVERGENTE');
    assert.equal(fechou,6);assert.deepEqual((await preparar(f.meta(),f.config)).buffer,pdf);
});
test('assinatura invalida mesmo com tamanho e hash corretos',async t=>{
    const f=await fixture(t),bytes=Buffer.from('<html>NAO PDF</html>');await fs.writeFile(f.arquivo,bytes);
    await rejeita(preparar(f.meta(bytes),f.config),'PDF_INVALIDO');
});
test('tamanho divergente e truncamento anterior a abertura',async t=>{
    const f=await fixture(t);
    await rejeita(preparar({...f.meta(),tamanhoBytes:String(pdf.length-1)},f.config),'TAMANHO_DIVERGENTE');
    await rejeita(preparar({...f.meta(),tamanhoBytes:String(pdf.length+1)},f.config),'ARQUIVO_TRUNCADO');
});
test('limite 32 MiB conferido no contrato e no arquivo antes de alocar/ler',async t=>{
    const f=await fixture(t);let leituras=0;
    interceptar(t,h=>{const ler=h.read.bind(h);h.read=(...args)=>{leituras++;return ler(...args);};return h;});
    await rejeita(preparar({...f.meta(),tamanhoBytes:String(32*1024*1024+1)},f.config),'TAMANHO_EXCEDIDO');
    const h=await fs.open(f.arquivo,'r+');try{await h.truncate(32*1024*1024+1);}finally{await h.close();}
    await rejeita(preparar(f.meta(),f.config),'TAMANHO_EXCEDIDO');assert.equal(leituras,0);
});
test('PDF de exatamente 32 MiB e aceito sem concatenacao',async t=>{
    const f=await fixture(t),bytes=Buffer.alloc(32*1024*1024,65);pdf.copy(bytes);await fs.writeFile(f.arquivo,bytes);
    const r=await preparar(f.meta(bytes),f.config);assert.equal(r.tamanho,bytes.length);
    assert(createHash('sha256').update(r.buffer).digest().equals(f.meta(bytes).sha256));
});
test('hardlink e arquivo nao regular rejeitados',async t=>{
    const f=await fixture(t);await fs.link(f.arquivo,path.join(f.raiz,'hard.pdf'));
    await rejeita(preparar(f.meta(),f.config),'ARQUIVO_ESPECIAL');
    await fs.unlink(f.arquivo);await fs.mkdir(f.arquivo);
    await rejeita(preparar(f.meta(),f.config),'ARQUIVO_ESPECIAL');
});
test('symlink de arquivo rejeitado',async t=>{
    const f=await fixture(t);await fs.rename(f.arquivo,path.join(f.raiz,'real.pdf'));
    try{await fs.symlink(path.join(f.raiz,'real.pdf'),f.arquivo,'file');}
    catch(e){if(e.code==='EPERM'){t.skip('Windows sem privilegio para criar symlink de arquivo; nenhum privilegio alterado');return;}throw e;}
    await rejeita(preparar(f.meta(),f.config),'CAMINHO_INSEGURO');
});
test('symlink/junction de diretorio e raiz rejeitados',async t=>{
    const f=await fixture(t);await fs.mkdir(path.join(f.raiz,'real'));
    await fs.writeFile(path.join(f.raiz,'real','arquivo.pdf'),pdf);
    await fs.symlink(path.join(f.raiz,'real'),path.join(f.raiz,'atalho'),process.platform==='win32'?'junction':'dir');
    await rejeita(preparar({...f.meta(),caminhoRelativo:'atalho/arquivo.pdf'},f.config),'CAMINHO_INSEGURO');
    await rejeita(preparar(f.meta(),{raizPrivada:path.join(f.raiz,'atalho')}),'CAMINHO_INSEGURO');
});
test('FIFO Linux rejeitado sem abrir nem bloquear',{skip:process.platform==='win32'},async t=>{
    const f=await fixture(t);await fs.unlink(f.arquivo);execFileSync('mkfifo',[f.arquivo]);
    await rejeita(preparar(f.meta(),f.config),'ARQUIVO_ESPECIAL');
});
test('arquivo truncado durante leitura incremental fecha descritor',async t=>{
    const f=await fixture(t),bytes=Buffer.alloc(128*1024,65);pdf.copy(bytes);await fs.writeFile(f.arquivo,bytes);let fechou=false;
    interceptar(t,h=>{const ler=h.read.bind(h),fechar=h.close.bind(h);let primeira=true;
        h.read=async(...args)=>{const r=await ler(...args);if(primeira){primeira=false;await fs.truncate(f.arquivo,0);}return r;};
        h.close=async()=>{fechou=true;return fechar();};return h;});
    await rejeita(preparar(f.meta(bytes),f.config),'ARQUIVO_TRUNCADO');assert(fechou);
});
test('modificacao durante leitura nao entrega bytes divergentes',async t=>{
    const f=await fixture(t),bytes=Buffer.alloc(128*1024,65);pdf.copy(bytes);await fs.writeFile(f.arquivo,bytes);
    interceptar(t,h=>{const ler=h.read.bind(h);let primeira=true;
        h.read=async(...args)=>{const r=await ler(...args);if(primeira){primeira=false;await fs.writeFile(f.arquivo,Buffer.alloc(bytes.length,66));}return r;};return h;});
    await rejeita(preparar(f.meta(bytes),f.config),'HASH_DIVERGENTE');
});
test('substituicao do caminho apos abertura nao passa revalidacao fisica',async t=>{
    const f=await fixture(t);
    interceptar(t,h=>{const ler=h.read.bind(h);let primeira=true;
        h.read=async(...args)=>{const r=await ler(...args);if(primeira){primeira=false;
            await fs.rename(f.arquivo,path.join(f.raiz,'anterior.pdf'));await fs.writeFile(f.arquivo,pdf);}return r;};return h;});
    await rejeita(preparar(f.meta(),f.config),'ARQUIVO_ALTERADO');
});
test('cancelamento antes de abrir e durante leitura; capacidade liberada',async t=>{
    const f=await fixture(t),controller=new AbortController();controller.abort();
    await rejeita(preparar(f.meta(),{...f.config,signal:controller.signal}),'OPERACAO_CANCELADA');
    const durante=new AbortController();let fechou=false;
    interceptar(t,h=>{const ler=h.read.bind(h),fechar=h.close.bind(h);
        h.read=async(...args)=>{const r=await ler(...args);durante.abort();return r;};
        h.close=async()=>{fechou=true;return fechar();};return h;});
    await rejeita(preparar(f.meta(),{...f.config,signal:durante.signal}),'OPERACAO_CANCELADA');assert(fechou);
    assert.deepEqual((await preparar(f.meta(),f.config)).buffer,pdf);
});
test('quatro preparacoes globais, quinta recusada sem fila e capacidade liberada',async t=>{
    const f=await fixture(t);let liberar,chegar,abertas=0;const bloqueio=new Promise(r=>liberar=r),pronto=new Promise(r=>chegar=r);
    const abrir=fs.open.bind(fs);
    t.mock.method(fs,'open',async(...args)=>{if(++abertas===4)chegar();await bloqueio;return abrir(...args);});
    const execucoes=Array.from({length:4},()=>preparar(f.meta(),f.config));
    try{await pronto;await rejeita(preparar(f.meta(),f.config),'CAPACIDADE_ESGOTADA');}
    finally{liberar();}
    for(const r of await Promise.all(execucoes))assert.deepEqual(r.buffer,pdf);
    assert.deepEqual((await preparar(f.meta(),f.config)).buffer,pdf);
});
test('falha de abertura e leitura sanitizadas; descritor fecha e capacidade retorna',async t=>{
    const f=await fixture(t),abrir=fs.open.bind(fs);let fechou=0,vez=0;
    t.mock.method(fs,'open',async(...args)=>{
        if(vez++===0)throw Error('SEGREDO '+f.arquivo);
        const h=await abrir(...args),fechar=h.close.bind(h);
        h.read=async()=>{throw Error('SEGREDO '+f.arquivo);};h.close=async()=>{fechou++;return fechar();};return h;
    });
    for(let n=0;n<6;n++)await rejeita(preparar(f.meta(),f.config),'FALHA_LEITURA');assert.equal(fechou,5);
});
test('falha de fechamento impede sucesso e libera capacidade',async t=>{
    const f=await fixture(t);let fechou=0;
    interceptar(t,h=>{const fechar=h.close.bind(h);h.close=async()=>{await fechar();fechou++;throw Error('erro privado');};return h;});
    for(let n=0;n<6;n++)await rejeita(preparar(f.meta(),f.config),'FALHA_LEITURA');assert.equal(fechou,6);
});
test('cancelamento durante fechamento tambem impede retorno',async t=>{
    const f=await fixture(t),controller=new AbortController();
    interceptar(t,h=>{const fechar=h.close.bind(h);h.close=async()=>{await fechar();controller.abort();};return h;});
    await rejeita(preparar(f.meta(),{...f.config,signal:controller.signal}),'OPERACAO_CANCELADA');
});
