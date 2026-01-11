import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';

export interface Release {
    id: number;
    release_num: number;
    thumb: string;
    country: string;
    year: string;
    title: string;
    format: string;
    label_: string;
    artist: string;
    type_: string;
    own_collection: number;
    for_sale: number;
    
    // Propriedade opcional para armazenar faixas no frontend
    tracks?: Track[];
}

export interface Track {
    id: number;
    position: string;
    duration: string;
    titulo: string;
}

@Injectable({
    providedIn: 'root'
})
export class ReleasesService {
    private apiUrl = `${environment.apiUrl}/releases`;

    constructor(private http: HttpClient) {}

    getAllReleases(): Observable<Release[]> {
        return this.http.get<Release[]>(this.apiUrl);
    }

    getTracks(releaseNum: number): Observable<Track[]> {
        return this.http.get<Track[]>(`${this.apiUrl}/${releaseNum}/tracks`);
    }
}
