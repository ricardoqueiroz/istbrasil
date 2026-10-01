import { Injectable } from '@angular/core';
import {
    SituacaoAdmin,
    UsuarioAdminAtualizacaoPayload,
    UsuarioAdminDetalheResponse,
    UsuariosAdminFiltros,
    UsuariosAdminOpcoes,
    UsuariosAdminResponse
} from './cadastros.model';

export class CadastrosAdminServiceError extends Error {
    constructor(
        message: string,
        public readonly status: number
    ) {
        super(message);
        this.name = 'CadastrosAdminServiceError';
    }
}

@Injectable({ providedIn: 'root' })
export class CadastrosAdminService {
    private readonly baseUrl = '/api/admin/usuarios';

    async listarUsuarios(filtros: UsuariosAdminFiltros): Promise<UsuariosAdminResponse> {
        const params = new URLSearchParams({
            page: String(filtros.page),
            limit: String(filtros.limit)
        });

        if (filtros.search) params.set('search', filtros.search);
        if (filtros.idTipoUsuario) params.set('idTipoUsuario', String(filtros.idTipoUsuario));
        if (filtros.idCargo) params.set('idCargo', String(filtros.idCargo));
        if (filtros.idSituacao) params.set('idSituacao', String(filtros.idSituacao));
        if (filtros.sortField) params.set('sortField', filtros.sortField);
        if (filtros.sortOrder) params.set('sortOrder', filtros.sortOrder);

        return this.requisitar<UsuariosAdminResponse>(`${this.baseUrl}?${params.toString()}`);
    }

    async listarOpcoes(): Promise<UsuariosAdminOpcoes> {
        return this.requisitar<UsuariosAdminOpcoes>(`${this.baseUrl}/opcoes`);
    }

    async listarSituacoes(idTipoUsuario: number): Promise<SituacaoAdmin[]> {
        const params = new URLSearchParams({ idTipoUsuario: String(idTipoUsuario) });
        return this.requisitar<SituacaoAdmin[]>(`${this.baseUrl}/situacoes?${params.toString()}`);
    }

    async obterUsuario(idUsuario: number): Promise<UsuarioAdminDetalheResponse> {
        return this.requisitar<UsuarioAdminDetalheResponse>(`${this.baseUrl}/${idUsuario}`);
    }

    async atualizarUsuario(idUsuario: number, payload: UsuarioAdminAtualizacaoPayload): Promise<UsuarioAdminDetalheResponse> {
        return this.requisitar<UsuarioAdminDetalheResponse>(`${this.baseUrl}/${idUsuario}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
    }

    private async requisitar<T>(url: string, init?: RequestInit): Promise<T> {
        let response: Response;

        try {
            response = await fetch(url, { ...init, credentials: 'include' });
        } catch {
            throw new CadastrosAdminServiceError('Não foi possível comunicar com o servidor.', 0);
        }

        const data = await response.json().catch(() => null) as (T & { message?: string }) | null;
        if (!response.ok) {
            throw new CadastrosAdminServiceError(data?.message || 'Não foi possível concluir a consulta.', response.status);
        }

        return data as T;
    }
}
