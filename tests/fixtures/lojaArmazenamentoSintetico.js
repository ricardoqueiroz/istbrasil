import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const prepararArmazenamentoSintetico=async t=>{
    const raiz=await mkdtemp(path.join(fileURLToPath(new URL('../',import.meta.url)),'ist-storage-'));
    t.after(()=>rm(raiz,{recursive:true,force:true}));
    const pdf=path.join(raiz,'pdf'),capas=path.join(raiz,'uploads','livros'),arquivo=path.join(raiz,'.env');
    await mkdir(pdf);await mkdir(capas,{recursive:true});
    await writeFile(arquivo,`PRODUCTS_LIVROS_PATH=${pdf.replaceAll('\\','/')}\nCAPAS_LIVROS_STORAGE_PATH=${capas.replaceAll('\\','/')}\n`);
    return {raiz,pdf,capas,arquivo};
};
