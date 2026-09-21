import { Injectable, signal } from '@angular/core';

export interface UsuarioLogado {
    id_usuario: number;
    id_tipo_usuario: number;
    nome: string;
    foto_url: string | null;
}

@Injectable({ providedIn: 'root' })
export class AuthService {
    readonly usuario = signal<UsuarioLogado | null>(null);
    readonly carregando = signal<boolean>(true);

    async verificarSessao(): Promise<void> {
        this.carregando.set(true);

        try {
            const response = await fetch('/api/usuarios/me', { credentials: 'include' });

            if (response.ok) {
                const data = await response.json();
                this.usuario.set(data);
            } else {
                this.usuario.set(null);
            }
        } catch {
            this.usuario.set(null);
        } finally {
            this.carregando.set(false);
        }
    }

    definirUsuario(usuario: UsuarioLogado): void {
        this.usuario.set(usuario);
    }

    async logout(): Promise<void> {
        try {
            await fetch('/api/usuarios/logout', { method: 'POST', credentials: 'include' });
        } finally {
            this.usuario.set(null);
        }
    }
}
