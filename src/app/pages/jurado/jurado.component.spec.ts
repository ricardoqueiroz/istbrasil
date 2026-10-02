import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';
import { By } from '@angular/platform-browser';
import { Table } from 'primeng/table';
import { BehaviorSubject } from 'rxjs';
import { AuthService } from '../../shared/auth.service';
import { ConcorrenteJurado, FilaJuradoResponse, FilaJuradoSort } from '../../shared/jurado.service';
import { JuradoAvaliacoesComponent } from './jurado-avaliacoes.component';
import { JuradoEventosComponent } from './jurado-eventos.component';

describe('Paginas de entrada do jurado', () => {
    let http: HttpTestingController;
    let params: BehaviorSubject<ReturnType<typeof convertToParamMap>>;
    const evento = { id: 17, slug: 'evento-teste', nome: 'Evento Autorizado' };
    const concorrente: ConcorrenteJurado = {
        idParticipacao: 20, numeroConcorrente: 'FVST2-020', nome: 'Concorrente Teste', cidade: null, uf: null,
        dataInscricao: '2026-10-02T12:00:00.000Z', obraPrincipal: { id: 22, titulo: 'Obra Principal' },
        linkVideoPrincipal: 'https://youtu.be/abcdefghijk', obraOpcional: null, linkVideoOpcional: null
    };

    beforeEach(() => {
        params = new BehaviorSubject(convertToParamMap({ slug: evento.slug }));
        TestBed.configureTestingModule({
            imports: [JuradoAvaliacoesComponent, JuradoEventosComponent],
            providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()]
        });
        TestBed.overrideComponent(JuradoAvaliacoesComponent, {
            add: { providers: [{ provide: ActivatedRoute, useValue: { paramMap: params.asObservable() } }] }
        });
        http = TestBed.inject(HttpTestingController);
    });

    afterEach(() => http.verify());

    function respostaFila(itens: ConcorrenteJurado[] = [concorrente], total = itens.length): FilaJuradoResponse {
        return { evento, concorrentes: itens, pagination: { page: 1, limit: 25, total, totalPages: Math.ceil(total / 25) } };
    }

    function criarPagina(): ComponentFixture<JuradoAvaliacoesComponent> {
        const fixture = TestBed.createComponent(JuradoAvaliacoesComponent);
        fixture.detectChanges();
        return fixture;
    }

    function consultaFila(slug = evento.slug) {
        return http.expectOne((request) => request.url === `/api/jurado/eventos/${slug}/concorrentes`);
    }

    it('faz exatamente uma carga inicial com defaults e sem consulta extra de metadados', () => {
        TestBed.inject(AuthService).definirUsuario({ id_usuario: 10, id_tipo_usuario: 3, nome: 'Nome do Jurado', foto_url: null });
        const fixture = criarPagina();
        const request = consultaFila();
        expect(request.request.params.get('page')).toBe('1');
        expect(request.request.params.get('limit')).toBe('25');
        expect(request.request.params.get('sort')).toBe('numeroConcorrente');
        expect(request.request.params.get('order')).toBe('asc');
        expect(fixture.componentInstance.carregando()).toBeTrue();
        expect(fixture.nativeElement.textContent).toContain('Carregando concorrentes');
        expect(fixture.nativeElement.textContent).not.toContain('Nenhum concorrente');
        const tabela = fixture.debugElement.query(By.directive(Table)).componentInstance as Table;
        expect(tabela.lazyLoadOnInit).toBeFalse();
        request.flush(respostaFila());
        fixture.detectChanges();
        const texto = fixture.nativeElement.textContent;
        expect(texto).toContain('Avalia\u00e7\u00e3o dos Concorrentes');
        expect(texto).toContain(evento.nome);
        expect(texto).toContain('Nome do Jurado');
        expect(texto).toContain('FVST2-020');
        expect(fixture.componentInstance.carregando()).toBeFalse();
        http.expectNone(`/api/jurado/eventos/${evento.slug}`);
        fixture.componentInstance.carregarConcorrentes({ first: 0, rows: 25, sortField: 'numeroConcorrente', sortOrder: 1 });
        http.expectNone((req) => req.url.endsWith('/concorrentes'));
    });

    it('pagina no servidor e usa o total global em vez do tamanho da pagina', () => {
        const fixture = criarPagina();
        consultaFila().flush(respostaFila([concorrente], 101));
        fixture.detectChanges();
        expect(fixture.nativeElement.querySelector('[data-testid="total-concorrentes"]').textContent).toContain('101');
        const tabela = fixture.debugElement.query(By.directive(Table)).componentInstance as Table;
        expect(tabela.totalRecords).toBe(101);
        tabela.onLazyLoad.emit({ first: 25, rows: 25, sortField: 'numeroConcorrente', sortOrder: 1 });
        const request = consultaFila();
        expect(request.request.params.get('page')).toBe('2');
        expect(request.request.params.get('limit')).toBe('25');
        expect(fixture.componentInstance.carregando()).toBeTrue();
        request.flush({ ...respostaFila([concorrente], 101), pagination: { page: 2, limit: 25, total: 101, totalPages: 5 } });
        expect(fixture.componentInstance.first).toBe(25);
        expect(fixture.componentInstance.carregando()).toBeFalse();
    });

    for (const limit of [25, 50, 100]) {
        it(`troca tamanho para ${limit} e reinicia primeira pagina`, () => {
            const fixture = criarPagina();
            consultaFila().flush(respostaFila([concorrente], 200));
            fixture.componentInstance.carregarConcorrentes({ first: 100, rows: 25 });
            consultaFila().flush(respostaFila([concorrente], 200));
            fixture.componentInstance.carregarConcorrentes({ first: limit === 25 ? 0 : 100, rows: limit });
            const request = consultaFila();
            expect(request.request.params.get('page')).toBe('1');
            expect(request.request.params.get('limit')).toBe(String(limit));
            request.flush(respostaFila());
            expect(fixture.componentInstance.first).toBe(0);
        });
    }

    for (const sort of ['numeroConcorrente', 'nome', 'dataInscricao'] as FilaJuradoSort[]) {
        for (const sortOrder of [1, -1]) {
            it(`ordena ${sort} ${sortOrder === 1 ? 'asc' : 'desc'} e reinicia pagina`, () => {
                const fixture = criarPagina();
                consultaFila().flush(respostaFila([concorrente], 100));
                if (sort === 'numeroConcorrente' && sortOrder === 1) {
                    fixture.componentInstance.carregarConcorrentes({ first: 0, rows: 25, sortField: 'nome', sortOrder: -1 });
                    consultaFila().flush(respostaFila());
                }
                fixture.componentInstance.carregarConcorrentes({ first: 25, rows: 25 });
                consultaFila().flush(respostaFila([concorrente], 100));
                fixture.componentInstance.carregarConcorrentes({ first: 25, rows: 25, sortField: sort, sortOrder });
                const request = consultaFila();
                expect(request.request.params.get('page')).toBe('1');
                expect(request.request.params.get('sort')).toBe(sort);
                expect(request.request.params.get('order')).toBe(sortOrder === -1 ? 'desc' : 'asc');
                expect(fixture.componentInstance.carregando()).toBeTrue();
                request.flush(respostaFila());
            });
        }
    }

    it('nao envia ordenacao nao suportada de localidade ou obras', () => {
        const fixture = criarPagina();
        consultaFila().flush(respostaFila([concorrente], 100));
        fixture.componentInstance.carregarConcorrentes({ first: 25, rows: 25, sortField: 'cidade' });
        const request = consultaFila();
        expect(request.request.params.get('sort')).toBe('numeroConcorrente');
        request.flush(respostaFila());
        fixture.detectChanges();
        const campos = Array.from(fixture.nativeElement.querySelectorAll('th[aria-sort]') as NodeListOf<HTMLElement>).map((header) => header.textContent?.trim());
        expect(campos.length).toBe(3);
        expect(campos[0]).toContain('Inscri');
        expect(campos[1]).toContain('Concorrente');
        expect(campos[2]).toContain('Data');
    });

    it('fila vazia aparece somente depois de sucesso com total zero', () => {
        const fixture = criarPagina();
        expect(fixture.nativeElement.textContent).not.toContain('Nenhum concorrente');
        consultaFila().flush(respostaFila([]));
        fixture.detectChanges();
        expect(fixture.nativeElement.textContent).toContain('Nenhum concorrente dispon\u00edvel para avalia\u00e7\u00e3o.');
        expect(fixture.componentInstance.carregando()).toBeFalse();
        expect(fixture.nativeElement.querySelector('[data-testid="total-concorrentes"]').textContent).toContain('0');
    });

    for (const [cidade, uf, esperado] of [
        ['Santarem', 'PA', 'Santarem / PA'], ['Santarem', null, 'Santarem'], [null, 'PA', 'PA'], [null, null, '\u2014']
    ]) {
        it(`renderiza localidade ${esperado} sem null ou undefined`, () => {
            const fixture = criarPagina();
            consultaFila().flush(respostaFila([{ ...concorrente, cidade, uf }]));
            fixture.detectChanges();
            const cells = fixture.nativeElement.querySelectorAll('tbody tr td');
            expect(cells[2].textContent.trim()).toBe(esperado);
            expect(fixture.nativeElement.textContent).not.toMatch(/null|undefined/);
        });
    }

    it('formata data pt-BR e obra opcional ausente sem inventar estado', () => {
        const fixture = criarPagina();
        consultaFila().flush(respostaFila());
        fixture.detectChanges();
        const cells = fixture.nativeElement.querySelectorAll('tbody tr td');
        expect(cells[3].textContent.trim()).toBe(new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short' }).format(new Date(concorrente.dataInscricao)));
        expect(cells[5].textContent.trim()).toBe('\u2014');
        expect(fixture.componentInstance.formatarDataInscricao('data-invalida')).toBe('\u2014');
    });

    it('mostra titulo da segunda obra sem renderizar videos, acoes ou notas', () => {
        const fixture = criarPagina();
        consultaFila().flush(respostaFila([{ ...concorrente, obraOpcional: { id: 40, titulo: 'Segunda Musica' }, linkVideoOpcional: 'https://youtu.be/lmnopqrstuv' }]));
        fixture.detectChanges();
        expect(fixture.nativeElement.querySelectorAll('thead th').length).toBe(6);
        expect(fixture.nativeElement.textContent).toContain('Segunda Musica');
        expect(fixture.nativeElement.textContent).not.toMatch(/\b(avaliados|pendentes|notas|m\u00e9dias)\b/i);
        expect(fixture.nativeElement.querySelector('thead').textContent).not.toContain('A\u00e7\u00e3o');
        expect(fixture.nativeElement.querySelector('tbody a, tbody button, iframe, video')).toBeNull();
        expect(fixture.nativeElement.innerHTML).not.toContain('youtu.be');
    });

    for (const status of [401, 403, 404]) {
        it(`falha ${status} ao carregar o evento redireciona com seguranca`, () => {
            const navigate = spyOn(TestBed.inject(Router), 'navigate').and.resolveTo(true);
            const fixture = criarPagina();
            consultaFila().flush({}, { status, statusText: 'Erro' });
            expect(navigate).toHaveBeenCalledWith([status === 401 ? '/login' : '/']);
            expect(fixture.componentInstance.carregando()).toBeFalse();
        });
    }

    for (const status of [500, 0]) {
        it(`erro ${status} permanece na pagina, termina loading e oferece retry`, () => {
            const navigate = spyOn(TestBed.inject(Router), 'navigate').and.resolveTo(true);
            const fixture = criarPagina();
            const request = consultaFila();
            if (status === 0) request.error(new ProgressEvent('error'));
            else request.flush({}, { status, statusText: 'Erro' });
            fixture.detectChanges();
            expect(navigate).not.toHaveBeenCalled();
            expect(fixture.componentInstance.carregando()).toBeFalse();
            expect(fixture.nativeElement.querySelector('[role="alert"]')).not.toBeNull();
            expect(fixture.nativeElement.textContent).not.toContain('Nenhum concorrente');
            expect(fixture.nativeElement.querySelector('[data-testid="total-concorrentes"]')).toBeNull();
            const button = fixture.nativeElement.querySelector('[role="alert"] button') as HTMLButtonElement;
            expect(button.textContent).toContain('Tentar novamente');
            button.click();
            expect(fixture.componentInstance.carregando()).toBeTrue();
            consultaFila().flush(respostaFila());
            fixture.detectChanges();
            expect(fixture.nativeElement.querySelector('[role="alert"]')).toBeNull();
            expect(fixture.nativeElement.textContent).toContain('FVST2-020');
        });
    }

    it('cancela pagina antiga quando uma pagina mais recente e solicitada', () => {
        const fixture = criarPagina();
        consultaFila().flush(respostaFila([concorrente], 100));
        fixture.componentInstance.carregarConcorrentes({ first: 25, rows: 25 });
        const antiga = consultaFila();
        fixture.componentInstance.carregarConcorrentes({ first: 50, rows: 25 });
        expect(antiga.cancelled).toBeTrue();
        const nova = consultaFila();
        expect(nova.request.params.get('page')).toBe('3');
        expect(fixture.componentInstance.carregando()).toBeTrue();
        nova.flush(respostaFila([{ ...concorrente, nome: 'Resposta Atual' }]));
        expect(() => antiga.flush(respostaFila([{ ...concorrente, nome: 'Resposta Antiga' }]))).toThrowError();
        expect(fixture.componentInstance.fila()?.concorrentes[0].nome).toBe('Resposta Atual');
    });

    it('troca de slug cancela carga antiga e reinicia defaults sem sobrescrever o novo evento', () => {
        const fixture = criarPagina();
        const antiga = consultaFila();
        params.next(convertToParamMap({ slug: 'outro-evento' }));
        expect(antiga.cancelled).toBeTrue();
        const nova = consultaFila('outro-evento');
        expect(nova.request.params.get('page')).toBe('1');
        expect(nova.request.params.get('sort')).toBe('numeroConcorrente');
        nova.flush({ ...respostaFila(), evento: { id: 28, slug: 'outro-evento', nome: 'Novo Evento' } });
        fixture.detectChanges();
        expect(() => antiga.flush(respostaFila())).toThrowError();
        expect(fixture.componentInstance.fila()?.evento.slug).toBe('outro-evento');
        expect(fixture.nativeElement.textContent).toContain('Novo Evento');
        expect(fixture.nativeElement.textContent).not.toContain(evento.nome);
    });

    it('resposta inesperada sem evento gera erro recuperavel', () => {
        const navigate = spyOn(TestBed.inject(Router), 'navigate').and.resolveTo(true);
        const fixture = criarPagina();
        consultaFila().flush({});
        expect(navigate).not.toHaveBeenCalled();
        expect(fixture.componentInstance.erro()).not.toBeNull();
        expect(fixture.componentInstance.carregando()).toBeFalse();
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