import { CommonModule } from '@angular/common';
import { Component, OnDestroy, OnInit, ViewChild, effect, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { ConfirmationService } from 'primeng/api';
import { ButtonModule } from 'primeng/button';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { DatePickerModule } from 'primeng/datepicker';
import { InputMaskModule } from 'primeng/inputmask';
import { InputTextModule } from 'primeng/inputtext';
import { SelectModule } from 'primeng/select';
import { CadastroTipo } from '../cadastro/models/cadastro.model';
import { AuthService } from '../../shared/auth.service';
import { FotoEditorComponent } from '../../shared/components/foto-editor/foto-editor.component';
import { PerfilService, PerfilServiceError } from './services/perfil.service';
import { ObraElegivel, ParticipacaoConcorrente, ParticipacaoConcorrentePayload, PerfilAtualizacaoPayload, PerfilConcorrente, PerfilResponse, PerfilUsuario } from './models/perfil.model';

interface PerfilRouteData {
    perfilTipo: CadastroTipo;
    perfilTipoId: number;
}

const PERFIL_ROTAS: Record<number, string> = {
    1: '/cadastro/diretoria/perfil',
    2: '/cadastro/concorrente/perfil',
    3: '/cadastro/externo/perfil',
    4: '/cadastro/colaborador/perfil'
};

const PERFIL_LABELS: Record<CadastroTipo, string> = {
    diretoria: 'Diretoria',
    concorrente: 'Concorrente do Festival',
    externo: 'Usuário Externo',
    colaborador: 'Colaborador'
};

const UFS = [
    'AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS',
    'MG', 'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC',
    'SP', 'SE', 'TO'
].map((uf) => ({ label: uf, value: uf }));

@Component({
    selector: 'app-perfil',
    standalone: true,
    imports: [CommonModule, FormsModule, RouterLink, ButtonModule, ConfirmDialogModule, DatePickerModule, InputMaskModule, InputTextModule, SelectModule, FotoEditorComponent],
    providers: [ConfirmationService],
    template: `
        <div class="flex justify-center px-4 py-8 md:py-12">
            <main class="w-full max-w-5xl rounded-3xl border border-surface-200 bg-white p-6 shadow-xl dark:border-surface-700 dark:bg-surface-900 md:p-10">
                <ng-container *ngIf="authService.carregando() || carregandoPerfil; else perfilEstado">
                    <p class="py-12 text-center text-surface-600 dark:text-surface-300">Carregando perfil...</p>
                </ng-container>

                <ng-template #perfilEstado>
                    <div *ngIf="erroPerfil; else perfilSucesso" class="py-12 text-center">
                        <h1 class="text-3xl font-semibold text-surface-900 dark:text-white">Perfil</h1>
                        <p class="mt-4 text-surface-600 dark:text-surface-300">{{ erroPerfil }}</p>
                    </div>
                </ng-template>

                <ng-template #perfilSucesso>
                    <ng-container *ngIf="usuario && perfilUsuario; else naoAutenticado">
                        <div *ngIf="tipoCompativel; else redirecionando">
                            <header class="border-b border-surface-200 pb-6 dark:border-surface-700">
                                <p class="text-sm font-medium uppercase tracking-wide text-primary">{{ perfilLabel }}</p>
                                <h2 *ngIf="perfilUsuario.idTipoUsuario === 2" class="mt-2 text-2xl font-semibold text-surface-900 dark:text-white">{{ perfilUsuario.nome }}</h2>
                                <h1 class="mt-2 text-3xl font-semibold text-surface-900 dark:text-white">Perfil</h1>
                                <div class="mt-2 flex flex-col gap-4 text-surface-600 dark:text-surface-300 md:flex-row md:items-center md:justify-between">
                                    <p>Dados cadastrados em modo de consulta.</p>
                                    <button *ngIf="!editando" pButton type="button" label="Editar dados" icon="pi pi-pencil" (click)="iniciarEdicao()"></button>
                                </div>
                            </header>

                            <div *ngIf="mensagemPerfil" class="mt-6 rounded-md border px-3 py-2 text-sm" [ngClass]="{
                                'border-red-200 bg-red-50 text-red-700': tipoMensagemPerfil === 'error',
                                'border-green-200 bg-green-50 text-green-700': tipoMensagemPerfil === 'success'
                            }">
                                {{ mensagemPerfil }}
                            </div>

                            <section *ngIf="podeEditarFoto" class="mt-8" aria-labelledby="foto-perfil">
                                <h2 id="foto-perfil" class="text-xl font-semibold text-surface-900 dark:text-white">Foto de perfil</h2>
                                <div class="mt-4">
                                    <app-foto-editor
                                        [fotoAtual]="fotoUrl"
                                        (aplicado)="receberFotoAplicada($event)"
                                        (cancelado)="cancelarFotoTemporaria()"
                                        (removido)="solicitarRemocaoFoto()"
                                    ></app-foto-editor>

                                    <div *ngIf="previewFotoUrl" class="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950/30">
                                        <div class="flex flex-col gap-3 sm:flex-row sm:items-center">
                                            <img [src]="previewFotoUrl" alt="Prévia da nova foto de perfil" class="h-20 w-20 rounded-full object-cover" />
                                            <div class="text-sm text-amber-900 dark:text-amber-100">
                                                <p class="font-semibold">Prévia da nova foto — ainda não salva.</p>
                                                <p class="mt-1">Tipo: {{ previewFotoTipo }} · Tamanho: {{ formatarTamanhoBlob(previewFotoTamanho) }}</p>
                                            </div>
                                        </div>
                                    </div>

                                    <div *ngIf="fotoBlobPendente" class="mt-4 flex flex-col gap-3 rounded-xl border border-surface-200 p-4 dark:border-surface-700 sm:flex-row sm:items-center sm:justify-between">
                                        <p class="text-sm text-surface-600 dark:text-surface-300">A prévia ainda não foi salva.</p>
                                        <div class="flex flex-wrap gap-2">
                                            <button pButton type="button" label="Cancelar" class="p-button-outlined" (click)="descartarFotoPendente()" [disabled]="fotoSalvando"></button>
                                            <button pButton type="button" label="Salvar foto" icon="pi pi-save" (click)="salvarFoto()" [loading]="fotoSalvando" [disabled]="fotoSalvando || fotoRemovendo"></button>
                                        </div>
                                    </div>

                                    <p *ngIf="fotoSalvando" class="mt-3 text-sm text-surface-600 dark:text-surface-300">Salvando foto...</p>

                                    <p *ngIf="remocaoFotoPendente" class="mt-3 text-sm text-amber-700 dark:text-amber-300">A remoção será aplicada agora, após a confirmação.</p>
                                </div>
                            </section>

                            <section *ngIf="tipoCompativel && perfilUsuario.idTipoUsuario === 2" class="mt-8" aria-labelledby="participacao-festival">
                                <div class="flex flex-col gap-3 border-b border-surface-200 pb-4 dark:border-surface-700 sm:flex-row sm:items-center sm:justify-between">
                                    <div>
                                        <h2 id="participacao-festival" class="text-xl font-semibold text-surface-900 dark:text-white">Obras e vídeos para o Festival</h2>
                                        <p class="mt-1 text-sm text-surface-600 dark:text-surface-300">Selecione a segunda obra, se desejar, e informe os vídeos correspondentes.</p>
                                    </div>
                                    <button pButton type="button" label="Salvar obras e vídeos" icon="pi pi-save" (click)="salvarParticipacao()" [loading]="salvandoParticipacao" [disabled]="salvandoParticipacao || carregandoObras"></button>
                                </div>

                                <div *ngIf="mensagemParticipacao" class="mt-4 rounded-md border px-3 py-2 text-sm" [ngClass]="{
                                    'border-red-200 bg-red-50 text-red-700': tipoMensagemParticipacao === 'error',
                                    'border-green-200 bg-green-50 text-green-700': tipoMensagemParticipacao === 'success'
                                }">
                                    {{ mensagemParticipacao }}
                                </div>

                                <div *ngIf="carregandoObras" class="mt-6 text-sm text-surface-600 dark:text-surface-300">Carregando obras elegíveis...</div>

                                <div *ngIf="!carregandoObras" class="mt-6 grid gap-5">
                                    <div>
                                        <label class="mb-2 block text-sm font-medium text-surface-700 dark:text-surface-200">Obra obrigatória</label>
                                        <div class="rounded-xl border border-surface-200 bg-surface-50 p-4 dark:border-surface-700 dark:bg-surface-800">
                                            <strong>{{ participacao.tituloObra1 || 'Catraias' }}</strong>
                                        </div>
                                    </div>

                                    <div>
                                        <label for="participacaoVideo1" class="mb-2 block text-sm font-medium text-surface-700 dark:text-surface-200">Vídeo da obra</label>
                                        <input id="participacaoVideo1" pInputText type="url" name="participacaoVideo1" [(ngModel)]="participacao.linkVideo1" (ngModelChange)="atualizarPreviewVideo1()" placeholder="https://www.youtube.com/... ou https://vimeo.com/..." class="w-full" />
                                        <p *ngIf="participacao.linkVideo1 && !previewVideo1" class="mt-2 text-sm text-red-600">Informe uma URL HTTPS válida do YouTube ou Vimeo.</p>
                                        <div *ngIf="previewVideo1" class="mt-4 aspect-video w-full overflow-hidden rounded-xl">
                                            <iframe [src]="previewVideo1" title="Vídeo da primeira obra" class="h-full w-full border-0" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen loading="lazy"></iframe>
                                        </div>
                                    </div>

                                    <div>
                                        <label for="participacaoObra2" class="mb-2 block text-sm font-medium text-surface-700 dark:text-surface-200">Segunda obra (opcional)</label>
                                        <p-select id="participacaoObra2" name="participacaoObra2" [(ngModel)]="participacao.idObra2" (ngModelChange)="alterarObra2($event)" [options]="obrasElegiveis" optionLabel="titulo" optionValue="idObra" [showClear]="true" placeholder="Nenhuma segunda obra" styleClass="w-full"></p-select>
                                    </div>

                                    <div *ngIf="participacao.idObra2 !== null">
                                        <label for="participacaoVideo2" class="mb-2 block text-sm font-medium text-surface-700 dark:text-surface-200">Vídeo da segunda obra</label>
                                        <input id="participacaoVideo2" pInputText type="url" name="participacaoVideo2" [(ngModel)]="participacao.linkVideo2" (ngModelChange)="atualizarPreviewVideo2()" placeholder="https://www.youtube.com/... ou https://vimeo.com/..." class="w-full" />
                                        <p *ngIf="participacao.linkVideo2 && !previewVideo2" class="mt-2 text-sm text-red-600">Informe uma URL HTTPS válida do YouTube ou Vimeo.</p>
                                        <div *ngIf="previewVideo2" class="mt-4 aspect-video w-full overflow-hidden rounded-xl">
                                            <iframe [src]="previewVideo2" title="Vídeo da segunda obra" class="h-full w-full border-0" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen loading="lazy"></iframe>
                                        </div>
                                    </div>
                                </div>
                            </section>

                            <ng-container *ngIf="!editando; else formularioEdicao">
                            <section class="mt-8" aria-labelledby="dados-pessoais">
                                <h2 id="dados-pessoais" class="text-xl font-semibold text-surface-900 dark:text-white">Dados pessoais</h2>
                                <div class="mt-4 grid gap-4 md:grid-cols-2">
                                    <div class="perfil-campo md:col-span-2"><span>Nome</span><strong>{{ valor(perfilUsuario.nome) }}</strong></div>
                                    <div class="perfil-campo"><span>E-mail</span><strong>{{ valor(perfilUsuario.email) }}</strong></div>
                                    <div class="perfil-campo"><span>CPF</span><strong>{{ formatarCpf(perfilUsuario.cpf) }}</strong></div>
                                    <div class="perfil-campo"><span>Identidade</span><strong>{{ valor(perfilUsuario.identidade) }}</strong></div>
                                    <div class="perfil-campo"><span>Telefone celular</span><strong>{{ formatarTelefone(perfilUsuario.telefoneCelular) }}</strong></div>
                                    <div class="perfil-campo"><span>Data de nascimento</span><strong>{{ formatarData(perfilUsuario.dataNascimento) }}</strong></div>
                                    <div class="perfil-campo"><span>Foto</span><strong>{{ perfilUsuario.foto ? 'Cadastrada' : 'Não informado' }}</strong></div>
                                </div>
                            </section>

                            <section class="mt-8" aria-labelledby="endereco">
                                <h2 id="endereco" class="text-xl font-semibold text-surface-900 dark:text-white">Endereço</h2>
                                <div class="mt-4 grid gap-4 md:grid-cols-2">
                                    <div class="perfil-campo"><span>CEP</span><strong>{{ formatarCep(perfilUsuario.cep) }}</strong></div>
                                    <div class="perfil-campo"><span>Logradouro</span><strong>{{ valor(perfilUsuario.logradouro) }}</strong></div>
                                    <div class="perfil-campo"><span>Número</span><strong>{{ valor(perfilUsuario.numero) }}</strong></div>
                                    <div class="perfil-campo"><span>Complemento</span><strong>{{ valor(perfilUsuario.complemento) }}</strong></div>
                                    <div class="perfil-campo"><span>Bairro</span><strong>{{ valor(perfilUsuario.bairro) }}</strong></div>
                                    <div class="perfil-campo"><span>Cidade</span><strong>{{ valor(perfilUsuario.cidade) }}</strong></div>
                                    <div class="perfil-campo"><span>UF</span><strong>{{ valor(perfilUsuario.uf) }}</strong></div>
                                </div>
                            </section>

                            <section *ngIf="podeEditarCurriculo" class="mt-8" aria-labelledby="curriculo">
                                <div class="flex flex-col gap-3 border-b border-surface-200 pb-4 dark:border-surface-700 sm:flex-row sm:items-center sm:justify-between">
                                    <h2 id="curriculo" class="text-xl font-semibold text-surface-900 dark:text-white">Currículo</h2>
                                    <button *ngIf="!editandoCurriculo" pButton type="button" label="Editar currículo" icon="pi pi-pencil" (click)="iniciarEdicaoCurriculo()"></button>
                                </div>

                                <div *ngIf="mensagemCurriculo" class="mt-4 rounded-md border px-3 py-2 text-sm" [ngClass]="{
                                    'border-red-200 bg-red-50 text-red-700': tipoMensagemCurriculo === 'error',
                                    'border-green-200 bg-green-50 text-green-700': tipoMensagemCurriculo === 'success'
                                }">
                                    {{ mensagemCurriculo }}
                                </div>

                                <ng-container *ngIf="!editandoCurriculo; else editorCurriculo">
                                    <p class="mt-4 whitespace-pre-wrap rounded-xl border border-surface-200 bg-surface-50 p-4 text-surface-700 dark:border-surface-700 dark:bg-surface-800 dark:text-surface-200">{{ valor(perfilUsuario.curriculo) }}</p>
                                </ng-container>

                                <ng-template #editorCurriculo>
                                    <div class="mt-4">
                                        <label for="perfilCurriculo" class="sr-only">Currículo</label>
                                        <textarea id="perfilCurriculo" name="perfilCurriculo" [(ngModel)]="curriculoEmEdicao" maxlength="10000" rows="8" class="w-full resize-y rounded-xl border border-surface-300 bg-white p-3 text-sm text-surface-900 outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 dark:border-surface-600 dark:bg-surface-800 dark:text-surface-100" aria-describedby="perfilCurriculoContador"></textarea>
                                        <div id="perfilCurriculoContador" class="mt-2 text-right text-xs text-surface-500">{{ curriculoEmEdicao.length }} / 10000 caracteres</div>
                                        <div class="mt-4 flex flex-col gap-3 sm:flex-row sm:justify-end">
                                            <button pButton type="button" label="Cancelar" class="p-button-outlined" (click)="cancelarEdicaoCurriculo()" [disabled]="salvandoCurriculo"></button>
                                            <button pButton type="button" label="Salvar currículo" icon="pi pi-save" (click)="salvarCurriculo()" [loading]="salvandoCurriculo" [disabled]="salvandoCurriculo"></button>
                                        </div>
                                    </div>
                                </ng-template>
                            </section>

                            <section *ngIf="perfilUsuario.idTipoUsuario === 2" class="mt-8" aria-labelledby="dados-festival">
                                <div class="grid gap-4 md:grid-cols-2 md:items-end">
                                    <div class="perfil-campo"><span>Número do concorrente</span><strong>{{ numeroConcorrente }}</strong></div>
                                    <h2 id="dados-festival" class="text-xl font-semibold text-surface-900 dark:text-white">Obra(s) Executada(s)</h2>
                                </div>
                                <div class="mt-4 grid gap-4 md:grid-cols-2">
                                    <div class="perfil-campo"><span>Primeira obra</span><strong>{{ valor(perfilConcorrente?.tituloObra1) }}</strong></div>
                                    <div class="perfil-campo"><span>Vídeo da primeira obra</span><a *ngIf="perfilConcorrente?.linkVideo1; else video1Ausente" [href]="perfilConcorrente!.linkVideo1" target="_blank" rel="noopener noreferrer">Abrir vídeo</a><ng-template #video1Ausente><strong>Não informado</strong></ng-template></div>
                                    <div class="perfil-campo"><span>Segunda obra (opcional)</span><strong>{{ valor(perfilConcorrente?.tituloObra2) }}</strong></div>
                                    <div class="perfil-campo"><span>Vídeo da segunda obra</span><a *ngIf="perfilConcorrente?.linkVideo2; else video2Ausente" [href]="perfilConcorrente!.linkVideo2" target="_blank" rel="noopener noreferrer">Abrir vídeo</a><ng-template #video2Ausente><strong>Não informado</strong></ng-template></div>
                                </div>
                            </section>
                            </ng-container>

                            <ng-template #formularioEdicao>
                                <form class="mt-8" (ngSubmit)="salvarPerfil()" novalidate>
                                    <div class="grid gap-4 md:grid-cols-2">
                                        <div class="md:col-span-2">
                                            <label for="perfilNome" class="mb-2 block text-sm font-medium text-surface-700 dark:text-surface-200">Nome</label>
                                            <input id="perfilNome" pInputText type="text" name="perfilNome" [(ngModel)]="formulario.nome" maxlength="255" class="w-full" />
                                        </div>
                                        <div>
                                            <label for="perfilEmail" class="mb-2 block text-sm font-medium text-surface-700 dark:text-surface-200">E-mail</label>
                                            <input id="perfilEmail" pInputText type="email" name="perfilEmail" [(ngModel)]="formulario.email" maxlength="255" class="w-full" />
                                        </div>
                                        <div>
                                            <label for="perfilCpf" class="mb-2 block text-sm font-medium text-surface-700 dark:text-surface-200">CPF</label>
                                            <p-inputMask id="perfilCpf" name="perfilCpf" [(ngModel)]="formulario.cpf" mask="999.999.999-99" placeholder="000.000.000-00" styleClass="w-full"></p-inputMask>
                                        </div>
                                        <div>
                                            <label for="perfilIdentidade" class="mb-2 block text-sm font-medium text-surface-700 dark:text-surface-200">Identidade</label>
                                            <input id="perfilIdentidade" pInputText type="text" name="perfilIdentidade" [(ngModel)]="formulario.identidade" maxlength="20" class="w-full" />
                                        </div>
                                        <div>
                                            <label for="perfilTelefone" class="mb-2 block text-sm font-medium text-surface-700 dark:text-surface-200">Telefone celular</label>
                                            <p-inputMask id="perfilTelefone" name="perfilTelefone" [(ngModel)]="formulario.telefoneCelular" mask="(99) 99999-9999" placeholder="(00) 00000-0000" styleClass="w-full"></p-inputMask>
                                        </div>
                                        <div>
                                            <label for="perfilDataNascimento" class="mb-2 block text-sm font-medium text-surface-700 dark:text-surface-200">Data de nascimento</label>
                                            <p-datepicker id="perfilDataNascimento" name="perfilDataNascimento" [(ngModel)]="dataNascimentoSelecionada" (input)="formatarEntradaDataNascimento($event)" (ngModelChange)="atualizarDataNascimento($event)" dateFormat="dd/mm/yy" [showIcon]="true" [maxDate]="hoje" placeholder="dd/mm/aaaa" styleClass="w-full"></p-datepicker>
                                        </div>
                                        <div>
                                            <label for="perfilCep" class="mb-2 block text-sm font-medium text-surface-700 dark:text-surface-200">CEP</label>
                                            <p-inputMask id="perfilCep" name="perfilCep" [(ngModel)]="formulario.cep" mask="99999-999" placeholder="00000-000" styleClass="w-full"></p-inputMask>
                                        </div>
                                        <div class="md:col-span-2">
                                            <label for="perfilLogradouro" class="mb-2 block text-sm font-medium text-surface-700 dark:text-surface-200">Logradouro</label>
                                            <input id="perfilLogradouro" pInputText type="text" name="perfilLogradouro" [(ngModel)]="formulario.logradouro" maxlength="255" class="w-full" />
                                        </div>
                                        <div>
                                            <label for="perfilNumero" class="mb-2 block text-sm font-medium text-surface-700 dark:text-surface-200">Número</label>
                                            <input id="perfilNumero" pInputText type="text" name="perfilNumero" [(ngModel)]="formulario.numero" maxlength="20" class="w-full" />
                                        </div>
                                        <div>
                                            <label for="perfilComplemento" class="mb-2 block text-sm font-medium text-surface-700 dark:text-surface-200">Complemento</label>
                                            <input id="perfilComplemento" pInputText type="text" name="perfilComplemento" [(ngModel)]="formulario.complemento" maxlength="100" class="w-full" />
                                        </div>
                                        <div>
                                            <label for="perfilBairro" class="mb-2 block text-sm font-medium text-surface-700 dark:text-surface-200">Bairro</label>
                                            <input id="perfilBairro" pInputText type="text" name="perfilBairro" [(ngModel)]="formulario.bairro" maxlength="100" class="w-full" />
                                        </div>
                                        <div>
                                            <label for="perfilCidade" class="mb-2 block text-sm font-medium text-surface-700 dark:text-surface-200">Cidade</label>
                                            <input id="perfilCidade" pInputText type="text" name="perfilCidade" [(ngModel)]="formulario.cidade" maxlength="100" class="w-full" />
                                        </div>
                                        <div>
                                            <label for="perfilUf" class="mb-2 block text-sm font-medium text-surface-700 dark:text-surface-200">UF</label>
                                            <p-select id="perfilUf" name="perfilUf" [(ngModel)]="formulario.uf" [options]="ufs" optionLabel="label" optionValue="value" placeholder="UF" styleClass="w-full"></p-select>
                                        </div>
                                    </div>

                                    <div class="mt-6 flex flex-col gap-3 md:flex-row md:justify-end">
                                        <button pButton type="button" label="Cancelar" class="p-button-outlined" (click)="cancelarEdicao()" [disabled]="salvandoPerfil"></button>
                                        <button pButton type="submit" label="Salvar" icon="pi pi-check" [loading]="salvandoPerfil" [disabled]="salvandoPerfil"></button>
                                    </div>
                                </form>
                            </ng-template>
                        </div>
                    </ng-container>
                </ng-template>

                <ng-template #naoAutenticado>
                    <div class="py-12 text-center">
                        <h1 class="text-3xl font-semibold text-surface-900 dark:text-white">Perfil</h1>
                        <p class="mt-4 text-surface-600 dark:text-surface-300">Faça login para acessar seu perfil.</p>
                        <a routerLink="/login" pButton label="Ir para o login" class="mt-6"></a>
                    </div>
                </ng-template>

                <ng-template #redirecionando>
                    <p class="py-12 text-center text-surface-600 dark:text-surface-300">Redirecionando para o perfil correto...</p>
                </ng-template>

                <p-confirmdialog [style]="{ width: '450px' }" />
            </main>
        </div>
    `,
    styles: [`
        .perfil-campo {
            display: flex;
            min-height: 4.25rem;
            flex-direction: column;
            justify-content: center;
            gap: 0.35rem;
            border: 1px solid var(--p-surface-200);
            border-radius: 0.75rem;
            padding: 0.75rem 1rem;
        }

        .perfil-campo span {
            color: var(--p-surface-700);
            font-size: 0.8rem;
            font-weight: 600;
        }

        .perfil-campo strong,
        .perfil-campo a {
            overflow-wrap: anywhere;
            color: var(--text-color-secondary);
            font-size: 0.95rem;
            font-weight: 700;
        }

        .perfil-campo a {
            color: var(--p-primary-color);
            text-decoration: underline;
        }

        :host-context(.dark) .perfil-campo {
            border-color: var(--p-surface-700);
        }

        :host-context(.dark) .perfil-campo strong {
            color: var(--p-surface-100);
        }
    `]
})
export class PerfilComponent implements OnInit, OnDestroy {
    readonly authService = inject(AuthService);
    @ViewChild(FotoEditorComponent) fotoEditor?: FotoEditorComponent;

    perfilTipo: CadastroTipo = 'diretoria';
    perfilTipoId = 0;
    usuario = this.authService.usuario();
    perfilUsuario: PerfilUsuario | null = null;
    perfilConcorrente: PerfilConcorrente | null = null;
    carregandoPerfil = true;
    erroPerfil: string | null = null;
    editando = false;
    salvandoPerfil = false;
    mensagemPerfil: string | null = null;
    tipoMensagemPerfil: 'success' | 'error' = 'error';
    editandoCurriculo = false;
    salvandoCurriculo = false;
    curriculoEmEdicao = '';
    mensagemCurriculo: string | null = null;
    tipoMensagemCurriculo: 'success' | 'error' = 'error';
    fotoUrl: string | null = null;
    fotoBlobPendente: Blob | null = null;
    previewFotoUrl: string | null = null;
    previewFotoTipo = '';
    previewFotoTamanho = 0;
    remocaoFotoPendente = false;
    fotoSalvando = false;
    fotoRemovendo = false;
    participacao: PerfilConcorrente = {
        idConcorrente: null,
        idObra1: null,
        tituloObra1: null,
        linkVideo1: null,
        idObra2: null,
        tituloObra2: null,
        linkVideo2: null,
        dataCadastro: null
    };
    obrasElegiveis: ObraElegivel[] = [];
    carregandoObras = false;
    salvandoParticipacao = false;
    mensagemParticipacao: string | null = null;
    tipoMensagemParticipacao: 'success' | 'error' = 'error';
    previewVideo1: SafeResourceUrl | null = null;
    previewVideo2: SafeResourceUrl | null = null;
    formulario: PerfilAtualizacaoPayload = {
        nome: '',
        email: '',
        cpf: '',
        identidade: '',
        telefoneCelular: '',
        dataNascimento: '',
        cep: '',
        logradouro: '',
        numero: '',
        complemento: '',
        bairro: '',
        cidade: '',
        uf: ''
    };
    dataNascimentoSelecionada: Date | null = null;
    private dataNascimentoEmEdicaoInvalida = false;
    readonly hoje = new Date();
    readonly ufs = UFS;
    private rotaCorrigida = false;

    constructor(
        private readonly route: ActivatedRoute,
        private readonly router: Router,
        private readonly perfilService: PerfilService,
        private readonly confirmationService: ConfirmationService,
        private readonly sanitizer: DomSanitizer
    ) {
        effect(() => {
            this.usuario = this.authService.usuario();
            const carregando = this.authService.carregando();

            if (!carregando) {
                this.verificarCompatibilidade();
            }
        });
    }

    get perfilLabel(): string {
        return PERFIL_LABELS[this.perfilTipo];
    }

    get tipoCompativel(): boolean {
        return !!this.usuario && this.usuario.id_tipo_usuario === this.perfilTipoId;
    }

    get podeEditarFoto(): boolean {
        return this.perfilUsuario !== null && [1, 2, 4].includes(this.perfilUsuario.idTipoUsuario);
    }

    get podeEditarCurriculo(): boolean {
        return this.perfilUsuario !== null && [1, 2, 4].includes(this.perfilUsuario.idTipoUsuario);
    }

    get numeroConcorrente(): string {
        const idUsuario = this.perfilUsuario?.idUsuario;
        return idUsuario === null || idUsuario === undefined ? 'Não informado' : String(idUsuario).padStart(3, '0');
    }

    ngOnInit(): void {
        this.route.data.subscribe((data) => {
            const perfilData = data as PerfilRouteData;
            this.perfilTipo = perfilData.perfilTipo;
            this.perfilTipoId = perfilData.perfilTipoId;
            this.verificarCompatibilidade();
        });

        void this.carregarPerfil();
    }

    alterarObra2(value: number | null | undefined): void {
        const idObra2 = value === null || value === undefined ? null : Number(value);

        if (this.participacao.idObra2 === idObra2) {
            return;
        }

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

    async salvarParticipacao(): Promise<void> {
        if (this.salvandoParticipacao) {
            return;
        }

        const linkVideo1 = (this.participacao.linkVideo1 || '').trim();
        if (!this.criarVideoEmbedUrl(linkVideo1)) {
            this.tipoMensagemParticipacao = 'error';
            this.mensagemParticipacao = 'Informe um vídeo HTTPS válido do YouTube ou Vimeo para a primeira obra.';
            return;
        }

        const idObra2 = this.participacao.idObra2 === null ? null : Number(this.participacao.idObra2);
        if (idObra2 !== null && !this.obrasElegiveis.some((obra) => obra.idObra === idObra2)) {
            this.tipoMensagemParticipacao = 'error';
            this.mensagemParticipacao = 'A segunda obra selecionada não é elegível.';
            return;
        }

        const linkVideo2 = idObra2 === null ? null : (this.participacao.linkVideo2 || '').trim();
        if (idObra2 !== null && !this.criarVideoEmbedUrl(linkVideo2 || '')) {
            this.tipoMensagemParticipacao = 'error';
            this.mensagemParticipacao = 'Informe um vídeo HTTPS válido do YouTube ou Vimeo para a segunda obra.';
            return;
        }

        const payload: ParticipacaoConcorrentePayload = {
            linkVideo1,
            idObra2,
            linkVideo2
        };

        this.salvandoParticipacao = true;
        this.mensagemParticipacao = null;

        try {
            const resposta = await this.perfilService.atualizarParticipacaoConcorrente(payload);
            this.aplicarParticipacao(resposta.concorrente);
            this.tipoMensagemParticipacao = 'success';
            this.mensagemParticipacao = resposta.message || 'Obras e vídeos atualizados com sucesso.';
        } catch (error) {
            this.tipoMensagemParticipacao = 'error';
            this.mensagemParticipacao = this.mensagemErroParticipacao(error);
        } finally {
            this.salvandoParticipacao = false;
        }
    }

    private async carregarObrasElegiveis(): Promise<void> {
        this.carregandoObras = true;

        try {
            this.obrasElegiveis = await this.perfilService.carregarObrasElegiveis();
        } catch {
            this.tipoMensagemParticipacao = 'error';
            this.mensagemParticipacao = 'Não foi possível carregar as obras elegíveis.';
        } finally {
            this.carregandoObras = false;
        }
    }

    private aplicarParticipacao(participacao: ParticipacaoConcorrente | null): void {
        this.participacao = {
            idConcorrente: participacao?.idConcorrente ?? null,
            idObra1: participacao?.idObra1 ?? null,
            tituloObra1: participacao?.tituloObra1 ?? null,
            linkVideo1: participacao?.linkVideo1 ?? null,
            idObra2: participacao?.idObra2 ?? null,
            tituloObra2: participacao?.tituloObra2 ?? null,
            linkVideo2: participacao?.linkVideo2 ?? null,
            dataCadastro: participacao?.dataCadastro ?? null
        };
        this.atualizarPreviewVideo1();
        this.atualizarPreviewVideo2();
    }

    private mensagemErroParticipacao(error: unknown): string {
        if (error instanceof PerfilServiceError) {
            if (error.status === 400) {
                return error.message || 'Verifique os dados das obras e vídeos.';
            }
            if (error.status === 401) {
                return 'Sua sessão expirou. Faça login novamente.';
            }
            if (error.status === 403) {
                return 'Esta seção está disponível apenas para concorrentes.';
            }
            if (error.status === 409) {
                return 'Cadastro de concorrente inconsistente.';
            }
        }

        return 'Não foi possível salvar as obras e vídeos. Tente novamente.';
    }

    private criarVideoEmbedUrl(url: string): SafeResourceUrl | null {
        const valor = this.extrairVideoEmbedUrl(url);
        return valor ? this.sanitizer.bypassSecurityTrustResourceUrl(valor) : null;
    }

    private extrairVideoEmbedUrl(url: string): string | null {
        try {
            const valor = new URL(url.trim());

            if (valor.protocol !== 'https:') {
                return null;
            }

            const hostname = valor.hostname.toLowerCase();
            let videoId: string | null = null;

            if (hostname === 'youtube.com' || hostname === 'www.youtube.com') {
                if (valor.pathname === '/watch') {
                    videoId = valor.searchParams.get('v');
                } else if (valor.pathname.startsWith('/shorts/') || valor.pathname.startsWith('/embed/')) {
                    videoId = valor.pathname.split('/')[2] || null;
                }

                return videoId && /^[A-Za-z0-9_-]{11}$/.test(videoId)
                    ? `https://www.youtube.com/embed/${videoId}`
                    : null;
            }

            if (hostname === 'youtu.be') {
                videoId = valor.pathname.split('/')[1] || null;
                return videoId && /^[A-Za-z0-9_-]{11}$/.test(videoId)
                    ? `https://www.youtube.com/embed/${videoId}`
                    : null;
            }

            if (hostname === 'vimeo.com' || hostname === 'www.vimeo.com') {
                videoId = valor.pathname.split('/')[1] || null;
                return videoId && /^\d+$/.test(videoId)
                    ? `https://player.vimeo.com/video/${videoId}`
                    : null;
            }

            return null;
        } catch {
            return null;
        }
    }

    iniciarEdicao(): void {
        if (!this.perfilUsuario) {
            return;
        }

        this.formulario = {
            nome: this.perfilUsuario.nome || '',
            email: this.perfilUsuario.email || '',
            cpf: this.perfilUsuario.cpf || '',
            identidade: this.perfilUsuario.identidade || '',
            telefoneCelular: this.perfilUsuario.telefoneCelular || '',
            dataNascimento: this.perfilUsuario.dataNascimento?.slice(0, 10) || '',
            cep: this.perfilUsuario.cep || '',
            logradouro: this.perfilUsuario.logradouro || '',
            numero: this.perfilUsuario.numero || '',
            complemento: this.perfilUsuario.complemento || '',
            bairro: this.perfilUsuario.bairro || '',
            cidade: this.perfilUsuario.cidade || '',
            uf: this.perfilUsuario.uf || ''
        };
        this.dataNascimentoSelecionada = this.criarDataNascimento(this.formulario.dataNascimento);
        this.dataNascimentoEmEdicaoInvalida = false;
        this.mensagemPerfil = null;
        this.editando = true;
    }

    cancelarEdicao(): void {
        this.editando = false;
        this.mensagemPerfil = null;
        this.dataNascimentoEmEdicaoInvalida = false;
    }

    receberFotoAplicada(blob: Blob): void {
        this.limparPreviewFoto();
        this.fotoBlobPendente = blob;
        this.previewFotoUrl = URL.createObjectURL(blob);
        this.previewFotoTipo = blob.type || 'desconhecido';
        this.previewFotoTamanho = blob.size;
        this.remocaoFotoPendente = false;
    }

    cancelarFotoTemporaria(): void {
        this.fotoBlobPendente = null;
        this.limparPreviewFoto();
        this.remocaoFotoPendente = false;
    }

    descartarFotoPendente(): void {
        this.fotoEditor?.cancelar();
    }

    solicitarRemocaoFoto(): void {
        this.confirmationService.confirm({
            header: 'Remover foto',
            message: 'Deseja remover sua foto de perfil?',
            icon: 'pi pi-exclamation-triangle',
            acceptLabel: 'Remover',
            rejectLabel: 'Cancelar',
            accept: () => void this.removerFoto()
        });
    }

    async salvarFoto(): Promise<void> {
        if (!this.fotoBlobPendente || this.fotoSalvando || this.fotoRemovendo) {
            return;
        }

        this.fotoSalvando = true;
        this.mensagemPerfil = null;

        try {
            const resultado = await this.perfilService.atualizarFoto(this.fotoBlobPendente);
            this.fotoUrl = resultado.fotoUrl;
            if (this.perfilUsuario) {
                this.perfilUsuario = {
                    ...this.perfilUsuario,
                    foto: resultado.foto,
                    fotoUrl: resultado.fotoUrl
                };
            }
            this.authService.atualizarFotoUsuarioLogado(resultado.fotoUrl);
            this.tipoMensagemPerfil = 'success';
            this.mensagemPerfil = resultado.message || 'Foto atualizada com sucesso.';
            this.fotoEditor?.cancelar();
        } catch (error) {
            this.tipoMensagemPerfil = 'error';
            this.mensagemPerfil = this.mensagemErroFoto(error, 'salvar');
        } finally {
            this.fotoSalvando = false;
        }
    }

    private async removerFoto(): Promise<void> {
        if (this.fotoRemovendo || this.fotoSalvando) {
            return;
        }

        this.fotoRemovendo = true;
        this.mensagemPerfil = null;

        try {
            const resultado = await this.perfilService.removerFoto();
            this.fotoUrl = null;
            if (this.perfilUsuario) {
                this.perfilUsuario = {
                    ...this.perfilUsuario,
                    foto: null,
                    fotoUrl: null
                };
            }
            this.authService.atualizarFotoUsuarioLogado(null);
            this.tipoMensagemPerfil = 'success';
            this.mensagemPerfil = resultado.message || 'Foto removida com sucesso.';
            this.fotoEditor?.cancelar();
        } catch (error) {
            this.tipoMensagemPerfil = 'error';
            this.mensagemPerfil = this.mensagemErroFoto(error, 'remover');
        } finally {
            this.fotoRemovendo = false;
        }
    }

    private mensagemErroFoto(error: unknown, operacao: 'salvar' | 'remover'): string {
        if (error instanceof PerfilServiceError) {
            if (error.status === 400) {
                return 'Não foi possível processar a imagem selecionada.';
            }
            if (error.status === 401) {
                return 'Sua sessão expirou. Faça login novamente.';
            }
            if (error.status === 413) {
                return 'A imagem excede o tamanho máximo permitido de 5 MB.';
            }
        }

        return operacao === 'salvar'
            ? 'Não foi possível salvar a foto. Tente novamente.'
            : 'Não foi possível remover a foto. Tente novamente.';
    }

    formatarTamanhoBlob(bytes: number): string {
        if (bytes < 1024) {
            return `${bytes} B`;
        }

        return `${(bytes / 1024).toFixed(1)} KB`;
    }

    iniciarEdicaoCurriculo(): void {
        this.curriculoEmEdicao = this.perfilUsuario?.curriculo || '';
        this.mensagemCurriculo = null;
        this.editandoCurriculo = true;
    }

    cancelarEdicaoCurriculo(): void {
        this.curriculoEmEdicao = this.perfilUsuario?.curriculo || '';
        this.mensagemCurriculo = null;
        this.editandoCurriculo = false;
    }

    async salvarCurriculo(): Promise<void> {
        if (this.salvandoCurriculo) {
            return;
        }

        if (this.curriculoEmEdicao.length > 10000) {
            this.tipoMensagemCurriculo = 'error';
            this.mensagemCurriculo = 'O currículo deve ter no máximo 10.000 caracteres.';
            return;
        }

        const curriculo = this.curriculoEmEdicao.trim() || null;
        this.salvandoCurriculo = true;
        this.mensagemCurriculo = null;

        try {
            const resposta = await this.perfilService.atualizarCurriculo(curriculo);
            if (this.perfilUsuario) {
                this.perfilUsuario = {
                    ...this.perfilUsuario,
                    curriculo: resposta.curriculo
                };
            }
            this.curriculoEmEdicao = resposta.curriculo || '';
            this.editandoCurriculo = false;
            this.tipoMensagemCurriculo = 'success';
            this.mensagemCurriculo = resposta.message || 'Currículo atualizado com sucesso.';
        } catch (error) {
            this.tipoMensagemCurriculo = 'error';
            this.mensagemCurriculo = this.mensagemErroCurriculo(error);
        } finally {
            this.salvandoCurriculo = false;
        }
    }

    private mensagemErroCurriculo(error: unknown): string {
        if (error instanceof PerfilServiceError) {
            if (error.status === 400) {
                return error.message || 'O currículo informado é inválido.';
            }
            if (error.status === 401) {
                return 'Sua sessão expirou. Faça login novamente.';
            }
            if (error.status === 403) {
                return 'Este tipo de usuário não possui currículo editável.';
            }
        }

        return 'Não foi possível salvar o currículo. Tente novamente.';
    }

    atualizarDataNascimento(value: Date | null): void {
        if (!value && this.dataNascimentoEmEdicaoInvalida) {
            return;
        }

        this.dataNascimentoEmEdicaoInvalida = false;
        this.dataNascimentoSelecionada = value;
        this.formulario.dataNascimento = this.formatarDataIso(value);
    }

    formatarEntradaDataNascimento(event: Event): void {
        const input = event.target as HTMLInputElement;
        const digits = input.value.replace(/\D/g, '').slice(0, 8);
        let formatted = digits;

        if (digits.length > 2) {
            formatted = `${digits.slice(0, 2)}/${digits.slice(2)}`;
        }

        if (digits.length > 4) {
            formatted = `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`;
        }

        input.value = formatted;

        if (digits.length === 0) {
            this.dataNascimentoEmEdicaoInvalida = false;
            this.dataNascimentoSelecionada = null;
            this.formulario.dataNascimento = '';
            return;
        }

        if (digits.length < 8) {
            this.dataNascimentoEmEdicaoInvalida = true;
            return;
        }

        const data = this.criarDataNascimentoPorDigitos(digits);
        this.dataNascimentoEmEdicaoInvalida = !data || data > this.hoje;

        if (data && !this.dataNascimentoEmEdicaoInvalida) {
            this.dataNascimentoSelecionada = data;
            this.formulario.dataNascimento = this.formatarDataIso(data);
        }
    }

    async salvarPerfil(): Promise<void> {
        this.mensagemPerfil = null;

        if (!this.validarFormulario()) {
            return;
        }

        this.salvandoPerfil = true;

        try {
            const resposta = await this.perfilService.atualizarPerfil(this.formulario);
            this.perfilUsuario = resposta.usuario;
            this.fotoUrl = resposta.usuario.fotoUrl ?? this.fotoUrl;
            this.authService.atualizarNomeUsuarioLogado(resposta.usuario.nome);
            this.editando = false;
            this.tipoMensagemPerfil = 'success';
            this.mensagemPerfil = resposta.message || 'Perfil atualizado com sucesso.';
        } catch (error) {
            this.tipoMensagemPerfil = 'error';
            if (error instanceof PerfilServiceError && error.status === 401) {
                this.mensagemPerfil = 'Sua sessão expirou. Faça login novamente para salvar o perfil.';
            } else if (error instanceof PerfilServiceError && error.status === 409) {
                this.mensagemPerfil = error.message;
            } else {
                this.mensagemPerfil = 'Não foi possível salvar seu perfil. Tente novamente mais tarde.';
            }
        } finally {
            this.salvandoPerfil = false;
        }
    }

    private validarFormulario(): boolean {
        const camposObrigatorios = [
            this.formulario.nome,
            this.formulario.email,
            this.formulario.cpf,
            this.formulario.telefoneCelular,
            this.formulario.dataNascimento,
            this.formulario.cep,
            this.formulario.logradouro,
            this.formulario.numero,
            this.formulario.bairro,
            this.formulario.cidade,
            this.formulario.uf
        ];

        if (camposObrigatorios.some((campo) => !campo.trim())) {
            this.mensagemPerfil = 'Preencha todos os campos obrigatórios.';
            return false;
        }

        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(this.formulario.email.trim())) {
            this.mensagemPerfil = 'Informe um e-mail válido.';
            return false;
        }

        if (!this.cpfValido(this.apenasDigitos(this.formulario.cpf))) {
            this.mensagemPerfil = 'CPF inválido.';
            return false;
        }

        const telefone = this.apenasDigitos(this.formulario.telefoneCelular);
        if (telefone.length !== 10 && telefone.length !== 11) {
            this.mensagemPerfil = 'Telefone celular inválido.';
            return false;
        }

        if (this.dataNascimentoEmEdicaoInvalida || !this.dataNascimentoSelecionada || !this.formulario.dataNascimento) {
            this.mensagemPerfil = 'Informe uma data de nascimento válida.';
            return false;
        }

        if (this.apenasDigitos(this.formulario.cep).length !== 8) {
            this.mensagemPerfil = 'CEP inválido.';
            return false;
        }

        return true;
    }

    private cpfValido(cpf: string): boolean {
        if (!/^\d{11}$/.test(cpf) || /^([0-9])\1{10}$/.test(cpf)) {
            return false;
        }

        let soma = 0;
        for (let indice = 0; indice < 9; indice += 1) {
            soma += Number(cpf[indice]) * (10 - indice);
        }

        let resto = (soma * 10) % 11;
        if (resto === 10) {
            resto = 0;
        }
        if (resto !== Number(cpf[9])) {
            return false;
        }

        soma = 0;
        for (let indice = 0; indice < 10; indice += 1) {
            soma += Number(cpf[indice]) * (11 - indice);
        }

        resto = (soma * 10) % 11;
        if (resto === 10) {
            resto = 0;
        }

        return resto === Number(cpf[10]);
    }

    private formatarDataIso(data: Date | null): string {
        if (!data) {
            return '';
        }

        return `${data.getFullYear()}-${String(data.getMonth() + 1).padStart(2, '0')}-${String(data.getDate()).padStart(2, '0')}`;
    }

    private criarDataNascimento(data: string): Date | null {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) {
            return null;
        }

        const partes = data.split('-').map(Number);
        const dataConvertida = new Date(partes[0], partes[1] - 1, partes[2]);
        return dataConvertida.getFullYear() === partes[0] && dataConvertida.getMonth() === partes[1] - 1 && dataConvertida.getDate() === partes[2]
            ? dataConvertida
            : null;
    }

    private criarDataNascimentoPorDigitos(digits: string): Date | null {
        const dia = Number(digits.slice(0, 2));
        const mes = Number(digits.slice(2, 4));
        const ano = Number(digits.slice(4, 8));
        const data = new Date(ano, mes - 1, dia);

        return data.getFullYear() === ano && data.getMonth() === mes - 1 && data.getDate() === dia ? data : null;
    }

    valor(value: string | number | null | undefined): string | number {
        return value === null || value === undefined || value === '' ? 'Não informado' : value;
    }

    formatarCpf(cpf: string | null): string {
        const digitos = this.apenasDigitos(cpf);
        return digitos.length === 11 ? digitos.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4') : this.valor(cpf).toString();
    }

    formatarTelefone(telefone: string | null): string {
        const digitos = this.apenasDigitos(telefone);
        if (digitos.length === 11) {
            return digitos.replace(/(\d{2})(\d{5})(\d{4})/, '($1) $2-$3');
        }
        if (digitos.length === 10) {
            return digitos.replace(/(\d{2})(\d{4})(\d{4})/, '($1) $2-$3');
        }
        return this.valor(telefone).toString();
    }

    formatarCep(cep: string | null): string {
        const digitos = this.apenasDigitos(cep);
        return digitos.length === 8 ? digitos.replace(/(\d{5})(\d{3})/, '$1-$2') : this.valor(cep).toString();
    }

    formatarData(data: string | null): string {
        if (!data) {
            return 'Não informado';
        }

        const dataIso = data.slice(0, 10);
        return /^\d{4}-\d{2}-\d{2}$/.test(dataIso) ? dataIso.split('-').reverse().join('/') : data;
    }

    private apenasDigitos(value: string | null): string {
        return (value || '').replace(/\D/g, '');
    }

    private async carregarPerfil(): Promise<void> {
        this.carregandoPerfil = true;
        this.erroPerfil = null;

        try {
            const perfil: PerfilResponse = await this.perfilService.obterPerfil();
            this.perfilUsuario = perfil.usuario;
            this.perfilConcorrente = perfil.concorrente;
            this.fotoUrl = perfil.usuario.fotoUrl;
            if (perfil.usuario.idTipoUsuario === 2) {
                this.aplicarParticipacao(perfil.concorrente);
                void this.carregarObrasElegiveis();
            }
        } catch (error) {
            if (error instanceof PerfilServiceError && error.status === 401) {
                this.erroPerfil = 'Sua sessão expirou. Faça login novamente para consultar o perfil.';
            } else {
                this.erroPerfil = 'Não foi possível carregar seu perfil. Tente novamente mais tarde.';
            }
        } finally {
            this.carregandoPerfil = false;
        }
    }

    ngOnDestroy(): void {
        this.limparPreviewFoto();
    }

    private limparPreviewFoto(): void {
        if (this.previewFotoUrl) {
            URL.revokeObjectURL(this.previewFotoUrl);
            this.previewFotoUrl = null;
        }

        this.previewFotoTipo = '';
        this.previewFotoTamanho = 0;
    }

    private verificarCompatibilidade(): void {
        if (!this.usuario || !this.perfilTipoId || this.usuario.id_tipo_usuario === this.perfilTipoId || this.rotaCorrigida) {
            return;
        }

        this.rotaCorrigida = true;
        const rotaCorreta = PERFIL_ROTAS[this.usuario.id_tipo_usuario];
        void this.router.navigate([rotaCorreta || '/']);
    }
}
