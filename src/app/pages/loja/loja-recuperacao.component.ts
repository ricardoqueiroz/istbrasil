import { Component, DestroyRef, OnInit, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormControl, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { MessageModule } from 'primeng/message';
import { DesafioRecuperacao, LojaBibliotecaService, MENSAGEM_RECUPERACAO, mensagemBiblioteca, mensagemCodigoBiblioteca } from '../../services/loja-biblioteca.service';

declare global { interface Window { __istRetirarDesafio?: () => DesafioRecuperacao | null; } }

export function retirarDesafio(): DesafioRecuperacao | null {
    // O bootstrap ja limpou a URL antes de carregar Angular. Esta alternativa
    // cobre navegacao interna SPA; nunca persiste ou consome o desafio.
    if (window.__istRetirarDesafio) return window.__istRetirarDesafio();
    const fragmento = window.location.hash;
    try { window.history.replaceState(null, '', window.location.pathname); } catch { return null; }
    const p = new URLSearchParams(fragmento.slice(1)), publicId = p.get('id'), segredo = p.get('segredo');
    return Array.from(p.keys()).length === 2 && p.getAll('id').length === 1 && p.getAll('segredo').length === 1
        && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(publicId ?? '')
        && /^[A-Za-z0-9_-]{43}$/.test(segredo ?? '') ? { publicId: publicId!, segredo: segredo! } : null;
}

@Component({
    selector: 'app-loja-recuperacao', standalone: true,
    imports: [ReactiveFormsModule, RouterLink, ButtonModule, InputTextModule, MessageModule],
    template: `<main class="card mx-auto max-w-2xl" aria-labelledby="recuperacao-titulo" [attr.aria-busy]="ocupado()">
        <h1 id="recuperacao-titulo">{{ mostrarConfirmacaoLink() ? 'Confirmar recuperação' : 'Recuperar meus e-books' }}</h1>
        @if (mostrarConfirmacaoLink()) {
            <p>Confirme para acessar os e-books vinculados ao link recebido. O link não é consumido ao abrir esta página.</p>
            <p-button label="Confirmar acesso" [disabled]="ocupado() || !temDesafio()" (onClick)="confirmar()" />
        } @else {
            <form (submit)="$event.preventDefault(); aguardandoCodigo() ? validarCodigo() : solicitar()">
                @if (aguardandoCodigo()) {
                    <p>Informe o código de seis dígitos recebido por e-mail para o pedido {{ pedido.value }}.</p>
                    <label for="recuperacao-codigo" class="block mb-2">Código de acesso</label>
                    <input pInputText id="recuperacao-codigo" type="text" inputmode="numeric" autocomplete="one-time-code"
                        maxlength="6" pattern="[0-9]{6}" [formControl]="codigo" [readonly]="ocupado()"
                        aria-describedby="codigo-ajuda" [attr.aria-invalid]="codigo.touched && codigo.invalid" class="w-full mb-2" />
                    <p id="codigo-ajuda">Use os seis dígitos, incluindo zeros no início. O código é válido por dez minutos.</p>
                    <div class="flex flex-wrap items-center gap-2">
                        <p-button type="submit" label="Confirmar acesso" [loading]="ocupado()" [disabled]="ocupado() || codigo.invalid" />
                        <p-button type="button" label="Solicitar novo código" severity="secondary" [outlined]="true" [disabled]="ocupado()" (onClick)="reenviarCodigo()" />
                        <p-button type="button" label="Alterar e-mail ou pedido" severity="secondary" [text]="true" [disabled]="ocupado()" (onClick)="alterarDados()" />
                    </div>
                } @else {
                    <p>Informe os dados utilizados na compra. Não é necessário criar uma conta.</p>
                    <label for="recuperacao-email" class="block mb-2">E-mail da compra</label>
                    <input pInputText id="recuperacao-email" type="email" autocomplete="email" [formControl]="email" [readonly]="ocupado()"
                        aria-describedby="email-ajuda" [attr.aria-invalid]="email.touched && email.invalid" class="w-full mb-2" />
                    <p id="email-ajuda">Informe um e-mail válido.</p>
                    @if (!porLink()) {
                        <label for="recuperacao-pedido" class="block mb-2">Número público do pedido</label>
                        <input pInputText id="recuperacao-pedido" type="text" autocomplete="off" maxlength="36" [formControl]="pedido" [readonly]="ocupado()"
                            aria-describedby="pedido-ajuda" [attr.aria-invalid]="pedido.touched && pedido.invalid" class="w-full mb-2" />
                        <p id="pedido-ajuda">Informe o identificador completo do pedido, no formato UUID.</p>
                    }
                    <div class="flex flex-wrap items-center gap-2">
                        <p-button type="submit" [label]="porLink() ? 'Enviar instruções' : 'Solicitar código de acesso'"
                            [loading]="ocupado()" [disabled]="ocupado() || email.invalid || (!porLink() && pedido.invalid)" />
                        <p-button type="button" [label]="porLink() ? 'Usar código de acesso' : 'Receber link por e-mail'"
                            severity="secondary" [outlined]="true" [disabled]="ocupado()" (onClick)="alternarMetodo()" />
                    </div>
                }
            </form>
        }
        @if (ocupado()) { <p role="status">Aguarde…</p> }
        @if (mensagem()) { <p-message class="block my-3" severity="success" role="status">{{ mensagem() }}</p-message> }
        @if (erro()) { <p-message class="block my-3" severity="warn" role="alert">{{ erro() }}</p-message> }
        <nav class="flex flex-wrap gap-4 mt-6" aria-label="Biblioteca">
            <a pButton routerLink="/loja/biblioteca">
                <i pButtonIcon class="pi pi-book" aria-hidden="true"></i>
                <span pButtonLabel>Minha biblioteca</span>
            </a>
            @if (mostrarConfirmacaoLink()) { <a routerLink="/loja/biblioteca/recuperar">Solicitar outra recuperação</a> }
            <a pButton routerLink="/loja" severity="secondary" [outlined]="true">
                <i pButtonIcon class="pi pi-shopping-bag" aria-hidden="true"></i>
                <span pButtonLabel>Voltar à Loja</span>
            </a>
        </nav>
    </main>`
})
export class LojaRecuperacaoComponent implements OnInit {
    private readonly api = inject(LojaBibliotecaService);
    private readonly router = inject(Router);
    private readonly destroy = inject(DestroyRef);
    readonly confirmarLink = inject(ActivatedRoute).snapshot.data['confirmar'] === true;
    readonly email = new FormControl('', { nonNullable: true, validators: [Validators.required, Validators.email, Validators.maxLength(254)] });
    readonly mostrarConfirmacaoLink = signal(false);
    readonly porLink = signal(false);
    readonly aguardandoCodigo = signal(false);
    readonly pedido = new FormControl('', { nonNullable: true, validators: [Validators.required,
        Validators.pattern(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)] });
    readonly codigo = new FormControl('', { nonNullable: true, validators: [Validators.required, Validators.pattern(/^[0-9]{6}$/)] });
    private contextoCodigo: { email: string; pedidoPublicId: string } | null = null;
    readonly ocupado = signal(false);
    readonly mensagem = signal('');
    readonly erro = signal('');
    readonly temDesafio = signal(false);
    private desafio: DesafioRecuperacao | null = null;
    constructor() { this.destroy.onDestroy(() => { this.desafio = null; this.contextoCodigo = null; this.email.reset(); this.pedido.reset(); this.codigo.reset(); }); }
    ngOnInit(): void {
        if (this.confirmarLink) {
            this.desafio = retirarDesafio(); this.temDesafio.set(!!this.desafio);
            this.mostrarConfirmacaoLink.set(!!this.desafio);
        }
    }
    alternarMetodo(): void {
        if (this.ocupado()) return;
        this.porLink.update(v => !v); this.alterarDados();
    }
    alterarDados(): void {
        if (this.ocupado()) return;
        this.contextoCodigo = null; this.aguardandoCodigo.set(false); this.codigo.reset();
        this.erro.set(''); this.mensagem.set('');
    }
    solicitar(): void {
        if (this.ocupado() || this.aguardandoCodigo()) return;
        this.email.markAsTouched();
        if (!this.porLink()) this.pedido.markAsTouched();
        if (this.email.invalid || (!this.porLink() && this.pedido.invalid)) return;
        if (!this.porLink()) {
            this.enviarCodigo({ email: this.email.value.trim(), pedidoPublicId: this.pedido.value }); return;
        }
        this.ocupado.set(true); this.erro.set(''); this.mensagem.set('');
        this.api.solicitar(this.email.value.trim()).pipe(takeUntilDestroyed(this.destroy)).subscribe({
            next: () => { this.ocupado.set(false); this.mensagem.set(MENSAGEM_RECUPERACAO); this.email.reset(); },
            error: e => { this.ocupado.set(false); this.erro.set(mensagemBiblioteca(e)); }
        });
    }
    private enviarCodigo(contexto: { email: string; pedidoPublicId: string }): void {
        this.ocupado.set(true); this.erro.set(''); this.mensagem.set(''); this.codigo.reset();
        this.api.solicitarCodigo(contexto.email, contexto.pedidoPublicId).pipe(takeUntilDestroyed(this.destroy)).subscribe({
            next: () => {
                this.contextoCodigo = contexto; this.aguardandoCodigo.set(true);
                this.mensagem.set(MENSAGEM_RECUPERACAO); this.ocupado.set(false);
            },
            error: e => { this.ocupado.set(false); this.erro.set(mensagemCodigoBiblioteca(e)); }
        });
    }
    reenviarCodigo(): void {
        if (this.ocupado() || !this.contextoCodigo) return;
        this.enviarCodigo(this.contextoCodigo);
    }
    validarCodigo(): void {
        if (this.ocupado() || !this.contextoCodigo) return;
        this.codigo.markAsTouched(); if (this.codigo.invalid) return;
        this.ocupado.set(true); this.erro.set(''); this.mensagem.set('');
        const codigo = this.codigo.value; this.codigo.reset();
        this.api.validarCodigo(this.contextoCodigo.pedidoPublicId, codigo).pipe(takeUntilDestroyed(this.destroy)).subscribe({
            next: () => { this.contextoCodigo = null; void this.router.navigateByUrl('/loja/biblioteca', { replaceUrl: true }); },
            error: e => { this.ocupado.set(false); this.erro.set(mensagemCodigoBiblioteca(e)); }
        });
    }
    confirmar(): void {
        if (this.ocupado() || !this.desafio) return;
        this.ocupado.set(true); this.erro.set('');
        const desafio = this.desafio; this.desafio = null; this.temDesafio.set(false);
        this.api.confirmar(desafio).pipe(takeUntilDestroyed(this.destroy)).subscribe({
            next: () => { void this.router.navigateByUrl('/loja/biblioteca', { replaceUrl: true }); },
            error: e => { this.ocupado.set(false); this.erro.set(mensagemBiblioteca(e)); }
        });
    }
}
