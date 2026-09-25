export interface PerfilUsuario {
    idUsuario: number;
    idTipoUsuario: number;
    idCargo: number | null;
    idSituacao: number | null;
    nome: string;
    foto: string | null;
    fotoUrl: string | null;
    dataNascimento: string | null;
    cpf: string | null;
    identidade: string | null;
    curriculo: string | null;
    email: string;
    emailConfirmado: number | boolean | null;
    telefoneCelular: string | null;
    celularConfirmado: number | boolean | null;
    cep: string | null;
    logradouro: string | null;
    numero: string | null;
    complemento: string | null;
    bairro: string | null;
    cidade: string | null;
    uf: string | null;
}

export interface PerfilConcorrente {
    idConcorrente: string | null;
    idObra1: number | null;
    tituloObra1: string | null;
    linkVideo1: string | null;
    idObra2: number | null;
    tituloObra2: string | null;
    linkVideo2: string | null;
    dataCadastro: string | null;
}

export interface PerfilResponse {
    usuario: PerfilUsuario;
    concorrente: PerfilConcorrente | null;
}

export interface PerfilAtualizacaoPayload {
    nome: string;
    email: string;
    cpf: string;
    identidade: string;
    telefoneCelular: string;
    dataNascimento: string;
    cep: string;
    logradouro: string;
    numero: string;
    complemento: string;
    bairro: string;
    cidade: string;
    uf: string;
}

export interface PerfilAtualizacaoResponse {
    message: string;
    usuario: PerfilUsuario;
}

export interface ObraElegivel {
    idObra: number;
    titulo: string;
}

export interface ParticipacaoConcorrentePayload {
    linkVideo1: string;
    idObra2: number | null;
    linkVideo2: string | null;
}

export interface ParticipacaoConcorrente {
    idConcorrente?: string | null;
    idObra1: number | null;
    tituloObra1: string | null;
    linkVideo1: string | null;
    idObra2: number | null;
    tituloObra2: string | null;
    linkVideo2: string | null;
    dataCadastro?: string | null;
}

export interface ParticipacaoConcorrenteResponse {
    message: string;
    concorrente: ParticipacaoConcorrente;
}

export interface PerfilFotoRespostaHttp {
    message: string;
    foto: string | null;
    foto_url: string | null;
}

export interface PerfilFotoResultado {
    message: string;
    foto: string | null;
    fotoUrl: string | null;
}

export interface CurriculoResposta {
    message: string;
    curriculo: string | null;
}
