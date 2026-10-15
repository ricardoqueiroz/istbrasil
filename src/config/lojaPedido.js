import { CONTRATO_PEDIDO, criarErroPedido } from '../services/lojaPedidoContratos.js';

// Configuracao confiavel do processo, nunca do corpo, URL ou cabecalhos HTTP.
export const carregarConfiguracaoLojaPedido = (env = process.env) => {
    const ambiente = env.LOJA_AMBIENTE ?? CONTRATO_PEDIDO.ambienteInicial;
    if (!['sandbox', 'live'].includes(ambiente)) throw criarErroPedido('ERRO_INTERNO');
    return Object.freeze({ ambiente });
};
