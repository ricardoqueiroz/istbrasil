export interface EmailPlaceholder {
    nome: string;
    tipo: 'texto' | 'url';
    obrigatorio: boolean;
    descricao: string;
}

export interface EmailPlaceholdersResposta {
    chave: string;
    ativo: boolean;
    placeholders: EmailPlaceholder[];
}

export interface EmailPreviewAviso {
    codigo: string;
    mensagem: string;
}

export interface EmailPreviewResultado {
    assunto: string;
    html: string;
    text: string;
    avisos: EmailPreviewAviso[];
}
