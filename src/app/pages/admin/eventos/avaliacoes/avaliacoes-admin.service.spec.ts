import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { AvaliacoesAdminResponse } from './avaliacoes-admin.model';
import { AvaliacoesAdminService } from './avaliacoes-admin.service';

describe('AvaliacoesAdminService', () => {
    let service: AvaliacoesAdminService;
    let http: HttpTestingController;
    beforeEach(() => {
        TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
        service = TestBed.inject(AvaliacoesAdminService);
        http = TestBed.inject(HttpTestingController);
    });
    afterEach(() => http.verify());

    it('GET codifica slug, envia quatro parametros e credenciais sem transformar DTO', () => {
        const dto: AvaliacoesAdminResponse = { evento: { id: 12, slug: 'evento/teste', nome: 'Evento' }, jurados: { totalAtuais: 0 }, data: [], pagination: { page: 2, limit: 50, total: 0, totalPages: 0 } };
        service.listarAndamento('evento/teste', { page: 2, limit: 50, sortField: 'nome', sortOrder: 'desc' }).subscribe(response => expect(response).toBe(dto));
        const request = http.expectOne(req => req.url === '/api/admin/eventos/evento%2Fteste/avaliacoes');
        expect(request.request.method).toBe('GET');
        expect(request.request.withCredentials).toBeTrue();
        expect(request.request.body).toBeNull();
        expect(request.request.params.keys()).toEqual(['page', 'limit', 'sortField', 'sortOrder']);
        expect(request.request.params.get('page')).toBe('2');
        expect(request.request.params.get('limit')).toBe('50');
        expect(request.request.params.get('sortField')).toBe('nome');
        expect(request.request.params.get('sortOrder')).toBe('desc');
        request.flush(dto);
    });

    for (const status of [401, 403, 404, 409, 500]) it(`propaga ${status} sem retry ou resultado fabricado`, () => {
        const error = jasmine.createSpy('error');
        service.listarAndamento('teste', { page: 1, limit: 25, sortField: 'numeroConcorrente', sortOrder: 'asc' }).subscribe({ next: () => fail('Erro nao pode emitir dados'), error });
        http.expectOne(req => req.url === '/api/admin/eventos/teste/avaliacoes').flush({ message: 'SQL interno' }, { status, statusText: 'Erro' });
        expect(error).toHaveBeenCalledTimes(1);
        expect(error.calls.mostRecent().args[0].status).toBe(status);
        http.expectNone(req => req.url.includes('/api/admin'));
    });

    it('propaga erro de rede sem retry', () => {
        const error = jasmine.createSpy('error');
        service.listarAndamento('teste', { page: 1, limit: 25, sortField: 'numeroConcorrente', sortOrder: 'asc' }).subscribe({ next: () => fail('Erro nao pode emitir dados'), error });
        http.expectOne(req => req.url === '/api/admin/eventos/teste/avaliacoes').error(new ProgressEvent('error'));
        expect(error).toHaveBeenCalledTimes(1);
        expect(error.calls.mostRecent().args[0].status).toBe(0);
        http.expectNone(req => req.url.includes('/api/admin'));
    });
});