import {normalizarEmailComprador} from './lojaPedidoContratos.js';

export const comporConfirmacaoCompra=n=>{
    if(n.ambiente!=='sandbox'||n.finalidade!=='CONFIRMACAO_COMPRA'
        ||typeof n.pedido_public_id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(n.pedido_public_id)
        ||normalizarEmailComprador(n.destinatario)!==n.destinatario)throw Error('NOTIFICACAO_INVALIDA');
    return {to:n.destinatario,subject:`Homologação — confirmação do pedido ${n.pedido_public_id}`,
        text:`Homologação — PayPal Sandbox — sem cobrança real\n\nPagamento de teste confirmado para o pedido ${n.pedido_public_id}.\nAcesse sua biblioteca digital autenticada:\nhttps://istbrasil.org.br/loja/biblioteca\n\nO acesso exige uma sessão autorizada. Se necessário, utilize a recuperação de acesso na biblioteca. A disponibilidade dos arquivos depende dos seus direitos atuais.`};
};
