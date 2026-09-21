import { CommonModule } from '@angular/common';
import { Component, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { PasswordModule } from 'primeng/password';
import { sha256 } from 'src/app/shared/crypto.util';

type Estado = 'verificando' | 'valido' | 'expirado' | 'invalido';

@Component({
    selector: 'app-redefinir-senha',
    standalone: true,
    imports: [CommonModule, FormsModule, RouterLink, ButtonModule, PasswordModule],
    template: `
        <div class="flex items-center justify-center py-12 px-4">
            <div class="w-full max-w-xl rounded-3xl border border-surface-200 bg-white p-8 shadow-2xl dark:border-surface-700 dark:bg-surface-900">
                <div class="mb-8 text-center">
                    <h1 class="text-3xl font-semibold text-surface-900 dark:text-white">Redefinir Senha</h1>
                </div>

                <div *ngIf="estado === 'verificando'" class="text-center text-surface-600 dark:text-surface-300">
                    Verificando o link de redefinição...
                </div>

                <div *ngIf="estado === 'expirado' || estado === 'invalido'" class="rounded-md border border-red-200 bg-red-50 px-3 py-3 text-sm text-red-700">
                    {{ mensagem }}
                    <div class="mt-4 text-center">
                        <a routerLink="/esqueci-senha" class="text-sm font-medium text-primary hover:underline">Solicitar novo link</a>
                    </div>
                </div>

                <form *ngIf="estado === 'valido'" (ngSubmit)="redefinir()" novalidate>
                    <div *ngIf="mensagem" class="mb-5 rounded-md border px-3 py-2 text-sm" [ngClass]="{
                        'border-red-200 bg-red-50 text-red-700': tipoMensagem === 'error',
                        'border-green-200 bg-green-50 text-green-700': tipoMensagem === 'success'
                    }">
                        {{ mensagem }}
                    </div>

                    <div class="mb-5">
                        <label for="novaSenha" class="mb-2 block text-sm font-medium text-surface-700 dark:text-surface-200">Nova senha</label>
                        <p-password id="novaSenha" name="novaSenha" [(ngModel)]="novaSenha" [toggleMask]="true" styleClass="w-full" inputStyleClass="w-full" placeholder="Mínimo 8 caracteres"></p-password>
                    </div>

                    <div class="mb-5">
                        <label for="confirmarSenha" class="mb-2 block text-sm font-medium text-surface-700 dark:text-surface-200">Confirme a nova senha</label>
                        <p-password id="confirmarSenha" name="confirmarSenha" [(ngModel)]="confirmarSenha" [toggleMask]="true" [feedback]="false" styleClass="w-full" inputStyleClass="w-full" placeholder="Repita a senha"></p-password>
                    </div>

                    <button pButton type="submit" label="Redefinir senha" class="w-full" [disabled]="isLoading"></button>
                </form>
            </div>
        </div>
    `
})
export class RedefinirSenhaComponent implements OnInit {
    estado: Estado = 'verificando';
    mensagem = '';
    tipoMensagem: 'success' | 'error' = 'error';
    isLoading = false;
    novaSenha = '';
    confirmarSenha = '';
    private token = '';

    constructor(
        private readonly route: ActivatedRoute,
        private readonly router: Router
    ) {}

    ngOnInit(): void {
        this.token = this.route.snapshot.queryParamMap.get('token') || '';

        if (!this.token) {
            this.estado = 'invalido';
            this.mensagem = 'Token não informado. Verifique o link recebido por e-mail.';
            return;
        }

        this.validarToken();
    }

    private async validarToken(): Promise<void> {
        try {
            const response = await fetch(`/api/usuarios/validar-token-senha?token=${encodeURIComponent(this.token)}`);
            const data = await response.json().catch(() => ({}));

            if (response.status === 200) {
                this.estado = 'valido';
                return;
            }

            this.estado = response.status === 410 ? 'expirado' : 'invalido';
            this.mensagem = data?.message || 'Token inválido.';
        } catch {
            this.estado = 'invalido';
            this.mensagem = 'Erro ao validar o token. Tente novamente.';
        }
    }

    async redefinir(): Promise<void> {
        this.mensagem = '';

        if (!this.novaSenha.trim() || !this.confirmarSenha.trim()) {
            this.tipoMensagem = 'error';
            this.mensagem = 'Preencha a nova senha e a confirmação.';
            return;
        }

        if (this.novaSenha.length < 8) {
            this.tipoMensagem = 'error';
            this.mensagem = 'A senha deve ter no mínimo 8 caracteres.';
            return;
        }

        if (this.novaSenha !== this.confirmarSenha) {
            this.tipoMensagem = 'error';
            this.mensagem = 'As senhas informadas não coincidem.';
            return;
        }

        this.isLoading = true;

        try {
            const novaSenhaCriptografada = await sha256(this.novaSenha);

            const response = await fetch('/api/usuarios/redefinir-senha', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token: this.token, novaSenha: novaSenhaCriptografada })
            });

            const data = await response.json().catch(() => ({}));

            if (!response.ok) {
                this.tipoMensagem = 'error';
                this.mensagem = data?.message || 'Não foi possível redefinir a senha.';
                return;
            }

            this.tipoMensagem = 'success';
            this.mensagem = 'Senha redefinida com sucesso! Redirecionando para o login...';
            setTimeout(() => this.router.navigate(['/cadastro/diretoria/login']), 1500);
        } catch {
            this.tipoMensagem = 'error';
            this.mensagem = 'Erro ao redefinir a senha. Tente novamente.';
        } finally {
            this.isLoading = false;
        }
    }
}
