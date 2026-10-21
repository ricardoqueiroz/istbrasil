import { provideZoneChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, provideRouter } from '@angular/router';
import { HttpErrorResponse } from '@angular/common/http';
import { Subject, of, throwError } from 'rxjs';
import { LojaBibliotecaService, MENSAGEM_RECUPERACAO } from '../../services/loja-biblioteca.service';
import { LojaRecuperacaoComponent, retirarDesafio } from './loja-recuperacao.component';

describe('Recuperacao Angular', () => {
    const desafio = { publicId: 'aa000000-0000-4000-8000-000000000001', segredo: 'A'.repeat(43) };
    let api: jasmine.SpyObj<LojaBibliotecaService>;
    function criar(confirmar = false) {
        TestBed.configureTestingModule({ imports: [LojaRecuperacaoComponent], providers: [provideZoneChangeDetection(), provideRouter([]),
            { provide: ActivatedRoute, useValue: { snapshot: { data: { confirmar } } } }, { provide: LojaBibliotecaService, useValue: api }] });
        const f = TestBed.createComponent(LojaRecuperacaoComponent); f.detectChanges(); return f;
    }
    beforeEach(() => { api = jasmine.createSpyObj('Biblioteca', ['solicitar', 'confirmar']); api.solicitar.and.returnValue(of(undefined)); api.confirmar.and.returnValue(of({})); });
    afterEach(() => { delete window.__istRetirarDesafio; });
    it('valida email, rotulo acessivel e impede envio invalido', () => {
        const f = criar(); const c = f.componentInstance; c.email.setValue('invalido'); c.solicitar(); expect(api.solicitar).not.toHaveBeenCalled();
        const input = f.nativeElement.querySelector('input') as HTMLInputElement; expect(input.id).toBe('recuperacao-email'); expect(f.nativeElement.querySelector('label').htmlFor).toBe(input.id);
    });
    it('envia email e sempre apresenta mensagem uniforme', () => {
        const f = criar(); f.componentInstance.email.setValue('comprador@example.invalid'); f.componentInstance.solicitar(); f.detectChanges(); expect(api.solicitar).toHaveBeenCalledOnceWith('comprador@example.invalid'); expect(f.nativeElement.textContent).toContain(MENSAGEM_RECUPERACAO);
    });
    it('bloqueia sobreposicao enquanto envia', () => {
        api.solicitar.and.returnValue(new Subject<void>()); const f = criar(); const c = f.componentInstance; c.email.setValue('a@example.invalid'); c.solicitar(); c.solicitar(); expect(api.solicitar).toHaveBeenCalledTimes(1); expect(c.ocupado()).toBeTrue();
    });
    it('rate limit generico sem enumeracao', () => {
        api.solicitar.and.returnValue(throwError(() => new HttpErrorResponse({ status: 429 }))); const c = criar().componentInstance; c.email.setValue('a@example.invalid'); c.solicitar(); expect(c.erro()).toContain('Aguarde');
    });
    it('retira desafio em memoria e nao consome automaticamente', () => {
        window.__istRetirarDesafio = () => desafio; const f = criar(true); expect(f.componentInstance.temDesafio()).toBeTrue(); expect(api.confirmar).not.toHaveBeenCalled();
    });
    it('confirmacao exige clique e navega com replaceUrl apos sucesso', () => {
        window.__istRetirarDesafio = () => desafio; const f = criar(true), router = TestBed.inject(Router); const navegar = spyOn(router, 'navigateByUrl').and.resolveTo(true);
        f.nativeElement.querySelector('p-button button').click(); expect(api.confirmar).toHaveBeenCalledOnceWith(desafio); expect(navegar).toHaveBeenCalledWith('/loja/biblioteca', { replaceUrl: true });
    });
    for (const causa of ['invalido', 'expirado', 'reutilizado']) it(`link ${causa} recebe mensagem segura sem repetir`, () => {
        window.__istRetirarDesafio = () => desafio; api.confirmar.and.returnValue(throwError(() => new HttpErrorResponse({ status: 400, error: { segredo: desafio.segredo } })));
        const c = criar(true).componentInstance; c.confirmar(); c.confirmar(); expect(api.confirmar).toHaveBeenCalledTimes(1); expect(c.erro()).toContain('expirado'); expect(c.erro()).not.toContain(desafio.segredo);
    });
    it('sem fragmento nao permite confirmar', () => { const c = criar(true).componentInstance; c.confirmar(); expect(c.temDesafio()).toBeFalse(); expect(api.confirmar).not.toHaveBeenCalled(); });
    it('le fragmento e limpa URL antes de retornar; nao usa storage', () => {
        const original = window.location.pathname + window.location.search + window.location.hash;
        const storage = spyOn(Storage.prototype, 'setItem');
        try { history.replaceState(null, '', '/loja/recuperar#id=' + desafio.publicId + '&segredo=' + desafio.segredo);
            expect(retirarDesafio()).toEqual(desafio); expect(location.hash).toBe(''); expect(storage).not.toHaveBeenCalled(); expect(retirarDesafio()).toBeNull();
        } finally { history.replaceState(null, '', original); }
    });
    it('fragmento duplicado e query nao sao autoridade', () => {
        const original = location.pathname + location.search;
        try { history.replaceState(null, '', '/loja/recuperar?segredo=NAO#id=' + desafio.publicId + '&segredo=' + desafio.segredo + '&segredo=B');
            expect(retirarDesafio()).toBeNull(); expect(location.search).toBe(''); expect(location.hash).toBe('');
        } finally { history.replaceState(null, '', original); }
    });
});
