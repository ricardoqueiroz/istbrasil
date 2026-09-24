export const TIPO_USUARIO_MAP = {
    diretoria: 1,
    concorrente: 2,
    externo: 3,
    colaborador: 4
} as const;

export type CadastroTipo = keyof typeof TIPO_USUARIO_MAP;
export type CadastroTipoId = (typeof TIPO_USUARIO_MAP)[CadastroTipo];

export interface CadastroIdentificacao {
    nome: string;
    email: string;
    confirmarEmail: string;
}

export interface CadastroDadosPessoais {
    cpf?: string;
    telefoneCelular?: string;
    dataNascimento?: string;
    identidade?: string;
    logradouro?: string;
    numero?: string;
    complemento?: string;
    bairro?: string;
    cidade?: string;
    uf?: string;
    cep?: string;
}

export interface CadastroDadosComplementares {
    foto?: string | null;
    curriculo?: string | null;
    idObra1?: number | null;
    linkVideo1?: string | null;
    idObra2?: number | null;
    linkVideo2?: string | null;
}

export interface CadastroState {
    idTipoUsuario: CadastroTipoId;
    tipo: CadastroTipo;
    etapaAtual: number;
    identificacao: CadastroIdentificacao;
    dadosPessoais: CadastroDadosPessoais;
    dadosComplementares: CadastroDadosComplementares;
}

export function isCadastroTipo(value: string | null | undefined): value is CadastroTipo {
    return !!value && value in TIPO_USUARIO_MAP;
}

export function criarEstadoCadastroInicial(tipo: CadastroTipo = 'diretoria'): CadastroState {
    return {
        idTipoUsuario: TIPO_USUARIO_MAP[tipo],
        tipo,
        etapaAtual: 1,
        identificacao: {
            nome: '',
            email: '',
            confirmarEmail: ''
        },
        dadosPessoais: {},
        dadosComplementares: {}
    };
}
