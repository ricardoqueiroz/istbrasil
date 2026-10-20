import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, timingSafeEqual } from 'node:crypto';

const MAX_BYTES = 32 * 1024 * 1024;
let preparacoes = 0; // Compartilhado entre todos os chamadores deste modulo/processo; sem fila.
const codigos = new Set(['CONFIGURACAO_INVALIDA','VERSAO_INVALIDA','ARQUIVO_AUSENTE','CAMINHO_INSEGURO',
    'ARQUIVO_ESPECIAL','TAMANHO_EXCEDIDO','TAMANHO_DIVERGENTE','ARQUIVO_TRUNCADO','HASH_DIVERGENTE',
    'PDF_INVALIDO','CAPACIDADE_ESGOTADA','OPERACAO_CANCELADA','ARQUIVO_ALTERADO','FALHA_LEITURA']);
const falhar = codigo => { throw Object.assign(new Error(codigo), { codigo }); };
const igual = (a,b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const identidade = s => ['dev','ino','size','mtimeNs','ctimeNs','nlink'].map(k=>String(s[k])).join(':');
const cancelar = signal => { if (signal?.aborted) falhar('OPERACAO_CANCELADA'); };

// Mesmo alfabeto/caminho do schema e da publicacao, sem fallback de raiz.
const validar = (m,config) => {
    if (!config || typeof config.raizPrivada !== 'string' || !path.isAbsolute(config.raizPrivada)
        || config.raizPrivada.includes('\0') || path.resolve(config.raizPrivada) === path.parse(config.raizPrivada).root
        || (config.signal !== undefined && !(config.signal instanceof AbortSignal))) falhar('CONFIGURACAO_INVALIDA');
    if (!m || !Number.isInteger(m.arquivoVersaoId) || m.arquivoVersaoId<1 || m.arquivoVersaoId>4294967295
        || typeof m.tamanhoBytes!=='string' || !/^[1-9]\d{0,15}$/.test(m.tamanhoBytes)
        || BigInt(m.tamanhoBytes)>9007199254740991n || !Buffer.isBuffer(m.sha256) || m.sha256.length!==32
        || m.mime!=='application/pdf') falhar('VERSAO_INVALIDA');
    if (typeof m.caminhoRelativo!=='string' || m.caminhoRelativo.length>512
        || !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\.pdf$/.test(m.caminhoRelativo)
        || /[^A-Za-z0-9_./-]/.test(m.caminhoRelativo)) falhar('CAMINHO_INSEGURO');
    if (BigInt(m.tamanhoBytes)>BigInt(MAX_BYTES)) falhar('TAMANHO_EXCEDIDO');
    return { raiz:path.resolve(config.raizPrivada), relativo:m.caminhoRelativo,
        tamanho:Number(m.tamanhoBytes), sha256:Buffer.from(m.sha256), signal:config.signal };
};

const semLinks = async alvo => {
    let atual=path.parse(alvo).root;
    for (const segmento of alvo.slice(atual.length).split(path.sep).filter(Boolean)) {
        atual=path.join(atual,segmento);
        if ((await fs.lstat(atual)).isSymbolicLink()) falhar('CAMINHO_INSEGURO');
    }
};

/** Recebe exclusivamente o resultado interno confiavel de D6-B1, apos encerrar SQL.
 * Nao autoriza comprador, nao consulta SQL, nao le dotenv e nao devolve caminhos.
 */
export const prepararArquivoValidado = async (metadadosVersao, configuracaoConfiavel) => {
    const m=validar(metadadosVersao,configuracaoConfiavel);
    cancelar(m.signal);
    if (preparacoes>=4) falhar('CAPACIDADE_ESGOTADA');
    preparacoes++;
    let h,resultado,erro;
    try {
        await semLinks(m.raiz);
        if (!(await fs.lstat(m.raiz)).isDirectory() || !igual(await fs.realpath(m.raiz),m.raiz)) falhar('CAMINHO_INSEGURO');
        const alvo=path.resolve(m.raiz,...m.relativo.split('/')), dentro=path.relative(m.raiz,alvo);
        if (!dentro || dentro.startsWith('..') || path.isAbsolute(dentro)) falhar('CAMINHO_INSEGURO');
        await semLinks(alvo);
        if (!igual(await fs.realpath(alvo),alvo)) falhar('CAMINHO_INSEGURO');
        const anterior=await fs.lstat(alvo,{bigint:true});
        if (!anterior.isFile() || anterior.nlink!==1n) falhar('ARQUIVO_ESPECIAL');
        cancelar(m.signal);
        // NONBLOCK evita bloqueio em FIFO substituido entre lstat/open, onde disponivel.
        h=await fs.open(alvo,constants.O_RDONLY | (constants.O_NOFOLLOW??0) | (constants.O_NONBLOCK??0));
        const inicial=await h.stat({bigint:true});
        if (!inicial.isFile() || inicial.nlink!==1n) falhar('ARQUIVO_ESPECIAL');
        if (identidade(inicial)!==identidade(anterior)) falhar('ARQUIVO_ALTERADO');
        if (inicial.size>BigInt(MAX_BYTES)) falhar('TAMANHO_EXCEDIDO');
        if (inicial.size<BigInt(m.tamanho)) falhar('ARQUIVO_TRUNCADO');
        if (inicial.size!==BigInt(m.tamanho)) falhar('TAMANHO_DIVERGENTE');
        const buffer=Buffer.alloc(m.tamanho); // Unica alocacao integral; nunca concatena.
        const hash=createHash('sha256');
        let posicao=0;
        while (posicao<buffer.length) {
            cancelar(m.signal);
            const {bytesRead}=await h.read(buffer,posicao,Math.min(64*1024,buffer.length-posicao),posicao);
            if (!bytesRead) falhar('ARQUIVO_TRUNCADO');
            if (bytesRead<0 || posicao+bytesRead>MAX_BYTES || posicao+bytesRead>buffer.length) falhar('TAMANHO_EXCEDIDO');
            hash.update(buffer.subarray(posicao,posicao+bytesRead));posicao+=bytesRead;
        }
        cancelar(m.signal);
        // Detecta crescimento sem alocar com base no tamanho observado/declarado.
        if ((await h.read(Buffer.alloc(1),0,1,posicao)).bytesRead!==0) falhar('TAMANHO_DIVERGENTE');
        if (!timingSafeEqual(hash.digest(),m.sha256)) falhar('HASH_DIVERGENTE');
        if (buffer.length<8 || !/^%PDF-(?:1\.[0-7]|2\.0)$/.test(buffer.subarray(0,8).toString('latin1'))) falhar('PDF_INVALIDO');
        await semLinks(m.raiz);await semLinks(alvo);
        if (!igual(await fs.realpath(m.raiz),m.raiz) || !igual(await fs.realpath(alvo),alvo)
            || identidade(await h.stat({bigint:true}))!==identidade(inicial)
            || identidade(await fs.lstat(alvo,{bigint:true}))!==identidade(inicial)) falhar('ARQUIVO_ALTERADO');
        cancelar(m.signal);
        resultado={buffer,tamanho:buffer.length,mime:'application/pdf',nomeDownload:'livro.pdf'};
    } catch (e) {
        erro=codigos.has(e?.codigo)?e.codigo:e?.code==='ENOENT'?'ARQUIVO_AUSENTE'
            :['ELOOP','ENOTDIR'].includes(e?.code)?'CAMINHO_INSEGURO':'FALHA_LEITURA';
    } finally {
        if (h) try { await h.close(); } catch { erro=erro??'FALHA_LEITURA'; }
        preparacoes--;
    }
    if (erro) falhar(erro);
    cancelar(m.signal);
    return resultado;
};
