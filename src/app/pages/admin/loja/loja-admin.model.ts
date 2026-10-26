export interface VersaoPdfAdmin {versaoPublicId: string; numeroVersao: number; estado: 'RASCUNHO' | 'PUBLICADA' | 'RETIRADA';}
export interface ComercialLivro {
    id: number; categoriaId: number; sku: string; precoCentavos: number | null;
    tipo: string | null; autor: string | null; titulo: string | null; descricao: string | null; imagemUrl: string | null;
    ativo: boolean | null; emVenda: boolean | null; disponivel: boolean | null;
    revisao: string;
}
export type ComandoComercialLivro = Partial<Pick<ComercialLivro, 'categoriaId' | 'sku' | 'precoCentavos' | 'titulo' | 'descricao' | 'imagemUrl' | 'ativo' | 'emVenda' | 'disponivel'>>;
export interface LivroAdmin {
    id: number;
    title: string | null;
    author: string | null;
    currency: string;
    description: string | null;
    language: string | null;
    format: string | null;
    category: string | null;
    img: string | null;
    pertenceEditoraIst: boolean | null;
    produtoId: number | null;
    produtoTipo: string | null;
    comercial?: ComercialLivro | null;
    versoesPdf?: VersaoPdfAdmin[];
    sku: string | null;
    price: string | null;
    onsale: number | null;
    inventory: string | null;
    revisao: string;
}
export interface LivrosAdminResposta {
    itens: LivroAdmin[];
    paginacao: { pagina: number; limite: number; total: number };
}
export interface LivrosAdminConsulta {
    pagina?: number;
    limite?: number;
    busca?: string;
    pertenceEditoraIst?: boolean | null;
}
export interface ErroAdminResposta {
    erro: { codigo: string; mensagem: string };
}

export type LivroAdminAlteracoes = Partial<Pick<LivroAdmin, 'title' | 'author' | 'currency' | 'language' | 'category' | 'img' | 'pertenceEditoraIst'
    | 'sku' | 'format' | 'description' | 'price' | 'onsale' | 'inventory'>> & {categoriaId?: number; comercial?: ComandoComercialLivro};
export interface LivroAdminCriacao {
    categoriaId: number;
    comercial?: {categoriaId: number; sku: string; precoCentavos: number};
    author?: string | null;
    currency?: string;
    title: string;
    format: 'E-Book' | 'Livro Físico';
    category?: string;
    pertenceEditoraIst: boolean | null;
    language?: string | null;
    img?: string | null;
    sku?: string | null;
    description?: string | null;
    price?: string | null;
    onsale?: 0 | 1;
    inventory?: 'Em estoque' | 'Poucas unidades' | 'Esgotado';
}
export interface CategoriaLivroOpcao { id: number; nome: string; ativo: boolean; categoriaPaiId: number | null; ordem: number; }
