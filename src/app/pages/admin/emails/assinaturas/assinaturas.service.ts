import { Injectable } from '@angular/core';
import { EmailAssinatura, EmailAssinaturaPayload } from './assinaturas.model';

export class EmailAssinaturaServiceError extends Error {
    constructor(
        message: string,
        public readonly status: number
    ) {
        super(message);
        this.name = 'EmailAssinaturaServiceError';
    }
}

@Injectable({ providedIn: 'root' })
export class AssinaturasService {
    private readonly baseUrl = '/api/admin/emails/assinaturas';

    async listar(): Promise<EmailAssinatura[]> {
        return this.requisitar<EmailAssinatura[]>(this.baseUrl);
    }

    async criar(payload: EmailAssinaturaPayload): Promise<EmailAssinatura> {
        return this.requisitar<EmailAssinatura>(this.baseUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(this.payloadParaApi(payload))
        });
    }

    async atualizar(idAssinatura: number, payload: EmailAssinaturaPayload): Promise<EmailAssinatura> {
        return this.requisitar<EmailAssinatura>(`${this.baseUrl}/${idAssinatura}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(this.payloadParaApi(payload))
        });
    }

    private payloadParaApi(payload: EmailAssinaturaPayload): { nome: string; conteudo_html: string; ativo: boolean } {
        return {
            nome: payload.nome,
            conteudo_html: payload.conteudoHtml,
            ativo: payload.ativo
        };
    }

    private async requisitar<T>(url: string, init?: RequestInit): Promise<T> {
        let response: Response;

        try {
            response = await fetch(url, { ...init, credentials: 'include' });
        } catch {
            throw new EmailAssinaturaServiceError('Não foi possível comunicar com o servidor.', 0);
        }

        const data = await response.json().catch(() => null) as (T & { message?: string }) | null;
        if (!response.ok) {
            throw new EmailAssinaturaServiceError(data?.message || 'Não foi possível concluir a operação.', response.status);
        }

        return data as T;
    }
}
