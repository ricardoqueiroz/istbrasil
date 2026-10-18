import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, InjectionToken, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { CARRINHO_STORAGE } from './carrinho.service';
import { LojaService } from './loja.service';
import { LojaPedido } from '../pages/loja/models/loja.model';

export interface CheckoutPagamento {
    publicId: string; pedidoPublicId: string; estado: string; pedidoEstado: LojaPedido['estado'];
    moeda: 'BRL'; valorCentavos: number; pagamentoConfirmadoEm: string | null;
}
export interface CheckoutEstado { pedido: LojaPedido; pagamento: CheckoutPagamento | null; ordemId: string | null; }
interface TentativaCheckout { pedidoPublicId: string; criacao: string; captura: string; expiraSessao: string; }
interface SessaoPayPal { start(opcoes: { presentationMode: 'popup' }, ordem: Promise<{ orderId: string }>): Promise<void>; }
export interface SdkCheckout {
    findEligibleMethods(opcoes: { currencyCode: 'BRL' }): Promise<{ isEligible(metodo: string): boolean }>;
    createPayPalOneTimePaymentSession(eventos: { onApprove(data: { orderId: string }): Promise<void>; onCancel(): void; onError(): void }): SessaoPayPal;
}
interface PayPalV6 { createInstance(opcoes: { clientId: string; components: string[]; pageType: string }): Promise<SdkCheckout>; }
export const CARREGAR_PAYPAL_V6 = new InjectionToken<() => Promise<PayPalV6>>('SDK PayPal v6 Sandbox', {
    providedIn: 'root', factory: () => {
        let carregamento: Promise<PayPalV6> | null = null;
        return () => carregamento ??= new Promise((resolve, reject) => {
            // URL fixa: nao utiliza valores do comprador, configuracao Live ou SDK legado.
            const script = document.createElement('script');
            script.src = 'https://www.sandbox.paypal.com/web-sdk/v6/core'; script.async = true;
            script.onload = () => {
                const sdk = (window as unknown as { paypal?: PayPalV6 }).paypal;
                if (typeof sdk?.createInstance === 'function') resolve(sdk);
                else { carregamento = null; script.remove(); reject(new Error('SDK_INDISPONIVEL')); }
            };
            script.onerror = () => { carregamento = null; script.remove(); reject(new Error('SDK_INDISPONIVEL')); };
            document.head.appendChild(script);
        });
    }
});
export const CHECKOUT_STORAGE_KEY = 'ist.loja.checkout';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable({ providedIn: 'root' })
export class LojaCheckoutService {
    private readonly http = inject(HttpClient);
    private readonly loja = inject(LojaService);
    private readonly storage = inject(CARRINHO_STORAGE);
    private readonly carregarSdk = inject(CARREGAR_PAYPAL_V6);
    private tentativa: TentativaCheckout | null = null;
    private sdk: SdkCheckout | null = null;
    private csrf = '';
    readonly estado = signal<CheckoutEstado | null>(null);
    readonly ocupado = signal(false);
    readonly pronto = signal(false);
    readonly erro = signal<string | null>(null);
    readonly pedidoSalvo = signal<string | null>(null);
    readonly confirmado = computed(() => {
        const pg = this.estado()?.pagamento;
        return pg?.estado === 'CAPTURADO' && pg.pedidoEstado === 'PAGO' && !!pg.pagamentoConfirmadoEm;
    });
    private armazenamentoInvalido = false;

    constructor() {
        try {
            const salvo = this.storage?.getItem(CHECKOUT_STORAGE_KEY);
            if (salvo) {
                const t = JSON.parse(salvo) as TentativaCheckout;
                if (!uuid.test(t.pedidoPublicId) || !uuid.test(t.criacao) || !uuid.test(t.captura) || !Number.isFinite(Date.parse(t.expiraSessao))) throw new Error();
                this.tentativa = t; this.pedidoSalvo.set(t.pedidoPublicId);
            }
        } catch { this.armazenamentoInvalido = true; this.erro.set('Nao foi possivel recuperar a tentativa. Verifique o resultado com o atendimento antes de pagar novamente.'); }
    }

    private async sessao(): Promise<string> {
        const r = await firstValueFrom(this.loja.estabelecerSessao());
        const csrf = r.headers.get('X-CSRF-Token'), expira = r.body?.sessao.expiraEm;
        if (!csrf || !expira || Date.parse(expira) <= Date.now()
            || (this.tentativa && (r.status !== 200 || expira !== this.tentativa.expiraSessao))) {
            throw new Error('SESSAO_INVALIDA');
        }
        this.csrf = csrf; return expira;
    }
    private post<T>(acao: string, corpo: object, chave?: string): Promise<T> {
        return firstValueFrom(this.http.post<T>(`/api/loja/checkout/${acao}`, corpo, { withCredentials: true,
            headers: { 'X-IST-Loja': '1', 'X-CSRF-Token': this.csrf, ...(chave ? { 'Idempotency-Key': chave } : {}) } }));
    }
    private mensagem(e: unknown): void {
        const codigo = e instanceof HttpErrorResponse ? e.error?.erro?.codigo : e instanceof Error ? e.message : '';
        const mensagens: Record<string, string> = {
            SESSAO_INVALIDA: 'A sessao original expirou ou nao pode ser reutilizada. Verifique o pedido com o atendimento.',
            CSRF_INVALIDO: 'Protecao expirada. Consulte novamente antes de repetir com a mesma tentativa.',
            PEDIDO_NAO_ENCONTRADO: 'Pedido indisponivel nesta sessao de compra.',
            PEDIDO_EXPIRADO: 'O prazo do pedido expirou. Verifique o resultado antes de criar outro.',
            APROVACAO_PENDENTE: 'A aprovacao ainda nao foi confirmada pelo PayPal.',
            CONFLITO_IDEMPOTENCIA: 'Existe conflito com uma tentativa anterior. Consulte o estado e procure o atendimento.',
            INELEGIVEL: 'Pagamento PayPal indisponivel para este navegador ou conta.'
        };
        this.erro.set(mensagens[codigo] ?? 'Nao foi possivel confirmar a operacao. Consulte novamente; a tentativa e suas chaves foram preservadas.');
    }
    async preparar(pedidoPublicId: string): Promise<void> {
        if (this.ocupado() || this.armazenamentoInvalido) return;
        this.ocupado.set(true); this.erro.set(null); this.pronto.set(false);
        try {
            if (!uuid.test(pedidoPublicId) || (this.tentativa && this.tentativa.pedidoPublicId !== pedidoPublicId)) throw new Error('TENTATIVA_ATIVA');
            const expiraSessao = await this.sessao();
            if (!this.tentativa) {
                const t = { pedidoPublicId, criacao: this.chave(), captura: this.chave(), expiraSessao };
                if (!this.storage) throw new Error('ARMAZENAMENTO');
                this.storage.setItem(CHECKOUT_STORAGE_KEY, JSON.stringify(t));
                this.tentativa = t; this.pedidoSalvo.set(pedidoPublicId);
            }
            await this.atualizar();
            const config = await this.post<{ ambiente: string; clientId: string }>('configuracao', {});
            if (config.ambiente !== 'sandbox') throw new Error('CONFIGURACAO_INVALIDA');
            const sdk = await this.carregarSdk();
            this.sdk = await sdk.createInstance({ clientId: config.clientId, components: ['paypal-payments'], pageType: 'checkout' });
            if (!(await this.sdk.findEligibleMethods({ currencyCode: 'BRL' })).isEligible('paypal')) throw new Error('INELEGIVEL');
            this.pronto.set(true);
        } catch (e) { this.mensagem(e); } finally { this.ocupado.set(false); }
    }
    private async atualizar(): Promise<void> {
        if (!this.tentativa) throw new Error();
        this.estado.set(await this.post<CheckoutEstado>('estado', { pedidoPublicId: this.tentativa.pedidoPublicId }));
    }
    async consultar(): Promise<void> {
        if (this.ocupado() || !this.tentativa || this.armazenamentoInvalido) return;
        this.ocupado.set(true); this.erro.set(null);
        try {
            await this.sessao(); await this.atualizar();
            const pg = this.estado()?.pagamento;
            if (pg && !['CAPTURADO', 'REVISAO', 'RECUSADO', 'CANCELADO', 'EXPIRADO', 'REEMBOLSADO', 'PARCIALMENTE_REEMBOLSADO', 'ESTORNADO'].includes(pg.estado)) {
                try { await this.post('reconciliar', { pagamentoPublicId: pg.publicId }); }
                finally { await this.atualizar(); }
            }
        } catch (e) { this.mensagem(e); } finally { this.ocupado.set(false); }
    }
    async concluirCaptura(): Promise<void> {
        if (this.ocupado() || !this.tentativa || this.armazenamentoInvalido) return;
        this.ocupado.set(true); this.erro.set(null);
        try {
            await this.sessao(); await this.atualizar();
            const pg = this.estado()?.pagamento;
            if (pg?.estado !== 'APROVADO') throw new Error('APROVACAO_PENDENTE');
            try { await this.post('capturar', { pagamentoPublicId: pg.publicId }, this.tentativa.captura); }
            finally { await this.atualizar(); }
        } catch (e) { this.mensagem(e); } finally { this.ocupado.set(false); }
    }
    // Chamado diretamente pelo gesto do comprador: start abre popup antes do POST resolver.
    pagar(): Promise<void> {
        if (this.ocupado() || !this.sdk || !this.pronto() || !this.tentativa) return Promise.resolve();
        this.ocupado.set(true); this.erro.set(null);
        const tentativa = this.tentativa;
        try {
        let ordemEsperada: string | null = null;
        const sessao = this.sdk.createPayPalOneTimePaymentSession({
            onApprove: async data => {
                if (!ordemEsperada || data.orderId !== ordemEsperada) throw new Error('APROVACAO_INVALIDA');
                const pg = this.estado()?.pagamento;
                if (!pg) throw new Error();
                // Nenhum ID externo do callback e enviado como autoridade ao backend.
                try { await this.post('capturar', { pagamentoPublicId: pg.publicId }, tentativa.captura); }
                finally { await this.atualizar(); }
            },
            onCancel: () => { this.erro.set('Aprovacao interrompida. O pagamento nao foi confirmado; consulte o estado antes de repetir.'); },
            onError: () => { this.mensagem(null); }
        });
        const ordem = this.sessao().then(async () => {
            // Recuperar tentativa existente evita criar outra apos recarregar a pagina.
            await this.atualizar();
            let atual = this.estado()!;
            if (!atual.pagamento) atual = await this.post<CheckoutEstado>('iniciar', { pedidoPublicId: tentativa.pedidoPublicId }, tentativa.criacao);
            this.estado.set(atual);
            if (!atual.ordemId || !['AGUARDANDO_APROVACAO', 'APROVADO'].includes(atual.pagamento?.estado ?? '')) throw new Error('TENTATIVA_ATIVA');
            ordemEsperada = atual.ordemId; return { orderId: ordemEsperada };
        });
        void ordem.catch(() => {}); // SDK indisponivel nao deixa rejeicao sem observador.
        return sessao.start({ presentationMode: 'popup' }, ordem).catch(e => this.mensagem(e)).finally(() => this.ocupado.set(false));
        } catch (e) { this.mensagem(e); this.ocupado.set(false); return Promise.resolve(); }
    }
    private chave(): string {
        const b = crypto.getRandomValues(new Uint8Array(16)); b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
        const s = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
        return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
    }
}
