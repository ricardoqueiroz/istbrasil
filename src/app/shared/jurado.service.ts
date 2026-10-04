import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, catchError, map, of } from 'rxjs';

export interface EventoJurado {
    id: number;
    slug: string;
    nome: string;
}

export interface AcessosJuradoResponse {
    eventos: EventoJurado[];
}

export interface EventoJuradoResponse {
    evento: EventoJurado;
}

export interface ObraJurado {
    id: number;
    titulo: string;
}

export interface ConcorrenteJurado {
    idParticipacao: number;
    numeroConcorrente: string;
    nome: string;
    cidade: string | null;
    uf: string | null;
    dataInscricao: string;
    obraPrincipal: ObraJurado;
    linkVideoPrincipal: string;
    obraOpcional: ObraJurado | null;
    linkVideoOpcional: string | null;
}

export interface PaginacaoJurado {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
}

export interface FilaJuradoResponse {
    evento: EventoJurado;
    concorrentes: ConcorrenteJurado[];
    pagination: PaginacaoJurado;
}

export interface ConcorrenteJuradoResponse {
    evento: EventoJurado;
    concorrente: ConcorrenteJurado;
}

export type EstadoAvaliacaoJurado = 'pendente' | 'rascunho' | 'concluida';

export interface CriterioAvaliacaoJurado {
    idCriterio: number;
    nome: string;
    descricao: string | null;
    ordem: number;
    peso: string;
}

export interface NotaAvaliacaoJurado {
    idCriterio: number;
    nota: number;
}

export interface AvaliacaoJurado {
    idAvaliacao: number;
    notas: NotaAvaliacaoJurado[];
    possivelDesclassificacao: boolean;
    motivoDesclassificacao: string | null;
    media: string | null;
    dataInclusao: string;
    dataAtualizacao: string;
    dataConclusao: string | null;
}

interface DadosAvaliacaoJuradoResponse {
    evento: EventoJurado;
    concorrente: Pick<ConcorrenteJurado, 'idParticipacao' | 'numeroConcorrente'>;
    escala: { min: number; max: number; passo: number };
    criterios: CriterioAvaliacaoJurado[];
}

export type AvaliacaoJuradoResponse = DadosAvaliacaoJuradoResponse & (
    { estado: 'pendente'; versao: 0; avaliacao: null }
    | { estado: Exclude<EstadoAvaliacaoJurado, 'pendente'>; versao: number; avaliacao: AvaliacaoJurado }
);

export interface SalvarAvaliacaoJuradoPayload {
    versao: number;
    estado: Exclude<EstadoAvaliacaoJurado, 'pendente'>;
    notas: NotaAvaliacaoJurado[];
    possivelDesclassificacao: boolean;
    motivoDesclassificacao: string | null;
}

export type FilaJuradoSort = 'numeroConcorrente' | 'nome' | 'dataInscricao';
export type FilaJuradoOrder = 'asc' | 'desc';

export interface FilaJuradoParams {
    page: number;
    limit: number;
    sort: FilaJuradoSort;
    order: FilaJuradoOrder;
}

@Injectable({ providedIn: 'root' })
export class JuradoService {
    private readonly http = inject(HttpClient);

    listarAcessos(): Observable<AcessosJuradoResponse> {
        return this.http.get<AcessosJuradoResponse>('/api/jurado/acessos', { withCredentials: true });
    }

    obterEvento(slug: string): Observable<EventoJuradoResponse> {
        return this.http.get<EventoJuradoResponse>(`/api/jurado/eventos/${encodeURIComponent(slug)}`, { withCredentials: true });
    }

    listarConcorrentes(slug: string, parametros: Partial<FilaJuradoParams> = {}): Observable<FilaJuradoResponse> {
        const params = new HttpParams()
            .set('page', parametros.page ?? 1)
            .set('limit', parametros.limit ?? 25)
            .set('sort', parametros.sort ?? 'numeroConcorrente')
            .set('order', parametros.order ?? 'asc');
        return this.http.get<FilaJuradoResponse>(`/api/jurado/eventos/${encodeURIComponent(slug)}/concorrentes`, { params, withCredentials: true });
    }

    obterConcorrente(slug: string, idParticipacao: number): Observable<ConcorrenteJuradoResponse> {
        return this.http.get<ConcorrenteJuradoResponse>(`/api/jurado/eventos/${encodeURIComponent(slug)}/concorrentes/${idParticipacao}`, { withCredentials: true });
    }

    obterAvaliacao(slug: string, idParticipacao: number): Observable<AvaliacaoJuradoResponse> {
        return this.http.get<AvaliacaoJuradoResponse>(`/api/jurado/eventos/${encodeURIComponent(slug)}/concorrentes/${idParticipacao}/avaliacao`, { withCredentials: true });
    }

    salvarAvaliacao(slug: string, idParticipacao: number, payload: SalvarAvaliacaoJuradoPayload): Observable<AvaliacaoJuradoResponse> {
        return this.http.put<AvaliacaoJuradoResponse>(`/api/jurado/eventos/${encodeURIComponent(slug)}/concorrentes/${idParticipacao}/avaliacao`, payload, { withCredentials: true });
    }

    destinoAposLogin(): Observable<string[]> {
        return this.listarAcessos().pipe(
            map(({ eventos }) => {
                if (eventos.length === 1) {
                    return ['/jurado', eventos[0].slug, 'avaliacoes'];
                }

                return eventos.length > 1 ? ['/jurado'] : ['/'];
            }),
            catchError(() => of(['/']))
        );
    }
}