import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { ConcorrenteJuradoResponse, FilaJuradoResponse, JuradoService } from './jurado.service';

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

    it('consulta fila com slug codificado, credenciais e defaults', () => {
        const resposta: FilaJuradoResponse = { evento, concorrentes: [], pagination: { page: 1, limit: 25, total: 0, totalPages: 0 } };
        service.listarConcorrentes('evento/teste').subscribe((fila) => expect(fila).toEqual(resposta));
        const request = http.expectOne((req) => req.url === '/api/jurado/eventos/evento%2Fteste/concorrentes');
        expect(request.request.method).toBe('GET');
        expect(request.request.withCredentials).toBeTrue();
        expect(request.request.params.keys()).toEqual(['page', 'limit', 'sort', 'order']);
        expect(request.request.params.get('page')).toBe('1');
        expect(request.request.params.get('limit')).toBe('25');
        expect(request.request.params.get('sort')).toBe('numeroConcorrente');
        expect(request.request.params.get('order')).toBe('asc');
        request.flush(resposta);
    });

    it('envia os quatro parametros fornecidos sem alterar o contrato', () => {
        const resposta: FilaJuradoResponse = {
            evento,
            concorrentes: [{
                idParticipacao: 20, numeroConcorrente: 'FVST2-020', nome: 'Concorrente', cidade: null, uf: null,
                dataInscricao: '2026-10-02T12:00:00.000Z', obraPrincipal: { id: 22, titulo: 'Obra' },
                linkVideoPrincipal: 'https://youtu.be/abcdefghijk', obraOpcional: null, linkVideoOpcional: null
            }],
            pagination: { page: 3, limit: 50, total: 101, totalPages: 3 }
        };
        service.listarConcorrentes(evento.slug, { page: 3, limit: 50, sort: 'nome', order: 'desc' }).subscribe((fila) => expect(fila).toEqual(resposta));
        const request = http.expectOne((req) => req.url.endsWith('/concorrentes'));
        expect(request.request.params.get('page')).toBe('3');
        expect(request.request.params.get('limit')).toBe('50');
        expect(request.request.params.get('sort')).toBe('nome');
        expect(request.request.params.get('order')).toBe('desc');
        request.flush(resposta);
    });

    it('envia ordenacao por data e preserva defaults nao fornecidos', () => {
        service.listarConcorrentes(evento.slug, { sort: 'dataInscricao', limit: 100 }).subscribe();
        const request = http.expectOne((req) => req.url.endsWith('/concorrentes'));
        expect(request.request.params.get('page')).toBe('1');
        expect(request.request.params.get('limit')).toBe('100');
        expect(request.request.params.get('sort')).toBe('dataInscricao');
        expect(request.request.params.get('order')).toBe('asc');
        request.flush({ evento, concorrentes: [], pagination: { page: 1, limit: 100, total: 0, totalPages: 0 } });
    });

    it('propaga falha da fila sem transforma-la em lista vazia', () => {
        service.listarConcorrentes(evento.slug).subscribe({
            next: () => fail('Erro HTTP nao deve emitir fila vazia'),
            error: (error) => expect(error.status).toBe(500)
        });
        http.expectOne((req) => req.url.endsWith('/concorrentes')).flush({}, { status: 500, statusText: 'Erro' });
    });

    it('consulta detalhe pela PK, codifica slug e envia credenciais sem id_evento', () => {
        const resposta: ConcorrenteJuradoResponse = {
            evento,
            concorrente: {
                idParticipacao: 20, numeroConcorrente: 'FVST2-020', nome: 'Concorrente', cidade: null, uf: null,
                dataInscricao: '2026-10-02T12:00:00.000Z', obraPrincipal: { id: 22, titulo: 'Obra' },
                linkVideoPrincipal: 'https://youtu.be/abcdefghijk', obraOpcional: null, linkVideoOpcional: null
            }
        };
        service.obterConcorrente('evento/teste', 20).subscribe((detalhe) => expect(detalhe).toEqual(resposta));
        const request = http.expectOne('/api/jurado/eventos/evento%2Fteste/concorrentes/20');
        expect(request.request.method).toBe('GET');
        expect(request.request.withCredentials).toBeTrue();
        expect(request.request.params.keys()).toEqual([]);
        request.flush(resposta);
    });

    it('propaga 404 do detalhe sem fabricar concorrente', () => {
        service.obterConcorrente(evento.slug, 20).subscribe({ next: () => fail('Erro nao pode emitir concorrente'), error: (error) => expect(error.status).toBe(404) });
        http.expectOne(`/api/jurado/eventos/${evento.slug}/concorrentes/20`).flush({}, { status: 404, statusText: 'Not Found' });
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