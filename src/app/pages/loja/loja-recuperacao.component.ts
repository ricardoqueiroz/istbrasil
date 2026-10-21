import { Component, DestroyRef, OnInit, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormControl, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { MessageModule } from 'primeng/message';
import { DesafioRecuperacao, LojaBibliotecaService, MENSAGEM_RECUPERACAO, mensagemBiblioteca } from '../../services/loja-biblioteca.service';

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
        <h1 id="recuperacao-titulo">{{ confirmarLink ? 'Confirmar recuperação' : 'Recuperar meus e-books' }}</h1>
        @if (confirmarLink) {
            <p>Confirme para acessar os e-books vinculados ao link recebido. O link não é consumido ao abrir esta página.</p>
            <p-button label="Confirmar acesso" [disabled]="ocupado() || !temDesafio()" (onClick)="confirmar()" />
        } @else {
            <p>Informe o e-mail utilizado na compra. Não é necessário criar uma conta.</p>
            <form (submit)="$event.preventDefault(); solicitar()">
                <label for="recuperacao-email" class="block mb-2">E-mail da compra</label>
                <input pInputText id="recuperacao-email" type="email" autocomplete="email" [formControl]="email"
                    aria-describedby="email-ajuda" [attr.aria-invalid]="email.touched && email.invalid" class="w-full mb-2" />
                <p id="email-ajuda">Informe um e-mail válido.</p>
                <p-button type="submit" label="Enviar instruções" [disabled]="ocupado() || email.invalid" />
            </form>
        }
        @if (ocupado()) { <p role="status">Aguarde…</p> }
        @if (mensagem()) { <p-message severity="success" role="status">{{ mensagem() }}</p-message> }
        @if (erro()) { <p-message severity="warn" role="alert">{{ erro() }}</p-message> }
        <nav class="flex gap-4 mt-6" aria-label="Biblioteca"><a routerLink="/loja/biblioteca">Minha biblioteca</a>
            @if (confirmarLink) { <a routerLink="/loja/biblioteca/recuperar">Solicitar outro link</a> }
            <a routerLink="/loja">Voltar à Loja</a></nav>
    </main>`
})
export class LojaRecuperacaoComponent implements OnInit {
    private readonly api = inject(LojaBibliotecaService);
    private readonly router = inject(Router);
    private readonly destroy = inject(DestroyRef);
    readonly confirmarLink = inject(ActivatedRoute).snapshot.data['confirmar'] === true;
    readonly email = new FormControl('', { nonNullable: true, validators: [Validators.required, Validators.email, Validators.maxLength(254)] });
    readonly ocupado = signal(false);
    readonly mensagem = signal('');
    readonly erro = signal('');
    readonly temDesafio = signal(false);
    private desafio: DesafioRecuperacao | null = null;
    constructor() { this.destroy.onDestroy(() => { this.desafio = null; this.email.reset(); }); }
    ngOnInit(): void {
        if (this.confirmarLink) {
            this.desafio = retirarDesafio(); this.temDesafio.set(!!this.desafio);
            if (!this.desafio) this.erro.set('Link inválido ou ausente. Solicite um novo link.');
        }
    }
    solicitar(): void {
        if (this.ocupado() || this.email.invalid) { this.email.markAsTouched(); return; }
        this.ocupado.set(true); this.erro.set(''); this.mensagem.set('');
        this.api.solicitar(this.email.value.trim()).pipe(takeUntilDestroyed(this.destroy)).subscribe({
            next: () => { this.ocupado.set(false); this.mensagem.set(MENSAGEM_RECUPERACAO); this.email.reset(); },
            error: e => { this.ocupado.set(false); this.erro.set(mensagemBiblioteca(e)); }
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
