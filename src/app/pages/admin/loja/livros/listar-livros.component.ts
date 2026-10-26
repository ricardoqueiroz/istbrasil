import {MessageModule} from 'primeng/message';
import { Component, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { DialogModule } from 'primeng/dialog';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { SelectModule } from 'primeng/select';
import { TooltipModule } from 'primeng/tooltip';
import { TableLazyLoadEvent, TableModule } from 'primeng/table';
import { Subject, catchError, debounceTime, distinctUntilChanged, map, of, startWith, switchMap } from 'rxjs';
import { LojaAdminErro, LojaAdminService } from '../loja-admin.service';
import { LivroAdmin, LivrosAdminConsulta, LivrosAdminResposta } from '../loja-admin.model';

@Component({
    selector: 'app-admin-loja-livros', standalone: true,
    imports: [MessageModule, FormsModule, RouterLink, DialogModule, ButtonModule, InputTextModule, SelectModule, TooltipModule, TableModule],
    template: `
        <section class="space-y-5">
            <h2 class="text-2xl font-semibold">Loja — Livros</h2>
            <a pButton routerLink="/admin/loja/livros/novo">Novo livro</a>
            @if (sucesso()) { <p role="status">{{ sucesso() }}</p> }
            @if (erroOperacao()) { <p-message severity="error" role="alert">{{ erroOperacao() }}</p-message> }
            <p>Dados editoriais. Ordenação por ID crescente.</p>
            <div class="flex flex-wrap gap-4">
                <div><label for="buscaLivros" class="block">Título</label>
                    <input id="buscaLivros" pInputText type="search" [ngModel]="busca" (ngModelChange)="buscar($event)" autocomplete="off" /></div>
                <div><label for="classificacaoLivros" class="block">Pertence à Editora IST</label>
                    <p-select inputId="classificacaoLivros" [options]="opcoes" optionLabel="label" optionValue="value"
                        [ngModel]="classificacao" (ngModelChange)="filtrar($event)" /></div>
            </div>
            @if (carregando()) { <p role="status">Carregando livros...</p> }
            @if (erro(); as mensagem) {
                <div><p-message severity="error" role="alert">{{ mensagem }}</p-message>
                    <button pButton type="button" label="Tentar novamente" (click)="recarregar()"></button></div>
            }
            <p-table [value]="dados()?.itens ?? []" dataKey="id" [lazy]="true" [lazyLoadOnInit]="false"
                (onLazyLoad)="paginar($event)" [paginator]="true" [first]="first" [rows]="rows"
                [rowsPerPageOptions]="[20,50,100]" [totalRecords]="dados()?.paginacao?.total ?? 0"
                [loading]="carregando()" [attr.aria-busy]="carregando()" responsiveLayout="scroll">
                <ng-template #header><tr><th>ID</th><th>Título</th><th>Idioma</th><th>Categoria editorial</th><th>Formato</th><th>Pertence à Editora IST</th><th>Ações</th></tr></ng-template>
                <ng-template #body let-livro><tr><td>{{ livro.id }}</td><td>{{ livro.title ?? 'Não informado' }}</td>
                    <td>{{ livro.language ?? 'Não informado' }}</td><td>{{ livro.category ?? 'Não informado' }}</td>
                    <td>{{ livro.format ?? 'Não informado' }}
                        @if (livro.produtoTipo === 'DIGITAL') {
                            @for (v of livro.versoesPdf ?? []; track v.versaoPublicId) { <div>PDF {{v.numeroVersao}} — {{v.estado}}</div> }
                            @if (!livro.versoesPdf?.length) { <div>Sem PDF</div> }
                        }
                    </td><td>{{ classificar(livro.pertenceEditoraIst) }}</td>
                    <td><div class="flex items-center gap-2">
                        <button pButton type="button" class="!h-8 !w-8 !p-0 shrink-0" aria-label="Publicar PDF" pTooltip="Publicar PDF"
                            [disabled]="publicando() || !rascunhos(livro).length" (click)="abrirPublicacao(livro)">
                            <i class="pi pi-upload" aria-hidden="true"></i></button>
                        <a pButton [routerLink]="['/admin/loja/livros', livro.id, 'editar']"
                            class="!h-8 !w-8 !p-0 shrink-0" aria-label="Editar livro" pTooltip="Editar livro">
                            <i class="pi pi-file-edit" aria-hidden="true"></i></a>
                        <button pButton type="button" class="!h-8 !w-8 !p-0 shrink-0"
                            aria-label="Excluir livro" pTooltip="Excluir livro"
                            [disabled]="excluindo()" (click)="confirmarExclusao(livro)">
                            <i class="pi pi-trash" aria-hidden="true"></i></button>
                    </div></td></tr></ng-template>
                <ng-template #emptymessage><tr><td colspan="7">{{ carregando() ? 'Carregando...' : erro() ? 'Consulta indisponível.' : 'Nenhum livro encontrado.' }}</td></tr></ng-template>
            </p-table>
            <p-dialog header="Excluir livro" [visible]="selecionado !== null" [modal]="true" [closable]="!excluindo()"
                [closeOnEscape]="!excluindo()" (visibleChange)="fecharConfirmacao($event)">
                <p>Excluir definitivamente o livro #{{ selecionado?.id }}? Livros vinculados a qualquer produto não podem ser excluídos.</p>
                <ng-template #footer>
                    <button pButton type="button" label="Cancelar" [disabled]="excluindo()" (click)="fecharConfirmacao(false)"></button>
                    <button pButton type="button" label="Confirmar exclusão" [disabled]="excluindo()" (click)="excluir()"></button>
                </ng-template>
            </p-dialog>
            <p-dialog header="Publicar PDF" [visible]="livroPublicacao !== null" [modal]="true" [closable]="!publicando()"
                [closeOnEscape]="!publicando()" (visibleChange)="fecharPublicacao($event)">
                <p>A publicação substitui o PDF atual para novas compras. Não altera a situação comercial.</p>
                <label for="versaoPublicacao">Selecione explicitamente o rascunho</label>
                <p-select inputId="versaoPublicacao" [options]="opcoesPublicacao" optionLabel="label" optionValue="value"
                    [(ngModel)]="versaoPublicacao" [disabled]="publicando()" appendTo="body" />
                <ng-template #footer>
                    <button pButton type="button" label="Cancelar" [disabled]="publicando()" (click)="fecharPublicacao(false)"></button>
                    <button pButton type="button" label="Confirmar publicação" [disabled]="publicando() || !versaoPublicacao" (click)="publicar()"></button>
                </ng-template>
            </p-dialog>
        </section>`
})
export class ListarLivrosComponent {
    private readonly service = inject(LojaAdminService);
    private readonly destroyRef = inject(DestroyRef);
    private readonly route = inject(ActivatedRoute);
    readonly sucesso = signal<string | null>(null);
    readonly erroOperacao = signal<string | null>(null);
    readonly excluindo = signal(false);
    readonly publicando = signal(false);
    livroPublicacao: LivroAdmin | null = null;
    versaoPublicacao: string | null = null;
    opcoesPublicacao: {label:string;value:string}[] = [];
    rascunhos(livro: LivroAdmin) { return (livro.versoesPdf??[]).filter(v=>v.estado==='RASCUNHO'); }
    abrirPublicacao(livro: LivroAdmin): void {
        if(this.publicando())return;
        this.livroPublicacao=livro;this.versaoPublicacao=null;
        this.opcoesPublicacao=this.rascunhos(livro).map(v=>({label:`Versão ${v.numeroVersao} — RASCUNHO`,value:v.versaoPublicId}));
    }
    fecharPublicacao(visivel: boolean): void {if(!visivel&&!this.publicando())this.livroPublicacao=null;}
    publicar(): void {
        if(!this.livroPublicacao||!this.versaoPublicacao||this.publicando())return;
        this.publicando.set(true);this.erroOperacao.set(null);this.sucesso.set(null);
        this.service.publicarPdf(this.livroPublicacao,this.versaoPublicacao).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
            next:()=>{this.publicando.set(false);this.livroPublicacao=null;this.sucesso.set('PDF publicado. A situação comercial foi preservada.');this.recarregar();},
            error:e=>{this.publicando.set(false);this.livroPublicacao=null;this.erroOperacao.set(e instanceof LojaAdminErro?e.message:'Publicação não confirmada. Confira antes de repetir.');this.recarregar();}
        });
    }
    selecionado: LivroAdmin | null = null;
    private readonly consultas = new Subject<void>();
    private readonly buscas = new Subject<string>();
    readonly carregando = signal(false);
    readonly erro = signal<string | null>(null);
    readonly dados = signal<LivrosAdminResposta | null>(null);
    readonly opcoes = [{ label: 'Todos', value: 'todos' }, { label: 'Sim', value: 'sim' },
        { label: 'Não', value: 'nao' }, { label: 'Não informado', value: 'nulo' }];
    busca = '';
    private buscaAplicada = '';
    classificacao = 'todos';
    first = 0;
    rows = 20;
    constructor() {
        const resultado = this.route.snapshot.queryParamMap.get('resultado');
        this.sucesso.set(resultado === 'criado' ? 'Livro cadastrado.' : resultado === 'editado' ? 'Livro atualizado.' : null);
        this.buscas.pipe(debounceTime(400), distinctUntilChanged(), takeUntilDestroyed(this.destroyRef)).subscribe(v => {
            this.buscaAplicada = v; this.first = 0; this.recarregar();
        });
        this.consultas.pipe(startWith(undefined), switchMap(() => {
            this.carregando.set(true); this.erro.set(null); this.dados.set(null);
            const consulta: LivrosAdminConsulta = { pagina: Math.floor(this.first / this.rows) + 1, limite: this.rows, busca: this.buscaAplicada };
            if (this.classificacao !== 'todos') consulta.pertenceEditoraIst = this.classificacao === 'nulo' ? null : this.classificacao === 'sim';
            return this.service.listarLivros(consulta).pipe(map(dados => ({ dados, erro: null })),
                catchError(e => of({ dados: null, erro: e instanceof LojaAdminErro ? e.message : 'Não foi possível carregar os livros.' })));
        }), takeUntilDestroyed(this.destroyRef)).subscribe(r => {
            if (r.dados && r.dados.paginacao.total > 0 && this.first >= r.dados.paginacao.total) {
                this.first = Math.floor((r.dados.paginacao.total - 1) / this.rows) * this.rows;
                this.recarregar(); return;
            }
            this.dados.set(r.dados); this.erro.set(r.erro); this.carregando.set(false);
        });
    }
    buscar(v: string): void { this.busca = v; this.buscas.next(v.trim()); }
    filtrar(v: string): void { this.classificacao = v; this.first = 0; this.recarregar(); }
    paginar(e: TableLazyLoadEvent): void {
        const rows = e.rows ?? this.rows;
        this.first = rows === this.rows ? (e.first ?? 0) : 0;
        this.rows = rows; this.recarregar();
    }
    recarregar(): void { this.consultas.next(); }
    confirmarExclusao(livro: LivroAdmin): void {
        if (this.excluindo()) return;
        this.erroOperacao.set(null); this.sucesso.set(null); this.excluindo.set(true);
        this.service.obterLivro(livro.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
            next: atual => {this.excluindo.set(false); this.selecionado = atual;},
            error: e => {this.excluindo.set(false); this.erroOperacao.set(e instanceof LojaAdminErro?e.message:'Nao foi possivel carregar as revisoes para confirmar a exclusao.');}
        });
    }
    fecharConfirmacao(visivel: boolean): void { if (!visivel && !this.excluindo()) this.selecionado = null; }
    excluir(): void {
        if (!this.selecionado || this.excluindo()) return;
        this.excluindo.set(true);
        this.service.excluirLivro(this.selecionado.id, this.selecionado.revisao, this.selecionado.comercial?.revisao).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
            next: () => { this.excluindo.set(false); this.selecionado = null; this.sucesso.set('Livro excluído.'); this.recarregar(); },
            error: e => { this.excluindo.set(false); this.selecionado = null;
                this.erroOperacao.set(e instanceof LojaAdminErro ? e.message : 'Não foi possível confirmar a exclusão. Recarregue antes de repetir.');
                this.recarregar(); }
        });
    }
    classificar(v: boolean | null): string { return v === null ? 'Não informado' : v ? 'Sim' : 'Não'; }
}
