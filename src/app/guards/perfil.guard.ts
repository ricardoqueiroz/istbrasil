import { inject } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { CanActivateFn, Router } from '@angular/router';
import { filter, map, take } from 'rxjs';
import { AuthService } from '../shared/auth.service';

const PERFIL_ROTAS: Record<number, string> = {
    1: '/cadastro/diretoria/perfil',
    2: '/cadastro/concorrente/perfil',
    3: '/cadastro/externo/perfil',
    4: '/cadastro/colaborador/perfil'
};

const TIPOS_VALIDOS = [1, 2, 3, 4];

export const perfilGuard: CanActivateFn = (route) => {
    const authService = inject(AuthService);
    const router = inject(Router);

    const perfilTipoId = route.data['perfilTipoId'] as number;

    return toObservable(authService.carregando).pipe(
        filter((carregando) => !carregando),
        take(1),
        map(() => {
            if (!TIPOS_VALIDOS.includes(perfilTipoId)) {
                return router.parseUrl('/');
            }

            const usuario = authService.usuario();

            if (!usuario) {
                return router.parseUrl('/login');
            }

            if (!TIPOS_VALIDOS.includes(usuario.id_tipo_usuario)) {
                return router.parseUrl('/');
            }

            if (usuario.id_tipo_usuario === perfilTipoId) {
                return true;
            }

            return router.parseUrl(PERFIL_ROTAS[usuario.id_tipo_usuario]);
        })
    );
};
