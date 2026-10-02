import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { DomSanitizer } from '@angular/platform-browser';
import { ActivatedRoute, Router, UrlTree, convertToParamMap, provideRouter } from '@angular/router';
import { BehaviorSubject } from 'rxjs';
import { appRoutes } from '../../../app.routes';
import { juradoGuard } from '../../guards/jurado.guard';
import { ConcorrenteJurado, ConcorrenteJuradoResponse } from '../../shared/jurado.service';
import { JuradoConcorrenteComponent } from './jurado-concorrente.component';

describe('JuradoConcorrenteComponent', () => {
    let http: HttpTestingController;
    let parametros: BehaviorSubject<ReturnType<typeof convertToParamMap>>;
    let trust: jasmine.Spy;
    const evento = { id: 17, slug: 'evento-teste', nome: 'Evento Autorizado' };
    const concorrente: ConcorrenteJurado = {
        idParticipacao: 20, numeroConcorrente: 'FVST2-020', nome: 'Nome do Concorrente', cidade: null, uf: null,
        dataInscricao: '2026-10-02T12:00:00.000Z', obraPrincipal: { id: 22, titulo: 'Obra Principal' },
        linkVideoPrincipal: 'https://youtu.be/abcdefghijk', obraOpcional: null, linkVideoOpcional: null
    };

    beforeEach(() => {
        parametros = new BehaviorSubject(convertToParamMap({ slug: evento.slug, idParticipacao: '20' }));
        TestBed.configureTestingModule({ imports: [JuradoConcorrenteComponent], providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()] });
        TestBed.overrideComponent(JuradoConcorrenteComponent, {
            add: { providers: [{ provide: ActivatedRoute, useValue: { paramMap: parametros.asObservable() } }] }
        });
        http = TestBed.inject(HttpTestingController);
        const sanitizer = TestBed.inject(DomSanitizer);
        const original = sanitizer.bypassSecurityTrustResourceUrl.bind(sanitizer);
        trust = spyOn(sanitizer, 'bypassSecurityTrustResourceUrl').and.callFake(() => original('about:blank'));
    });

    afterEach(() => http.verify());

    function criarPagina(): ComponentFixture<JuradoConcorrenteComponent> {
        const fixture = TestBed.createComponent(JuradoConcorrenteComponent);
        fixture.detectChanges();
        return fixture;
    }

    function dados(campos: Partial<ConcorrenteJurado> = {}): ConcorrenteJuradoResponse {
        return { evento, concorrente: { ...concorrente, ...campos } };
    }

    function consulta(slug = evento.slug, id = 20) {
        return http.expectOne(`/api/jurado/eventos/${slug}/concorrentes/${id}`);
    }

    it('rota individual e lazy e usa exatamente o guard existente', async () => {
        const rota = appRoutes.find((item) => item.path === 'jurado')?.children?.find((item) => item.path === ':slug/avaliacoes/:idParticipacao');
        expect(rota?.canActivate).toEqual([juradoGuard]);
        expect(await rota?.loadComponent?.()).toBe(JuradoConcorrenteComponent);
    });

    it('faz uma carga inicial, mostra dados publicos e nao carrega player automaticamente', () => {
        const fixture = criarPagina();
        expect(fixture.componentInstance.carregando()).toBeTrue();
        expect(fixture.nativeElement.textContent).toContain('Carregando concorrente');
        consulta().flush(dados());
        fixture.detectChanges();
        const texto = fixture.nativeElement.textContent;
        expect(texto).toContain('Avalia\u00e7\u00e3o do Concorrente');
        expect(texto).toContain(evento.nome);
        expect(texto).toContain(concorrente.numeroConcorrente);
        expect(texto).toContain(concorrente.nome);
        expect(texto).toContain(concorrente.obraPrincipal.titulo);
        expect(texto).toContain(new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short' }).format(new Date(concorrente.dataInscricao)));
        expect(texto).toContain('N\u00e3o h\u00e1 segunda obra.');
        expect(fixture.componentInstance.carregando()).toBeFalse();
        expect(fixture.nativeElement.querySelector('iframe')).toBeNull();
        expect(trust).not.toHaveBeenCalled();
        parametros.next(convertToParamMap({ slug: evento.slug, idParticipacao: '20' }));
        http.expectNone((request) => request.url.includes('/api/jurado'));
    });

    for (const [cidade, uf, esperado] of [['Santarem', 'PA', 'Santarem / PA'], ['Santarem', null, 'Santarem'], [null, 'PA', 'PA'], [null, null, '\u2014']]) {
        it(`localidade ${esperado} e null-safe`, () => {
            const fixture = criarPagina();
            consulta().flush(dados({ cidade, uf }));
            fixture.detectChanges();
            expect(fixture.nativeElement.querySelector('[data-testid="localidade"]').textContent.trim()).toBe(esperado);
            expect(fixture.nativeElement.textContent).not.toMatch(/null|undefined/);
        });
    }

    for (const url of [
        'https://www.youtube.com/watch?v=abcdefghijk&list=ignorada',
        'https://youtube.com/watch?v=abcdefghijk',
        'https://youtu.be/abcdefghijk?si=ignorado',
        'https://www.youtube.com/shorts/abcdefghijk',
        'https://youtube.com/embed/abcdefghijk',
        'https://www.youtube.com:443/watch?v=abcdefghijk'
    ]) {
        it(`YouTube aceito ${url} usa ID validado e URL construida somente apos acao`, () => {
            const fixture = criarPagina();
            consulta().flush(dados({ linkVideoPrincipal: url }));
            fixture.detectChanges();
            expect(fixture.nativeElement.querySelector('iframe')).toBeNull();
            expect(trust).not.toHaveBeenCalled();
            const externo = fixture.nativeElement.querySelector('a[target="_blank"]') as HTMLAnchorElement;
            expect(externo.getAttribute('href')).toBe('https://www.youtube.com/watch?v=abcdefghijk');
            expect(externo.getAttribute('rel')).toBe('noopener noreferrer');
            const play = fixture.nativeElement.querySelector('button[aria-label="Reproduzir V\u00eddeo principal"]') as HTMLButtonElement;
            play.click();
            fixture.detectChanges();
            expect(trust).toHaveBeenCalledOnceWith('https://www.youtube-nocookie.com/embed/abcdefghijk');
            expect(fixture.nativeElement.querySelector('iframe').getAttribute('src')).toBe('about:blank');
            expect(fixture.nativeElement.querySelector('iframe').getAttribute('title')).toBe('V\u00eddeo principal');
            expect(fixture.componentInstance.videoPrincipal()?.embed).not.toContain('autoplay');
            http.expectNone((request) => request.method !== 'GET');
        });
    }

    for (const url of ['https://vimeo.com/123456789', 'https://www.vimeo.com/123456789/hash-nao-listado?h=abc']) {
        it(`Vimeo ${url} abre somente link seguro externo`, () => {
            const fixture = criarPagina();
            consulta().flush(dados({ linkVideoPrincipal: url }));
            fixture.detectChanges();
            const link = fixture.nativeElement.querySelector('a[target="_blank"]') as HTMLAnchorElement;
            expect(link.getAttribute('href')).toBe(url);
            expect(link.getAttribute('rel')).toBe('noopener noreferrer');
            expect(link.textContent).toContain('Abrir no Vimeo');
            expect(fixture.nativeElement.querySelector('iframe, button')).toBeNull();
            expect(trust).not.toHaveBeenCalled();
        });
    }

    for (const url of [
        '', 'nao-e-url', 'javascript:alert(1)', 'data:text/html,<script>alert(1)</script>',
        'http://youtu.be/abcdefghijk', 'https://youtube.com.evil.test/watch?v=abcdefghijk',
        'https://evil.test/abcdefghijk', 'https://user:pass@youtube.com/watch?v=abcdefghijk',
        'https://youtube.com:444/watch?v=abcdefghijk', 'https://youtu.be/curto',
        'https://www.youtube.com/watch?v=abcdefghij%3C', 'https://vimeo.com/abc',
        'https://player.vimeo.com/video/123', 'https://www.youtube-nocookie.com/embed/abcdefghijk',
        `https://youtu.be/abcdefghijk?extra=${'x'.repeat(500)}`
    ]) {
        it(`URL invalida ${url.slice(0, 70)} nao produz link/player confiavel`, () => {
            const fixture = criarPagina();
            consulta().flush(dados({ linkVideoPrincipal: url }));
            fixture.detectChanges();
            expect(fixture.nativeElement.querySelector('a[target="_blank"], iframe')).toBeNull();
            expect(fixture.nativeElement.textContent).toContain('V\u00eddeo principal indispon\u00edvel.');
            fixture.componentInstance.reproduzirVideo(false);
            expect(trust).not.toHaveBeenCalled();
        });
    }

    it('obra opcional com YouTube tem player independente e nunca reproduz o principal por engano', () => {
        const fixture = criarPagina();
        consulta().flush(dados({ obraOpcional: { id: 40, titulo: 'Segunda Obra' }, linkVideoOpcional: 'https://youtu.be/lmnopqrstuv' }));
        fixture.detectChanges();
        expect(fixture.nativeElement.textContent).toContain('Segunda Obra');
        expect(fixture.nativeElement.querySelector('iframe')).toBeNull();
        (fixture.nativeElement.querySelector('button[aria-label="Reproduzir V\u00eddeo opcional"]') as HTMLButtonElement).click();
        fixture.detectChanges();
        expect(trust).toHaveBeenCalledOnceWith('https://www.youtube-nocookie.com/embed/lmnopqrstuv');
        expect(fixture.componentInstance.playerPrincipal()).toBeNull();
        expect(fixture.nativeElement.querySelector('iframe').getAttribute('title')).toBe('V\u00eddeo opcional');
    });

    for (const url of [null, 'javascript:alert(1)']) {
        it(`obra opcional com video ${url === null ? 'ausente' : 'invalido'} permanece identificada`, () => {
            const fixture = criarPagina();
            consulta().flush(dados({ obraOpcional: { id: 40, titulo: 'Segunda Obra' }, linkVideoOpcional: url }));
            fixture.detectChanges();
            expect(fixture.nativeElement.textContent).toContain('Segunda Obra');
            expect(fixture.nativeElement.textContent).toContain('V\u00eddeo opcional indispon\u00edvel.');
            expect(fixture.componentInstance.videoOpcional()).toBeNull();
        });
    }

    it('criterios e sinalizacao sao apenas informativos sem formulario ou persistencia', () => {
        const storage = spyOn(Storage.prototype, 'setItem');
        const fixture = criarPagina();
        consulta().flush(dados());
        fixture.detectChanges();
        const texto = fixture.nativeElement.textContent;
        for (const criterio of ['T\u00e9cnica e Precis\u00e3o Executiva', 'Expressividade e Interpreta\u00e7\u00e3o Musical', 'Fidelidade \u00e0 Obra e Arranjo', 'Conformidade com o Regulamento']) expect(texto).toContain(criterio);
        expect(texto).toContain('nenhuma nota \u00e9 registrada');
        expect(texto).toContain('25%');
        expect(texto).toContain('coordena\u00e7\u00e3o');
        expect(texto).not.toMatch(/\b(m\u00e9dia|avaliado|pendente|Salvar)\b/i);
        expect(fixture.nativeElement.querySelector('form, input, textarea, p-slider, p-inputnumber, p-radiobutton, p-checkbox')).toBeNull();
        expect(storage).not.toHaveBeenCalled();
        http.expectNone((request) => request.method !== 'GET');
    });

    it('voltar retorna para fila padrao sem state ou identificador da participacao', () => {
        const navigate = spyOn(TestBed.inject(Router), 'navigateByUrl').and.resolveTo(true);
        const fixture = criarPagina();
        consulta().flush(dados());
        fixture.detectChanges();
        const link = fixture.nativeElement.querySelector('a:not([target])') as HTMLAnchorElement;
        expect(link.getAttribute('href')).toBe(`/jurado/${evento.slug}/avaliacoes`);
        expect(link.textContent).toContain('Voltar para a lista');
        link.click();
        expect(TestBed.inject(Router).serializeUrl(navigate.calls.mostRecent().args[0] as UrlTree)).toBe(`/jurado/${evento.slug}/avaliacoes`);
        expect(navigate.calls.mostRecent().args[1]?.state).toBeUndefined();
    });

    for (const status of [401, 403]) {
        it(`${status} redireciona sem repetir autorizacao local`, () => {
            const navigate = spyOn(TestBed.inject(Router), 'navigate').and.resolveTo(true);
            const fixture = criarPagina();
            consulta().flush({}, { status, statusText: 'Erro' });
            expect(navigate).toHaveBeenCalledWith([status === 401 ? '/login' : '/']);
            expect(fixture.componentInstance.carregando()).toBeFalse();
        });
    }

    it('404 e neutro, permanece em contexto de jurado e oferece retorno sem revelar causa', () => {
        const navigate = spyOn(TestBed.inject(Router), 'navigate').and.resolveTo(true);
        const fixture = criarPagina();
        consulta().flush({ message: 'Detalhe interno nao deve ser exibido' }, { status: 404, statusText: 'Not Found' });
        fixture.detectChanges();
        expect(navigate).not.toHaveBeenCalled();
        expect(fixture.nativeElement.querySelector('[role="alert"]').textContent).toContain('Concorrente indispon\u00edvel');
        expect(fixture.nativeElement.textContent).not.toContain('Detalhe interno');
        expect(fixture.nativeElement.querySelector('a').textContent).toContain('Voltar para a lista');
        expect(fixture.componentInstance.carregando()).toBeFalse();
    });

    for (const status of [500, 0]) {
        it(`${status} termina loading e retry repete exatamente a mesma participacao`, () => {
            const navigate = spyOn(TestBed.inject(Router), 'navigate').and.resolveTo(true);
            const fixture = criarPagina();
            const request = consulta();
            if (status === 0) request.error(new ProgressEvent('error'));
            else request.flush({}, { status, statusText: 'Erro' });
            fixture.detectChanges();
            expect(navigate).not.toHaveBeenCalled();
            expect(fixture.componentInstance.carregando()).toBeFalse();
            expect(fixture.nativeElement.querySelector('[role="alert"]')).not.toBeNull();
            (fixture.nativeElement.querySelector('[role="alert"] button') as HTMLButtonElement).click();
            expect(fixture.componentInstance.carregando()).toBeTrue();
            consulta().flush(dados());
            fixture.detectChanges();
            expect(fixture.nativeElement.querySelector('[role="alert"]')).toBeNull();
            expect(fixture.nativeElement.textContent).toContain(concorrente.nome);
        });
    }

    for (const id of ['0', '-1', 'abc', '1.5', '9007199254740992']) {
        it(`ID ${id} malformado nao envia consulta ou concede autorizacao`, () => {
            parametros.next(convertToParamMap({ slug: evento.slug, idParticipacao: id }));
            const fixture = criarPagina();
            http.expectNone((request) => request.url.includes('/api/jurado'));
            expect(fixture.nativeElement.textContent).toContain('Concorrente indispon\u00edvel');
        });
    }

    it('troca de parametros remove dados/player antigos antes da resposta e cancela cargas anteriores', () => {
        const fixture = criarPagina();
        consulta().flush(dados());
        fixture.componentInstance.reproduzirVideo(false);
        fixture.detectChanges();
        expect(fixture.nativeElement.querySelector('iframe')).not.toBeNull();
        parametros.next(convertToParamMap({ slug: evento.slug, idParticipacao: '21' }));
        fixture.detectChanges();
        const antiga = consulta(evento.slug, 21);
        expect(fixture.componentInstance.detalhe()).toBeNull();
        expect(fixture.componentInstance.playerPrincipal()).toBeNull();
        expect(fixture.nativeElement.querySelector('iframe')).toBeNull();
        expect(fixture.nativeElement.textContent).not.toContain(concorrente.nome);
        parametros.next(convertToParamMap({ slug: 'outro-evento', idParticipacao: '22' }));
        expect(antiga.cancelled).toBeTrue();
        const nova = consulta('outro-evento', 22);
        nova.flush({ ...dados({ idParticipacao: 22, nome: 'Concorrente Atual' }), evento: { id: 28, slug: 'outro-evento', nome: 'Novo Evento' } });
        fixture.detectChanges();
        expect(() => antiga.flush(dados())).toThrowError();
        expect(fixture.nativeElement.textContent).toContain('Novo Evento');
        expect(fixture.nativeElement.textContent).toContain('Concorrente Atual');
        expect(fixture.nativeElement.textContent).not.toContain(concorrente.nome);
        expect(fixture.componentInstance.playerPrincipal()).toBeNull();
        expect(fixture.componentInstance.carregando()).toBeFalse();
    });

    it('destroy cancela a consulta pendente e encerra a subscription de parametros', () => {
        const fixture = criarPagina();
        const request = consulta();
        fixture.destroy();
        expect(request.cancelled).toBeTrue();
        parametros.next(convertToParamMap({ slug: 'outro-evento', idParticipacao: '22' }));
        http.expectNone((req) => req.url.includes('/api/jurado'));
    });
});