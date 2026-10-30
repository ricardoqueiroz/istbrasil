import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, InjectionToken, computed, inject, signal } from '@angular/core';
import { EMPTY, Observable, Subject, defer, filter, finalize, firstValueFrom, takeUntil, tap, throwError, timeout } from 'rxjs';
import { DireitoBiblioteca } from './loja-biblioteca.service';
import { CARRINHO_STORAGE } from './carrinho.service';
import { LojaService } from './loja.service';
import { LojaPedido } from '../pages/loja/models/loja.model';

export interface CheckoutPagamento {
    publicId: string; pedidoPublicId: string; estado: string; pedidoEstado: LojaPedido['estado'];
    moeda: 'BRL'; valorCentavos: number; pagamentoConfirmadoEm: string | null;
}
export interface CheckoutEstado { ambiente: 'sandbox' | 'live'; pedido: LojaPedido; pagamento: CheckoutPagamento | null; ordemId: string | null; }
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
    private readonly cancelarLeitura = new Subject<void>();
    readonly leiturasInterrompidas = this.cancelarLeitura.asObservable();
    private revisaoLeitura = 0;
    private operacoesEmCurso = 0;
    private consultaManual = false;
    private leituraEmCurso = false;
    private sequencia = 0;
    readonly acompanhamento = signal<{ pedidoPublicId: string; inicio: number; sequencia: number } | null>(null);
    readonly direitosConsultados = signal<{ pedidoPublicId: string; estado: CheckoutEstado; direitos: DireitoBiblioteca[] } | null>(null);
    readonly bibliotecaLiberada = computed(() => {
        const d = this.direitosConsultados(), e = this.estado();
        if (!d || !e || d.estado !== e || d.pedidoPublicId !== e.pedido.publicId || !this.confirmado()) return false;
        if (e.pagamento?.valorCentavos !== e.pedido.totalCentavos || e.pagamento.moeda !== e.pedido.moeda
            || !Number.isFinite(Date.parse(e.pagamento.pagamentoConfirmadoEm ?? ''))) return false;
        // O contrato ordena itens pela posicao 1..N. Nao existe UUID publico de item.
        // Cada ocorrencia exige um UUID de direito distinto com pedido/produto/posicao iguais.
        const esperados = e.pedido.itens.map((item, i) => ({ item, posicao: i + 1 }))
            .filter(({ item }) => ['DIGITAL', 'E-Book'].includes(item.tipo));
        if (!esperados.length || esperados.length !== d.direitos.length) return false;
        const ids = new Set(d.direitos.map(x => x.publicId));
        return ids.size === d.direitos.length && d.direitos.every(x => uuid.test(x.publicId))
            && esperados.every(({ item, posicao }) => item.quantidade === 1 && d.direitos.filter(x =>
                x.pedidoPublicId === e.pedido.publicId && x.produtoId === item.produtoId && x.itemPosicao === posicao
                && x.estado === 'ATIVO' && x.podeSolicitarArquivo === true).length === 1);
    });
    private csrf = '';
    readonly estado = signal<CheckoutEstado | null>(null);
    readonly ocupado = signal(false);
    readonly pronto = signal(false);
    readonly erro = signal<string | null>(null);
    readonly falhaConsulta = signal<unknown>(null);
    readonly pedidoSalvo = signal<string | null>(null);
    readonly verificandoAnterior = signal(false);
    readonly confirmado = computed(() => {
        const pg = this.estado()?.pagamento;
        const e=this.estado();
        return e?.ambiente==='sandbox' && e.pedido.estado==='PAGO' && pg?.pedidoPublicId===e.pedido.publicId
            && pg?.estado === 'CAPTURADO' && pg.pedidoEstado === 'PAGO' && !!pg.pagamentoConfirmadoEm;
    });
    private armazenamentoInvalido = false;
    private continuidade: CheckoutEstado | null = null;

    cancelarContinuidade(): void {
        this.continuidade = null;
        if (this.verificandoAnterior()) this.interromperLeituras();
    }

    async consultarAnterior(): Promise<CheckoutEstado | null> {
        const anterior = this.tentativa;
        if (this.ocupado() || this.armazenamentoInvalido || !anterior) return null;
        this.continuidade = null;
        this.ocupado.set(true); this.verificandoAnterior.set(true); this.erro.set(null);
        this.interromperLeituras();
        const revisao = this.revisaoLeitura;
        try {
            if (Date.parse(anterior.expiraSessao) <= Date.now()) throw new Error('SESSAO_INVALIDA');
            await this.sessao();
            if (revisao !== this.revisaoLeitura) return null;
            const e = await firstValueFrom(this.http.post<CheckoutEstado>('/api/loja/checkout/estado',
                { pedidoPublicId: anterior.pedidoPublicId }, { withCredentials: true,
                    headers: { 'X-IST-Loja': '1', 'X-CSRF-Token': this.csrf } })
                .pipe(timeout(15000), takeUntil(this.leiturasInterrompidas)));
            const pg = e?.pagamento;
            if (this.tentativa !== anterior || revisao !== this.revisaoLeitura) return null;
            if (e?.ambiente !== 'sandbox' || e.pedido?.publicId !== anterior.pedidoPublicId || e.pedido.moeda !== 'BRL'
                || !Number.isSafeInteger(e.pedido.totalCentavos) || e.pedido.totalCentavos <= 0
                || !Array.isArray(e.pedido.itens) || !e.pedido.itens.length
                || e.pedido.itens.some(i => !i || !Number.isSafeInteger(i.produtoId) || i.produtoId <= 0
                    || i.quantidade !== 1 || !Number.isSafeInteger(i.precoUnitarioCentavos) || i.precoUnitarioCentavos <= 0
                    || i.subtotalCentavos !== i.precoUnitarioCentavos)
                || new Set(e.pedido.itens.map(i => i.produtoId)).size !== e.pedido.itens.length
                || e.pedido.itens.reduce((total, i) => total + i.subtotalCentavos, 0) !== e.pedido.totalCentavos
                || (!pg && e.ordemId !== null)
                || (pg && (!uuid.test(pg.publicId) || pg.pedidoPublicId !== anterior.pedidoPublicId
                    || pg.pedidoEstado !== e.pedido.estado || pg.moeda !== e.pedido.moeda || pg.valorCentavos !== e.pedido.totalCentavos))) {
                throw new Error('CONFIGURACAO_INVALIDA');
            }
            this.continuidade = e;
            return e;
        } catch (e) { if (revisao === this.revisaoLeitura) this.mensagem(e); return null; }
        finally { this.verificandoAnterior.set(false); this.ocupado.set(false); }
    }

    podeRetomar(e: CheckoutEstado): boolean {
        return this.continuidade === e && !this.ocupado() && this.tentativa?.pedidoPublicId === e.pedido.publicId
            && Date.parse(this.tentativa.expiraSessao) > Date.now() && Date.parse(e.pedido.expiraEm) > Date.now()
            && ['CRIADO', 'AGUARDANDO_PAGAMENTO'].includes(e.pedido.estado)
            && (!e.pagamento || (['AGUARDANDO_APROVACAO', 'APROVADO'].includes(e.pagamento.estado)
                && e.pagamento.pagamentoConfirmadoEm === null
                && typeof e.ordemId === 'string' && /^[A-Za-z0-9]+$/.test(e.ordemId)));
    }

    restaurarAnterior(e: CheckoutEstado): boolean {
        if (!this.podeRetomar(e)) return false;
        this.encerrarAcompanhamento(e.pedido.publicId); this.interromperLeituras();
        this.receberEstado(e); this.direitosConsultados.set(null); this.pronto.set(false); this.sdk = null;
        this.continuidade = null;
        return true;
    }

    async verificarAnterior(pedidoAtual: string): Promise<void> {
        const anterior = this.tentativa;
        if (this.ocupado() || this.armazenamentoInvalido || !anterior || !uuid.test(pedidoAtual)
            || anterior.pedidoPublicId === pedidoAtual) return;
        this.ocupado.set(true); this.verificandoAnterior.set(true); this.erro.set(null);
        this.interromperLeituras();
        try {
            await this.sessao();
            const e = await firstValueFrom(this.http.post<CheckoutEstado>('/api/loja/checkout/estado',
                { pedidoPublicId: anterior.pedidoPublicId }, { withCredentials: true,
                    headers: { 'X-IST-Loja': '1', 'X-CSRF-Token': this.csrf } }).pipe(timeout(15000)));
            const pg = e?.pagamento;
            if (this.tentativa !== anterior || e?.ambiente !== 'sandbox' || e.pedido?.publicId !== anterior.pedidoPublicId
                || e.pedido.estado !== 'PAGO' || !pg || !uuid.test(pg.publicId)
                || pg.pedidoPublicId !== anterior.pedidoPublicId || pg.estado !== 'CAPTURADO' || pg.pedidoEstado !== 'PAGO'
                || e.pedido.moeda !== 'BRL' || pg.moeda !== e.pedido.moeda
                || !Number.isSafeInteger(e.pedido.totalCentavos) || e.pedido.totalCentavos <= 0
                || pg.valorCentavos !== e.pedido.totalCentavos
                || !Number.isFinite(Date.parse(pg.pagamentoConfirmadoEm ?? ''))) {
                throw new Error('TENTATIVA_ATIVA');
            }
            // Somente o contexto local termina. B exige um novo gesto e novas chaves.
            if (!this.storage) throw new Error('ARMAZENAMENTO');
            this.storage.removeItem(CHECKOUT_STORAGE_KEY);
            this.encerrarAcompanhamento(anterior.pedidoPublicId);
            this.interromperLeituras();
            this.tentativa = null; this.pedidoSalvo.set(null); this.estado.set(null);
            this.direitosConsultados.set(null); this.pronto.set(false); this.sdk = null; this.csrf = '';
        } catch (e) { this.mensagem(e); }
        finally { this.verificandoAnterior.set(false); this.ocupado.set(false); }
    }

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
    private interromperLeituras(): void {
        this.revisaoLeitura++;
        this.cancelarLeitura.next();
    }
    private iniciarAcompanhamento(): void {
        if (!this.tentativa) return;
        this.interromperLeituras();
        this.acompanhamento.set({ pedidoPublicId: this.tentativa.pedidoPublicId, inicio: Date.now(), sequencia: ++this.sequencia });
    }
    encerrarAcompanhamento(pedidoPublicId: string): void {
        if (this.acompanhamento()?.pedidoPublicId !== pedidoPublicId) return;
        this.interromperLeituras();
        this.acompanhamento.set(null);
    }
    private post<T>(acao: string, corpo: object, chave?: string): Promise<T> {
        this.interromperLeituras();
        this.operacoesEmCurso++;
        return firstValueFrom(this.http.post<T>(`/api/loja/checkout/${acao}`, corpo, { withCredentials: true,
            headers: { 'X-IST-Loja': '1', 'X-CSRF-Token': this.csrf, ...(chave ? { 'Idempotency-Key': chave } : {}) } }))
            .finally(() => this.operacoesEmCurso--);
    }
    // Exclusivamente leitura local. Nao estabelece sessao, reconcilia ou captura.
    observar(pedidoPublicId: string): Observable<CheckoutEstado> {
        return defer(() => {
            if (this.operacoesEmCurso || this.consultaManual || this.leituraEmCurso || this.verificandoAnterior()) return EMPTY;
            if (this.armazenamentoInvalido || !this.csrf || this.tentativa?.pedidoPublicId !== pedidoPublicId)
                return throwError(() => new Error('SESSAO_INVALIDA'));
            const revisao = this.revisaoLeitura;
            this.leituraEmCurso = true;
            return this.http.post<CheckoutEstado>('/api/loja/checkout/estado', { pedidoPublicId }, {
                withCredentials: true, headers: { 'X-IST-Loja': '1', 'X-CSRF-Token': this.csrf }
            }).pipe(takeUntil(this.leiturasInterrompidas),
                filter(() => revisao === this.revisaoLeitura && this.tentativa?.pedidoPublicId === pedidoPublicId),
                tap(e => this.receberEstado(e)), finalize(() => { this.leituraEmCurso = false; }));
        });
    }
    registrarDireitos(pedidoPublicId: string, estado: CheckoutEstado, direitos: DireitoBiblioteca[]): void {
        if (this.estado() !== estado || this.tentativa?.pedidoPublicId !== pedidoPublicId) return;
        this.direitosConsultados.set({ pedidoPublicId, estado, direitos });
    }
    private mensagem(e: unknown): void {
        this.falhaConsulta.set(e);
        const codigo = e instanceof HttpErrorResponse ? e.error?.erro?.codigo : e instanceof Error ? e.message : '';
        const mensagens: Record<string, string> = {
            SESSAO_INVALIDA: 'A sessao original expirou ou nao pode ser reutilizada. Verifique o pedido com o atendimento.',
            CSRF_INVALIDO: 'Protecao expirada. Consulte novamente antes de repetir com a mesma tentativa.',
            PEDIDO_NAO_ENCONTRADO: 'Pedido indisponivel nesta sessao de compra.',
            PEDIDO_EXPIRADO: 'O prazo do pedido expirou. Verifique o resultado antes de criar outro.',
            APROVACAO_PENDENTE: 'A aprovacao ainda nao foi confirmada pelo PayPal.',
            CONFIGURACAO_INVALIDA: 'Ambiente de pagamento inconsistente ou indisponível. Não inicie outra tentativa.',
            TENTATIVA_ATIVA: 'Existe uma tentativa anterior preservada. Verifique seu resultado com o atendimento antes de pagar outro pedido.',
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
            if (config.ambiente !== 'sandbox' || this.estado()?.ambiente!==config.ambiente) {
                this.estado.set(null);this.sdk=null;throw new Error('CONFIGURACAO_INVALIDA');
            }
            const sdk = await this.carregarSdk();
            this.sdk = await sdk.createInstance({ clientId: config.clientId, components: ['paypal-payments'], pageType: 'checkout' });
            if (!(await this.sdk.findEligibleMethods({ currencyCode: 'BRL' })).isEligible('paypal')) throw new Error('INELEGIVEL');
            this.pronto.set(true);
        } catch (e) { this.mensagem(e); } finally { this.ocupado.set(false); }
    }
    private async atualizar(tentativa = this.tentativa): Promise<void> {
        if (!tentativa || this.tentativa !== tentativa) return;
        const e = await this.post<CheckoutEstado>('estado', { pedidoPublicId: tentativa.pedidoPublicId });
        if (this.tentativa === tentativa) this.receberEstado(e);
    }
    private receberEstado(e: CheckoutEstado): void {
        if(e?.ambiente!=='sandbox'||e.pedido?.publicId!==this.tentativa?.pedidoPublicId
            ||(e.pagamento&&e.pagamento.pedidoPublicId!==e.pedido.publicId)) {
            this.estado.set(null);this.pronto.set(false);this.sdk=null;throw new Error('CONFIGURACAO_INVALIDA');
        }
        this.revisaoLeitura++;
        this.estado.set(e);
    }
    async consultar(pedidoPublicId?: string): Promise<void> {
        if (pedidoPublicId && pedidoPublicId !== this.tentativa?.pedidoPublicId) {
            this.mensagem(new Error('TENTATIVA_ATIVA'));
            return;
        }
        if (this.ocupado() || !this.tentativa || this.armazenamentoInvalido) return;
        this.consultaManual = true; this.interromperLeituras();
        this.ocupado.set(true); this.erro.set(null);
        try {
            await this.sessao(); await this.atualizar();
            const pg = this.estado()?.pagamento;
            if (pg && !['CAPTURADO', 'REVISAO', 'RECUSADO', 'CANCELADO', 'EXPIRADO', 'REEMBOLSADO', 'PARCIALMENTE_REEMBOLSADO', 'ESTORNADO'].includes(pg.estado)) {
                try { await this.post('reconciliar', { pagamentoPublicId: pg.publicId }); }
                finally { await this.atualizar(); }
            }
        } catch (e) { this.mensagem(e); } finally { this.consultaManual = false; this.ocupado.set(false); }
    }
    async concluirCaptura(): Promise<void> {
        if (this.ocupado() || !this.tentativa || this.armazenamentoInvalido) return;
        this.iniciarAcompanhamento();
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
        this.iniciarAcompanhamento();
        try {
        let ordemEsperada: string | null = null;
        const sessao = this.sdk.createPayPalOneTimePaymentSession({
            onApprove: async data => {
                if (this.tentativa !== tentativa) return;
                if (!ordemEsperada || data.orderId !== ordemEsperada) throw new Error('APROVACAO_INVALIDA');
                const pg = this.estado()?.pagamento;
                if (!pg) throw new Error();
                // Nenhum ID externo do callback e enviado como autoridade ao backend.
                try { await this.post('capturar', { pagamentoPublicId: pg.publicId }, tentativa.captura); }
                finally { await this.atualizar(tentativa); }
            },
            onCancel: () => { if (this.tentativa !== tentativa) return; this.encerrarAcompanhamento(tentativa.pedidoPublicId); this.erro.set('Aprovacao interrompida. O pagamento nao foi confirmado; consulte o estado antes de repetir.'); },
            onError: () => { if (this.tentativa === tentativa) this.mensagem(null); }
        });
        const ordem = this.sessao().then(async () => {
            // Recuperar tentativa existente evita criar outra apos recarregar a pagina.
            await this.atualizar();
            let atual = this.estado()!;
            if (!atual.pagamento) atual = await this.post<CheckoutEstado>('iniciar', { pedidoPublicId: tentativa.pedidoPublicId }, tentativa.criacao);
            this.receberEstado(atual);
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
