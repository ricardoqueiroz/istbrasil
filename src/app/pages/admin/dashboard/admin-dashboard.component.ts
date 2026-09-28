import { Component } from '@angular/core';

@Component({
    selector: 'app-admin-dashboard',
    standalone: true,
    template: `
        <section class="space-y-6">
            <div>
                <p class="text-sm font-semibold uppercase tracking-widest text-primary">Painel administrativo</p>
                <h2 class="mt-2 text-3xl font-bold text-surface-900 dark:text-white">Bem-vindo à Administração</h2>
                <p class="mt-2 max-w-2xl text-surface-600 dark:text-surface-300">Os módulos administrativos do Instituto Sebastião Tapajós serão disponibilizados progressivamente.</p>
            </div>

            <div class="rounded-xl border border-surface-200 bg-white p-6 dark:border-surface-800 dark:bg-surface-900">
                <div class="flex items-start gap-4">
                    <div class="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                        <i class="pi pi-clock text-xl" aria-hidden="true"></i>
                    </div>
                    <div>
                        <h3 class="text-lg font-semibold text-surface-900 dark:text-white">Área em evolução</h3>
                        <p class="mt-1 text-sm leading-relaxed text-surface-600 dark:text-surface-300">Os recursos de administração de e-mails serão adicionados nas próximas etapas.</p>
                    </div>
                </div>
            </div>
        </section>
    `
})
export class AdminDashboardComponent {}
