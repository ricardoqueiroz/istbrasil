import { CommonModule } from '@angular/common';
import { Component, inject } from '@angular/core';
import { Router, RouterModule } from '@angular/router';
import { AuthService } from '../../../shared/auth.service';

@Component({
    selector: 'app-admin-layout',
    standalone: true,
    imports: [CommonModule, RouterModule],
    template: `
        <div class="min-h-screen bg-surface-50 text-surface-900 dark:bg-surface-950 dark:text-surface-0">
            <header class="border-b border-surface-200 bg-white dark:border-surface-800 dark:bg-surface-900">
                <div class="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-4 sm:px-6 lg:px-8">
                    <div class="flex items-center gap-3">
                        <button type="button" class="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-surface-200 text-surface-700 lg:hidden dark:border-surface-700 dark:text-surface-200" (click)="menuAberto = !menuAberto" [attr.aria-expanded]="menuAberto" aria-controls="admin-navigation" aria-label="Abrir menu administrativo">
                            <i class="pi pi-bars" aria-hidden="true"></i>
                        </button>
                        <div>
                            <p class="text-xs font-semibold uppercase tracking-widest text-primary">IST Brasil</p>
                            <h1 class="text-xl font-bold sm:text-2xl">Administração</h1>
                        </div>
                    </div>
                    <div class="flex items-center gap-3">
                        <span *ngIf="authService.usuario() as usuario" class="hidden text-sm text-surface-600 sm:inline dark:text-surface-300">{{ usuario.nome }}</span>
                        <button type="button" class="inline-flex items-center gap-2 rounded-lg border border-surface-200 px-3 py-2 text-sm font-medium text-surface-700 hover:bg-surface-50 dark:border-surface-700 dark:text-surface-200 dark:hover:bg-surface-800" (click)="sair()">
                            <i class="pi pi-sign-out" aria-hidden="true"></i>
                            <span>Sair</span>
                        </button>
                    </div>
                </div>
            </header>

            <div class="mx-auto flex max-w-7xl flex-col gap-6 px-4 py-6 sm:px-6 lg:flex-row lg:px-8">
                <aside id="admin-navigation" class="w-full shrink-0 lg:w-56" [class.hidden]="!menuAberto" [class.lg:block]="true">
                    <nav class="rounded-xl border border-surface-200 bg-white p-2 dark:border-surface-800 dark:bg-surface-900" aria-label="Navegação administrativa">
                        <a routerLink="/admin" routerLinkActive="bg-primary/10 text-primary" [routerLinkActiveOptions]="{ exact: true }" (click)="fecharMenu()" class="flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-surface-700 hover:bg-surface-50 dark:text-surface-200 dark:hover:bg-surface-800">
                            <i class="pi pi-home" aria-hidden="true"></i>
                            <span>Dashboard</span>
                        </a>
                        <div class="px-3 pb-1 pt-4 text-xs font-semibold uppercase tracking-wider text-surface-500">Cadastros</div>
                        <a routerLink="/admin/cadastros/listar" routerLinkActive="bg-primary/10 text-primary" (click)="fecharMenu()" class="flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-surface-700 hover:bg-surface-50 dark:text-surface-200 dark:hover:bg-surface-800">
                            <i class="pi pi-users" aria-hidden="true"></i>
                            <span>Listar</span>
                        </a>
                        <div class="px-3 pb-1 pt-4 text-xs font-semibold uppercase tracking-wider text-surface-500">E-mails</div>
                        <a routerLink="/admin/emails/assinaturas" routerLinkActive="bg-primary/10 text-primary" (click)="fecharMenu()" class="flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-surface-700 hover:bg-surface-50 dark:text-surface-200 dark:hover:bg-surface-800">
                            <i class="pi pi-pencil" aria-hidden="true"></i>
                            <span>Assinaturas</span>
                        </a>
                        <a routerLink="/admin/emails/modelos" routerLinkActive="bg-primary/10 text-primary" (click)="fecharMenu()" class="flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-surface-700 hover:bg-surface-50 dark:text-surface-200 dark:hover:bg-surface-800">
                            <i class="pi pi-file-edit" aria-hidden="true"></i>
                            <span>Modelos</span>
                        </a>
                    </nav>
                    <a routerLink="/" class="mt-4 flex items-center gap-2 px-3 text-sm font-medium text-primary hover:underline" (click)="fecharMenu()">
                        <i class="pi pi-arrow-left" aria-hidden="true"></i>
                        <span>Voltar ao site</span>
                    </a>
                </aside>

                <main class="min-w-0 flex-1">
                    <router-outlet></router-outlet>
                </main>
            </div>
        </div>
    `
})
export class AdminLayoutComponent {
    readonly authService = inject(AuthService);
    private readonly router = inject(Router);
    menuAberto = false;

    fecharMenu(): void {
        this.menuAberto = false;
    }

    async sair(): Promise<void> {
        await this.authService.logout();
        await this.router.navigate(['/login']);
    }
}
