import { CommonModule } from '@angular/common';
import { Component } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { CheckboxModule } from 'primeng/checkbox';
import { InputTextModule } from 'primeng/inputtext';
import { PasswordModule } from 'primeng/password';

@Component({
    selector: 'app-diretoria-login',
    standalone: true,
    imports: [CommonModule, FormsModule, RouterLink, ButtonModule, CheckboxModule, InputTextModule, PasswordModule],
    template: `
        <div class="min-h-screen flex items-center justify-center bg-surface-100 dark:bg-surface-950 px-4">
            <div class="w-full max-w-xl rounded-3xl border border-surface-200 bg-white p-8 shadow-2xl dark:border-surface-700 dark:bg-surface-900">
                <div class="mb-8 text-center">
                    <h1 class="text-3xl font-semibold text-surface-900 dark:text-white">Cadastro de Diretoria</h1>
                </div>

                <input type="hidden" name="id_tipo_usuario" [value]="idTipoUsuario" />

                <form (ngSubmit)="login()" novalidate>
                    <div class="mb-5">
                        <label for="email" class="mb-2 block text-sm font-medium text-surface-700 dark:text-surface-200">E-mail</label>
                        <input
                            id="email"
                            pInputText
                            type="email"
                            name="email"
                            [(ngModel)]="email"
                            placeholder="Digite seu e-mail"
                            class="w-full"
                            autocomplete="email"
                            required
                        />
                    </div>

                    <div class="mb-5">
                        <label for="password" class="mb-2 block text-sm font-medium text-surface-700 dark:text-surface-200">Senha</label>
                        <p-password
                            id="password"
                            name="password"
                            [(ngModel)]="password"
                            [toggleMask]="true"
                            [feedback]="false"
                            styleClass="w-full"
                            inputStyleClass="w-full"
                            placeholder="Digite sua senha"
                            autocomplete="current-password"
                        ></p-password>
                    </div>

                    <div class="mb-5 flex items-center justify-between gap-3">
                        <label for="manterConectado" class="flex items-center gap-2 text-sm text-surface-700 dark:text-surface-200">
                            <p-checkbox id="manterConectado" name="manterConectado" [(ngModel)]="manterConectado" [binary]="true"></p-checkbox>
                            Manter Conectado?
                        </label>
                    </div>

                    <button
                        pButton
                        type="submit"
                        label="Login"
                        class="w-full"
                        [disabled]="isLoading"
                    ></button>

                    <div *ngIf="mensagem" class="mt-4 rounded-md border px-3 py-2 text-sm" [ngClass]="{
                        'border-red-200 bg-red-50 text-red-700': tipoMensagem === 'error',
                        'border-green-200 bg-green-50 text-green-700': tipoMensagem === 'success',
                        'border-blue-200 bg-blue-50 text-blue-700': tipoMensagem === 'info'
                    }">
                        {{ mensagem }}
                    </div>

                    <div class="mt-6 text-center">
                        <a routerLink="/cadastro/diretoria/cadastro" class="text-sm font-medium text-primary hover:underline">
                            Não tem conta? Cadastrar.
                        </a>
                    </div>
                </form>
            </div>
        </div>
    `
})
export class DiretoriaLoginComponent {
    idTipoUsuario = '1';
    email = '';
    password = '';
    manterConectado = false;
    isLoading = false;
    mensagem = '';
    tipoMensagem: 'success' | 'error' | 'info' = 'info';

    constructor(private readonly router: Router) {}

    validarCampos(): boolean {
        return !!this.email?.trim() && !!this.password?.trim();
    }

    async criptografarSenha(valor: string): Promise<string> {
        const texto = valor.trim();

        if (typeof crypto !== 'undefined' && crypto.subtle) {
            const buffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(texto));
            return Array.from(new Uint8Array(buffer))
                .map((byte) => byte.toString(16).padStart(2, '0'))
                .join('');
        }

        return texto;
    }

    async login(): Promise<void> {
        this.mensagem = '';

        if (!this.validarCampos()) {
            this.tipoMensagem = 'error';
            this.mensagem = 'Preencha e-mail e senha para continuar.';
            return;
        }

        this.isLoading = true;
        this.tipoMensagem = 'info';
        this.mensagem = 'Consultando banco de dados...';

        try {
            const senhaCriptografada = await this.criptografarSenha(this.password);

            const response = await fetch('/api/usuarios/login', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    id_tipo_usuario: Number(this.idTipoUsuario),
                    email: this.email.trim(),
                    senha: senhaCriptografada
                })
            });

            const data = await response.json();

            if (!response.ok) {
                if (response.status === 404) {
                    this.tipoMensagem = 'error';
                    this.mensagem = 'E-mail não cadastrado.';
                    return;
                }

                this.tipoMensagem = 'error';
                this.mensagem = data?.message || 'Senha ou e-mail inválido.';
                return;
            }

            this.tipoMensagem = 'success';
            this.mensagem = 'Login realizado com sucesso.';
            await this.router.navigate(['/cadastro/diretoria/cadastro']);
        } catch (error) {
            this.tipoMensagem = 'error';
            this.mensagem = 'Erro ao consultar o banco de dados. Tente novamente.';
        } finally {
            this.isLoading = false;
        }
    }
}
