import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { criarPaypalProvider } from '../src/services/pagamentos/paypalProvider.js';
import { classificarFalhaPagamento, erroPagamentoPublico, uuidPagamento } from '../src/services/lojaPagamentoContratos.js';

// Preparacao 67.6-A. Nao executado ao importar e nao le arquivos .env.
// A execucao REAL abaixo exige autorizacao posterior e credenciais no processo:
// IST_LOJA_PAYPAL_ENV=sandbox, IST_LOJA_PAYPAL_CLIENT_ID, IST_LOJA_PAYPAL_CLIENT_SECRET.
// node scripts/loja-paypal-sandbox-manual.mjs --executar-sandbox --recebedor <MERCHANT_ID>
//   --referencia <UUID_V4> --request-id <UUID_V4>
// Valor fixo: BRL 1,00. OAuth e obtido internamente por provider.criar.
// Preservar referencia/request-id fora do script. Nao repetir uma criacao incerta
// automaticamente: nao ha persistencia local nem garantia de idempotencia eterna.
// Nao aprova, nao captura, nao abre servidor, nao utiliza banco ou SDK legado.
export const executarHomologacaoPaypal = async ({ argv = [], env = {}, http,
    saida = linha => process.stdout.write(`${linha}\n`) } = {}) => {
    let etapa = 'configuracao', referencia = null, requestId = null, ordemId = null;
    const emitir = dados => saida(JSON.stringify(dados));
    try {
        if (argv.length !== 7 || argv[0] !== '--executar-sandbox') throw new Error();
        const opcoes = new Map();
        for (let i = 1; i < argv.length; i += 2) {
            if (!['--recebedor', '--referencia', '--request-id'].includes(argv[i]) || opcoes.has(argv[i])) throw new Error();
            opcoes.set(argv[i], argv[i + 1]);
        }
        const recebedor = opcoes.get('--recebedor');
        if (typeof recebedor !== 'string' || !/^[2-9A-HJ-NP-Z]{13}$/.test(recebedor)) throw new Error();
        referencia = uuidPagamento(opcoes.get('--referencia'));
        requestId = uuidPagamento(opcoes.get('--request-id'));
        const provider = criarPaypalProvider({ env: {
            IST_LOJA_PAYPAL_ENV: env.IST_LOJA_PAYPAL_ENV,
            IST_LOJA_PAYPAL_CLIENT_ID: env.IST_LOJA_PAYPAL_CLIENT_ID,
            IST_LOJA_PAYPAL_CLIENT_SECRET: env.IST_LOJA_PAYPAL_CLIENT_SECRET
        }, ...(http ? { http } : {}) });
        const contexto = { ambiente: 'sandbox', contaRecebedora: recebedor,
            referencia, requestId, valorCentavos: '100', moeda: 'BRL', ordemId: null };
        emitir({ etapa, estado: 'VALIDA', referencia, requestId });
        etapa = 'criacao';
        const criado = await provider.criar(contexto);
        ordemId = criado.ordemId;
        emitir({ etapa, estado: criado.estado, ordemId, referencia, requestId });
        // Mesmo uma representacao minima pode fornecer ID suficiente para GET.
        if (!ordemId) return 1;
        etapa = 'consulta';
        const consultado = await provider.consultar({ ...contexto, ordemId });
        emitir({ etapa, estado: consultado.estado, ordemId: consultado.ordemId });
        // Um HTTP bem sucedido nao homologa dados ausentes ou divergentes.
        return consultado.estado === 'AGUARDANDO_APROVACAO' && consultado.ordemId === ordemId
            && consultado.referencia === referencia && consultado.contaRecebedora === recebedor
            && consultado.valorCentavos === '100' && consultado.moeda === 'BRL' ? 0 : 1;
    } catch (e) {
        const falha = classificarFalhaPagamento(e);
        emitir({ etapa, estado: 'FALHA', codigo: erroPagamentoPublico(e).erro.codigo,
            categoria: falha.categoria, envio: falha.envio,
            ordemId: falha.resultado?.ordemId ?? ordemId });
        return 1;
    }
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    process.exitCode = await executarHomologacaoPaypal({ argv: process.argv.slice(2), env: process.env });
}
