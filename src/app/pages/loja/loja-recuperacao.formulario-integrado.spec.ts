import { provideZoneChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { LojaBibliotecaService } from '../../services/loja-biblioteca.service';
import { LojaRecuperacaoComponent } from './loja-recuperacao.component';

describe('D7.4 submissao real do formulario de recuperacao', () => {
    it('submit HTML deve chamar a API e impedir navegacao nativa', () => {
        const api = jasmine.createSpyObj<LojaBibliotecaService>('Biblioteca', ['solicitar']);
        api.solicitar.and.returnValue(of(undefined));
        TestBed.configureTestingModule({ imports: [LojaRecuperacaoComponent], providers: [provideZoneChangeDetection(), provideRouter([]),
            { provide: ActivatedRoute, useValue: { snapshot: { data: {} } } }, { provide: LojaBibliotecaService, useValue: api }] });
        const fixture = TestBed.createComponent(LojaRecuperacaoComponent);
        fixture.componentInstance.alternarMetodo();
        fixture.componentInstance.email.setValue('sintetico@example.invalid'); fixture.detectChanges();
        const evento = new Event('submit', { bubbles: true, cancelable: true });
        fixture.nativeElement.querySelector('form').dispatchEvent(evento);
        expect(api.solicitar).toHaveBeenCalledOnceWith('sintetico@example.invalid');
        expect(evento.defaultPrevented).toBeTrue();
    });
    it('submit OTP preserva zeros e confirma apenas apos acao explicita', () => {
        const api = jasmine.createSpyObj<LojaBibliotecaService>('Biblioteca', ['solicitarCodigo', 'validarCodigo']);
        api.solicitarCodigo.and.returnValue(of(undefined)); api.validarCodigo.and.returnValue(of({}));
        TestBed.configureTestingModule({ imports: [LojaRecuperacaoComponent], providers: [provideZoneChangeDetection(), provideRouter([]),
            { provide: ActivatedRoute, useValue: { snapshot: { data: {} } } }, { provide: LojaBibliotecaService, useValue: api }] });
        const fixture = TestBed.createComponent(LojaRecuperacaoComponent), c = fixture.componentInstance;
        const navegar = spyOn(TestBed.inject(Router), 'navigateByUrl').and.resolveTo(true);
        c.email.setValue('sintetico@example.invalid'); c.pedido.setValue('aa000000-0000-4000-8000-000000000001'); fixture.detectChanges();
        const solicitar = new Event('submit', { bubbles: true, cancelable: true });
        fixture.nativeElement.querySelector('form').dispatchEvent(solicitar); fixture.detectChanges();
        expect(solicitar.defaultPrevented).toBeTrue(); expect(api.solicitarCodigo).toHaveBeenCalledTimes(1);
        expect(api.validarCodigo).not.toHaveBeenCalled();
        const input = fixture.nativeElement.querySelector('#recuperacao-codigo') as HTMLInputElement;
        input.value = '012345'; input.dispatchEvent(new Event('input')); fixture.detectChanges();
        const confirmar = new Event('submit', { bubbles: true, cancelable: true });
        fixture.nativeElement.querySelector('form').dispatchEvent(confirmar);
        expect(confirmar.defaultPrevented).toBeTrue(); expect(api.validarCodigo).toHaveBeenCalledOnceWith(c.pedido.value, '012345');
        expect(navegar).toHaveBeenCalledWith('/loja/biblioteca', { replaceUrl: true });
    });

});
