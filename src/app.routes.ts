import { Routes } from '@angular/router';
import { AppLayout } from './app/layout/component/app.layout';
import { Dashboard } from './app/pages/dashboard/dashboard';
import { Documentation } from './app/pages/documentation/documentation';
import { Landing } from './app/pages/landing/landing';
import { Notfound } from './app/pages/notfound/notfound';
import { InstitutoComponent } from './app/pages/instituto/instituto.component';
import { TransparenciaComponent } from './app/pages/transparencia/transparencia.component';
import { LocalizacaoComponent } from './app/pages/localizacao/localizacao.component';
import { EditoraComponent } from './app/pages/editora/editora.component';

export const appRoutes: Routes = [
    { path: '', component: Landing },
    {
        path: 'instituto',
        component: AppLayout,
        children: [
            { path: '', component: InstitutoComponent }
        ]
    },
    {
        path: 'transparencia',
        component: AppLayout,
        children: [
            { path: '', component: TransparenciaComponent }
        ]
    },
    {
        path: 'localizacao',
        component: AppLayout,
        children: [
            { path: '', component: LocalizacaoComponent }
        ]
    },
    {
        path: 'editora',
        component: AppLayout,
        children: [
            { path: '', component: EditoraComponent }
        ]
    },
    {
        path: 'admin',
        component: AppLayout,
        children: [
            { path: '', component: Dashboard },
            { path: 'pages', loadChildren: () => import('./app/pages/pages.routes') }
        ]
    },
    {
        path: 'patrono',
        component: AppLayout,
        children: [
            { path: 'biografia', loadComponent: () => import('./app/pages/patrono/biografia/biografia').then(m => m.BiografiaComponent) },
            { path: 'discografia', loadComponent: () => import('./app/pages/patrono/discografia/discografia.component').then(m => m.DiscografiaComponent) },
            { path: 'obra', loadComponent: () => import('./app/pages/patrono/obra/obra.component').then(m => m.ObraComponent) }
        ]
    },
    { path: 'notfound', component: Notfound },
    { path: 'auth', loadChildren: () => import('./app/pages/auth/auth.routes') },
    { path: '**', redirectTo: '/notfound' }
];
