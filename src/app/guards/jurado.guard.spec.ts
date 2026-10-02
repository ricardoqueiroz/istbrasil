import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { ActivatedRouteSnapshot, Router, RouterStateSnapshot, UrlTree, convertToParamMap, provideRouter } from '@angular/router';
import { Observable, firstValueFrom } from 'rxjs';
import { AuthService } from '../shared/auth.service';
import { juradoGuard } from './jurado.guard';

describe('juradoGuard', () => {
    let auth: AuthService;
    let http: HttpTestingController;
    let router: Router;
    const evento = { id: 17, slug: 'evento-teste', nome: 'Evento Teste' };

    beforeEach(() => {
        TestBed.configureTestingModule({ providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()] });
        auth = TestBed.inject(AuthService);
        http = TestBed.inject(HttpTestingController);
        router = TestBed.inject(Router);
        auth.carregando.set(false);
        auth.definirUsuario({ id_usuario: 10, id_tipo_usuario: 3, nome: 'Jurado Teste', foto_url: null });
    });

    afterEach(() => http.verify());

    function executar(slug: string | null = evento.slug): Promise<boolean | UrlTree> {
        const route = { paramMap: convertToParamMap(slug === null ? {} : { slug }) } as ActivatedRouteSnapshot;
        const resultado = TestBed.runInInjectionContext(() => juradoGuard(route, {} as RouterStateSnapshot));
        const promise = firstValueFrom(resultado as Observable<boolean | UrlTree>);
        TestBed.tick();
        return promise;
    }

    it('sem sessao vai para login sem consultar acessos', async () => {
        auth.usuario.set(null);
        const resultado = await executar();
        expect(router.serializeUrl(resultado as UrlTree)).toBe('/login');
        http.expectNone('/api/jurado/acessos');
    });

    it('aguarda restauracao da sessao antes de consultar acessos', async () => {
        let concluirSessao!: () => void;
        const sessao = new Promise<void>((resolve) => { concluirSessao = resolve; });
        const verificarSessao = spyOn(auth, 'verificarSessao').and.returnValue(sessao);
        auth.carregando.set(true);
        const resultado = executar();
        http.expectNone('/api/jurado/acessos');
        expect(verificarSessao).toHaveBeenCalledTimes(1);
        auth.carregando.set(false);
        concluirSessao();
        await sessao;
        TestBed.tick();
        http.expectOne('/api/jurado/acessos').flush({ eventos: [evento] });
        expect(await resultado).toBeTrue();
    });

    it('inicia restauracao na navegacao direta e reutiliza uma restauracao em andamento', async () => {
        const usuario = { id_usuario: 10, id_tipo_usuario: 3, nome: 'Jurado Teste', foto_url: null };
        const fetchSpy = spyOn(window, 'fetch').and.resolveTo(new Response(JSON.stringify(usuario), { status: 200 }));
        auth.usuario.set(null);
        auth.carregando.set(true);
        const sessao = auth.verificarSessao();
        const resultado = executar();
        http.expectNone('/api/jurado/acessos');
        await sessao;
        await Promise.resolve();
        TestBed.tick();
        http.expectOne('/api/jurado/acessos').flush({ eventos: [evento] });
        expect(await resultado).toBeTrue();
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(auth.usuario()).toEqual(usuario);
    });

    it('slug autorizado permite navegacao independentemente do tipo local', async () => {
        const resultado = executar();
        http.expectOne('/api/jurado/acessos').flush({ eventos: [evento] });
        expect(await resultado).toBeTrue();
    });

    it('slug de outro evento vai para a raiz', async () => {
        const resultado = executar('outro-evento');
        http.expectOne('/api/jurado/acessos').flush({ eventos: [evento] });
        expect(router.serializeUrl(await resultado as UrlTree)).toBe('/');
    });

    it('lista vazia vai para a raiz', async () => {
        const resultado = executar();
        http.expectOne('/api/jurado/acessos').flush({ eventos: [] });
        expect(router.serializeUrl(await resultado as UrlTree)).toBe('/');
    });

    for (const status of [401, 403, 404, 500, 0]) {
        it(`erro ${status} tem fallback seguro`, async () => {
            const resultado = executar();
            const request = http.expectOne('/api/jurado/acessos');
            if (status === 0) {
                request.error(new ProgressEvent('error'));
            } else {
                request.flush({}, { status, statusText: 'Erro' });
            }
            expect(router.serializeUrl(await resultado as UrlTree)).toBe(status === 401 ? '/login' : '/');
        });
    }

    it('selecao exige ao menos um acesso', async () => {
        const resultado = executar(null);
        http.expectOne('/api/jurado/acessos').flush({ eventos: [] });
        expect(router.serializeUrl(await resultado as UrlTree)).toBe('/');
    });

    it('selecao permite eventos autorizados', async () => {
        const resultado = executar(null);
        http.expectOne('/api/jurado/acessos').flush({ eventos: [evento] });
        expect(await resultado).toBeTrue();
    });
});