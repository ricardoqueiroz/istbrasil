import { CommonModule } from '@angular/common';
import { Component, DestroyRef, OnInit, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { SelectModule } from 'primeng/select';
import { TableLazyLoadEvent, TableModule } from 'primeng/table';
import { TooltipModule } from 'primeng/tooltip';
import { Subject, debounceTime } from 'rxjs';
import {
    CargoAdmin,
    SituacaoAdmin,
    TipoUsuarioAdmin,
    UsuarioAdminLista,
    UsuariosAdminSortField
} from '../cadastros.model';
import { CadastrosAdminService } from '../cadastros.service';

const CAMPOS_ORDENACAO = new Set<UsuariosAdminSortField>([
    'nome',
    'email',
    'tipo',
    'cargo',
    'situacao',
    'dataCadastro'
]);

@Component({
    selector: 'app-admin-cadastros-listar',
    standalone: true,
    imports: [CommonModule, FormsModule, ButtonModule, InputTextModule, SelectModule, TableModule, TooltipModule],
    template: `
        <section class="space-y-6">
            <header>
                <p class="text-sm font-semibold uppercase tracking-widest text-primary">Administração de cadastros</p>
                <h2 class="mt-2 text-3xl font-bold text-surface-900 dark:text-white">Usuários</h2>
                <p class="mt-2 text-surface-600 dark:text-surface-300">Consulte os usuários cadastrados e refine a listagem pelos dados administrativos.</p>
            </header>

            <div *ngIf="erroOpcoes" class="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
                {{ erroOpcoes }}
            </div>

            <div class="border-y border-surface-200 py-5 dark:border-surface-800">
                <div class="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                    <div class="md:col-span-2 xl:col-span-1">
                        <label for="buscaUsuarios" class="mb-2 block text-sm font-medium text-surface-700 dark:text-surface-200">Buscar por nome ou e-mail</label>
                        <div class="relative">
                            <i class="pi pi-search pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-surface-400" aria-hidden="true"></i>
                            <input id="buscaUsuarios" pInputText type="search" [(ngModel)]="buscaDigitada" (input)="aoDigitarBusca($event)" class="w-full pl-30" style="padding-left: 30px" placeholder="Nome ou e-mail" autocomplete="off" />
                        </div>
                    </div>

                    <div>
                        <label for="tipoUsuario" class="mb-2 block text-sm font-medium text-surface-700 dark:text-surface-200">Tipo de usuário</label>
                        <p-select id="tipoUsuario" name="tipoUsuario" [(ngModel)]="idTipoUsuario" (ngModelChange)="alterarTipo($event)" [options]="tiposUsuario" optionLabel="tipo" optionValue="idTipoUsuario" [showClear]="true" placeholder="Todos" styleClass="w-full" [loading]="carregandoOpcoes"></p-select>
                    </div>

                    <div>
                        <label for="cargoUsuario" class="mb-2 block text-sm font-medium text-surface-700 dark:text-surface-200">Cargo</label>
                        <p-select id="cargoUsuario" name="cargoUsuario" [(ngModel)]="idCargo" (ngModelChange)="alterarFiltro()" [options]="cargos" optionLabel="cargo" optionValue="idCargo" [showClear]="true" placeholder="Todos" styleClass="w-full" [loading]="carregandoOpcoes"></p-select>
                    </div>

                    <div>
                        <label for="situacaoUsuario" class="mb-2 block text-sm font-medium text-surface-700 dark:text-surface-200">Situação</label>
                        <p-select id="situacaoUsuario" name="situacaoUsuario" [(ngModel)]="idSituacao" (ngModelChange)="alterarFiltro()" [options]="situacoesVisiveis" optionLabel="situacao" optionValue="idSituacao" [showClear]="true" placeholder="Todos" styleClass="w-full" [loading]="carregandoOpcoes"></p-select>
                    </div>
                </div>

                <div class="mt-4 flex justify-end">
                    <button pButton type="button" label="Limpar filtros" icon="pi pi-filter-slash" class="p-button-outlined" (click)="limparFiltros()" [disabled]="!filtrosAtivos"></button>
                </div>
            </div>

            <div *ngIf="erroUsuarios" class="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/30 dark:text-red-200">
                {{ erroUsuarios }}
            </div>

            <div class="overflow-hidden rounded-lg border border-surface-200 bg-white dark:border-surface-800 dark:bg-surface-900">
                <p-table
                    #tabela
                    [value]="usuarios"
                    dataKey="idUsuario"
                    [lazy]="true"
                    (onLazyLoad)="carregarUsuarios($event)"
                    [paginator]="true"
                    [first]="first"
                    [rows]="rows"
                    [rowsPerPageOptions]="[25, 50, 100]"
                    [totalRecords]="totalRecords"
                    [loading]="carregandoUsuarios"
                    [sortField]="sortField"
                    [sortOrder]="sortOrder"
                    [showCurrentPageReport]="true"
                    currentPageReportTemplate="Mostrando {first} a {last} de {totalRecords} usuários"
                    responsiveLayout="scroll"
                    [tableStyle]="{ 'min-width': '70rem' }"
                >
                    <ng-template #header>
                        <tr>
                            <th pSortableColumn="nome">Nome <p-sortIcon field="nome" /></th>
                            <th pSortableColumn="email">E-mail <p-sortIcon field="email" /></th>
                            <th pSortableColumn="tipo">Tipo <p-sortIcon field="tipo" /></th>
                            <th pSortableColumn="cargo">Cargo <p-sortIcon field="cargo" /></th>
                            <th pSortableColumn="situacao">Situação <p-sortIcon field="situacao" /></th>
                            <th pSortableColumn="dataCadastro">Cadastro <p-sortIcon field="dataCadastro" /></th>
                            <th class="text-center">Ações</th>
                        </tr>
                    </ng-template>

                    <ng-template #body let-usuario>
                        <tr>
                            <td class="font-medium">{{ usuario.nome }}</td>
                            <td>{{ usuario.email }}</td>
                            <td>{{ usuario.tipo }}</td>
                            <td>{{ usuario.cargo || '—' }}</td>
                            <td>{{ usuario.situacao || '—' }}</td>
                            <td>{{ formatarDataCadastro(usuario.dataCadastro) }}</td>
                            <td class="text-center">
                                <span pTooltip="Editar usuário" tooltipPosition="left" class="inline-flex">
                                    <button pButton type="button" icon="pi pi-pencil" class="p-button-text p-button-rounded" aria-label="Editar usuário" (click)="editarUsuario(usuario.idUsuario)"></button>
                                </span>
                            </td>
                        </tr>
                    </ng-template>

                    <ng-template #emptymessage>
                        <tr>
                            <td colspan="7" class="py-10 text-center text-surface-500">
                                {{ mensagemTabelaVazia }}
                            </td>
                        </tr>
                    </ng-template>
                </p-table>
            </div>
        </section>
    `
})
export class ListarCadastrosComponent implements OnInit {
    private readonly service = inject(CadastrosAdminService);
    private readonly router = inject(Router);
    private readonly destroyRef = inject(DestroyRef);
    private readonly buscaSubject = new Subject<string>();
    private requisicaoAtual = 0;

    usuarios: UsuarioAdminLista[] = [];
    tiposUsuario: TipoUsuarioAdmin[] = [];
    cargos: CargoAdmin[] = [];
    situacoes: SituacaoAdmin[] = [];

    buscaDigitada = '';
    search = '';
    idTipoUsuario: number | null = null;
    idCargo: number | null = null;
    idSituacao: number | null = null;

    first = 0;
    rows = 25;
    totalRecords = 0;
    sortField: UsuariosAdminSortField = 'nome';
    sortOrder = 1;

    carregandoUsuarios = false;
    carregandoOpcoes = false;
    erroUsuarios: string | null = null;
    erroOpcoes: string | null = null;

    get situacoesVisiveis(): SituacaoAdmin[] {
        return this.idTipoUsuario === null
            ? this.situacoes
            : this.situacoes.filter((situacao) => situacao.idTipoUsuario === this.idTipoUsuario);
    }

    get filtrosAtivos(): boolean {
        return Boolean(this.buscaDigitada.trim() || this.idTipoUsuario || this.idCargo || this.idSituacao);
    }

    get mensagemTabelaVazia(): string {
        if (this.erroUsuarios) return 'Não foi possível carregar os usuários.';
        return this.filtrosAtivos ? 'Nenhum usuário corresponde aos filtros informados.' : 'Nenhum usuário cadastrado.';
    }

    ngOnInit(): void {
        this.buscaSubject.pipe(
            debounceTime(400),
            takeUntilDestroyed(this.destroyRef)
        ).subscribe((valor) => {
            this.search = valor.trim();
            this.recarregarPrimeiraPagina();
        });

        void this.carregarOpcoes();
    }

    async carregarUsuarios(event: TableLazyLoadEvent): Promise<void> {
        const first = event.first ?? this.first;
        const rows = event.rows ?? this.rows;
        const sortFieldEvento = typeof event.sortField === 'string' ? event.sortField : this.sortField;

        this.first = first;
        this.rows = rows;
        this.sortField = this.ehCampoOrdenacao(sortFieldEvento) ? sortFieldEvento : 'nome';
        this.sortOrder = event.sortOrder === -1 ? -1 : 1;

        const numeroRequisicao = ++this.requisicaoAtual;
        this.carregandoUsuarios = true;
        this.erroUsuarios = null;

        try {
            const resposta = await this.service.listarUsuarios({
                page: Math.floor(this.first / this.rows) + 1,
                limit: this.rows,
                search: this.search || undefined,
                idTipoUsuario: this.idTipoUsuario ?? undefined,
                idCargo: this.idCargo ?? undefined,
                idSituacao: this.idSituacao ?? undefined,
                sortField: this.sortField,
                sortOrder: this.sortOrder === -1 ? 'desc' : 'asc'
            });

            if (numeroRequisicao !== this.requisicaoAtual) return;
            this.usuarios = resposta.data;
            this.totalRecords = resposta.pagination.total;
        } catch {
            if (numeroRequisicao !== this.requisicaoAtual) return;
            this.usuarios = [];
            this.totalRecords = 0;
            this.erroUsuarios = 'Não foi possível carregar os usuários. Tente novamente.';
        } finally {
            if (numeroRequisicao === this.requisicaoAtual) {
                this.carregandoUsuarios = false;
            }
        }
    }

    aoDigitarBusca(event: Event): void {
        const input = event.target as HTMLInputElement;
        this.buscaSubject.next(input.value);
    }

    alterarTipo(idTipoUsuario: number | null): void {
        this.idTipoUsuario = idTipoUsuario;
        if (this.idSituacao !== null && !this.situacoesVisiveis.some((situacao) => situacao.idSituacao === this.idSituacao)) {
            this.idSituacao = null;
        }
        this.recarregarPrimeiraPagina();
    }

    alterarFiltro(): void {
        this.recarregarPrimeiraPagina();
    }

    limparFiltros(): void {
        this.buscaDigitada = '';
        this.search = '';
        this.idTipoUsuario = null;
        this.idCargo = null;
        this.idSituacao = null;
        this.buscaSubject.next('');
    }

    formatarDataCadastro(valor: string): string {
        const data = new Date(valor);
        if (Number.isNaN(data.getTime())) return '—';
        return new Intl.DateTimeFormat('pt-BR', {
            dateStyle: 'short',
            timeStyle: 'short'
        }).format(data);
    }

    async editarUsuario(idUsuario: number): Promise<void> {
        await this.router.navigate(['/admin/cadastros', idUsuario, 'editar']);
    }

    private async carregarOpcoes(): Promise<void> {
        this.carregandoOpcoes = true;
        this.erroOpcoes = null;

        try {
            const opcoes = await this.service.listarOpcoes();
            this.tiposUsuario = opcoes.tiposUsuario;
            this.cargos = opcoes.cargos;
            this.situacoes = opcoes.situacoes;
        } catch {
            this.erroOpcoes = 'Não foi possível carregar as opções de filtro. A listagem continua disponível.';
        } finally {
            this.carregandoOpcoes = false;
        }
    }

    private recarregarPrimeiraPagina(): void {
        this.first = 0;
        void this.carregarUsuarios({
            first: 0,
            rows: this.rows,
            sortField: this.sortField,
            sortOrder: this.sortOrder
        });
    }

    private ehCampoOrdenacao(valor: string): valor is UsuariosAdminSortField {
        return CAMPOS_ORDENACAO.has(valor as UsuariosAdminSortField);
    }
}
