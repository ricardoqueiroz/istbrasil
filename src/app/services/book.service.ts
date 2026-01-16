import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';

export interface Book {
  id: number;
  onsale: number;
  sku: string;
  format: 'E-Book' | 'Livro Físico';
  category: string;
  language: string;
  title: string;
  descriptionDisplay?: string;
  currency: string;
  price: number;
  img: string;
  inventory: 'Em estoque' | 'Poucas unidades' | 'Esgotado';
  inventoryStatus?: string;
}

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