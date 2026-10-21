import test from 'node:test';
import assert from 'node:assert/strict';
import {iniciarDescobertaLoja} from '../src/services/lojaPagamentoAgendador.js';
const flush=()=>new Promise(r=>setImmediate(r));
const config={IST_LOJA_DESCOBERTA_ATIVA:'true',IST_LOJA_DESCOBERTA_FONTES:'NOTIFICACOES,DISPUTAS',IST_LOJA_DESCOBERTA_DESDE:'2026-01-01T00:00:00Z'};
const montar=(extras={})=>{
    let tick,n=0,cancelado=0;const chamadas=[],timers=[],logs=[];
    const service={descobrirEventosAdversos:async x=>{chamadas.push(x);return {estado:'CONCLUIDO'};}};
    const c=iniciarDescobertaLoja({env:config,obterFinanceiro:()=>{n++;return {service};},
        agendar:(fn,ms)=>{assert.equal(ms,60000);tick=fn;return {unref(){}};},cancelar:()=>cancelado++,
        limitar:(fn,ms)=>{const h={fn,ms,unref(){}};timers.push(h);return h;},deslimitar:h=>{if(h)h.cancelado=true;},
        registrar:m=>logs.push(m),...extras});
    return {c,service,chamadas,timers,logs,tick:()=>tick?.(),get composicoes(){return n;},get cancelados(){return cancelado;}};
};
test('descoberta desligada por padrao, independente do worker adverso',async()=>{
    for(const flag of [undefined,'false','TRUE',true]){
        const m=montar({env:{...config,IST_LOJA_ADVERSOS_ATIVA:'true',IST_LOJA_DESCOBERTA_ATIVA:flag}});
        assert.equal(m.c.ativo,false);assert.equal(m.composicoes,0);await m.c.parar();
    }
    assert.equal(montar({env:{...config,NODE_ENV:'test'}}).composicoes,0);
});
test('fontes e inicio explicitamente obrigatorios, sem presumir permissao da conta',()=>{
    for(const campo of [{IST_LOJA_DESCOBERTA_FONTES:''},{IST_LOJA_DESCOBERTA_FONTES:'OUTRA'},
        {IST_LOJA_DESCOBERTA_FONTES:'DISPUTAS,DISPUTAS'},{IST_LOJA_DESCOBERTA_DESDE:undefined}]){
        const m=montar({env:{...config,...campo}});assert.equal(m.c.ativo,false);assert.equal(m.composicoes,0);
    }
});
test('sem execucao imediata, fontes sequenciais, sem sobreposicao e encerramento idempotente',async()=>{
    const m=montar();assert.equal(m.chamadas.length,0);
    let liberar;m.service.descobrirEventosAdversos=x=>{m.chamadas.push(x);return new Promise(r=>liberar=r);};
    m.tick();await flush();m.tick();assert.equal(m.chamadas.length,1);
    const fim=m.c.parar();assert.strictEqual(m.c.parar(),fim);liberar({estado:'SEM_TRABALHO'});
    await fim;assert.equal(m.chamadas.length,1);assert.equal(m.cancelados,1);assert(m.timers.every(t=>t.cancelado));
});
test('deadline aborta e parar nao depende indefinidamente de fonte travada',async()=>{
    const m=montar();m.service.descobrirEventosAdversos=x=>{m.chamadas.push(x);return new Promise(()=>{});};
    m.tick();await flush();m.timers.find(t=>t.ms===90000).fn();assert(m.chamadas[0].signal.aborted);
    const fim=m.c.parar();m.timers.find(t=>t.ms===95000).fn();await fim;
});
test('erros de fonte sao sanitizados e nao derrubam API',async()=>{
    const m=montar();m.service.descobrirEventosAdversos=async()=>{throw Error('SEGREDO');};
    m.tick();await flush();assert.doesNotMatch(m.logs.join(),/SEGREDO/);await m.c.parar();
});
