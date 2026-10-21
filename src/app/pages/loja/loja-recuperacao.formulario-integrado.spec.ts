import { provideZoneChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, provideRouter } from '@angular/router';
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
        fixture.componentInstance.email.setValue('sintetico@example.invalid'); fixture.detectChanges();
        const evento = new Event('submit', { bubbles: true, cancelable: true });
        fixture.nativeElement.querySelector('form').dispatchEvent(evento);
        expect(api.solicitar).toHaveBeenCalledOnceWith('sintetico@example.invalid');
        expect(evento.defaultPrevented).toBeTrue();
    });
});
