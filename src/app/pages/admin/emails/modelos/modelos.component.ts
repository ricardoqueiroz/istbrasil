import { CommonModule } from '@angular/common';
import { Component, OnInit, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { EditorModule } from 'primeng/editor';
import { AssinaturasService, EmailAssinaturaServiceError } from '../assinaturas/assinaturas.service';
import { EmailAssinatura } from '../assinaturas/assinaturas.model';
import { EmailModelo, EmailModeloAtualizacaoPayload, EmailModeloPayload } from './modelos.model';
import { EmailPlaceholder, EmailPreviewResultado } from './preview.model';
import { EmailModeloServiceError, ModelosService } from './modelos.service';

@Component({
    selector: 'app-modelos',
    standalone: true,
    imports: [CommonModule, FormsModule, EditorModule],
    template: `
        <section class="space-y-6">
            <div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                    <p class="text-sm font-semibold uppercase tracking-widest text-primary">Administração de e-mails</p>
                    <h2 class="mt-2 text-3xl font-bold text-surface-900 dark:text-white">Modelos</h2>
                    <p class="mt-2 text-surface-600 dark:text-surface-300">Gerencie modelos HTML reutilizáveis para mensagens administrativas.</p>
                </div>
                <button type="button" class="inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-contrast hover:opacity-90" (click)="novoModelo()" [disabled]="editando">
                    <i class="pi pi-plus" aria-hidden="true"></i><span>Novo modelo</span>
                </button>
            </div>

            <div *ngIf="mensagem" class="rounded-lg border px-4 py-3 text-sm" [ngClass]="{ 'border-red-200 bg-red-50 text-red-700': mensagemTipo === 'error', 'border-green-200 bg-green-50 text-green-700': mensagemTipo === 'success' }">{{ mensagem }}</div>
            <div *ngIf="carregando" class="rounded-xl border border-surface-200 bg-white p-6 text-surface-600 dark:border-surface-800 dark:bg-surface-900 dark:text-surface-300">Carregando modelos...</div>

            <div *ngIf="!carregando && !modelos.length && !editando" class="rounded-xl border border-surface-200 bg-white p-8 text-center text-surface-600 dark:border-surface-800 dark:bg-surface-900 dark:text-surface-300">Nenhum modelo cadastrado.</div>
            <div *ngIf="!carregando && modelos.length && !editando" class="overflow-hidden rounded-xl border border-surface-200 bg-white dark:border-surface-800 dark:bg-surface-900">
                <div class="overflow-x-auto">
                    <table class="w-full min-w-[900px] text-left text-sm">
                        <thead class="border-b border-surface-200 bg-surface-50 text-xs uppercase tracking-wide text-surface-600 dark:border-surface-800 dark:bg-surface-800 dark:text-surface-300">
                            <tr><th class="px-4 py-3 font-semibold">Nome</th><th class="px-4 py-3 font-semibold">Chave</th><th class="px-4 py-3 font-semibold">Assunto</th><th class="px-4 py-3 font-semibold">Assinatura</th><th class="px-4 py-3 font-semibold">Status</th><th class="px-4 py-3 font-semibold">Atualização</th><th class="px-4 py-3 text-right font-semibold">Ação</th></tr>
                        </thead>
                        <tbody>
                            <tr *ngFor="let modelo of modelos" class="border-b border-surface-100 last:border-0 dark:border-surface-800">
                                <td class="px-4 py-4 font-medium text-surface-900 dark:text-white">{{ modelo.nome }}</td>
                                <td class="px-4 py-4 font-mono text-xs text-surface-600 dark:text-surface-300">{{ modelo.chave }}</td>
                                <td class="max-w-xs truncate px-4 py-4 text-surface-600 dark:text-surface-300">{{ modelo.assunto }}</td>
                                <td class="px-4 py-4 text-surface-600 dark:text-surface-300">{{ modelo.nomeAssinatura || 'Nenhuma' }}<span *ngIf="modelo.nomeAssinatura && modelo.assinaturaAtiva === false" class="ml-2 text-xs text-orange-600">(inativa)</span></td>
                                <td class="px-4 py-4"><span class="rounded-full px-2.5 py-1 text-xs font-semibold" [ngClass]="modelo.ativo ? 'bg-green-100 text-green-700' : 'bg-surface-100 text-surface-600 dark:bg-surface-800 dark:text-surface-300'">{{ modelo.ativo ? 'Ativo' : 'Inativo' }}</span></td>
                                <td class="px-4 py-4 text-surface-600 dark:text-surface-300">{{ modelo.dataAtualizacao | date: 'dd/MM/yyyy HH:mm' }}</td>
                                <td class="px-4 py-4 text-right"><button type="button" class="inline-flex items-center gap-2 rounded-lg border border-surface-300 px-3 py-2 text-sm font-medium text-surface-700 hover:bg-surface-50 dark:border-surface-700 dark:text-surface-200 dark:hover:bg-surface-800" (click)="editarModelo(modelo)"><i class="pi pi-pencil" aria-hidden="true"></i><span>Editar</span></button></td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </div>

            <form *ngIf="editando" class="rounded-xl border border-surface-200 bg-white p-6 dark:border-surface-800 dark:bg-surface-900" (ngSubmit)="salvar()" novalidate>
                <div class="flex items-center justify-between border-b border-surface-200 pb-4 dark:border-surface-800"><h3 class="text-xl font-semibold text-surface-900 dark:text-white">{{ modeloSelecionado ? 'Editar modelo' : 'Novo modelo' }}</h3><span class="text-sm text-surface-500">HTML sanitizado no servidor</span></div>
                <div class="mt-6 grid gap-5">
                    <div><label for="modeloChave" class="mb-2 block text-sm font-medium text-surface-700 dark:text-surface-200">Chave</label><input id="modeloChave" name="modeloChave" type="text" maxlength="100" [(ngModel)]="formulario.chave" [readonly]="!!modeloSelecionado" class="w-full rounded-lg border border-surface-300 bg-white px-3 py-2.5 font-mono outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 read-only:bg-surface-100 dark:border-surface-600 dark:bg-surface-800 dark:read-only:bg-surface-700" required /></div>
                    <div><label for="modeloNome" class="mb-2 block text-sm font-medium text-surface-700 dark:text-surface-200">Nome</label><input id="modeloNome" name="modeloNome" type="text" maxlength="150" [(ngModel)]="formulario.nome" class="w-full rounded-lg border border-surface-300 bg-white px-3 py-2.5 outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 dark:border-surface-600 dark:bg-surface-800" required /></div>
                    <div><label for="modeloAssunto" class="mb-2 block text-sm font-medium text-surface-700 dark:text-surface-200">Assunto</label><input id="modeloAssunto" name="modeloAssunto" type="text" maxlength="255" [(ngModel)]="formulario.assunto" class="w-full rounded-lg border border-surface-300 bg-white px-3 py-2.5 outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 dark:border-surface-600 dark:bg-surface-800" required /></div>
                    <div><label for="modeloAssinatura" class="mb-2 block text-sm font-medium text-surface-700 dark:text-surface-200">Assinatura</label><select id="modeloAssinatura" name="modeloAssinatura" [(ngModel)]="formulario.idAssinatura" class="w-full rounded-lg border border-surface-300 bg-white px-3 py-2.5 outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 dark:border-surface-600 dark:bg-surface-800"><option [ngValue]="null">Nenhuma</option><option *ngFor="let assinatura of assinaturas" [ngValue]="assinatura.idAssinatura" [disabled]="!assinatura.ativo && assinatura.idAssinatura !== formulario.idAssinatura">{{ assinatura.nome }}{{ assinatura.ativo ? '' : ' (inativa)' }}</option></select></div>
                    <div><label for="modeloConteudo" class="mb-2 block text-sm font-medium text-surface-700 dark:text-surface-200">Conteúdo</label><p-editor id="modeloConteudo" name="modeloConteudo" [(ngModel)]="formulario.conteudoHtml" [modules]="editorModules" [style]="{ height: '320px' }" placeholder="Escreva o conteúdo do e-mail..."></p-editor></div>
                    <label class="flex items-center gap-3 text-sm font-medium text-surface-700 dark:text-surface-200"><input type="checkbox" name="modeloAtivo" [(ngModel)]="formulario.ativo" class="h-4 w-4 accent-primary" /> Modelo ativo</label>
                </div>
                <div class="mt-6 flex flex-col gap-3 sm:flex-row sm:justify-end"><button type="button" class="rounded-lg border border-surface-300 px-4 py-2.5 text-sm font-semibold text-surface-700 hover:bg-surface-50 dark:border-surface-700 dark:text-surface-200 dark:hover:bg-surface-800" (click)="cancelar()" [disabled]="salvando">Cancelar</button><button *ngIf="modeloSelecionado" type="button" class="rounded-lg border border-primary px-4 py-2.5 text-sm font-semibold text-primary hover:bg-primary/10" (click)="abrirPreview()" [disabled]="carregandoPreview">{{ carregandoPreview ? 'Carregando...' : 'Preview' }}</button><button type="submit" class="rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-contrast hover:opacity-90" [disabled]="salvando">{{ salvando ? 'Salvando...' : 'Salvar' }}</button></div>
            </form>

            <section *ngIf="editando && preview" class="rounded-xl border border-surface-200 bg-white p-6 dark:border-surface-800 dark:bg-surface-900">
                <div class="flex items-center justify-between border-b border-surface-200 pb-4 dark:border-surface-800">
                    <h3 class="text-xl font-semibold text-surface-900 dark:text-white">Preview</h3>
                    <button type="button" class="text-sm font-medium text-surface-600 hover:underline dark:text-surface-300" (click)="fecharPreview()">Fechar</button>
                </div>

                <p *ngIf="!preview.campos.length" class="mt-4 text-sm text-surface-600 dark:text-surface-300">Este modelo não utiliza placeholders.</p>
                <div *ngIf="preview.campos.length" class="mt-4 grid gap-4">
                    <div *ngFor="let campo of preview.campos">
                        <label [attr.for]="'preview-' + campo.nome" class="mb-2 block text-sm font-medium text-surface-700 dark:text-surface-200">{{ campo.descricao }} <span class="text-xs text-surface-500">({{ campo.nome }} · {{ campo.tipo }})</span></label>
                        <input [id]="'preview-' + campo.nome" [name]="'preview-' + campo.nome" type="text" [(ngModel)]="preview.valores[campo.nome]" class="w-full rounded-lg border border-surface-300 px-3 py-2.5 outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 dark:border-surface-600" style="background: #ffffff; color: #1f2937" />
                    </div>
                </div>

                <div *ngIf="mensagemPreview" class="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{{ mensagemPreview }}</div>

                <button type="button" class="mt-4 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-contrast hover:opacity-90" (click)="gerarPreview()" [disabled]="gerandoPreview">{{ gerandoPreview ? 'Gerando...' : 'Gerar preview' }}</button>

                <div *ngIf="preview.resultado as resultado" class="mt-6 space-y-4">
                    <div *ngFor="let aviso of resultado.avisos" class="rounded-lg border border-orange-200 bg-orange-50 px-4 py-3 text-sm text-orange-700">{{ aviso.mensagem }}</div>
                    <div><p class="mb-1 text-sm font-semibold text-surface-700 dark:text-surface-200">Assunto</p><p class="preview-assunto">{{ resultado.assunto }}</p></div>
                    <div><p class="mb-1 text-sm font-semibold text-surface-700 dark:text-surface-200">Texto</p><pre class="preview-bloco text-sm">{{ resultado.text }}</pre></div>
                    <div><p class="mb-1 text-sm font-semibold text-surface-700 dark:text-surface-200">HTML final (código)</p><pre class="preview-bloco text-xs">{{ resultado.html }}</pre></div>
                </div>
            </section>
        </section>
    `,
    styles: [`
        :host ::ng-deep .p-editor { background: var(--p-surface-0); color: var(--text-color); }
        :host ::ng-deep .p-editor .p-editor-toolbar { background: var(--p-surface-50); border-color: var(--p-surface-300); }
        :host ::ng-deep .p-editor .p-editor-content, :host ::ng-deep .p-editor .ql-editor { background: var(--p-surface-0); color: var(--text-color); }
        :host ::ng-deep .p-editor .ql-editor.ql-blank::before { color: var(--text-color-secondary); font-style: normal; opacity: 1; }
        #modeloChave, #modeloNome, #modeloAssunto { background: #ffffff; color: #1f2937; }
        :host-context(.dark) #modeloChave, :host-context(.dark) #modeloNome, :host-context(.dark) #modeloAssunto { background: var(--p-surface-800); color: #f8fafc; }
        #modeloAssinatura { background: #ffffff; color: #1f2937; }
        #modeloAssinatura option { background: #ffffff; color: #1f2937; }
        :host-context(.dark) #modeloAssinatura { background: var(--p-surface-800); color: #f8fafc; }
        :host-context(.dark) #modeloAssinatura option { background: var(--p-surface-800); color: #f8fafc; }
        .preview-assunto { color: #1f2937; }
        .preview-bloco {
            background: #f1f5f9;
            color: #1f2937;
            border-radius: 0.5rem;
            padding: 1rem;
            white-space: pre-wrap;
            word-break: break-word;
            overflow-wrap: anywhere;
            overflow-x: auto;
        }
        :host-context(.dark) .preview-assunto { color: #f8fafc; }
        :host-context(.dark) .preview-bloco { background: var(--p-surface-800); color: #f8fafc; }
    `]
})
export class ModelosComponent implements OnInit {
    private readonly service = inject(ModelosService);
    private readonly assinaturasService = inject(AssinaturasService);
    modelos: EmailModelo[] = [];
    assinaturas: EmailAssinatura[] = [];
    carregando = false;
    salvando = false;
    editando = false;
    modeloSelecionado: EmailModelo | null = null;
    mensagem: string | null = null;
    mensagemTipo: 'success' | 'error' = 'error';
    formulario: EmailModeloPayload = this.formularioVazio();
    preview: { campos: EmailPlaceholder[]; valores: Record<string, string>; resultado: EmailPreviewResultado | null } | null = null;
    carregandoPreview = false;
    gerandoPreview = false;
    mensagemPreview: string | null = null;

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
        try {
            [this.modelos, this.assinaturas] = await Promise.all([this.service.listar(), this.assinaturasService.listar()]);
        } catch (error) {
            this.mensagemTipo = 'error';
            this.mensagem = this.mensagemErro(error);
        } finally { this.carregando = false; }
    }

    novoModelo(): void {
        this.modeloSelecionado = null;
        this.formulario = this.formularioVazio();
        this.mensagem = null;
        this.editando = true;
        this.fecharPreview();
    }

    editarModelo(modelo: EmailModelo): void {
        this.modeloSelecionado = modelo;
        this.formulario = { chave: modelo.chave, nome: modelo.nome, assunto: modelo.assunto, conteudoHtml: modelo.conteudoHtml, idAssinatura: modelo.idAssinatura, ativo: modelo.ativo };
        this.mensagem = null;
        this.editando = true;
        this.fecharPreview();
    }

    cancelar(): void {
        this.editando = false;
        this.modeloSelecionado = null;
        this.mensagem = null;
        this.fecharPreview();
    }

    fecharPreview(): void {
        this.preview = null;
        this.mensagemPreview = null;
    }

    async abrirPreview(): Promise<void> {
        if (!this.modeloSelecionado || this.carregandoPreview) return;
        this.carregandoPreview = true;
        this.mensagemPreview = null;
        try {
            const metadados = await this.service.obterPlaceholders(this.modeloSelecionado.idModelo);
            const valores: Record<string, string> = {};
            for (const campo of metadados.placeholders) {
                valores[campo.nome] = '';
            }
            this.preview = { campos: metadados.placeholders, valores, resultado: null };
        } catch (error) {
            this.preview = { campos: [], valores: {}, resultado: null };
            this.mensagemPreview = this.mensagemErro(error);
        } finally {
            this.carregandoPreview = false;
        }
    }

    async gerarPreview(): Promise<void> {
        if (!this.modeloSelecionado || !this.preview || this.gerandoPreview) return;
        this.gerandoPreview = true;
        this.mensagemPreview = null;
        try {
            const resultado = await this.service.gerarPreview(this.modeloSelecionado.idModelo, this.preview.valores);
            this.preview = { ...this.preview, resultado };
        } catch (error) {
            this.preview = { ...this.preview, resultado: null };
            this.mensagemPreview = this.mensagemErro(error);
        } finally {
            this.gerandoPreview = false;
        }
    }

    async salvar(): Promise<void> {
        if (this.salvando) return;
        const formulario = {
            chave: this.formulario.chave.trim().toLowerCase(),
            nome: this.formulario.nome.trim(),
            assunto: this.formulario.assunto.trim(),
            conteudoHtml: this.formulario.conteudoHtml.trim(),
            idAssinatura: this.formulario.idAssinatura,
            ativo: Boolean(this.formulario.ativo)
        };
        if ((!this.modeloSelecionado && !formulario.chave) || !formulario.nome || !formulario.assunto || !formulario.conteudoHtml) {
            this.mensagemTipo = 'error';
            this.mensagem = 'Informe a chave, o nome, o assunto e o conteúdo do modelo.';
            return;
        }
        this.salvando = true;
        this.mensagem = null;
        try {
            if (this.modeloSelecionado) {
                const payload: EmailModeloAtualizacaoPayload = { nome: formulario.nome, assunto: formulario.assunto, conteudoHtml: formulario.conteudoHtml, idAssinatura: formulario.idAssinatura, ativo: formulario.ativo };
                await this.service.atualizar(this.modeloSelecionado.idModelo, payload);
                this.mensagem = 'Modelo atualizado com sucesso.';
            } else {
                await this.service.criar(formulario);
                this.mensagem = 'Modelo criado com sucesso.';
            }
            this.mensagemTipo = 'success';
            this.editando = false;
            this.modeloSelecionado = null;
            await this.carregar();
        } catch (error) {
            this.mensagemTipo = 'error';
            this.mensagem = this.mensagemErro(error);
        } finally { this.salvando = false; }
    }

    private formularioVazio(): EmailModeloPayload { return { chave: '', nome: '', assunto: '', conteudoHtml: '', idAssinatura: null, ativo: true }; }

    private mensagemErro(error: unknown): string {
        if (error instanceof EmailModeloServiceError || error instanceof EmailAssinaturaServiceError) {
            if (error.status === 401) return 'Sua sessão expirou. Faça login novamente.';
            if (error.status === 403) return 'Você não tem autorização para administrar modelos.';
            return error.message;
        }
        return 'Não foi possível concluir a operação. Tente novamente.';
    }
}
