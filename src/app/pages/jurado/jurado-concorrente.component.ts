import { NgTemplateOutlet } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { Component, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { Subject, catchError, distinctUntilChanged, map, of, startWith, switchMap } from 'rxjs';
import { ConcorrenteJuradoResponse, JuradoService } from '../../shared/jurado.service';

interface VideoJurado {
    provedor: 'YouTube' | 'Vimeo';
    externo: string;
    embed: string | null;
}

interface ResultadoDetalhe {
    resposta: ConcorrenteJuradoResponse | null;
    erro: 'indisponivel' | 'inesperado' | null;
}

@Component({
    selector: 'p-jurado-concorrente',
    standalone: true,
    imports: [NgTemplateOutlet, RouterLink, ButtonModule],
    styles: [':host { display: block; min-width: 0; max-width: 100%; }'],
    template: `
        <section class="min-w-0 w-full max-w-full space-y-6 py-6">
            <header class="flex flex-wrap items-start justify-between gap-4">
                <h1 class="min-w-0 break-words text-2xl font-semibold">Avalia&ccedil;&atilde;o do Concorrente</h1>
                <a pButton [routerLink]="['/jurado', slug(), 'avaliacoes']" class="p-button-outlined"><i class="pi pi-arrow-left" aria-hidden="true"></i><span>Voltar para a lista</span></a>
            </header>

            @if (carregando()) {
                <p role="status">Carregando concorrente...</p>
            } @else if (erro() === 'indisponivel') {
                <p role="alert">Concorrente indispon&iacute;vel.</p>
            } @else if (erro()) {
                <div role="alert" class="flex flex-wrap items-center justify-between gap-3 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-red-700 dark:border-red-800 dark:bg-red-950/30 dark:text-red-200">
                    <p>N&atilde;o foi poss&iacute;vel carregar o concorrente. Tente novamente.</p>
                    <button pButton type="button" icon="pi pi-refresh" label="Tentar novamente" class="p-button-outlined" (click)="tentarNovamente()"></button>
                </div>
            } @else if (detalhe(); as resposta) {
                <dl class="grid gap-x-8 gap-y-4 border-y border-surface-200 py-5 dark:border-surface-800 sm:grid-cols-2">
                    <div><dt class="text-sm text-surface-600 dark:text-surface-300">Evento</dt><dd class="break-words font-medium">{{ resposta.evento.nome }}</dd></div>
                    <div><dt class="text-sm text-surface-600 dark:text-surface-300">Inscri&ccedil;&atilde;o</dt><dd class="break-words font-medium">{{ resposta.concorrente.numeroConcorrente }}</dd></div>
                    <div><dt class="text-sm text-surface-600 dark:text-surface-300">Concorrente</dt><dd class="break-words font-medium">{{ resposta.concorrente.nome }}</dd></div>
                    <div><dt class="text-sm text-surface-600 dark:text-surface-300">Localidade</dt><dd data-testid="localidade">{{ formatarLocalidade(resposta.concorrente.cidade, resposta.concorrente.uf) }}</dd></div>
                    <div><dt class="text-sm text-surface-600 dark:text-surface-300">Data da inscri&ccedil;&atilde;o</dt><dd>{{ formatarData(resposta.concorrente.dataInscricao) }}</dd></div>
                </dl>

                <div class="grid min-w-0 gap-8 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
                    <div class="min-w-0 space-y-8">
                        <section class="min-w-0 space-y-3" aria-labelledby="obra-principal">
                            <h2 id="obra-principal" class="text-xl font-semibold">Obra principal</h2>
                            <p class="break-words font-medium">{{ resposta.concorrente.obraPrincipal.titulo }}</p>
                            <ng-container [ngTemplateOutlet]="video" [ngTemplateOutletContext]="{ video: videoPrincipal(), player: playerPrincipal(), opcional: false, titulo: 'V\u00eddeo principal' }" />
                        </section>
                        <section class="min-w-0 space-y-3" aria-labelledby="obra-opcional">
                            <h2 id="obra-opcional" class="text-xl font-semibold">Segunda obra</h2>
                            @if (resposta.concorrente.obraOpcional; as obra) {
                                <p class="break-words font-medium">{{ obra.titulo }}</p>
                                <ng-container [ngTemplateOutlet]="video" [ngTemplateOutletContext]="{ video: videoOpcional(), player: playerOpcional(), opcional: true, titulo: 'V\u00eddeo opcional' }" />
                            } @else {
                                <p>N&atilde;o h&aacute; segunda obra.</p>
                            }
                        </section>
                    </div>
                    <section class="min-w-0 space-y-4" aria-labelledby="criterios">
                        <h2 id="criterios" class="text-xl font-semibold">Crit&eacute;rios de avalia&ccedil;&atilde;o</h2>
                        <p class="text-sm text-surface-600 dark:text-surface-300">Crit&eacute;rios informativos: nenhuma nota &eacute; registrada nesta etapa. Escala prevista: 0&ndash;100. Peso inicial previsto: 25% por crit&eacute;rio.</p>
                        <ol class="list-decimal space-y-4 pl-5">
                            <li>T&eacute;cnica e Precis&atilde;o Executiva</li>
                            <li>Expressividade e Interpreta&ccedil;&atilde;o Musical</li>
                            <li>Fidelidade &agrave; Obra e Arranjo</li>
                            <li>Conformidade com o Regulamento<p class="mt-2 text-sm text-surface-600 dark:text-surface-300">A futura sinaliza&ccedil;&atilde;o de poss&iacute;vel desclassifica&ccedil;&atilde;o ser&aacute; encaminhada para an&aacute;lise da coordena&ccedil;&atilde;o, respons&aacute;vel pela decis&atilde;o final.</p></li>
                        </ol>
                    </section>
                </div>
            }

            <ng-template #video let-video="video" let-player="player" let-opcional="opcional" let-titulo="titulo">
                @if (video) {
                    @if (video.embed) {
                        @if (player) {
                            <div class="aspect-video w-full overflow-hidden">
                                <iframe [src]="player" [title]="titulo" class="h-full w-full border-0" allow="encrypted-media; picture-in-picture; fullscreen" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>
                            </div>
                        } @else {
                            <div class="flex aspect-video w-full flex-col items-center justify-center gap-3 border border-surface-200 bg-surface-50 p-4 text-center dark:border-surface-700 dark:bg-surface-800">
                                <button pButton type="button" icon="pi pi-play" label="Reproduzir v&#237;deo" [attr.aria-label]="'Reproduzir ' + titulo" (click)="reproduzirVideo(opcional)"></button>
                                <p class="text-sm">Ao reproduzir, o player do YouTube ser&aacute; carregado.</p>
                            </div>
                        }
                    }
                    <a [href]="video.externo" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-2 text-primary underline underline-offset-4 focus-visible:outline focus-visible:outline-2" [attr.aria-label]="titulo + ': abrir no ' + video.provedor + ' em nova aba'"><i class="pi pi-external-link" aria-hidden="true"></i>Abrir no {{ video.provedor }}</a>
                } @else {
                    <p>{{ titulo }} indispon&iacute;vel.</p>
                }
            </ng-template>
        </section>
    `
})
export class JuradoConcorrenteComponent {
    private readonly route = inject(ActivatedRoute);
    private readonly router = inject(Router);
    private readonly service = inject(JuradoService);
    private readonly sanitizer = inject(DomSanitizer);
    private readonly recargas = new Subject<void>();

    readonly slug = signal('');
    readonly detalhe = signal<ConcorrenteJuradoResponse | null>(null);
    readonly carregando = signal(true);
    readonly erro = signal<ResultadoDetalhe['erro']>(null);
    readonly videoPrincipal = signal<VideoJurado | null>(null);
    readonly videoOpcional = signal<VideoJurado | null>(null);
    readonly playerPrincipal = signal<SafeResourceUrl | null>(null);
    readonly playerOpcional = signal<SafeResourceUrl | null>(null);

    constructor() {
        this.route.paramMap.pipe(
            map((params) => ({ slug: params.get('slug') || '', id: params.get('idParticipacao') || '' })),
            distinctUntilChanged((anterior, atual) => anterior.slug === atual.slug && anterior.id === atual.id),
            switchMap(({ slug, id }) => {
                this.slug.set(slug);
                return this.recargas.pipe(
                    startWith(undefined),
                    switchMap(() => {
                        this.limparDetalhe();
                        if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) {
                            return of<ResultadoDetalhe>({ resposta: null, erro: 'indisponivel' });
                        }
                        return this.service.obterConcorrente(slug, Number(id)).pipe(
                            map((resposta): ResultadoDetalhe => {
                                if (!resposta.evento || !resposta.concorrente) throw new Error('Detalhe ausente.');
                                return { resposta, erro: null };
                            }),
                            catchError((error: unknown) => {
                                if (error instanceof HttpErrorResponse && [401, 403].includes(error.status)) {
                                    void this.router.navigate([error.status === 401 ? '/login' : '/']);
                                }
                                return of<ResultadoDetalhe>({ resposta: null, erro: error instanceof HttpErrorResponse && [400, 404].includes(error.status) ? 'indisponivel' : 'inesperado' });
                            })
                        );
                    })
                );
            }),
            takeUntilDestroyed()
        ).subscribe(({ resposta, erro }) => {
            this.detalhe.set(resposta);
            this.erro.set(erro);
            this.videoPrincipal.set(this.normalizarVideo(resposta?.concorrente.linkVideoPrincipal ?? null));
            this.videoOpcional.set(resposta?.concorrente.obraOpcional ? this.normalizarVideo(resposta.concorrente.linkVideoOpcional) : null);
            this.carregando.set(false);
        });
    }

    tentarNovamente(): void {
        this.recargas.next();
    }

    reproduzirVideo(opcional: boolean): void {
        const video = opcional ? this.videoOpcional() : this.videoPrincipal();
        if (video?.embed) {
            const player = this.sanitizer.bypassSecurityTrustResourceUrl(video.embed);
            if (opcional) this.playerOpcional.set(player);
            else this.playerPrincipal.set(player);
        }
    }

    formatarLocalidade(cidade: string | null, uf: string | null): string {
        return [cidade?.trim(), uf?.trim()].filter(Boolean).join(' / ') || '\u2014';
    }

    formatarData(valor: string): string {
        const data = new Date(valor);
        return Number.isNaN(data.getTime()) ? '\u2014' : new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short' }).format(data);
    }

    private limparDetalhe(): void {
        this.detalhe.set(null);
        this.videoPrincipal.set(null);
        this.videoOpcional.set(null);
        this.playerPrincipal.set(null);
        this.playerOpcional.set(null);
        this.erro.set(null);
        this.carregando.set(true);
    }

    private normalizarVideo(valor: string | null): VideoJurado | null {
        if (!valor?.trim() || valor.trim().length > 500) return null;
        try {
            const url = new URL(valor.trim());
            if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
            const segmentos = url.pathname.split('/').filter(Boolean);
            let id: string | null = null;
            if (url.hostname === 'youtu.be') id = segmentos[0] || null;
            else if (['youtube.com', 'www.youtube.com'].includes(url.hostname)) {
                if (url.pathname === '/watch') id = url.searchParams.get('v');
                else if (['shorts', 'embed'].includes(segmentos[0])) id = segmentos[1] || null;
            } else if (['vimeo.com', 'www.vimeo.com'].includes(url.hostname) && /^\d+$/.test(segmentos[0] || '')) {
                return { provedor: 'Vimeo', externo: url.href, embed: null };
            }
            return id && /^[A-Za-z0-9_-]{11}$/.test(id)
                ? { provedor: 'YouTube', externo: `https://www.youtube.com/watch?v=${id}`, embed: `https://www.youtube-nocookie.com/embed/${id}` }
                : null;
        } catch {
            return null;
        }
    }
}