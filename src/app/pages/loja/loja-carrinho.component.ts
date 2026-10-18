import { Component, computed, effect, inject, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { FormControl, ReactiveFormsModule, Validators } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { SkeletonModule } from 'primeng/skeleton';
import { MessageModule } from 'primeng/message';
import { CarrinhoService } from '../../services/carrinho.service';
import { LojaPedidoService } from '../../services/loja-pedido.service';
import { LojaCheckoutComponent } from './loja-checkout.component';
import { LojaCheckoutService } from '../../services/loja-checkout.service';

@Component({
    selector: 'app-loja-carrinho', standalone: true,
    imports: [RouterLink, ReactiveFormsModule, ButtonModule, InputTextModule, SkeletonModule, MessageModule, LojaCheckoutComponent],
    templateUrl: './loja-carrinho.component.html', styleUrl: './loja-carrinho.component.scss'
})
export class LojaCarrinhoComponent {
    readonly carrinho = inject(CarrinhoService);
    readonly pedidos = inject(LojaPedidoService);
    readonly checkout = inject(LojaCheckoutService);
    readonly email = new FormControl(this.pedidos.pendente()?.entrada.compradorEmail ?? '', {
        nonNullable: true, validators: [Validators.required, Validators.email, Validators.maxLength(254)]
    });
    readonly bloqueado = computed(() => this.pedidos.processando() || !!this.pedidos.pendente());
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

    async confirmarPedido(): Promise<void> {
        if (this.pedidos.processando()) return;
        const pendente = this.pedidos.pendente();
        const cotacao = this.carrinho.cotacao();
        if (!pendente) {
            this.email.markAsTouched();
            if (this.email.invalid || !cotacao || this.carrinho.carregando() || this.carrinho.erro()) return;
        }
        await this.pedidos.confirmar(pendente?.entrada ?? {
            produtoIds: [...this.carrinho.ids()], compradorEmail: this.email.value.trim()
        }, pendente?.totalCotado ?? cotacao!.totalCentavos);
        const confirmado = this.pedidos.confirmado();
        if (confirmado) {
            // Limpar apenas os produtos confirmados; preservar adicoes feitas em outra pagina.
            confirmado.itens.forEach((item) => this.carrinho.remover(item.produtoId));
        }
    }
}
