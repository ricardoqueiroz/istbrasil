import { Injectable } from '@angular/core';
import { CurriculoResposta, ObraElegivel, ParticipacaoConcorrentePayload, ParticipacaoConcorrenteResponse, PerfilAtualizacaoPayload, PerfilAtualizacaoResponse, PerfilFotoRespostaHttp, PerfilFotoResultado, PerfilResponse } from '../models/perfil.model';

export class PerfilServiceError extends Error {
    constructor(
        message: string,
        public readonly status: number
    ) {
        super(message);
        this.name = 'PerfilServiceError';
    }
}

@Injectable({ providedIn: 'root' })
export class PerfilService {
    async obterPerfil(): Promise<PerfilResponse> {
        let response: Response;

        try {
            response = await fetch('/api/usuarios/perfil', { credentials: 'include' });
        } catch {
            throw new PerfilServiceError('Não foi possível carregar o perfil.', 0);
        }

        if (!response.ok) {
            throw new PerfilServiceError(await this.obterMensagemErro(response, 'Não foi possível carregar o perfil.'), response.status);
        }

        return response.json() as Promise<PerfilResponse>;
    }

    async atualizarPerfil(payload: PerfilAtualizacaoPayload): Promise<PerfilAtualizacaoResponse> {
        let response: Response;

        try {
            response = await fetch('/api/usuarios/perfil', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify(payload)
            });
        } catch {
            throw new PerfilServiceError('Não foi possível salvar o perfil.', 0);
        }

        if (!response.ok) {
            throw new PerfilServiceError(await this.obterMensagemErro(response, 'Não foi possível salvar o perfil.'), response.status);
        }

        return response.json() as Promise<PerfilAtualizacaoResponse>;
    }

    async atualizarFoto(blob: Blob): Promise<PerfilFotoResultado> {
        const formData = new FormData();
        formData.append('foto', blob, 'foto.webp');

        let response: Response;

        try {
            response = await fetch('/api/usuarios/perfil/foto', {
                method: 'POST',
                credentials: 'include',
                body: formData
            });
        } catch {
            throw new PerfilServiceError('Não foi possível salvar a foto. Tente novamente.', 0);
        }

        if (!response.ok) {
            throw new PerfilServiceError(await this.obterMensagemErro(response, 'Não foi possível salvar a foto. Tente novamente.'), response.status);
        }

        const data = await response.json() as PerfilFotoRespostaHttp;
        return {
            message: data.message,
            foto: data.foto ?? null,
            fotoUrl: data.foto_url ?? null
        };
    }

    async removerFoto(): Promise<PerfilFotoResultado> {
        let response: Response;

        try {
            response = await fetch('/api/usuarios/perfil/foto', {
                method: 'DELETE',
                credentials: 'include'
            });
        } catch {
            throw new PerfilServiceError('Não foi possível remover a foto. Tente novamente.', 0);
        }

        if (!response.ok) {
            throw new PerfilServiceError(await this.obterMensagemErro(response, 'Não foi possível remover a foto. Tente novamente.'), response.status);
        }

        const data = await response.json() as PerfilFotoRespostaHttp;
        return {
            message: data.message,
            foto: data.foto ?? null,
            fotoUrl: data.foto_url ?? null
        };
    }

    async carregarObrasElegiveis(): Promise<ObraElegivel[]> {
        let response: Response;

        try {
            response = await fetch('/api/obra/composicoes-elegiveis');
        } catch {
            throw new PerfilServiceError('Não foi possível carregar as obras elegíveis.', 0);
        }

        if (!response.ok) {
            throw new PerfilServiceError('Não foi possível carregar as obras elegíveis.', response.status);
        }

        return response.json() as Promise<ObraElegivel[]>;
    }

    async atualizarParticipacaoConcorrente(payload: ParticipacaoConcorrentePayload): Promise<ParticipacaoConcorrenteResponse> {
        let response: Response;

        try {
            response = await fetch('/api/usuarios/perfil/concorrente/participacao', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify(payload)
            });
        } catch {
            throw new PerfilServiceError('Não foi possível salvar as obras e vídeos.', 0);
        }

        if (!response.ok) {
            throw new PerfilServiceError(await this.obterMensagemErro(response, 'Não foi possível salvar as obras e vídeos.'), response.status);
        }

        return response.json() as Promise<ParticipacaoConcorrenteResponse>;
    }

    async atualizarCurriculo(curriculo: string | null): Promise<CurriculoResposta> {
        let response: Response;

        try {
            response = await fetch('/api/usuarios/perfil/curriculo', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ curriculo })
            });
        } catch {
            throw new PerfilServiceError('Não foi possível salvar o currículo. Tente novamente.', 0);
        }

        if (!response.ok) {
            throw new PerfilServiceError(await this.obterMensagemErro(response, 'Não foi possível salvar o currículo. Tente novamente.'), response.status);
        }

        return response.json() as Promise<CurriculoResposta>;
    }

    private async obterMensagemErro(response: Response, mensagemPadrao: string): Promise<string> {
        const data = await response.json().catch(() => null) as { message?: unknown } | null;
        return typeof data?.message === 'string' ? data.message : mensagemPadrao;
    }
}
