import axios from 'axios';
import { criarPaypalProvider } from '../src/services/pagamentos/paypalProvider.js';
import { classificarFalhaPagamento, erroPagamentoPublico, uuidPagamento } from '../src/services/lojaPagamentoContratos.js';

// Apoio exclusivo dos scripts manuais. Nao altera o adaptador, nao inicia HTTP
// por conta propria e nao guarda o corpo bruto recebido pelo transporte.
export const contextoManual = (argv, captura = false) => {
    const flag = captura ? '--autorizar-captura-sandbox' : '--autorizar-consulta-sandbox';
    const nomes = ['--ordem', '--recebedor', '--referencia', ...(captura ? ['--request-id'] : [])];
    if (argv.length !== 1 + nomes.length * 2 || argv[0] !== flag) throw new Error();
    const opcoes = new Map();
    for (let i = 1; i < argv.length; i += 2) {
        if (!nomes.includes(argv[i]) || opcoes.has(argv[i])) throw new Error();
        opcoes.set(argv[i], argv[i + 1]);
    }
    const ordemId = opcoes.get('--ordem'), contaRecebedora = opcoes.get('--recebedor');
    if (!/^[A-Z0-9]{1,36}$/.test(ordemId ?? '') || !/^[2-9A-HJ-NP-Z]{13}$/.test(contaRecebedora ?? '')) throw new Error();
    return { ordemId, contaRecebedora, referencia: uuidPagamento(opcoes.get('--referencia')),
        ...(captura ? { requestId: uuidPagamento(opcoes.get('--request-id')) } : {}),
        ambiente: 'sandbox', valorCentavos: '100', moeda: 'BRL' };
};

const linkOficial = (links, ordemId) => {
    if (links === undefined) return { estado: 'AUSENTE', url: null };
    if (!Array.isArray(links)) return { estado: 'REJEITADO', url: null };
    const candidatos = links.filter(l => ['approve', 'payer-action'].includes(l?.rel));
    if (!candidatos.length) return { estado: 'AUSENTE', url: null };
    const urls = new Set();
    for (const l of candidatos) {
        try {
            if (l.method !== 'GET' || typeof l.href !== 'string' || l.href.length > 2048 || /[\s\x00-\x1f\x7f]/.test(l.href)) throw new Error();
            const u = new URL(l.href);
            if (u.protocol !== 'https:' || !['www.sandbox.paypal.com', 'sandbox.paypal.com'].includes(u.hostname)
                || u.port || u.username || u.password || u.hash || u.pathname !== '/checkoutnow'
                || u.searchParams.getAll('token').length !== 1 || u.searchParams.get('token') !== ordemId
                || [...u.searchParams.keys()].some(k => k !== 'token')) throw new Error();
            urls.add(l.href); // Texto original da API, nunca URL construida por suposicao.
        } catch { return { estado: 'REJEITADO', url: null }; }
    }
    return urls.size === 1 ? { estado: 'VALIDO', url: [...urls][0] } : { estado: 'REJEITADO', url: null };
};

export const prepararProviderManual = ({ contexto, env, http = axios.create(), captura = false }) => {
    const observacao = { estadoPayPal: null, link: { estado: 'AUSENTE', url: null } };
    let enviado = false;
    const host = 'https://api-m.sandbox.paypal.com';
    const caminho = `/v2/checkout/orders/${contexto.ordemId}`;
    const transporte = { async request(config) {
        const u = new URL(config.url);
        const oauth = config.method === 'POST' && u.pathname === '/v1/oauth2/token';
        const consulta = config.method === 'GET' && u.pathname === caminho;
        const capturar = captura && !enviado && config.method === 'POST' && u.pathname === `${caminho}/capture`;
        if (u.origin !== host || u.search || u.hash || u.username || u.password || (!oauth && !consulta && !capturar)) throw new Error();
        if (capturar) enviado = true; // No maximo um POST de captura por execucao.
        const resposta = await http.request(config);
        if (consulta) {
            observacao.estadoPayPal = null; observacao.link = { estado: 'AUSENTE', url: null };
            if (resposta.status === 200 && resposta.data?.id === contexto.ordemId) {
                if (['CREATED', 'SAVED', 'PAYER_ACTION_REQUIRED', 'APPROVED', 'COMPLETED', 'VOIDED'].includes(resposta.data.status)) {
                    observacao.estadoPayPal = resposta.data.status;
                }
                observacao.link = linkOficial(resposta.data.links, contexto.ordemId);
            }
        }
        return resposta;
    } };
    const provider = criarPaypalProvider({ env: {
        IST_LOJA_PAYPAL_ENV: env?.IST_LOJA_PAYPAL_ENV,
        IST_LOJA_PAYPAL_CLIENT_ID: env?.IST_LOJA_PAYPAL_CLIENT_ID,
        IST_LOJA_PAYPAL_CLIENT_SECRET: env?.IST_LOJA_PAYPAL_CLIENT_SECRET
    }, http: transporte });
    return { provider, observacao };
};
export const confereContexto = (r, c) => r.ordemId === c.ordemId && r.referencia === c.referencia
    && r.ambiente === 'sandbox' && r.contaRecebedora === c.contaRecebedora && r.valorCentavos === '100' && r.moeda === 'BRL';
export const resumoManual = r => ({ estado: r.estado, ordemId: r.ordemId, capturaId: r.capturaId,
    moeda: r.moeda, valorOperacaoCentavos: r.valorCentavos, capturadoEm: r.capturadoEm });
export const falhaManual = (erro, ordemId = null) => {
    const f = classificarFalhaPagamento(erro);
    return { estado: 'FALHA', codigo: erroPagamentoPublico(erro).erro.codigo, categoria: f.categoria, envio: f.envio,
        ordemId: f.resultado?.ordemId ?? ordemId, capturaId: f.resultado?.capturaId ?? null };
};
