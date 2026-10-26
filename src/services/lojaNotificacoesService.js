import {randomUUID} from 'node:crypto';
import {normalizarEmailComprador} from './lojaPedidoContratos.js';
import {erroPagamento,sqlUtcPagamento} from './lojaPagamentoContratos.js';

// Internal write only. Caller owns the financial transaction and already holds
// the order lock. No pool, SMTP, scheduler, retry, commit or historical backfill.
export const registrarConfirmacaoCompraNaConexao=async(c,pedido,instante)=>{
    if(!c?.query||!Number.isSafeInteger(pedido?.id)||pedido.id<1||pedido.id>4294967295
        ||pedido.estado!=='PAGO'||!pedido.pagamento_confirmado_em||!['sandbox','live'].includes(pedido.ambiente))
        throw erroPagamento('ERRO_INTERNO');
    try{
        if(normalizarEmailComprador(pedido.comprador_email)!==pedido.comprador_email)throw Error();
    }catch{throw erroPagamento('ERRO_INTERNO');}
    const data=sqlUtcPagamento(instante);
    const [[tx]]=await c.query('SELECT @@in_transaction AS em_transacao');
    if(Number(tx?.em_transacao)!==1)throw erroPagamento('ERRO_INTERNO');
    // Plain INSERT deliberately does not hide an unexpected UNIQUE collision.
    // Order lock + the single unpaid -> PAGO branch prevent duplicate producers;
    // UNIQUE(pedido_id,finalidade) is the final database barrier.
    const [r]=await c.query(`INSERT INTO ist_loja_notificacoes
        (public_id,pedido_id,finalidade,ambiente,destinatario,estado,tentativas,criado_em,atualizado_em,proxima_tentativa_em)
        VALUES (?,?,?,?,?,?,?,?,?,?)`,[randomUUID(),pedido.id,'CONFIRMACAO_COMPRA',pedido.ambiente,
        pedido.comprador_email,'PENDENTE',0,data,data,data]);
    if(!Number.isSafeInteger(Number(r.insertId))||Number(r.insertId)<1||r.affectedRows!==1||r.warningStatus)
        throw erroPagamento('ERRO_INTERNO');
};
