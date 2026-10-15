import { Component, computed, effect, inject, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { SkeletonModule } from 'primeng/skeleton';
import { MessageModule } from 'primeng/message';
import { CarrinhoService } from '../../services/carrinho.service';

@Component({
    selector: 'app-loja-carrinho', standalone: true,
    imports: [RouterLink, ButtonModule, SkeletonModule, MessageModule],
    templateUrl: './loja-carrinho.component.html', styleUrl: './loja-carrinho.component.scss'
})
export class LojaCarrinhoComponent {
    readonly carrinho = inject(CarrinhoService);
    readonly linhas = computed(() => {
        const cotados = new Map(this.carrinho.cotacao()?.itens.map((item) => [item.produtoId, item]));
        return this.carrinho.ids().map((id) => ({ id, item: cotados.get(id) }));
    });
    private readonly formato = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
    readonly preco = (centavos: number) => this.formato.format(centavos / 100);

    constructor() {
        effect(() => {
            this.carrinho.ids();
            // Somente mudancas nos IDs disparam cotacao; os estados da resposta nao.
            untracked(() => this.carrinho.cotar());
        });
    }
}
