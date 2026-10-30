import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { environment } from '../../environments/environment';
import { LojaBibliotecaService, mensagemBiblioteca } from './loja-biblioteca.service';

describe('Biblioteca HTTP D6/D7', () => {
    let api: LojaBibliotecaService, http: HttpTestingController;
    const base = `${environment.apiUrl}/loja/downloads`;
    beforeEach(() => { TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] }); api = TestBed.inject(LojaBibliotecaService); http = TestBed.inject(HttpTestingController); });
    afterEach(() => http.verify());
    function sessao(recuperada = true): void {
        const req = http.expectOne(`${base}/recuperacao/sessao`);
        expect(req.request.withCredentials).toBeTrue(); expect(req.request.headers.get('X-IST-Loja')).toBe('1');
        req.flush({ sessao: { autenticada: recuperada }, csrfToken: 'csrf-recuperacao' });
    }
    it('solicita com bootstrap e CSRF; resposta nao informa existencia de compras', () => {
        let recebido = false; api.solicitar('teste@example.invalid').subscribe(() => recebido = true); sessao();
        const r = http.expectOne(`${base}/recuperacao/solicitar`); expect(r.request.method).toBe('POST');
        expect(r.request.body).toEqual({ email: 'teste@example.invalid' }); expect(r.request.headers.get('X-CSRF-Token')).toBe('csrf-recuperacao');
        expect(r.request.withCredentials).toBeTrue(); r.flush({ mensagem: 'resposta uniforme' }, { status: 202, statusText: 'Accepted' }); expect(recebido).toBeTrue();
    });
    it('confirma segredo somente em corpo POST, nunca query ou armazenamento', () => {
        const local = spyOn(Storage.prototype, 'setItem');
        api.confirmar({ publicId: 'id', segredo: 'segredo-sintetico' }).subscribe(); sessao();
        const r = http.expectOne(`${base}/recuperacao/validar`); expect(r.request.urlWithParams).not.toContain('segredo');
        expect(r.request.body).toEqual({ publicId: 'id', segredo: 'segredo-sintetico' }); r.flush({}); expect(local).not.toHaveBeenCalled();
    });
    it('lista paginada no maximo 50 com credenciais sem reavaliar', () => {
        api.listar('cursor').subscribe(); const r = http.expectOne(q => q.url === `${base}/direitos`);
        expect(r.request.params.get('limite')).toBe('50'); expect(r.request.params.get('apos')).toBe('cursor'); expect(r.request.withCredentials).toBeTrue(); r.flush({ direitos: [], proximoCursor: null });
    });
    it('reavalia sessao recuperada com CSRF separado sem criar sessao de compra', () => {
        api.reavaliar('direito').subscribe(); sessao(); const r = http.expectOne(`${base}/itens/direito/reavaliar`);
        expect(r.request.headers.get('X-CSRF-Token')).toBe('csrf-recuperacao'); r.flush({ publicId: 'direito', estado: 'ATIVO' }); http.expectNone('/api/loja/sessao');
    });
    it('reavalia compra com CSRF original sem reutilizar bootstrap da recuperacao', () => {
        api.reavaliar('direito').subscribe(); sessao(false); const s = http.expectOne('/api/loja/sessao');
        s.flush({ sessao: {} }, { headers: { 'X-CSRF-Token': 'csrf-compra' } }); const r = http.expectOne(`${base}/itens/direito/reavaliar`);
        expect(r.request.headers.get('X-CSRF-Token')).toBe('csrf-compra'); r.flush({ publicId: 'direito', estado: 'ATIVO' });
    });
    it('erro de sessao nao tenta autoridade alternativa nem repete automaticamente', () => {
        let falhou = false;
        api.reavaliar('direito').subscribe({ error: () => { falhou = true; } }); http.expectOne(`${base}/recuperacao/sessao`).flush({}, { status: 401, statusText: 'Unauthorized' }); http.expectNone('/api/loja/sessao'); expect(falhou).toBeTrue();
    });
    it('download e Blob autenticado sem URL privada', () => {
        api.arquivo('direito').subscribe(b => expect(b.type).toBe('application/pdf'));
        const r = http.expectOne(`${base}/itens/direito/arquivo`); expect(r.request.responseType).toBe('blob'); expect(r.request.withCredentials).toBeTrue(); r.flush(new Blob(['%PDF'], { type: 'application/pdf' }));
    });
    it('revoga somente recuperacao com CSRF, sem revogar compra', () => {
        api.revogar().subscribe(); sessao(); const r = http.expectOne(`${base}/recuperacao/revogar`);
        expect(r.request.body).toEqual({}); expect(r.request.headers.get('X-CSRF-Token')).toBe('csrf-recuperacao'); r.flush({ revogada: true }); http.expectNone('/api/loja/sessao');
    });
    for (const status of [400, 401, 403, 404, 409, 429, 503]) it(`erro ${status} sanitizado sem detalhes internos`, () => {
        const mensagem = mensagemBiblioteca(new HttpErrorResponse({ status, error: 'segredo-caminho-privado' })); expect(mensagem).not.toContain('segredo-caminho-privado'); expect(mensagem.length).toBeGreaterThan(10);
    });
    it('B2 filtra por UUID do pedido mantendo credenciais e cursor', () => {
        api.listar('cursor', 'pedido-publico').subscribe();
        const r = http.expectOne(req => req.url === `${base}/direitos`);
        expect(r.request.params.get('pedidoPublicId')).toBe('pedido-publico');
        expect(r.request.params.get('apos')).toBe('cursor'); expect(r.request.withCredentials).toBeTrue();
        r.flush({ direitos: [], proximoCursor: null });
        http.expectNone(`${base}/recuperacao/sessao`);
    });


});
