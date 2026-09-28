import { Injectable } from '@angular/core';
import { EmailModelo, EmailModeloAtualizacaoPayload, EmailModeloPayload } from './modelos.model';
import { EmailPlaceholdersResposta, EmailPreviewResultado } from './preview.model';

export class EmailModeloServiceError extends Error {
    constructor(
        message: string,
        public readonly status: number
    ) {
        super(message);
        this.name = 'EmailModeloServiceError';
    }
}

@Injectable({ providedIn: 'root' })
export class ModelosService {
    private readonly baseUrl = '/api/admin/emails/modelos';

    async listar(): Promise<EmailModelo[]> {
        return this.requisitar<EmailModelo[]>(this.baseUrl);
    }

    async obter(idModelo: number): Promise<EmailModelo> {
        return this.requisitar<EmailModelo>(`${this.baseUrl}/${idModelo}`);
    }

    async criar(payload: EmailModeloPayload): Promise<EmailModelo> {
        return this.requisitar<EmailModelo>(this.baseUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(this.payloadCriacaoParaApi(payload))
        });
    }

    async atualizar(idModelo: number, payload: EmailModeloAtualizacaoPayload): Promise<EmailModelo> {
        return this.requisitar<EmailModelo>(`${this.baseUrl}/${idModelo}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(this.payloadAtualizacaoParaApi(payload))
        });
    }

    async obterPlaceholders(idModelo: number): Promise<EmailPlaceholdersResposta> {
        return this.requisitar<EmailPlaceholdersResposta>(`${this.baseUrl}/${idModelo}/placeholders`);
    }

    async gerarPreview(idModelo: number, variaveis: Record<string, string>): Promise<EmailPreviewResultado> {
        return this.requisitar<EmailPreviewResultado>(`${this.baseUrl}/${idModelo}/preview`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ variaveis })
        });
    }

    private payloadCriacaoParaApi(payload: EmailModeloPayload) {
        return {
            chave: payload.chave,
            nome: payload.nome,
            assunto: payload.assunto,
            conteudo_html: payload.conteudoHtml,
            id_assinatura: payload.idAssinatura,
            ativo: payload.ativo
        };
    }

    private payloadAtualizacaoParaApi(payload: EmailModeloAtualizacaoPayload) {
        return {
            nome: payload.nome,
            assunto: payload.assunto,
            conteudo_html: payload.conteudoHtml,
            id_assinatura: payload.idAssinatura,
            ativo: payload.ativo
        };
    }

    private async requisitar<T>(url: string, init?: RequestInit): Promise<T> {
        let response: Response;
        try {
            response = await fetch(url, { ...init, credentials: 'include' });
        } catch {
            throw new EmailModeloServiceError('Não foi possível comunicar com o servidor.', 0);
        }

        const data = await response.json().catch(() => null) as (T & { message?: string }) | null;
        if (!response.ok) {
            throw new EmailModeloServiceError(data?.message || 'Não foi possível concluir a operação.', response.status);
        }
        return data as T;
    }
}
