import path from 'node:path';
import { lstat, realpath, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';

const erro = codigo => Object.assign(new Error(codigo), { codigo });
const falhar = codigo => { throw erro(codigo); };
const uuid = v => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
const produtoValido = v => Number.isSafeInteger(v) && v > 0 && v <= 2147483647;
const relativoValido = v => typeof v === 'string' && v.length <= 512
    && /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\.pdf$/.test(v) && !/[^A-Za-z0-9_./-]/.test(v);
const campos = (v, nomes) => {
    if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length !== nomes.length
        || nomes.some(n => !Object.hasOwn(v, n))) falhar('ENTRADA_INVALIDA');
};
const mesmoCaminho = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const identidade = s => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].map(k => String(s[k])).join(':');
const destruir = c => { try { c.destroy(); } catch { /* Conexao incerta nunca volta ao pool. */ } };
const publico = r => ({ versaoPublicId: r.public_id, produtoId: r.produto_id, arquivoLogicoId: r.arquivo_logico_id,
    numeroVersao: r.numero_versao, estado: r.estado });

// Chamador ja bloqueou categorias, produtos e livros, nesta ordem.
// Somente leitura de metadados; nunca abre transacao ou acessa o filesystem.
export const selecionarVersoesNaConexao = async (conexao, produtoIds) => {
    if (!conexao || !Array.isArray(produtoIds) || produtoIds.some(id => !produtoValido(id))
        || new Set(produtoIds).size !== produtoIds.length) falhar('ENTRADA_INVALIDA');
    const [[estado]] = await conexao.query('SELECT @@in_transaction AS em_transacao');
    if (Number(estado?.em_transacao) !== 1) falhar('ERRO_INTERNO');
    const versoes = new Map();
    for (const produtoId of [...produtoIds].sort((a,b) => a-b)) {
        const [rows] = await conexao.query(`SELECT id, produto_id FROM ist_loja_arquivo_versoes
            WHERE produto_id = ? AND publicacao_atual = 1 AND estado = 'PUBLICADA' LOCK IN SHARE MODE`, [produtoId]);
        if (rows.length > 1 || rows.some(r => r.produto_id !== produtoId || !Number.isInteger(r.id) || r.id <= 0)) falhar('ERRO_INTERNO');
        versoes.set(produtoId, rows[0]?.id ?? null);
    }
    return versoes;
};

// Sem singleton, dotenv, pool padrao, HTTP ou escrita no sistema de arquivos.
export const criarLojaArquivoService = ({ db, raizPrivada, agora = () => new Date(), maxBytes = 268435456 } = {}) => {
    if (!db?.getConnection || typeof raizPrivada !== 'string' || !path.isAbsolute(raizPrivada)
        || typeof agora !== 'function' || !Number.isSafeInteger(maxBytes) || maxBytes < 8) falhar('CONFIGURACAO_INVALIDA');
    const raiz = path.resolve(raizPrivada);
    const instante = () => {
        const d = agora();
        if (!(d instanceof Date) || !Number.isFinite(d.getTime()) || d.getUTCFullYear() < 1000 || d.getUTCFullYear() > 9999) falhar('CONFIGURACAO_INVALIDA');
        return d.toISOString().slice(0, 23).replace('T', ' ');
    };
    const semLinks = async alvo => {
        let atual = path.parse(alvo).root;
        for (const segmento of alvo.slice(atual.length).split(path.sep).filter(Boolean)) {
            atual = path.join(atual, segmento);
            if ((await lstat(atual)).isSymbolicLink()) falhar('CAMINHO_INSEGURO');
        }
    };
    const conferirArquivo = async relativo => {
        let h;
        try {
            await semLinks(raiz);
            const root = await realpath(raiz);
            if (!mesmoCaminho(root, raiz) || !(await lstat(root)).isDirectory()) falhar('CAMINHO_INSEGURO');
            const alvo = path.resolve(root, ...relativo.split('/'));
            const dentro = path.relative(root, alvo);
            if (!dentro || dentro.startsWith('..') || path.isAbsolute(dentro)) falhar('CAMINHO_INSEGURO');
            await semLinks(alvo);
            const canonico = await realpath(alvo);
            if (!mesmoCaminho(canonico, alvo)) falhar('CAMINHO_INSEGURO');
            h = await open(alvo, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
            const inicial = await h.stat({ bigint: true });
            if (!inicial.isFile() || inicial.nlink !== 1n || inicial.size < 8n || inicial.size > BigInt(maxBytes)) falhar('ARQUIVO_INVALIDO');
            const header = Buffer.alloc(8);
            const { bytesRead } = await h.read(header, 0, 8, 0);
            if (bytesRead !== 8 || !/^%PDF-(?:1\.[0-7]|2\.0)$/.test(header.toString('latin1'))) falhar('PDF_INVALIDO');
            const hash = createHash('sha256'); let bytes = 0n;
            for await (const bloco of h.createReadStream({ autoClose: false, start: 0 })) {
                bytes += BigInt(bloco.length);
                if (bytes > BigInt(maxBytes)) falhar('ARQUIVO_ALTERADO');
                hash.update(bloco);
            }
            if (bytes !== inicial.size) falhar('ARQUIVO_ALTERADO');
            const conferir = async () => {
                try {
                    await semLinks(raiz); await semLinks(alvo);
                    if (!mesmoCaminho(await realpath(alvo), canonico)
                        || identidade(await h.stat({ bigint: true })) !== identidade(inicial)
                        || identidade(await lstat(alvo, { bigint: true })) !== identidade(inicial)) falhar('ARQUIVO_ALTERADO');
                } catch { falhar('ARQUIVO_ALTERADO'); }
            };
            await conferir();
            return { tamanho: String(bytes), sha: hash.digest(), conferir, fechar: () => h.close() };
        } catch (e) {
            if (h) await h.close().catch(() => {});
            if (e.codigo) throw e;
            falhar(e.code === 'ENOENT' ? 'ARQUIVO_AUSENTE' : 'ARQUIVO_INVALIDO');
        }
    };
    const transacao = async (caminho, arquivo, executar, conciliar) => {
        let c, iniciada = false, commitIniciado = false, lock = false;
        // Mesmo nome por caminho em todos os produtos/processos; sem lock global
        // da aplicacao. Comparacao case-insensitive conservadora tambem no Linux.
        const chave = 'ist:arq:' + createHash('sha256').update(caminho.toLowerCase()).digest('hex').slice(0, 56);
        try {
            c = await db.getConnection();
            try { await c.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED'); }
            catch (e) { destruir(c); c = null; throw e; }
            const [[estado]] = await c.query('SELECT @@in_transaction transacao,@@autocommit autocommit');
            if (Number(estado.transacao) !== 0 || Number(estado.autocommit) !== 1) { destruir(c); c = null; falhar('CONEXAO_INVALIDA'); }
            const [[obtido]] = await c.execute('SELECT GET_LOCK(?,5) obtido', [chave]);
            if (Number(obtido.obtido) !== 1) falhar('CONTENCAO_TEMPORARIA');
            lock = true;
            await c.beginTransaction(); iniciada = true;
            await arquivo.conferir();
            const resultado = await executar(c);
            await arquivo.conferir();
            commitIniciado = true;
            await c.commit(); iniciada = false;
            return resultado;
        } catch (e) {
            if (commitIniciado) {
                destruir(c); c = null;
                if (conciliar) return conciliar();
                falhar('RESULTADO_DESCONHECIDO');
            }
            if (c && iniciada) {
                try { await c.rollback(); } catch { destruir(c); c = null; falhar('RESULTADO_DESCONHECIDO'); }
            }
            if (e.codigo) throw e;
            falhar([1205,1213].includes(e.errno) ? 'CONTENCAO_TEMPORARIA'
                : e.errno === 1062 ? 'CONFLITO_IDEMPOTENCIA' : 'ERRO_PERSISTENCIA');
        } finally {
            if (c) {
                if (lock) {
                    try {
                        const [[liberado]] = await c.execute('SELECT RELEASE_LOCK(?) liberado', [chave]);
                        if (Number(liberado.liberado) !== 1) { destruir(c); c = null; }
                    } catch { destruir(c); c = null; }
                }
                if (c) c.release();
            }
        }
    };
    const bloquearProduto = async (c, id) => {
        const [[p]] = await c.execute('SELECT id,tipo,livro_id FROM ist_loja_produtos WHERE id=? FOR UPDATE', [id]);
        if (!p || p.tipo !== 'DIGITAL' || !produtoValido(p.livro_id)) falhar('PRODUTO_INDISPONIVEL');
        const [[l]] = await c.execute('SELECT format FROM ist_livros WHERE id=? LOCK IN SHARE MODE', [p.livro_id]);
        if (l?.format !== 'E-Book') falhar('PRODUTO_INDISPONIVEL');
    };
    const versoesBloqueadas = async (c, id) => {
        const [ids] = await c.execute('SELECT id FROM ist_loja_arquivo_versoes WHERE produto_id=? ORDER BY id', [id]);
        const rows = [];
        for (const r of ids) rows.push((await c.execute('SELECT * FROM ist_loja_arquivo_versoes WHERE id=? FOR UPDATE', [r.id]))[0][0]);
        return rows;
    };
    const mesmoConteudo = (row, arq) => String(row.tamanho_bytes) === arq.tamanho
        && Buffer.isBuffer(row.sha256) && row.sha256.equals(arq.sha) && row.mime === 'application/pdf';

    const registrarRascunho = async entrada => {
        campos(entrada, ['registroPublicId','produtoId','caminhoRelativo','arquivoLogicoId']);
        const { registroPublicId, produtoId, caminhoRelativo, arquivoLogicoId } = entrada;
        if (!uuid(registroPublicId) || !uuid(arquivoLogicoId) || !produtoValido(produtoId) || !relativoValido(caminhoRelativo)) falhar('ENTRADA_INVALIDA');
        const arq = await conferirArquivo(caminhoRelativo);
        const lerIdentidade = async (c, rows) => {
            const [[r]] = await c.execute('SELECT * FROM ist_loja_arquivo_versoes WHERE public_id=?', [registroPublicId]);
            if (!r) return null;
            if (r.produto_id !== produtoId || r.arquivo_logico_id !== arquivoLogicoId
                || r.caminho_relativo !== caminhoRelativo || !mesmoConteudo(r, arq)
                || !rows.some(v => v.id === r.id)) falhar('CONFLITO_IDEMPOTENCIA');
            return publico(r);
        };
        const conciliar = () => transacao(caminhoRelativo, arq, async c => {
            await bloquearProduto(c, produtoId);
            const r = await lerIdentidade(c, await versoesBloqueadas(c, produtoId));
            if (!r) falhar('RESULTADO_DESCONHECIDO');
            return r;
        });
        try {
            return await transacao(caminhoRelativo, arq, async c => {
                await bloquearProduto(c, produtoId);
                const rows = await versoesBloqueadas(c, produtoId);
                const repetido = await lerIdentidade(c, rows);
                if (repetido) return repetido;
                if (rows.some(r => r.estado === 'RASCUNHO')) falhar('ADMIN_RASCUNHO_EXISTENTE');
                if (rows.some(r => r.arquivo_logico_id !== arquivoLogicoId)) falhar('CONFLITO_IDENTIDADE_LOGICA');
                const [caminhos] = await c.execute('SELECT produto_id,tamanho_bytes,sha256,mime FROM ist_loja_arquivo_versoes WHERE LOWER(caminho_relativo)=LOWER(?)', [caminhoRelativo]);
                if (caminhos.some(r => r.produto_id === produtoId || !mesmoConteudo(r, arq))) falhar('CAMINHO_REUTILIZADO');
                const numero = rows.reduce((max,r) => Math.max(max, r.numero_versao), 0) + 1;
                if (!Number.isSafeInteger(numero) || numero > 4294967295) falhar('LIMITE_VERSOES');
                const data = instante();
                await c.execute(`INSERT INTO ist_loja_arquivo_versoes(public_id,produto_id,arquivo_logico_id,numero_versao,
                    caminho_relativo,tamanho_bytes,sha256,mime,criado_em) VALUES(?,?,?,?,?,?,?,'application/pdf',?)`,
                [registroPublicId,produtoId,arquivoLogicoId,numero,caminhoRelativo,arq.tamanho,arq.sha,data]);
                const [[r]] = await c.execute('SELECT * FROM ist_loja_arquivo_versoes WHERE public_id=?', [registroPublicId]);
                return publico(r);
            }, conciliar);
        } finally { await arq.fechar(); }
    };
    const publicar = async entrada => {
        campos(entrada, ['produtoId','versaoPublicId','publicacaoAtualEsperada']);
        const { produtoId, versaoPublicId, publicacaoAtualEsperada } = entrada;
        if (!produtoValido(produtoId) || !uuid(versaoPublicId)
            || (publicacaoAtualEsperada !== null && !uuid(publicacaoAtualEsperada))) falhar('ENTRADA_INVALIDA');
        let leitura;
        try {
            leitura = await db.getConnection();
            try { await leitura.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED'); }
            catch (e) { destruir(leitura); leitura = null; throw e; }
            const [[limpa]] = await leitura.query('SELECT @@in_transaction transacao,@@autocommit autocommit');
            if (Number(limpa.transacao) !== 0 || Number(limpa.autocommit) !== 1) {
                destruir(leitura); leitura = null; falhar('CONEXAO_INVALIDA');
            }
            const [[r]] = await leitura.execute('SELECT * FROM ist_loja_arquivo_versoes WHERE public_id=? AND produto_id=?', [versaoPublicId,produtoId]);
            if (!r) falhar('VERSAO_INEXISTENTE');
            entrada = { ...entrada, registrada: r };
        } catch (e) { if (e.codigo) throw e; falhar('ERRO_PERSISTENCIA'); }
        finally { leitura?.release(); }
        const registrada = entrada.registrada;
        if (!relativoValido(registrada.caminho_relativo)) falhar('ARQUIVO_INVALIDO');
        const arq = await conferirArquivo(registrada.caminho_relativo);
        const verificar = async c => {
            await bloquearProduto(c, produtoId);
            const rows = await versoesBloqueadas(c, produtoId);
            const r = rows.find(x => x.public_id === versaoPublicId);
            if (!r || r.caminho_relativo !== registrada.caminho_relativo || r.arquivo_logico_id !== registrada.arquivo_logico_id
                || r.numero_versao !== registrada.numero_versao || !mesmoConteudo(r, arq)) falhar('ARQUIVO_ALTERADO');
            return { r, atual: rows.find(x => x.publicacao_atual === 1) };
        };
        const conciliar = () => transacao(registrada.caminho_relativo, arq, async c => {
            const { r, atual } = await verificar(c);
            if (r.estado !== 'PUBLICADA' || atual?.id !== r.id) falhar('RESULTADO_DESCONHECIDO');
            return publico(r);
        });
        try {
            return await transacao(registrada.caminho_relativo, arq, async c => {
                const { r, atual } = await verificar(c);
                if (r.estado === 'PUBLICADA' && atual?.id === r.id) return publico(r);
                if (r.estado !== 'RASCUNHO' || (atual?.public_id ?? null) !== publicacaoAtualEsperada) falhar('CONFLITO_PUBLICACAO');
                const data = instante();
                if (atual) await c.execute("UPDATE ist_loja_arquivo_versoes SET estado='RETIRADA',publicacao_atual=NULL,retirado_em=? WHERE id=?", [data,atual.id]);
                await c.execute("UPDATE ist_loja_arquivo_versoes SET estado='PUBLICADA',publicacao_atual=1,publicado_em=? WHERE id=?", [data,r.id]);
                return publico({ ...r, estado: 'PUBLICADA' });
            }, conciliar);
        } finally { await arq.fechar(); }
    };
    return { registrarRascunho, publicar };
};
