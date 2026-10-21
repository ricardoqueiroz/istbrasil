import { provideZoneChangeDetection } from '@angular/core';
import { TestBed, fakeAsync, tick } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { HttpErrorResponse } from '@angular/common/http';
import { Subject, of, throwError } from 'rxjs';
import { DireitoBiblioteca, LojaBibliotecaService } from '../../services/loja-biblioteca.service';
import { LojaBibliotecaComponent } from './loja-biblioteca.component';

describe('Biblioteca unica Angular', () => {
    let api: jasmine.SpyObj<LojaBibliotecaService>;
    const ativo: DireitoBiblioteca = { publicId: 'id', titulo: 'Livro sintético', estado: 'ATIVO', podeSolicitarArquivo: true };
    beforeEach(() => {
        api = jasmine.createSpyObj('Biblioteca', ['listar', 'sessao', 'reavaliar', 'arquivo', 'revogar']);
        api.listar.and.returnValue(of({ direitos: [], proximoCursor: null })); api.sessao.and.returnValue(of({ sessao: { autenticada: false }, csrfToken: 'csrf' }));
        api.reavaliar.and.returnValue(of({ publicId: 'id', estado: 'ATIVO' })); api.revogar.and.returnValue(of({ revogada: true }));
        TestBed.configureTestingModule({ imports: [LojaBibliotecaComponent], providers: [provideZoneChangeDetection(), provideRouter([]), { provide: LojaBibliotecaService, useValue: api }] });
    });
    const criar = () => { const f = TestBed.createComponent(LojaBibliotecaComponent); f.detectChanges(); return f; };
    it('lista vazia nao reavalia nem baixa automaticamente', () => {
        const f = criar(); expect(f.nativeElement.textContent).toContain('Nenhum e-book'); expect(api.reavaliar).not.toHaveBeenCalled(); expect(api.arquivo).not.toHaveBeenCalled();
    });
    it('pagina usa cursor e pode voltar sem misturar escopos', () => {
        api.listar.and.returnValue(of({ direitos: [ativo], proximoCursor: 'pagina2' })); const c = criar().componentInstance; c.avancar(); expect(api.listar).toHaveBeenCalledWith('pagina2'); c.anterior(); expect(api.listar.calls.mostRecent().args[0]).toBeUndefined();
    });
    it('ativo permite download e titulo e renderizado como texto', () => {
        api.listar.and.returnValue(of({ direitos: [{ ...ativo, titulo: '<script>privado</script>' }], proximoCursor: null })); const f = criar();
        expect(f.nativeElement.textContent).toContain('Download disponível'); expect(f.nativeElement.querySelector('section script')).toBeNull();
        expect(f.nativeElement.querySelector('button[aria-label="Baixar <script>privado</script>"]')).not.toBeNull();
    });
    for (const estado of ['SUSPENSO', 'REVOGADO', 'AGUARDANDO_CONFIRMACAO'] as const) it(`${estado} nao baixa nem autoativa`, () => {
        const d = { ...ativo, estado, podeSolicitarArquivo: false }; api.listar.and.returnValue(of({ direitos: [d], proximoCursor: null })); const f = criar(); f.componentInstance.baixar(d);
        expect(api.arquivo).not.toHaveBeenCalled(); expect(api.reavaliar).not.toHaveBeenCalled(); expect(f.nativeElement.querySelector('button[aria-label^="Baixar"]')).toBeNull();
    });
    it('reavaliacao somente explicita e atualiza lista', () => {
        const c = criar().componentInstance; expect(api.reavaliar).not.toHaveBeenCalled(); c.reavaliar({ ...ativo, estado: 'AGUARDANDO_CONFIRMACAO' }); expect(api.reavaliar).toHaveBeenCalledOnceWith('id'); expect(api.listar).toHaveBeenCalledTimes(2);
    });
    it('download Blob cria URL temporaria e revoga; sem persistencia', fakeAsync(() => {
        api.arquivo.and.returnValue(of(new Blob(['%PDF-sintetico'], { type: 'application/pdf' })));
        const criarUrl = spyOn(URL, 'createObjectURL').and.returnValue('blob:sintetico'), revogar = spyOn(URL, 'revokeObjectURL'), clicar = spyOn(HTMLAnchorElement.prototype, 'click');
        const storage = spyOn(Storage.prototype, 'setItem'); const c = criar().componentInstance; c.baixar(ativo); expect(criarUrl).toHaveBeenCalledTimes(1); expect(clicar).toHaveBeenCalledTimes(1); tick(1000); expect(revogar).toHaveBeenCalledWith('blob:sintetico'); expect(storage).not.toHaveBeenCalled();
    }));
    it('ngOnDestroy libera URL e cancela requisicao em andamento', () => {
        api.arquivo.and.returnValue(of(new Blob(['%PDF'], { type: 'application/pdf' }))); spyOn(URL, 'createObjectURL').and.returnValue('blob:destruir'); spyOn(HTMLAnchorElement.prototype, 'click'); const r = spyOn(URL, 'revokeObjectURL');
        const f = criar(); f.componentInstance.baixar(ativo); f.destroy(); expect(r).toHaveBeenCalledWith('blob:destruir');
    });
    it('falha download sanitizada sem retry nem URL', () => {
        api.arquivo.and.returnValue(throwError(() => new HttpErrorResponse({ status: 503, error: '/privado/segredo.pdf' }))); const url = spyOn(URL, 'createObjectURL'); const c = criar().componentInstance; c.baixar(ativo); expect(c.erro()).not.toContain('segredo'); expect(url).not.toHaveBeenCalled(); expect(api.arquivo).toHaveBeenCalledTimes(1);
    });
    it('limita operacoes a uma de cada vez', () => {
        api.arquivo.and.returnValue(new Subject<Blob>()); const c = criar().componentInstance; c.baixar(ativo); c.baixar(ativo); c.carregar(); expect(api.arquivo).toHaveBeenCalledTimes(1); expect(api.listar).toHaveBeenCalledTimes(1);
    });
    it('sessao expirada limpa dados e oferece recuperacao', () => {
        api.listar.and.returnValue(throwError(() => new HttpErrorResponse({ status: 401 }))); const f = criar(); expect(f.componentInstance.direitos()).toEqual([]); expect(f.nativeElement.textContent).toContain('Sessão expirada'); expect(f.nativeElement.querySelector('a[href="/loja/biblioteca/recuperar"]')).not.toBeNull();
    });
    it('revoga recuperacao sem acao sobre compra e limpa biblioteca', () => {
        api.sessao.and.returnValue(of({ sessao: { autenticada: true }, csrfToken: 'csrf' })); api.listar.and.returnValue(of({ direitos: [ativo], proximoCursor: null })); const c = criar().componentInstance; c.encerrar(); expect(api.revogar).toHaveBeenCalledTimes(1); expect(c.direitos()).toEqual([]); expect(c.aviso()).toContain('compra foi preservada');
    });
    it('sessao original nao oferece revogacao nem chama endpoint', () => { const f = criar(); f.componentInstance.encerrar(); expect(api.revogar).not.toHaveBeenCalled(); expect(f.nativeElement.textContent).not.toContain('Encerrar sessão recuperada'); });
    it('regioes e navegacao possuem nomes acessiveis', () => { const f = criar(); expect(f.nativeElement.querySelector('main').getAttribute('aria-labelledby')).toBe('biblioteca-titulo'); expect(f.nativeElement.querySelector('nav[aria-label="Páginas da biblioteca"]')).not.toBeNull(); });
});
