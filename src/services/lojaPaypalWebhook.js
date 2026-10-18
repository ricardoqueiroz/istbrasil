import { createHash } from 'node:crypto';
import { classificarFalhaPagamento } from './lojaPagamentoContratos.js';

const erro = (status, codigo) => Object.assign(new Error(codigo), { status, codigoWebhook: codigo });
export const criarProcessadorWebhookPayPal = ({ obterFinanceiro, obterWebhookId }) => async ({ corpo, cabecalhos }) => {
    const webhookId = obterWebhookId();
    if (typeof webhookId !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(webhookId)) throw erro(503, 'WEBHOOK_INDISPONIVEL');
    if (!Buffer.isBuffer(corpo) || corpo.length === 0 || corpo.length > 65536) throw erro(400, 'WEBHOOK_INVALIDO');
    const texto = corpo.toString('utf8');
    if (!Buffer.from(texto, 'utf8').equals(corpo)) throw erro(400, 'WEBHOOK_INVALIDO');
    let financeiro;
    try { financeiro = obterFinanceiro(); } catch { throw erro(503, 'WEBHOOK_INDISPONIVEL'); }
    let valida;
    try { valida = await financeiro.adaptador.verificarWebhook({ corpo: texto, cabecalhos, webhookId }); }
    catch (e) {
        throw erro(classificarFalhaPagamento(e).categoria === 'VALIDACAO_LOCAL' ? 400 : 503, 'WEBHOOK_VERIFICACAO_INDISPONIVEL');
    }
    if (valida !== true) throw erro(401, 'WEBHOOK_ASSINATURA_INVALIDA');
    let evento;
    try { evento = JSON.parse(texto); } catch { throw erro(400, 'WEBHOOK_INVALIDO'); }
    if (!evento || typeof evento.id !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(evento.id)
        || typeof evento.event_type !== 'string' || !/^[A-Z0-9_.]{1,128}$/.test(evento.event_type)) throw erro(400, 'WEBHOOK_INVALIDO');
    if (!['PAYMENT.CAPTURE.COMPLETED', 'PAYMENT.CAPTURE.PENDING', 'PAYMENT.CAPTURE.DENIED'].includes(evento.event_type)) return;
    const capturaId = evento.resource?.id ?? null;
    const ordemId = evento.resource?.supplementary_data?.related_ids?.order_id ?? null;
    if (!/^[A-Z0-9]{1,36}$/.test(capturaId ?? '') || (ordemId !== null && !/^[A-Z0-9]{1,36}$/.test(ordemId))) throw erro(400, 'WEBHOOK_INVALIDO');
    try {
        await financeiro.service.reconciliarWebhook({ eventoId: evento.id, tipo: evento.event_type, ordemId, capturaId,
            hash: createHash('sha256').update(corpo).digest() });
    } catch { throw erro(503, 'WEBHOOK_PROCESSAMENTO_PENDENTE'); }
};
