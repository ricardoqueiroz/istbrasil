import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {limitesArmazenamentoImplantacao} from '../../src/config/lojaImplantacao.js';

const execute=promisify(execFile);
const fail=code=>Object.assign(Error(code),{code});
// Import only the target release's pure validator. Never import server.js or db.js.
const programa=`
try {
  const m=await import(process.argv[1]);
  if(JSON.stringify(m.CONTRATO_ARMAZENAMENTO)!==JSON.stringify({versao:1,variaveis:['PRODUCTS_LIVROS_PATH','CAPAS_LIVROS_STORAGE_PATH']})
     ||typeof m.carregarCaminhosDoEnv!=='function'||typeof m.criarArmazenamentoLoja!=='function')process.exit(41);
  const env=m.carregarCaminhosDoEnv({arquivo:process.argv[2],env:{}});
  const armazenamento=m.criarArmazenamentoLoja({env,raizProjeto:process.argv[3],limites:JSON.parse(process.argv[4])});
  await armazenamento.validar();
  process.stdout.write('ARMAZENAMENTO_VALIDADO_V1');
} catch { process.exit(42); }
`;

export async function verificarArmazenamentoRelease({backend,arquivoEnv,base,limites=limitesArmazenamentoImplantacao(base),executar=execute}) {
    if(!path.isAbsolute(backend)||!path.isAbsolute(arquivoEnv))throw fail('STORAGE_PREFLIGHT_ARGUMENT_INVALID');
    const modulo=path.join(backend,'src/config/lojaArmazenamento.js');
    try{
        if((await fs.lstat(backend)).isSymbolicLink()||path.relative(await fs.realpath(backend),backend)!=='')throw fail('STORAGE_CONTRACT_INCOMPATIBLE');
        // Refuse a module redirected outside the selected release.
        let atual=backend;
        for(const parte of ['src','config','lojaArmazenamento.js']){
            atual=path.join(atual,parte);const st=await fs.lstat(atual);
            if(st.isSymbolicLink()||(parte==='lojaArmazenamento.js'?!st.isFile():!st.isDirectory()))throw fail('STORAGE_CONTRACT_INCOMPATIBLE');
        }
    }catch{throw fail('STORAGE_CONTRACT_INCOMPATIBLE');}
    const env={};for(const nome of ['SystemRoot','WINDIR'])if(process.env[nome])env[nome]=process.env[nome];
    try{
        const r=await executar(process.execPath,['--input-type=module','-e',programa,pathToFileURL(modulo).href,arquivoEnv,backend,JSON.stringify(limites)],
            {cwd:backend,env,timeout:10000,maxBuffer:4096,encoding:'utf8',windowsHide:true});
        if(r.stdout!=='ARMAZENAMENTO_VALIDADO_V1'||r.stderr)throw fail('STORAGE_PREFLIGHT_FAILED');
    }catch(e){throw fail(e?.code===41?'STORAGE_CONTRACT_INCOMPATIBLE':'STORAGE_PREFLIGHT_FAILED');}
}

// Shared gate: an unsuccessful validation never invokes the mutation callback.
export async function antesDeAtivar({backend,arquivoEnv,base,validar=verificarArmazenamentoRelease},ativar) {
    await validar({backend,arquivoEnv,base});return ativar();
}
