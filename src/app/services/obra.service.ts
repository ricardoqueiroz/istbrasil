import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';

export interface Obra {
    titulo: string;
    iswc: string;
    data: string;
    partitura: string;
    link: string;
}

export interface ObraApiResponse {
    total: number;
    page: number;
    limit: number;
    data: Obra[];
}

@Injectable({
    providedIn: 'root'
})
export class ObraService {

    private apiUrl = `${environment.apiUrl}/obra`;

    constructor(private http: HttpClient) { }

    getObras(page: number = 1, limit: number = 10, search: string = '', sortField?: string, sortOrder?: number): Observable<ObraApiResponse> {
        let params = new HttpParams()
            .set('page', page.toString())
            .set('limit', limit.toString());
        if (search) {
            params = params.set('search', search);
        }
        if (sortField) {
            params = params.set('sortField', sortField);
            params = params.set('sortOrder', sortOrder === 1 ? '1' : '-1');
        }
        return this.http.get<ObraApiResponse>(this.apiUrl, { params });
    }
}
