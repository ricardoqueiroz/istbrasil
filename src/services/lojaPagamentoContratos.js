import { createHash } from 'node:crypto';
import { validarChaveIdempotencia } from './lojaPedidoContratos.js';

const definicoes = {
    SOLICITACAO_INVALIDA: [400, 'Solicitação de pagamento inválida.'],
    SESSAO_INVALIDA: [401, 'Sessão de compra inválida ou expirada.'],
    PEDIDO_NAO_ENCONTRADO: [404, 'Pedido ou pagamento não encontrado.'],
    PEDIDO_INDISPONIVEL: [409, 'Pedido indisponível para pagamento.'],
    PEDIDO_EXPIRADO: [409, 'O prazo do pedido expirou.'],
    CONFLITO_IDEMPOTENCIA: [409, 'Chave de idempotência utilizada com outro conteúdo.'],
    TENTATIVA_ATIVA: [409, 'Já existe uma tentativa ativa ou uma situação financeira pendente.'],
    APROVACAO_PENDENTE: [409, 'A aprovação do pagamento ainda não foi confirmada.'],
    OPERACAO_EM_ANDAMENTO: [409, 'Operação em andamento. Aguarde e consulte novamente.'],
    RESULTADO_DESCONHECIDO: [503, 'Resultado financeiro ainda não confirmado. Preserve a tentativa para reconciliação.'],
    CONFIGURACAO_INVALIDA: [500, 'Configuração de pagamentos indisponível.'],
    ERRO_INTERNO: [500, 'Não foi possível processar o pagamento.']
};
export const erroPagamento = codigo => {
    const seguro = Object.hasOwn(definicoes, codigo) ? codigo : 'ERRO_INTERNO';
    return Object.assign(new Error(definicoes[seguro][1]), { codigo: seguro, status: definicoes[seguro][0] });
};
export const erroPagamentoPublico = erro => {
    const seguro = erroPagamento(erro?.codigo);
    return { erro: { codigo: seguro.codigo, mensagem: seguro.message } };
};
export const uuidPagamento = valor => {
    try { return validarChaveIdempotencia(valor); }
    catch { throw erroPagamento('SOLICITACAO_INVALIDA'); }
};
export const camposExatos = (entrada, nomes) => {
    if (!entrada || Object.getPrototypeOf(entrada) !== Object.prototype
        || Reflect.ownKeys(entrada).length !== nomes.length || nomes.some(n => {
            const d = Object.getOwnPropertyDescriptor(entrada, n);
            return !d?.enumerable || !Object.hasOwn(d, 'value');
        })) throw erroPagamento('SOLICITACAO_INVALIDA');
    return Object.fromEntries(nomes.map(n => [n, uuidPagamento(entrada[n])]));
};
export const hashPagamento = entrada => createHash('sha256').update(JSON.stringify(entrada), 'utf8').digest();
export const idExterno = valor => typeof valor === 'string' && /^[\x21-\x7e]{1,128}$/.test(valor);
export const centavosPagamento = valor => {
    if (typeof valor === 'number' && Number.isSafeInteger(valor)) valor = String(valor);
    if (typeof valor !== 'string' || !/^(0|[1-9]\d{0,19})$/.test(valor) || BigInt(valor) > 18446744073709551615n) {
        throw erroPagamento('ERRO_INTERNO');
    }
    return valor;
};
export const instantePagamento = valor => {
    if (typeof valor !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(valor)
        || !Number.isFinite(Date.parse(valor)) || new Date(valor).toISOString() !== valor
        || valor.slice(0, 4) < '1000') throw erroPagamento('ERRO_INTERNO');
    return valor;
};
export const sqlUtcPagamento = iso => instantePagamento(iso).slice(0, 23).replace('T', ' ');

// Reembolsos/estornos constam do vocabulario; nenhuma operacao os aplica nesta etapa.
export const TRANSICOES_PAGAMENTO = Object.freeze(Object.fromEntries(Object.entries({
    CRIANDO: ['AGUARDANDO_APROVACAO', 'APROVADO', 'RECUSADO', 'DESCONHECIDO', 'REVISAO'],
    AGUARDANDO_APROVACAO: ['APROVADO', 'CANCELADO', 'EXPIRADO', 'DESCONHECIDO', 'REVISAO'],
    APROVADO: ['CAPTURANDO', 'CANCELADO', 'EXPIRADO', 'DESCONHECIDO', 'REVISAO'],
    CAPTURANDO: ['CAPTURADO', 'PENDENTE', 'RECUSADO', 'DESCONHECIDO', 'REVISAO'],
    PENDENTE: ['CAPTURADO', 'RECUSADO', 'DESCONHECIDO', 'REVISAO'],
    DESCONHECIDO: ['AGUARDANDO_APROVACAO', 'APROVADO', 'CAPTURADO', 'PENDENTE', 'RECUSADO', 'CANCELADO', 'EXPIRADO', 'REVISAO'],
    CAPTURADO: ['PARCIALMENTE_REEMBOLSADO', 'REEMBOLSADO', 'ESTORNADO', 'REVISAO'],
    PARCIALMENTE_REEMBOLSADO: ['REEMBOLSADO', 'ESTORNADO', 'REVISAO'],
    RECUSADO: ['REVISAO'], CANCELADO: ['REVISAO'], EXPIRADO: ['REVISAO'],
    REEMBOLSADO: ['REVISAO'], ESTORNADO: ['REVISAO'], REVISAO: []
}).map(([k, v]) => [k, Object.freeze(v)])));
export const validarTransicaoPagamento = (de, para) => {
    if (!Object.hasOwn(TRANSICOES_PAGAMENTO, de) || (de !== para && !TRANSICOES_PAGAMENTO[de].includes(para))) {
        throw erroPagamento('ERRO_INTERNO');
    }
};

/** Interface minima de adaptadores (somente contexto confiavel do servidor):
 * criar({ referencia, requestId, valorCentavos:string, moeda, ambiente, contaRecebedora, signal })
 * consultar({ referencia, ordemId, requestIdCriacao, requestIdCaptura, ...contexto, signal })
 * capturar({ referencia, ordemId, requestId, ...contexto, signal })
 * Resposta normalizada e permitida abaixo; nenhum payload bruto e persistido.
 * RECUSADO/CANCELADO/EXPIRADO devem ser definitivos, sem captura em andamento.
 * Ausencia ou consulta ambigua retorna DESCONHECIDO, nunca prova ausencia de efeito.
 */
export const normalizarResultadoPagamento = r => {
    const estados = ['AGUARDANDO_APROVACAO', 'APROVADO', 'CAPTURADO', 'RECUSADO', 'PENDENTE', 'CANCELADO', 'EXPIRADO', 'DESCONHECIDO'];
    if (!r || !estados.includes(r.estado) || !idExterno(r.referencia)
        || !idExterno(r.contaRecebedora) || !['sandbox', 'live'].includes(r.ambiente)
        || typeof r.moeda !== 'string' || !/^[A-Z]{3}$/.test(r.moeda)
        || (r.ordemId !== null && !idExterno(r.ordemId))
        || (r.capturaId !== null && !idExterno(r.capturaId))
        || (r.estado !== 'DESCONHECIDO' && !r.ordemId)
        || (r.estado === 'CAPTURADO' && (!r.capturaId || !r.capturadoEm))) throw erroPagamento('ERRO_INTERNO');
    return { estado: r.estado, referencia: r.referencia, ordemId: r.ordemId, capturaId: r.capturaId,
        valorCentavos: centavosPagamento(r.valorCentavos), moeda: r.moeda,
        contaRecebedora: r.contaRecebedora, ambiente: r.ambiente,
        capturadoEm: r.capturadoEm === null ? null : instantePagamento(r.capturadoEm) };
};
export const pagamentoPublico = (p, pedido) => ({
    publicId: p.public_id, pedidoPublicId: pedido.public_id, estado: p.estado, pedidoEstado: pedido.estado,
    moeda: p.moeda, valorCentavos: Number(centavosPagamento(p.valor_centavos)), versao: p.versao,
    criadoEm: p.criado_em, expiraEm: p.expira_em,
    pagamentoConfirmadoEm: pedido.pagamento_confirmado_em
});
