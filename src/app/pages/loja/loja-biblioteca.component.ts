import { Component, DestroyRef, OnInit, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { DOCUMENT } from '@angular/common';
import { forkJoin } from 'rxjs';
import { ButtonModule } from 'primeng/button';
import { MessageModule } from 'primeng/message';
import { DireitoBiblioteca, EstadoDireito, LojaBibliotecaService, mensagemBiblioteca } from '../../services/loja-biblioteca.service';

@Component({
    selector: 'app-loja-biblioteca', standalone: true,
    imports: [RouterLink, ButtonModule, MessageModule],
    template: `<main class="card" aria-labelledby="biblioteca-titulo" [attr.aria-busy]="ocupado()">
        <header class="flex flex-wrap justify-between gap-4"><div><h1 id="biblioteca-titulo">Minha biblioteca digital</h1>
            <p>Seus e-books nesta sessão de compra ou recuperação.</p></div>
            @if (recuperada()) { <p-button label="Encerrar sessão recuperada" severity="secondary" [disabled]="ocupado()" (onClick)="encerrar()" /> }
        </header>
        <nav class="flex gap-4 mb-6" aria-label="Acesso à biblioteca"><a routerLink="/loja/biblioteca/recuperar">Recuperar por e-mail</a><a routerLink="/loja">Ir à Loja</a></nav>
        @if (ocupado()) { <p role="status">Aguarde…</p> }
        @if (erro()) { <p-message severity="warn" role="alert">{{ erro() }}</p-message> }
        @if (aviso()) { <p role="status">{{ aviso() }}</p> }
        @if (!ocupado() && !erro() && direitos().length === 0) { <p role="status">Nenhum e-book disponível nesta sessão.</p> }
        <section aria-label="E-books"><ul class="list-none p-0">
            @for (d of direitos(); track d.publicId) {
                <li class="border-b border-surface py-4 flex flex-wrap items-center justify-between gap-4">
                    <div><h2 class="text-xl">{{ d.titulo }}</h2><p>{{ estado(d.estado) }}</p>
                        <p>{{ d.podeSolicitarArquivo ? 'Download disponível' : 'Download indisponível' }}</p></div>
                    @if (d.estado === 'ATIVO' && d.podeSolicitarArquivo) {
                        <p-button [label]="'Baixar ' + d.titulo" [ariaLabel]="'Baixar ' + d.titulo" icon="pi pi-download" [disabled]="ocupado()" (onClick)="baixar(d)" />
                    }
                    @if (d.estado === 'AGUARDANDO_CONFIRMACAO') {
                        <p-button [label]="'Verificar confirmação de ' + d.titulo" [disabled]="ocupado()" (onClick)="reavaliar(d)" />
                    }
                </li>
            }
        </ul></section>
        <nav aria-label="Páginas da biblioteca" class="flex gap-4 mt-4">
            <p-button label="Anterior" [disabled]="ocupado() || cursores.length < 2" (onClick)="anterior()" />
            <p-button label="Próxima" [disabled]="ocupado() || !proximo()" (onClick)="avancar()" />
            <p-button label="Atualizar lista" [disabled]="ocupado()" (onClick)="carregar()" />
        </nav>
    </main>`
})
export class LojaBibliotecaComponent implements OnInit {
    private readonly api = inject(LojaBibliotecaService);
    private readonly destroy = inject(DestroyRef);
    private readonly document = inject(DOCUMENT);
    readonly direitos = signal<DireitoBiblioteca[]>([]);
    readonly recuperada = signal(false);
    readonly ocupado = signal(false);
    readonly erro = signal('');
    readonly aviso = signal('');
    readonly proximo = signal<string | null>(null);
    readonly cursores: (string | undefined)[] = [undefined];
    private readonly urls = new Set<string>();
    private readonly timers = new Set<ReturnType<typeof setTimeout>>();
    readonly estado = (e: EstadoDireito): string => ({ ATIVO: 'Ativo', AGUARDANDO_CONFIRMACAO: 'Aguardando confirmação', SUSPENSO: 'Suspenso', REVOGADO: 'Revogado' })[e];
    constructor() { this.destroy.onDestroy(() => { for (const t of this.timers) clearTimeout(t); for (const url of this.urls) URL.revokeObjectURL(url); }); }
    ngOnInit(): void {
        // O fragmento ja foi retirado. D6 aceita Referer na leitura same-origin.
        let meta = this.document.querySelector<HTMLMetaElement>('meta[name="referrer"]');
        if (!meta) { meta = this.document.createElement('meta'); meta.name = 'referrer'; this.document.head.appendChild(meta); }
        meta.content = 'same-origin'; this.carregar();
    }
    carregar(): void {
        if (this.ocupado()) return;
        this.ocupado.set(true); this.erro.set('');
        forkJoin({ pagina: this.api.listar(this.cursores.at(-1)), sessao: this.api.sessao() }).pipe(takeUntilDestroyed(this.destroy)).subscribe({
            next: ({ pagina, sessao }) => { this.direitos.set(pagina.direitos); this.proximo.set(pagina.proximoCursor); this.recuperada.set(sessao.sessao.autenticada); this.ocupado.set(false); },
            error: e => this.falhar(e)
        });
    }
    avancar(): void { if (!this.ocupado() && this.proximo()) { this.cursores.push(this.proximo()!); this.carregar(); } }
    anterior(): void { if (!this.ocupado() && this.cursores.length > 1) { this.cursores.pop(); this.carregar(); } }
    reavaliar(d: DireitoBiblioteca): void {
        if (this.ocupado() || d.estado !== 'AGUARDANDO_CONFIRMACAO') return;
        this.ocupado.set(true); this.erro.set('');
        this.api.reavaliar(d.publicId).pipe(takeUntilDestroyed(this.destroy)).subscribe({
            next: () => { this.ocupado.set(false); this.carregar(); }, error: e => this.falhar(e)
        });
    }
    baixar(d: DireitoBiblioteca): void {
        if (this.ocupado() || d.estado !== 'ATIVO' || !d.podeSolicitarArquivo) return;
        this.ocupado.set(true); this.erro.set('');
        this.api.arquivo(d.publicId).pipe(takeUntilDestroyed(this.destroy)).subscribe({
            next: blob => {
                try {
                    if (blob.type.split(';')[0] !== 'application/pdf' || !blob.size) throw new Error();
                    const url = URL.createObjectURL(blob); this.urls.add(url);
                    const timer = setTimeout(() => { URL.revokeObjectURL(url); this.urls.delete(url); this.timers.delete(timer); }, 1000);
                    this.timers.add(timer);
                    const a = this.document.createElement('a'); a.href = url; a.download = 'ebook.pdf';
                    this.document.body.appendChild(a);
                    try { a.click(); } finally { a.remove(); }
                    this.aviso.set('Download solicitado ao navegador.'); this.ocupado.set(false);
                } catch { this.falhar(null); }
            }, error: e => this.falhar(e)
        });
    }
    encerrar(): void {
        if (this.ocupado() || !this.recuperada()) return;
        this.ocupado.set(true); this.erro.set('');
        this.api.revogar().pipe(takeUntilDestroyed(this.destroy)).subscribe({
            next: () => { this.recuperada.set(false); this.direitos.set([]); this.proximo.set(null); this.cursores.splice(0, this.cursores.length, undefined);
                this.aviso.set('Sessão recuperada encerrada. Sua sessão de compra foi preservada.'); this.ocupado.set(false); },
            error: e => this.falhar(e)
        });
    }
    private falhar(e: unknown): void { this.ocupado.set(false); this.erro.set(mensagemBiblioteca(e)); this.direitos.set([]); this.proximo.set(null); }
}
