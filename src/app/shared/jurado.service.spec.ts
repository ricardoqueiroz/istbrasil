import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { JuradoService } from './jurado.service';

describe('JuradoService', () => {
    let service: JuradoService;
    let http: HttpTestingController;
    const evento = { id: 17, slug: 'evento-teste', nome: 'Evento Teste' };

    beforeEach(() => {
        TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
        service = TestBed.inject(JuradoService);
        http = TestBed.inject(HttpTestingController);
    });

    afterEach(() => http.verify());

    it('consulta acessos com credenciais', () => {
        service.listarAcessos().subscribe((resposta) => expect(resposta.eventos).toEqual([evento]));
        const request = http.expectOne('/api/jurado/acessos');
        expect(request.request.method).toBe('GET');
        expect(request.request.withCredentials).toBeTrue();
        request.flush({ eventos: [evento] });
    });

    it('consulta evento usando somente o slug codificado e credenciais', () => {
        service.obterEvento('evento/teste').subscribe((resposta) => expect(resposta.evento).toEqual(evento));
        const request = http.expectOne('/api/jurado/eventos/evento%2Fteste');
        expect(request.request.withCredentials).toBeTrue();
        request.flush({ evento });
    });

    it('zero eventos direciona para a raiz', () => {
        service.destinoAposLogin().subscribe((destino) => expect(destino).toEqual(['/']));
        http.expectOne('/api/jurado/acessos').flush({ eventos: [] });
    });

    it('um evento direciona para suas avaliacoes', () => {
        service.destinoAposLogin().subscribe((destino) => expect(destino).toEqual(['/jurado', evento.slug, 'avaliacoes']));
        http.expectOne('/api/jurado/acessos').flush({ eventos: [evento] });
    });

    it('multiplos eventos direcionam para a selecao', () => {
        service.destinoAposLogin().subscribe((destino) => expect(destino).toEqual(['/jurado']));
        http.expectOne('/api/jurado/acessos').flush({ eventos: [evento, { ...evento, id: 28, slug: 'outro' }] });
    });

    it('falha nos acessos retorna a raiz sem emitir erro', () => {
        service.destinoAposLogin().subscribe({
            next: (destino) => expect(destino).toEqual(['/']),
            error: () => fail('A consulta de acessos nao deve falhar o login')
        });
        http.expectOne('/api/jurado/acessos').flush({}, { status: 500, statusText: 'Server Error' });
    });
});