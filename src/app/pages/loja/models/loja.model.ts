export interface LojaCategoria {
    readonly id: number;
    readonly nome: string | null;
    readonly slug: string;
    readonly categoriaPaiId: number | null;
    readonly ordem: number;
}

export interface LojaProduto {
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
