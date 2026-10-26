import fs from 'node:fs/promises';
import path from 'node:path';

// Copies only validator sources and dotenv into a synthetic release; never loads server/db.
export async function prepararValidadorRelease(backend){
    await fs.mkdir(path.join(backend,'src/config'),{recursive:true});
    for(const arquivo of ['config/lojaArmazenamento.js','config/lojaImplantacao.js','config/lojaArquivos.js','services/lojaArquivoService.js']){
        const destino=path.join(backend,'src',arquivo);await fs.mkdir(path.dirname(destino),{recursive:true});
        await fs.copyFile(new URL(`../../src/${arquivo}`,import.meta.url),destino);
    }
    await fs.mkdir(path.join(backend,'node_modules'),{recursive:true});
    await fs.cp(new URL('../../node_modules/dotenv',import.meta.url),path.join(backend,'node_modules/dotenv'),{recursive:true});
    await fs.writeFile(path.join(backend,'package.json'),JSON.stringify({type:'module',name:'storage-synthetic'}));
}
