import { NgTemplateOutlet } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { ConfirmationService } from 'primeng/api';
import { ButtonModule } from 'primeng/button';
import { CheckboxModule } from 'primeng/checkbox';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { InputNumberModule } from 'primeng/inputnumber';
import { TextareaModule } from 'primeng/textarea';
import { EMPTY, Subject, catchError, distinctUntilChanged, finalize, map, merge, of, startWith, switchMap, takeUntil } from 'rxjs';
import { AvaliacaoJuradoResponse, ConcorrenteJuradoResponse, JuradoService, SalvarAvaliacaoJuradoPayload } from '../../shared/jurado.service';

interface VideoJurado {
    provedor: 'YouTube' | 'Vimeo';
    externo: string;
    embed: string | null;
}

interface ResultadoDetalhe {
    resposta: ConcorrenteJuradoResponse | null;
    erro: 'indisponivel' | 'inesperado' | null;
}

interface ContextoAvaliacao {
    slug: string;
    idParticipacao: number;
    geracao: number;
}

type ResultadoCarga =
    { tipo: 'detalhe'; contexto: ContextoAvaliacao; resultado: ResultadoDetalhe }
    | { tipo: 'avaliacao'; contexto: ContextoAvaliacao; resposta: AvaliacaoJuradoResponse | null; erro: unknown };

interface EdicaoAvaliacao {
    notas: Readonly<Record<number, number | null>>;
    possivelDesclassificacao: boolean;
    motivoDesclassificacao: string;
}

@Component({
    selector: 'p-jurado-concorrente',
    standalone: true,
    imports: [NgTemplateOutlet, RouterLink, FormsModule, ButtonModule, CheckboxModule, ConfirmDialogModule, InputNumberModule, TextareaModule],
    providers: [ConfirmationService],
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
                    @if (resposta.concorrente.cidade !== undefined || resposta.concorrente.uf !== undefined) {
                        <div><dt class="text-sm text-surface-600 dark:text-surface-300">Localidade</dt><dd data-testid="localidade">{{ formatarLocalidade(resposta.concorrente.cidade, resposta.concorrente.uf) }}</dd></div>
                    }
                    @if (resposta.concorrente.dataInscricao) {
                        <div><dt class="text-sm text-surface-600 dark:text-surface-300">Data da inscri&ccedil;&atilde;o</dt><dd>{{ formatarData(resposta.concorrente.dataInscricao) }}</dd></div>
                    }
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
                    <section class="min-w-0 space-y-4" aria-labelledby="criterios" [attr.aria-busy]="carregandoAvaliacao() || salvando() || reconciliando()">
                        <h2 id="criterios" class="text-xl font-semibold">Crit&eacute;rios de avalia&ccedil;&atilde;o</h2>
                        @if (carregandoAvaliacao()) {
                            <p role="status" data-testid="loading-avaliacao">Carregando avalia&ccedil;&atilde;o...</p>
                        }
                        @if (erroAvaliacao()) {
                            <p role="alert" class="break-words text-red-700 dark:text-red-300" data-testid="erro-avaliacao">{{ erroAvaliacao() }}</p>
                        }
                        @if (mensagemConflito()) {
                            <p role="alert" class="break-words border-l-4 border-amber-500 pl-3" data-testid="conflito-avaliacao">{{ mensagemConflito() }}</p>
                        }
                        @if (conflito()) {
                            <button pButton type="button" icon="pi pi-refresh" label="Recarregar avalia\u00e7\u00e3o"
                                data-testid="recarregar-avaliacao" [disabled]="reconciliando() || salvando()"
                                (click)="recarregarAvaliacao()"></button>
                        }
                        @if (avaliacao(); as atual) {
                            @if (!atual.podeGravar) {
                                <p role="status" data-testid="autorizacao-gravacao">{{ mensagemBloqueio() }}</p>
                            }
                            <p role="status" class="font-semibold" data-testid="estado-avaliacao">
                                @switch (atual.estado) {
                                    @case ('pendente') { Avalia&ccedil;&atilde;o n&atilde;o iniciada }
                                    @case ('rascunho') { Rascunho }
                                    @case ('concluida') { Avalia&ccedil;&atilde;o conclu&iacute;da }
                                }
                            </p>
                            @if (alteracoesNaoSalvas()) {
                                <p class="text-sm text-surface-600 dark:text-surface-300" data-testid="alteracoes-nao-salvas">Altera&ccedil;&otilde;es n&atilde;o salvas.</p>
                            }
                            <form (ngSubmit)="salvarRascunho()" novalidate class="min-w-0 space-y-5">
                                @for (criterio of atual.criterios; track criterio.idCriterioCiclo) {
                                    <div class="min-w-0 space-y-2 border-b border-surface-200 pb-4 dark:border-surface-800" data-testid="criterio-avaliacao">
                                        <label [for]="'nota-' + criterio.idCriterioCiclo" class="block break-words font-medium">{{ criterio.nome }}</label>
                                        @if (criterio.descricao?.trim()) {
                                            <p [id]="'descricao-' + criterio.idCriterioCiclo" class="break-words text-sm text-surface-600 dark:text-surface-300">{{ criterio.descricao }}</p>
                                        }
                                        <p [id]="'peso-' + criterio.idCriterioCiclo" class="text-sm">Peso: {{ criterio.peso }}%</p>
                                        <p-inputnumber
                                            [inputId]="'nota-' + criterio.idCriterioCiclo" [name]="'nota-' + criterio.idCriterioCiclo"
                                            [ngModel]="notasEditaveis()[criterio.idCriterioCiclo]" (ngModelChange)="alterarNota(criterio.idCriterioCiclo, $event)"
                                            [min]="atual.escala.min" [max]="atual.escala.max" [step]="atual.escala.passo"
                                            [allowEmpty]="true" [useGrouping]="false" [maxFractionDigits]="0"
                                            [readonly]="concluida()" [disabled]="!podeEditar() || confirmando"
                                            [invalid]="!!erroGravacao()"
                                            [ariaDescribedBy]="'peso-' + criterio.idCriterioCiclo + (criterio.descricao?.trim() ? ' descricao-' + criterio.idCriterioCiclo : '') + (erroGravacao() ? ' erro-gravacao' : '')"
                                            [inputStyleClass]="erroGravacao() ? 'w-full ng-invalid ng-dirty' : 'w-full'" styleClass="w-full" />
                                    </div>
                                }
                                <section class="min-w-0 space-y-3 border-t border-surface-200 pt-4 dark:border-surface-800" aria-labelledby="sinalizacao">
                                    <h3 id="sinalizacao" class="text-base font-semibold">Sinaliza&ccedil;&atilde;o &agrave; coordena&ccedil;&atilde;o</h3>
                                    <div class="flex items-start gap-3">
                                        <p-checkbox inputId="possivel-desclassificacao" name="possivel-desclassificacao" [binary]="true"
                                            [ngModel]="possivelDesclassificacao()" (ngModelChange)="alterarDesclassificacao($event)"
                                            [disabled]="!podeEditar() || confirmando" ariaLabelledBy="label-desclassificacao" />
                                        <label id="label-desclassificacao" for="possivel-desclassificacao" class="break-words font-medium">Poss&iacute;vel desclassifica&ccedil;&atilde;o</label>
                                    </div>
                                    <p class="text-sm text-surface-600 dark:text-surface-300">Esta &eacute; uma sinaliza&ccedil;&atilde;o do jurado. A decis&atilde;o final cabe &agrave; coordena&ccedil;&atilde;o do Festival.</p>
                                    @if (possivelDesclassificacao()) {
                                        <label for="motivo-desclassificacao" class="block font-medium">Motivo da sinaliza&ccedil;&atilde;o</label>
                                        <textarea pTextarea id="motivo-desclassificacao" name="motivo-desclassificacao" rows="4" class="w-full min-w-0 resize-y"
                                            [ngModel]="motivoDesclassificacao()" (ngModelChange)="alterarMotivo($event)"
                                            [readonly]="concluida()" [disabled]="!podeEditar() || confirmando" [required]="true"
                                            [attr.aria-invalid]="erroGravacao() ? 'true' : null"
                                            [attr.aria-describedby]="erroGravacao() ? 'motivo-contagem erro-gravacao' : 'motivo-contagem'"></textarea>
                                        <p id="motivo-contagem" class="text-sm" aria-live="polite" data-testid="contador-motivo">{{ tamanhoMotivo() }} / 2000 caracteres</p>
                                    }
                                </section>
                                <div class="border-y border-surface-200 py-4 dark:border-surface-800" data-testid="media-avaliacao">
                                    @if (mediaSalva(); as media) {
                                        <p class="text-sm text-surface-600 dark:text-surface-300">{{ concluida() ? 'M\u00e9dia final' : alteracoesNaoSalvas() ? 'M\u00e9dia do \u00faltimo estado salvo' : 'M\u00e9dia do rascunho salvo' }}</p>
                                        <p class="text-xl font-semibold">{{ media }}</p>
                                    } @else {
                                        <p class="text-sm text-surface-600 dark:text-surface-300">A m&eacute;dia estar&aacute; dispon&iacute;vel ap&oacute;s todas as notas necess&aacute;rias serem preenchidas e salvas.</p>
                                    }
                                </div>
                                @if (atual.avaliacao?.dataConclusao; as dataConclusao) {
                                    <p class="text-sm" data-testid="data-conclusao">Conclu&iacute;da em {{ formatarData(dataConclusao) }}</p>
                                }
                                @if (erroGravacao()) {
                                    <p id="erro-gravacao" role="alert" class="break-words text-red-700 dark:text-red-300">{{ erroGravacao() }}</p>
                                }
                                @if (reconciliando()) {
                                    <p role="status">Atualizando o estado da avalia&ccedil;&atilde;o...</p>
                                } @else if (salvando()) {
                                    <p role="status">Salvando...</p>
                                }
                                @if (!concluida() && !erroAvaliacao()) {
                                    <div class="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
                                        <button pButton type="submit" icon="pi pi-save" label="Salvar rascunho" data-testid="salvar-rascunho"
                                            [disabled]="!podeEditar() || confirmando" [loading]="salvando() && !reconciliando()"></button>
                                        <button pButton type="button" icon="pi pi-check" label="Concluir avalia\u00e7\u00e3o" class="p-button-outlined" data-testid="concluir-avaliacao"
                                            [disabled]="!podeEditar() || confirmando" (click)="abrirConfirmacaoConclusao()"></button>
                                    </div>
                                }
                            </form>
                        }
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
            <p-confirmdialog key="concluir-avaliacao" [style]="{ width: 'min(32rem, calc(100vw - 2rem))' }" [closable]="false" [closeOnEscape]="false" />
        </section>
    `
})
export class JuradoConcorrenteComponent {
    private readonly route = inject(ActivatedRoute);
    private readonly router = inject(Router);
    private readonly service = inject(JuradoService);
    private readonly sanitizer = inject(DomSanitizer);
    private readonly confirmationService = inject(ConfirmationService);
    private readonly destroyRef = inject(DestroyRef);
    private readonly recargas = new Subject<void>();
    private readonly cancelarOperacoes = new Subject<void>();
    private contexto: ContextoAvaliacao | null = null;
    private geracao = 0;
    private preparacaoConclusao: { contexto: ContextoAvaliacao; payload: SalvarAvaliacaoJuradoPayload } | null = null;
    private readonly edicao = signal<EdicaoAvaliacao>({ notas: Object.freeze({}), possivelDesclassificacao: false, motivoDesclassificacao: '' });
    private readonly respostaAvaliacao = signal<AvaliacaoJuradoResponse | null>(null);

    readonly slug = signal('');
    readonly detalhe = signal<ConcorrenteJuradoResponse | null>(null);
    readonly carregando = signal(true);
    readonly erro = signal<ResultadoDetalhe['erro']>(null);
    readonly videoPrincipal = signal<VideoJurado | null>(null);
    readonly videoOpcional = signal<VideoJurado | null>(null);
    readonly playerPrincipal = signal<SafeResourceUrl | null>(null);
    readonly playerOpcional = signal<SafeResourceUrl | null>(null);
    readonly avaliacao = this.respostaAvaliacao.asReadonly();
    readonly notasEditaveis = computed(() => this.edicao().notas);
    readonly possivelDesclassificacao = computed(() => this.edicao().possivelDesclassificacao);
    readonly motivoDesclassificacao = computed(() => this.edicao().motivoDesclassificacao);
    readonly carregandoAvaliacao = signal(true);
    readonly salvando = signal(false);
    readonly reconciliando = signal(false);
    readonly erroAvaliacao = signal<string | null>(null);
    readonly erroGravacao = signal<string | null>(null);
    readonly conflito = signal(false);
    readonly mensagemConflito = signal<string | null>(null);
    readonly mediaSalva = computed(() => this.avaliacao()?.avaliacao?.media ?? null);
    readonly tamanhoMotivo = computed(() => Array.from(this.motivoDesclassificacao().trim()).length);
    readonly concluida = computed(() => this.avaliacao()?.estado === 'concluida');
    readonly podeEditar = computed(() => Boolean(this.detalhe() && this.avaliacao()?.podeGravar)
        && !this.carregando() && !this.carregandoAvaliacao() && !this.salvando()
        && !this.reconciliando() && !this.conflito() && !this.erroAvaliacao() && !this.concluida());
    readonly mensagemBloqueio = computed(() => {
        const autorizacao = this.avaliacao()?.autorizacaoGravacao;
        switch (autorizacao?.estado) {
            case 'avaliacao_concluida': return 'Avalia\u00e7\u00e3o conclu\u00edda. Dispon\u00edvel somente para leitura.';
            case 'ciclo_fechado': return 'Ciclo de julgamento fechado. Dispon\u00edvel somente para leitura.';
            case 'jurado_inelegivel':
            case 'jurado_fora_do_ciclo': return 'Sem autoriza\u00e7\u00e3o para gravar neste ciclo.';
            case 'concorrente_fora_do_ciclo':
            case 'concorrente_inelegivel': return 'Participa\u00e7\u00e3o indispon\u00edvel para grava\u00e7\u00e3o neste ciclo.';
            default: return autorizacao?.motivo === 'limite_versao'
                && autorizacao.code === 'CONTEXTO_NAO_GRAVAVEL'
                ? 'Esta avalia\u00e7\u00e3o n\u00e3o permite novas grava\u00e7\u00f5es.'
                : 'Grava\u00e7\u00e3o indispon\u00edvel neste contexto.';
        }
    });
    readonly alteracoesNaoSalvas = computed(() => {
        const resposta = this.avaliacao();
        if (!resposta) return false;
        const persistida = resposta.avaliacao;
        return resposta.criterios.some((criterio) => !Object.is(this.notasEditaveis()[criterio.idCriterioCiclo],
            persistida?.notas.find((nota) => nota.idCriterioCiclo === criterio.idCriterioCiclo)?.nota ?? null))
            || this.possivelDesclassificacao() !== (persistida?.possivelDesclassificacao ?? false)
            || this.motivoDesclassificacao() !== (persistida?.motivoDesclassificacao ?? '');
    });

    constructor() {
        this.route.paramMap.pipe(
            map((params) => ({ slug: params.get('slug') || '', id: params.get('idParticipacao') || '' })),
            distinctUntilChanged((anterior, atual) => anterior.slug === atual.slug && anterior.id === atual.id),
            switchMap(({ slug, id }) => {
                this.slug.set(slug);
                return this.recargas.pipe(
                    startWith(undefined),
                    switchMap(() => {
                        this.contexto = null;
                        this.cancelarOperacoes.next();
                        this.limparDetalhe();
                        this.limparAvaliacao();
                        if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) {
                            this.erro.set('indisponivel');
                            this.carregando.set(false);
                            this.carregandoAvaliacao.set(false);
                            this.erroAvaliacao.set('Avalia\u00e7\u00e3o indispon\u00edvel.');
                            return EMPTY;
                        }
                        const contexto = { slug, idParticipacao: Number(id), geracao: ++this.geracao };
                        this.contexto = contexto;
                        const detalhe = this.service.obterConcorrente(slug, contexto.idParticipacao).pipe(
                            map((resposta): ResultadoCarga => {
                                if (resposta.evento?.slug !== slug || resposta.concorrente?.idParticipacao !== contexto.idParticipacao) throw new Error('Detalhe ausente.');
                                return { tipo: 'detalhe', contexto, resultado: { resposta, erro: null } };
                            }),
                            catchError((error: unknown) => {
                                this.tratarAutorizacao(error);
                                return of<ResultadoCarga>({ tipo: 'detalhe', contexto, resultado: { resposta: null, erro: error instanceof HttpErrorResponse && [400, 404].includes(error.status) ? 'indisponivel' : 'inesperado' } });
                            })
                        );
                        const avaliacao = this.service.obterAvaliacao(slug, contexto.idParticipacao).pipe(
                            map((resposta): ResultadoCarga => ({ tipo: 'avaliacao', contexto, resposta, erro: null })),
                            catchError((erro: unknown) => of<ResultadoCarga>({ tipo: 'avaliacao', contexto, resposta: null, erro }))
                        );
                        return merge(detalhe, avaliacao);
                    })
                );
            }),
            takeUntilDestroyed()
        ).subscribe((resultado) => {
            if (resultado.contexto !== this.contexto) return;
            if (resultado.tipo === 'detalhe') {
                const { resposta, erro } = resultado.resultado;
                this.detalhe.set(resposta);
                this.erro.set(erro);
                this.videoPrincipal.set(this.normalizarVideo(resposta?.concorrente.linkVideoPrincipal ?? null));
                this.videoOpcional.set(resposta?.concorrente.obraOpcional ? this.normalizarVideo(resposta.concorrente.linkVideoOpcional) : null);
                this.carregando.set(false);
            } else {
                if (resultado.resposta) this.aplicarAvaliacao(resultado.resposta, resultado.contexto);
                else this.tratarErroAvaliacao(resultado.erro);
                this.carregandoAvaliacao.set(false);
            }
        });
    }

    tentarNovamente(): void {
        if (this.salvando() || this.reconciliando()) return;
        this.recargas.next();
    }

    alterarNota(idCriterioCiclo: number, nota: number | null): void {
        if (!this.podeEditar() || !this.avaliacao()?.criterios.some((criterio) => criterio.idCriterioCiclo === idCriterioCiclo)) return;
        this.preparacaoConclusao = null;
        this.edicao.update((edicao) => ({ ...edicao, notas: Object.freeze({ ...edicao.notas, [idCriterioCiclo]: nota }) }));
    }

    alterarDesclassificacao(possivel: boolean): void {
        if (!this.podeEditar() || typeof possivel !== 'boolean') return;
        this.preparacaoConclusao = null;
        this.edicao.update((edicao) => ({ ...edicao, possivelDesclassificacao: possivel }));
    }

    alterarMotivo(motivo: string): void {
        if (!this.podeEditar() || typeof motivo !== 'string') return;
        this.preparacaoConclusao = null;
        this.edicao.update((edicao) => ({ ...edicao, motivoDesclassificacao: motivo }));
    }

    salvarRascunho(): void {
        const payload = this.construirPayload('rascunho');
        if (payload && this.contexto) this.gravar(payload, this.contexto);
    }

    solicitarConclusao(): boolean {
        this.preparacaoConclusao = null;
        const payload = this.construirPayload('concluida');
        if (!payload || !this.contexto) return false;
        this.preparacaoConclusao = { contexto: this.contexto, payload };
        return true;
    }

    cancelarConclusao(): void {
        this.preparacaoConclusao = null;
    }

    get confirmando(): boolean {
        return this.preparacaoConclusao !== null;
    }

    abrirConfirmacaoConclusao(): void {
        if (this.confirmando || !this.solicitarConclusao()) return;
        const preparacao = this.preparacaoConclusao;
        this.confirmationService.confirm({
            key: 'concluir-avaliacao',
            header: 'Concluir avalia\u00e7\u00e3o',
            message: 'A avalia\u00e7\u00e3o ser\u00e1 conclu\u00edda. Depois da conclus\u00e3o, voc\u00ea n\u00e3o poder\u00e1 alter\u00e1-la. Esta a\u00e7\u00e3o \u00e9 irrevers\u00edvel para o jurado.',
            icon: 'pi pi-exclamation-triangle',
            acceptLabel: 'Concluir',
            rejectLabel: 'Cancelar',
            defaultFocus: 'reject',
            accept: () => {
                if (preparacao === this.preparacaoConclusao) this.executarConclusao();
            },
            reject: () => {
                if (preparacao === this.preparacaoConclusao) this.cancelarConclusao();
            }
        });
    }

    executarConclusao(): void {
        const preparacao = this.preparacaoConclusao;
        this.preparacaoConclusao = null;
        if (!preparacao || preparacao.contexto !== this.contexto || preparacao.payload.versao !== this.avaliacao()?.versao) return;
        this.gravar(preparacao.payload, preparacao.contexto);
    }

    private construirPayload(estado: SalvarAvaliacaoJuradoPayload['estado']): SalvarAvaliacaoJuradoPayload | null {
        if (!this.podeEditar()) return null;
        this.erroGravacao.set(null);
        const resposta = this.avaliacao()!;
        const notas: SalvarAvaliacaoJuradoPayload['notas'] = [];
        for (const criterio of resposta.criterios) {
            const nota = this.notasEditaveis()[criterio.idCriterioCiclo];
            if (nota === null && estado === 'rascunho') continue;
            if (typeof nota !== 'number' || !Number.isInteger(nota) || nota < resposta.escala.min || nota > resposta.escala.max) {
                this.erroGravacao.set('Informe notas inteiras dentro da escala. Para concluir, preencha todos os crit\u00e9rios.');
                return null;
            }
            notas.push({ idCriterioCiclo: criterio.idCriterioCiclo, nota });
        }
        const motivo = this.motivoDesclassificacao().trim();
        if (this.possivelDesclassificacao() && (!motivo || Array.from(motivo).length > 2000)) {
            this.erroGravacao.set('Informe um motivo com at\u00e9 2000 caracteres para a poss\u00edvel desclassifica\u00e7\u00e3o.');
            return null;
        }
        return {
            contexto: { idCiclo: resposta.contexto.idCiclo, numeroTentativa: resposta.contexto.numeroTentativa },
            versao: resposta.versao, estado, notas, possivelDesclassificacao: this.possivelDesclassificacao(),
            motivoDesclassificacao: this.possivelDesclassificacao() ? motivo : null
        };
    }

    private gravar(payload: SalvarAvaliacaoJuradoPayload, contexto: ContextoAvaliacao): void {
        if (!this.podeEditar() || contexto !== this.contexto) return;
        this.preparacaoConclusao = null;
        this.salvando.set(true);
        this.conflito.set(false);
        this.mensagemConflito.set(null);
        this.service.salvarAvaliacao(contexto.slug, contexto.idParticipacao, payload).pipe(
            catchError((error: unknown) => {
                if (contexto !== this.contexto) return EMPTY;
                if (error instanceof HttpErrorResponse && error.status === 409) {
                    this.conflito.set(true);
                    this.mensagemConflito.set('A avalia\u00e7\u00e3o ou o contexto foi alterado. Recarregue para continuar; suas edi\u00e7\u00f5es n\u00e3o ser\u00e3o reaplicadas.');
                    return EMPTY;
                }
                this.erroGravacao.set(error instanceof HttpErrorResponse && error.status === 400
                    ? 'Dados de avalia\u00e7\u00e3o inv\u00e1lidos. Confira as notas e o motivo.'
                    : 'N\u00e3o foi poss\u00edvel salvar a avalia\u00e7\u00e3o.');
                if (error instanceof HttpErrorResponse && [401, 403, 404].includes(error.status)) this.tratarErroAvaliacao(error);
                return EMPTY;
            }),
            takeUntil(this.cancelarOperacoes),
            takeUntilDestroyed(this.destroyRef),
            finalize(() => {
                if (contexto === this.contexto) {
                    this.salvando.set(false);
                    this.reconciliando.set(false);
                }
            })
        ).subscribe((resposta) => {
            if (contexto !== this.contexto) return;
            this.aplicarAvaliacao(resposta, contexto);
        });
    }

    recarregarAvaliacao(): void {
        const contexto = this.contexto;
        if (!contexto || !this.conflito() || this.salvando() || this.reconciliando()) return;
        this.preparacaoConclusao = null;
        this.reconciliando.set(true);
        this.service.obterAvaliacao(contexto.slug, contexto.idParticipacao).pipe(
            catchError((error: unknown) => {
                if (contexto === this.contexto) this.tratarErroAvaliacao(error);
                return EMPTY;
            }),
            takeUntil(this.cancelarOperacoes),
            takeUntilDestroyed(this.destroyRef),
            finalize(() => {
                if (contexto === this.contexto) this.reconciliando.set(false);
            })
        ).subscribe((resposta) => {
            if (contexto !== this.contexto) return;
            this.aplicarAvaliacao(resposta, contexto);
            if (!this.erroAvaliacao()) {
                this.conflito.set(false);
                this.mensagemConflito.set('Estado atualizado. As edi\u00e7\u00f5es anteriores n\u00e3o foram reaplicadas.');
            }
        });
    }

    private aplicarAvaliacao(resposta: AvaliacaoJuradoResponse, contexto: ContextoAvaliacao): void {
        if (contexto !== this.contexto) return;
        if (resposta.evento?.slug !== contexto.slug || resposta.concorrente?.idParticipacao !== contexto.idParticipacao) {
            this.erroAvaliacao.set('Avalia\u00e7\u00e3o indispon\u00edvel.');
            return;
        }
        this.respostaAvaliacao.set(resposta);
        this.erroAvaliacao.set(null);
        this.erroGravacao.set(null);
        this.preparacaoConclusao = null;
        this.edicao.set({
            notas: Object.freeze(Object.fromEntries(resposta.criterios.map((criterio) => [criterio.idCriterioCiclo,
                resposta.avaliacao?.notas.find((nota) => nota.idCriterioCiclo === criterio.idCriterioCiclo)?.nota ?? null]))),
            possivelDesclassificacao: resposta.avaliacao?.possivelDesclassificacao ?? false,
            motivoDesclassificacao: resposta.avaliacao?.motivoDesclassificacao ?? ''
        });
    }

    private tratarAutorizacao(error: unknown): void {
        if (error instanceof HttpErrorResponse && [401, 403].includes(error.status)) void this.router.navigate([error.status === 401 ? '/login' : '/']);
    }

    private tratarErroAvaliacao(error: unknown): void {
        this.tratarAutorizacao(error);
        this.erroAvaliacao.set(error instanceof HttpErrorResponse && [400, 404, 409].includes(error.status)
            ? 'Avalia\u00e7\u00e3o indispon\u00edvel.' : 'N\u00e3o foi poss\u00edvel carregar a avalia\u00e7\u00e3o.');
    }

    private limparAvaliacao(): void {
        this.confirmationService.close();
        this.respostaAvaliacao.set(null);
        this.edicao.set({ notas: Object.freeze({}), possivelDesclassificacao: false, motivoDesclassificacao: '' });
        this.preparacaoConclusao = null;
        this.carregandoAvaliacao.set(true);
        this.salvando.set(false);
        this.reconciliando.set(false);
        this.erroAvaliacao.set(null);
        this.erroGravacao.set(null);
        this.conflito.set(false);
        this.mensagemConflito.set(null);
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