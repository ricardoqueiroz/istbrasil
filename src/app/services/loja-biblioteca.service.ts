import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map, of, switchMap, throwError } from 'rxjs';
import { environment } from '../../environments/environment';
import { LojaService } from './loja.service';

export interface DesafioRecuperacao { publicId: string; segredo: string; }
export interface SessaoBiblioteca { sessao: { autenticada: boolean; expiraEm?: string }; csrfToken: string; }
export type EstadoDireito = 'ATIVO' | 'AGUARDANDO_CONFIRMACAO' | 'SUSPENSO' | 'REVOGADO';
export interface DireitoBiblioteca { pedidoPublicId?: string; produtoId?: number; itemPosicao?: number; publicId: string; titulo: string; estado: EstadoDireito; podeSolicitarArquivo: boolean; }
export interface PaginaBiblioteca { direitos: DireitoBiblioteca[]; proximoCursor: string | null; }
export const MENSAGEM_RECUPERACAO = 'Se houver direitos elegíveis, enviaremos as instruções de recuperação.';

export function mensagemCodigoBiblioteca(e: unknown): string {
    if (e instanceof HttpErrorResponse && e.status === 400) return 'Código inválido, expirado ou já utilizado. Confira os dados ou solicite um novo código.';
    if (e instanceof HttpErrorResponse && e.status === 401) return 'Sessão expirada ou inválida. Solicite um novo código de acesso.';
    return mensagemBiblioteca(e);
}

export function mensagemBiblioteca(e: unknown): string {
    const status = e instanceof HttpErrorResponse ? e.status : 0;
    if (status === 401) return 'Sessão expirada ou inválida. Solicite um novo link de recuperação.';
    if (status === 429) return 'Muitas solicitações. Aguarde antes de tentar novamente.';
    if (status === 400) return 'Link inválido, expirado ou já utilizado. Solicite um novo link.';
    if (status === 403) return 'Não foi possível autorizar a solicitação. Atualize a página e tente novamente.';
    if (status === 404 || status === 409) return 'Este e-book não está disponível para esta sessão.';
    return 'Serviço indisponível no momento. Tente novamente mais tarde.';
}

@Injectable({ providedIn: 'root' })
export class LojaBibliotecaService {
    private readonly http = inject(HttpClient);
    private readonly loja = inject(LojaService);
    private readonly base = `${environment.apiUrl}/loja/downloads`;
    private readonly opcoes = { withCredentials: true, headers: { 'X-IST-Loja': '1' } };
    sessao(): Observable<SessaoBiblioteca> { return this.http.get<SessaoBiblioteca>(`${this.base}/recuperacao/sessao`, this.opcoes); }
    private post<T>(acao: string, corpo: object): Observable<T> {
        return this.sessao().pipe(switchMap(s => this.http.post<T>(`${this.base}/recuperacao/${acao}`, corpo,
            { ...this.opcoes, headers: { ...this.opcoes.headers, 'X-CSRF-Token': s.csrfToken } })));
    }
    solicitar(email: string): Observable<void> { return this.post<unknown>('solicitar', { email }).pipe(map(() => undefined)); }
    solicitarCodigo(email: string, pedidoPublicId: string): Observable<void> {
        return this.post<unknown>('solicitar-codigo', { email, pedidoPublicId }).pipe(map(() => undefined));
    }
    validarCodigo(pedidoPublicId: string, codigo: string): Observable<unknown> {
        return this.post('validar-codigo', { pedidoPublicId, codigo });
    }
    confirmar(d: DesafioRecuperacao): Observable<unknown> { return this.post('validar', { publicId: d.publicId, segredo: d.segredo }); }
    revogar(): Observable<unknown> { return this.post('revogar', {}); }
    listar(apos?: string, pedidoPublicId?: string): Observable<PaginaBiblioteca> {
        let params = new HttpParams().set('limite', 50);
        if (apos) params = params.set('apos', apos);
        if (pedidoPublicId) params = params.set('pedidoPublicId', pedidoPublicId);
        return this.http.get<PaginaBiblioteca>(`${this.base}/direitos`, { ...this.opcoes, params });
    }
    reavaliar(id: string): Observable<{ publicId: string; estado: EstadoDireito }> {
        return this.sessao().pipe(switchMap(s => s.sessao.autenticada ? of(s.csrfToken)
            : this.loja.estabelecerSessao().pipe(map(r => r.headers.get('X-CSRF-Token') ?? ''))), switchMap(csrf => csrf
                ? this.http.post<{ publicId: string; estado: EstadoDireito }>(`${this.base}/itens/${encodeURIComponent(id)}/reavaliar`, {},
                    { ...this.opcoes, headers: { ...this.opcoes.headers, 'X-CSRF-Token': csrf } })
                : throwError(() => new Error('CSRF_INDISPONIVEL'))));
    }
    arquivo(id: string): Observable<Blob> {
        return this.http.get(`${this.base}/itens/${encodeURIComponent(id)}/arquivo`, { ...this.opcoes, responseType: 'blob' });
    }
}
