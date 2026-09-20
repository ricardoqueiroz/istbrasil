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
import { CheckoutComponent } from './app/pages/editora/checkout/checkout.component';
import { DiretoriaLoginComponent } from './app/pages/cadastro/diretoria/diretoria-login.component';
// import { LivroComponent } from './app/pages/editora/livro/livro.component';

export const appRoutes: Routes = [
    { path: '', component: Landing },
    {
        path: 'disclaimers',
        component: AppLayout,
        children: [
            {
                path: 'brandpolicy',
                loadComponent: () => import('./app/pages/disclaimers/brandpolicy/brandpolicy.component').then(m => m.BrandPolicyComponent)
            },
            {
                path: 'privacypolicy',
                loadComponent: () => import('./app/pages/disclaimers/privacypolicy/privacypolicy.component').then(m => m.PrivacyPolicyComponent)
            },
            {
                path: 'termsofservice',
                loadComponent: () => import('./app/pages/disclaimers/termsofservice/termsofservice.component').then(m => m.TermsOfServiceComponent)
            },
            {
                path: 'refundpolicy',
                loadComponent: () => import('./app/pages/disclaimers/refundpolicy/refundpolicy.component').then(m => m.RefundPolicyComponent)
            }
        ]
    },
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
        path: 'fale-conosco',
        component: AppLayout,
        children: [
            {
                path: '',
                loadComponent: () => import('./app/pages/fale-conosco/fale-conosco').then(m => m.FaleConosco)
            }
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
    {
        path: 'flipbooks',
        component: AppLayout,
        children: [
            {
                path: 'book01',
                loadComponent: () => import('./app/pages/flipbooks/book01/book01.component').then(m => m.ReaderPageComponent)
            }
        ]
    },
    {
        path: 'editora',
        component: AppLayout,
        children: [
            { path: '', component: EditoraComponent },
            { 
                path: 'livro/:id', 
                loadComponent: () => import('./app/pages/editora/livro/livro.component').then(m => m.LivroComponent) 
            },
            { path: 'checkout', component: CheckoutComponent }
        ]
    },
    {
        path: 'cadastro',
        component: AppLayout,
        children: [
            { path: 'diretoria/login', component: DiretoriaLoginComponent },
            { path: 'diretoria/cadastro', loadComponent: () => import('./app/pages/cadastro/diretoria/diretoria-cadastro.component').then(m => m.DiretoriaCadastroComponent) },
            { path: 'diretoria/esqueci-senha', loadComponent: () => import('./app/pages/cadastro/diretoria/diretoria-esqueci-senha.component').then(m => m.DiretoriaEsqueciSenhaComponent) }
        ]
    },
    {
        path: 'confirmar-email',
        component: AppLayout,
        children: [
            { path: '', loadComponent: () => import('./app/pages/cadastro/confirmar-email/confirmar-email.component').then(m => m.ConfirmarEmailComponent) }
        ]
    },
    {
        path: 'redefinir-senha',
        component: AppLayout,
        children: [
            { path: '', loadComponent: () => import('./app/pages/cadastro/redefinir-senha/redefinir-senha.component').then(m => m.RedefinirSenhaComponent) }
        ]
    },
    { path: 'notfound', component: Notfound },
    { path: 'auth', loadChildren: () => import('./app/pages/auth/auth.routes') },
    { path: '**', redirectTo: '/notfound' }
];
