import test from 'node:test';
import assert from 'node:assert/strict';
import {iniciarWorkerAdversoLoja} from '../src/services/lojaPagamentoAgendador.js';
import {criarLojaPagamentoAdversoWorker} from '../src/services/lojaPagamentoAdversoWorker.js';
const flush=()=>new Promise(r=>setImmediate(r));
const montar=(extras={})=>{
    let tick,cancelados=0,criadas=0;const limites=[],logs=[],chamadas=[];
    const service={processarEventosAdversos:async x=>{chamadas.push(x);},diagnosticarEventosAdversos:async()=>({
        pendentes:0,processando:0,reservasVencidas:0,reagendados:0,esgotados:0,revisao:0,erros:{},ultimosErros:{}})};
    const r=iniciarWorkerAdversoLoja({env:{IST_LOJA_ADVERSOS_ATIVA:'true'},
        obterFinanceiro:()=>{criadas++;return {service};},
        agendar:(fn,ms)=>{assert.equal(ms,60000);tick=fn;return {unref(){}};},cancelar:()=>cancelados++,
        limitar:(fn,ms)=>{const h={fn,ms,unref(){}};limites.push(h);return h;},
        deslimitar:h=>{if(h)h.cancelado=true;},registrar:m=>logs.push(m),...extras});
    return {r,service,logs,limites,chamadas,tick:()=>tick?.(),get criadas(){return criadas;},get cancelados(){return cancelados;}};
};
test('adversos desligados por padrao, valores nao exatos e testes nao compoem financeiro',async()=>{
    for(const v of [undefined,'false','TRUE','1',true]){
        const m=montar({env:{IST_LOJA_RECUPERACAO_ATIVA:'true',IST_LOJA_ADVERSOS_ATIVA:v}});
        assert.equal(m.r.ativo,false);assert.equal(m.criadas,0);await m.r.parar();
    }
    assert.equal(montar({env:{NODE_ENV:'test',IST_LOJA_ADVERSOS_ATIVA:'true'}}).criadas,0);
});
test('ativacao explicita, lote 10, sem execucao imediata ou ciclos sobrepostos',async()=>{
    const m=montar();let liberar;m.service.processarEventosAdversos=x=>{m.chamadas.push(x);return new Promise(r=>liberar=r);};
    assert.equal(m.r.ativo,true);assert.equal(m.chamadas.length,0);
    m.tick();await flush();m.tick();assert.equal(m.chamadas.length,1);assert.equal(m.chamadas[0].limite,10);
    const fim=m.r.parar();assert.strictEqual(m.r.parar(),fim);m.tick();liberar();await fim;
    assert.equal(m.cancelados,1);assert(m.limites.every(x=>x.cancelado));
});
test('diagnostico totalmente zerado e silencioso, mas pendencias continuam registradas',async()=>{
    const m=montar();m.tick();await flush();assert.deepEqual(m.logs,[]);
    m.service.diagnosticarEventosAdversos=async()=>({pendentes:1,processando:0,reservasVencidas:0,reagendados:0,
        esgotados:0,revisao:0,erros:{},ultimosErros:{}});
    m.tick();await flush();assert.equal(m.logs.length,1);assert.match(m.logs[0],/"pendentes":1/);await m.r.parar();
});
test('excecao nao encerra API nem vaza mensagem e proximo ciclo e permitido',async()=>{
    const m=montar();m.service.processarEventosAdversos=async()=>{throw Error('SEGREDO-PESSOAL');};
    m.tick();await flush();m.tick();await flush();assert.equal(m.logs.length,2);
    assert.doesNotMatch(m.logs.join(),/SEGREDO-PESSOAL/);await m.r.parar();
});
test('prazo do ciclo aborta signal e encerramento limitado nao espera promessa infinita',async()=>{
    const m=montar();m.service.processarEventosAdversos=x=>{m.chamadas.push(x);return new Promise(()=>{});};
    m.tick();await flush();m.limites.find(x=>x.ms===30000).fn();assert(m.chamadas[0].signal.aborted);
    const fim=m.r.parar();m.limites.find(x=>x.ms===35000).fn();await fim;
    m.tick();assert.equal(m.chamadas.length,1);assert(m.limites.every(x=>x.cancelado));
});
test('configuracao invalida desativa apenas worker adverso',()=>{
    const m=montar({obterFinanceiro:()=>{throw Error('SEGREDO');}});assert.equal(m.r.ativo,false);
    assert.doesNotMatch(m.logs.join(),/SEGREDO/);
});
test('falha de conexao antes de GET e sanitizada e nao aciona provedor',async()=>{
    const w=criarLojaPagamentoAdversoWorker({db:{getConnection:async()=>{throw Error('SEGREDO');}},
        contexto:{provedor:'paypal',ambiente:'sandbox',contaRecebedora:'SINTETICO'},reconciliar:()=>assert.fail()});
    await assert.rejects(w.processar(),e=>e.codigo==='CONEXAO_INVALIDA'&&!e.message.includes('SEGREDO'));
});
test('jitter e limitado a seis horas; mensagens arbitrarias nao entram no ledger',async()=>{
    let parametros;
    const w=criarLojaPagamentoAdversoWorker({db:{getConnection:async()=>({
        query:async(s,p)=>{if(s.startsWith('SELECT @@'))return [[{tx:0,ac:1}]];
            if(s.startsWith('UPDATE')){parametros=p;return [{affectedRows:1}];}return [[]];},
        beginTransaction:async()=>{},commit:async()=>{},release(){},rollback:async()=>{}
    })},contexto:{provedor:'paypal',ambiente:'sandbox',contaRecebedora:'SINTETICO'},
        reconciliar:()=>assert.fail(),agora:()=>new Date('2026-01-01T00:00:00Z'),aleatorio:()=>.999});
    await w.registrarFalha({tentativas:5},'D9_TRANSITORIO');assert.equal(parametros[2],'2026-01-01 06:00:00.000');
    await w.registrarFalha({tentativas:1},'SEGREDO-SQL');assert.equal(parametros[1],'D9_REVISAO');assert.equal(parametros[2],null);
});
