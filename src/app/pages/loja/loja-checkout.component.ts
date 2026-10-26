import { Component, computed, inject, input } from '@angular/core';
import { ButtonModule } from 'primeng/button';
import { MessageModule } from 'primeng/message';
import {RouterLink} from '@angular/router';
import { LojaCheckoutService } from '../../services/loja-checkout.service';

@Component({
    selector: 'app-loja-checkout', standalone: true, imports: [RouterLink, ButtonModule, MessageModule],
    template: `
        @if (pedidoId() || checkout.pedidoSalvo()) {
            <section aria-labelledby="checkout-titulo" [attr.aria-busy]="checkout.ocupado()">
                <h2 id="checkout-titulo">Pagamento PayPal</h2>
                @if (checkout.estado()?.ambiente === 'sandbox') {
                    <p-message severity="warn">Homologação — PayPal Sandbox — sem cobrança real</p-message>
                }
                @if (checkout.estado(); as estado) {
                    <p>Pedido: <strong>{{ estado.pedido.publicId }}</strong></p>
                    <ul>@for (item of estado.pedido.itens; track item.produtoId) {
                        <li>{{ item.titulo }} · {{ preco(item.subtotalCentavos) }}</li>
                    }</ul>
                    <p>Total oficial: <strong>{{ preco(estado.pedido.totalCentavos) }}</strong></p>
                    <p role="status">{{ situacao() }}</p>
                    @if (checkout.confirmado()) {
                        <a pButton routerLink="/loja/biblioteca">Acessar minha biblioteca digital</a>
                        <p>A confirmação por e-mail será processada separadamente. O acesso aos arquivos exige autorização na biblioteca.</p>
                    }
                }
                @if (checkout.erro(); as erro) { <p-message severity="warn">{{ erro }}</p-message> }
                <div class="acoes">
                    @if (!checkout.pronto()) {
                        <p-button label="Preparar pagamento" [disabled]="checkout.ocupado()" (onClick)="checkout.preparar(pedidoId() || checkout.pedidoSalvo()!)" />
                    } @else if (checkout.estado()?.pagamento?.estado === 'APROVADO') {
                        <p-button label="Concluir captura autorizada" [disabled]="checkout.ocupado()" (onClick)="checkout.concluirCaptura()" />
                    } @else if (podePagar()) {
                        <p-button label="Pagar com PayPal Sandbox" [disabled]="checkout.ocupado()" (onClick)="checkout.pagar()" />
                    }
                    <p-button label="Consultar estado do pedido" [outlined]="true" [disabled]="checkout.ocupado() || !checkout.pedidoSalvo()" (onClick)="checkout.consultar()" />
                </div>
                @if (checkout.ocupado()) { <p role="status">Processando. Aguarde sem iniciar outra tentativa.</p> }
            </section>
        }
    `,
    styles: [`section { margin-block: 1.5rem; padding: 1.25rem; border: 1px solid var(--surface-border); border-radius: var(--content-border-radius); } .acoes { display: flex; flex-wrap: wrap; gap: .75rem; margin-top: 1rem; }`]
})
export class LojaCheckoutComponent {
    readonly checkout = inject(LojaCheckoutService);
    readonly pedidoId = input<string | null>(null);
    readonly preco = (n: number) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(n / 100);
    readonly podePagar = computed(() => !this.checkout.estado()?.pagamento
        || ['AGUARDANDO_APROVACAO', 'APROVADO'].includes(this.checkout.estado()?.pagamento?.estado ?? ''));
    readonly situacao = computed(() => {
        const pg = this.checkout.estado()?.pagamento;
        if (this.checkout.confirmado()) return 'Pagamento confirmado.';
        if (!pg) return 'Pedido criado. Pagamento ainda não realizado.';
        if (pg.estado === 'AGUARDANDO_APROVACAO') return 'Aguardando aprovação do comprador.';
        if (pg.estado === 'APROVADO') return 'Aprovação recebida. A captura ainda não foi confirmada.';
        if (pg.estado === 'CAPTURANDO') return 'Captura em processamento. Pagamento ainda não confirmado.';
        if (pg.estado === 'RECUSADO') return 'Pagamento recusado.';
        if (pg?.estado === 'PENDENTE') return 'Pagamento pendente de confirmacao. Nao efetue outro pagamento.';
        if (['CANCELADO', 'EXPIRADO', 'REVISAO'].includes(pg.estado)) return 'Pagamento nao confirmado. Consulte o estado ou procure o atendimento.';
        if (pg.estado === 'DESCONHECIDO') return 'Resultado financeiro pendente de reconciliacao. Consulte o estado; nao inicie outro pagamento.';
        return 'Aguardando aprovacao e confirmacao do pagamento.';
    });
}
