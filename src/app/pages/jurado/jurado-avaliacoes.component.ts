import { HttpErrorResponse } from '@angular/common/http';
import { Component, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { TableLazyLoadEvent, TableModule } from 'primeng/table';
import { Subject, catchError, distinctUntilChanged, map, of, startWith, switchMap } from 'rxjs';
import { AuthService } from '../../shared/auth.service';
import { FilaJuradoParams, FilaJuradoResponse, FilaJuradoSort, JuradoService } from '../../shared/jurado.service';

const PARAMETROS_PADRAO: FilaJuradoParams = { page: 1, limit: 25, sort: 'numeroConcorrente', order: 'asc' };
const CAMPOS_ORDENACAO: FilaJuradoSort[] = ['numeroConcorrente', 'nome', 'dataInscricao'];

@Component({
    selector: 'p-jurado-avaliacoes',
    standalone: true,
    imports: [ButtonModule, TableModule],
    styles: [':host { display: block; min-width: 0; max-width: 100%; }'],
    template: `
        <section class="min-w-0 w-full max-w-full space-y-6 py-6">
            <header class="space-y-3">
                <h1 class="break-words text-2xl font-semibold">Avalia&ccedil;&atilde;o dos Concorrentes</h1>
                @if (fila(); as resposta) {
                    <p class="break-words"><span class="font-medium">Evento:</span> {{ resposta.evento.nome }}</p>
                }
                @if (authService.usuario(); as usuario) {
                    <p class="break-words"><span class="font-medium">Jurado:</span> {{ usuario.nome }}</p>
                }
                @if (!carregando() && !erro() && fila(); as resposta) {
                    <p class="text-sm" data-testid="total-concorrentes">Total de concorrentes: <strong>{{ resposta.pagination.total }}</strong></p>
                }
            </header>

            @if (carregando()) {
                <p role="status" class="text-sm text-surface-600 dark:text-surface-300">Carregando concorrentes...</p>
            }

            @if (erro(); as mensagem) {
                <div role="alert" class="flex flex-wrap items-center justify-between gap-3 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-red-700 dark:border-red-800 dark:bg-red-950/30 dark:text-red-200">
                    <p class="min-w-0 break-words">{{ mensagem }}</p>
                    <button pButton type="button" icon="pi pi-refresh" label="Tentar novamente" class="p-button-outlined shrink-0" (click)="tentarNovamente()"></button>
                </div>
            }

            <div class="min-w-0 max-w-full overflow-hidden border-y border-surface-200 dark:border-surface-800" [attr.aria-busy]="carregando()">
                <p-table
                    [value]="carregando() || erro() ? [] : (fila()?.concorrentes ?? [])"
                    dataKey="idParticipacao"
                    [lazy]="true"
                    [lazyLoadOnInit]="false"
                    (onLazyLoad)="carregarConcorrentes($event)"
                    [paginator]="true"
                    [first]="first"
                    [rows]="rows"
                    [rowsPerPageOptions]="[25, 50, 100]"
                    [totalRecords]="erro() ? 0 : (fila()?.pagination?.total ?? 0)"
                    [loading]="carregando()"
                    [sortField]="sortField"
                    [sortOrder]="sortOrder"
                    sortMode="single"
                    [resetPageOnSort]="true"
                    [showCurrentPageReport]="true"
                    currentPageReportTemplate="{first}-{last} / {totalRecords}"
                    paginatorTemplate="FirstPageLink PrevPageLink CurrentPageReport NextPageLink LastPageLink RowsPerPageDropdown"
                    responsiveLayout="scroll"
                    [tableStyle]="{ 'min-width': '56rem', 'width': '100%', 'table-layout': 'fixed' }"
                >
                    <ng-template #header>
                        <tr>
                            <th style="width: 13%" pSortableColumn="numeroConcorrente">Inscri&ccedil;&atilde;o <p-sortIcon field="numeroConcorrente" /></th>
                            <th style="width: 22%" pSortableColumn="nome">Concorrente <p-sortIcon field="nome" /></th>
                            <th style="width: 15%">Localidade</th>
                            <th style="width: 14%" pSortableColumn="dataInscricao">Data da inscri&ccedil;&atilde;o <p-sortIcon field="dataInscricao" /></th>
                            <th style="width: 18%">Obra principal</th>
                            <th style="width: 18%">Segunda obra</th>
                        </tr>
                    </ng-template>
                    <ng-template #body let-concorrente>
                        <tr>
                            <td class="whitespace-normal break-words font-medium">{{ concorrente.numeroConcorrente }}</td>
                            <td class="whitespace-normal break-words">{{ concorrente.nome }}</td>
                            <td class="whitespace-normal break-words">{{ formatarLocalidade(concorrente.cidade, concorrente.uf) }}</td>
                            <td>{{ formatarDataInscricao(concorrente.dataInscricao) }}</td>
                            <td class="whitespace-normal break-words">{{ concorrente.obraPrincipal.titulo }}</td>
                            <td class="whitespace-normal break-words">{{ concorrente.obraOpcional?.titulo ?? '\u2014' }}</td>
                        </tr>
                    </ng-template>
                    <ng-template #emptymessage>
                        <tr>
                            <td colspan="6" class="py-8 text-center text-surface-600 dark:text-surface-300">
                                @if (carregando()) {
                                    <span role="status">Carregando concorrentes...</span>
                                } @else if (erro()) {
                                    N&atilde;o foi poss&iacute;vel carregar a fila.
                                } @else if (fila()?.pagination?.total === 0) {
                                    Nenhum concorrente dispon&iacute;vel para avalia&ccedil;&atilde;o.
                                }
                            </td>
                        </tr>
                    </ng-template>
                </p-table>
            </div>
        </section>
    `
})
export class JuradoAvaliacoesComponent {
    readonly authService = inject(AuthService);
    private readonly route = inject(ActivatedRoute);
    private readonly router = inject(Router);
    private readonly juradoService = inject(JuradoService);
    private readonly cargas = new Subject<FilaJuradoParams>();

    readonly fila = signal<FilaJuradoResponse | null>(null);
    readonly carregando = signal(true);
    readonly erro = signal<string | null>(null);
    first = 0;
    rows = 25;
    sortField: FilaJuradoSort = 'numeroConcorrente';
    sortOrder = 1;

    constructor() {
        this.route.paramMap.pipe(
            map((params) => params.get('slug') || ''),
            distinctUntilChanged(),
            switchMap((slug) => {
                this.first = 0;
                this.rows = 25;
                this.sortField = 'numeroConcorrente';
                this.sortOrder = 1;
                this.fila.set(null);
                return this.cargas.pipe(
                    startWith(PARAMETROS_PADRAO),
                    switchMap((parametros) => {
                        this.carregando.set(true);
                        this.erro.set(null);
                        return this.juradoService.listarConcorrentes(slug, parametros).pipe(
                            map((resposta) => {
                                if (!resposta.evento) throw new Error('Evento ausente na resposta da fila.');
                                return { resposta, erro: null };
                            }),
                            catchError((error: unknown) => {
                                if (error instanceof HttpErrorResponse && [401, 403, 404].includes(error.status)) {
                                    void this.router.navigate([error.status === 401 ? '/login' : '/']);
                                }
                                return of({ resposta: null, erro: 'N\u00e3o foi poss\u00edvel carregar os concorrentes. Tente novamente.' });
                            })
                        );
                    })
                );
            }),
            takeUntilDestroyed()
        ).subscribe(({ resposta, erro }) => {
            this.fila.set(resposta);
            this.erro.set(erro);
            this.carregando.set(false);
        });
    }

    carregarConcorrentes(event: TableLazyLoadEvent): void {
        const rows = event.rows && [25, 50, 100].includes(event.rows) ? event.rows : this.rows;
        const sort = typeof event.sortField === 'string' && CAMPOS_ORDENACAO.includes(event.sortField as FilaJuradoSort)
            ? event.sortField as FilaJuradoSort : this.sortField;
        const sortOrder = event.sortOrder == null ? this.sortOrder : event.sortOrder === -1 ? -1 : 1;
        const reiniciarPagina = rows !== this.rows || sort !== this.sortField || sortOrder !== this.sortOrder;
        const firstSolicitado = event.first ?? this.first;
        const first = reiniciarPagina || !Number.isSafeInteger(firstSolicitado) || firstSolicitado < 0
            ? 0 : Math.floor(firstSolicitado / rows) * rows;
        if (first === this.first && rows === this.rows && sort === this.sortField && sortOrder === this.sortOrder) return;

        this.first = first;
        this.rows = rows;
        this.sortField = sort;
        this.sortOrder = sortOrder;
        this.tentarNovamente();
    }

    tentarNovamente(): void {
        this.cargas.next({ page: Math.floor(this.first / this.rows) + 1, limit: this.rows, sort: this.sortField, order: this.sortOrder === -1 ? 'desc' : 'asc' });
    }

    formatarLocalidade(cidade: string | null, uf: string | null): string {
        return [cidade?.trim(), uf?.trim()].filter(Boolean).join(' / ') || '\u2014';
    }

    formatarDataInscricao(valor: string): string {
        const data = new Date(valor);
        return Number.isNaN(data.getTime()) ? '\u2014' : new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short' }).format(data);
    }
}