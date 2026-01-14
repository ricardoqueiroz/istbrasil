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
                    { label: 'Quem Somos', icon: 'pi pi-fw pi-users', routerLink: ['/instituto'] },
                    { label: 'Transparência', icon: 'pi pi-fw pi-file-pdf', routerLink: ['/transparencia'] },
                    { label: 'Localização', icon: 'pi pi-fw pi-map-marker', routerLink: ['/localizacao'] }
                ]
            },
            {
                label: 'Sebastião Tapajós',
                items: [
                    { label: 'Biografia', icon: 'pi pi-fw pi-info-circle', routerLink: ['/patrono/biografia'] },
                    { label: 'Obra Musical', icon: 'pi pi-fw pi-volume-up', routerLink: ['/patrono/obra'] },
                    { label: 'Discografia', icon: 'pi pi-fw pi-headphones', routerLink: ['/patrono/discografia'] }
                ]
            },
            {
                label: 'PROJETOS E TURISMO',
                items: [
                    { label: 'Cidade de Santarém', icon: 'pi pi-fw pi-map-marker', url: 'https://turismo.santarem.pa.gov.br/', target: '_blank' },
                    { label: 'Centro de Convenções', icon: 'pi pi-fw pi-building', url: 'https://www.facebook.com/p/Centro-de-Conven%C3%A7%C3%B5es-de-Santar%C3%A9m-Sebasti%C3%A3o-Tapaj%C3%B3s-61565020076617/', target: '_blank' },
                    { label: 'Ecoturismo', icon: 'pi pi-fw pi-camera', url: 'https://www.gov.br/icmbio/pt-br/assuntos/biodiversidade/unidade-de-conservacao/unidades-de-biomas/amazonia/lista-de-ucs/flona-do-tapajos', target: '_blank' }
                ]
            },
            {
                label: 'LOJA',
                items: [
                    { label: 'IST Editora', icon: 'pi pi-fw pi-shopping-cart', routerLink: ['/editora'] }
                ]
            }
        ];
    }
}
