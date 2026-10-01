export interface UsuarioAdminLista {
    idUsuario: number;
    nome: string;
    email: string;
    idTipoUsuario: number;
    tipo: string;
    idCargo: number | null;
    cargo: string | null;
    idSituacao: number | null;
    situacao: string | null;
    emailConfirmado: boolean;
    dataCadastro: string;
}

export interface TipoUsuarioAdmin {
    idTipoUsuario: number;
    tipo: string;
}

export interface CargoAdmin {
    idCargo: number;
    cargo: string;
}

export interface SituacaoAdmin {
    idSituacao: number;
    situacao: string;
    idTipoUsuario: number;
}

export interface UsuariosAdminPagination {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
}

export interface UsuariosAdminResponse {
    data: UsuarioAdminLista[];
    pagination: UsuariosAdminPagination;
}

export interface UsuariosAdminOpcoes {
    tiposUsuario: TipoUsuarioAdmin[];
    cargos: CargoAdmin[];
    situacoes: SituacaoAdmin[];
}

export interface UsuarioAdminDetalhe {
    idUsuario: number;
    nome: string;
    cpf: string;
    identidade: string | null;
    dataNascimento: string | null;
    idTipoUsuario: number;
    tipo: string;
    idCargo: number | null;
    cargo: string | null;
    idSituacao: number | null;
    situacao: string | null;
    email: string;
    telefoneCelular: string;
    logradouro: string | null;
    numero: string | null;
    complemento: string | null;
    bairro: string | null;
    cidade: string | null;
    uf: string | null;
    cep: string | null;
    foto: string | null;
    curriculo: string | null;
    emailConfirmado: boolean;
    celularConfirmado: boolean;
    dataCadastro: string;
    dataAtualizacao: string | null;
}

export interface UsuarioAdminDetalheResponse {
    usuario: UsuarioAdminDetalhe;
}

export interface UsuarioAdminAtualizacaoPayload {
    nome: string;
    cpf: string;
    identidade: string | null;
    dataNascimento: string;
    idTipoUsuario: number;
    idCargo: number | null;
    idSituacao: number;
    telefoneCelular: string;
    logradouro: string;
    numero: string;
    complemento: string;
    bairro: string;
    cidade: string;
    uf: string;
    cep: string;
}

export type UsuariosAdminSortField = 'nome' | 'email' | 'tipo' | 'cargo' | 'situacao' | 'dataCadastro';
export type UsuariosAdminSortOrder = 'asc' | 'desc';

export interface UsuariosAdminFiltros {
    page: number;
    limit: number;
    search?: string;
    idTipoUsuario?: number;
    idCargo?: number;
    idSituacao?: number;
    sortField?: UsuariosAdminSortField;
    sortOrder?: UsuariosAdminSortOrder;
}
