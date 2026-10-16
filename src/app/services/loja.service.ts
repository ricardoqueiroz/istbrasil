import { HttpClient, HttpParams, HttpResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';
import { LojaCategoria, LojaCotacao, LojaItemCotacao, LojaProduto, LojaProdutoDetalhe, LojaPedido, LojaSolicitacaoPedido, LojaSessao } from '../pages/loja/models/loja.model';

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

    estabelecerSessao(): Observable<HttpResponse<LojaSessao>> {
        return this.http.post<LojaSessao>('/api/loja/sessao', {}, {
            observe: 'response', withCredentials: true, headers: { 'X-IST-Loja': '1' }
        });
    }

    criarPedido(entrada: LojaSolicitacaoPedido, chave: string, csrf: string): Observable<LojaPedido> {
        return this.http.post<LojaPedido>('/api/loja/pedidos', {
            produtoIds: [...entrada.produtoIds], compradorEmail: entrada.compradorEmail
        }, { withCredentials: true, headers: { 'X-IST-Loja': '1', 'X-CSRF-Token': csrf, 'Idempotency-Key': chave } });
    }
}
