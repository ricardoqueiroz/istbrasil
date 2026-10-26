import {MessageModule} from 'primeng/message';
import { Component, DestroyRef, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { SelectModule } from 'primeng/select';
import { SelectButtonModule } from 'primeng/selectbutton';
import { LivroAdmin, LivroAdminAlteracoes, LivroAdminCriacao, CategoriaLivroOpcao, VersaoPdfAdmin } from '../loja-admin.model';
import { LojaAdminErro, LojaAdminService } from '../loja-admin.service';

type Campo = 'author' | 'title' | 'language' | 'category' | 'img' | 'pertenceEditoraIst' | 'sku' | 'format' | 'price' | 'onsale' | 'inventory';
type Valores = Pick<LivroAdmin, Campo>;

@Component({
    selector: 'app-admin-formulario-livro', standalone: true,
    imports: [MessageModule, FormsModule, RouterLink, ButtonModule, InputTextModule, SelectModule, SelectButtonModule],
    styles: [`
        .livro-painel { background: #fff; color: #0f172a; border: 1px solid #e2e8f0; border-radius: 1.5rem; padding: 1.5rem; }
        .livro-campos { width: 100%; }
        .livro-campos label { display: block; color: #334155; font-weight: 600; margin-bottom: .5rem; }
        .livro-campos input[pInputText], .livro-campos p-select { width: 100%; }
        .livro-campos fieldset > div { margin-bottom: 1.5rem; }
        .livro-campos .ajuda { color: #475569; font-size: .875rem; margin-top: .5rem; }
        .capa-preview { width: 186px; height: 260px; object-fit: contain; background: #f8fafc; border: 1px solid #cbd5e1; border-radius: .75rem; }
        @media (min-width: 1024px) { .livro-campos { width: 80%; } .livro-painel { padding: 2.5rem; } }
    `],
    template: `
        <section class="livro-painel space-y-5 shadow-xl">
            <header class="flex flex-wrap items-center justify-between gap-4">
                <h2 class="text-2xl font-semibold">{{ id === null ? 'Novo livro' : 'Editar livro #' + id }}</h2>
                <a pButton routerLink="/admin/loja/livros" [class.pointer-events-none]="ocupado()"><i class="pi pi-arrow-left" aria-hidden="true"></i> Voltar à listagem</a>
            </header>
            <p>Dados do livro e produto associado. O PDF enviado permanece em rascunho; a venda não é ativada automaticamente.</p>
            @if (carregando()) { <p role="status">Carregando livro...</p> }
            @if (erro() && !pronto()) { <p-message severity="error" role="alert">{{ erro() }}</p-message><button pButton type="button" label="Recarregar livro" (click)="carregar()" [disabled]="carregando()"></button> }
            @if (pronto()) {
                <form #form="ngForm" (submit)="$event.preventDefault(); salvar()" class="livro-campos space-y-6">
                    <fieldset [disabled]="ocupado() || bloqueado()" class="space-y-4">
                        <div><label for="livroTitle" class="block">Título</label>
                            <input id="livroTitle" name="title" pInputText [ngModel]="valores.title"
                                (ngModelChange)="mudar('title', $event)" maxlength="255" /></div>
                        <div><label for="authorName">Autor</label>
                            <input id="authorName" name="author" pInputText maxlength="100" [ngModel]="valores.author"
                                (ngModelChange)="mudar('author', $event)" /></div>
                        <div><label for="livroLanguage">Idioma:</label>
                            <p-select inputId="livroLanguage" name="language" [options]="opcoesIdiomas"
                                optionLabel="label" optionValue="value" optionDisabled="disabled" styleClass="w-full"
                                [disabled]="ocupado() || bloqueado()"
                                [ngModel]="valores.language" (ngModelChange)="mudar('language', $event)" />
                        </div>
                        <div><label for="livroCategory" class="block">Categoria</label>
                            <p-select inputId="livroCategory" name="category" [options]="opcoesCategorias"
                                optionLabel="label" optionValue="id" optionDisabled="disabled" styleClass="w-full"
                                [disabled]="ocupado() || bloqueado()"
                                [ngModel]="categoriaSelecionada" (ngModelChange)="selecionarCategoria($event)"
                                [loading]="carregandoCategorias()" />
                            @if (erroCategorias()) { <p role="alert">{{ erroCategorias() }}</p>
                                <button pButton type="button" label="Recarregar categorias" (click)="carregarCategorias()"></button> }
                        </div>
                        <div><label for="livroSku">SKU</label>
                            <input id="livroSku" name="sku" pInputText maxlength="50" [ngModel]="valores.sku" (ngModelChange)="mudar('sku', $event)" /></div>
                        <div><label id="livroFormatLabel">Formato</label>
                            <p-selectbutton ariaLabelledBy="livroFormatLabel" name="format" [options]="formatos" [allowEmpty]="false"
                                [ngModel]="valores.format" (ngModelChange)="mudar('format', $event)"
                                [disabled]="ocupado() || bloqueado() || original?.produtoId != null" />
                            @if (original?.produtoId != null) { <p class="ajuda">O formato não pode mudar enquanto houver produto associado, inclusive inativo.</p> }
                        </div>
                        <div class="space-y-4 border-t border-surface-200 pt-4">
                            <h3 class="text-lg font-semibold">Descrição bibliográfica</h3>
                            @if (descricaoLegada !== null) {
                                <p class="ajuda">Descrição legada preservada. A conversão exige confirmação e mantém o conteúdo original no JSON.</p>
                                <pre class="whitespace-pre-wrap break-words text-sm">{{ descricaoLegada }}</pre>
                                <label><input type="checkbox" name="converterDescricao" [ngModel]="converterDescricao"
                                    (ngModelChange)="confirmarConversao($event)" /> Confirmo a conversão para descrição estruturada</label>
                            }
                            <div><label for="desc-01">Título</label><input id="desc-01" pInputText [value]="valores.title ?? ''" readonly /></div>
                            <div><label for="desc-author">Autor</label><input id="desc-author" name="desc-author" pInputText [value]="valores.author ?? ''" disabled /></div>
                            @for (campo of camposDescricao; track campo.id) {
                                @if (campo.id === 'desc-08') {
                                    <div><label for="desc-07">Idioma</label><input id="desc-07" pInputText [value]="valores.language ?? ''" readonly /></div>
                                }
                                <div><label [for]="campo.id">{{ campo.chave }}</label>
                                    <input pInputText [id]="campo.id" [name]="campo.id" [maxlength]="campo.max"
                                        [attr.inputmode]="campo.numerico ? 'numeric' : 'text'"
                                        [ngModel]="descricao[campo.chave]" (ngModelChange)="mudarDescricao(campo.chave, $event)"
                                        [disabled]="descricaoLegada !== null && !converterDescricao" /></div>
                            }
                            <div><label for="desc-10">ISBN-13</label><input id="desc-10" name="isbn13" pInputText maxlength="14" inputmode="numeric"
                                [ngModel]="isbn13Apresentado" (ngModelChange)="mudarIsbn13($event)"
                                [disabled]="descricaoLegada !== null && !converterDescricao" /></div>
                        </div>
                        <div><label for="livroImg">Imagem Capa (min: 186 x 260 px)</label>
                            <div class="flex flex-wrap items-start gap-5 rounded-xl border border-surface-200 bg-surface-50 p-4">
                                @if (capaAtual()) { <img class="capa-preview" [src]="capaAtual()" alt="Capa do livro" /> }
                                @else { <div class="capa-preview flex items-center justify-center">Sem capa exibível</div> }
                                <div class="space-y-3">
                                    <input #capaInput id="livroImg" type="file" accept="image/jpeg,image/png,image/webp"
                                        (change)="selecionarCapa($event)" class="hidden" />
                                    <p class="ajuda">JPEG, PNG ou WebP, até 5 MiB. Clique em Enviar capa para selecionar e enviar antes de salvar.</p>
                                    <div class="flex flex-wrap gap-3"><button pButton type="button" icon="pi pi-upload" label="Enviar capa" [disabled]="ocupado() || bloqueado()"
                                        (click)="capaInput.click()"></button>
                                    <button pButton type="button" label="Remover" (click)="limparImagem()"></button></div>
                                    <p class="ajuda">Capas anteriores não são excluídas. Imagens legadas são preservadas sem alteração explícita.</p>
                                </div>
                            </div>
                            @if (enviandoCapa() || validandoCapa()) { <p role="status">Validando ou enviando capa...</p> }
                            @if (avisoCapa()) { <p-message severity="info" role="status">{{ avisoCapa() }}</p-message> }
                        </div>
                        @if (valores.format === 'E-Book') {
                            <div class="space-y-3 border-t border-surface-200 pt-4">
                                <h3 class="text-lg font-semibold">PDF do E-Book</h3>
                                <input #pdfInput type="file" accept="application/pdf,.pdf" class="hidden" (change)="selecionarPdf($event)" />
                                <button pButton type="button" label="Enviar arquivo PDF" icon="pi pi-upload"
                                    [disabled]="ocupado() || bloqueado() || podeEnviarPdf() && !podeEnviarNovoPdf()" (click)="solicitarPdf(pdfInput)"></button>
                                @if (podeEnviarPdf() && estadoPdf() === 'CARREGANDO') { <p>Confirmando versoes do produto. Envio bloqueado ate a consulta concluir.</p> }
                                @if (podeEnviarPdf() && estadoPdf() === 'ERRO') {
                                    <p-message severity="error" role="alert">{{ erroConsultaPdf() }}</p-message>
                                    <button pButton type="button" label="Tentar consultar versoes novamente" (click)="atualizarVersoesPdf()" [disabled]="ocupado()"></button>
                                }
                                @for (versao of versoesPdf(); track versao.versaoPublicId) { <p>Versão {{versao.numeroVersao}} — {{versao.estado}}</p> }
                                @if (estadoPdf() === 'SEM_RASCUNHO' && !versoesPdf().length) { <p>Sem PDF.</p> }
                                @if (rascunhosPdf().length) { <p>Ja existe PDF em RASCUNHO. Novo envio bloqueado. Substituicao e descarte nao estao disponiveis.</p> }
                                @if (!podeEnviarPdf()) { <p>Salve primeiro o livro e seu produto DIGITAL para enviar o PDF.</p> }
                                @if (arquivoPdf) { <button pButton type="button" label="Confirmar envio como rascunho" (click)="enviarPdf()" [disabled]="ocupado() || bloqueado() || !podeEnviarNovoPdf()"></button> }
                                @if (avisoPdf()) { <p-message severity="info" role="status">{{ avisoPdf() }}</p-message> }
                            </div>
                        }
                        <div><label for="livroPrice">Preço (R$)</label>
                            <input id="livroPrice" name="price" pInputText inputmode="decimal" maxlength="6" placeholder="Não informado"
                                [ngModel]="precoApresentado" (ngModelChange)="mudarPreco($event)" (blur)="formatarPreco()" />
                            <p class="ajuda">Máximo R$ 999,99. Compartilhado com o produto comercial.</p></div>
                        <div><label id="livroOnsaleLabel">Disponível (legado)</label>
                            <p-selectbutton ariaLabelledBy="livroOnsaleLabel" name="onsale" [options]="disponibilidades" optionLabel="label" optionValue="value"
                                [allowEmpty]="false" [ngModel]="valores.onsale" (ngModelChange)="mudar('onsale', $event)" [disabled]="ocupado() || bloqueado()" /></div>
                        <div><label for="livroInventory">Inventário (legado)</label>
                            <p-select inputId="livroInventory" name="inventory" [options]="inventarios" [ngModel]="valores.inventory"
                                (ngModelChange)="mudar('inventory', $event)" [disabled]="ocupado() || bloqueado()" styleClass="w-full" />
                            <p class="ajuda">Inventário sincroniza a disponibilidade; a venda depende da situação comercial e da publicação.</p></div>
                        @if (original?.comercial) {
                            <div><label for="situacaoComercial">Situação comercial</label>
                                <p-select inputId="situacaoComercial" name="situacaoComercial" [options]="situacoesComerciais" optionLabel="label" optionValue="value"
                                    [(ngModel)]="emVenda" [disabled]="ocupado() || bloqueado()" />
                                @if (emVenda === true && elegivelCompra() === false) {
                                    <p-message severity="warn">Em venda, mas ainda não elegível para compra segundo o backend. Confira publicação e condições comerciais.</p-message>
                                }
                                @if (emVenda === true && elegivelCompra() === null) { <p>Elegibilidade não confirmada. Salve e recarregue para conferir.</p> }
                            </div>
                        }
                        <div><label id="livroEditoraLabel" class="block">Pertence à Editora IST</label>
                            <p-selectbutton ariaLabelledBy="livroEditoraLabel" name="pertenceEditoraIst" [options]="classificacoes" [allowEmpty]="true"
                                [disabled]="ocupado() || bloqueado()"
                                optionLabel="label" optionValue="value" [ngModel]="valores.pertenceEditoraIst"
                                (ngModelChange)="mudar('pertenceEditoraIst', $event)" /></div>
                        @if (id === null) {
                            <p>O cadastro cria o produto associado, fora de venda. Preencha categoria, SKU e preço.</p>
                        }
                    </fieldset>
                    @if (erro()) { <p-message severity="error" role="alert">{{ erro() }}</p-message> }
                    <div class="flex gap-3">
                        <p-button type="submit" label="Salvar" icon="pi pi-save" iconPos="left" [loading]="salvando()"
                            [disabled]="ocupado() || bloqueado() || !!arquivoCapa"></p-button>
                        @if (bloqueado()) { <button pButton type="button" label="Recarregar registro" (click)="carregar()"></button> }
                    </div>
                </form>
            } @else if (!carregando()) { <a routerLink="/admin/loja/livros">Voltar à listagem</a> }
            @if (salvando()) { <p role="status">Aguardando confirmação da gravação...</p> }
        </section>`
})
export class FormularioLivroComponent {
    private readonly service = inject(LojaAdminService);
    private readonly router = inject(Router);
    private readonly route = inject(ActivatedRoute);
    private readonly destroyRef = inject(DestroyRef);
    readonly id = this.route.snapshot.paramMap.has('id') ? Number(this.route.snapshot.paramMap.get('id')) : null;
    readonly carregando = signal(false);
    readonly salvando = signal(false);
    readonly bloqueado = signal(false);
    readonly pronto = signal(false);
    readonly erro = signal<string | null>(null);
    readonly classificacoes = [{ label: 'Sim', value: true }, { label: 'Não', value: false }];
    readonly enviandoCapa = signal(false);
    readonly validandoCapa = signal(false);
    readonly preview = signal<string | null>(null);
    readonly avisoCapa = signal<string | null>(null);
    readonly carregandoCategorias = signal(false);
    readonly erroCategorias = signal<string | null>(null);
    arquivoCapa: File | null = null;
    private geracaoCapa = 0;
    private urlEmValidacao: string | null = null;
    private categorias: CategoriaLivroOpcao[] = [];

    opcoesCategorias: { id: number | string; nome: string; label: string; disabled?: boolean }[] = [];
    categoriaSelecionada: number | string | null = null;
    private categoriaAlterada = false;
    private readonly idiomas = [
        { value: 'pt-BR', label: 'Português (Brasil)' }, { value: 'pt-PT', label: 'Português (Portugal)' },
        { value: 'en', label: 'Inglês (geral)' }, { value: 'en-US', label: 'Inglês (Estados Unidos)' },
        { value: 'en-GB', label: 'Inglês (Reino Unido)' }, { value: 'es', label: 'Espanhol (geral)' },
        { value: 'es-419', label: 'Espanhol (América Latina)' },
        { value: 'fr', label: 'Francês' }, { value: 'fr-CA', label: 'Francês (Canadá)' },
        { value: 'de', label: 'Alemão' }, { value: 'it', label: 'Italiano' }, { value: 'ja', label: 'Japonês' }
    ];
    get opcoesIdiomas(): { value: string | null; label: string; disabled?: boolean }[] {
        const atual = this.valores.language;
        return [{ value: null, label: 'Não informado' }, ...this.idiomas,
            ...(atual !== null && !this.idiomas.some(i => i.value === atual) ? [{ value: atual, label: `Valor existente: ${atual}` }] : [])];
    }
    readonly formatos: LivroAdminCriacao['format'][] = ['E-Book', 'Livro Físico'];
    readonly inventarios = ['Em estoque', 'Poucas unidades', 'Esgotado'];
    readonly disponibilidades = [{ label: 'Sim', value: 1 }, { label: 'Não', value: 0 }];
    readonly situacoesComerciais = [{label:'Em venda',value:true},{label:'Fora de venda',value:false}];
    emVenda: boolean | null = null;
    readonly elegivelCompra = signal<boolean | null>(null);
    readonly enviandoPdf = signal(false);
    readonly avisoPdf = signal<string | null>(null);
    readonly versoesPdf = signal<VersaoPdfAdmin[]>([]);
    readonly estadoPdf = signal<'CARREGANDO'|'SEM_RASCUNHO'|'COM_RASCUNHO'|'ERRO'>('CARREGANDO');
    readonly erroConsultaPdf = signal<string | null>(null);
    private geracaoPdf=0;
    rascunhosPdf(): VersaoPdfAdmin[] {return this.versoesPdf().filter(v=>v.estado==='RASCUNHO');}
    podeEnviarNovoPdf(): boolean {return this.podeEnviarPdf() && this.estadoPdf()==='SEM_RASCUNHO';}
    private receberVersoesPdf(livro: LivroAdmin): void {
        if(!Array.isArray(livro.versoesPdf)) {
            this.estadoPdf.set('ERRO');this.erroConsultaPdf.set('As versoes nao foram informadas. Atualize o backend e tente novamente.');return;
        }
        this.versoesPdf.set(livro.versoesPdf);this.erroConsultaPdf.set(null);
        this.estadoPdf.set(this.rascunhosPdf().length?'COM_RASCUNHO':'SEM_RASCUNHO');
    }
    atualizarVersoesPdf(): void {
        if(this.id===null || this.ocupado() || this.estadoPdf()==='CARREGANDO')return;
        const geracao=++this.geracaoPdf;
        this.estadoPdf.set('CARREGANDO');this.erroConsultaPdf.set(null);
        this.service.obterLivro(this.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
            next: livro=>{if(geracao===this.geracaoPdf)this.receberVersoesPdf(livro);},
            error: e=>{if(geracao===this.geracaoPdf){this.estadoPdf.set('ERRO');this.erroConsultaPdf.set(e instanceof LojaAdminErro?e.message:'Nao foi possivel consultar as versoes. Tente novamente.');}}
        });
    }
    arquivoPdf: File | null = null;
    precoApresentado = '';
    private precoInvalido = false;
    descricao: Record<string, string> = {};
    descricaoLegada: string | null = null;
    converterDescricao = false;
    private descricaoAlterada = false;
    private descricaoExtras: Record<string, unknown> = {};
    isbn13Apresentado = '';
    readonly camposDescricao = [
        { id: 'desc-02', chave: 'Conteúdo', max: 50, numerico: false },
        { id: 'desc-03', chave: 'Formato', max: 50, numerico: false },
        { id: 'desc-04', chave: 'Dimensões (cm)', max: 50, numerico: false },
        { id: 'desc-05', chave: 'Dimensões (pol)', max: 50, numerico: false },
        { id: 'desc-06', chave: 'Editor', max: 50, numerico: false },
        { id: 'desc-08', chave: 'Prefixo Ed.', max: 8, numerico: true },
        { id: 'desc-09', chave: 'ISBN-10', max: 10, numerico: true }
    ];
    private readonly aliases: Record<string, string[]> = {
        'Título': ['Title'], 'Conteúdo': ['Content'], 'Formato': ['Format'],
        'Dimensões (cm)': ['Dimension (cm)', 'Dimensions (cm)'],
        'Dimensões (pol)': ['Dimension (in)', 'Dimensions (in)'],
        'Editor': ['Publisher'], 'Idioma': ['Language'], 'Prefixo Ed.': ['Ed.Prefix'], 'ISBN-10': [], 'ISBN-13': []
    };
    original: LivroAdmin | null = null;
    valores: Valores = { author: null, title: null, language: null, category: null, img: null, pertenceEditoraIst: null,
        sku: null, format: 'E-Book', price: null, onsale: 1, inventory: 'Em estoque' };
    private readonly tocados = new Set<Campo>();
    private removerImagem = false;
    constructor() {
        this.prepararDescricao(null);
        this.carregar(); this.carregarCategorias();
        this.destroyRef.onDestroy(() => { this.geracaoCapa++; this.descartarPreview(); });
    }
    ocupado(): boolean { return this.salvando() || this.enviandoCapa() || this.validandoCapa() || this.enviandoPdf(); }
    podeEnviarPdf(): boolean { return this.id !== null && this.original?.format === 'E-Book'
        && this.valores.format === 'E-Book' && this.original.produtoTipo === 'DIGITAL' && this.original.produtoId !== null; }
    selecionarPdf(event: Event): void {
        const input = event.target as HTMLInputElement, arquivo = input.files?.[0]; input.value = '';
        if (!arquivo || !this.podeEnviarNovoPdf() || this.ocupado() || this.bloqueado()) return;
        this.arquivoPdf = null;
        if (arquivo.size < 8 || arquivo.size > 32 * 1024 * 1024 || arquivo.type !== 'application/pdf') {
            this.avisoPdf.set('Selecione um PDF de até 32 MiB.'); return;
        }
        this.arquivoPdf = arquivo; this.avisoPdf.set('PDF selecionado; aguardando envio como rascunho.');
    }
    enviarPdf(): void {
        if (!this.podeEnviarNovoPdf() || !this.arquivoPdf || this.ocupado() || this.bloqueado()) return;
        this.enviandoPdf.set(true);
        this.service.enviarPdf(this.id!, this.arquivoPdf, this.original!.revisao).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
            next: item => { this.enviandoPdf.set(false); this.arquivoPdf = null;
                this.versoesPdf.update(v=>[...v,item]);this.atualizarVersoesPdf();
                this.avisoPdf.set(`Versão ${item.numeroVersao}: ${item.estado}. Novo envio bloqueado enquanto houver rascunho.`); },
            error: e => { this.enviandoPdf.set(false); this.arquivoPdf = null;
                this.avisoPdf.set(e instanceof LojaAdminErro ? e.message : 'Não foi possível confirmar o rascunho. Confira antes de reenviar.');
                this.atualizarVersoesPdf(); }
        });
    }
    private prepararDescricao(texto: string | null): void {
        this.descricaoExtras = {}; this.descricaoLegada = null; this.converterDescricao = false; this.descricaoAlterada = false;
        if (texto) {
            try {
                const obj: unknown = JSON.parse(texto);
                if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) throw Error();
                this.descricaoExtras = Object.fromEntries(Object.entries(obj));
            } catch { this.descricaoLegada = texto; }
        }
        this.descricao = {};
        for (const [chave, aliases] of Object.entries(this.aliases)) {
            const nome = [chave, ...aliases].find(k => Object.hasOwn(this.descricaoExtras, k));
            const valor = nome === undefined ? '' : this.descricaoExtras[nome];
            this.descricao[chave] = typeof valor === 'string' || typeof valor === 'number' ? String(valor) : '';
        }
        this.descricao['ISBN-13'] = this.descricao['ISBN-13'].replace(/-/g, '');
        this.isbn13Apresentado = this.apresentarIsbn13(this.descricao['ISBN-13']);
    }
    confirmarConversao(valor: boolean): void { this.converterDescricao = valor; this.descricaoAlterada = valor; }
    mudarDescricao(chave: string, valor: string): void { this.descricao[chave] = valor; this.descricaoAlterada = true; }
    private apresentarIsbn13(valor: string): string { return valor.length > 3 ? valor.slice(0, 3) + '-' + valor.slice(3) : valor; }
    mudarIsbn13(valor: string): void {
        const digitos = valor.replace(/-/g, '');
        this.descricao['ISBN-13'] = digitos; this.isbn13Apresentado = this.apresentarIsbn13(digitos); this.descricaoAlterada = true;
    }
    private serializarDescricao(): string {
        const valores = { ...this.descricao, 'Autor:': this.valores.author ?? '', 'Título': this.valores.title ?? '', 'Idioma': this.valores.language ?? '' };
        const extras = { ...this.descricaoExtras };
        delete extras['Autor'];delete extras['Autor:'];delete extras['Author'];delete extras['Author:'];
        for (const [chave, aliases] of Object.entries(this.aliases)) {
            for (const alias of aliases) {
                // Remove an alias only when it duplicates the selected known value.
                // Conflicting aliases remain preserved as additional information.
                if (extras[alias] === this.descricao[chave]) delete extras[alias];
            }
        }
        if (this.descricaoLegada !== null) extras['Descrição legada original'] = this.descricaoLegada;
        return JSON.stringify({ ...extras, ...valores });
    }
    mudarPreco(valor: string): void {
        this.precoApresentado = valor; this.tocados.add('price');
        this.precoInvalido = valor !== '' && !/^\d{1,3}(?:,\d{0,2})?$/.test(valor);
        if (this.precoInvalido) return;
        if (!valor) { this.valores.price = null; return; }
        const [reais, fracao = ''] = valor.split(',');
        const centavos = BigInt(reais) * 100n + BigInt(fracao.padEnd(2, '0'));
        this.valores.price = `${centavos / 100n}.${String(centavos % 100n).padStart(2, '0')}`;
    }
    formatarPreco(): void { if (!this.precoInvalido) this.precoApresentado = this.valores.price?.replace('.', ',') ?? ''; }
    private descartarPreview(): void {
        const url = this.preview(); if (url) URL.revokeObjectURL(url);
        if (this.urlEmValidacao) URL.revokeObjectURL(this.urlEmValidacao);
        this.urlEmValidacao = null;
        this.preview.set(null); this.arquivoCapa = null;
    }
    capaAtual(): string | null { return this.preview() ?? (this.valores.img ? '/' + this.valores.img.replace(/^\//, '') : null); }
    carregarCategorias(): void {
        if (this.carregandoCategorias()) return;
        this.carregandoCategorias.set(true); this.erroCategorias.set(null);
        this.service.listarCategorias().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
            next: itens => { this.categorias = itens; this.atualizarCategorias(); this.carregandoCategorias.set(false); },
            error: e => { this.carregandoCategorias.set(false); this.erroCategorias.set(e instanceof LojaAdminErro?e.message:'Nao foi possivel carregar as categorias. O valor existente sera preservado.'); }
        });
    }
    private atualizarCategorias(): void {
        this.opcoesCategorias = this.categorias.map(c => {
            const nomes: string[] = []; const vistos = new Set<number>(); let atual: CategoriaLivroOpcao | undefined = c; let ativa = true;
            while(atual) {
                if(vistos.has(atual.id)) {ativa=false;break;} vistos.add(atual.id);nomes.unshift(atual.nome);ativa=ativa&&atual.ativo;
                if(atual.categoriaPaiId === null)break;
                const pai: number = atual.categoriaPaiId;atual=this.categorias.find(x=>x.id===pai);if(!atual)ativa=false;
            }
            return {...c,label:nomes.join(' / '),disabled:!ativa || [...c.nome].length>50};
        });
        if(this.categoriaAlterada)return;
        const produtoId=this.original?.comercial?.categoriaId;
        if(produtoId != null) {this.categoriaSelecionada=produtoId;return;}
        const candidatos=this.categorias.filter(c=>c.nome===this.valores.category);
        this.categoriaSelecionada=candidatos.length===1?candidatos[0].id:null;
        if(this.valores.category != null && candidatos.length!==1)
            this.opcoesCategorias.push({id:'legada',nome:this.valores.category,label:'Valor legado: '+this.valores.category,disabled:true});
    }
    selecionarCategoria(id: number | string): void {
        const item=this.opcoesCategorias.find(c=>c.id===id);
        if(!item||item.disabled||typeof id!=='number')return;
        this.categoriaSelecionada=id;this.categoriaAlterada=true;
    }
    solicitarPdf(input: HTMLInputElement): void {
        if(!this.podeEnviarPdf()) {this.avisoPdf.set('Salve primeiro o livro e seu produto DIGITAL.');return;}
        if(!this.podeEnviarNovoPdf()){this.avisoPdf.set('Novo envio bloqueado: existe rascunho ou as versoes ainda nao foram confirmadas.');return;}
        input.click();
    }
    selecionarCapa(event: Event): void {
        const input = event.target as HTMLInputElement, arquivo = input.files?.[0]; input.value = '';
        if (!arquivo || this.enviandoCapa() || this.salvando() || this.bloqueado()) return;
        const geracao = ++this.geracaoCapa; this.descartarPreview(); this.avisoCapa.set(null);
        if (!['image/jpeg', 'image/png', 'image/webp'].includes(arquivo.type) || !arquivo.size || arquivo.size > 5 * 1024 * 1024) {
            this.avisoCapa.set('Selecione JPEG, PNG ou WebP de até 5 MiB.'); return;
        }
        this.validandoCapa.set(true);
        const url = URL.createObjectURL(arquivo), imagem = new Image();
        this.urlEmValidacao = url;
        imagem.onload = () => {
            if (geracao !== this.geracaoCapa) { URL.revokeObjectURL(url); return; }
            this.urlEmValidacao = null;
            this.validandoCapa.set(false);
            if (imagem.naturalWidth < 186 || imagem.naturalHeight < 260 || imagem.naturalWidth * imagem.naturalHeight > 40_000_000) {
                URL.revokeObjectURL(url); this.avisoCapa.set('A capa precisa ter no mínimo 186 × 260 pixels e no máximo 40 megapixels.'); return;
            }
            this.arquivoCapa = arquivo; this.preview.set(url); this.enviarCapa();
        };
        imagem.onerror = () => { URL.revokeObjectURL(url); if (geracao === this.geracaoCapa) {
            this.urlEmValidacao = null;
            this.validandoCapa.set(false); this.avisoCapa.set('Não foi possível abrir a imagem selecionada.'); } };
        imagem.src = url;
    }
    enviarCapa(): void {
        if (this.ocupado() || this.bloqueado()) return;
        if (!this.arquivoCapa) { this.avisoCapa.set('Selecione uma imagem antes de enviar a capa.'); return; }
        this.enviandoCapa.set(true); this.avisoCapa.set(null);
        this.service.enviarCapa(this.arquivoCapa).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
            next: img => {
                this.mudar('img', img); this.arquivoCapa = null;
                const geracao = this.geracaoCapa, imagem = new Image();
                const timer = setTimeout(() => concluir(false), 10000);
                const concluir = (carregou: boolean) => {
                    clearTimeout(timer); imagem.onload = imagem.onerror = null;
                    if (geracao !== this.geracaoCapa) return;
                    this.enviandoCapa.set(false);
                    if (carregou) this.descartarPreview();
                    this.avisoCapa.set(carregou
                        ? 'Capa enviada. Salve o livro para associar ao registro.'
                        : 'Capa enviada, mas a URL publica nao carregou. A previa local e a referencia enviada foram preservadas; nao e necessario reenviar.');
                };
                imagem.onload = () => concluir(true); imagem.onerror = () => concluir(false);
                imagem.src = '/' + img.replace(/^\//, '');
            },
            error: e => { this.enviandoCapa.set(false); this.avisoCapa.set((e instanceof LojaAdminErro?e.message:'Falha ao enviar a capa.')+' A referencia anterior foi preservada.'); }
        });
    }
    carregar(): void {
        if (this.ocupado()) return;
        this.geracaoCapa++; this.descartarPreview(); this.avisoCapa.set(null);
        this.erro.set(null); this.bloqueado.set(false); this.tocados.clear(); this.removerImagem = false;
        if (this.id === null) { this.pronto.set(true); return; }
        this.pronto.set(false);
        if (!Number.isSafeInteger(this.id) || this.id <= 0) { this.erro.set('Identificador inválido.'); return; }
        this.carregando.set(true);this.estadoPdf.set('CARREGANDO');this.erroConsultaPdf.set(null);++this.geracaoPdf;
        this.service.obterLivro(this.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
            next: livro => {
                this.original = livro;
                this.emVenda=livro.comercial?.emVenda??null;
                this.elegivelCompra.set(null);
                if(livro.produtoId)this.service.obterElegibilidade(livro.produtoId).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
                    next:v=>{if(this.original===livro)this.elegivelCompra.set(v);},error:()=>{if(this.original===livro)this.elegivelCompra.set(null);}});
                this.receberVersoesPdf(livro);
                this.categoriaAlterada=false;
                this.valores = { author: livro.author, title: livro.title, language: livro.language, category: livro.category,
                    img: livro.img, pertenceEditoraIst: livro.pertenceEditoraIst, sku: livro.sku, format: livro.format,
                    price: livro.price, onsale: livro.onsale, inventory: livro.inventory };
                this.precoInvalido = false; this.formatarPreco(); this.prepararDescricao(livro.description);
                this.arquivoPdf = null; this.avisoPdf.set(null);
                this.atualizarCategorias();
                this.carregando.set(false); this.pronto.set(true);
            },
            error: e => { this.carregando.set(false);this.estadoPdf.set('ERRO');this.erroConsultaPdf.set('Falha ao carregar as versoes do livro. Tente novamente.'); this.erro.set(e instanceof LojaAdminErro ? e.message : 'Não foi possível carregar o livro.'); }
        });
    }
    mudar(campo: Campo, valor: string | boolean | number | null): void {
        this.tocados.add(campo);
        if (campo === 'pertenceEditoraIst') this.valores.pertenceEditoraIst = valor as boolean | null;
        else if (campo === 'onsale') this.valores.onsale = valor as number | null;
        else this.valores[campo] = ['language', 'img', 'sku', 'author'].includes(campo) && valor === '' ? null : valor as string | null;
        if (campo === 'img') this.removerImagem = false;
        if (['title', 'language', 'author'].includes(campo) && this.original && (campo === 'author' || this.original.description != null) && this.descricaoLegada === null)
            this.descricaoAlterada = true;
    }
    limparImagem(): void { this.geracaoCapa++; this.descartarPreview(); this.valores.img = null; this.tocados.add('img'); this.removerImagem = true; }
    salvar(): void {
        if (this.ocupado() || this.bloqueado() || this.arquivoCapa || !this.pronto()) return;
        const patch: LivroAdminAlteracoes = {};
        if(this.id === null || this.categoriaAlterada) {
            const item=this.opcoesCategorias.find(c=>c.id===this.categoriaSelecionada);
            if(!item||item.disabled||typeof item.id!=='number') {this.erro.set('Selecione uma categoria ativa valida.');return;}
            patch.categoriaId=item.id;
        }
        for (const campo of this.tocados) {
            if (this.valores[campo] !== this.original?.[campo] || (campo === 'img' && this.removerImagem))
                Object.assign(patch, { [campo]: this.valores[campo] });
        }
        if ((this.id===null || 'sku' in patch) && (!this.valores.sku?.trim() || [...this.valores.sku].length>50)) {this.erro.set('Informe SKU valido de ate 50 caracteres.');return;}
        if ((this.id===null || 'price' in patch) && (this.valores.price===null || this.valores.price==='0.00')) {this.erro.set('Informe preco positivo ate 999,99.');return;}
        if (this.precoInvalido) { this.erro.set('Informe o preço entre 0,00 e 999,99 ou deixe sem valor.'); return; }
        if (this.descricaoAlterada && this.descricaoLegada !== null && !this.converterDescricao) {
            this.erro.set('Confirme a conversão da descrição legada antes de salvá-la.'); return;
        }
        if (this.id === null || this.descricaoAlterada) {
            for (const campo of this.camposDescricao) {
                const valor = this.descricao[campo.chave] ?? '';
                if ([...valor].length > campo.max || campo.numerico && !/^\d*$/.test(valor)) {
                    this.erro.set(`Confira o campo ${campo.chave}.`); return;
                }
            }
            if (!/^\d{0,13}$/.test(this.descricao['ISBN-13'] ?? '')) { this.erro.set('Confira o ISBN-13.'); return; }
            patch.description = this.serializarDescricao();
        }
        if(this.id!==null&&this.original?.comercial&&this.emVenda!==null&&this.emVenda!==this.original.comercial.emVenda)
            patch.comercial={emVenda:this.emVenda};
        if (this.id !== null && !Object.keys(patch).length) { this.erro.set('Nenhuma alteração para salvar.'); return; }
        const validarTexto = (v: string | null, max: number) => typeof v === 'string' && !!v.trim() && [...v].length <= max;
        if ((this.id === null || 'title' in patch) && !validarTexto(this.valores.title, 255)
            || ('category' in patch) && !validarTexto(this.valores.category, 50)
            || (this.id === null || 'language' in patch) && this.valores.language !== null && !/^(?:[a-z]{2}(?:-(?:[a-z]{2}|[A-Z]{2}))?|es-419)$/.test(this.valores.language)
            || (this.id === null || 'img' in patch) && this.valores.img !== null && !/^\/?assets\/images\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.(png|jpe?g|webp|avif|gif)$/i.test(this.valores.img)) {
            this.erro.set('Confira título, categoria, idioma e caminho público da imagem.'); return;
        }
        const operacao = this.id === null
            ? this.service.criarLivro({ categoriaId: patch.categoriaId!, author: this.valores.author, currency: 'BRL', title: this.valores.title!, format: this.valores.format as LivroAdminCriacao['format'],
                language: this.valores.language, img: this.valores.img, pertenceEditoraIst: this.valores.pertenceEditoraIst,
                sku: this.valores.sku, price: this.valores.price, onsale: this.valores.onsale as 0 | 1,
                inventory: this.valores.inventory as LivroAdminCriacao['inventory'], description: patch.description })
            : this.service.atualizarLivro(this.id, patch, this.original!.revisao, this.original!.comercial?.revisao);
        this.salvando.set(true); this.erro.set(null);
        operacao.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
            next: livro => { this.salvando.set(false);
                if(this.id === null) void this.router.navigate(['/admin/loja/livros',livro.id,'editar']);
                else {this.carregar();}
            },
            error: e => {
                this.salvando.set(false); this.erro.set(e instanceof LojaAdminErro ? e.message : 'Não foi possível confirmar a gravação. Confira o registro antes de repetir.');
                if (!(e instanceof LojaAdminErro) || [0, 401, 403, 404, 412, 428, 502, 503].includes(e.status)) this.bloqueado.set(true);
            }
        });
    }
}
