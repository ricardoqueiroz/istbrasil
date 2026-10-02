import { HttpErrorResponse } from '@angular/common/http';
import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { catchError, from, map, of, switchMap } from 'rxjs';
import { AuthService } from '../shared/auth.service';
import { JuradoService } from '../shared/jurado.service';

export const juradoGuard: CanActivateFn = (route) => {
    const authService = inject(AuthService);
    const juradoService = inject(JuradoService);
    const router = inject(Router);

    const sessao = authService.carregando() ? from(authService.verificarSessao()) : of(undefined);
    return sessao.pipe(
        switchMap(() => {
            if (!authService.usuario()) {
                return of(router.parseUrl('/login'));
            }

            const slug = route.paramMap.get('slug');
            return juradoService.listarAcessos().pipe(
                map(({ eventos }) => {
                    const autorizado = slug === null ? eventos.length > 0 : eventos.some((evento) => evento.slug === slug);
                    return autorizado ? true : router.parseUrl('/');
                }),
                catchError((error: unknown) => of(router.parseUrl(error instanceof HttpErrorResponse && error.status === 401 ? '/login' : '/')))
            );
        }),
        catchError(() => of(router.parseUrl('/')))
    );
};