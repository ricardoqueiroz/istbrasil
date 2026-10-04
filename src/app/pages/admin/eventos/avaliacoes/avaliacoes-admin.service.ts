import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { AvaliacoesAdminParametros, AvaliacoesAdminResponse } from './avaliacoes-admin.model';

@Injectable({ providedIn: 'root' })
export class AvaliacoesAdminService {
    private readonly http = inject(HttpClient);

    listarAndamento(slug: string, parametros: AvaliacoesAdminParametros): Observable<AvaliacoesAdminResponse> {
        const params = new HttpParams()
            .set('page', parametros.page)
            .set('limit', parametros.limit)
            .set('sortField', parametros.sortField)
            .set('sortOrder', parametros.sortOrder);
        return this.http.get<AvaliacoesAdminResponse>(`/api/admin/eventos/${encodeURIComponent(slug)}/avaliacoes`, { params, withCredentials: true });
    }
}