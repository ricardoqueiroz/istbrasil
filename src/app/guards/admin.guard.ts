import { inject } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { CanActivateFn, Router } from '@angular/router';
import { filter, map, take } from 'rxjs';
import { AuthService } from '../shared/auth.service';

export const adminGuard: CanActivateFn = () => {
    const authService = inject(AuthService);
    const router = inject(Router);

    return toObservable(authService.carregando).pipe(
        filter((carregando) => !carregando),
        take(1),
        map(() => {
            const usuario = authService.usuario();

            if (!usuario) {
                return router.parseUrl('/login');
            }

            return usuario.id_tipo_usuario === 1 ? true : router.parseUrl('/');
        })
    );
};
