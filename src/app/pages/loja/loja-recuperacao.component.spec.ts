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
    beforeEach(() => { api = jasmine.createSpyObj('Biblioteca', ['solicitar', 'confirmar', 'solicitarCodigo', 'validarCodigo']); api.solicitar.and.returnValue(of(undefined)); api.confirmar.and.returnValue(of({})); api.solicitarCodigo.and.returnValue(of(undefined)); api.validarCodigo.and.returnValue(of({})); });
    afterEach(() => { delete window.__istRetirarDesafio; });
    it('valida email, rotulo acessivel e impede envio invalido', () => {
        const f = criar(); const c = f.componentInstance; c.email.setValue('invalido'); c.solicitar(); expect(api.solicitar).not.toHaveBeenCalled();
        const input = f.nativeElement.querySelector('input') as HTMLInputElement; expect(input.id).toBe('recuperacao-email'); expect(f.nativeElement.querySelector('label').htmlFor).toBe(input.id);
    });
    it('envia email e sempre apresenta mensagem uniforme', () => {
        const f = criar(); f.componentInstance.alternarMetodo(); f.componentInstance.email.setValue('comprador@example.invalid'); f.componentInstance.solicitar(); f.detectChanges(); expect(api.solicitar).toHaveBeenCalledOnceWith('comprador@example.invalid'); expect(f.nativeElement.textContent).toContain(MENSAGEM_RECUPERACAO);
    });
    it('bloqueia sobreposicao enquanto envia', () => {
        api.solicitar.and.returnValue(new Subject<void>()); const f = criar(); const c = f.componentInstance; c.alternarMetodo(); c.email.setValue('a@example.invalid'); c.solicitar(); c.solicitar(); expect(api.solicitar).toHaveBeenCalledTimes(1); expect(c.ocupado()).toBeTrue();
    });
    it('rate limit generico sem enumeracao', () => {
        api.solicitar.and.returnValue(throwError(() => new HttpErrorResponse({ status: 429 }))); const c = criar().componentInstance; c.alternarMetodo(); c.email.setValue('a@example.invalid'); c.solicitar(); expect(c.erro()).toContain('Aguarde');
    });
    const pedido = 'aa000000-0000-4000-8000-000000000002';
    function dados(c: LojaRecuperacaoComponent): void { c.email.setValue('comprador@example.invalid'); c.pedido.setValue(pedido); }
    it('OTP exige email e UUID do pedido sem enviar dados invalidos', () => {
        const c = criar().componentInstance; c.email.setValue('a@example.invalid'); c.pedido.setValue('123'); c.solicitar();
        expect(api.solicitarCodigo).not.toHaveBeenCalled(); expect(c.pedido.touched).toBeTrue();
    });
    it('OTP apresenta resposta generica e atributos de entrada numerica sem perder zeros', () => {
        const f = criar(), c = f.componentInstance; dados(c); c.solicitar(); f.detectChanges();
        expect(api.solicitarCodigo).toHaveBeenCalledOnceWith('comprador@example.invalid', pedido);
        expect(f.nativeElement.textContent).toContain(MENSAGEM_RECUPERACAO);
        const input = f.nativeElement.querySelector('#recuperacao-codigo') as HTMLInputElement;
        expect(input.type).toBe('text'); expect(input.inputMode).toBe('numeric'); expect(input.autocomplete).toBe('one-time-code');
        const navegar = spyOn(TestBed.inject(Router), 'navigateByUrl').and.resolveTo(true);
        c.codigo.setValue('012345'); c.validarCodigo();
        expect(api.validarCodigo).toHaveBeenCalledOnceWith(pedido, '012345'); expect(c.codigo.value).toBe('');
        expect(navegar).toHaveBeenCalledWith('/loja/biblioteca', { replaceUrl: true });
    });
    it('OTP aceita apenas seis digitos completos', () => {
        const c = criar().componentInstance; dados(c); c.solicitar();
        for (const v of ['', '12345', '1234567', '12e345', '12 345', 'abcdef']) { c.codigo.setValue(v); c.validarCodigo(); }
        expect(api.validarCodigo).not.toHaveBeenCalled();
    });
    for (const status of [400, 429, 0, 503]) it(`erro OTP ${status} seguro, sem retry, permite nova acao`, () => {
        api.validarCodigo.and.returnValue(throwError(() => new HttpErrorResponse({ status, error: 'SEGREDO' })));
        const c = criar().componentInstance; dados(c); c.solicitar(); c.codigo.setValue('012345'); c.validarCodigo();
        expect(c.erro()).not.toContain('SEGREDO'); expect(c.erro().length).toBeGreaterThan(10); expect(c.ocupado()).toBeFalse();
        expect(api.validarCodigo).toHaveBeenCalledTimes(1); if (status === 400) expect(c.erro()).toContain('expirado');
    });
    it('reenvia para o mesmo pedido sem reaproveitar o codigo digitado', () => {
        const c = criar().componentInstance; dados(c); c.solicitar(); c.codigo.setValue('012345'); c.reenviarCodigo();
        expect(api.solicitarCodigo).toHaveBeenCalledTimes(2); expect(api.solicitarCodigo.calls.mostRecent().args).toEqual(['comprador@example.invalid', pedido]);
        expect(c.codigo.value).toBe(''); expect(api.validarCodigo).not.toHaveBeenCalled();
    });
    it('impede cliques concorrentes durante solicitacao, reenvio e validacao', () => {
        const pendente = new Subject<void>(); api.solicitarCodigo.and.returnValue(pendente);
        const c = criar().componentInstance; dados(c); c.solicitar(); c.solicitar(); c.alternarMetodo();
        expect(api.solicitarCodigo).toHaveBeenCalledTimes(1); expect(c.porLink()).toBeFalse();
        pendente.next(); api.solicitarCodigo.and.returnValue(new Subject<void>()); c.reenviarCodigo(); c.reenviarCodigo();
        expect(api.solicitarCodigo).toHaveBeenCalledTimes(2);
    });
    it('bloqueia validacao concorrente e nao grava OTP em storage ou URL', () => {
        const storage = spyOn(Storage.prototype, 'setItem');
        api.validarCodigo.and.returnValue(new Subject()); const c = criar().componentInstance; const navegar = spyOn(TestBed.inject(Router), 'navigateByUrl').and.resolveTo(true); dados(c); c.solicitar();
        c.codigo.setValue('012345'); c.validarCodigo(); c.validarCodigo(); c.alterarDados();
        expect(api.validarCodigo).toHaveBeenCalledTimes(1); expect(storage).not.toHaveBeenCalled(); expect(navegar).not.toHaveBeenCalled();
        expect(location.href).not.toContain('012345');
    });
    it('erro de rede na solicitacao permite tentar novamente sem confirmar existencia', () => {
        api.solicitarCodigo.and.returnValue(throwError(() => new HttpErrorResponse({ status: 0 })));
        const c = criar().componentInstance; dados(c); c.solicitar(); expect(c.aguardandoCodigo()).toBeFalse(); expect(c.ocupado()).toBeFalse();
        expect(c.mensagem()).toBe(''); expect(c.erro()).toContain('indisponível');
    });
    it('alterar dados descarta contexto OTP e pagina sem fragmento aceita fluxo por codigo', () => {
        const c = criar(true).componentInstance; expect(c.mostrarConfirmacaoLink()).toBeFalse(); dados(c); c.solicitar(); c.alterarDados();
        expect(c.aguardandoCodigo()).toBeFalse(); c.codigo.setValue('012345'); c.validarCodigo(); expect(api.validarCodigo).not.toHaveBeenCalled();
    });
    it('destruicao cancela observacao e limpa dados sem aplicar resposta tardia', () => {
        const pendente = new Subject<void>(); api.solicitarCodigo.and.returnValue(pendente);
        const f = criar(), c = f.componentInstance; dados(c); c.solicitar();
        expect(pendente.observed).toBeTrue(); f.destroy(); expect(pendente.observed).toBeFalse();
        pendente.next(); expect(c.aguardandoCodigo()).toBeFalse(); expect(c.email.value).toBe(''); expect(c.pedido.value).toBe('');
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
