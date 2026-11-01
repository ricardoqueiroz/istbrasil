import { Component, DestroyRef, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { ButtonModule } from 'primeng/button';
import { MessageModule } from 'primeng/message';
import { Router, RouterLink } from '@angular/router';
import { HttpErrorResponse } from '@angular/common/http';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { EMPTY, Observable, Subscription, catchError, exhaustMap, of, switchMap, takeUntil, tap, timer, finalize } from 'rxjs';
import { DialogModule } from 'primeng/dialog';
import { DireitoBiblioteca, LojaBibliotecaService } from '../../services/loja-biblioteca.service';
import { CheckoutEstado, LojaCheckoutService } from '../../services/loja-checkout.service';

@Component({
    selector: 'app-loja-checkout', standalone: true, imports: [RouterLink, ButtonModule, MessageModule, DialogModule],
    template: `
        @if (pedidoId()) {
            <section aria-labelledby="checkout-titulo" [attr.aria-busy]="checkout.ocupado() || iniciandoPagamento()">
                <h2 id="checkout-titulo">Pagamento PayPal</h2>
                @if (conflito()) {
                    <p-message class="block my-3" severity="warn">Existe uma tentativa anterior para o pedido {{ checkout.pedidoSalvo() }}. Verifique sua conclusão antes de preparar o pedido atual. As chaves serão preservadas se o pagamento não estiver comprovadamente concluído.</p-message>
                    <p-button label="Verificar tentativa anterior" [disabled]="checkout.ocupado()" (onClick)="checkout.verificarAnterior(pedidoId()!)" />
                    @if (checkout.verificandoAnterior()) { <p role="status">Verificando o pagamento anterior. Aguarde.</p> }
                    @if (checkout.erro(); as erro) { <p-message class="block my-3" severity="warn">{{ erro }}</p-message> }
                } @else {
                    @if (estadoAtual()?.ambiente === 'sandbox') {
                        <p-message class="block my-3" severity="warn">Homologação — PayPal Sandbox — sem cobrança real</p-message>
                    }
                    @if (estadoAtual(); as estado) {
                        <p>Pedido: <strong>{{ estado.pedido.publicId }}</strong></p>
                        <ul>@for (item of estado.pedido.itens; track item.produtoId) {
                            <li>{{ item.titulo }} · {{ preco(item.subtotalCentavos) }}</li>
                        }</ul>
                        <p>Total oficial: <strong>{{ preco(estado.pedido.totalCentavos) }}</strong></p>
                        <p role="status">{{ situacao() }}</p>
                        @if (checkout.bibliotecaLiberada()) {
                            <a pButton routerLink="/loja/biblioteca">Acessar minha biblioteca digital</a>
                            <p>A confirmação por e-mail será processada separadamente. O acesso aos arquivos exige autorização na biblioteca.</p>
                        }
                    }
                    @if (!estadoAtual()) { <p role="status">Pedido {{ pedidoId() }}. Pague com PayPal ou consulte uma tentativa anterior deste pedido.</p> }
                    @if (aviso()) { <p role="status">{{ aviso() }}</p> }
                    @if (erroConsulta()) { <p-message class="block my-3" severity="warn">{{ erroConsulta() }}</p-message> }
                    @if (checkout.erro(); as erro) { <p-message class="block my-3" severity="warn">{{ erro }}</p-message> }
                    <div class="acoes">
                        @if (podePagar()) {
                            @if (checkout.aberturaPronta()) {
                                <p-button label="Continuar no PayPal" [loading]="checkout.ocupado()"
                                    [disabled]="checkout.ocupado() || iniciandoPagamento() || manualEmCurso()" (onClick)="checkout.pagar()" />
                            } @else {
                                <p-button label="Preparar pagamento" [loading]="iniciandoPagamento() || checkout.ocupado()"
                                    [disabled]="checkout.ocupado() || iniciandoPagamento() || manualEmCurso()" (onClick)="iniciarPagamento()" />
                            }
                        }
                        @if (checkout.podeAcompanhar() && !checkout.acompanhamento()) {
                            <p-button label="Retomar acompanhamento" [outlined]="true"
                                [disabled]="checkout.ocupado() || iniciandoPagamento() || manualEmCurso() || checkout.pedidoSalvo() !== pedidoId()"
                                (onClick)="retomarAcompanhamento()" />
                        }
                        <p-button label="Consultar estado do pedido" [outlined]="true" [disabled]="checkout.ocupado() || iniciandoPagamento() || manualEmCurso() || checkout.pedidoSalvo() !== pedidoId()" (onClick)="consultarManual()" />
                    </div>
                    @if (checkout.ocupado()) { <p role="status">Processando. Aguarde sem iniciar outra tentativa.</p> }
                }
            </section>
        }
        <p-dialog header="Estado do pedido" [visible]="dialogoAberto()" [modal]="true" [closable]="false"
            [dismissableMask]="false" [closeOnEscape]="false" [style]="{width:'min(36rem, 95vw)'}">
            <p>Pedido: {{ pedidoId() }}</p>
            @if (estadoAtual(); as e) {
                <p>Valor: {{ preco(e.pedido.totalCentavos) }}</p>
                <p>{{ situacao() }}</p>
                <p>{{ situacaoDireitos() }}</p>
                @if (e.pagamento?.estado === 'APROVADO') {
                    <p>Se a confirmação não avançar, retome o pagamento já aprovado. O pedido e suas chaves serão preservados.</p>
                    <p-button label="Retomar confirmação do pagamento" [outlined]="true"
                        [disabled]="checkout.ocupado() || iniciandoPagamento() || manualEmCurso() || conflito()"
                        (onClick)="retomarConfirmacao()" />
                }
            } @else { <p>Ainda não há informação confirmada para este pedido.</p> }
            @if (manualEmCurso()) { <p role="status">Consultando…</p> }
            @if (erroConsulta()) { <p-message class="block my-3" severity="warn">{{ erroConsulta() }} A última informação conhecida foi preservada.</p-message> }
            <ng-template #footer><p-button label="Fechar" (onClick)="fecharConsulta()" /></ng-template>
        </p-dialog>
    `,
    styles: [`section { margin-block: 1.5rem; padding: 1.25rem; border: 1px solid var(--surface-border); border-radius: var(--content-border-radius); } .acoes { display: flex; flex-wrap: wrap; gap: .75rem; margin-top: 1rem; }`]
})
export class LojaCheckoutComponent {
    readonly checkout = inject(LojaCheckoutService);
    readonly pedidoId = input<string | null>(null);
    readonly conflito = computed(() => !!this.checkout.pedidoSalvo() && this.checkout.pedidoSalvo() !== this.pedidoId());
    readonly estadoAtual = computed(() => this.checkout.estado()?.pedido.publicId === this.pedidoId() ? this.checkout.estado() : null);
    readonly preco = (n: number) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(n / 100);
    readonly iniciandoPagamento = signal(false);
    readonly podePagar = computed(() => {
        const e = this.estadoAtual();
        return !e || (['CRIADO', 'AGUARDANDO_PAGAMENTO'].includes(e.pedido.estado)
            && (!e.pagamento || e.pagamento.estado === 'AGUARDANDO_APROVACAO'));
    });
    readonly situacao = computed(() => {
        const pg = this.estadoAtual()?.pagamento;
        const d = this.checkout.direitosConsultados();
        if (this.checkout.confirmado() && d?.estado === this.estadoAtual()
            && d?.direitos.some(x => ['SUSPENSO', 'REVOGADO'].includes(x.estado)))
            return 'Pagamento confirmado. O acesso digital está indisponível. Procure o atendimento com o código do pedido. Não efetue outro pagamento.';
        if (this.estadoAtual() && this.checkout.confirmado()) return this.checkout.bibliotecaLiberada()
            ? 'Livro disponível. Pagamento confirmado. Acesse sua biblioteca digital.'
            : 'Pagamento confirmado. Estamos liberando seu livro digital. Retome o acompanhamento ou consulte o pedido. Se a pendência persistir, procure o atendimento com o código do pedido. Não efetue outro pagamento.';
        if (!pg) return this.estadoAtual()?.pedido.estado === 'AGUARDANDO_PAGAMENTO'
            ? 'Aguardando pagamento.' : this.estadoAtual()?.pedido.estado === 'CRIADO'
                ? 'Pedido criado. Pagamento ainda não realizado.' : 'Pedido sem captura integral confirmada. Consulte o estado ou procure o atendimento.';
        if (['REEMBOLSADO','PARCIALMENTE_REEMBOLSADO','ESTORNADO'].includes(pg.estado)) return 'Pagamento reembolsado ou estornado. Procure o atendimento para verificar o acesso digital.';
        if (pg.estado === 'AGUARDANDO_APROVACAO') return 'Conclua a aprovação no PayPal. Se já aprovou, acompanhe a confirmação ou consulte o pedido antes de tentar novamente.';
        if (['CRIANDO', 'APROVADO', 'CAPTURANDO', 'PENDENTE', 'DESCONHECIDO'].includes(pg.estado))
            return 'Confirmando pagamento. Aguarde ou retome o acompanhamento. Não efetue outro pagamento.';
        if (pg.estado === 'RECUSADO') return 'Pagamento recusado. Consulte o pedido ou procure o atendimento antes de tentar novamente.';
        if (['CANCELADO', 'EXPIRADO', 'REVISAO'].includes(pg.estado)) return 'Pagamento nao confirmado. Consulte o estado ou procure o atendimento.';
        return 'Aguardando aprovacao e confirmacao do pagamento.';
    });
    private readonly biblioteca = inject(LojaBibliotecaService);
    private readonly router = inject(Router);
    private readonly destroy = inject(DestroyRef);
    readonly dialogoAberto = signal(false);
    readonly manualEmCurso = signal(false);
    readonly aviso = signal('');
    readonly erroConsulta = signal('');
    readonly situacaoDireitos = computed(() => {
        const d = this.checkout.direitosConsultados();
        if (!d || d.estado !== this.estadoAtual()) return 'Direitos digitais ainda não confirmados para este estado do pedido.';
        return d.direitos.length ? d.direitos.map(x => `${x.titulo}: ${x.estado === 'ATIVO' && x.podeSolicitarArquivo
            ? 'disponível' : ['SUSPENSO', 'REVOGADO'].includes(x.estado) ? 'acesso indisponível; procure o atendimento' : 'em liberação'}`).join('; ')
            : 'Direitos digitais ainda não disponíveis.';
    });
    private retomarEm = 0;
    private navegou = false;
    private destruido = false;
    private ultimoPedido: string | null = null;
    private consulta?: Subscription;

    constructor() {
        this.destroy.onDestroy(() => {
            this.destruido = true;
            this.consulta?.unsubscribe();
            const id = this.pedidoId(); if (id) this.checkout.encerrarAcompanhamento(id);
        });
        effect(onCleanup => {
            const id = this.pedidoId(), fluxo = this.checkout.acompanhamento();
            untracked(() => {
                if (this.ultimoPedido !== id) {
                    if (this.ultimoPedido) this.checkout.encerrarAcompanhamento(this.ultimoPedido);
                    this.consulta?.unsubscribe(); this.dialogoAberto.set(false); this.manualEmCurso.set(false);
                    this.ultimoPedido = id; this.navegou = false; this.retomarEm = 0;
                    this.erroConsulta.set(''); this.aviso.set('');
                }
                if (!id || !fluxo || fluxo.pedidoPublicId !== id || this.conflito()) return;
                const restante = 120000 - (Date.now() - fluxo.inicio);
                if (restante <= 0) { this.encerrarPorPrazo(id); return; }
                const sub = timer(5000, 5000).pipe(
                    exhaustMap(() => this.manualEmCurso() || Date.now() < this.retomarEm ? EMPTY
                        : this.ciclo(id).pipe(catchError(e => { this.tratarErro(e, id); return EMPTY; }))),
                    takeUntil(timer(restante).pipe(tap(() => this.encerrarPorPrazo(id)))),
                    takeUntilDestroyed(this.destroy)
                ).subscribe(e => this.receberCiclo(id, e));
                onCleanup(() => sub.unsubscribe());
            });
        });
    }
    async iniciarPagamento(): Promise<void> {
        const id = this.pedidoId();
        if (!id || this.destruido || this.conflito() || !this.podePagar() || this.checkout.ocupado()
            || this.iniciandoPagamento() || this.manualEmCurso()) return;
        this.iniciandoPagamento.set(true);
        try {
            if (!this.checkout.pronto()) await this.checkout.preparar(id);
            if (this.destruido || this.pedidoId() !== id || this.conflito() || !this.checkout.pronto()) return;
            if (this.podePagar()) await this.checkout.prepararAbertura();
            if (!this.podePagar()) this.checkout.retomarAcompanhamento(id);
        } finally { this.iniciandoPagamento.set(false); }
    }
    private encerrarPorPrazo(id: string): void {
        this.aviso.set('O acompanhamento automático terminou. Retome por até dois minutos ou consulte o estado do pedido. Isso não cancela o pagamento. Não pague novamente enquanto a confirmação estiver pendente.');
        this.checkout.encerrarAcompanhamento(id);
    }
    private lerDireitos(id: string, apos?: string, anteriores: DireitoBiblioteca[] = [], vistos = new Set<string>()): Observable<DireitoBiblioteca[]> {
        return this.biblioteca.listar(apos, id).pipe(switchMap(p => {
            if (!p || !Array.isArray(p.direitos) || p.direitos.length > 50 || anteriores.length + p.direitos.length > 100)
                throw new Error('CONTRATO_DIREITOS_INVALIDO');
            const todos = [...anteriores, ...p.direitos];
            if (p.proximoCursor === null) return of(todos);
            if (typeof p.proximoCursor !== 'string' || !p.direitos.length || vistos.has(p.proximoCursor))
                throw new Error('CONTRATO_DIREITOS_INVALIDO');
            vistos.add(p.proximoCursor);
            return this.lerDireitos(id, p.proximoCursor, todos, vistos);
        }));
    }
    private ciclo(id: string): Observable<CheckoutEstado> {
        return this.checkout.observar(id).pipe(switchMap(e => {
            if (!this.checkout.confirmado()) return of(e);
            return this.lerDireitos(id).pipe(tap(d => this.checkout.registrarDireitos(id, e, d)), switchMap(() => of(e)));
        }), takeUntil(this.checkout.leiturasInterrompidas), takeUntilDestroyed(this.destroy));
    }
    private receberCiclo(id: string, e: CheckoutEstado): void {
        if (this.destruido || this.pedidoId() !== id || this.checkout.estado() !== e) return;
        this.erroConsulta.set('');
        const terminais = ['RECUSADO', 'CANCELADO', 'EXPIRADO', 'REVISAO', 'REEMBOLSADO', 'PARCIALMENTE_REEMBOLSADO', 'ESTORNADO'];
        const d = this.checkout.direitosConsultados();
        if (terminais.includes(e.pedido.estado) || terminais.includes(e.pagamento?.estado ?? '')
            || (d?.estado === e && d.direitos.some(x => ['SUSPENSO', 'REVOGADO'].includes(x.estado)))) {
            if (d?.estado === e && d.direitos.some(x => ['SUSPENSO', 'REVOGADO'].includes(x.estado)))
                this.aviso.set('O acesso digital está suspenso ou revogado. Procure o atendimento.');
            this.checkout.encerrarAcompanhamento(id); return;
        }
        if (this.checkout.bibliotecaLiberada()) {
            this.checkout.encerrarAcompanhamento(id);
            if (!this.dialogoAberto() && !this.navegou) {
                this.navegou = true;
                void this.router.navigateByUrl('/loja/biblioteca').then(ok => {
                    if (!ok) { this.navegou = false; this.erroConsulta.set('Não foi possível abrir a biblioteca. Consulte novamente.'); }
                }).catch(() => { this.navegou = false; this.erroConsulta.set('Não foi possível abrir a biblioteca. Consulte novamente.'); });
            }
        }
    }
    private tratarErro(e: unknown, id: string): void {
        if (this.destruido || this.pedidoId() !== id) return;
        if (e instanceof HttpErrorResponse) {
            if (e.status === 429) {
                const retry = e.headers.get('Retry-After');
                const segundos = retry && /^\d+$/.test(retry) ? Number(retry) * 1000 : 0;
                this.retomarEm = Math.max(Date.now() + 5000, segundos ? Date.now() + segundos : Date.parse(retry ?? '') || Date.now() + 60000);
                this.erroConsulta.set('Muitas consultas. Aguarde antes de consultar novamente.'); return;
            }
            if ([401, 403, 404].includes(e.status)) {
                this.checkout.encerrarAcompanhamento(id);
                this.erroConsulta.set(e.status === 401 ? 'Sessão expirada ou inválida. Verifique o pedido antes de tentar novamente.'
                    : e.status === 403 ? 'Não foi possível autorizar a consulta. Atualize a página e verifique a sessão.'
                        : 'Pedido indisponível nesta sessão. Verifique o identificador e procure o atendimento.'); return;
            }
            if (e.status === 0 || e.status >= 500) {
                this.erroConsulta.set('Consulta temporariamente indisponível. O último resultado foi preservado.'); return;
            }
        }
        this.checkout.encerrarAcompanhamento(id);
        this.erroConsulta.set('Não foi possível confirmar o estado deste pedido. Consulte novamente ou procure o atendimento.');
    }
    retomarAcompanhamento(): void {
        const id = this.pedidoId();
        if (!id || this.conflito() || this.iniciandoPagamento() || this.manualEmCurso() || Date.now() < this.retomarEm) return;
        this.checkout.retomarAcompanhamento(id);
        if (this.checkout.acompanhamento()?.pedidoPublicId === id) this.aviso.set('Acompanhamento retomado por até dois minutos. Não efetue outro pagamento.');
    }
    async retomarConfirmacao(): Promise<void> {
        const id = this.pedidoId();
        if (!id || this.destruido || this.conflito() || !this.dialogoAberto() || this.iniciandoPagamento()
            || this.manualEmCurso() || this.checkout.ocupado() || Date.now() < this.retomarEm
            || this.estadoAtual()?.pagamento?.estado !== 'APROVADO') return;
        this.manualEmCurso.set(true);
        await this.checkout.concluirCaptura();
        if (this.destruido || this.pedidoId() !== id) return;
        this.manualEmCurso.set(false);
        if (this.checkout.erro()) this.tratarErro(this.checkout.falhaConsulta(), id);
        else this.consultarUmaVez(id);
    }
    async consultarManual(): Promise<void> {
        const id = this.pedidoId();
        if (!id || this.conflito() || this.iniciandoPagamento() || this.checkout.ocupado() || this.manualEmCurso()) return;
        this.dialogoAberto.set(true);
        if (Date.now() < this.retomarEm) return;
        this.manualEmCurso.set(true);
        await this.checkout.consultar(id);
        if (this.destruido || this.pedidoId() !== id) return;
        if (this.checkout.erro()) { this.tratarErro(this.checkout.falhaConsulta(), id); this.manualEmCurso.set(false); return; }
        this.consultarUmaVez(id);
    }
    private consultarUmaVez(id: string): void {
        this.manualEmCurso.set(true);
        this.consulta = this.ciclo(id).pipe(finalize(() => this.manualEmCurso.set(false)))
            .subscribe({ next: e => this.receberCiclo(id, e), error: e => this.tratarErro(e, id) });
    }
    fecharConsulta(): void {
        this.dialogoAberto.set(false);
        const id = this.pedidoId();
        if (!id || this.manualEmCurso() || this.conflito() || Date.now() < this.retomarEm) return;
        this.consultarUmaVez(id);
    }

}
