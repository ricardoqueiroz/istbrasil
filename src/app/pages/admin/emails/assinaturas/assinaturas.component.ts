import { CommonModule } from '@angular/common';
import { Component, OnInit, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { EditorModule } from 'primeng/editor';
import { AssinaturasService, EmailAssinaturaServiceError } from './assinaturas.service';
import { EmailAssinatura, EmailAssinaturaPayload } from './assinaturas.model';

@Component({
    selector: 'app-assinaturas',
    standalone: true,
    imports: [CommonModule, FormsModule, EditorModule],
    template: `
        <section class="space-y-6">
            <div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                    <p class="text-sm font-semibold uppercase tracking-widest text-primary">Administração de e-mails</p>
                    <h2 class="mt-2 text-3xl font-bold text-surface-900 dark:text-white">Assinaturas</h2>
                    <p class="mt-2 text-surface-600 dark:text-surface-300">Gerencie assinaturas HTML reutilizáveis para mensagens administrativas.</p>
                </div>
                <button type="button" class="inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-contrast hover:opacity-90" (click)="novaAssinatura()" [disabled]="editando">
                    <i class="pi pi-plus" aria-hidden="true"></i>
                    <span>Nova assinatura</span>
                </button>
            </div>

            <div *ngIf="mensagem" class="rounded-lg border px-4 py-3 text-sm" [ngClass]="{ 'border-red-200 bg-red-50 text-red-700': mensagemTipo === 'error', 'border-green-200 bg-green-50 text-green-700': mensagemTipo === 'success' }">
                {{ mensagem }}
            </div>

            <div *ngIf="carregando" class="rounded-xl border border-surface-200 bg-white p-6 text-surface-600 dark:border-surface-800 dark:bg-surface-900 dark:text-surface-300">Carregando assinaturas...</div>

            <div *ngIf="!carregando && !assinaturas.length && !editando" class="rounded-xl border border-surface-200 bg-white p-8 text-center text-surface-600 dark:border-surface-800 dark:bg-surface-900 dark:text-surface-300">Nenhuma assinatura cadastrada.</div>

            <div *ngIf="!carregando && assinaturas.length && !editando" class="overflow-hidden rounded-xl border border-surface-200 bg-white dark:border-surface-800 dark:bg-surface-900">
                <div class="overflow-x-auto">
                    <table class="w-full min-w-[640px] text-left text-sm">
                        <thead class="border-b border-surface-200 bg-surface-50 text-xs uppercase tracking-wide text-surface-600 dark:border-surface-800 dark:bg-surface-800 dark:text-surface-300">
                            <tr><th class="px-4 py-3 font-semibold">Nome</th><th class="px-4 py-3 font-semibold">Status</th><th class="px-4 py-3 font-semibold">Atualizada em</th><th class="px-4 py-3 text-right font-semibold">Ação</th></tr>
                        </thead>
                        <tbody>
                            <tr *ngFor="let assinatura of assinaturas" class="border-b border-surface-100 last:border-0 dark:border-surface-800">
                                <td class="px-4 py-4 font-medium text-surface-900 dark:text-white">{{ assinatura.nome }}</td>
                                <td class="px-4 py-4"><span class="rounded-full px-2.5 py-1 text-xs font-semibold" [ngClass]="assinatura.ativo ? 'bg-green-100 text-green-700' : 'bg-surface-100 text-surface-600 dark:bg-surface-800 dark:text-surface-300'">{{ assinatura.ativo ? 'Ativa' : 'Inativa' }}</span></td>
                                <td class="px-4 py-4 text-surface-600 dark:text-surface-300">{{ assinatura.dataAtualizacao | date: 'dd/MM/yyyy HH:mm' }}</td>
                                <td class="px-4 py-4 text-right"><button type="button" class="inline-flex items-center gap-2 rounded-lg border border-surface-300 px-3 py-2 text-sm font-medium text-surface-700 hover:bg-surface-50 dark:border-surface-700 dark:text-surface-200 dark:hover:bg-surface-800" (click)="editarAssinatura(assinatura)"><i class="pi pi-pencil" aria-hidden="true"></i><span>Editar</span></button></td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </div>

            <form *ngIf="editando" class="rounded-xl border border-surface-200 bg-white p-6 dark:border-surface-800 dark:bg-surface-900" (ngSubmit)="salvar()" novalidate>
                <div class="flex items-center justify-between border-b border-surface-200 pb-4 dark:border-surface-800"><h3 class="text-xl font-semibold text-surface-900 dark:text-white">{{ assinaturaSelecionada ? 'Editar assinatura' : 'Nova assinatura' }}</h3><span class="text-sm text-surface-500">HTML sanitizado no servidor</span></div>
                <div class="mt-6 grid gap-5">
                    <div><label for="assinaturaNome" class="mb-2 block text-sm font-medium text-surface-700 dark:text-surface-200">Nome</label><input id="assinaturaNome" name="assinaturaNome" type="text" maxlength="150" [(ngModel)]="formulario.nome" class="w-full rounded-lg border border-surface-300 bg-white px-3 py-2.5 outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 dark:border-surface-600 dark:bg-surface-800" required /></div>
                    <div><label for="assinaturaConteudo" class="mb-2 block text-sm font-medium text-surface-700 dark:text-surface-200">Conteúdo</label><p-editor id="assinaturaConteudo" name="assinaturaConteudo" [(ngModel)]="formulario.conteudoHtml" [modules]="editorModules" [style]="{ height: '320px' }" placeholder="Escreva a assinatura do e-mail..."></p-editor></div>
                    <label class="flex items-center gap-3 text-sm font-medium text-surface-700 dark:text-surface-200"><input type="checkbox" name="assinaturaAtiva" [(ngModel)]="formulario.ativo" class="h-4 w-4 accent-primary" /> Assinatura ativa</label>
                </div>
                <div class="mt-6 flex flex-col gap-3 sm:flex-row sm:justify-end"><button type="button" class="rounded-lg border border-surface-300 px-4 py-2.5 text-sm font-semibold text-surface-700 hover:bg-surface-50 dark:border-surface-700 dark:text-surface-200 dark:hover:bg-surface-800" (click)="cancelar()" [disabled]="salvando">Cancelar</button><button type="submit" class="rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-contrast hover:opacity-90" [disabled]="salvando">{{ salvando ? 'Salvando...' : 'Salvar' }}</button></div>
            </form>
        </section>
    `,
    styles: [`
        :host ::ng-deep .p-editor {
            background: var(--p-surface-0);
            color: var(--text-color);
        }

        :host ::ng-deep .p-editor .p-editor-toolbar {
            background: var(--p-surface-50);
            border-color: var(--p-surface-300);
        }

        :host ::ng-deep .p-editor .p-editor-content,
        :host ::ng-deep .p-editor .ql-editor {
            background: var(--p-surface-0);
            color: var(--text-color);
        }

        :host ::ng-deep .p-editor .ql-editor.ql-blank::before {
            color: var(--text-color-secondary);
            font-style: normal;
            opacity: 1;
        }`
        , `#assinaturaNome {
            background: #ffffff;
            color: #1f2937;
        }

        :host-context(.dark) #assinaturaNome {
            background: var(--p-surface-800);
            color: #f8fafc;
        }`
    ]
})
export class AssinaturasComponent implements OnInit {
    private readonly service = inject(AssinaturasService);
    assinaturas: EmailAssinatura[] = [];
    carregando = false;
    salvando = false;
    editando = false;
    assinaturaSelecionada: EmailAssinatura | null = null;
    mensagem: string | null = null;
    mensagemTipo: 'success' | 'error' = 'error';
    formulario: EmailAssinaturaPayload = this.formularioVazio();

    readonly editorModules = {
        toolbar: [
            ['bold', 'italic', 'underline'],
            [{ header: [2, 3, false] }],
            [{ list: 'ordered' }, { list: 'bullet' }],
            [{ align: [] }],
            ['link'],
            ['clean']
        ]
    };

    ngOnInit(): void { void this.carregar(); }

    async carregar(): Promise<void> {
        this.carregando = true;
        try { this.assinaturas = await this.service.listar(); }
        catch (error) { this.mensagemTipo = 'error'; this.mensagem = this.mensagemErro(error); }
        finally { this.carregando = false; }
    }

    novaAssinatura(): void {
        this.assinaturaSelecionada = null;
        this.formulario = this.formularioVazio();
        this.mensagem = null;
        this.editando = true;
    }

    editarAssinatura(assinatura: EmailAssinatura): void {
        this.assinaturaSelecionada = assinatura;
        this.formulario = { nome: assinatura.nome, conteudoHtml: assinatura.conteudoHtml, ativo: assinatura.ativo };
        this.mensagem = null;
        this.editando = true;
    }

    cancelar(): void {
        this.editando = false;
        this.assinaturaSelecionada = null;
        this.mensagem = null;
    }

    async salvar(): Promise<void> {
        if (this.salvando) return;
        const payload: EmailAssinaturaPayload = { nome: this.formulario.nome.trim(), conteudoHtml: this.formulario.conteudoHtml.trim(), ativo: Boolean(this.formulario.ativo) };
        if (!payload.nome || !payload.conteudoHtml) { this.mensagemTipo = 'error'; this.mensagem = 'Informe o nome e o conteúdo da assinatura.'; return; }
        this.salvando = true;
        this.mensagem = null;
        try {
            if (this.assinaturaSelecionada) {
                await this.service.atualizar(this.assinaturaSelecionada.idAssinatura, payload);
                this.mensagem = 'Assinatura atualizada com sucesso.';
            } else {
                await this.service.criar(payload);
                this.mensagem = 'Assinatura criada com sucesso.';
            }
            this.mensagemTipo = 'success';
            this.editando = false;
            this.assinaturaSelecionada = null;
            await this.carregar();
        } catch (error) { this.mensagemTipo = 'error'; this.mensagem = this.mensagemErro(error); }
        finally { this.salvando = false; }
    }

    private formularioVazio(): EmailAssinaturaPayload { return { nome: '', conteudoHtml: '', ativo: true }; }

    private mensagemErro(error: unknown): string {
        if (error instanceof EmailAssinaturaServiceError) {
            if (error.status === 401) return 'Sua sessão expirou. Faça login novamente.';
            if (error.status === 403) return 'Você não tem autorização para administrar assinaturas.';
            return error.message;
        }
        return 'Não foi possível concluir a operação. Tente novamente.';
    }
}
