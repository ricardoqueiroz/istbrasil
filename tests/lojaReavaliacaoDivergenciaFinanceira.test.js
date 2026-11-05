import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {executarReavaliacaoDivergenciaFinanceira} from '../scripts/loja-reavaliar-divergencia-financeira.mjs';

const pedido=randomUUID(),recebedor='ABCDEFGHJKLMN';
const env={NODE_ENV:'production',DB_HOST:'127.0.0.1',DB_PORT:'3307',DB_NAME:'istbrasil_homolog',LOJA_AMBIENTE:'sandbox',
    IST_LOJA_PAYPAL_ENV:'sandbox',IST_LOJA_PAYPAL_CONTA_RECEBEDORA:recebedor};
test('rotina administrativa exige autorizacao explicita antes de carregar banco',async()=>{
    let carregou=false;const linhas=[];
    const n=await executarReavaliacaoDivergenciaFinanceira({argv:['--pedido',pedido],env,carregar:async()=>{carregou=true;},saida:x=>linhas.push(x)});
    assert.equal(n,1);assert.equal(carregou,false);assert.equal(JSON.parse(linhas[0]).codigo,'SOLICITACAO_INVALIDA');
});
test('rotina reavalia somente pedido em divergencia e fecha pool',async()=>{
    const linhas=[],chamadas=[];let fechou=false;
    const pool={getConnection(){},async query(sql,args){chamadas.push([sql,args]);
        if(sql.startsWith('SELECT DATABASE'))return [[{banco:'istbrasil_homolog',porta:3307,versao:'10.3.39-MariaDB'}]];
        return [[{id:1,estado:'REVISAO',motivo_revisao:'DIVERGENCIA_FINANCEIRA'}]];
    },async end(){fechou=true;}};
    const criarLojaDownloadDireitosService=({db})=>({async reavaliarDireitosDoPedido(id,contexto){
        assert.equal(db,pool);assert.equal(id,1);assert.deepEqual(contexto,{provedor:'paypal',ambiente:'sandbox',contaRecebedora:recebedor});
        return {avaliacao:{classificacao:'ELEGIVEL',elegivel:true,criterioExcepcional:'DIVERGENCIA_FINANCEIRA_CAPTURA_COMPROVADA'},
            direitos:[{id:1,estado:'ATIVO'}],transicoes:[{direitoId:1,estado:'ATIVO'}]};
    }});
    const n=await executarReavaliacaoDivergenciaFinanceira({argv:['--autorizar-reavaliacao-divergencia-sandbox','--pedido',pedido],env,
        carregar:async()=>({pool,criarLojaDownloadDireitosService}),saida:x=>linhas.push(x)});
    assert.equal(n,0);assert.equal(fechou,true);assert.equal(chamadas.length,2);
    assert.deepEqual(JSON.parse(linhas[0]),{pedidoPublicId:pedido,classificacao:'ELEGIVEL',criterioExcepcional:'DIVERGENCIA_FINANCEIRA_CAPTURA_COMPROVADA',
        direitosAvaliados:1,direitosAtivados:1,idempotente:false});
});
test('rotina nao reavalia pedido fora da revisao especifica',async()=>{
    let reavaliou=false;const pool={getConnection(){},async query(sql){return sql.startsWith('SELECT DATABASE')
        ?[[{banco:'istbrasil_homolog',porta:3307,versao:'10.3.39-MariaDB'}]]:[[{id:1,estado:'REVISAO',motivo_revisao:'OUTRO'}]];},async end(){}};
    const n=await executarReavaliacaoDivergenciaFinanceira({argv:['--autorizar-reavaliacao-divergencia-sandbox','--pedido',pedido],env,
        carregar:async()=>({pool,criarLojaDownloadDireitosService:()=>({reavaliarDireitosDoPedido(){reavaliou=true;}})}),saida:()=>{}});
    assert.equal(n,1);assert.equal(reavaliou,false);
});
