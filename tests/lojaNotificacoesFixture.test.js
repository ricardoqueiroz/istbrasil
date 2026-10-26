import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {readFile} from 'node:fs/promises';
import {selecionarFixtureNotificacoes,validarManifestoNotificacoes10339,verificarObservadorNotificacoes,DIRETORIO_10339,DIGEST_10339} from './fixtures/lojaNotificacoesFixture.js';

test('selecao explicita sem fallback, sem SQL ou inicializacao de processos',()=>{
    const bin=resolve('tests','fixture-bin-nao-executado');
    assert.equal(selecionarFixtureNotificacoes({IST_LOJA_NOTIFICACOES_MARIADB:'13.0.2',IST_LOJA_PAGAMENTOS_MARIADB_BIN:bin}),'13.0.2');
    const env={IST_LOJA_NOTIFICACOES_MARIADB:'10.3.39',IST_R2_10339_MANIFEST:`${DIRETORIO_10339}/manifest.json`};
    assert.equal(selecionarFixtureNotificacoes(env),'10.3.39');
    for(const e of [{}, {...env,IST_LOJA_PAGAMENTOS_MARIADB_BIN:bin},{...env,IST_R2_10339_MANIFEST:'/outro/manifest.json'},
        {IST_LOJA_NOTIFICACOES_MARIADB:'13.0.2'}, {IST_LOJA_NOTIFICACOES_MARIADB:'10.3.40'},
        {IST_LOJA_NOTIFICACOES_MARIADB:'13.0.2',IST_LOJA_PAGAMENTOS_MARIADB_BIN:'relativo'},
        {...env,IST_LOJA_NOTIFICACOES_MARIADB:'13.0.2',IST_LOJA_PAGAMENTOS_MARIADB_BIN:bin}])assert.throws(()=>selecionarFixtureNotificacoes(e));
});

const fixture=()=>{
    const m={containerName:'ist-notificacoes-mariadb10339',containerId:'a'.repeat(64),imageDigest:DIGEST_10339,
        runId:'11111111-1111-4111-8111-111111111111',volume:'ist-notificacoes-mariadb10339-data',host:'127.0.0.1',port:49321,schema:'ist_loja_67_3_123456abcdef'};
    const v={Name:m.volume,Labels:{'ist.r2.run':m.runId},Driver:'local',Mountpoint:'/var/lib/docker/volumes/fixture/_data'};
    const c={Id:m.containerId,Name:`/${m.containerName}`,State:{Running:true},Config:{Image:`docker.io/library/mariadb@${DIGEST_10339}`,Labels:v.Labels},
        HostConfig:{RestartPolicy:{Name:'no'},NetworkMode:'bridge',Privileged:false},
        NetworkSettings:{Networks:{bridge:{NetworkID:'b'.repeat(64),EndpointID:'c'.repeat(64)}},Ports:{'3306/tcp':[{HostIp:'127.0.0.1',HostPort:String(m.port)}]}},
        Mounts:[{Destination:'/var/lib/mysql',Type:'volume',Name:m.volume,Source:v.Mountpoint,RW:true},
            {Destination:'/run/secrets/root-password',Type:'bind',Source:`${DIRETORIO_10339}/root-password`,RW:false}]};
    return {m,c,v};
};
test('manifesto dinamico valido exige identidade Docker efetiva correspondente',()=>{
    const {m,c,v}=fixture();assert.equal(validarManifestoNotificacoes10339(m,c,v),m);
});
for(const modo of ['host','none','container:'+'d'.repeat(64),'rede-personalizada','default']){
    test(`rede rejeita NetworkMode ${modo}`,()=>{
        const {m,c,v}=fixture();c.HostConfig.NetworkMode=modo;
        assert.throws(()=>validarManifestoNotificacoes10339(m,c,v));
    });
}
for(const [nome,redes]of [['ausentes',undefined],['nulas',null],['vazias',{}],
    ['personalizada sem bridge',{'rede-personalizada':{}}],['adicionais',{bridge:{},outra:{}}],
    ['lista em vez de objeto',['bridge']],['bridge sem objeto',{bridge:null}]]){
    test(`rede rejeita associacoes ${nome}`,()=>{
        const {m,c,v}=fixture();c.NetworkSettings.Networks=redes;
        assert.throws(()=>validarManifestoNotificacoes10339(m,c,v));
    });
}
test('PROCESS ausente falha fechado; verificacao nao concede privilegios',async()=>{
    for(const n of [0,1]){
        const sqls=[],logs=[];
        const c={async query(sql,args){sqls.push(sql);if(sql.includes('CURRENT_USER()'))return [[{usuario:'root@%',conexao:4}]];
            assert.deepEqual(args,["'root'@'%'"]);return [[{n}]];}};
        const p=verificarObservadorNotificacoes(c,{diagnostic:s=>logs.push(s)});
        if(n===0)await assert.rejects(p);else {await p;assert.equal(logs.length,1);}
        assert(sqls.every(sql=>sql.startsWith('SELECT ')));
    }
});
for(const [nome,mutar]of [
    ['porta ausente',x=>delete x.m.port],['porta texto',x=>x.m.port='49321'],
    ...[3000,3001,3306,3307,4200,4201,8080,8443,13339].map(porta=>[`porta protegida ${porta}`,x=>x.m.port=porta]),
    ['porta fora da faixa',x=>x.m.port=65536],['host externo',x=>x.m.host='0.0.0.0'],
    ['schema principal',x=>x.m.schema='istbrasil'],['ID divergente',x=>x.c.Id='b'.repeat(64)],['imagem divergente',x=>x.c.Config.Image='mariadb:latest'],
    ['label divergente',x=>x.c.Config.Labels={'ist.r2.run':'outro'}],['volume divergente',x=>x.v.Name='outro'],
    ['porta real divergente',x=>x.c.NetworkSettings.Ports['3306/tcp'][0].HostPort='49322'],
    ['binding externo',x=>x.c.NetworkSettings.Ports['3306/tcp'][0].HostIp='0.0.0.0'],
    ['datadir divergente',x=>x.c.Mounts[0].Source='/persistente'],['segredo gravavel',x=>x.c.Mounts[1].RW=true],
    ['contêiner parado',x=>x.c.State.Running=false],['privilegiado',x=>x.c.HostConfig.Privileged=true]
])test(`manifesto rejeita ${nome} antes de conectar`,()=>{const x=fixture();mutar(x);assert.throws(()=>validarManifestoNotificacoes10339(x.m,x.c,x.v));});

test('percurso legado e executor homologado permanecem na porta fixa; novo executor nao inicia servicos',async()=>{
    const legado=await readFile(new URL('../scripts/loja-admin-livro-patch-homologar-mariadb10339-wsl.sh',import.meta.url),'utf8');
    assert(legado.includes('-p 127.0.0.1:13339:3306'));
    const novo=await readFile(new URL('../scripts/loja-notificacoes-homologar-mariadb10339-wsl.sh',import.meta.url),'utf8');
    assert(novo.includes('-p 127.0.0.1::3306'));assert(novo.includes(DIGEST_10339));
    assert.doesNotMatch(novo,/systemctl\s+(?:start|stop|restart|enable|disable)|docker\s+(?:system|volume|container)\s+prune|docker\s+pull/);
});
