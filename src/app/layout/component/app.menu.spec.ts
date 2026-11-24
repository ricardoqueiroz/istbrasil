import { provideZoneChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideAnimations } from '@angular/platform-browser/animations';
import { provideRouter } from '@angular/router';
import { AppMenu } from './app.menu';

describe('Navegação da Editora e da loja', () => {
    it('mantém a Editora no portal e direciona a loja para o site independente', () => {
        TestBed.configureTestingModule({
            imports: [AppMenu],
            providers: [provideZoneChangeDetection(), provideRouter([]), provideAnimations()]
        });
        const fixture = TestBed.createComponent(AppMenu);
        fixture.detectChanges();
        const links = Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('a'));
        const editora = links.find(link => link.textContent?.includes('IST Editora'));
        const loja = links.find(link => link.textContent?.includes('Loja Virtual'));
        expect(editora?.getAttribute('href')).toBe('/editora');
        expect(loja?.getAttribute('href')).toBe('https://loja.istbrasil.org.br/');
    });
});
