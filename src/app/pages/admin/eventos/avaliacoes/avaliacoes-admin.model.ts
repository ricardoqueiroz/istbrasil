export type AvaliacoesAdminSortField = 'numeroConcorrente' | 'nome';
export type AvaliacoesAdminSortOrder = 'asc' | 'desc';

export interface AvaliacoesAdminParametros {
    page: number;
    limit: number;
    sortField: AvaliacoesAdminSortField;
    sortOrder: AvaliacoesAdminSortOrder;
}

export interface HistoricoAvaliacoesAdmin {
    totalAvaliacoesForaDoJuriAtual: number;
    concluidas: number;
    rascunhos: number;
    possuiSinalizacaoPossivelDesclassificacao: boolean;
}

export interface SinalizacoesAvaliacoesAdmin {
    possuiAtual: boolean;
    possuiHistorica: boolean;
    possuiQualquer: boolean;
}

export interface ConcorrenteAndamentoAdmin {
    idParticipacao: number;
    numeroConcorrente: string;
    nome: string;
    andamento: {
        totalJuradosAtuais: number;
        concluidasAtuais: number;
        rascunhosAtuais: number;
        pendentesAtuais: number;
    };
    historico: HistoricoAvaliacoesAdmin;
    sinalizacoes: SinalizacoesAvaliacoesAdmin;
}

export interface AvaliacoesAdminResponse {
    evento: { id: number; slug: string; nome: string };
    jurados: { totalAtuais: number };
    data: ConcorrenteAndamentoAdmin[];
    pagination: { page: number; limit: number; total: number; totalPages: number };
}