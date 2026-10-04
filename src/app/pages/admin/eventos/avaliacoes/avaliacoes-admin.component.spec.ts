import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';
import { By } from '@angular/platform-browser';
import { BehaviorSubject } from 'rxjs';
import { Table } from 'primeng/table';
import adminRoutes from '../../admin.routes';
import { adminGuard } from '../../../../guards/admin.guard';
import { AvaliacoesAdminComponent } from './avaliacoes-admin.component';
import { AvaliacoesAdminResponse, ConcorrenteAndamentoAdmin } from './avaliacoes-admin.model';

describe('AvaliacoesAdminComponent', () => {
    let http: HttpTestingController;
    let params: BehaviorSubject<ReturnType<typeof convertToParamMap>>;
    const evento = { id: 17, slug: 'evento-teste', nome: 'Evento Administrativo' };
    const participante: ConcorrenteAndamentoAdmin = { idParticipacao: 20, numeroConcorrente: 'TEST-020', nome: 'Concorrente', andamento: { totalJuradosAtuais: 3, concluidasAtuais: 1, rascunhosAtuais: 1, pendentesAtuais: 1 }, historico: { totalAvaliacoesForaDoJuriAtual: 0, concluidas: 0, rascunhos: 0, possuiSinalizacaoPossivelDesclassificacao: false }, sinalizacoes: { possuiAtual: false, possuiHistorica: false, possuiQualquer: false } };
    beforeEach(() => {
        params = new BehaviorSubject(convertToParamMap({ slug: evento.slug }));
        TestBed.configureTestingModule({ imports: [AvaliacoesAdminComponent], providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()] });
        TestBed.overrideComponent(AvaliacoesAdminComponent, { add: { providers: [{ provide: ActivatedRoute, useValue: { paramMap: params.asObservable() } }] } });
        http = TestBed.inject(HttpTestingController);
    });
    afterEach(() => http.verify());
    function pagina() { const fixture = TestBed.createComponent(AvaliacoesAdminComponent); fixture.detectChanges(); return fixture; }
    function request(slug = evento.slug) { return http.expectOne(req => req.url === `/api/admin/eventos/${slug}/avaliacoes`); }
    function dto(data = [participante], total = data.length): AvaliacoesAdminResponse { return { evento, jurados: { totalAtuais: 3 }, data, pagination: { page: 1, limit: 25, total, totalPages: total === 0 ? 0 : Math.ceil(total / 25) } }; }

    it('rota lazy usa o guard administrativo existente', async () => {
        const route = adminRoutes[0].children?.find(item => item.path === 'eventos/:slug/avaliacoes');
        expect(route?.canActivate).toEqual([adminGuard]);
        expect(await route?.loadComponent?.()).toBe(AvaliacoesAdminComponent);
    });

    it('carga unica mostra evento, sete colunas e contagens sem media/ranking', () => {
        const fixture = pagina();
        expect(fixture.nativeElement.textContent).toContain('Carregando acompanhamento');
        const load = request();
        expect(load.request.params.get('page')).toBe('1');
        expect(load.request.params.get('limit')).toBe('25');
        expect(load.request.params.get('sortField')).toBe('numeroConcorrente');
        const table = fixture.debugElement.query(By.directive(Table)).componentInstance as Table;
        expect(table.lazyLoadOnInit).toBeFalse();
        load.flush(dto());
        fixture.detectChanges();
        const text = fixture.nativeElement.textContent;
        expect(text).toContain('Acompanhamento das Avalia\u00e7\u00f5es');
        expect(text).toContain(evento.nome);
        expect(text).toContain('Jurados atuais: 3');
        expect(fixture.nativeElement.querySelectorAll('th').length).toBe(7);
        expect(fixture.nativeElement.querySelectorAll('tbody td')[2].textContent.trim()).toBe('1/3');
        expect(fixture.nativeElement.querySelectorAll('tbody td')[3].textContent.trim()).toBe('1');
        expect(fixture.nativeElement.querySelectorAll('tbody td')[4].textContent.trim()).toBe('1');
        expect(fixture.nativeElement.querySelectorAll('tbody td')[5].textContent.trim()).toBe('\u2014');
        expect(fixture.nativeElement.querySelectorAll('tbody td')[6].textContent.trim()).toBe('\u2014');
        expect(fixture.nativeElement.querySelectorAll('th[pSortableColumn]').length).toBe(2);
        expect(text).not.toMatch(/M\u00e9dia|Ranking|Vencedor|Classifica\u00e7\u00e3o|Notas/);
        fixture.componentInstance.carregar({ first: 0, rows: 25, sortField: 'numeroConcorrente', sortOrder: 1 });
        http.expectNone(req => req.url.includes('/api/admin'));
    });

    it('juri vazio recebe aviso explicito sem inferir julgamento concluido', () => {
        const fixture = pagina();
        const resposta = dto([{ ...participante, andamento: { totalJuradosAtuais: 0, concluidasAtuais: 0, rascunhosAtuais: 0, pendentesAtuais: 0 } }]);
        resposta.jurados.totalAtuais = 0;
        request().flush(resposta);
        fixture.detectChanges();
        expect(fixture.nativeElement.querySelector('[data-testid="juri-vazio"]').textContent).toContain('Nenhum jurado est\u00e1 atualmente habilitado para este evento.');
        expect(fixture.nativeElement.querySelectorAll('tbody td')[2].textContent.trim()).toBe('0/0');
        expect(fixture.nativeElement.textContent).not.toMatch(/julgamento conclu\u00eddo|avalia\u00e7\u00e3o completa/i);
    });

    it('historico exibe quantidade fora do juri e tooltip somente de contagens', () => {
        const fixture = pagina();
        const historico = { totalAvaliacoesForaDoJuriAtual: 2, concluidas: 1, rascunhos: 1, possuiSinalizacaoPossivelDesclassificacao: true };
        request().flush(dto([{ ...participante, historico }]));
        fixture.detectChanges();
        expect(fixture.nativeElement.querySelectorAll('tbody td')[5].textContent).toContain('2 fora do j\u00fari atual');
        expect(fixture.componentInstance.tooltipHistorico(historico)).toBe('Total: 2. Conclu\u00eddas: 1. Rascunhos: 1.');
        expect(fixture.nativeElement.querySelectorAll('tbody td')[5].querySelector('[tabindex="0"]')).not.toBeNull();
    });

    for (const [possuiAtual, possuiHistorica, esperado] of [[true, false, 'Sinaliza\u00e7\u00e3o atual'], [false, true, 'Sinaliza\u00e7\u00e3o hist\u00f3rica'], [true, true, 'Atual e hist\u00f3rica']] as const) {
        it(`sinal ${esperado} e textual e nao representa decisao definitiva`, () => {
            const fixture = pagina();
            request().flush(dto([{ ...participante, sinalizacoes: { possuiAtual, possuiHistorica, possuiQualquer: true } }]));
            fixture.detectChanges();
            expect(fixture.nativeElement.querySelectorAll('tbody td')[6].textContent).toContain(esperado);
            expect(fixture.nativeElement.textContent).toContain('Sinaliza\u00e7\u00e3o registrada por jurado; n\u00e3o representa decis\u00e3o de desclassifica\u00e7\u00e3o.');
            expect(fixture.nativeElement.textContent).not.toContain('Desclassificado');
        });
    }

    it('estado vazio aparece somente depois de loading e preserva total zero', () => {
        const fixture = pagina();
        expect(fixture.nativeElement.textContent).not.toContain('Nenhum concorrente eleg\u00edvel');
        request().flush(dto([], 0));
        fixture.detectChanges();
        expect(fixture.nativeElement.textContent).toContain('Nenhum concorrente eleg\u00edvel encontrado para este evento.');
        expect(fixture.componentInstance.carregando()).toBeFalse();
        expect(fixture.componentInstance.resposta()?.pagination.total).toBe(0);
    });

    for (const [status, mensagem] of [[404, 'Evento n\u00e3o encontrado.'], [403, 'Acesso administrativo n\u00e3o autorizado.'], [500, 'N\u00e3o foi poss\u00edvel carregar o acompanhamento das avalia\u00e7\u00f5es.'], [0, 'N\u00e3o foi poss\u00edvel carregar o acompanhamento das avalia\u00e7\u00f5es.']] as const) {
        it(`erro ${status} termina loading e nao expoe resposta interna`, () => {
            const navigate = spyOn(TestBed.inject(Router), 'navigate').and.resolveTo(true);
            const fixture = pagina();
            const consulta = request();
            if (status === 0) consulta.error(new ProgressEvent('error'));
            else consulta.flush({ message: 'SQL stack motivo token interno' }, { status, statusText: 'Erro' });
            fixture.detectChanges();
            expect(fixture.nativeElement.querySelector('[role="alert"]').textContent).toContain(mensagem);
            expect(fixture.nativeElement.textContent).not.toMatch(/SQL|stack|token interno/);
            expect(fixture.componentInstance.carregando()).toBeFalse();
            expect(navigate).not.toHaveBeenCalled();
            http.expectNone(req => req.url.includes('/api/admin'));
        });
    }

    it('401 navega para login pelo fluxo existente', () => {
        const navigate = spyOn(TestBed.inject(Router), 'navigate').and.resolveTo(true);
        const fixture = pagina();
        request().flush({}, { status: 401, statusText: 'Unauthorized' });
        expect(navigate).toHaveBeenCalledOnceWith(['/login']);
        expect(fixture.componentInstance.carregando()).toBeFalse();
    });

    it('retry manual repete os mesmos parametros e nao ocorre automaticamente', () => {
        const fixture = pagina();
        request().flush({}, { status: 500, statusText: 'Erro' });
        fixture.detectChanges();
        http.expectNone(req => req.url.includes('/api/admin'));
        (fixture.nativeElement.querySelector('[role="alert"] button') as HTMLButtonElement).click();
        expect(fixture.componentInstance.carregando()).toBeTrue();
        const consulta = request();
        expect(consulta.request.params.get('page')).toBe('1');
        expect(consulta.request.params.get('limit')).toBe('25');
        consulta.flush(dto());
    });

    it('paginacao envia pagina correta e usa total global do servidor', () => {
        const fixture = pagina();
        request().flush(dto([participante], 101));
        fixture.detectChanges();
        const table = fixture.debugElement.query(By.directive(Table)).componentInstance as Table;
        expect(table.totalRecords).toBe(101);
        table.onLazyLoad.emit({ first: 25, rows: 25, sortField: 'numeroConcorrente', sortOrder: 1 });
        const consulta = request();
        expect(consulta.request.params.get('page')).toBe('2');
        consulta.flush({ ...dto([participante], 101), pagination: { page: 2, limit: 25, total: 101, totalPages: 5 } });
        expect(fixture.componentInstance.first).toBe(25);
    });

    for (const limit of [25, 50, 100]) it(`limite ${limit} permitido, troca reinicia pagina`, () => {
        const fixture = pagina();
        request().flush(dto([participante], 200));
        fixture.componentInstance.carregar({ first: 25, rows: 25 });
        request().flush({ ...dto([participante], 200), pagination: { page: 2, limit: 25, total: 200, totalPages: 8 } });
        fixture.componentInstance.carregar({ first: 0, rows: limit });
        const consulta = request();
        expect(consulta.request.params.get('limit')).toBe(String(limit));
        expect(consulta.request.params.get('page')).toBe('1');
        consulta.flush({ ...dto(), pagination: { page: 1, limit, total: 1, totalPages: 1 } });
        expect(fixture.componentInstance.rows).toBe(limit);
        expect(fixture.componentInstance.first).toBe(0);
    });

    for (const sortField of ['numeroConcorrente', 'nome'] as const) for (const sortOrder of [1, -1]) {
        it(`sort ${sortField}/${sortOrder} mapeia whitelist e volta a pagina 1`, () => {
            const fixture = pagina();
            request().flush(dto());
            fixture.componentInstance.carregar({ first: 0, rows: 25, sortField: sortField === 'nome' ? 'numeroConcorrente' : 'nome', sortOrder: -1 });
            request().flush(dto());
            fixture.componentInstance.carregar({ first: 25, rows: 25 });
            request().flush({ ...dto(), pagination: { page: 2, limit: 25, total: 51, totalPages: 3 } });
            fixture.componentInstance.carregar({ first: 25, rows: 25, sortField, sortOrder });
            const consulta = request();
            expect(consulta.request.params.get('page')).toBe('1');
            expect(consulta.request.params.get('sortField')).toBe(sortField);
            expect(consulta.request.params.get('sortOrder')).toBe(sortOrder === -1 ? 'desc' : 'asc');
            consulta.flush(dto());
        });
    }

    it('campos de sort arbitrarios e eventos repetidos nao geram request insegura', () => {
        const fixture = pagina();
        request().flush(dto());
        fixture.componentInstance.carregar({ first: 0, rows: 25, sortField: 'cpf;DROP', sortOrder: 1 });
        fixture.componentInstance.carregar({ first: 0, rows: 999, sortField: ['nome', 'cpf'], sortOrder: 1 });
        params.next(convertToParamMap({ slug: evento.slug }));
        expect(fixture.componentInstance.sortField).toBe('numeroConcorrente');
        expect(fixture.componentInstance.rows).toBe(25);
        expect(fixture.componentInstance.first).toBe(0);
        http.expectNone(req => req.url.includes('/api/admin'));
    });

    it('troca de evento cancela resposta antiga e remove dados do contexto anterior', () => {
        const fixture = pagina();
        const antiga = request();
        params.next(convertToParamMap({ slug: 'outro-evento' }));
        expect(antiga.cancelled).toBeTrue();
        expect(fixture.componentInstance.resposta()).toBeNull();
        const atual = request('outro-evento');
        atual.flush({ ...dto(), evento: { id: 99, slug: 'outro-evento', nome: 'Outro Evento' } });
        fixture.detectChanges();
        expect(() => antiga.flush(dto())).toThrowError();
        expect(fixture.nativeElement.textContent).toContain('Outro Evento');
        expect(fixture.nativeElement.textContent).not.toContain(evento.nome);
    });

    it('destroy cancela consulta e encerra parametros', () => {
        const fixture = pagina();
        const consulta = request();
        fixture.destroy();
        expect(consulta.cancelled).toBeTrue();
        params.next(convertToParamMap({ slug: 'outro-evento' }));
        http.expectNone(req => req.url.includes('/api/admin'));
    });

    it('resposta nao exibe propriedades extras de nota/media/motivo', () => {
        const fixture = pagina();
        request().flush({ ...dto(), notas: [99], media: '99.00', motivo: 'MOTIVO_INTERNO' });
        fixture.detectChanges();
        expect(fixture.nativeElement.textContent).not.toContain('99.00');
        expect(fixture.nativeElement.textContent).not.toContain('MOTIVO_INTERNO');
        expect(fixture.nativeElement.querySelector('input, textarea, iframe')).toBeNull();
    });

    it('409 mostra erro neutro de inconsistencia sem retry automatico', () => {
        const fixture = pagina();
        request().flush({ message: 'SQL secreto' }, { status: 409, statusText: 'Conflict' });
        fixture.detectChanges();
        expect(fixture.nativeElement.querySelector('[role="alert"]').textContent).toContain('inconsist\u00eancias');
        expect(fixture.nativeElement.textContent).not.toContain('SQL secreto');
        expect(fixture.componentInstance.carregando()).toBeFalse();
        http.expectNone(req => req.url.includes('/api/admin'));
    });
});