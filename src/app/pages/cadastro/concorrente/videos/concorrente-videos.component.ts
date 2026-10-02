import { CommonModule } from '@angular/common';
import { Component, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { Router } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { SelectModule } from 'primeng/select';
import {
    ObraElegivel,
    ObraPrincipalConcorrente,
    ParticipacaoConcorrente,
    ParticipacaoConcorrentePayload,
    PerfilUsuario
} from '../../../perfil/models/perfil.model';
import { PerfilService, PerfilServiceError } from '../../../perfil/services/perfil.service';

@Component({
    selector: 'app-concorrente-videos',
    standalone: true,
    imports: [CommonModule, FormsModule, ButtonModule, InputTextModule, SelectModule],
    template: `
        <div class="flex justify-center px-4 py-8 md:py-12">
            <main class="w-full max-w-4xl rounded-3xl border border-surface-200 bg-white p-6 shadow-xl dark:border-surface-700 dark:bg-surface-900 md:p-10">
                <header class="border-b border-surface-200 pb-6 dark:border-surface-700">
                    <p class="text-sm font-medium uppercase tracking-wide text-primary">Concorrente do II Festival de Violões Sebastião Tapajós</p>
                    <h1 class="mt-2 text-3xl font-semibold text-surface-900 dark:text-white">Postar vídeos da participação</h1>
                    <p class="mt-2 text-surface-600 dark:text-surface-300">Revise as músicas, informe os vídeos e conclua sua participação.</p>
                </header>

                <div *ngIf="mensagem" class="mt-6 rounded-md border px-3 py-2 text-sm" [ngClass]="{
                    'border-red-200 bg-red-50 text-red-700': tipoMensagem === 'error',
                    'border-green-200 bg-green-50 text-green-700': tipoMensagem === 'success'
                }">{{ mensagem }}</div>

                <p *ngIf="carregando" class="py-12 text-center text-surface-600 dark:text-surface-300">Carregando participação...</p>

                <form *ngIf="!carregando && usuario" class="mt-8" (ngSubmit)="salvar()" novalidate>
                    <section aria-labelledby="identificacao-participacao">
                        <h2 id="identificacao-participacao" class="text-xl font-semibold text-surface-900 dark:text-white">Dados da participação</h2>
                        <div class="mt-4 grid gap-4 sm:grid-cols-2">
                            <div class="rounded-xl border border-surface-200 bg-surface-50 p-4 dark:border-surface-700 dark:bg-surface-800">
                                <span class="block text-xs font-semibold uppercase text-surface-500">Concorrente</span>
                                <strong class="participacao-valor mt-1 block">{{ usuario.nome }}</strong>
                            </div>
                            <div class="rounded-xl border border-surface-200 bg-surface-50 p-4 dark:border-surface-700 dark:bg-surface-800">
                                <span class="block text-xs font-semibold uppercase text-surface-500">Número do concorrente</span>
                                <strong class="participacao-valor mt-1 block">{{ numeroConcorrente }}</strong>
                            </div>
                        </div>
                    </section>

                    <section class="mt-8" aria-labelledby="primeira-musica">
                        <h2 id="primeira-musica" class="text-xl font-semibold text-surface-900 dark:text-white">Primeira música (obrigatória)</h2>
                        <div class="mt-4 grid gap-5">
                            <div>
                                <label class="mb-2 block text-sm font-medium text-surface-700 dark:text-surface-200">Obra obrigatória</label>
                                <div class="rounded-xl border border-surface-200 bg-surface-50 p-4 dark:border-surface-700 dark:bg-surface-800">
                                    <strong>{{ participacao.tituloObra1 || obraPrincipal?.titulo || 'Obra principal' }}</strong>
                                </div>
                            </div>
                            <div>
                                <label for="videoPrimeiraMusica" class="mb-2 block text-sm font-medium text-surface-700 dark:text-surface-200">Vídeo da primeira música</label>
                                <input id="videoPrimeiraMusica" pInputText type="url" name="videoPrimeiraMusica" [(ngModel)]="participacao.linkVideo1" (ngModelChange)="atualizarPreviewVideo1()" placeholder="https://www.youtube.com/... ou https://vimeo.com/..." class="w-full" />
                                <p *ngIf="participacao.linkVideo1 && !previewVideo1" class="mt-2 text-sm text-red-600">Informe uma URL HTTPS válida do YouTube ou Vimeo.</p>
                                <div *ngIf="previewVideo1" class="mt-4 aspect-video w-full overflow-hidden rounded-xl">
                                    <iframe [src]="previewVideo1" title="Vídeo da primeira música" class="h-full w-full border-0" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen loading="lazy"></iframe>
                                </div>
                            </div>
                        </div>
                    </section>

                    <section class="mt-8" aria-labelledby="segunda-musica">
                        <h2 id="segunda-musica" class="text-xl font-semibold text-surface-900 dark:text-white">Segunda música (opcional)</h2>
                        <div class="mt-4 grid gap-5">
                            <div>
                                <label for="segundaObra" class="mb-2 block text-sm font-medium text-surface-700 dark:text-surface-200">Obra (opcional)</label>
                                <p-select id="segundaObra" name="segundaObra" [(ngModel)]="participacao.idObra2" (ngModelChange)="alterarObra2($event)" [options]="obrasElegiveis" optionLabel="titulo" optionValue="idObra" [showClear]="true" placeholder="Nenhuma segunda obra" styleClass="w-full"></p-select>
                            </div>
                            <div *ngIf="participacao.idObra2 !== null">
                                <label for="videoSegundaMusica" class="mb-2 block text-sm font-medium text-surface-700 dark:text-surface-200">Vídeo da segunda música</label>
                                <input id="videoSegundaMusica" pInputText type="url" name="videoSegundaMusica" [(ngModel)]="participacao.linkVideo2" (ngModelChange)="atualizarPreviewVideo2()" placeholder="https://www.youtube.com/... ou https://vimeo.com/..." class="w-full" />
                                <p *ngIf="participacao.linkVideo2 && !previewVideo2" class="mt-2 text-sm text-red-600">Informe uma URL HTTPS válida do YouTube ou Vimeo.</p>
                                <div *ngIf="previewVideo2" class="mt-4 aspect-video w-full overflow-hidden rounded-xl">
                                    <iframe [src]="previewVideo2" title="Vídeo da segunda música" class="h-full w-full border-0" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen loading="lazy"></iframe>
                                </div>
                            </div>
                        </div>
                    </section>

                    <div class="mt-8 border-t border-surface-200 pt-6 dark:border-surface-700">
                        <label for="aceiteRegulamentoVideos" class="flex items-center gap-3 text-sm font-medium text-surface-700 dark:text-surface-200">
                            <input id="aceiteRegulamentoVideos" name="aceiteRegulamentoVideos" type="checkbox" [(ngModel)]="aceiteRegulamento" [disabled]="aceiteRegulamentoPersistido || salvando" class="h-4 w-4 accent-primary" />
                            <span>Aceito o Regulamento do Festival:</span>
                        </label>

                        <div class="mt-6 flex flex-col gap-3 sm:flex-row sm:justify-end">
                            <button pButton type="button" label="Cancelar" class="p-button-outlined" (click)="cancelar()" [disabled]="salvando"></button>
                            <button pButton type="submit" label="Salvar participação" icon="pi pi-save" [loading]="salvando" [disabled]="salvando || !aceiteRegulamento"></button>
                        </div>
                    </div>
                </form>
            </main>
        </div>
    `,
    styles: [`
        .participacao-valor {
            color: #1f2937;
        }

        :host-context(.dark) .participacao-valor {
            color: #f8fafc;
        }
    `]
})
export class ConcorrenteVideosComponent implements OnInit {
    usuario: PerfilUsuario | null = null;
    participacao: ParticipacaoConcorrente = {
        numeroConcorrente: null,
        idObra1: null,
        tituloObra1: null,
        linkVideo1: null,
        idObra2: null,
        tituloObra2: null,
        linkVideo2: null,
        aceiteRegulamento: false,
        dataCadastro: null
    };
    obrasElegiveis: ObraElegivel[] = [];
    obraPrincipal: ObraPrincipalConcorrente | null = null;
    aceiteRegulamento = false;
    aceiteRegulamentoPersistido = false;
    previewVideo1: SafeResourceUrl | null = null;
    previewVideo2: SafeResourceUrl | null = null;
    carregando = true;
    salvando = false;
    mensagem: string | null = null;
    tipoMensagem: 'success' | 'error' = 'error';

    constructor(
        private readonly perfilService: PerfilService,
        private readonly sanitizer: DomSanitizer,
        private readonly router: Router
    ) {}

    get numeroConcorrente(): string {
        return this.participacao.numeroConcorrente || 'Não atribuído';
    }

    ngOnInit(): void {
        void this.carregar();
    }

    async cancelar(): Promise<void> {
        await this.router.navigate(['/cadastro/concorrente/perfil']);
    }

    alterarObra2(value: number | null | undefined): void {
        const idObra2 = value === null || value === undefined ? null : Number(value);
        if (this.participacao.idObra2 === idObra2) return;
        this.participacao.idObra2 = idObra2 !== null && Number.isInteger(idObra2) && idObra2 > 0 ? idObra2 : null;
        this.participacao.linkVideo2 = null;
        this.previewVideo2 = null;
    }

    atualizarPreviewVideo1(): void {
        this.previewVideo1 = this.criarVideoEmbedUrl(this.participacao.linkVideo1 || '');
    }

    atualizarPreviewVideo2(): void {
        this.previewVideo2 = this.criarVideoEmbedUrl(this.participacao.linkVideo2 || '');
    }

    async salvar(): Promise<void> {
        if (this.salvando || !this.usuario || !this.aceiteRegulamento) return;

        const linkVideo1 = (this.participacao.linkVideo1 || '').trim();
        if (!this.criarVideoEmbedUrl(linkVideo1)) {
            this.exibirErro('Informe um vídeo HTTPS válido do YouTube ou Vimeo para a primeira obra.');
            return;
        }

        const idObra2 = this.participacao.idObra2 === null ? null : Number(this.participacao.idObra2);
        if (idObra2 !== null && !this.obrasElegiveis.some((obra) => obra.idObra === idObra2)) {
            this.exibirErro('A segunda obra selecionada não é elegível.');
            return;
        }

        const linkVideo2 = idObra2 === null ? null : (this.participacao.linkVideo2 || '').trim();
        if (idObra2 !== null && !this.criarVideoEmbedUrl(linkVideo2 || '')) {
            this.exibirErro('Informe um vídeo HTTPS válido do YouTube ou Vimeo para a segunda obra.');
            return;
        }

        this.salvando = true;
        this.mensagem = null;

        try {
            const participacaoPayload: ParticipacaoConcorrentePayload = {
                linkVideo1,
                idObra2,
                linkVideo2,
                aceiteRegulamento: this.aceiteRegulamento
            };
            const participacaoResposta = await this.perfilService.atualizarParticipacaoConcorrente(participacaoPayload);
            this.aplicarParticipacao(participacaoResposta.concorrente);
            this.tipoMensagem = 'success';
            this.mensagem = participacaoResposta.message || 'Participação atualizada com sucesso.';
        } catch (error) {
            this.exibirErro(error instanceof PerfilServiceError ? error.message : 'Não foi possível salvar a participação. Tente novamente.');
        } finally {
            this.salvando = false;
        }
    }

    private async carregar(): Promise<void> {
        this.carregando = true;
        try {
            const [perfil, obrasParticipacao] = await Promise.all([
                this.perfilService.obterPerfil(),
                this.perfilService.carregarObrasParticipacao()
            ]);
            if (perfil.usuario.idTipoUsuario !== 2 || !perfil.concorrente) {
                throw new PerfilServiceError('Esta página está disponível apenas para concorrentes.', 403);
            }
            this.usuario = perfil.usuario;
            this.obraPrincipal = obrasParticipacao.obraPrincipal;
            this.obrasElegiveis = obrasParticipacao.obrasElegiveis;
            this.aplicarParticipacao(perfil.concorrente);
        } catch (error) {
            this.exibirErro(error instanceof PerfilServiceError ? error.message : 'Não foi possível carregar a participação.');
        } finally {
            this.carregando = false;
        }
    }

    private aplicarParticipacao(participacao: ParticipacaoConcorrente): void {
        const aceiteRegulamento = participacao.aceiteRegulamento ?? this.aceiteRegulamentoPersistido;
        this.participacao = {
            ...this.participacao,
            ...participacao,
            aceiteRegulamento
        };
        this.aceiteRegulamento = aceiteRegulamento;
        this.aceiteRegulamentoPersistido = aceiteRegulamento;
        this.atualizarPreviewVideo1();
        this.atualizarPreviewVideo2();
    }

    private criarVideoEmbedUrl(url: string): SafeResourceUrl | null {
        try {
            const valor = new URL(url.trim());
            if (valor.protocol !== 'https:') return null;

            const hostname = valor.hostname.toLowerCase();
            let videoId: string | null = null;
            if (hostname === 'youtube.com' || hostname === 'www.youtube.com') {
                if (valor.pathname === '/watch') videoId = valor.searchParams.get('v');
                else if (valor.pathname.startsWith('/shorts/') || valor.pathname.startsWith('/embed/')) videoId = valor.pathname.split('/')[2] || null;
                return videoId && /^[A-Za-z0-9_-]{11}$/.test(videoId)
                    ? this.sanitizer.bypassSecurityTrustResourceUrl(`https://www.youtube.com/embed/${videoId}`)
                    : null;
            }
            if (hostname === 'youtu.be') {
                videoId = valor.pathname.split('/')[1] || null;
                return videoId && /^[A-Za-z0-9_-]{11}$/.test(videoId)
                    ? this.sanitizer.bypassSecurityTrustResourceUrl(`https://www.youtube.com/embed/${videoId}`)
                    : null;
            }
            if (hostname === 'vimeo.com' || hostname === 'www.vimeo.com') {
                videoId = valor.pathname.split('/')[1] || null;
                return videoId && /^\d+$/.test(videoId)
                    ? this.sanitizer.bypassSecurityTrustResourceUrl(`https://player.vimeo.com/video/${videoId}`)
                    : null;
            }
            return null;
        } catch {
            return null;
        }
    }

    private exibirErro(mensagem: string): void {
        this.tipoMensagem = 'error';
        this.mensagem = mensagem;
    }
}