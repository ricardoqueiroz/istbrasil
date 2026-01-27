import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { CardModule } from 'primeng/card';
import { ButtonModule } from 'primeng/button';
import { RippleModule } from 'primeng/ripple';
import { FooterWidget } from 'src/app/shared/footer';

@Component({
    selector: 'app-localizacao',
    standalone: true,
    imports: [CommonModule, CardModule, ButtonModule, RippleModule, FooterWidget],
    templateUrl: './localizacao.component.html',
    styleUrls: ['./localizacao.component.css']
})
export class LocalizacaoComponent {}