import { createHash } from 'node:crypto';
import { projetarDetalhesDisputaPaypal } from './lojaPagamentoAdversoContratos.js';

// Contratos e limitacoes: docs/loja-paypal-eventos-d8-b1.md.
const id = v => typeof v === 'string' && /^[A-Za-z0-9-]{1,128}$/.test(v) ? v : null;
const codigo = v => typeof v === 'string' && /^[A-Z0-9_]{1,64}$/.test(v) ? v : null;
const instante = v => typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(v)
    && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null;
const montante = m => {
    if (!m || typeof m.value !== 'string' || !/^(0|[1-9]\d{0,13})\.\d{2}$/.test(m.value)
        || !/^[A-Z]{3}$/.test(m.currency_code ?? '')) return { valorCentavos: null, moeda: null };
    const n = BigInt(m.value.replace('.', ''));
    return n <= 9007199254740991n ? { valorCentavos: String(n), moeda: m.currency_code }
        : { valorCentavos: null, moeda: null };
};

// Projecao permitida da evidencia original; nunca armazena payer, emails, notas,
// enderecos ou URLs arbitrarias. Hash cobre TODOS os bytes autenticados.
export const normalizarEventoAdversoPaypal = (evento, corpo) => {
    const r = evento.resource ?? {};
    const tipo = evento.event_type;
    const refund = tipo === 'PAYMENT.CAPTURE.REFUNDED' && evento.resource_type === 'refund'
        && evento.resource_version === '2.0';
    const disputa = ['CUSTOMER.DISPUTE.CREATED', 'CUSTOMER.DISPUTE.UPDATED', 'CUSTOMER.DISPUTE.RESOLVED'].includes(tipo);
    const reversao = tipo === 'PAYMENT.CAPTURE.REVERSED';
    const reembolsoId = refund ? id(r.id) : null;
    const disputaId = disputa ? id(r.dispute_id) : null;
    const capturasPorAmbiente = { sandbox: [], live: [] };
    let vinculoInvalido = Array.isArray(r.links) && r.links.length > 10;
    if (refund && Array.isArray(r.links)) for (const l of r.links.slice(0, 10)) {
        if (l?.rel !== 'up' || l.method !== 'GET' || typeof l.href !== 'string') continue;
        // Extracao apenas; jamais requisitar o link. Host/path exatos, sem query,
        // credenciais, fragmentos, portas ou normalizacao de traversal.
        const m = /^https:\/\/(api-m\.sandbox\.paypal\.com|api-m\.paypal\.com)\/v2\/payments\/captures\/([A-Za-z0-9-]{1,128})$/.exec(l.href);
        if (m) capturasPorAmbiente[m[1].includes('sandbox') ? 'sandbox' : 'live'].push(m[2]);
        else vinculoInvalido = true;
    }
    const transacoes = disputa && Array.isArray(r.disputed_transactions)
        ? r.disputed_transactions.slice(0, 50).map(t => id(t?.seller_transaction_id)).filter(Boolean) : [];
    return {
        contrato: 'PAYPAL_EVENTO_POS_CAPTURA_V1', eventoId: evento.id, tipo,
        recursoId: reembolsoId ?? disputaId, reembolsoId, disputaId,
        capturasPorAmbiente, vinculoInvalido, transacoesVendedor: [...new Set(transacoes)],
        transacoesExcedemLimite: disputa && Array.isArray(r.disputed_transactions) && r.disputed_transactions.length > 50,
        capturaId: null, correlacao: 'NAO_CORRELACIONADO', efeitoFinanceiroAplicado: false,
        classificacao: refund ? 'REEMBOLSO_NOTIFICADO' : disputa ? (tipo.endsWith('RESOLVED') ? 'DISPUTA_RESOLVIDA_NOTIFICADA' : 'RISCO_DISPUTA')
            : reversao ? 'REVERSAO_NOTIFICADA_SEM_EXTRATOR'
                : tipo === 'PAYMENT.CAPTURE.REFUNDED' ? 'REEMBOLSO_CONTRATO_NAO_SUPORTADO' : 'DESCONHECIDO',
        ...montante(refund ? r.amount : disputa ? r.dispute_amount : null),
        estadoRecurso: refund || disputa ? codigo(r.status) : null,
        desfechoDisputa: disputa ? codigo(r.dispute_outcome?.outcome_code) : null,
        ...(disputa?{detalhesDisputa:projetarDetalhesDisputaPaypal(r)}:{}),
        ocorridoEm: instante(evento.create_time),
        evidenciaOriginal: { resource_type: ['refund','dispute','capture'].includes(evento.resource_type) ? evento.resource_type : null,
            resource_version: /^\d{1,2}\.\d{1,2}$/.test(evento.resource_version ?? '') ? evento.resource_version : null,
            update_time: refund || disputa ? instante(r.update_time) : null },
        hash: createHash('sha256').update(corpo).digest()
    };
};
