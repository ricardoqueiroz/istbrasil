import axios from 'axios';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { criarPaypalProvider } from '../src/services/pagamentos/paypalProvider.js';
import { falhaManual } from './loja-paypal-ordem-manual-contexto.mjs';

// Sem execucao ao importar. Nao usa referencia/chave de captura para enviar POST.
export const reconciliarCapturaManual = async ({ argv = [], env = {}, http = axios.create(),
    saida = linha => process.stdout.write(`${linha}\n`) } = {}) => {
    let capturaId = null, ordemId = null;
    const emitir = v => saida(JSON.stringify(v));
    try {
        if (argv.length !== 5 || argv[0] !== '--autorizar-consulta-sandbox') throw new Error();
        const opcoes = new Map();
        for (let i = 1; i < argv.length; i += 2) {
            if (!['--captura', '--ordem'].includes(argv[i]) || opcoes.has(argv[i])) throw new Error();
            opcoes.set(argv[i], argv[i + 1]);
        }
        const captura = opcoes.get('--captura'), ordem = opcoes.get('--ordem');
        if (typeof captura !== 'string' || !/^[A-Z0-9]{1,36}$/.test(captura)
            || typeof ordem !== 'string' || !/^[A-Z0-9]{1,36}$/.test(ordem)) throw new Error();
        capturaId = captura; ordemId = ordem;
        // Lista fechada: apenas OAuth e GET deste recurso; nem GET da ordem e necessario.
        const transporte = { request(config) {
            const u = new URL(config.url);
            if (u.origin !== 'https://api-m.sandbox.paypal.com' || u.username || u.password || u.search || u.hash
                || !((config.method === 'POST' && u.pathname === '/v1/oauth2/token')
                    || (config.method === 'GET' && u.pathname === `/v2/payments/captures/${capturaId}`))) throw new Error();
            return http.request(config);
        } };
        const provider = criarPaypalProvider({ env: {
            IST_LOJA_PAYPAL_ENV: env?.IST_LOJA_PAYPAL_ENV,
            IST_LOJA_PAYPAL_CLIENT_ID: env?.IST_LOJA_PAYPAL_CLIENT_ID,
            IST_LOJA_PAYPAL_CLIENT_SECRET: env?.IST_LOJA_PAYPAL_CLIENT_SECRET
        }, http: transporte });
        const r = await provider.consultarCaptura({ capturaId, ambiente: 'sandbox' });
        if (!r.recursoDisponivel) {
            emitir({ estadoConsulta: 'INDISPONIVEL', capturaConsultadaId: capturaId, statusFinanceiro: 'DESCONHECIDO' }); return 1;
        }
        const associacaoOrdem = r.associacaoInvalida ? 'INVALIDA'
            : !r.ordensRelacionadas.length ? 'NAO_DEMONSTRADA'
                : r.ordensRelacionadas.every(id => id === ordemId) ? 'CONFIRMADA' : 'DIVERGENTE';
        const divergente = (r.capturaId !== null && r.capturaId !== capturaId)
            || (r.moeda !== null && r.moeda !== 'BRL') || (r.valorCentavos !== null && r.valorCentavos !== '100')
            || associacaoOrdem === 'DIVERGENTE';
        const completo = !r.respostaInvalida && r.capturaId === capturaId && r.moeda === 'BRL'
            && r.valorCentavos === '100' && r.statusFinanceiro !== 'DESCONHECIDO' && associacaoOrdem === 'CONFIRMADA';
        emitir({ estadoConsulta: 'CONSULTADA', capturaConsultadaId: capturaId, capturaId: r.capturaId,
            statusFinanceiro: r.statusFinanceiro, moeda: r.moeda, valorOperacaoCentavos: r.valorCentavos,
            criadoEm: r.criadoEm, atualizadoEm: r.atualizadoEm,
            // Timestamps do recurso: nao presumir horario exato da liquidacao.
            horarioReferenciaUTC: r.statusFinanceiro === 'COMPLETED' ? r.atualizadoEm ?? r.criadoEm : null,
            fonteHorario: r.statusFinanceiro !== 'COMPLETED' ? null : r.atualizadoEm ? 'update_time' : r.criadoEm ? 'create_time' : null,
            ordemEsperadaId: ordemId, ordensRelacionadas: r.ordensRelacionadas, associacaoOrdem,
            motivosAssociacaoInvalida: r.motivosAssociacaoInvalida,
            diagnosticosLinksUp: r.diagnosticosLinksUp,
            motivoPendencia: r.motivoPendencia, estadoMotivoPendencia: r.estadoMotivoPendencia,
            limitacaoAssociacao: associacaoOrdem === 'NAO_DEMONSTRADA' ? 'API_NAO_INFORMOU_ORDEM_RELACIONADA' : null,
            validacao: divergente ? 'DIVERGENTE' : completo ? 'CONSISTENTE' : 'INCONCLUSIVA' });
        return completo ? 0 : 1;
    } catch (e) { emitir({ ...falhaManual(e, ordemId), capturaConsultadaId: capturaId, operacao: 'CONSULTA' }); return 1; }
};
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    process.exitCode = await reconciliarCapturaManual({ argv: process.argv.slice(2), env: process.env });
}
