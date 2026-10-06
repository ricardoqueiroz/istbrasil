import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { AvaliacaoJuradoResponse, ConcorrenteJuradoResponse, FilaJuradoResponse, JuradoService, SalvarAvaliacaoJuradoPayload } from './jurado.service';

describe('JuradoService', () => {
    let service: JuradoService;
    let http: HttpTestingController;
    const evento = { id: 17, slug: 'evento-teste', nome: 'Evento Teste' };
    const dadosAvaliacao = {
        evento,
        concorrente: { idParticipacao: 20, idSnapshot: 320, numeroConcorrente: 'FVST2-020', nome: 'Frozen participant',
            obraPrincipal: { id: 22, titulo: 'Frozen work' }, linkVideoPrincipal: 'https://example.invalid/frozen',
            obraOpcional: null, linkVideoOpcional: null },
        contexto: { idCiclo: 100, numeroCiclo: 1, numeroTentativa: null },
        podeGravar: true,
        autorizacaoGravacao: { estado: 'autorizada', code: null, motivo: null },
        escala: { min: 0, max: 100, passo: 1 },
        criterios: [
            { idCriterio: 111, idCriterioOrigem: 111, idCriterioCiclo: 11, nome: 'Primeiro criterio', descricao: null, ordem: 1, peso: '40.00' },
            { idCriterio: 128, idCriterioOrigem: 128, idCriterioCiclo: 28, nome: 'Segundo criterio', descricao: 'Descricao do criterio', ordem: 2, peso: '60.00' }
        ]
    };
    const respostasPersistidas: AvaliacaoJuradoResponse[] = (['rascunho', 'concluida'] as const).map((estado) => ({
        ...dadosAvaliacao,
        contexto: { idCiclo: 100, numeroCiclo: 1, numeroTentativa: 1 },
        podeGravar: estado === 'rascunho',
        autorizacaoGravacao: estado === 'rascunho'
            ? { estado: 'autorizada', code: null, motivo: null }
            : { estado: 'avaliacao_concluida', code: 'AVALIACAO_CONCLUIDA', motivo: 'AVALIACAO_CONCLUIDA' },
        estado,
        versao: 3,
        avaliacao: {
            idAvaliacao: 50,
            notas: [{ idCriterio: 111, idCriterioOrigem: 111, idCriterioCiclo: 11, nota: 35 },
                { idCriterio: 128, idCriterioOrigem: 128, idCriterioCiclo: 28, nota: 65 }],
            possivelDesclassificacao: true,
            motivoDesclassificacao: 'Analise do video',
            media: '53.00',
            dataInclusao: '2026-10-03T12:00:00.000Z',
            dataAtualizacao: '2026-10-04T12:00:00.000Z',
            dataConclusao: estado === 'concluida' ? '2026-10-04T12:00:00.000Z' : null
        }
    }));
    const respostasAvaliacao: AvaliacaoJuradoResponse[] = [
        { ...dadosAvaliacao, estado: 'pendente', versao: 0, avaliacao: null },
        ...respostasPersistidas
    ];

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

    for (const respostaEsperada of respostasAvaliacao) {
        it(`consulta avaliacao ${respostaEsperada.estado} com slug codificado e retorna DTO sem transformar`, () => {
            service.obterAvaliacao('evento/teste', 20).subscribe((resposta) => expect(resposta).toBe(respostaEsperada));
            const request = http.expectOne('/api/jurado/eventos/evento%2Fteste/concorrentes/20/avaliacao');
            expect(request.request.method).toBe('GET');
            expect(request.request.withCredentials).toBeTrue();
            expect(request.request.params.keys()).toEqual([]);
            expect(request.request.body).toBeNull();
            request.flush(respostaEsperada);
            http.expectNone((req) => req.url.includes('/api/jurado'));
        });
    }

    for (const respostaEsperada of respostasPersistidas) {
        it(`salva avaliacao ${respostaEsperada.estado} sem modificar payload nem consultar novamente`, () => {
            if (respostaEsperada.estado === 'pendente') throw new Error('Fixture deve representar uma avaliacao persistida');
            const payload: SalvarAvaliacaoJuradoPayload = {
                contexto: { idCiclo: 100, numeroTentativa: 1 },
                versao: 2,
                estado: respostaEsperada.estado,
                notas: [{ idCriterioCiclo: 11, nota: 35 }, { idCriterioCiclo: 28, nota: 65 }],
                possivelDesclassificacao: true,
                motivoDesclassificacao: '  Analise do video  '
            };
            const antes = JSON.stringify(payload);
            payload.notas.forEach((nota) => Object.freeze(nota));
            Object.freeze(payload.notas);
            Object.freeze(payload);
            service.salvarAvaliacao('evento/teste', 20, payload).subscribe((resposta) => expect(resposta).toBe(respostaEsperada));
            const request = http.expectOne('/api/jurado/eventos/evento%2Fteste/concorrentes/20/avaliacao');
            expect(request.request.method).toBe('PUT');
            expect(request.request.withCredentials).toBeTrue();
            expect(request.request.params.keys()).toEqual([]);
            expect(request.request.body).toBe(payload);
            expect(request.request.body).toEqual({
                contexto: { idCiclo: 100, numeroTentativa: 1 },
                versao: 2,
                estado: respostaEsperada.estado,
                notas: [{ idCriterioCiclo: 11, nota: 35 }, { idCriterioCiclo: 28, nota: 65 }],
                possivelDesclassificacao: true,
                motivoDesclassificacao: '  Analise do video  '
            });
            request.flush(respostaEsperada);
            expect(JSON.stringify(payload)).toBe(antes);
            http.expectNone((req) => req.url.includes('/api/jurado'));
        });
    }

    for (const status of [400, 401, 403, 404, 409, 500]) {
        it(`GET avaliacao propaga ${status} sem fallback ou retry`, () => {
            const erro = jasmine.createSpy('erro');
            service.obterAvaliacao(evento.slug, 20).subscribe({ next: () => fail('Erro nao deve emitir avaliacao'), error: erro });
            const request = http.expectOne(`/api/jurado/eventos/${evento.slug}/concorrentes/20/avaliacao`);
            request.flush({ message: 'Falha de avaliacao' }, { status, statusText: 'Erro' });
            expect(erro).toHaveBeenCalledTimes(1);
            expect(erro.calls.mostRecent().args[0].status).toBe(status);
            expect(erro.calls.mostRecent().args[0].error).toEqual({ message: 'Falha de avaliacao' });
            http.expectNone((req) => req.url.includes('/api/jurado'));
        });

        it(`PUT avaliacao propaga ${status} sem retry ou GET automatico`, () => {
            const payload: SalvarAvaliacaoJuradoPayload = { contexto: { idCiclo: 100, numeroTentativa: null }, versao: 0, estado: 'rascunho', notas: [], possivelDesclassificacao: false, motivoDesclassificacao: null };
            const erro = jasmine.createSpy('erro');
            service.salvarAvaliacao(evento.slug, 20, payload).subscribe({ next: () => fail('Erro nao deve emitir avaliacao'), error: erro });
            const request = http.expectOne(`/api/jurado/eventos/${evento.slug}/concorrentes/20/avaliacao`);
            expect(request.request.method).toBe('PUT');
            expect(request.request.body).toBe(payload);
            request.flush({ message: 'Falha de avaliacao' }, { status, statusText: 'Erro' });
            expect(erro).toHaveBeenCalledTimes(1);
            expect(erro.calls.mostRecent().args[0].status).toBe(status);
            expect(erro.calls.mostRecent().args[0].error).toEqual({ message: 'Falha de avaliacao' });
            http.expectNone((req) => req.url.includes('/api/jurado'));
        });
    }

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