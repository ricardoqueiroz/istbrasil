import { CommonModule } from '@angular/common';
import { Component, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { DatePickerModule } from 'primeng/datepicker';
import { InputMaskModule } from 'primeng/inputmask';
import { InputTextModule } from 'primeng/inputtext';
import { PasswordModule } from 'primeng/password';
import { SelectModule } from 'primeng/select';
import { CadastroTipo, isCadastroTipo, OBRA_PRINCIPAL_CONCORRENTE } from './models/cadastro.model';
import { CadastroStateService } from './services/cadastro-state.service';
import { EnderecoService } from 'src/app/shared/endereco.service';
import { sha256 } from 'src/app/shared/crypto.util';

interface Cargo {
    id_cargo: number;
    nome_cargo: string;
}

interface ObraOption {
    idObra: number;
    titulo: string;
}

interface UfOption {
    label: string;
    value: string;
}

const UFS: UfOption[] = [
    { label: 'AC', value: 'AC' }, { label: 'AL', value: 'AL' }, { label: 'AP', value: 'AP' }, { label: 'AM', value: 'AM' },
    { label: 'BA', value: 'BA' }, { label: 'CE', value: 'CE' }, { label: 'DF', value: 'DF' }, { label: 'ES', value: 'ES' },
    { label: 'GO', value: 'GO' }, { label: 'MA', value: 'MA' }, { label: 'MT', value: 'MT' }, { label: 'MS', value: 'MS' },
    { label: 'MG', value: 'MG' }, { label: 'PA', value: 'PA' }, { label: 'PB', value: 'PB' }, { label: 'PR', value: 'PR' },
    { label: 'PE', value: 'PE' }, { label: 'PI', value: 'PI' }, { label: 'RJ', value: 'RJ' }, { label: 'RN', value: 'RN' },
    { label: 'RS', value: 'RS' }, { label: 'RO', value: 'RO' }, { label: 'RR', value: 'RR' }, { label: 'SC', value: 'SC' },
    { label: 'SP', value: 'SP' }, { label: 'SE', value: 'SE' }, { label: 'TO', value: 'TO' }
];

@Component({
    selector: 'app-diretoria-cadastro',
    standalone: true,
    imports: [CommonModule, FormsModule, RouterLink, ButtonModule, InputTextModule, PasswordModule, SelectModule, InputMaskModule, DatePickerModule],
    template: `
        <div class="flex items-center justify-center py-12 px-4">
            <div class="w-full max-w-2xl rounded-3xl border border-surface-200 bg-white p-8 shadow-2xl dark:border-surface-700 dark:bg-surface-900">
                <div class="mb-8 text-center">
                    <h1 class="text-3xl font-semibold text-surface-900 dark:text-white">{{ tituloCadastro }}</h1>
                    <p class="mt-2 text-sm text-surface-500">Etapa {{ step }} de {{ totalEtapasVisiveis }}</p>
                </div>

                <div *ngIf="mensagem" class="mb-6 rounded-md border px-3 py-2 text-sm" [ngClass]="{
                    'border-red-200 bg-red-50 text-red-700': tipoMensagem === 'error',
                    'border-green-200 bg-green-50 text-green-700': tipoMensagem === 'success',
                    'border-blue-200 bg-blue-50 text-blue-700': tipoMensagem === 'info'
                }">
                    {{ mensagem }}
                </div>

                <!-- Passo 1: confirmação de nome e e-mail -->
                <form *ngIf="step === 1" (ngSubmit)="confirmarPasso1()" novalidate>
                    <div class="mb-5">
                        <label for="nome" class="mb-2 block text-sm font-medium text-surface-700 dark:text-surface-200">Nome completo</label>
                        <input id="nome" pInputText type="text" name="nome" [(ngModel)]="nome" placeholder="Seu nome completo" class="w-full" required />
                    </div>

                    <div class="mb-5">
                        <label for="email" class="mb-2 block text-sm font-medium text-surface-700 dark:text-surface-200">E-mail</label>
                        <input id="email" pInputText type="email" name="email" [(ngModel)]="email" placeholder="seuemail@exemplo.com" class="w-full" required />
                    </div>

                    <div class="mb-5">
                        <label for="confirmarEmail" class="mb-2 block text-sm font-medium text-surface-700 dark:text-surface-200">Confirme o e-mail</label>
                        <input id="confirmarEmail" pInputText type="email" name="confirmarEmail" [(ngModel)]="confirmarEmail" placeholder="Digite o e-mail novamente" class="w-full" required />
                    </div>

                    <button pButton type="submit" label="Confirmar e Continuar" class="w-full" [disabled]="isLoading"></button>

                    <div class="mt-6 text-center">
                        <a routerLink="/login" class="text-sm font-medium text-primary hover:underline">Já tem conta? Fazer login.</a>
                    </div>
                </form>

                <!-- Passo 2: dados completos -->
                <form *ngIf="step === 2" (ngSubmit)="finalizarCadastro()" novalidate>
                    <div class="mb-5 rounded-md bg-surface-100 dark:bg-surface-800 px-3 py-2 text-sm text-surface-600 dark:text-surface-300">
                        <strong>{{ nome }}</strong> &lt;{{ email }}&gt;
                        <button type="button" class="ml-2 text-primary hover:underline" (click)="voltarPasso1()">alterar</button>
                    </div>

                    <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-5">
                        <div>
                            <label for="cpf" class="mb-2 block text-sm font-medium text-surface-700 dark:text-surface-200">CPF</label>
                            <p-inputMask id="cpf" name="cpf" [(ngModel)]="cpf" mask="999.999.999-99" placeholder="000.000.000-00" styleClass="w-full" [required]="true"></p-inputMask>
                        </div>
                        <div>
                            <label for="telefone" class="mb-2 block text-sm font-medium text-surface-700 dark:text-surface-200">Celular</label>
                            <p-inputMask id="telefone" name="telefone" [(ngModel)]="telefoneCelular" mask="(99) 99999-9999" placeholder="(00) 00000-0000" styleClass="w-full" [required]="true"></p-inputMask>
                        </div>
                    </div>

                    <div *ngIf="usaCargo" class="mb-5">
                        <label for="cargo" class="mb-2 block text-sm font-medium text-surface-700 dark:text-surface-200">Cargo na Diretoria</label>
                        <p-select id="cargo" name="cargo" [(ngModel)]="idCargo" [options]="cargos" optionLabel="nome_cargo" optionValue="id_cargo" placeholder="Selecione o cargo" styleClass="w-full" [required]="true"></p-select>
                    </div>

                    <div class="mb-5">
                        <label for="identidade" class="mb-2 block text-sm font-medium text-surface-700 dark:text-surface-200">RG / Identidade (opcional)</label>
                        <input id="identidade" pInputText type="text" name="identidade" [(ngModel)]="identidade" maxlength="20" class="w-full" />
                    </div>

                    <div class="mb-5">
                        <label for="dataNascimento" class="mb-2 block text-sm font-medium text-surface-700 dark:text-surface-200">Data de Nascimento</label>
                        <p-datepicker id="dataNascimento" name="dataNascimento" [(ngModel)]="dataNascimento" dateFormat="dd/mm/yy" [showIcon]="true" [maxDate]="hoje" placeholder="dd/mm/aaaa" styleClass="w-full" [required]="true"></p-datepicker>
                    </div>

                    <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-5">
                        <div>
                            <label for="senha" class="mb-2 block text-sm font-medium text-surface-700 dark:text-surface-200">Senha</label>
                            <p-password id="senha" name="senha" [(ngModel)]="senha" [toggleMask]="true" styleClass="w-full" inputStyleClass="w-full" placeholder="Mínimo 8 caracteres"></p-password>
                        </div>
                        <div>
                            <label for="confirmarSenha" class="mb-2 block text-sm font-medium text-surface-700 dark:text-surface-200">Confirme a senha</label>
                            <p-password id="confirmarSenha" name="confirmarSenha" [(ngModel)]="confirmarSenha" [toggleMask]="true" [feedback]="false" styleClass="w-full" inputStyleClass="w-full" placeholder="Repita a senha"></p-password>
                        </div>
                    </div>

                    <p class="mb-3 text-sm font-medium text-surface-700 dark:text-surface-200">Endereço Completo:</p>
                    <div class="grid grid-cols-1 md:grid-cols-3 gap-4 mb-5">
                        <div>
                            <label for="cep" class="mb-2 block text-sm text-surface-600 dark:text-surface-300">CEP</label>
                            <p-inputMask id="cep" name="cep" [(ngModel)]="cep" mask="99999-999" placeholder="00000-000" styleClass="w-full" (onComplete)="consultarCep()"></p-inputMask>
                        </div>
                        <div class="md:col-span-2">
                            <label for="logradouro" class="mb-2 block text-sm text-surface-600 dark:text-surface-300">Logradouro</label>
                            <input id="logradouro" pInputText type="text" name="logradouro" [(ngModel)]="logradouro" class="w-full" />
                        </div>
                        <div>
                            <label for="numero" class="mb-2 block text-sm text-surface-600 dark:text-surface-300">Número</label>
                            <input id="numero" pInputText type="text" name="numero" [(ngModel)]="numero" class="w-full" />
                        </div>
                        <div>
                            <label for="complemento" class="mb-2 block text-sm text-surface-600 dark:text-surface-300">Complemento</label>
                            <input id="complemento" pInputText type="text" name="complemento" [(ngModel)]="complemento" class="w-full" />
                        </div>
                        <div>
                            <label for="bairro" class="mb-2 block text-sm text-surface-600 dark:text-surface-300">Bairro</label>
                            <input id="bairro" pInputText type="text" name="bairro" [(ngModel)]="bairro" class="w-full" />
                        </div>
                        <div>
                            <label for="cidade" class="mb-2 block text-sm text-surface-600 dark:text-surface-300">Cidade</label>
                            <input id="cidade" pInputText type="text" name="cidade" [(ngModel)]="cidade" class="w-full" [disabled]="cidadeBloqueada" />
                        </div>
                        <div>
                            <label for="uf" class="mb-2 block text-sm text-surface-600 dark:text-surface-300">UF</label>
                            <p-select id="uf" name="uf" [(ngModel)]="uf" [options]="ufs" optionLabel="label" optionValue="value" placeholder="UF" styleClass="w-full" [disabled]="ufBloqueada"></p-select>
                        </div>
                    </div>

                    <div class="flex gap-3">
                        <button pButton type="button" label="Voltar" class="w-full p-button-outlined" (click)="voltarPasso1()" [disabled]="isLoading"></button>
                        <button pButton type="submit" label="Continuar" class="w-full" [disabled]="isLoading"></button>
                    </div>
                </form>

                <!-- Passo 3: dados complementares opcionais -->
                <form *ngIf="step === 3" (ngSubmit)="concluirEtapa3()" novalidate>
                    <div class="mb-5">
                        <label for="foto" class="mb-2 block text-sm font-medium text-surface-700 dark:text-surface-200">Foto (opcional)</label>
                        <input id="foto" name="foto" type="file" accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp" (change)="selecionarFoto($event)" class="w-full text-sm text-surface-600" />
                        <p class="mt-1 text-xs text-surface-500">JPG, JPEG, PNG ou WEBP. Máximo de 5 MB.</p>
                    </div>

                    <div class="mb-5">
                        <label for="curriculo" class="mb-2 block text-sm font-medium text-surface-700 dark:text-surface-200">Currículo (opcional)</label>
                        <textarea id="curriculo" name="curriculo" [(ngModel)]="curriculo" rows="5" class="w-full rounded-md border border-surface-300 p-3 text-sm" placeholder="Escreva um breve currículo"></textarea>
                    </div>

                    <ng-container *ngIf="tipoCadastro === 'concorrente'">
                        <div class="mb-5">
                            <label for="obra1" class="mb-2 block text-sm font-medium text-surface-700 dark:text-surface-200">Primeira obra</label>
                            <p-select id="obra1" name="obra1" [options]="[obraPrincipal]" optionLabel="titulo" optionValue="idObra" [ngModel]="obraPrincipal.idObra" [disabled]="true" styleClass="w-full"></p-select>
                        </div>

                        <div class="mb-5">
                            <label for="linkVideo1" class="mb-2 block text-sm font-medium text-surface-700 dark:text-surface-200">Vídeo da primeira obra</label>
                            <input id="linkVideo1" pInputText type="url" name="linkVideo1" [(ngModel)]="linkVideo1" placeholder="https://www.youtube.com/... ou https://vimeo.com/..." class="w-full" />
                        </div>

                        <div class="mb-5">
                            <label for="obra2" class="mb-2 block text-sm font-medium text-surface-700 dark:text-surface-200">Segunda obra</label>
                            <p-select id="obra2" name="obra2" [options]="obrasSecundarias" optionLabel="titulo" optionValue="idObra" [(ngModel)]="segundaObraSelecionada" styleClass="w-full"></p-select>
                            <p class="mt-1 text-xs text-surface-500">As opções de obras serão disponibilizadas após a criação do endpoint correspondente.</p>
                        </div>

                        <div class="mb-5">
                            <label for="linkVideo2" class="mb-2 block text-sm font-medium text-surface-700 dark:text-surface-200">Vídeo da segunda obra</label>
                            <input id="linkVideo2" pInputText type="url" name="linkVideo2" [(ngModel)]="linkVideo2" [disabled]="idObra2 === null" placeholder="https://www.youtube.com/... ou https://vimeo.com/..." class="w-full" />
                        </div>
                    </ng-container>

                    <div class="flex flex-col gap-3 md:flex-row">
                        <button pButton type="button" label="Voltar" class="w-full p-button-outlined" (click)="voltarEtapa3()" [disabled]="isLoading"></button>
                        <button pButton type="button" label="Pular esta etapa" class="w-full p-button-outlined" (click)="pularEtapa3()" [disabled]="isLoading"></button>
                        <button pButton type="submit" label="Concluir cadastro" class="w-full" [disabled]="isLoading"></button>
                    </div>
                </form>
            </div>
        </div>
    `
})
export class CadastroComponent implements OnInit {
    isLoading = false;
    cadastroBasicoConcluido = false;
    mensagem = '';
    tipoMensagem: 'success' | 'error' | 'info' = 'info';
    hoje = new Date();
    cidadeBloqueada = false;
    ufBloqueada = false;
    fotoSelecionada: File | null = null;
    readonly obraPrincipal = OBRA_PRINCIPAL_CONCORRENTE;
    readonly obrasSecundarias: ObraOption[] = [{ idObra: 0, titulo: 'Selecione a segunda obra (opcional)' }];

    cargos: Cargo[] = [];
    ufs = UFS;

    get step(): number {
        return this.cadastroStateService.etapaAtual();
    }

    get tipoCadastro(): CadastroTipo {
        return this.cadastroStateService.tipo();
    }

    get totalEtapasVisiveis(): number {
        return this.cadastroStateService.totalEtapas();
    }

    get tituloCadastro(): string {
        const titulos: Record<CadastroTipo, string> = {
            diretoria: 'Cadastro da Diretoria',
            concorrente: 'Cadastro de Concorrente',
            externo: 'Cadastro de Usuário Externo',
            colaborador: 'Cadastro de Colaborador'
        };

        return titulos[this.tipoCadastro];
    }

    get usaCargo(): boolean {
        return this.tipoCadastro === 'diretoria' || this.tipoCadastro === 'colaborador';
    }

    get nome(): string { return this.cadastroStateService.identificacao().nome; }
    set nome(value: string) { this.cadastroStateService.atualizarIdentificacao({ nome: value }); }
    get email(): string { return this.cadastroStateService.identificacao().email; }
    set email(value: string) { this.cadastroStateService.atualizarIdentificacao({ email: value }); }
    get confirmarEmail(): string { return this.cadastroStateService.identificacao().confirmarEmail; }
    set confirmarEmail(value: string) { this.cadastroStateService.atualizarIdentificacao({ confirmarEmail: value }); }
    get cpf(): string { return this.cadastroStateService.dadosPessoais().cpf; }
    set cpf(value: string) { this.cadastroStateService.atualizarDadosPessoais({ cpf: value }); }
    get telefoneCelular(): string { return this.cadastroStateService.dadosPessoais().telefoneCelular; }
    set telefoneCelular(value: string) { this.cadastroStateService.atualizarDadosPessoais({ telefoneCelular: value }); }
    get idCargo(): number | null { return this.cadastroStateService.dadosPessoais().idCargo; }
    set idCargo(value: number | null) { this.cadastroStateService.atualizarDadosPessoais({ idCargo: this.usaCargo ? value : null }); }
    get identidade(): string { return this.cadastroStateService.dadosPessoais().identidade; }
    set identidade(value: string) { this.cadastroStateService.atualizarDadosPessoais({ identidade: value }); }
    get dataNascimento(): Date | null {
        const value = this.cadastroStateService.dadosPessoais().dataNascimento;
        return value ? new Date(`${value}T00:00:00`) : null;
    }
    set dataNascimento(value: Date | null) {
        this.cadastroStateService.atualizarDadosPessoais({ dataNascimento: this.formatarDataIso(value) || '' });
    }
    get senha(): string { return this.cadastroStateService.dadosPessoais().senha; }
    set senha(value: string) { this.cadastroStateService.atualizarDadosPessoais({ senha: value }); }
    get confirmarSenha(): string { return this.cadastroStateService.dadosPessoais().confirmarSenha; }
    set confirmarSenha(value: string) { this.cadastroStateService.atualizarDadosPessoais({ confirmarSenha: value }); }
    get logradouro(): string { return this.cadastroStateService.dadosPessoais().logradouro; }
    set logradouro(value: string) { this.cadastroStateService.atualizarDadosPessoais({ logradouro: value }); }
    get numero(): string { return this.cadastroStateService.dadosPessoais().numero; }
    set numero(value: string) { this.cadastroStateService.atualizarDadosPessoais({ numero: value }); }
    get complemento(): string { return this.cadastroStateService.dadosPessoais().complemento; }
    set complemento(value: string) { this.cadastroStateService.atualizarDadosPessoais({ complemento: value }); }
    get bairro(): string { return this.cadastroStateService.dadosPessoais().bairro; }
    set bairro(value: string) { this.cadastroStateService.atualizarDadosPessoais({ bairro: value }); }
    get cidade(): string { return this.cadastroStateService.dadosPessoais().cidade; }
    set cidade(value: string) { this.cadastroStateService.atualizarDadosPessoais({ cidade: value }); }
    get uf(): string { return this.cadastroStateService.dadosPessoais().uf; }
    set uf(value: string) { this.cadastroStateService.atualizarDadosPessoais({ uf: value }); }
    get cep(): string { return this.cadastroStateService.dadosPessoais().cep; }
    set cep(value: string) { this.cadastroStateService.atualizarDadosPessoais({ cep: value }); }
    get curriculo(): string { return this.cadastroStateService.dadosComplementares().curriculo; }
    set curriculo(value: string) { this.cadastroStateService.atualizarDadosComplementares({ curriculo: value }); }
    get idObra1(): number | null { return this.cadastroStateService.dadosComplementares().idObra1; }
    get linkVideo1(): string { return this.cadastroStateService.dadosComplementares().linkVideo1; }
    set linkVideo1(value: string) { this.cadastroStateService.atualizarDadosComplementares({ linkVideo1: value }); }
    get idObra2(): number | null { return this.cadastroStateService.dadosComplementares().idObra2; }
    get segundaObraSelecionada(): number { return this.idObra2 ?? 0; }
    set segundaObraSelecionada(value: number) {
        const idObra = Number(value);

        if (!idObra || idObra === this.obraPrincipal.idObra) {
            this.cadastroStateService.atualizarDadosComplementares({ idObra2: null, linkVideo2: '' });
            return;
        }

        this.cadastroStateService.atualizarDadosComplementares({ idObra2: idObra });
    }
    get linkVideo2(): string { return this.cadastroStateService.dadosComplementares().linkVideo2; }
    set linkVideo2(value: string) { this.cadastroStateService.atualizarDadosComplementares({ linkVideo2: value }); }

    constructor(
        private readonly router: Router,
        private readonly route: ActivatedRoute,
        private readonly enderecoService: EnderecoService,
        private readonly cadastroStateService: CadastroStateService
    ) {}

    ngOnInit(): void {
        this.carregarCargos();

        this.route.data.subscribe(({ cadastroTipo }) => {
            if (!isCadastroTipo(cadastroTipo)) {
                return;
            }

            const estadoAtual = this.cadastroStateService.getEstado();

            if (estadoAtual.tipo === cadastroTipo) {
                this.inicializarEtapa3();
                return;
            }

            this.cadastroStateService.setTipo(cadastroTipo);
            this.inicializarEtapa3();
        });
    }

    private async carregarCargos(): Promise<void> {
        try {
            const response = await fetch('/api/usuarios/cargos');
            if (response.ok) {
                this.cargos = await response.json();
            }
        } catch {
            // Silencioso: o select ficará vazio e o usuário pode tentar novamente ao reenviar o formulário
        }
    }

    private formatarDataIso(data: Date | null): string | null {
        if (!data) {
            return null;
        }

        const ano = data.getFullYear();
        const mes = String(data.getMonth() + 1).padStart(2, '0');
        const dia = String(data.getDate()).padStart(2, '0');

        return `${ano}-${mes}-${dia}`;
    }

    voltarPasso1(): void {
            this.cadastroStateService.setEtapaAtual(1);
        this.mensagem = '';
    }

    voltarEtapa3(): void {
        this.cadastroStateService.setEtapaAtual(2);
        this.mensagem = '';
    }

    private inicializarEtapa3(): void {
        if (this.tipoCadastro === 'concorrente' && this.idObra1 !== this.obraPrincipal.idObra) {
            this.cadastroStateService.atualizarDadosComplementares({ idObra1: this.obraPrincipal.idObra });
        }
    }

    selecionarFoto(event: Event): void {
        const input = event.target as HTMLInputElement;
        const arquivo = input.files?.[0] ?? null;

        if (!arquivo) {
            this.fotoSelecionada = null;
            return;
        }

        const extensaoValida = /\.(jpe?g|png|webp)$/i.test(arquivo.name);
        const tipoValido = ['image/jpeg', 'image/png', 'image/webp'].includes(arquivo.type);

        if (!extensaoValida || !tipoValido) {
            this.fotoSelecionada = null;
            input.value = '';
            this.tipoMensagem = 'error';
            this.mensagem = 'Selecione uma imagem JPG, JPEG, PNG ou WEBP.';
            return;
        }

        if (arquivo.size > 5 * 1024 * 1024) {
            this.fotoSelecionada = null;
            input.value = '';
            this.tipoMensagem = 'error';
            this.mensagem = 'A foto deve ter no máximo 5 MB.';
            return;
        }

        this.fotoSelecionada = arquivo;
        this.mensagem = '';
    }

    async consultarCep(): Promise<void> {
        try {
            const endereco = await this.enderecoService.consultarCep(this.cep);

            if (!endereco) {
                this.cidadeBloqueada = false;
                this.ufBloqueada = false;
                this.tipoMensagem = 'error';
                this.mensagem = 'CEP não encontrado. Preencha o endereço manualmente.';
                return;
            }

            this.logradouro = endereco.logradouro || this.logradouro;
            this.bairro = endereco.bairro || this.bairro;
            this.cidade = endereco.localidade;
            this.uf = endereco.uf;
            this.cidadeBloqueada = true;
            this.ufBloqueada = true;
            this.mensagem = '';
        } catch {
            this.cidadeBloqueada = false;
            this.ufBloqueada = false;
            this.tipoMensagem = 'error';
            this.mensagem = 'Não foi possível consultar o CEP. Preencha o endereço manualmente.';
        }
    }

    async confirmarPasso1(): Promise<void> {
        this.mensagem = '';

        if (!this.nome.trim() || !this.email.trim() || !this.confirmarEmail.trim()) {
            this.tipoMensagem = 'error';
            this.mensagem = 'Preencha nome, e-mail e a confirmação de e-mail.';
            return;
        }

        if (this.email.trim().toLowerCase() !== this.confirmarEmail.trim().toLowerCase()) {
            this.tipoMensagem = 'error';
            this.mensagem = 'Os e-mails informados não coincidem.';
            return;
        }

        this.isLoading = true;

        try {
            const response = await fetch(`/api/usuarios/verificar-email?email=${encodeURIComponent(this.email.trim())}`);
            const data = await response.json();

            if (!response.ok) {
                this.tipoMensagem = 'error';
                this.mensagem = data?.message || 'Não foi possível verificar o e-mail. Tente novamente.';
                return;
            }

            if (!data.disponivel) {
                this.tipoMensagem = 'error';
                this.mensagem = 'Este e-mail já está cadastrado. Faça login ou recupere sua senha.';
                return;
            }

            this.cadastroStateService.setEtapaAtual(2);
        } catch {
            this.tipoMensagem = 'error';
            this.mensagem = 'Erro ao verificar o e-mail. Tente novamente.';
        } finally {
            this.isLoading = false;
        }
    }

    async finalizarCadastro(): Promise<void> {
        this.mensagem = '';

        if (this.cadastroBasicoConcluido) {
            this.tipoMensagem = 'info';
            this.mensagem = 'A conta já foi criada. A Etapa 3 é complementar e opcional.';
            return;
        }

        if (!this.cpf.trim() || !this.telefoneCelular.trim() || (this.usaCargo && !this.idCargo) || !this.senha.trim() || !this.confirmarSenha.trim() || !this.cep.trim() || !this.logradouro.trim() || !this.numero.trim() || !this.bairro.trim() || !this.cidade.trim() || !this.uf.trim()) {
            this.tipoMensagem = 'error';
            this.mensagem = 'Preencha todos os campos obrigatórios.';
            return;
        }

        if (!this.dataNascimento) {
            this.tipoMensagem = 'error';
            this.mensagem = 'Informe a data de nascimento.';
            return;
        }

        if (this.dataNascimento > this.hoje) {
            this.tipoMensagem = 'error';
            this.mensagem = 'A data de nascimento não pode ser no futuro.';
            return;
        }

        if (this.senha.length < 8) {
            this.tipoMensagem = 'error';
            this.mensagem = 'A senha deve ter no mínimo 8 caracteres.';
            return;
        }

        if (this.senha !== this.confirmarSenha) {
            this.tipoMensagem = 'error';
            this.mensagem = 'As senhas informadas não coincidem.';
            return;
        }

        this.isLoading = true;
        this.tipoMensagem = 'info';
        this.mensagem = 'Criando cadastro...';

        try {
            const senhaCriptografada = await sha256(this.senha);
            const payload: Record<string, unknown> = {
                cadastroTipo: this.tipoCadastro,
                nome: this.nome.trim(),
                email: this.email.trim(),
                confirmarEmail: this.confirmarEmail.trim(),
                cpf: this.cpf,
                telefone_celular: this.telefoneCelular,
                senha: senhaCriptografada,
                identidade: this.identidade,
                data_nascimento: this.formatarDataIso(this.dataNascimento),
                logradouro: this.logradouro,
                numero: this.numero,
                complemento: this.complemento,
                bairro: this.bairro,
                cidade: this.cidade,
                uf: this.uf,
                cep: this.cep
            };

            if (this.usaCargo) {
                payload.id_cargo = this.idCargo;
            }

            const response = await fetch('/api/usuarios/cadastro', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const data = await response.json().catch(() => ({}));

            if (!response.ok) {
                this.tipoMensagem = 'error';
                this.mensagem = data?.message || (response.status === 409 ? 'Este e-mail ou CPF já está cadastrado.' : 'Não foi possível concluir o cadastro.');
                return;
            }

            this.cadastroBasicoConcluido = true;

            if (this.totalEtapasVisiveis === 3) {
                this.inicializarEtapa3();
                this.cadastroStateService.setEtapaAtual(3);
                this.tipoMensagem = 'success';
                this.mensagem = 'Conta criada com sucesso. A Etapa 3 é complementar e opcional.';
                return;
            }

            this.tipoMensagem = 'success';
            this.mensagem = 'Cadastro realizado com sucesso! Redirecionando para o login...';
            setTimeout(() => this.router.navigate(['/login']), 2000);
        } catch {
            this.tipoMensagem = 'error';
            this.mensagem = 'Erro ao enviar o cadastro. Tente novamente.';
        } finally {
            this.isLoading = false;
        }
    }

    private validarUrlVideo(url: string): boolean {
        try {
            const valor = new URL(url);
            return valor.protocol === 'https:' && (valor.hostname === 'youtube.com' || valor.hostname.endsWith('.youtube.com') || valor.hostname === 'youtu.be' || valor.hostname === 'vimeo.com' || valor.hostname.endsWith('.vimeo.com'));
        } catch {
            return false;
        }
    }

    private validarEtapa3(): boolean {
        if (this.tipoCadastro !== 'concorrente') {
            return true;
        }

        if (this.idObra1 !== this.obraPrincipal.idObra) {
            this.tipoMensagem = 'error';
            this.mensagem = 'A primeira obra deve ser Catraias.';
            return false;
        }

        if (!this.linkVideo1.trim() || !this.validarUrlVideo(this.linkVideo1.trim())) {
            this.tipoMensagem = 'error';
            this.mensagem = 'Informe um vídeo HTTPS válido do YouTube ou Vimeo para a primeira obra.';
            return false;
        }

        if (this.idObra2 === this.obraPrincipal.idObra) {
            this.tipoMensagem = 'error';
            this.mensagem = 'A segunda obra deve ser diferente da primeira.';
            return false;
        }

        if (this.idObra2 !== null && (!this.linkVideo2.trim() || !this.validarUrlVideo(this.linkVideo2.trim()))) {
            this.tipoMensagem = 'error';
            this.mensagem = 'Informe um vídeo HTTPS válido do YouTube ou Vimeo para a segunda obra.';
            return false;
        }

        return true;
    }

    concluirEtapa3(): void {
        this.mensagem = '';

        if (!this.validarEtapa3()) {
            return;
        }

        this.bloquearSubmissaoTemporaria('A conta já foi criada. Os dados complementares foram validados, mas ainda não são persistidos nesta fase.');
    }

    pularEtapa3(): void {
        if (!this.cadastroBasicoConcluido) {
            this.bloquearSubmissaoTemporaria('A conta básica ainda não foi criada.');
            return;
        }

        this.tipoMensagem = 'success';
        this.mensagem = 'Cadastro realizado com sucesso! Redirecionando para o login...';
        setTimeout(() => this.router.navigate(['/login']), 2000);
    }

    private bloquearSubmissaoTemporaria(mensagem = 'A conclusão deste tipo de cadastro será habilitada após a adaptação do backend.'): void {
        this.tipoMensagem = 'info';
        this.mensagem = mensagem;
    }
}
