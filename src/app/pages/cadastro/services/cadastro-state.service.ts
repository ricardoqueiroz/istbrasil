import { computed, Injectable, signal } from '@angular/core';
import {
    CadastroDadosComplementares,
    CadastroDadosPessoais,
    CadastroIdentificacao,
    CadastroState,
    CadastroTipo,
    CadastroTipoId,
    criarEstadoCadastroInicial,
    TOTAL_ETAPAS_MAP,
    TIPO_USUARIO_MAP
} from '../models/cadastro.model';

@Injectable({
    providedIn: 'root'
})
export class CadastroStateService {
    private readonly state = signal<CadastroState>(criarEstadoCadastroInicial());

    readonly cadastro = this.state.asReadonly();
    readonly idTipoUsuario = computed(() => this.state().idTipoUsuario);
    readonly idSituacao = computed(() => this.state().idSituacao);
    readonly tipo = computed(() => this.state().tipo);
    readonly etapaAtual = computed(() => this.state().etapaAtual);
    readonly totalEtapas = computed(() => TOTAL_ETAPAS_MAP[this.state().tipo]);
    readonly identificacao = computed(() => this.state().identificacao);
    readonly dadosPessoais = computed(() => this.state().dadosPessoais);
    readonly dadosComplementares = computed(() => this.state().dadosComplementares);

    setTipo(tipo: CadastroTipo): void {
        const proximoEstado = criarEstadoCadastroInicial(tipo);
        this.state.set(proximoEstado);
    }

    setCadastro(cadastro: Partial<CadastroState>): void {
        this.state.update((estadoAtual) => ({
            ...estadoAtual,
            ...cadastro,
            identificacao: {
                ...estadoAtual.identificacao,
                ...(cadastro.identificacao ?? {})
            },
            dadosPessoais: {
                ...estadoAtual.dadosPessoais,
                ...(cadastro.dadosPessoais ?? {})
            },
            dadosComplementares: {
                ...estadoAtual.dadosComplementares,
                ...(cadastro.dadosComplementares ?? {})
            }
        }));
    }

    setEtapaAtual(etapaAtual: number): void {
        this.state.update((estadoAtual) => ({
            ...estadoAtual,
            etapaAtual: Math.max(1, etapaAtual)
        }));
    }

    atualizarIdentificacao(partial: Partial<CadastroIdentificacao>): void {
        this.state.update((estadoAtual) => ({
            ...estadoAtual,
            identificacao: {
                ...estadoAtual.identificacao,
                ...partial
            }
        }));
    }

    atualizarDadosPessoais(partial: Partial<CadastroDadosPessoais>): void {
        this.state.update((estadoAtual) => ({
            ...estadoAtual,
            dadosPessoais: {
                ...estadoAtual.dadosPessoais,
                ...partial
            }
        }));
    }

    atualizarDadosComplementares(partial: Partial<CadastroDadosComplementares>): void {
        this.state.update((estadoAtual) => ({
            ...estadoAtual,
            dadosComplementares: {
                ...estadoAtual.dadosComplementares,
                ...partial
            }
        }));
    }

    getEstado(): CadastroState {
        return this.state();
    }

    reset(): void {
        this.state.set(criarEstadoCadastroInicial());
    }

    static tipoParaId(tipo: CadastroTipo): CadastroTipoId {
        return TIPO_USUARIO_MAP[tipo];
    }
}
