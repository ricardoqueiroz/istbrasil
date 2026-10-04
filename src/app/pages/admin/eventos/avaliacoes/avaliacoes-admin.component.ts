import { HttpErrorResponse } from '@angular/common/http';
import { Component, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { TableLazyLoadEvent, TableModule } from 'primeng/table';
import { TooltipModule } from 'primeng/tooltip';
import { Subject, catchError, distinctUntilChanged, map, of, startWith, switchMap } from 'rxjs';
import { AvaliacoesAdminParametros, AvaliacoesAdminResponse, AvaliacoesAdminSortField, HistoricoAvaliacoesAdmin, SinalizacoesAvaliacoesAdmin } from './avaliacoes-admin.model';
import { AvaliacoesAdminService } from './avaliacoes-admin.service';

const PADRAO: AvaliacoesAdminParametros = { page: 1, limit: 25, sortField: 'numeroConcorrente', sortOrder: 'asc' };
const CAMPOS: AvaliacoesAdminSortField[] = ['numeroConcorrente', 'nome'];

@Component({
    selector: 'p-admin-avaliacoes',
    standalone: true,
    imports: [ButtonModule, TableModule, TooltipModule],
    styles: [':host { display: block; min-width: 0; max-width: 100%; color: var(--text-color); }'],
    template: `
        <section class="min-w-0 w-full max-w-full space-y-5">
            <header class="space-y-2">
                <h2 class="break-words text-2xl font-semibold">Acompanhamento das Avalia&ccedil;&otilde;es</h2>
                @if (resposta(); as dados) {
                    <p class="break-words"><span class="font-medium">Evento:</span> {{ dados.evento.nome }}</p>
                    <div class="flex flex-wrap gap-x-6 gap-y-2 border-y border-surface-200 py-3 text-sm dark:border-surface-800">
                        <p data-testid="jurados-atuais">Jurados atuais: <strong>{{ dados.jurados.totalAtuais }}</strong></p>
                        <p data-testid="total-concorrentes">Concorrentes eleg&iacute;veis: <strong>{{ dados.pagination.total }}</strong></p>
                    </div>
                    @if (dados.jurados.totalAtuais === 0) {
                        <p role="alert" class="border-l-4 border-amber-500 pl-3" data-testid="juri-vazio">Nenhum jurado est&aacute; atualmente habilitado para este evento.</p>
                    }
                }
            </header>
            @if (carregando()) {
                <p role="status">Carregando acompanhamento...</p>
            }
            @if (erro(); as mensagem) {
                <div role="alert" class="flex flex-wrap items-center justify-between gap-3 border-l-4 border-red-500 pl-3">
                    <p class="min-w-0 break-words">{{ mensagem }}</p>
                    <button pButton type="button" icon="pi pi-refresh" label="Tentar novamente" class="p-button-outlined" (click)="tentarNovamente()"></button>
                </div>
            }
            <div class="min-w-0 max-w-full overflow-hidden border-y border-surface-200 dark:border-surface-800" [attr.aria-busy]="carregando()">
                <p-table
                    [value]="carregando() || erro() ? [] : (resposta()?.data ?? [])" dataKey="idParticipacao"
                    [lazy]="true" [lazyLoadOnInit]="false" (onLazyLoad)="carregar($event)"
                    [paginator]="true" [first]="first" [rows]="rows" [rowsPerPageOptions]="[25, 50, 100]"
                    [totalRecords]="erro() ? 0 : (resposta()?.pagination?.total ?? 0)" [loading]="carregando()"
                    [sortField]="sortField" [sortOrder]="sortOrder" sortMode="single" [resetPageOnSort]="true"
                    [showCurrentPageReport]="true" currentPageReportTemplate="{first}-{last} / {totalRecords}"
                    paginatorTemplate="FirstPageLink PrevPageLink CurrentPageReport NextPageLink LastPageLink RowsPerPageDropdown"
                    responsiveLayout="scroll" [tableStyle]="{ 'min-width': '62rem', 'width': '100%', 'table-layout': 'fixed' }">
                    <ng-template #header>
                        <tr>
                            <th style="width: 17%" pSortableColumn="numeroConcorrente">Inscri&ccedil;&atilde;o <p-sortIcon field="numeroConcorrente" /></th>
                            <th style="width: 23%" pSortableColumn="nome">Concorrente <p-sortIcon field="nome" /></th>
                            <th style="width: 10%">Conclu&iacute;das</th>
                            <th style="width: 9%">Rascunhos</th>
                            <th style="width: 9%">Pendentes</th>
                            <th style="width: 16%">Hist&oacute;rico</th>
                            <th style="width: 16%">Sinaliza&ccedil;&atilde;o</th>
                        </tr>
                    </ng-template>
                    <ng-template #body let-concorrente>
                        <tr>
                            <td class="whitespace-normal break-words font-medium">{{ concorrente.numeroConcorrente }}</td>
                            <td class="whitespace-normal break-words">{{ concorrente.nome }}</td>
                            <td>{{ concorrente.andamento.concluidasAtuais }}/{{ concorrente.andamento.totalJuradosAtuais }}</td>
                            <td>{{ concorrente.andamento.rascunhosAtuais }}</td>
                            <td>{{ concorrente.andamento.pendentesAtuais }}</td>
                            <td class="whitespace-normal break-words">
                                @if (concorrente.historico.totalAvaliacoesForaDoJuriAtual > 0) {
                                    <span tabindex="0" [pTooltip]="tooltipHistorico(concorrente.historico)" tooltipEvent="focus" tooltipPosition="top">{{ concorrente.historico.totalAvaliacoesForaDoJuriAtual }} fora do j&uacute;ri atual</span>
                                } @else { &mdash; }
                            </td>
                            <td class="whitespace-normal break-words">
                                @if (concorrente.sinalizacoes.possuiQualquer) {
                                    <span tabindex="0" [pTooltip]="explicacaoSinalizacao" tooltipEvent="focus" tooltipPosition="top">{{ textoSinalizacao(concorrente.sinalizacoes) }}</span>
                                } @else { &mdash; }
                            </td>
                        </tr>
                    </ng-template>
                    <ng-template #emptymessage>
                        <tr><td colspan="7" class="py-6 text-center">
                            @if (carregando()) { Carregando acompanhamento... }
                            @else if (erro()) { Acompanhamento indispon&iacute;vel. }
                            @else if (resposta()?.pagination?.total === 0) { Nenhum concorrente eleg&iacute;vel encontrado para este evento. }
                        </td></tr>
                    </ng-template>
                </p-table>
            </div>
            <p class="text-sm text-surface-600 dark:text-surface-300">{{ explicacaoSinalizacao }}</p>
        </section>
    `
})
export class AvaliacoesAdminComponent {
    private readonly route = inject(ActivatedRoute);
    private readonly router = inject(Router);
    private readonly service = inject(AvaliacoesAdminService);
    private readonly cargas = new Subject<AvaliacoesAdminParametros>();
    readonly resposta = signal<AvaliacoesAdminResponse | null>(null);
    readonly carregando = signal(true);
    readonly erro = signal<string | null>(null);
    readonly explicacaoSinalizacao = 'Sinaliza\u00e7\u00e3o registrada por jurado; n\u00e3o representa decis\u00e3o de desclassifica\u00e7\u00e3o.';
    first = 0;
    rows = 25;
    sortField: AvaliacoesAdminSortField = 'numeroConcorrente';
    sortOrder = 1;

    constructor() {
        this.route.paramMap.pipe(
            map(params => params.get('slug') || ''),
            distinctUntilChanged(),
            switchMap(slug => {
                this.first = 0;
                this.rows = 25;
                this.sortField = 'numeroConcorrente';
                this.sortOrder = 1;
                this.resposta.set(null);
                return this.cargas.pipe(
                    startWith(PADRAO),
                    switchMap(parametros => {
                        this.carregando.set(true);
                        this.erro.set(null);
                        return this.service.listarAndamento(slug, parametros).pipe(
                            map(resposta => {
                                if (resposta.evento?.slug !== slug || !Array.isArray(resposta.data)) throw new Error('Resposta indisponivel');
                                return { resposta, erro: null };
                            }),
                            catchError((error: unknown) => {
                                const status = error instanceof HttpErrorResponse ? error.status : 0;
                                if (status === 401) void this.router.navigate(['/login']);
                                const mensagem = status === 404 ? 'Evento n\u00e3o encontrado.'
                                    : status === 403 ? 'Acesso administrativo n\u00e3o autorizado.'
                                    : status === 409 ? 'N\u00e3o foi poss\u00edvel apresentar o acompanhamento porque foram detectadas inconsist\u00eancias nos dados do evento.'
                                    : 'N\u00e3o foi poss\u00edvel carregar o acompanhamento das avalia\u00e7\u00f5es.';
                                return of({ resposta: null, erro: mensagem });
                            })
                        );
                    })
                );
            }),
            takeUntilDestroyed()
        ).subscribe(({ resposta, erro }) => {
            this.resposta.set(resposta);
            this.erro.set(erro);
            if (resposta) {
                this.rows = resposta.pagination.limit;
                this.first = (resposta.pagination.page - 1) * this.rows;
            }
            this.carregando.set(false);
        });
    }

    carregar(event: TableLazyLoadEvent): void {
        const rows = event.rows && [25, 50, 100].includes(event.rows) ? event.rows : this.rows;
        const sortField = typeof event.sortField === 'string' && CAMPOS.includes(event.sortField as AvaliacoesAdminSortField) ? event.sortField as AvaliacoesAdminSortField : this.sortField;
        const sortOrder = event.sortOrder == null ? this.sortOrder : event.sortOrder === -1 ? -1 : 1;
        const reset = rows !== this.rows || sortField !== this.sortField || sortOrder !== this.sortOrder;
        const pedido = event.first ?? this.first;
        const first = reset || !Number.isSafeInteger(pedido) || pedido < 0 ? 0 : Math.floor(pedido / rows) * rows;
        if (first === this.first && rows === this.rows && sortField === this.sortField && sortOrder === this.sortOrder) return;
        this.first = first;
        this.rows = rows;
        this.sortField = sortField;
        this.sortOrder = sortOrder;
        this.tentarNovamente();
    }

    tentarNovamente(): void {
        this.cargas.next({ page: Math.floor(this.first / this.rows) + 1, limit: this.rows, sortField: this.sortField, sortOrder: this.sortOrder === -1 ? 'desc' : 'asc' });
    }

    tooltipHistorico(historico: HistoricoAvaliacoesAdmin): string {
        return `Total: ${historico.totalAvaliacoesForaDoJuriAtual}. Conclu\u00eddas: ${historico.concluidas}. Rascunhos: ${historico.rascunhos}.`;
    }

    textoSinalizacao(sinal: SinalizacoesAvaliacoesAdmin): string {
        if (sinal.possuiAtual && sinal.possuiHistorica) return 'Atual e hist\u00f3rica';
        if (sinal.possuiAtual) return 'Sinaliza\u00e7\u00e3o atual';
        if (sinal.possuiHistorica) return 'Sinaliza\u00e7\u00e3o hist\u00f3rica';
        return '\u2014';
    }
}