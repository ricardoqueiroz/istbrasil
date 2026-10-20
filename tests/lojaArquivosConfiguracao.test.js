import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {mkdtemp,mkdir,rm,symlink,writeFile} from 'node:fs/promises';
import {criarConfiguracaoArquivosLoja,raizesPublicasConhecidasLoja} from '../src/config/lojaArquivos.js';

const rejeitar=p=>assert.rejects(p,e=>e.codigo==='CONFIGURACAO_INVALIDA'&&e.message==='CONFIGURACAO_INVALIDA'&&!e.cause);
const fixture=async t=>{
    const base=await mkdtemp(path.join(tmpdir(),'ist-raiz-f1-'));
    t.after(()=>rm(base,{recursive:true,force:true}));
    const projeto=path.join(base,'projeto'),privada=path.join(base,'privada'),publica=path.join(projeto,'html');
    for(const p of [privada,publica])await mkdir(p,{recursive:true});
    const criar=(raizPrivada=privada,raizesPublicas=[])=>criarConfiguracaoArquivosLoja({raizPrivada,raizProjeto:projeto,raizesPublicas});
    return {base,projeto,privada,publica,criar};
};
test('raiz privada legitima fora dos publicos, com segmentos ausentes projetados',async t=>{
    const f=await fixture(t);assert.equal(await f.criar().obterRaizValidada(),f.privada);
    assert.equal(await f.criar().obterRaizValidada(),f.privada);
});
test('lista explicita preserva mounts publicos e nao declara todo projeto publico',async t=>{
    const f=await fixture(t),lista=raizesPublicasConhecidasLoja(f.projeto);
    for(const sub of ['html','public','src/assets','dist/sakai-ng','istbrasil.private/documents','istbrasil.private/projetos','istbrasil.private/usuarios/fotos'])
        assert(lista.includes(path.resolve(f.projeto,...sub.split('/'))));
    const dentro=path.join(f.projeto,'armazenamento-comercial');await mkdir(dentro);
    assert.equal(await f.criar(dentro).obterRaizValidada(),dentro);
});
for(const caso of ['igual','dentro','ancestral','equivalente'])test('sobreposicao ao webroot '+caso,async t=>{
    const f=await fixture(t);const dentro=path.join(f.publica,'livros');await mkdir(dentro);
    const alvo=caso==='igual'?f.publica:caso==='dentro'?dentro:caso==='ancestral'?f.projeto:path.join(f.publica,'..','html','.');
    await rejeitar(f.criar(alvo).obterRaizValidada());
});
test('irmaos com prefixos semelhantes nao sao sobreposicao',async t=>{
    const f=await fixture(t),privada=f.publica+'-privado';await mkdir(privada);
    assert.equal(await f.criar(privada).obterRaizValidada(),privada);
});
for(const caso of ['ausente','relativa','inexistente','arquivo','nul','raiz-volume'])test('configuracao invalida '+caso,async t=>{
    const f=await fixture(t),arquivo=path.join(f.base,'arquivo');await writeFile(arquivo,'SINTETICO');
    const v={ausente:undefined,relativa:'privado',inexistente:path.join(f.base,'ausente'),arquivo,nul:f.privada+'\0','raiz-volume':path.parse(f.base).root}[caso];
    const cfg=criarConfiguracaoArquivosLoja({raizPrivada:v,raizProjeto:f.projeto});await rejeitar(cfg.obterRaizValidada());
});
test('raizes publicas adicionais invalidas ou nao-diretorio falham fechado',async t=>{
    const f=await fixture(t),arquivo=path.join(f.base,'arquivo');await writeFile(arquivo,'SINTETICO');
    for(const extras of [['relativo'],[arquivo],null]){
        const cfg=criarConfiguracaoArquivosLoja({raizPrivada:f.privada,raizProjeto:f.projeto,raizesPublicas:extras});await rejeitar(cfg.obterRaizValidada());
    }
});
test('symlink/junction privado apontando para publico e rejeitado',async t=>{
    const f=await fixture(t),atalho=path.join(f.base,'atalho');
    await symlink(f.publica,atalho,process.platform==='win32'?'junction':'dir');await rejeitar(f.criar(atalho).obterRaizValidada());
});
test('raiz publica conhecida como symlink/junction para privada e rejeitada',async t=>{
    const f=await fixture(t),atalho=path.join(f.base,'publico-link');
    await symlink(f.privada,atalho,process.platform==='win32'?'junction':'dir');await rejeitar(f.criar(f.privada,[atalho]).obterRaizValidada());
});
test('symlink publico quebrado falha sem presumir ausencia',async t=>{
    const f=await fixture(t),atalho=path.join(f.base,'quebrado');
    await symlink(path.join(f.base,'inexistente'),atalho,process.platform==='win32'?'junction':'dir');await rejeitar(f.criar(f.privada,[atalho]).obterRaizValidada());
});
test('mudanca posterior de publico para link privado e detectada sem cache',async t=>{
    const f=await fixture(t),novo=path.join(f.base,'publico-futuro'),cfg=f.criar(f.privada,[novo]);
    assert.equal(await cfg.obterRaizValidada(),f.privada);
    await symlink(f.privada,novo,process.platform==='win32'?'junction':'dir');await rejeitar(cfg.obterRaizValidada());
});
test('semantica de separadores nativos e caminho estrangeiro',async t=>{
    const f=await fixture(t);assert.equal(await f.criar(f.privada.split(path.sep).join(path.sep)).obterRaizValidada(),f.privada);
    if(process.platform==='win32'){
        assert.equal(await f.criar(f.privada.replaceAll('\\','/')).obterRaizValidada(),f.privada);
        await rejeitar(f.criar(f.publica.replaceAll('\\','/')).obterRaizValidada());
    }else await rejeitar(f.criar('C:\\publico\\privado').obterRaizValidada());
});
test('publicacao e download compartilham configuracao e nao aceitam segunda raiz',async t=>{
    const f=await fixture(t),cfg=f.criar(),db={getConnection(){throw Error('SQL NAO AUTORIZADO NESTE TESTE');}};
    assert.deepEqual(Object.keys(cfg.criarPublicacao({db})),['registrarRascunho','publicar']);
    assert.throws(()=>cfg.criarPublicacao({db,raizPrivada:f.publica}),{codigo:'CONFIGURACAO_INVALIDA'});
    assert.equal(await cfg.obterRaizValidada(),f.privada);
    const invalida=f.criar(f.publica),s=invalida.criarPublicacao({db});
    await rejeitar(s.registrarRascunho({}));await rejeitar(s.publicar({}));
});
