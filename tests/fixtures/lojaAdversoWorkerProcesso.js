// Processo filho exclusivo dos testes; dados/credenciais sinteticos via stdin,
// nunca em argumentos, arquivos ou logs. Nenhum dotenv/config da aplicacao.
import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import {criarLojaPagamentoService} from '../../src/services/lojaPagamentoService.js';
let texto='';for await(const parte of process.stdin)texto+=parte;
const entrada=JSON.parse(texto);texto='';
assert.equal(entrada.config.host,'127.0.0.1');assert(![3306,3307].includes(entrada.config.port));
assert.match(entrada.config.database,/^ist_loja_67_3_[a-f0-9]{12}$/);
const db=mysql.createPool({...entrada.config,dateStrings:false});
try{
    const [[id]]=await db.query('SELECT VERSION() versao,DATABASE() banco,@@port porta');
    assert.match(id.versao,/^(13\.0\.2|10\.3\.39)-MariaDB/);assert.equal(id.banco,entrada.config.database);
    assert.equal(Number(id.porta),Number(entrada.identidade.porta));
    const recursos=new Map(entrada.recursos),capturas=new Map(entrada.capturas);
    const service=criarLojaPagamentoService({db,contexto:entrada.contexto,agora:()=>new Date(entrada.tempo),
        adaptador:{criar(){assert.fail();},capturar(){assert.fail();},consultar(){assert.fail();},
            consultarEvidenciaAdversa:async x=>x.tipo==='CAPTURA'?capturas.get(x.recursoId):recursos.get(x.recursoId)}});
    const r=await service.processarEventosAdversos({limite:1});
    process.stdout.write(JSON.stringify(r));
}catch(e){
    const codigo=/^[A-Z0-9_]{1,64}$/.test(e.codigo??e.code??'')?(e.codigo??e.code):'FALHA_PROCESSO_SINTETICO';
    process.stderr.write(codigo);process.exitCode=1;
}finally{await db.end();}
