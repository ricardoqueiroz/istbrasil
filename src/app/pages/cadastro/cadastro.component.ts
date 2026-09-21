import { CommonModule } from '@angular/common';
import { Component, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { DatePickerModule } from 'primeng/datepicker';
import { InputMaskModule } from 'primeng/inputmask';
import { InputTextModule } from 'primeng/inputtext';
import { PasswordModule } from 'primeng/password';
import { SelectModule } from 'primeng/select';
import { EnderecoService } from 'src/app/shared/endereco.service';
import { sha256 } from 'src/app/shared/crypto.util';

interface Cargo {
    id_cargo: number;
    nome_cargo: string;
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
                    <h1 class="text-3xl font-semibold text-surface-900 dark:text-white">Cadastro</h1>
                    <p class="mt-2 text-sm text-surface-500">Etapa {{ step }} de 2</p>
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

                    <div class="mb-5">
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
                        <button pButton type="submit" label="Finalizar Cadastro" class="w-full" [disabled]="isLoading"></button>
                    </div>
                </form>
            </div>
        </div>
    `
})
export class DiretoriaCadastroComponent implements OnInit {
    step = 1;
    isLoading = false;
    mensagem = '';
    tipoMensagem: 'success' | 'error' | 'info' = 'info';

    // Passo 1
    nome = '';
    email = '';
    confirmarEmail = '';

    // Passo 2
    cpf = '';
    telefoneCelular = '';
    idCargo: number | null = null;
    identidade = '';
    dataNascimento: Date | null = null;
    hoje = new Date();
    senha = '';
    confirmarSenha = '';
    logradouro = '';
    numero = '';
    complemento = '';
    bairro = '';
    cidade = '';
    uf = '';
    cep = '';
    cidadeBloqueada = false;
    ufBloqueada = false;

    cargos: Cargo[] = [];
    ufs = UFS;

    constructor(
        private readonly router: Router,
        private readonly enderecoService: EnderecoService
    ) {}

    ngOnInit(): void {
        this.carregarCargos();
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
        this.step = 1;
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

            this.step = 2;
        } catch {
            this.tipoMensagem = 'error';
            this.mensagem = 'Erro ao verificar o e-mail. Tente novamente.';
        } finally {
            this.isLoading = false;
        }
    }

    async finalizarCadastro(): Promise<void> {
        this.mensagem = '';

        if (!this.cpf.trim() || !this.telefoneCelular.trim() || !this.idCargo || !this.senha.trim() || !this.confirmarSenha.trim()) {
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
        this.mensagem = 'Enviando cadastro...';

        try {
            const senhaCriptografada = await sha256(this.senha);

            const response = await fetch('/api/usuarios/cadastro', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    nome: this.nome.trim(),
                    email: this.email.trim(),
                    confirmarEmail: this.confirmarEmail.trim(),
                    cpf: this.cpf,
                    telefone_celular: this.telefoneCelular,
                    senha: senhaCriptografada,
                    id_cargo: this.idCargo,
                    identidade: this.identidade,
                    data_nascimento: this.formatarDataIso(this.dataNascimento),
                    logradouro: this.logradouro,
                    numero: this.numero,
                    complemento: this.complemento,
                    bairro: this.bairro,
                    cidade: this.cidade,
                    uf: this.uf,
                    cep: this.cep
                })
            });

            const data = await response.json();

            if (!response.ok) {
                this.tipoMensagem = 'error';
                this.mensagem = data?.message || 'Não foi possível concluir o cadastro.';
                return;
            }

            this.tipoMensagem = 'success';
            this.mensagem = 'Cadastro realizado com sucesso! Redirecionando para o login...';
            setTimeout(() => this.router.navigate(['/cadastro/diretoria/login']), 1500);
        } catch {
            this.tipoMensagem = 'error';
            this.mensagem = 'Erro ao enviar o cadastro. Tente novamente.';
        } finally {
            this.isLoading = false;
        }
    }
}
