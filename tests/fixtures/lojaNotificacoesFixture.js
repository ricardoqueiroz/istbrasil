import assert from 'node:assert/strict';
import {isAbsolute} from 'node:path';

export const DIRETORIO_10339='/home/ist_user/.local/state/ist-notificacoes-mariadb10339';
export const DIGEST_10339='sha256:a4b57b620852e26f2c306c79fd8a61e22c7cd6e55d0a55d5521854ed2c370102';

export const selecionarFixtureNotificacoes=(env=process.env)=>{
    const versao=env.IST_LOJA_NOTIFICACOES_MARIADB;
    assert(['13.0.2','10.3.39'].includes(versao),'Selecionar explicitamente a versao MariaDB das notificacoes.');
    if(versao==='13.0.2'){
        assert(!env.IST_R2_10339_MANIFEST,'Configuracao MariaDB ambigua.');
        assert(env.IST_LOJA_PAGAMENTOS_MARIADB_BIN&&isAbsolute(env.IST_LOJA_PAGAMENTOS_MARIADB_BIN),'Binario 13.0.2 absoluto obrigatorio.');
    }else{
        assert(!env.IST_LOJA_PAGAMENTOS_MARIADB_BIN,'Configuracao MariaDB ambigua.');
        assert.equal(env.IST_R2_10339_MANIFEST,`${DIRETORIO_10339}/manifest.json`);
    }
    return versao;
};

export const validarManifestoNotificacoes10339=(m,c,v)=>{
    assert.equal(m.containerName,'ist-notificacoes-mariadb10339');
    assert.equal(m.volume,'ist-notificacoes-mariadb10339-data');
    assert.equal(m.imageDigest,DIGEST_10339);assert.equal(m.host,'127.0.0.1');
    assert.match(m.containerId,/^[0-9a-f]{64}$/);assert.match(m.runId,/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.match(m.schema,/^ist_loja_67_3_[0-9a-f]{12}$/);
    assert(Number.isInteger(m.port)&&m.port>1024&&m.port<=65535&&![3000,3001,3306,3307,4200,4201,8080,8443,13339].includes(m.port));
    assert.equal(c.Id,m.containerId);assert.equal(c.Name,`/${m.containerName}`);assert.equal(c.State.Running,true);
    assert.equal(c.Config.Image,`docker.io/library/mariadb@${DIGEST_10339}`);
    assert.equal(c.Config.Labels['ist.r2.run'],m.runId);assert.equal(v.Name,m.volume);assert.equal(v.Labels['ist.r2.run'],m.runId);
    assert.equal(v.Driver,'local');assert.equal(c.Mounts.length,2);
    assert.equal(c.HostConfig.RestartPolicy.Name,'no');assert.equal(c.HostConfig.NetworkMode,'bridge');
    // docker inspect exposes Networks as an object keyed by network name.
    const redes=c.NetworkSettings.Networks;
    assert(redes&&typeof redes==='object'&&!Array.isArray(redes),'Associacoes de rede ausentes ou invalidas.');
    assert.deepEqual(Object.keys(redes),['bridge'],'Somente a rede bridge e permitida.');
    assert(redes.bridge&&typeof redes.bridge==='object'&&!Array.isArray(redes.bridge),'Associacao bridge invalida.');
    assert.equal(c.HostConfig.Privileged,false);
    assert.deepEqual(c.NetworkSettings.Ports['3306/tcp'],[{HostIp:'127.0.0.1',HostPort:String(m.port)}]);
    const dados=c.Mounts.filter(x=>x.Destination==='/var/lib/mysql');
    assert.equal(dados.length,1);assert.equal(dados[0].Type,'volume');assert.equal(dados[0].Name,m.volume);assert.equal(dados[0].RW,true);
    assert.equal(dados[0].Source,v.Mountpoint);
    const segredos=c.Mounts.filter(x=>x.Destination==='/run/secrets/root-password');
    assert.equal(segredos.length,1);assert.equal(segredos[0].Type,'bind');
    assert.equal(segredos[0].Source,`${DIRETORIO_10339}/root-password`);assert.equal(segredos[0].RW,false);
    return m;
};

export const verificarObservadorNotificacoes=async(c,t)=>{
    const [[i]]=await c.query('SELECT CURRENT_USER() usuario,CONNECTION_ID() conexao');
    assert.match(i.usuario,/^[a-zA-Z0-9_.%-]+@[a-zA-Z0-9_.%-]+$/);
    const [usuario,host]=i.usuario.split('@');
    const [[p]]=await c.query("SELECT COUNT(*) n FROM information_schema.USER_PRIVILEGES WHERE GRANTEE=? AND PRIVILEGE_TYPE='PROCESS'",[`'${usuario}'@'${host}'`]);
    assert.equal(Number(p.n),1,'PROCESS global necessario; nao conceder privilegios automaticamente.');
    t.diagnostic(`OBSERVADOR_SQL: usuario efetivo ${i.usuario}; conexao ${Number(i.conexao)}; PROCESS global confirmado.`);
};

export const criarFixtureNotificacoes=async t=>{
    const versao=selecionarFixtureNotificacoes();
    const modulo=await import(versao==='10.3.39'?'./lojaCatalogoMariaDB10339.js':'./lojaPagamentoBancoIsolado.js');
    const fx=await modulo.criarBancoPagamentoIsolado(t,...(versao==='10.3.39'?[{financeiroOutbox:true}]:[]));
    await verificarObservadorNotificacoes(fx.admin,t);
    const config=fx.admin.config??fx.admin.connection.config;
    assert.equal(config.host,'127.0.0.1');
    assert.match(fx.identidade.banco,/^ist_loja_67_3_[0-9a-f]{12}$/);
    assert.match(fx.identidade.versao,versao==='10.3.39'?/^10\.3\.39-MariaDB(?:-|$)/:/^13\.0\.2-MariaDB(?:-|$)/);
    const portaExterna=Number(config.port);assert(Number.isInteger(portaExterna)&&portaExterna>0&&portaExterna<=65535);
    const obter=fx.pool.getConnection.bind(fx.pool);
    fx.pool.getConnection=async()=>{
        const c=await obter();
        try{
            const [[i]]=await c.query('SELECT DATABASE() banco,@@port porta,@@datadir datadir,@@hostname hostname,VERSION() versao');
            assert.deepEqual(i,fx.identidade);
            assert.equal(c.connection.config.host,'127.0.0.1');assert.equal(Number(c.connection.config.port),portaExterna);
            return c;
        }catch(e){c.destroy();throw e;}
    };
    return {...fx,portaExterna};
};
