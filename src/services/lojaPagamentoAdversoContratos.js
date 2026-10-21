// Projecoes de GETs oficiais. Nenhuma URL recebida e executada.
export const idAdverso = v => typeof v === 'string' && /^[A-Za-z0-9-]{1,128}$/.test(v);
export const centavosAdversos = v => typeof v === 'string' && /^(0|[1-9]\d{0,15})$/.test(v)
    && BigInt(v) <= 9007199254740991n;
const codigo = v => typeof v === 'string' && /^[A-Z_]{1,64}$/.test(v) ? v : null;
const dinheiro = m => {
    if (typeof m?.value !== 'string' || !/^(0|[1-9]\d{0,13})(\.\d{1,2})?$/.test(m.value)
        || !/^[A-Z]{3}$/.test(m.currency_code ?? '')) return { valorCentavos: null, moeda: null };
    const [n, f = ''] = m.value.split('.');
    const v = String(BigInt(n) * 100n + BigInt(f.padEnd(2, '0')));
    return centavosAdversos(v) ? { valorCentavos: v, moeda: m.currency_code } : { valorCentavos: null, moeda: null };
};
// Fonte: paypal/paypal-rest-api-specifications, customer_disputes_v1.json,
// transaction_info/seller e fund_movement. Nao ha ID economico em fund_movement.
export const projetarDetalhesDisputaPaypal = d => {
    const ts=d.disputed_transactions, t=Array.isArray(ts)&&ts.length===1?ts[0]:null;
    const merchant=t?.seller?.merchant_id;
    const movimentos=d.fund_movements;
    const listaValida=movimentos===undefined||(Array.isArray(movimentos)&&movimentos.length<=50);
    return {
        contaRecebedora: idAdverso(merchant)?merchant:null,
        identidadeRecebedorInvalida: merchant!==undefined&&!idAdverso(merchant),
        estadoTransacao:codigo(t?.transaction_status),
        estagio:codigo(d.dispute_life_cycle_stage),canal:codigo(d.dispute_channel),
        movimentosInvalidos:!listaValida,
        // Sem truncar uma lista excessiva nem gerar uma identidade por hash/valor/data.
        movimentos:listaValida?(movimentos??[]).map(m=>({
            parte:['SELLER','BUYER','PAYMENT_PROCESSOR'].includes(m?.party)?m.party:null,
            direcao:['DEBIT','CREDIT'].includes(m?.type)?m.type:null,
            motivo:['REVERSED_TRANSACTION_FEE','DISPUTE_SETTLEMENT','DISPUTE_FEE','CHARGEBACK_FEE'].includes(m?.reason)?m.reason:null,
            ...dinheiro(m?.amount),
            iniciadoEm:typeof m?.initiated_time==='string'&&m.initiated_time.length<=64
                && /^\d{4}-\d\d-\d\dT/.test(m.initiated_time)&&Number.isFinite(Date.parse(m.initiated_time))
                ?new Date(m.initiated_time).toISOString():null
        })):[],
        identidadeEconomica:'NAO_COMPROVADA'
    };
};
export const projetarRecursoAdversoPaypal = (tipo, d) => {
    if (!d || typeof d !== 'object' || Array.isArray(d)) throw Error('RECURSO_INVALIDO');
    const recursoId = tipo === 'DISPUTA' ? d.dispute_id : d.id;
    const r = { tipo, recursoId: idAdverso(recursoId) ? recursoId : null, estado: codigo(d.status),
        ...dinheiro(tipo === 'DISPUTA' ? d.dispute_amount : d.amount) };
    if (tipo === 'REEMBOLSO') {
        const ids = [], links = d.links;
        let vinculoInvalido = !Array.isArray(links) || links.length > 10;
        for (const l of (Array.isArray(links) ? links.slice(0, 10) : [])) if (l?.rel === 'up') {
            const m = l.method === 'GET' && typeof l.href === 'string'
                && /^https:\/\/(?:api-m\.sandbox\.paypal\.com|api\.sandbox\.paypal\.com)\/v2\/payments\/captures\/([A-Za-z0-9-]{1,128})$/.exec(l.href);
            if (!m) vinculoInvalido = true; else ids.push(m[1]);
        }
        const unicos = [...new Set(ids)];
        return { ...r, capturaId: !vinculoInvalido && unicos.length === 1 ? unicos[0] : null, vinculoInvalido };
    }
    if (tipo === 'DISPUTA') {
        const ts = d.disputed_transactions;
        const completas = Array.isArray(ts) && ts.length === 1 && idAdverso(ts[0]?.seller_transaction_id);
        return { ...r, ...projetarDetalhesDisputaPaypal(d), transacoesVendedor: completas ? [ts[0].seller_transaction_id] : [],
            vinculoInvalido: !completas, desfecho: codigo(d.dispute_outcome?.outcome_code) };
    }
    if (tipo === 'CAPTURA') return { ...r,
        ordemId: idAdverso(d.supplementary_data?.related_ids?.order_id) ? d.supplementary_data.related_ids.order_id : null,
        contaRecebedora: idAdverso(d.payee?.merchant_id) ? d.payee.merchant_id : null,
        motivo: codigo(d.status_details?.reason) };
    throw Error('TIPO_INVALIDO');
};

// Evidencia local independente do contrato de captura. Consumida tambem pela D6.
export const validarEvidenciaAdversa = (f, pg, contexto) => {
    if (!f || f.contrato !== 'IST_EVIDENCIA_ADVERSA_V1' || !idAdverso(f.eventoOrigem)
        || !/^[a-f0-9]{64}$/.test(f.hashOrigem ?? '') || !['REEMBOLSO','DISPUTA'].includes(f.tipo)
        || !idAdverso(f.recursoId) || f.capturaId !== pg.captura_externa_id
        || f.contexto?.provedor !== contexto.provedor || f.contexto.ambiente !== contexto.ambiente
        || f.contexto.contaRecebedora !== contexto.contaRecebedora
        || !['REEMBOLSO_CONFIRMADO','RISCO_DISPUTA','DISPUTA_ENCERRADA','CONTRADITORIA','INCOMPLETA'].includes(f.classificacao)) throw Error('EVIDENCIA_ADVERSA_INVALIDA');
    if (f.classificacao === 'REEMBOLSO_CONFIRMADO' && (f.tipo !== 'REEMBOLSO'
        || !centavosAdversos(f.valorCentavos) || BigInt(f.valorCentavos) <= 0n || f.moeda !== 'BRL')) throw Error('REEMBOLSO_INVALIDO');
    return f;
};
