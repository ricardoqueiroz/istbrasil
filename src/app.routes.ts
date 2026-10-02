import { Routes } from '@angular/router';
import { AppLayout } from './app/layout/component/app.layout';
import { Documentation } from './app/pages/documentation/documentation';
import { Landing } from './app/pages/landing/landing';
import { Notfound } from './app/pages/notfound/notfound';
import { InstitutoComponent } from './app/pages/instituto/instituto.component';
import { TransparenciaComponent } from './app/pages/transparencia/transparencia.component';
import { LocalizacaoComponent } from './app/pages/localizacao/localizacao.component';
import { EditoraComponent } from './app/pages/editora/editora.component';
import { CheckoutComponent } from './app/pages/editora/checkout/checkout.component';
import { DiretoriaLoginComponent } from './app/pages/cadastro/diretoria/diretoria-login.component';
import { TIPO_USUARIO_MAP } from './app/pages/cadastro/models/cadastro.model';
import { perfilGuard } from './app/guards/perfil.guard';
import { adminGuard } from './app/guards/admin.guard';
import { juradoGuard } from './app/guards/jurado.guard';
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
        canActivate: [adminGuard],
        loadChildren: () => import('./app/pages/admin/admin.routes')
    },
    {
        path: 'jurado',
        component: AppLayout,
        children: [
            {
                path: '',
                pathMatch: 'full',
                canActivate: [juradoGuard],
                loadComponent: () => import('./app/pages/jurado/jurado-eventos.component').then(m => m.JuradoEventosComponent)
            },
            {
                path: ':slug/avaliacoes/:idParticipacao',
                canActivate: [juradoGuard],
                loadComponent: () => import('./app/pages/jurado/jurado-concorrente.component').then(m => m.JuradoConcorrenteComponent)
            },
            {
                path: ':slug/avaliacoes',
                canActivate: [juradoGuard],
                loadComponent: () => import('./app/pages/jurado/jurado-avaliacoes.component').then(m => m.JuradoAvaliacoesComponent)
            }
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
            { path: '', pathMatch: 'full', redirectTo: 'usuarios' },
            {
                path: 'usuarios',
                loadComponent: () => import('./app/pages/cadastro/cadastro.component').then(m => m.CadastroComponent),
                data: {
                    cadastroTipo: 'externo',
                    idTipoUsuario: TIPO_USUARIO_MAP.externo
                }
            },
            { path: 'externo', pathMatch: 'full', redirectTo: 'usuarios' },
            {
                path: 'concorrente',
                loadComponent: () => import('./app/pages/cadastro/cadastro.component').then(m => m.CadastroComponent),
                data: {
                    cadastroTipo: 'concorrente',
                    idTipoUsuario: TIPO_USUARIO_MAP.concorrente
                }
            },
            {
                path: 'diretoria/perfil',
                loadComponent: () => import('./app/pages/perfil/perfil.component').then(m => m.PerfilComponent),
                canActivate: [perfilGuard],
                data: {
                    perfilTipo: 'diretoria',
                    perfilTipoId: TIPO_USUARIO_MAP.diretoria
                }
            },
            {
                path: 'concorrente/perfil',
                loadComponent: () => import('./app/pages/perfil/perfil.component').then(m => m.PerfilComponent),
                canActivate: [perfilGuard],
                data: {
                    perfilTipo: 'concorrente',
                    perfilTipoId: TIPO_USUARIO_MAP.concorrente
                }
            },
            {
                path: 'concorrente/videos',
                loadComponent: () => import('./app/pages/cadastro/concorrente/videos/concorrente-videos.component').then(m => m.ConcorrenteVideosComponent),
                canActivate: [perfilGuard],
                data: {
                    perfilTipo: 'concorrente',
                    perfilTipoId: TIPO_USUARIO_MAP.concorrente
                }
            },
            {
                path: 'externo/perfil',
                loadComponent: () => import('./app/pages/perfil/perfil.component').then(m => m.PerfilComponent),
                canActivate: [perfilGuard],
                data: {
                    perfilTipo: 'externo',
                    perfilTipoId: TIPO_USUARIO_MAP.externo
                }
            },
            {
                path: 'colaborador/perfil',
                loadComponent: () => import('./app/pages/perfil/perfil.component').then(m => m.PerfilComponent),
                canActivate: [perfilGuard],
                data: {
                    perfilTipo: 'colaborador',
                    perfilTipoId: TIPO_USUARIO_MAP.colaborador
                }
            },
            { path: 'diretoria/login', component: DiretoriaLoginComponent },
        ]
    },
    {
        path: 'login',
        component: AppLayout,
        children: [
            { path: '', loadComponent: () => import('./app/pages/login/login.component').then(m => m.LoginComponent) }
        ]
    },
    {
        path: 'confirmar-email',
        component: AppLayout,
        children: [
            { path: '', loadComponent: () => import('./app/pages/confirmar-email/confirmar-email.component').then(m => m.ConfirmarEmailComponent) }
        ]
    },
    {
        path: 'redefinir-senha',
        component: AppLayout,
        children: [
            { path: '', loadComponent: () => import('./app/pages/redefinir-senha/redefinir-senha.component').then(m => m.RedefinirSenhaComponent) }
        ]
    },
    {
        path: 'esqueci-senha',
        component: AppLayout,
        children: [
            { path: '', loadComponent: () => import('./app/pages/esqueci-senha/esqueci-senha.component').then(m => m.EsqueciSenhaComponent) }
        ]
    },
    {
        path: 'eventos',
        loadComponent: () => import('./app/pages/eventos/eventos.component').then(m => m.EventosComponent)
    },
    {
        path: 'eventos/:slug',
        loadComponent: () => import('./app/pages/eventos/evento-detalhe/evento-detalhe.component').then(m => m.EventoDetalheComponent)
    },
    { path: 'notfound', component: Notfound },
    { path: 'auth', loadChildren: () => import('./app/pages/auth/auth.routes') },
    { path: '**', redirectTo: '/notfound' }
];
