export interface LojaCategoria {
    readonly id: number;
    readonly nome: string | null;
    readonly slug: string;
    readonly categoriaPaiId: number | null;
    readonly ordem: number;
}

export type LojaTipoProduto = 'DIGITAL' | 'MERCADORIA' | 'SERVICO';
export const tipoProduto = (tipo: LojaTipoProduto): string => ({ DIGITAL: 'Digital', MERCADORIA: 'Mercadoria', SERVICO: 'Serviço' })[tipo];

export interface LojaProduto {
    readonly tipo: LojaTipoProduto;
    readonly livroId: number | null;
    readonly formatoEditorial: string | null;
    readonly id: number;
    readonly sku: string;
    readonly titulo: string | null;
    readonly descricao: string | null;
    readonly categoria: LojaCategoria;
    readonly idioma: string | null;
    readonly imagemUrl: string | null;
    /** Valor oficial da API, em centavos inteiros. */
    readonly precoCentavos: number;
    readonly moeda: 'BRL';
    readonly disponivel: boolean;
    readonly quantidadeMaxima: 1;
}

// O backend atual usa a mesma projecao publica na listagem e nos detalhes.
export type LojaProdutoDetalhe = LojaProduto;

export interface LojaItemCotacao {
    readonly produtoId: number;
    readonly quantidade: 1;
}

export interface LojaItemCotado extends LojaItemCotacao {
    readonly produto: LojaProduto;
    readonly precoUnitarioCentavos: number;
    readonly subtotalCentavos: number;
}

export interface LojaCotacao {
    readonly itens: readonly LojaItemCotado[];
    readonly moeda: 'BRL';
    readonly totalCentavos: number;
    readonly geradaEm: string;
}

export interface LojaErroApi {
    readonly erro: {
        readonly codigo: string;
        readonly mensagem: string;
    };
}

export interface CarrinhoErro {
    readonly status: number;
    readonly codigo: string;
    readonly mensagem: string;
}

export interface CarrinhoInconsistencia {
    readonly produtoId: number;
    readonly codigo: 'DISPONIBILIDADE_NAO_CONFIRMADA';
    readonly mensagem: string;
}

export interface LojaSessao {
    readonly sessao: { readonly expiraEm: string };
}

export interface LojaSolicitacaoPedido {
    readonly produtoIds: readonly number[];
    readonly compradorEmail: string;
}

export interface LojaPedidoItem {
    readonly produtoId: number;
    readonly sku: string;
    readonly titulo: string;
    readonly tipo: string;
    readonly quantidade: 1;
    readonly precoUnitarioCentavos: number;
    readonly subtotalCentavos: number;
}

export interface LojaPedido {
    readonly publicId: string;
    readonly estado: 'CRIADO' | 'AGUARDANDO_PAGAMENTO' | 'PAGO' | 'CANCELADO' | 'EXPIRADO'
        | 'PARCIALMENTE_REEMBOLSADO' | 'REEMBOLSADO' | 'ESTORNADO' | 'REVISAO';
    readonly versao: number;
    readonly moeda: 'BRL';
    readonly totalCentavos: number;
    readonly criadoEm: string;
    readonly expiraEm: string;
    readonly itens: readonly LojaPedidoItem[];
}
