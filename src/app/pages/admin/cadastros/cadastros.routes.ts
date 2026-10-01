import { Routes } from '@angular/router';

export default [
    { path: '', pathMatch: 'full', redirectTo: 'listar' },
    {
        path: 'listar',
        loadComponent: () => import('./listar/listar.component').then((m) => m.ListarCadastrosComponent)
    }
] as Routes;
