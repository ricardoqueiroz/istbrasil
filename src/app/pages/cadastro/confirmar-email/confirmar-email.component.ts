import { CommonModule } from '@angular/common';
import { Component, OnInit } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';

type Estado = 'verificando' | 'sucesso' | 'expirado' | 'invalido' | 'erro';

@Component({
    selector: 'app-confirmar-email',
    standalone: true,
    imports: [CommonModule, RouterLink, ButtonModule],
    template: `
        <div class="flex items-center justify-center py-12 px-4">
            <div class="w-full max-w-xl rounded-3xl border border-surface-200 bg-white p-8 text-center shadow-2xl dark:border-surface-700 dark:bg-surface-900">
                <h1 class="mb-6 text-3xl font-semibold text-surface-900 dark:text-white">Confirmação de E-mail</h1>

                <div *ngIf="estado === 'verificando'" class="text-surface-600 dark:text-surface-300">
                    Verificando seu token de confirmação...
                </div>

                <div *ngIf="estado === 'sucesso'" class="rounded-md border border-green-200 bg-green-50 px-3 py-3 text-sm text-green-700">
                    {{ mensagem }}
                </div>

                <div *ngIf="estado === 'expirado'" class="rounded-md border border-yellow-200 bg-yellow-50 px-3 py-3 text-sm text-yellow-700">
                    {{ mensagem }}
                </div>

                <div *ngIf="estado === 'invalido' || estado === 'erro'" class="rounded-md border border-red-200 bg-red-50 px-3 py-3 text-sm text-red-700">
                    {{ mensagem }}
                </div>

                <div class="mt-8">
                    <a routerLink="/cadastro/diretoria/login" pButton label="Ir para o login"></a>
                </div>
            </div>
        </div>
    `
})
export class ConfirmarEmailComponent implements OnInit {
    estado: Estado = 'verificando';
    mensagem = '';

    constructor(private readonly route: ActivatedRoute) {}

    ngOnInit(): void {
        const token = this.route.snapshot.queryParamMap.get('token');

        if (!token) {
            this.estado = 'invalido';
            this.mensagem = 'Token não informado. Verifique o link recebido por e-mail.';
            return;
        }

        this.confirmar(token);
    }

    private async confirmar(token: string): Promise<void> {
        try {
            const response = await fetch(`/api/usuarios/confirmar-email?token=${encodeURIComponent(token)}`);
            const data = await response.json().catch(() => ({}));

            if (response.status === 200) {
                this.estado = 'sucesso';
                this.mensagem = data?.message || 'E-mail confirmado com sucesso.';
                return;
            }

            if (response.status === 410) {
                this.estado = 'expirado';
                this.mensagem = data?.message || 'Token expirado. Solicite um novo e-mail de confirmação.';
                return;
            }

            this.estado = 'invalido';
            this.mensagem = data?.message || 'Token inválido.';
        } catch {
            this.estado = 'erro';
            this.mensagem = 'Erro ao confirmar e-mail. Tente novamente.';
        }
    }
}
