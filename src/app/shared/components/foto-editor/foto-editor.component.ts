import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, OnDestroy, Output } from '@angular/core';
import { ImageCroppedEvent, ImageCropperComponent, ImageTransform } from 'ngx-image-cropper';

const MAX_FILE_SIZE = 5 * 1024 * 1024;
const MIN_ZOOM = 1;
const MAX_ZOOM = 3;
const ZOOM_STEP = 0.1;
const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

@Component({
    selector: 'app-foto-editor',
    standalone: true,
    imports: [CommonModule, ImageCropperComponent],
    template: `
        <section class="foto-editor" aria-labelledby="foto-editor-titulo">
            <div class="foto-editor-cabecalho">
                <div>
                    <h2 id="foto-editor-titulo">Foto de perfil</h2>
                    <p>Escolha uma imagem quadrada para seu perfil.</p>
                </div>
                <span class="foto-editor-formato">JPG, PNG ou WEBP</span>
            </div>

            <div *ngIf="mensagemErro" class="foto-editor-mensagem" role="alert">
                {{ mensagemErro }}
            </div>

            <div *ngIf="!arquivoSelecionado" class="foto-editor-inicial">
                <img *ngIf="fotoAtual; else fotoVazia" [src]="fotoAtual" alt="Foto de perfil atual" class="foto-editor-foto-atual" />
                <ng-template #fotoVazia>
                    <div class="foto-editor-placeholder" aria-hidden="true">
                        <i class="pi pi-user"></i>
                    </div>
                </ng-template>
                <p class="foto-editor-status">{{ fotoAtual ? 'Foto atual' : 'Nenhuma foto cadastrada' }}</p>
            </div>

            <div *ngIf="arquivoSelecionado" class="foto-editor-edicao">
                <div class="foto-editor-cropper">
                    <image-cropper
                        [imageFile]="arquivoSelecionado"
                        [maintainAspectRatio]="true"
                        [aspectRatio]="1"
                        [resizeToWidth]="800"
                        [resizeToHeight]="800"
                        [output]="'blob'"
                        [format]="'webp'"
                        [imageQuality]="90"
                        [allowMoveImage]="true"
                        [transform]="transform"
                        [cropperFrameAriaLabel]="'Área de recorte da foto de perfil'"
                        (imageCropped)="imagemRecortada($event)"
                        (imageLoaded)="imagemCarregada()"
                        (loadImageFailed)="falhaAoCarregarImagem()"
                        (transformChange)="atualizarTransform($event)"
                    ></image-cropper>
                </div>

                <div class="foto-editor-controles" aria-label="Controles de zoom">
                    <button type="button" class="foto-editor-botao-icone" (click)="alterarZoom(-ZOOM_STEP)" [disabled]="zoomAtual <= MIN_ZOOM" aria-label="Diminuir zoom" title="Diminuir zoom">
                        <i class="pi pi-minus" aria-hidden="true"></i>
                    </button>
                    <span aria-live="polite">Zoom {{ zoomAtual | number: '1.1-1' }}x</span>
                    <button type="button" class="foto-editor-botao-icone" (click)="alterarZoom(ZOOM_STEP)" [disabled]="zoomAtual >= MAX_ZOOM" aria-label="Aumentar zoom" title="Aumentar zoom">
                        <i class="pi pi-plus" aria-hidden="true"></i>
                    </button>
                </div>

                <div *ngIf="resultadoPreviewUrl" class="foto-editor-preview">
                    <p>Pré-visualização</p>
                    <img [src]="resultadoPreviewUrl" alt="Pré-visualização da foto recortada" />
                </div>
            </div>

            <div class="foto-editor-acoes">
                <label [for]="inputId" class="foto-editor-botao foto-editor-botao-secundario">
                    <i class="pi pi-image" aria-hidden="true"></i>
                    <span>{{ arquivoSelecionado ? 'Escolher outra foto' : 'Selecionar nova foto' }}</span>
                </label>
                <input [id]="inputId" type="file" accept="image/jpeg,image/png,image/webp" (change)="selecionarArquivo($event)" class="sr-only" />

                <button *ngIf="arquivoSelecionado" type="button" class="foto-editor-botao foto-editor-botao-secundario" (click)="cancelar()">
                    <i class="pi pi-times" aria-hidden="true"></i>
                    <span>Cancelar</span>
                </button>
                <button *ngIf="arquivoSelecionado" type="button" class="foto-editor-botao foto-editor-botao-principal" (click)="aplicar()" [disabled]="!resultadoBlob || imagemCarregando">
                    <i class="pi pi-check" aria-hidden="true"></i>
                    <span>Aplicar</span>
                </button>
                <button *ngIf="fotoAtual && !arquivoSelecionado" type="button" class="foto-editor-botao foto-editor-botao-perigo" (click)="remover()">
                    <i class="pi pi-trash" aria-hidden="true"></i>
                    <span>Remover foto</span>
                </button>
            </div>
        </section>
    `,
    styles: [`
        :host {
            display: block;
        }

        .foto-editor {
            display: flex;
            flex-direction: column;
            gap: 1rem;
            border: 1px solid var(--p-surface-200);
            border-radius: 0.75rem;
            padding: 1rem;
        }

        .foto-editor-cabecalho,
        .foto-editor-acoes,
        .foto-editor-controles {
            display: flex;
            align-items: center;
            gap: 0.75rem;
        }

        .foto-editor-cabecalho {
            justify-content: space-between;
            gap: 1rem;
        }

        .foto-editor-cabecalho h2 {
            margin: 0;
            color: var(--text-color);
            font-size: 1.1rem;
            font-weight: 700;
        }

        .foto-editor-cabecalho p,
        .foto-editor-status,
        .foto-editor-preview p {
            margin: 0.25rem 0 0;
            color: var(--text-color-secondary);
            font-size: 0.875rem;
        }

        .foto-editor-formato {
            color: var(--text-color-secondary);
            font-size: 0.75rem;
            white-space: nowrap;
        }

        .foto-editor-inicial {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            gap: 0.5rem;
            min-height: 12rem;
            border: 1px dashed var(--p-surface-300);
            border-radius: 0.75rem;
            padding: 1rem;
        }

        .foto-editor-foto-atual,
        .foto-editor-placeholder,
        .foto-editor-preview img {
            width: 8rem;
            height: 8rem;
            border-radius: 50%;
            object-fit: cover;
        }

        .foto-editor-placeholder {
            display: grid;
            place-items: center;
            background: var(--p-surface-100);
            color: var(--text-color-secondary);
            font-size: 2rem;
        }

        .foto-editor-edicao {
            display: flex;
            flex-direction: column;
            gap: 1rem;
        }

        .foto-editor-cropper {
            width: 100%;
            max-width: 32rem;
            min-height: 18rem;
            margin: 0 auto;
            overflow: hidden;
            border-radius: 0.75rem;
            background: var(--p-surface-950);
        }

        .foto-editor-cropper image-cropper {
            display: block;
            height: min(70vw, 28rem);
            min-height: 18rem;
        }

        .foto-editor-controles {
            justify-content: center;
            color: var(--text-color-secondary);
            font-size: 0.875rem;
        }

        .foto-editor-botao-icone {
            display: inline-grid;
            width: 2.25rem;
            height: 2.25rem;
            place-items: center;
            border: 1px solid var(--p-surface-300);
            border-radius: 0.5rem;
            background: transparent;
            color: var(--text-color);
            cursor: pointer;
        }

        .foto-editor-botao-icone:disabled {
            cursor: not-allowed;
            opacity: 0.5;
        }

        .foto-editor-preview {
            display: flex;
            align-items: center;
            gap: 0.75rem;
        }

        .foto-editor-preview img {
            width: 4rem;
            height: 4rem;
        }

        .foto-editor-acoes {
            flex-wrap: wrap;
            justify-content: flex-end;
        }

        .foto-editor-botao {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 0.5rem;
            min-height: 2.5rem;
            border: 1px solid transparent;
            border-radius: 0.5rem;
            padding: 0.625rem 0.875rem;
            font-size: 0.875rem;
            font-weight: 600;
            cursor: pointer;
        }

        .foto-editor-botao-secundario {
            border-color: var(--p-surface-300);
            background: transparent;
            color: var(--text-color);
        }

        .foto-editor-botao-principal {
            background: var(--p-primary-color);
            color: var(--p-primary-contrast-color);
        }

        .foto-editor-botao-perigo {
            border-color: var(--p-red-300);
            background: transparent;
            color: var(--p-red-700);
        }

        .foto-editor-botao:disabled {
            cursor: not-allowed;
            opacity: 0.5;
        }

        .foto-editor-mensagem {
            border: 1px solid var(--p-red-200);
            border-radius: 0.5rem;
            background: var(--p-red-50);
            color: var(--p-red-700);
            padding: 0.625rem 0.75rem;
            font-size: 0.875rem;
        }

        @media (max-width: 480px) {
            .foto-editor-cabecalho,
            .foto-editor-acoes {
                align-items: stretch;
                flex-direction: column;
            }

            .foto-editor-formato {
                white-space: normal;
            }

            .foto-editor-botao {
                width: 100%;
            }
        }
    `]
})
export class FotoEditorComponent implements OnDestroy {
    private static proximoId = 0;

    @Input() fotoAtual: string | null = null;
    @Output() readonly aplicado = new EventEmitter<Blob>();
    @Output() readonly cancelado = new EventEmitter<void>();
    @Output() readonly removido = new EventEmitter<void>();

    readonly inputId = `foto-editor-${++FotoEditorComponent.proximoId}`;
    readonly MIN_ZOOM = MIN_ZOOM;
    readonly MAX_ZOOM = MAX_ZOOM;
    readonly ZOOM_STEP = ZOOM_STEP;

    arquivoSelecionado: File | null = null;
    resultadoBlob: Blob | null = null;
    resultadoPreviewUrl: string | null = null;
    mensagemErro: string | null = null;
    imagemCarregando = false;
    zoomAtual = MIN_ZOOM;
    transform: ImageTransform = { scale: MIN_ZOOM };

    selecionarArquivo(event: Event): void {
        const input = event.target as HTMLInputElement;
        const arquivo = input.files?.[0] ?? null;
        this.limparResultado();
        this.mensagemErro = null;
        this.arquivoSelecionado = null;

        if (!arquivo) {
            return;
        }

        if (arquivo.size > MAX_FILE_SIZE) {
            this.mensagemErro = 'A foto deve ter no máximo 5 MB.';
            input.value = '';
            return;
        }

        if (!ALLOWED_MIME_TYPES.has(arquivo.type)) {
            this.mensagemErro = 'Selecione uma imagem JPG, PNG ou WEBP.';
            input.value = '';
            return;
        }

        this.arquivoSelecionado = arquivo;
        this.imagemCarregando = true;
        this.zoomAtual = MIN_ZOOM;
        this.transform = { scale: MIN_ZOOM };
    }

    imagemRecortada(event: ImageCroppedEvent): void {
        if (!event.blob) {
            this.resultadoBlob = null;
            this.mensagemErro = 'Não foi possível produzir a foto recortada.';
            return;
        }

        this.resultadoBlob = event.blob;
        this.substituirPreview(event.blob);
        this.mensagemErro = null;
    }

    imagemCarregada(): void {
        this.imagemCarregando = false;
    }

    falhaAoCarregarImagem(): void {
        this.imagemCarregando = false;
        this.arquivoSelecionado = null;
        this.limparResultado();
        this.mensagemErro = 'Não foi possível carregar essa imagem.';
    }

    alterarZoom(delta: number): void {
        const proximoZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number((this.zoomAtual + delta).toFixed(1))));
        this.zoomAtual = proximoZoom;
        this.transform = { ...this.transform, scale: proximoZoom };
    }

    atualizarTransform(transform: ImageTransform): void {
        this.transform = { ...transform };
        if (typeof transform.scale === 'number') {
            this.zoomAtual = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, transform.scale));
        }
    }

    aplicar(): void {
        if (!this.resultadoBlob || this.imagemCarregando) {
            this.mensagemErro = 'Aguarde a imagem ser processada antes de aplicar.';
            return;
        }

        this.aplicado.emit(this.resultadoBlob);
    }

    cancelar(): void {
        this.resetarEditor();
        this.cancelado.emit();
    }

    remover(): void {
        this.resetarEditor();
        this.removido.emit();
    }

    ngOnDestroy(): void {
        this.limparResultado();
    }

    private substituirPreview(blob: Blob): void {
        this.limparPreviewUrl();
        this.resultadoPreviewUrl = URL.createObjectURL(blob);
    }

    private limparResultado(): void {
        this.resultadoBlob = null;
        this.limparPreviewUrl();
    }

    private limparPreviewUrl(): void {
        if (this.resultadoPreviewUrl) {
            URL.revokeObjectURL(this.resultadoPreviewUrl);
            this.resultadoPreviewUrl = null;
        }
    }

    private resetarEditor(): void {
        this.arquivoSelecionado = null;
        this.imagemCarregando = false;
        this.zoomAtual = MIN_ZOOM;
        this.transform = { scale: MIN_ZOOM };
        this.mensagemErro = null;
        this.limparResultado();
        const input = document.getElementById(this.inputId) as HTMLInputElement | null;
        if (input) {
            input.value = '';
        }
    }
}
