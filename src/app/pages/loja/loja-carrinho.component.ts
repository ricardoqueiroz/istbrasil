import { Component, DestroyRef, computed, effect, inject, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { FormControl, ReactiveFormsModule, Validators } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { SkeletonModule } from 'primeng/skeleton';
import { MessageModule } from 'primeng/message';
import { CarrinhoService } from '../../services/carrinho.service';
import { LojaPedidoService } from '../../services/loja-pedido.service';
import { LojaCheckoutComponent } from './loja-checkout.component';
import { CheckoutEstado, LojaCheckoutService } from '../../services/loja-checkout.service';
import { LojaCotacao, LojaPedido } from './models/loja.model';

export const pedidosEquivalentes = (pedido: LojaPedido, cotacao: LojaCotacao): boolean => {
    const dinheiro = (n: number) => Number.isSafeInteger(n) && n > 0;
    if (pedido.moeda !== 'BRL' || cotacao.moeda !== pedido.moeda || !dinheiro(pedido.totalCentavos)
        || pedido.totalCentavos !== cotacao.totalCentavos || !Number.isFinite(Date.parse(cotacao.geradaEm))
        || !Array.isArray(pedido.itens) || !Array.isArray(cotacao.itens) || !pedido.itens.length
        || pedido.itens.length !== cotacao.itens.length) return false;
    const ids = new Set(pedido.itens.map(i => i.produtoId));
    if (ids.size !== pedido.itens.length || new Set(cotacao.itens.map(i => i.produtoId)).size !== ids.size) return false;
    return pedido.itens.every(i => {
        const c = cotacao.itens.find(c => c.produtoId === i.produtoId);
        return Number.isSafeInteger(i.produtoId) && i.produtoId > 0 && i.quantidade === 1 && !!c
            && c.quantidade === i.quantidade && dinheiro(i.precoUnitarioCentavos)
            && i.precoUnitarioCentavos === i.subtotalCentavos && c.precoUnitarioCentavos === i.precoUnitarioCentavos
            && c.subtotalCentavos === i.subtotalCentavos && c.produto?.id === i.produtoId
            && c.produto.moeda === pedido.moeda && c.produto.disponivel === true;
    }) && pedido.itens.reduce((s, i) => s + i.subtotalCentavos, 0) === pedido.totalCentavos;
};

@Component({
    selector: 'app-loja-carrinho', standalone: true,
    imports: [RouterLink, ReactiveFormsModule, ButtonModule, InputTextModule, SkeletonModule, MessageModule, LojaCheckoutComponent],
    templateUrl: './loja-carrinho.component.html', styleUrl: './loja-carrinho.component.scss'
})
export class LojaCarrinhoComponent {
    readonly carrinho = inject(CarrinhoService);
    readonly pedidos = inject(LojaPedidoService);
    readonly checkout = inject(LojaCheckoutService);
    readonly etapaPagamento = signal(true);
    readonly email = new FormControl(this.pedidos.emailConfirmado() ?? this.pedidos.pendente()?.entrada.compradorEmail ?? '', {
        nonNullable: true, validators: [Validators.required, Validators.email, Validators.maxLength(254)]
    });
    readonly bloqueado = computed(() => this.pedidos.processando() || !!this.pedidos.pendente() || this.checkout.ocupado());
    readonly anterior = signal<CheckoutEstado | null>(null);
    private cotacaoAnterior: LojaCotacao | null = null;
    readonly equivalente = computed(() => {
        const e = this.anterior(), c = this.carrinho.cotacao();
        return !!e && !!c && c === this.cotacaoAnterior && pedidosEquivalentes(e.pedido, c);
    });
    readonly anteriorPago = computed(() => {
        const e = this.anterior(), pg = e?.pagamento;
        return e?.pedido.estado === 'PAGO' && pg?.estado === 'CAPTURADO' && pg.pedidoEstado === 'PAGO'
            && Number.isFinite(Date.parse(pg.pagamentoConfirmadoEm ?? ''));
    });
    readonly retomavel = computed(() => {
        const e = this.anterior(); return !!e && this.equivalente() && this.checkout.podeRetomar(e);
    });
    readonly linhas = computed(() => {
        const cotados = new Map(this.carrinho.cotacao()?.itens.map((item) => [item.produtoId, item]));
        return this.carrinho.ids().map((id) => ({ id, item: cotados.get(id) }));
    });
    private readonly formato = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
    readonly preco = (centavos: number) => this.formato.format(centavos / 100);

    constructor() {
        inject(DestroyRef).onDestroy(() => { if (this.cotacaoAnterior) this.checkout.cancelarContinuidade(); });
        effect(() => {
            this.carrinho.ids();
            // Somente mudancas nos IDs disparam cotacao; os estados da resposta nao.
            untracked(() => this.carrinho.cotar());
        });
        effect(() => {
            const cotacao = this.carrinho.cotacao();
            untracked(() => {
                if (this.cotacaoAnterior && cotacao !== this.cotacaoAnterior) {
                    this.checkout.cancelarContinuidade(); this.anterior.set(null); this.cotacaoAnterior = null;
                }
            });
        });
    }

    async consultarPedidoAnterior(): Promise<void> {
        const c = this.carrinho.cotacao();
        if (!c || this.carrinho.carregando() || this.carrinho.erro() || this.bloqueado() || this.pedidos.confirmado()) return;
        this.anterior.set(null); this.cotacaoAnterior = c;
        const e = await this.checkout.consultarAnterior();
        if (this.cotacaoAnterior === c && this.carrinho.cotacao() === c) this.anterior.set(e);
    }

    retomarPedidoAnterior(): void {
        const e = this.anterior();
        if (!e || !this.retomavel() || this.pedidos.pendente() || !this.checkout.restaurarAnterior(e)) return;
        this.pedidos.emailConfirmado.set(null); this.pedidos.precoAlterado.set(false);
        this.pedidos.confirmado.set(e.pedido); this.etapaPagamento.set(true);
        this.anterior.set(null); this.cotacaoAnterior = null;
    }

    async confirmarPedido(): Promise<void> {
        if (this.pedidos.processando() || this.checkout.ocupado()) return;
        if (this.pedidos.confirmado()) {
            this.etapaPagamento.set(true);
            return;
        }
        const pendente = this.pedidos.pendente();
        const cotacao = this.carrinho.cotacao();
        if (!pendente && this.checkout.pedidoSalvo() && !(this.anteriorPago() && this.cotacaoAnterior === cotacao)) {
            await this.consultarPedidoAnterior();
            return;
        }
        if (!pendente) {
            this.email.markAsTouched();
            if (this.email.invalid || !cotacao || this.carrinho.carregando() || this.carrinho.erro()) return;
        }
        await this.pedidos.confirmar(pendente?.entrada ?? {
            produtoIds: [...this.carrinho.ids()], compradorEmail: this.email.value.trim()
        }, pendente?.totalCotado ?? cotacao!.totalCentavos);
        const confirmado = this.pedidos.confirmado();
        if (confirmado) {
            this.etapaPagamento.set(true);
        }
    }
}
