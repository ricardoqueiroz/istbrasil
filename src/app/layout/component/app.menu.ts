import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { MenuItem } from 'primeng/api';
import { AppMenuitem } from './app.menuitem';

@Component({
    selector: 'app-menu',
    standalone: true,
    imports: [CommonModule, AppMenuitem, RouterModule],
    template: `<ul class="layout-menu">
        <ng-container *ngFor="let item of model; let i = index">
            <li app-menuitem *ngIf="!item.separator" [item]="item" [index]="i" [root]="true"></li>
            <li *ngIf="item.separator" class="menu-separator"></li>
        </ng-container>
    </ul> `
})
export class AppMenu {
    model: MenuItem[] = [];

    ngOnInit() {
        this.model = [
            {
                label: 'INSTITUTO IST',
                items: [
                    { label: 'Home', icon: 'pi pi-fw pi-home', routerLink: ['/'] },
                    { label: 'Quem Somos', icon: 'pi pi-fw pi-users', routerLink: ['/instituto/quem-somos'] },
                    { label: 'Transparência', icon: 'pi pi-fw pi-file-pdf', routerLink: ['/instituto/transparencia'] }
                ]
            },
            {
                label: 'O PATRONO',
                items: [
                    { label: 'Biografia', icon: 'pi pi-fw pi-info-circle', routerLink: ['/patrono/biografia'] },
                    { label: 'Obra Musical', icon: 'pi pi-fw pi-volume-up', routerLink: ['/patrono/obra'] },
                    { label: 'Museu Virtual', icon: 'pi pi-fw pi-camera', routerLink: ['/patrono/museu'] }
                ]
            },
            {
                label: 'PROJETOS E TURISMO',
                items: [
                    { label: 'Cidade de Santarém', icon: 'pi pi-fw pi-map-marker', routerLink: ['/turismo/santarem'] },
                    { label: 'Centro de Convenções', icon: 'pi pi-fw pi-building', routerLink: ['/turismo/centro-convencoes'] }
                ]
            },
            {
                label: 'LOJA',
                items: [
                    { label: 'IST Editora', icon: 'pi pi-fw pi-shopping-cart', routerLink: ['/loja'] }
                ]
            }
        ];
    }
}
