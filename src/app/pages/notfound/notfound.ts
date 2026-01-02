import { Component } from '@angular/core';
import { RouterModule } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { AppFloatingConfigurator } from '../../layout/component/app.floatingconfigurator';

@Component({
    selector: 'app-notfound',
    standalone: true,
    imports: [RouterModule, AppFloatingConfigurator, ButtonModule],
    template: ` <app-floating-configurator />
        <div class="flex items-center justify-center min-h-screen overflow-hidden px-4">
            <div class="flex flex-col items-center justify-center">
                <img src="assets/images/selo-small.png" alt="IST Logo" class="mb-8 w-16 shrink-0">
                <div style="border-radius: 56px; padding: 0.3rem; background: linear-gradient(180deg, color-mix(in srgb, var(--primary-color), transparent 60%) 10%, var(--surface-ground) 30%)">
                    <div class="w-full bg-surface-0 dark:bg-surface-900 py-20 px-8 sm:px-20 flex flex-col items-center" style="border-radius: 53px">
                        <span class="text-primary font-bold text-3xl">404</span>
                        <h1 class="text-surface-900 dark:text-surface-0 font-bold text-3xl lg:text-5xl mb-2">Página não encontrada</h1>
                        <div class="text-surface-600 dark:text-surface-200 mb-8">O site está em desenvolvimento, desculpe.</div>
                        <a routerLink="/" class="w-full flex items-center justify-center py-8 mb-8 px-5">
                            <img src="assets/images/logo-ist-web.webp" alt="IST Logo" class="w-full h-auto">
                        </a>


                        <p-button label="Voltar para Início" routerLink="/" />
                    </div>
                </div>
            </div>
        </div>`
})
export class Notfound {}
