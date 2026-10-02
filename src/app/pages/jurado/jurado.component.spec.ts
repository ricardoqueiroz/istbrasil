import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { AuthService } from '../../shared/auth.service';
import { JuradoAvaliacoesComponent } from './jurado-avaliacoes.component';
import { JuradoEventosComponent } from './jurado-eventos.component';

describe('Paginas de entrada do jurado', () => {
    let http: HttpTestingController;
    const evento = { id: 17, slug: 'evento-teste', nome: 'Evento Autorizado' };

    beforeEach(() => {
        TestBed.configureTestingModule({
            imports: [JuradoAvaliacoesComponent, JuradoEventosComponent],
            providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()]
        });
        TestBed.overrideComponent(JuradoAvaliacoesComponent, {
            add: { providers: [{ provide: ActivatedRoute, useValue: { paramMap: of(convertToParamMap({ slug: evento.slug })) } }] }
        });
        http = TestBed.inject(HttpTestingController);
    });

    afterEach(() => http.verify());

    it('mostra nome do evento obtido pelo endpoint e jurado da sessao', () => {
        TestBed.inject(AuthService).definirUsuario({ id_usuario: 10, id_tipo_usuario: 3, nome: 'Nome do Jurado', foto_url: null });
        const fixture = TestBed.createComponent(JuradoAvaliacoesComponent);
        fixture.detectChanges();
        expect(fixture.nativeElement.textContent).toContain('Carregando evento');
        http.expectOne(`/api/jurado/eventos/${evento.slug}`).flush({ evento });
        fixture.detectChanges();
        const texto = fixture.nativeElement.textContent;
        expect(texto).toContain('Avalia\u00e7\u00e3o dos Concorrentes');
        expect(texto).toContain(evento.nome);
        expect(texto).toContain('Nome do Jurado');
        expect(fixture.nativeElement.querySelector('table')).toBeNull();
    });

    for (const status of [401, 403, 404, 500]) {
        it(`falha ${status} ao carregar o evento redireciona com seguranca`, () => {
            const navigate = spyOn(TestBed.inject(Router), 'navigate').and.resolveTo(true);
            const fixture = TestBed.createComponent(JuradoAvaliacoesComponent);
            fixture.detectChanges();
            http.expectOne(`/api/jurado/eventos/${evento.slug}`).flush({}, { status, statusText: 'Erro' });
            expect(navigate).toHaveBeenCalledWith([status === 401 ? '/login' : '/']);
        });
    }

    it('evento ausente no endpoint redireciona para a raiz', () => {
        const navigate = spyOn(TestBed.inject(Router), 'navigate').and.resolveTo(true);
        const fixture = TestBed.createComponent(JuradoAvaliacoesComponent);
        fixture.detectChanges();
        http.expectOne(`/api/jurado/eventos/${evento.slug}`).flush({});
        expect(navigate).toHaveBeenCalledWith(['/']);
    });

    it('selecao lista exclusivamente os eventos do backend e seus destinos', () => {
        const fixture = TestBed.createComponent(JuradoEventosComponent);
        fixture.detectChanges();
        http.expectOne('/api/jurado/acessos').flush({ eventos: [evento, { id: 28, slug: 'outro-evento', nome: 'Outro Evento' }] });
        fixture.detectChanges();
        const links = fixture.nativeElement.querySelectorAll('a');
        expect(links.length).toBe(2);
        expect(links[0].textContent).toContain(evento.nome);
        expect(links[0].getAttribute('href')).toBe('/jurado/evento-teste/avaliacoes');
        expect(links[1].getAttribute('href')).toBe('/jurado/outro-evento/avaliacoes');
    });

    it('selecao vazia nao inventa eventos', () => {
        const fixture = TestBed.createComponent(JuradoEventosComponent);
        fixture.detectChanges();
        http.expectOne('/api/jurado/acessos').flush({ eventos: [] });
        fixture.detectChanges();
        expect(fixture.nativeElement.querySelectorAll('a').length).toBe(0);
        expect(fixture.nativeElement.textContent).toContain('Nenhum evento');
    });
});