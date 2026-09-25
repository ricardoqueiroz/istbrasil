import { Component, Input } from '@angular/core';
import { MenuItem } from 'primeng/api';
import { Router, RouterModule } from '@angular/router';
import { CommonModule } from '@angular/common';
import { StyleClassModule } from 'primeng/styleclass';
import { MenuModule } from 'primeng/menu';
import { AppConfigurator } from './app.configurator';
import { LayoutService } from '../service/layout.service';
import { AuthService } from '../../shared/auth.service';

@Component({
    selector: 'app-topbar',
    standalone: true,
    imports: [RouterModule, CommonModule, StyleClassModule, MenuModule, AppConfigurator],
    template: ` <div class="layout-topbar">
        <div class="layout-topbar-logo-container">
            <button *ngIf="showMenuButton" class="layout-menu-button layout-topbar-action" (click)="layoutService.onMenuToggle()">
                <i class="pi pi-bars"></i>
            </button>
            <a routerLink="/" class="layout-topbar-logo">
                <img src="assets/images/selo-small.png" alt="Logo IST" class="h-12 mr-2">
                <span class="whitespace-nowrap"> Instituto Sebastião Tapajós</span>
            </a>
        </div>

        <div class="layout-topbar-actions">
            <div class="layout-config-menu" style="display:none">
                <button type="button" class="layout-topbar-action" (click)="toggleDarkMode()">
                    <i [ngClass]="{ 'pi ': true, 'pi-moon': layoutService.isDarkTheme(), 'pi-sun': !layoutService.isDarkTheme() }"></i>
                </button>
                <div class="relative">
                    <button
                        class="layout-topbar-action layout-topbar-action-highlight"
                        pStyleClass="@next"
                        enterFromClass="hidden"
                        enterActiveClass="animate-scalein"
                        leaveToClass="hidden"
                        leaveActiveClass="animate-fadeout"
                        [hideOnOutsideClick]="true"
                    >
                        <i class="pi pi-palette"></i>
                    </button>
                    <app-configurator />
                </div>
            </div>

            <button class="layout-topbar-menu-button layout-topbar-action" pStyleClass="@next" enterFromClass="hidden" enterActiveClass="animate-scalein" leaveToClass="hidden" leaveActiveClass="animate-fadeout" [hideOnOutsideClick]="true">
                <i class="pi pi-ellipsis-v"></i>
            </button>

            <div class="layout-topbar-menu hidden lg:block">
                <div class="layout-topbar-menu-content">
                    <button type="button" class="layout-topbar-action">
                        <i class="pi pi-calendar"></i>
                        <span>Calendario</span>
                    </button>
                    <button type="button" class="layout-topbar-action"  routerLink="/fale-conosco">
                        <i class="pi pi-inbox"></i>
                        <span>Contato</span>
                    </button>

                    <span class="mr-2 hidden md:inline-flex items-center self-center text-sm font-medium">
                        <ng-container *ngIf="authService.usuario() as usuario; else linkEntrar">{{ primeiroNome(usuario.nome) }}</ng-container>
                        <ng-template #linkEntrar><a routerLink="/login" class="hover:underline">Entrar</a></ng-template>
                    </span>
                    <button type="button" class="layout-topbar-action p-0" (click)="authService.usuario() ? menuPerfil.toggle($event) : irParaLogin()">
                        <img *ngIf="authService.usuario()?.foto_url as foto" [src]="foto" alt="Foto de perfil" class="w-8 h-8 rounded-full object-cover" />
                        <i *ngIf="!authService.usuario()?.foto_url" class="pi pi-user"></i>
                    </button>
                    <p-menu #menuPerfil [model]="itensMenuPerfil" [popup]="true"></p-menu>
                </div>
            </div>
        </div>
    </div>`
})
export class AppTopbar {
    @Input() showMenuButton = true;

    items!: MenuItem[];

    itensMenuPerfil: MenuItem[] = [
        {
            label: 'Consultar / Alterar Dados',
            icon: 'pi pi-user-edit',
            command: () => this.irParaPerfil()
        },
        {
            label: 'Sair',
            icon: 'pi pi-sign-out',
            command: () => this.sair()
        }
    ];

    constructor(
        public layoutService: LayoutService,
        public authService: AuthService,
        private readonly router: Router
    ) {}

    toggleDarkMode() {
        this.layoutService.layoutConfig.update((state) => ({ ...state, darkTheme: !state.darkTheme }));
    }

    primeiroNome(nomeCompleto: string): string {
        return nomeCompleto.split(' ')[0];
    }

    async irParaLogin(): Promise<void> {
        await this.router.navigate(['/login']);
    }

    async irParaPerfil(): Promise<void> {
        const tipoUsuario = this.authService.usuario()?.id_tipo_usuario;
        const rotasPorTipo: Record<number, string> = {
            1: '/cadastro/diretoria/perfil',
            2: '/cadastro/concorrente/perfil',
            3: '/cadastro/externo/perfil',
            4: '/cadastro/colaborador/perfil'
        };

        if (!tipoUsuario) {
            await this.router.navigate(['/login']);
            return;
        }

        await this.router.navigate([rotasPorTipo[tipoUsuario] || '/']);
    }

    async sair(): Promise<void> {
        await this.authService.logout();
        await this.router.navigate(['/']);
    }
}
