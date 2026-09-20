import { CommonModule } from '@angular/common';
import { Component } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';

@Component({
    selector: 'app-diretoria-esqueci-senha',
    standalone: true,
    imports: [CommonModule, FormsModule, RouterLink, ButtonModule, InputTextModule],
    template: `
        <div class="flex items-center justify-center py-12 px-4">
            <div class="w-full max-w-xl rounded-3xl border border-surface-200 bg-white p-8 shadow-2xl dark:border-surface-700 dark:bg-surface-900">
                <div class="mb-8 text-center">
                    <h1 class="text-3xl font-semibold text-surface-900 dark:text-white">Esqueci a Senha</h1>
                    <p class="mt-2 text-sm text-surface-500">Informe seu e-mail para receber o link de redefinição.</p>
                </div>

                <div *ngIf="mensagem" class="mb-6 rounded-md border px-3 py-2 text-sm" [ngClass]="{
                    'border-red-200 bg-red-50 text-red-700': tipoMensagem === 'error',
                    'border-green-200 bg-green-50 text-green-700': tipoMensagem === 'success',
                    'border-blue-200 bg-blue-50 text-blue-700': tipoMensagem === 'info'
                }">
                    {{ mensagem }}
                </div>

                <form (ngSubmit)="enviar()" novalidate>
                    <div class="mb-5">
                        <label for="email" class="mb-2 block text-sm font-medium text-surface-700 dark:text-surface-200">E-mail</label>
                        <input id="email" pInputText type="email" name="email" [(ngModel)]="email" placeholder="Digite seu e-mail cadastrado" class="w-full" required />
                    </div>

                    <button pButton type="submit" label="Enviar link de redefinição" class="w-full" [disabled]="isLoading"></button>

                    <div class="mt-6 text-center">
                        <a routerLink="/cadastro/diretoria/login" class="text-sm font-medium text-primary hover:underline">Voltar para o login</a>
                    </div>
                </form>
            </div>
        </div>
    `
})
export class DiretoriaEsqueciSenhaComponent {
    email = '';
    isLoading = false;
    mensagem = '';
    tipoMensagem: 'success' | 'error' | 'info' = 'info';

    async enviar(): Promise<void> {
        this.mensagem = '';

        if (!this.email.trim()) {
            this.tipoMensagem = 'error';
            this.mensagem = 'Informe o e-mail cadastrado.';
            return;
        }

        this.isLoading = true;

        try {
            const response = await fetch('/api/usuarios/esqueci-senha', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: this.email.trim() })
            });

            const data = await response.json().catch(() => ({}));

            if (!response.ok) {
                this.tipoMensagem = 'error';
                this.mensagem = data?.message || 'Não foi possível enviar o e-mail de redefinição.';
                return;
            }

            this.tipoMensagem = 'success';
            this.mensagem = data?.message || 'E-mail de redefinição enviado. Verifique sua caixa de entrada.';
        } catch {
            this.tipoMensagem = 'error';
            this.mensagem = 'Erro ao enviar o e-mail. Tente novamente.';
        } finally {
            this.isLoading = false;
        }
    }
}
