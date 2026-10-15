import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';
import { LojaCategoria, LojaCotacao, LojaItemCotacao, LojaProduto, LojaProdutoDetalhe } from '../pages/loja/models/loja.model';

@Injectable({ providedIn: 'root' })
export class LojaService {
    private readonly http = inject(HttpClient);
    private readonly url = `${environment.apiUrl}/loja`;

    listarCategorias(): Observable<LojaCategoria[]> {
        return this.http.get<LojaCategoria[]>(`${this.url}/categorias`);
    }

    listarProdutos(categoria?: string): Observable<LojaProduto[]> {
        const params = categoria === undefined ? new HttpParams() : new HttpParams().set('categoria', categoria);
        return this.http.get<LojaProduto[]>(`${this.url}/produtos`, { params });
    }

    obterProduto(id: number): Observable<LojaProdutoDetalhe> {
        return this.http.get<LojaProdutoDetalhe>(`${this.url}/produtos/${encodeURIComponent(String(id))}`);
    }

    cotar(itens: readonly LojaItemCotacao[]): Observable<LojaCotacao> {
        return this.http.post<LojaCotacao>(`${this.url}/cotacao`, {
            itens: itens.map(({ produtoId, quantidade }) => ({ produtoId, quantidade }))
        });
    }
}
