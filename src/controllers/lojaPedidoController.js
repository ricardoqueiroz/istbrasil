import { carregarConfiguracaoLojaPedido } from '../config/lojaPedido.js';
import { criarLojaPedidoService } from '../services/lojaPedidoService.js';
import { validarSolicitacaoPedido, criarErroPedido } from '../services/lojaPedidoContratos.js';

export const criarLojaPedidoController = ({ service, obterConfiguracao = carregarConfiguracaoLojaPedido } = {}) =>
    async (req, res) => {
        const solicitacao = validarSolicitacaoPedido(req.body);
        const config = obterConfiguracao();
        if (!['sandbox', 'live'].includes(config?.ambiente)) throw criarErroPedido('ERRO_INTERNO');
        const pedidos = service ?? criarLojaPedidoService({ ambiente: config.ambiente });
        const resultado = await pedidos.criarPedidoComResultado(res.locals.sessaoLoja, solicitacao, res.locals.chaveIdempotenciaLoja);
        if (typeof resultado?.criado !== 'boolean' || !resultado.pedido) throw criarErroPedido('ERRO_INTERNO');
        res.set('Cache-Control', 'no-store');
        res.status(resultado.criado ? 201 : 200).json(resultado.pedido);
    };
