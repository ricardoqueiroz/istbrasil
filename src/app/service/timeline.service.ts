import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';

// Interface baseada na View SQL criada
export interface TimelineEvent {
    ano: string;
    titulo: string;
    subtitulo: string;
    descricao: string;
    midia?: string; // URL da imagem ou vídeo
    footer: string; // HTML pré-formatado pelo SQL
}

@Injectable({
    providedIn: 'root'
})
export class TimelineService {
    // URL definida automaticamente pelo environment (dev ou prod)
    private apiUrl = environment.apiUrl;

    constructor(private http: HttpClient) {}

    getEvents(page: number, limit: number): Observable<TimelineEvent[]> {
        return this.http.get<TimelineEvent[]>(`${this.apiUrl}?page=${page}&limit=${limit}`);
    }
}
