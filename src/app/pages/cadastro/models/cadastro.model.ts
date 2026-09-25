export const TIPO_USUARIO_MAP = {
    diretoria: 1,
    concorrente: 2,
    externo: 3,
    colaborador: 4
} as const;

export type CadastroTipo = keyof typeof TIPO_USUARIO_MAP;
export type CadastroTipoId = (typeof TIPO_USUARIO_MAP)[CadastroTipo];

export const SITUACAO_INICIAL_MAP = {
    diretoria: 1,
    concorrente: 3,
    externo: 6,
    colaborador: 8
} as const satisfies Record<CadastroTipo, number>;

export type CadastroSituacaoId = (typeof SITUACAO_INICIAL_MAP)[CadastroTipo];

export const TOTAL_ETAPAS_MAP = {
    diretoria: 3,
    concorrente: 3,
    externo: 2,
    colaborador: 2
} as const satisfies Record<CadastroTipo, number>;

export const OBRA_PRINCIPAL_CONCORRENTE = {
    idObra: 63,
    titulo: 'Catraias'
} as const;

export interface CadastroIdentificacao {
    nome: string;
    email: string;
    confirmarEmail: string;
}

export interface CadastroDadosPessoais {
    cpf: string;
    telefoneCelular: string;
    dataNascimento: string;
    identidade: string;
    idCargo: number | null;
    logradouro: string;
    numero: string;
    complemento: string;
    bairro: string;
    cidade: string;
    uf: string;
    cep: string;
    senha: string;
    confirmarSenha: string;
}

export interface CadastroDadosComplementares {
    foto: string | null;
    curriculo: string;
    idObra1: number | null;
    linkVideo1: string;
    idObra2: number | null;
    linkVideo2: string;
}

export interface CadastroState {
    idTipoUsuario: CadastroTipoId;
    idSituacao: CadastroSituacaoId;
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
        idSituacao: SITUACAO_INICIAL_MAP[tipo],
        tipo,
        etapaAtual: 1,
        identificacao: {
            nome: '',
            email: '',
            confirmarEmail: ''
        },
        dadosPessoais: {
            cpf: '',
            telefoneCelular: '',
            dataNascimento: '',
            identidade: '',
            idCargo: null,
            logradouro: '',
            numero: '',
            complemento: '',
            bairro: '',
            cidade: '',
            uf: '',
            cep: '',
            senha: '',
            confirmarSenha: ''
        },
        dadosComplementares: {
            foto: null,
            curriculo: '',
            idObra1: null,
            linkVideo1: '',
            idObra2: null,
            linkVideo2: ''
        }
    };
}
