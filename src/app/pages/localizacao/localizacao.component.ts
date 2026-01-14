import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { CardModule } from 'primeng/card';
import { ButtonModule } from 'primeng/button';
import { RippleModule } from 'primeng/ripple';

@Component({
    selector: 'app-localizacao',
    standalone: true,
    imports: [CommonModule, CardModule, ButtonModule, RippleModule],
    templateUrl: './localizacao.component.html',
    styleUrls: ['./localizacao.component.css']
})
export class LocalizacaoComponent {}