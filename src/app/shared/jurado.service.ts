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