export interface EmailModelo {
    idModelo: number;
    chave: string;
    nome: string;
    assunto: string;
    conteudoHtml: string;
    idAssinatura: number | null;
    nomeAssinatura: string | null;
    assinaturaAtiva: boolean | null;
    ativo: boolean;
    criadoPor: number;
    atualizadoPor: number | null;
    dataCadastro: string;
    dataAtualizacao: string;
}

export interface EmailModeloPayload {
    chave: string;
    nome: string;
    assunto: string;
    conteudoHtml: string;
    idAssinatura: number | null;
    ativo: boolean;
}

export interface EmailModeloAtualizacaoPayload {
    nome: string;
    assunto: string;
    conteudoHtml: string;
    idAssinatura: number | null;
    ativo: boolean;
}
