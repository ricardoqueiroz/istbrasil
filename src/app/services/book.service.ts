import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';

export interface BookComercial {
  readonly produtoId: number;
  readonly sku: string;
  readonly precoCentavos: number | null;
  readonly moeda: string;
  readonly podeComprar: boolean;
}

export interface Book {
  readonly id: number;
  readonly title: string | null;
  readonly description: string | null;
  readonly language: string | null;
  readonly format: string | null;
  readonly img: string | null;
  readonly category: string | null;
  readonly comercial?: BookComercial | null;
}

// Apenas apresentacao: a autorizacao de compra continua sendo fornecida pela API.
export const precoEditorial = (book: Book): string | null => {
  const oferta = book.comercial;
  return oferta && oferta.moeda === 'BRL' && typeof oferta.precoCentavos === 'number'
    && Number.isSafeInteger(oferta.precoCentavos) && oferta.precoCentavos > 0
    ? new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(oferta.precoCentavos / 100) : null;
};

@Injectable({
  providedIn: 'root'
})
export class BookService {
  // Use a URL absoluta para garantir que bata no backend Node e não no servidor Angular
  private apiUrl = `${environment.apiUrl}/books`;

  constructor(private http: HttpClient) { }

  getBooks(): Observable<Book[]> {
    return this.http.get<Book[]>(this.apiUrl);
  }

  getById(id: string | number) {
    return this.http.get<Book>(`${this.apiUrl}/${id}`);
  }
}