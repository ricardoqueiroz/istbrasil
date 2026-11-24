import { Component, inject, InjectionToken, OnInit } from '@angular/core';

export const REDIRECIONAR_LOJA = new InjectionToken<(url: string) => void>('REDIRECIONAR_LOJA', {
    providedIn: 'root',
    factory: () => (url: string) => window.location.replace(url)
});

@Component({
    standalone: true,
    selector: 'app-loja-redirecionamento',
    template: ''
})
export class LojaRedirecionamentoComponent implements OnInit {
    private readonly redirecionar = inject(REDIRECIONAR_LOJA);

    ngOnInit(): void {
        this.redirecionar('https://loja.istbrasil.org.br/');
    }
}
