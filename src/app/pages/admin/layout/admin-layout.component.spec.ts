import { provideZoneChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { AuthService } from '../../../shared/auth.service';
import { AdminLayoutComponent } from './admin-layout.component';

describe('Navegação administrativa institucional', () => {
    it('preserva os links institucionais e remove a loja', () => {
        TestBed.configureTestingModule({ imports: [AdminLayoutComponent], providers: [provideZoneChangeDetection(), provideRouter([])] });
        TestBed.inject(AuthService).carregando.set(false);
        const fixture = TestBed.createComponent(AdminLayoutComponent);
        fixture.detectChanges();
        const el: HTMLElement = fixture.nativeElement;
        expect(el.querySelector('a[href="/admin"]')).not.toBeNull();
        expect(el.querySelector('a[href="/admin/cadastros/listar"]')).not.toBeNull();
        expect(el.querySelector('a[href="/admin/emails/assinaturas"]')).not.toBeNull();
        expect(el.querySelector('a[href="/admin/emails/modelos"]')).not.toBeNull();
        expect(el.querySelector('a[href^="/admin/loja"]')).toBeNull();
    });
});
