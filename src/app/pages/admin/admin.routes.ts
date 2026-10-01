import { Routes } from '@angular/router';
import { AdminLayoutComponent } from './layout/admin-layout.component';
import { AdminDashboardComponent } from './dashboard/admin-dashboard.component';

export default [
    {
        path: '',
        component: AdminLayoutComponent,
        children: [
            { path: '', component: AdminDashboardComponent },
            {
                path: 'cadastros',
                loadChildren: () => import('./cadastros/cadastros.routes')
            },
            {
                path: 'emails/assinaturas',
                loadComponent: () => import('./emails/assinaturas/assinaturas.component').then((m) => m.AssinaturasComponent)
            },
            {
                path: 'emails/modelos',
                loadChildren: () => import('./emails/modelos/modelos.routes')
            }
        ]
    }
] as Routes;
