import {createHash} from 'node:crypto';
import {idAdverso,projetarRecursoAdversoPaypal} from './lojaPagamentoAdversoContratos.js';

export const fontesDescoberta=Object.freeze(['NOTIFICACOES','DISPUTAS','TRANSACOES']);
export const erroDescoberta=codigo=>Object.assign(new Error('Descoberta financeira indisponivel.'),{codigo});
export const isoDescoberta=v=>typeof v==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/.test(v)
    &&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().startsWith(v.slice(0,19))?new Date(v).toISOString():null;
const idRelatorio=v=>typeof v==='string'&&/^[A-Za-z0-9_]{1,24}$/.test(v)?v:null;
const referenciaRelatorio=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,24}$/.test(v)?v:null;
const sha=v=>createHash('sha256').update(v).digest('hex');

// Origem API, nao e evento WEBHOOK nem assinatura/verificacao de corpo original.
export const observarRecursoPaypal=(fonte,raw)=>{
    let recurso=null,tipoRecurso=null,notificacaoId=null,relatorio=null;
    if(fonte==='NOTIFICACOES'){
        if(!idAdverso(raw?.id)||typeof raw.event_type!=='string')throw erroDescoberta('D9_DESCOBERTA_CONTRATO');
        notificacaoId=raw.id;
        if(raw.event_type==='PAYMENT.CAPTURE.REFUNDED'&&raw.resource_type==='refund'&&raw.resource_version==='2.0')tipoRecurso='REEMBOLSO';
        else if(['CUSTOMER.DISPUTE.CREATED','CUSTOMER.DISPUTE.UPDATED','CUSTOMER.DISPUTE.RESOLVED'].includes(raw.event_type))tipoRecurso='DISPUTA';
        else if(!['PAYMENT.CAPTURE.REVERSED','PAYMENT.CAPTURE.REFUNDED'].includes(raw.event_type))return null;
        if(tipoRecurso)recurso=projetarRecursoAdversoPaypal(tipoRecurso,raw.resource);
        else relatorio={notificacaoTipo:raw.event_type};
    }else if(fonte==='DISPUTAS'){
        tipoRecurso='DISPUTA';recurso=projetarRecursoAdversoPaypal('DISPUTA',raw);
    }else if(fonte==='TRANSACOES'){
        const r=raw?.transaction_info;
        if(!r||!idRelatorio(r.transaction_id))throw erroDescoberta('D9_DESCOBERTA_CONTRATO');
        if(!['T1106','T1107','T1110','T1111','T1201'].includes(r.transaction_event_code)&&r.transaction_status!=='V')return null;
        // Nenhuma identidade economica e deduzida de T-code, valor ou data.
        relatorio={transacaoId:idRelatorio(r.transaction_id),referenciaId:referenciaRelatorio(r.paypal_reference_id),
            referenciaTipo:['ODR','TXN','SUB','PAP'].includes(r.paypal_reference_id_type)?r.paypal_reference_id_type:null,
            tipoMovimento:/^T\d{4}$/.test(r.transaction_event_code??'')?r.transaction_event_code:null,
            estado:['D','P','S','V'].includes(r.transaction_status)?r.transaction_status:null,iniciadoEm:isoDescoberta(r.transaction_initiation_date),
            atualizadoEm:isoDescoberta(r.transaction_updated_date),
            valor:typeof r.transaction_amount?.value==='string'&&/^-?(0|[1-9]\d{0,13})(\.\d{1,2})?$/.test(r.transaction_amount.value)?r.transaction_amount.value:null,
            moeda:/^[A-Z]{3}$/.test(r.transaction_amount?.currency_code??'')?r.transaction_amount.currency_code:null};
    }else throw erroDescoberta('D9_DESCOBERTA_FONTE');
    if(tipoRecurso&&!recurso?.recursoId)throw erroDescoberta('D9_DESCOBERTA_CONTRATO');
    const observacao={contrato:'PAYPAL_OBSERVACAO_API_V1',fonte,notificacaoId,tipoRecurso,recurso,relatorio,
        atualizadoEm:isoDescoberta(raw?.update_time),identidadeEconomica:'NAO_COMPROVADA'};
    // Identidade DA OBSERVACAO, nunca usada como identidade de debito/reembolso.
    const json=JSON.stringify(observacao);
    if(Buffer.byteLength(json)>12000)throw erroDescoberta('D9_DESCOBERTA_LIMITE');
    return {...observacao,observacaoId:`D9-OBS-${sha(json)}`};
};
