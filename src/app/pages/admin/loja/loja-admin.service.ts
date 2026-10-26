import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { EMPTY, Observable, catchError, expand, map, reduce, switchMap, throwError, timeout } from 'rxjs';
import { CategoriaLivroOpcao, LivroAdmin, LivroAdminAlteracoes, LivroAdminCriacao, LivrosAdminConsulta, LivrosAdminResposta } from './loja-admin.model';

export class LojaAdminErro extends Error {
    constructor(public readonly status: number, escrita = false, mensagem?: string) {
        super(escrita && [0, 502, 503].includes(status)
            ? 'Não foi possível confirmar a operação. Recarregue e confira o registro antes de tentar novamente; não repita a gravação automaticamente.'
            : ({ 0: 'Não foi possível comunicar com o servidor.', 400: 'Dados inválidos. Confira os campos informados.',
                401: 'Sessão expirada. Entre novamente.', 403: 'Operação não autorizada ou proteção de sessão expirada. Recarregue a página.',
                404: 'Livro não encontrado.', 409: 'Conflito comercial: verifique SKU, categoria e dependências do produto.',
                412: 'O livro foi alterado por outra operação. Recarregue antes de editar.',
                413: 'Os dados excedem o tamanho permitido.', 415: 'Formato da requisição inválido.',
                428: 'Revisão ausente. Recarregue o registro.',
                503: 'Administração indisponível.' } as Record<number, string>)[status]
                ?? 'Não foi possível concluir a consulta de livros.');
        if(mensagem) this.message=mensagem+(escrita && [0,502,503].includes(status) ? ' Confira o registro antes de repetir; a gravacao pode ter sido confirmada.' : '');
    }
}
const objeto = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const inteiro = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);
const livroValido = (v: unknown): v is LivroAdmin => objeto(v) && inteiro(v['id']) && v['id'] > 0
    && ['title', 'author', 'description', 'language', 'format', 'category', 'img'].every(k => v[k] === null || typeof v[k] === 'string')
    && typeof v['currency'] === 'string'
    && (v['pertenceEditoraIst'] === null || typeof v['pertenceEditoraIst'] === 'boolean')
    && ['sku', 'price', 'inventory', 'produtoTipo'].every(k => v[k] === null || typeof v[k] === 'string')
    && (v['onsale'] === null || inteiro(v['onsale']))
    && (v['produtoId'] === null || (inteiro(v['produtoId']) && v['produtoId'] > 0)) && typeof v['revisao'] === 'string';

@Injectable({ providedIn: 'root' })
export class LojaAdminService {
    private readonly http = inject(HttpClient);
    private erro(e: unknown, escrita = false): Observable<never> {
        if(e instanceof LojaAdminErro) return throwError(()=>escrita && [0,502,503].includes(e.status) ? new LojaAdminErro(e.status,true) : e);
        const status=e instanceof HttpErrorResponse?e.status:502;
        let mensagem: string | undefined;
        if(e instanceof HttpErrorResponse && [400,401,403,404,409,412,413,415,428,503].includes(status)) {
            const envelope=e.error;
            const erro=objeto(envelope)&&objeto(envelope['erro'])?envelope['erro']:null;
            const texto=erro?.['mensagem'],codigo=erro?.['codigo'];
            if(typeof codigo==='string' && /^ADMIN_[A-Z_]+$/.test(codigo) && typeof texto==='string' && texto.trim()
                && texto.length<=400 && !/[<>`\\/\x00-\x1f\x7f]/.test(texto)
                && !/(?:\b(?:SELECT|INSERT|UPDATE|DELETE|ALTER|DROP|FROM|WHERE|SQL|stack|trace|exception|password|secret|segredo|senha|credenciais|JWT|Bearer|token|cookie)\b|https?:|[A-Za-z]:[\\/]|[\\/][A-Za-z0-9_.-]+[\\/]|\bat .+:\d+)/i.test(texto)) mensagem=texto;
            if(codigo==='ADMIN_SKU_DUPLICADO') mensagem='SKU comercial já cadastrado. Informe outro SKU.';
        }
        return throwError(()=>new LojaAdminErro(status,escrita,mensagem));
    }
    private item(v: unknown): LivroAdmin {
        if (!objeto(v) || !livroValido(v['item'])) throw new LojaAdminErro(502);
        const c = v['item'].comercial;
        if (c !== null && (!objeto(c) || !inteiro(c['id']) || c['id'] !== v['item'].produtoId
            || !inteiro(c['categoriaId']) || typeof c['sku'] !== 'string' || typeof c['revisao'] !== 'string'
            || !/^"[a-f0-9]{64}"$/.test(c['revisao']) || !(c['precoCentavos'] === null || inteiro(c['precoCentavos']) && c['precoCentavos'] > 0)))
            throw new LojaAdminErro(502);
        const versoes=v['item'].versoesPdf;
        if(versoes!==undefined&&(!Array.isArray(versoes)||versoes.some(r=>!objeto(r)||typeof r['versaoPublicId']!=='string'
            ||!inteiro(r['numeroVersao'])||r['numeroVersao']<1||!['RASCUNHO','PUBLICADA','RETIRADA'].includes(String(r['estado'])))))
            throw new LojaAdminErro(502);
        return v['item'];
    }
    private csrf(): Observable<string> {
        // Fresh token bound to the current JWT. Kept only in this request chain.
        return this.http.get('/api/admin/loja/livros', { params: { limite: 1 }, withCredentials: true, observe: 'response' }).pipe(
            map(r => {
                const token = r.headers.get('X-CSRF-Token');
                if (!token || !/^\d{13}\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/.test(token)) throw new LojaAdminErro(503);
                return token;
            })
        );
    }
    listarCategorias(): Observable<CategoriaLivroOpcao[]> {
        const pagina = (numero: number) => this.http.get<unknown>('/api/admin/loja/categorias',
            { params: { pagina: numero, limite: 100 }, withCredentials: true }).pipe(map(v => {
                if (!objeto(v) || !Array.isArray(v['itens']) || !objeto(v['paginacao'])) throw new LojaAdminErro(502);
                const p = v['paginacao'];
                if (p['pagina'] !== numero || p['limite'] !== 100 || !inteiro(p['total']) || p['total'] < 0
                    || v['itens'].some(c => !objeto(c) || !inteiro(c['id']) || c['id'] <= 0 || typeof c['nome'] !== 'string' || typeof c['ativo'] !== 'boolean' || !(c['categoriaPaiId'] === null || inteiro(c['categoriaPaiId'])) || !inteiro(c['ordem']))) throw new LojaAdminErro(502);
                if (numero >= 100 && numero * 100 < p['total']) throw new LojaAdminErro(503);
                return { pagina: numero, total: p['total'], itens: v['itens'] as CategoriaLivroOpcao[] };
            }));
        return pagina(1).pipe(expand(p => p.pagina * 100 < p.total ? pagina(p.pagina + 1) : EMPTY),
            reduce((itens, p) => itens.concat(p.itens), [] as CategoriaLivroOpcao[]),
            map(itens => { if (new Set(itens.map(c => c.id)).size !== itens.length) throw new LojaAdminErro(502); return itens; }),
            catchError(e => this.erro(e)));
    }
    enviarCapa(arquivo: File): Observable<string> {
        const dados = new FormData(); dados.append('capa', arquivo);
        return this.csrf().pipe(switchMap(token => this.http.post<unknown>('/api/admin/loja/livros/capa', dados,
            { withCredentials: true, headers: { 'X-CSRF-Token': token } })),
            map(v => {
                if (!objeto(v) || !objeto(v['item']) || typeof v['item']['img'] !== 'string'
                    || !/^assets\/images\/(?:[A-Za-z0-9_-]+\/)+[a-f0-9-]+\.webp$/.test(v['item']['img'])) throw new LojaAdminErro(502);
                return v['item']['img'];
            }), catchError(e => this.erro(e, true)));
    }
    enviarPdf(id: number, arquivo: File, revisao: string): Observable<{ versaoPublicId: string; numeroVersao: number; estado: 'RASCUNHO' }> {
        const dados = new FormData(); dados.append('pdf', arquivo);
        return this.csrf().pipe(switchMap(token => this.http.post<unknown>(`/api/admin/loja/livros/${id}/pdf`, dados,
            { withCredentials: true, headers: { 'X-CSRF-Token': token, 'If-Match': revisao } })),
            map(v => {
                if (!objeto(v) || !objeto(v['item']) || v['item']['estado'] !== 'RASCUNHO'
                    || typeof v['item']['versaoPublicId'] !== 'string' || !inteiro(v['item']['numeroVersao'])) throw new LojaAdminErro(502);
                return v['item'] as { versaoPublicId: string; numeroVersao: number; estado: 'RASCUNHO' };
            }), catchError(e => this.erro(e, true)));
    }
    obterLivro(id: number): Observable<LivroAdmin> {
        return this.http.get<unknown>(`/api/admin/loja/livros/${id}`, { withCredentials: true }).pipe(
            timeout(15000), map(v => this.item(v)), catchError(e => this.erro(e)));
    }
    obterElegibilidade(produtoId: number): Observable<boolean> {
        return this.http.get<{item:{podeComprar:boolean}}>(`/api/admin/loja/produtos/${produtoId}`,{withCredentials:true}).pipe(
            map(v=>{if(typeof v?.item?.podeComprar!=='boolean')throw new LojaAdminErro(502);return v.item.podeComprar;}),catchError(e=>this.erro(e)));
    }
    publicarPdf(livro: LivroAdmin, versaoPublicId: string): Observable<unknown> {
        const publicacaoAtualEsperada=livro.versoesPdf?.find(v=>v.estado==='PUBLICADA')?.versaoPublicId??null;
        return this.csrf().pipe(switchMap(token=>this.http.post<unknown>(
            `/api/admin/loja/livros/${livro.id}/versoes-pdf/${versaoPublicId}/publicar`,{publicacaoAtualEsperada},
            {withCredentials:true,headers:{'X-CSRF-Token':token,'If-Match':livro.revisao}})),
            map(v=>{if(!objeto(v)||!objeto(v['item'])||v['item']['estado']!=='PUBLICADA'
                ||v['item']['versaoPublicId']!==versaoPublicId)throw new LojaAdminErro(502);return v;}),catchError(e=>this.erro(e,true)));
    }
    criarLivro(dados: LivroAdminCriacao): Observable<LivroAdmin> {
        return this.csrf().pipe(switchMap(token => this.http.post<unknown>('/api/admin/loja/livros', dados,
            { withCredentials: true, headers: { 'X-CSRF-Token': token } })),
            map(v => this.item(v)), catchError(e => this.erro(e, true)));
    }
    atualizarLivro(id: number, dados: LivroAdminAlteracoes, revisao: string, revisaoComercial?: string): Observable<LivroAdmin> {
        return this.csrf().pipe(switchMap(token => this.http.patch<unknown>(`/api/admin/loja/livros/${id}`, dados,
            { withCredentials: true, headers: { 'X-CSRF-Token': token, 'If-Match': revisao, ...(revisaoComercial ? {'If-Match-Produto': revisaoComercial} : {}) } })),
            map(v => this.item(v)), catchError(e => this.erro(e, true)));
    }
    excluirLivro(id: number, revisao: string, revisaoComercial?: string): Observable<void> {
        return this.csrf().pipe(switchMap(token => this.http.delete<void>(`/api/admin/loja/livros/${id}`,
            { withCredentials: true, headers: { 'X-CSRF-Token': token, 'If-Match': revisao, ...(revisaoComercial ? {'If-Match-Produto': revisaoComercial} : {}) } })),
            catchError(e => this.erro(e, true)));
    }
    listarLivros(consulta: LivrosAdminConsulta): Observable<LivrosAdminResposta> {
        let params = new HttpParams();
        if (consulta.pagina !== undefined) params = params.set('pagina', consulta.pagina);
        if (consulta.limite !== undefined) params = params.set('limite', consulta.limite);
        if (consulta.busca?.trim()) params = params.set('busca', consulta.busca.trim());
        if (consulta.pertenceEditoraIst !== undefined) params = params.set('pertenceEditoraIst', String(consulta.pertenceEditoraIst));
        return this.http.get<unknown>('/api/admin/loja/livros', { params, withCredentials: true }).pipe(
            map(v => {
                if (!objeto(v) || !Array.isArray(v['itens']) || !v['itens'].every(livroValido) || !objeto(v['paginacao'])) throw new LojaAdminErro(502);
                const p = v['paginacao'];
                if (!inteiro(p['pagina']) || p['pagina'] < 1 || !inteiro(p['limite']) || p['limite'] < 1 || p['limite'] > 100
                    || !inteiro(p['total']) || p['total'] < 0) throw new LojaAdminErro(502);
                return v as unknown as LivrosAdminResposta;
            }),
            catchError(e => this.erro(e))
        );
    }
}
