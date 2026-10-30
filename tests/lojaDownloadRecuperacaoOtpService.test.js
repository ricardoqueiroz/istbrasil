import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomBytes,randomUUID} from 'node:crypto';
import {criarLojaDownloadRecuperacaoService} from '../src/services/lojaDownloadRecuperacaoService.js';
import {criarFixtureDireitos,contextoDireitos} from './fixtures/lojaDownloadDireitosFixture.js';
const chaveEmail=Buffer.alloc(32,1),chaveCodigo=Buffer.alloc(32,2),chaveLimites=Buffer.alloc(32,3);
const sql=async nome=>(await readFile(new URL(`../migrations/${nome}`,import.meta.url),'utf8'));
const baseConfig={chaveEmail,contextoEsperado:contextoDireitos};
test('B7-C4 exige chaves OTP independentes, sem banco ou rede',()=>{
    const db={getConnection(){throw Error('nao conectar');}};
    for(const otp of [{},{chaveCodigo,chaveLimites:chaveCodigo},{chaveCodigo:chaveEmail,chaveLimites},
        {chaveCodigo,chaveLimites:Buffer.alloc(31)}])assert.throws(()=>criarLojaDownloadRecuperacaoService({...baseConfig,db,otp}),{codigo:'CONFIGURACAO_INVALIDA'});
    assert.equal(typeof criarLojaDownloadRecuperacaoService({...baseConfig,db}).criarDesafio,'function');
});
test('B7-C4 OTP/LINK no MariaDB 10.3.39 exclusivo',{
    skip:process.env.IST_LOJA_MARIADB_NATIVO_10339!=='true',timeout:240000
},async t=>{
    assert.equal(process.env.IST_R2_10339_MANIFEST,'NATIVO_DESCARTAVEL_10339');
    const f=await criarFixtureDireitos(t),{a,pool}=f;
    for(const ddl of (await sql('ist_loja_download_recuperacao_fundacao.sql')).match(/CREATE TABLE ist_loja_[\s\S]*?\) ENGINE=InnoDB[^;]*;/g))await a.query(ddl);
    await a.query("SET @ist_b7c3_schema=DATABASE(),@ist_b7c3_autorizacao='FUNDACAO_OTP_B7_C3'");
    await a.query((await sql('ist_loja_download_recuperacao_otp_fundacao.sql')).replace(/^DELIMITER[^\r\n]*$/gm,'').replace(/END\$\$\s*$/,'END'));
    let contador=0;
    const preparar=async({sortearCodigo=()=>0,estadoDireito='ATIVO'}={})=>{
        const x=await f.preparar({estadoDireito}),i=++contador,email=`sintetico${i}@example.invalid`;
        await a.query('UPDATE ist_loja_pedidos SET comprador_email=? WHERE id=?',[email,x.pedidoId]);
        const [[p]]=await a.query('SELECT public_id FROM ist_loja_pedidos WHERE id=?',[x.pedidoId]);
        let n=Date.parse('2026-01-01T13:00:00.000Z');
        const op={email,pedidoPublicId:p.public_id,ip:`127.0.0.${i}`};
        const make=(db=pool)=>criarLojaDownloadRecuperacaoService({...baseConfig,db,agora:()=>new Date(n),otp:{chaveCodigo,chaveLimites,sortearCodigo}});
        return {x,op,s:make(),make,passar:ms=>{n+=ms;},registro:async id=>(await a.query('SELECT * FROM ist_loja_download_recuperacoes WHERE public_id=?',[id]))[0][0]};
    };
    const validar=(y,r,codigo=r.entrega.codigo,extra={})=>y.s.validarCodigo({...y.op,publicId:r.resposta.publicId,codigo,...extra});
    await t.test('zero a esquerda, HMAC persistido, dez minutos e sessao/escopo compartilhados',async()=>{
        const y=await preparar(),antes=await f.ler(y.x),r=await y.s.solicitarCodigo(y.op),row=await y.registro(r.resposta.publicId);
        assert.equal(r.entrega.codigo,'000000');assert.equal(r.entrega.validadeMinutos,10);
        assert.equal(Date.parse(r.entrega.expiraEm)-Date.parse('2026-01-01T13:00:00Z'),600000);
        assert.equal(row.tipo,'OTP');assert.equal(row.desafio_hash.length,32);
        assert(!row.desafio_hash.equals(Buffer.from('000000'.padEnd(32,'\0'))));
        const v=await validar(y,r);assert.deepEqual(v.sessao.direitos.map(d=>d.direitoId),y.x.direitos);
        assert.deepEqual(await y.s.obterSessao(v.token),v.sessao);
        await assert.rejects(validar(y,r),{codigo:'DESAFIO_INVALIDO'});
        assert.deepEqual(await f.ler(y.x),antes);
        assert.equal((await y.s.revogarSessao(v.token)).revogada,true);
        await assert.rejects(y.s.obterSessao(v.token),{codigo:'SESSAO_INVALIDA'});
    });
    await t.test('gerador padrao randomInt emite seis digitos e nao registra segredos',async()=>{
        const y=await preparar({sortearCodigo:undefined});
        const s=criarLojaDownloadRecuperacaoService({...baseConfig,db:pool,agora:()=>new Date('2026-01-01T13:00:00Z'),otp:{chaveCodigo,chaveLimites}});
        const logs=[],originais={};
        for(const nome of ['log','info','warn','error']){originais[nome]=console[nome];console[nome]=(...args)=>logs.push(args);}
        try{
            const r=await s.solicitarCodigo(y.op);assert.match(r.entrega.codigo,/^[0-9]{6}$/);
            assert((await s.validarCodigo({...y.op,publicId:r.resposta.publicId,codigo:r.entrega.codigo})).token);
            assert.equal(logs.length,0);
        }finally{Object.assign(console,originais);}
    });
    await t.test('limite exato de expiracao e nenhuma sessao',async()=>{
        const y=await preparar(),r=await y.s.solicitarCodigo(y.op);y.passar(600000);
        await assert.rejects(validar(y,r),{codigo:'DESAFIO_INVALIDO'});
        assert.equal((await y.registro(r.resposta.publicId)).sessao_hash,null);
    });
    await t.test('cinco erros invalidam e persistem depois de recriar servico',async()=>{
        const y=await preparar(),r=await y.s.solicitarCodigo(y.op);
        for(let i=0;i<5;i++)await assert.rejects(validar(y,r,'999999'),{codigo:'DESAFIO_INVALIDO'});
        const row=await y.registro(r.resposta.publicId);assert.equal(row.tentativas,5);assert.notEqual(row.invalidado_em,null);
        y.passar(61000);assert.equal((await y.make().solicitarCodigo(y.op)).entrega,null);
        await assert.rejects(validar(y,r),{codigo:'DESAFIO_INVALIDO'});
    });
    await t.test('reenvio preserva orçamento acumulado e invalida codigo anterior',async()=>{
        let numero=0;const y=await preparar({sortearCodigo:()=>numero++}),r=await y.s.solicitarCodigo(y.op);
        assert.equal((await y.s.solicitarCodigo(y.op)).entrega,null);
        for(let i=0;i<3;i++)await assert.rejects(validar(y,r,'999999'),{codigo:'DESAFIO_INVALIDO'});
        y.passar(61000);const outro=await y.make().solicitarCodigo(y.op);assert.equal(outro.entrega.codigo,'000001');
        assert.notEqual((await y.registro(r.resposta.publicId)).invalidado_em,null);
        await assert.rejects(validar(y,r),{codigo:'DESAFIO_INVALIDO'});
        for(let i=0;i<2;i++)await assert.rejects(validar(y,outro,'999999'),{codigo:'DESAFIO_INVALIDO'});
        assert.notEqual((await y.registro(outro.resposta.publicId)).invalidado_em,null);
        await assert.rejects(validar(y,outro),{codigo:'DESAFIO_INVALIDO'});
    });
    await t.test('tres emissoes por janela, IP protege solicitacoes invalidas sem texto claro',async()=>{
        const y=await preparar();
        for(let i=0;i<3;i++){assert((await y.s.solicitarCodigo(y.op)).entrega);y.passar(61000);}
        assert.equal((await y.s.solicitarCodigo(y.op)).entrega,null);
        const z=await preparar();
        for(let i=0;i<20;i++)assert.equal((await z.s.solicitarCodigo({...z.op,pedidoPublicId:randomUUID()})).entrega,null);
        assert.equal((await z.s.solicitarCodigo(z.op)).entrega,null);
        const [[ddl]]=await a.query('SHOW CREATE TABLE ist_loja_download_recuperacao_limites');
        assert(!/email_normalizado|ip_endereco|codigo/.test(ddl['Create Table']));
    });
    await t.test('concorrencia: uma emissao e um consumo, sem sessao duplicada',async()=>{
        const y=await preparar();const rs=await Promise.all([y.s.solicitarCodigo(y.op),y.s.solicitarCodigo(y.op)]);
        assert.equal(rs.filter(r=>r.entrega).length,1);const r=rs.find(r=>r.entrega);
        const vs=await Promise.allSettled([validar(y,r),validar(y,r)]);
        assert.equal(vs.filter(v=>v.status==='fulfilled').length,1);
        assert.equal(vs.filter(v=>v.status==='rejected'&&v.reason.codigo==='DESAFIO_INVALIDO').length,1);
        const [[v]]=await a.query('SELECT COUNT(*) n FROM ist_loja_download_recuperacao_direitos WHERE recuperacao_id=?',[(await y.registro(r.resposta.publicId)).id]);
        assert.equal(Number(v.n),2);
    });
    await t.test('LINK nao consome OTP, OTP nao consome LINK; links continuam funcionando',async()=>{
        const y=await preparar(),r=await y.s.solicitarCodigo(y.op);
        await assert.rejects(y.s.consumirDesafio(r.resposta.publicId,randomBytes(32).toString('base64url')),{codigo:'DESAFIO_INVALIDO'});
        assert.equal((await y.registro(r.resposta.publicId)).tentativas,0);
        const link=await y.s.criarDesafio(y.op.email);
        await assert.rejects(y.s.validarCodigo({...y.op,publicId:link.publicId,codigo:'000000'}),{codigo:'DESAFIO_INVALIDO'});
        assert.equal((await y.registro(link.publicId)).tentativas,0);
        const v=await y.s.consumirDesafio(link.publicId,link.segredo);
        assert.deepEqual((await y.s.obterSessao(v.token)).direitos.map(d=>d.direitoId),y.x.direitos);
        assert((await validar(y,r)).token);
    });
    await t.test('titulares/pedidos isolados; escopo OTP nao inclui outras compras do titular',async()=>{
        const y=await preparar(),z=await preparar(),r=await y.s.solicitarCodigo(y.op);
        await assert.rejects(validar(y,r,r.entrega.codigo,{email:z.op.email,pedidoPublicId:z.op.pedidoPublicId,ip:z.op.ip}),{codigo:'DESAFIO_INVALIDO'});
        assert.equal((await y.registro(r.resposta.publicId)).tentativas,0);
        assert.equal((await z.s.solicitarCodigo({...z.op,email:y.op.email})).entrega,null);
        const outro=await f.preparar({estadoDireito:'ATIVO'});
        await a.query('UPDATE ist_loja_pedidos SET comprador_email=? WHERE id=?',[y.op.email,outro.pedidoId]);
        assert.deepEqual((await validar(y,r)).sessao.direitos.map(d=>d.direitoId),y.x.direitos);
    });
    await t.test('pedido inelegivel e entrada invalida preservam resposta publica uniforme',async()=>{
        const y=await preparar({estadoDireito:'SUSPENSO'});
        for(const op of [y.op,{...y.op,email:'invalido'},{...y.op,pedidoPublicId:randomUUID()}]){
            const r=await y.s.solicitarCodigo(op);assert.deepEqual(Object.keys(r.resposta),['aceito','publicId']);assert.equal(r.entrega,null);
        }
        await assert.rejects(y.s.solicitarCodigo({...y.op,ip:'nao-IP'}),{codigo:'ENTRADA_INVALIDA'});
    });
    const bancoFalha=(fase)=>({getConnection:async()=>{
        const c=await pool.getConnection();
        return {query:async(...args)=>{if(fase==='escopo'&&args[0].includes('INSERT INTO ist_loja_download_recuperacao_direitos'))throw Error('falha sintetica');return c.query(...args);},
            beginTransaction:()=>c.beginTransaction(),rollback:()=>c.rollback(),release:()=>c.release(),destroy:()=>c.destroy(),
            commit:async()=>{if(fase==='commit-apos')await c.commit();if(fase.startsWith('commit'))throw Error('ACK incerto');return c.commit();}};
    }});
    await t.test('falha no escopo reverte sessao e vinculos; recuperacao posterior funciona',async()=>{
        const y=await preparar(),r=await y.s.solicitarCodigo(y.op);
        await assert.rejects(y.make(bancoFalha('escopo')).validarCodigo({...y.op,publicId:r.resposta.publicId,codigo:r.entrega.codigo}),{codigo:'RECUPERACAO_INDISPONIVEL'});
        assert.equal((await y.registro(r.resposta.publicId)).consumido_em,null);
        assert((await validar(y,r)).token);
    });
    await t.test('falha na escrita do desafio nao invalida o anterior nem consome reenvio',async()=>{
        const y=await preparar(),r=await y.s.solicitarCodigo(y.op);y.passar(61000);
        const db={getConnection:async()=>{
            const c=await pool.getConnection();
            return {query:async(...args)=>{if(args[0].includes('INSERT INTO ist_loja_download_recuperacoes'))throw Error('escrita sintetica');return c.query(...args);},
                beginTransaction:()=>c.beginTransaction(),rollback:()=>c.rollback(),release:()=>c.release(),destroy:()=>c.destroy(),commit:()=>c.commit()};
        }};
        await assert.rejects(y.make(db).solicitarCodigo(y.op),{codigo:'RECUPERACAO_INDISPONIVEL'});
        assert.equal((await y.registro(r.resposta.publicId)).invalidado_em,null);
        assert((await validar(y,r)).token);
    });
    await t.test('falha antes do commit nao entrega token e deixa desafio recuperavel',async()=>{
        const y=await preparar(),r=await y.s.solicitarCodigo(y.op);
        await assert.rejects(y.make(bancoFalha('commit-antes')).validarCodigo({...y.op,publicId:r.resposta.publicId,codigo:r.entrega.codigo}),{codigo:'RESULTADO_DESCONHECIDO'});
        assert.equal((await y.registro(r.resposta.publicId)).consumido_em,null);
        assert((await validar(y,r)).token);
    });
    await t.test('commit incerto nunca devolve codigo ou sessao; sem retry automatico',async()=>{
        const y=await preparar();
        await assert.rejects(y.make(bancoFalha('commit-apos')).solicitarCodigo(y.op),{codigo:'RESULTADO_DESCONHECIDO'});
        y.passar(61000);const r=await y.s.solicitarCodigo(y.op);
        await assert.rejects(y.make(bancoFalha('commit-apos')).validarCodigo({...y.op,publicId:r.resposta.publicId,codigo:r.entrega.codigo}),{codigo:'RESULTADO_DESCONHECIDO'});
        assert.notEqual((await y.registro(r.resposta.publicId)).consumido_em,null);
        await assert.rejects(validar(y,r),{codigo:'DESAFIO_INVALIDO'});
    });
});
