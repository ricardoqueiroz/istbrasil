import { HttpClient } from '@angular/common/http';
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

@Injectable({ providedIn: 'root' })
export class JuradoService {
    private readonly http = inject(HttpClient);

    listarAcessos(): Observable<AcessosJuradoResponse> {
        return this.http.get<AcessosJuradoResponse>('/api/jurado/acessos', { withCredentials: true });
    }

    obterEvento(slug: string): Observable<EventoJuradoResponse> {
        return this.http.get<EventoJuradoResponse>(`/api/jurado/eventos/${encodeURIComponent(slug)}`, { withCredentials: true });
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