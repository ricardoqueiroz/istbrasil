import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const codigoSeguro = valor => typeof valor === 'string' && /^[A-Z0-9_]{1,64}$/.test(valor) ? valor : 'FALHA_INTERNA';

const carregarPadrao = async () => {
    const [{ pool }, { comporFinanceiroLoja }] = await Promise.all([
        import('../src/config/db.js'), import('../src/services/lojaPagamentoAgendador.js')
    ]);
    return { pool, comporFinanceiroLoja };
};

// Importar este modulo nao abre banco, nao cria provider e nao executa recuperacao.
export const executarRecuperacaoCapturaIsolada = async ({ argv = [], env = {}, carregar = carregarPadrao,
    saida = linha => process.stdout.write(`${linha}\n`) } = {}) => {
    let pedidoPublicId = null, pool;
    const emitir = valor => saida(JSON.stringify(valor));
    try {
        if (argv.length !== 3 || argv[0] !== '--autorizar-recuperacao-sandbox' || argv[1] !== '--pedido'
            || !uuid.test(argv[2] ?? '')) throw Object.assign(new Error(), { codigo: 'SOLICITACAO_INVALIDA' });
        pedidoPublicId = argv[2];
        if (env.NODE_ENV !== 'production' || env.DB_HOST !== '127.0.0.1' || env.DB_PORT !== '3307'
            || env.DB_NAME !== 'istbrasil_homolog' || env.LOJA_AMBIENTE !== 'sandbox'
            || env.IST_LOJA_PAYPAL_ENV !== 'sandbox' || env.IST_LOJA_RECUPERACAO_ATIVA !== 'false'
            || !env.IST_LOJA_PAYPAL_CLIENT_ID || !env.IST_LOJA_PAYPAL_CLIENT_SECRET
            || !/^[2-9A-HJ-NP-Z]{13}$/.test(env.IST_LOJA_PAYPAL_CONTA_RECEBEDORA ?? '')) {
            throw Object.assign(new Error(), { codigo: 'CONFIGURACAO_INVALIDA' });
        }
        const dependencias = await carregar();
        pool = dependencias?.pool;
        if (!pool?.getConnection || typeof dependencias?.comporFinanceiroLoja !== 'function') {
            throw Object.assign(new Error(), { codigo: 'CONFIGURACAO_INVALIDA' });
        }
        const { service } = dependencias.comporFinanceiroLoja({ db: pool, env });
        const resultados = await service.recuperarPendencias({ limite: 1, pedidoPublicId });
        const primeiro = resultados[0];
        const estado = resultados.length === 0 ? 'NAO_SELECIONADO'
            : primeiro?.erro ? 'ERRO'
                : primeiro?.resultado?.intervencao ? 'INTERVENCAO'
                    : primeiro?.resultado?.ignorada ? 'IGNORADA'
                        : primeiro?.resultado?.estado ?? 'INCONCLUSIVO';
        emitir({ pedidoPublicId, selecionados: resultados.length, estado,
            codigo: primeiro?.erro ? codigoSeguro(primeiro.erro) : null,
            intervencao: primeiro?.resultado?.intervencao ? codigoSeguro(primeiro.resultado.intervencao) : null });
        return resultados.length === 1 && estado === 'CAPTURADO' ? 0 : 2;
    } catch (erro) {
        emitir({ pedidoPublicId, selecionados: 0, estado: 'FALHA', codigo: codigoSeguro(erro?.codigo) });
        return 1;
    } finally {
        if (pool?.end) { try { await pool.end(); } catch { /* Pool exclusivo do processo pontual. */ } }
    }
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    process.exitCode = await executarRecuperacaoCapturaIsolada({ argv: process.argv.slice(2), env: process.env });
}
