import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZoneChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { appRoutes } from '../../../app.routes';
import { adminGuard } from '../../guards/admin.guard';
import { juradoGuard } from '../../guards/jurado.guard';
import { perfilGuard } from '../../guards/perfil.guard';
import { AppLayout } from '../../layout/component/app.layout';
import { AuthService } from '../../shared/auth.service';
import { EditoraComponent } from '../editora/editora.component';
import { Notfound } from '../notfound/notfound';
import { REDIRECIONAR_LOJA } from '../loja-redirecionamento/loja-redirecionamento.component';

describe('Rotas após desativação da loja legada', () => {
    let http: HttpTestingController;
    let redirecionar: jasmine.Spy;
    beforeEach(() => {
        redirecionar = jasmine.createSpy('redirecionar');
        TestBed.configureTestingModule({ providers: [provideZoneChangeDetection(), provideNoopAnimations(),
            provideRouter(appRoutes), provideHttpClient(), provideHttpClientTesting(),
            { provide: REDIRECIONAR_LOJA, useValue: redirecionar }] });
        TestBed.overrideComponent(AppLayout, { set: { template: '<router-outlet />' } });
        TestBed.overrideComponent(EditoraComponent, { set: { template: '<p>IST Editora</p>' } });
        TestBed.overrideComponent(Notfound, { set: { template: '<p>Página não encontrada</p>' } });
        http = TestBed.inject(HttpTestingController);
    });
    afterEach(() => http.verify());

    for (const url of ['/loja', '/loja/', '/loja?token=segredo', '/loja#fragmento', '/loja/?token=segredo#fragmento']) {
        it(`redireciona somente ${url} para destino fixo sem dados da URL`, async () => {
            await RouterTestingHarness.create(url);
            expect(redirecionar).toHaveBeenCalledOnceWith('https://loja.istbrasil.org.br/');
            http.expectNone(req => req.url.includes('/api/loja'));
        });
    }
    for (const url of ['/loja/carrinho', '/loja/produto/1', '/loja/biblioteca',
        '/loja/biblioteca/recuperar', '/loja/recuperar', '/loja/biblioteca/confirmar', '/editora/livro/1', '/inexistente',
        '/loja;x=1', '/loja;x=1/carrinho', '/loja/(aux:x)', '/loja(aux:x)', '/(loja//aux:x)', '/lojavirtual', '/lojas']) {
        it(`${url} não carrega loja e segue o wildcard`, async () => {
            await RouterTestingHarness.create(url);
            expect(TestBed.inject(Router).url).toBe('/notfound');
            expect(redirecionar).not.toHaveBeenCalled();
            http.expectNone(req => req.url.includes('/api/loja') || req.url.includes('/api/books'));
        });
    }
    for (const url of ['/loja//x', '/loja//']) {
        it(`${url} é normalizada pelo Router para /loja antes do reconhecimento`, async () => {
            const router = TestBed.inject(Router);
            expect(router.serializeUrl(router.parseUrl(url))).toBe('/loja');
            await RouterTestingHarness.create(url);
            expect(redirecionar).toHaveBeenCalledOnceWith('https://loja.istbrasil.org.br/');
            http.expectNone(req => req.url.includes('/api/loja'));
        });
    }
    for (const autenticado of [true, false]) {
        for (const url of ['/admin/loja/livros', '/admin/loja/livros/novo', '/admin/loja/livros/1/editar']) {
            it(`${url} não carrega rota comercial com sessão ${autenticado}`, async () => {
                const auth = TestBed.inject(AuthService);
                if (autenticado) auth.definirUsuario({ id_usuario: 1, id_tipo_usuario: 1, nome: 'Admin', foto_url: null });
                auth.carregando.set(false);
                await RouterTestingHarness.create(url);
                expect(TestBed.inject(Router).url).not.toContain('/admin/loja');
                expect(redirecionar).not.toHaveBeenCalled();
                http.expectNone(req => req.url.includes('/api/admin/loja'));
            });
        }
    }
    it('preserva a Editora e não consulta livros', async () => {
        const harness = await RouterTestingHarness.create('/editora');
        expect(harness.routeNativeElement?.textContent).toContain('IST Editora');
        http.expectNone(req => req.url.includes('/api/books'));
    });
    it('preserva rotas e guards institucionais', () => {
        for (const path of ['login', 'confirmar-email', 'esqueci-senha', 'redefinir-senha', 'eventos', 'eventos/:slug', 'projetos', 'projetos/:slug']) {
            expect(appRoutes.some(route => route.path === path)).withContext(path).toBeTrue();
        }
        expect(appRoutes.find(route => route.path === 'admin')?.canActivate).toEqual([adminGuard]);
        expect(appRoutes.find(route => route.path === 'jurado')?.children?.every(route => route.canActivate?.includes(juradoGuard))).toBeTrue();
        const cadastro = appRoutes.find(route => route.path === 'cadastro')?.children;
        expect(cadastro?.find(route => route.path === 'concorrente/perfil')?.canActivate).toEqual([perfilGuard]);
        expect(cadastro?.find(route => route.path === 'concorrente/videos')?.canActivate).toEqual([perfilGuard]);
        expect(appRoutes.at(-1)).toEqual({ path: '**', redirectTo: '/notfound' });
    });
});
