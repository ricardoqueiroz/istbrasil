import { TestBed } from '@angular/core/testing';
import { ActivatedRouteSnapshot, Router, RouterStateSnapshot, UrlTree, provideRouter } from '@angular/router';
import { Observable, firstValueFrom } from 'rxjs';
import { AuthService } from '../shared/auth.service';
import { adminGuard } from './admin.guard';

describe('adminGuard existente', () => {
    let auth: AuthService;
    let router: Router;
    beforeEach(() => {
        TestBed.configureTestingModule({ providers: [provideRouter([])] });
        auth = TestBed.inject(AuthService);
        router = TestBed.inject(Router);
    });
    function executar(): Observable<boolean | UrlTree> {
        return TestBed.runInInjectionContext(() => adminGuard({} as ActivatedRouteSnapshot, {} as RouterStateSnapshot)) as Observable<boolean | UrlTree>;
    }
    function usuario(tipo: number) { auth.definirUsuario({ id_usuario: 10, id_tipo_usuario: tipo, nome: 'Teste', foto_url: null }); }

    it('sem sessao direciona para login', async () => {
        auth.carregando.set(false);
        const result = firstValueFrom(executar());
        TestBed.tick();
        expect(router.serializeUrl(await result as UrlTree)).toBe('/login');
    });
    it('tipo 1 permite acesso sem requisito de cargo', async () => {
        usuario(1);
        auth.carregando.set(false);
        const result = firstValueFrom(executar());
        TestBed.tick();
        expect(await result).toBeTrue();
    });
    for (const tipo of [2, 3, 4]) it(`tipo ${tipo} nao recebe autoridade administrativa`, async () => {
        usuario(tipo);
        auth.carregando.set(false);
        const result = firstValueFrom(executar());
        TestBed.tick();
        expect(router.serializeUrl(await result as UrlTree)).toBe('/');
    });
    it('aguarda restauracao e emite uma vez', () => {
        const next = jasmine.createSpy('next');
        executar().subscribe(next);
        TestBed.tick();
        expect(next).not.toHaveBeenCalled();
        usuario(1);
        auth.carregando.set(false);
        TestBed.tick();
        expect(next).toHaveBeenCalledOnceWith(true);
        usuario(4);
        TestBed.tick();
        expect(next).toHaveBeenCalledTimes(1);
    });
});