export interface EmailAssinatura {
    idAssinatura: number;
    nome: string;
    conteudoHtml: string;
    ativo: boolean;
    criadoPor: number;
    atualizadoPor: number | null;
    dataCadastro: string;
    dataAtualizacao: string;
}

export interface EmailAssinaturaPayload {
    nome: string;
    conteudoHtml: string;
    ativo: boolean;
}
