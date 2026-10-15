import { HttpErrorResponse } from '@angular/common/http';
import { DestroyRef, Injectable, InjectionToken, computed, inject, signal } from '@angular/core';
import { Subscription } from 'rxjs';
import { CarrinhoErro, CarrinhoInconsistencia, LojaCotacao } from '../pages/loja/models/loja.model';
import { LojaService } from './loja.service';

export const CARRINHO_STORAGE_KEY = 'ist.loja.carrinho.ids';
export type CarrinhoStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export const CARRINHO_STORAGE = new InjectionToken<CarrinhoStorage | null>('Loja sessionStorage', {
    providedIn: 'root',
    factory: () => {
        try { return globalThis.sessionStorage ?? null; } catch { return null; }
    }
});

const idValido = (id: unknown): id is number => typeof id === 'number'
    && Number.isSafeInteger(id) && id > 0 && id <= 2147483647;

@Injectable({ providedIn: 'root' })
export class CarrinhoService {
    private readonly loja = inject(LojaService);
    private readonly storage = inject(CARRINHO_STORAGE);
    private readonly idsEstado = signal<readonly number[]>(Object.freeze([]));
    private readonly cotacaoEstado = signal<LojaCotacao | null>(null);
    private readonly carregandoEstado = signal(false);
    private readonly erroEstado = signal<CarrinhoErro | null>(null);
    private readonly inconsistenciasEstado = signal<readonly CarrinhoInconsistencia[]>([]);
    private versao = 0;
    private requisicao?: Subscription;

    readonly ids = this.idsEstado.asReadonly();
    readonly quantidadeTitulos = computed(() => this.ids().length);
    readonly vazio = computed(() => this.quantidadeTitulos() === 0);
    readonly cotacao = this.cotacaoEstado.asReadonly();
    readonly carregando = this.carregandoEstado.asReadonly();
    readonly erro = this.erroEstado.asReadonly();
    readonly inconsistencias = this.inconsistenciasEstado.asReadonly();

    constructor() {
        this.restaurar();
        inject(DestroyRef).onDestroy(() => this.cancelar());
    }

    adicionar(produtoId: number): boolean {
        if (!idValido(produtoId) || this.contem(produtoId) || this.quantidadeTitulos() >= 100) return false;
        this.alterar([...this.ids(), produtoId]);
        return true;
    }

    remover(produtoId: number): void {
        if (this.contem(produtoId)) this.alterar(this.ids().filter((id) => id !== produtoId));
    }

    limpar(): void {
        this.alterar([]);
    }

    contem(produtoId: number): boolean {
        return this.ids().includes(produtoId);
    }

    cotar(): void {
        this.cancelar();
        this.cotacaoEstado.set(null);
        this.erroEstado.set(null);
        this.inconsistenciasEstado.set([]);
        const ids = this.ids();
        if (ids.length === 0) return;
        const versao = this.versao;
        this.carregandoEstado.set(true);
        this.requisicao = this.loja.cotar(ids.map((produtoId) => ({ produtoId, quantidade: 1 }))).subscribe({
            next: (cotacao) => {
                if (versao !== this.versao) return;
                // Nao aceitar cotacao incompleta ou de outro conjunto de itens como oficial.
                if (!this.corresponde(cotacao, ids)) {
                    this.falhar(502, 'COTACAO_INVALIDA', 'A cotação recebida não corresponde ao carrinho.');
                    return;
                }
                this.cotacaoEstado.set(cotacao);
                this.carregandoEstado.set(false);
            },
            error: (erro: unknown) => {
                if (versao !== this.versao) return;
                const status = erro instanceof HttpErrorResponse ? erro.status : 0;
                const codigo = status === 422 ? 'PRODUTO_INDISPONIVEL' : status === 429 ? 'LIMITE_REQUISICOES' : 'FALHA_COTACAO';
                const mensagem = status === 422 ? 'Não foi possível confirmar a disponibilidade dos títulos. Revise o carrinho.'
                    : status === 429 ? 'Muitas requisições. Aguarde um minuto e tente novamente.'
                        : 'Não foi possível consultar a cotação. Tente novamente.';
                this.falhar(status, codigo, mensagem);
                if (status === 422) {
                    // O contrato atual nao identifica o item recusado: todos ficam pendentes
                    // de verificacao, sem afirmar que todos estao indisponiveis ou remove-los.
                    this.inconsistenciasEstado.set(ids.map((produtoId) => ({ produtoId,
                        codigo: 'DISPONIBILIDADE_NAO_CONFIRMADA', mensagem: 'Disponibilidade deste título ainda não confirmada.' })));
                }
            },
            complete: () => { if (versao === this.versao) this.carregandoEstado.set(false); }
        });
    }

    private corresponde(cotacao: LojaCotacao, ids: readonly number[]): boolean {
        if (!cotacao || cotacao.moeda !== 'BRL' || !Number.isSafeInteger(cotacao.totalCentavos) || cotacao.totalCentavos <= 0
            || !Array.isArray(cotacao.itens) || cotacao.itens.length !== ids.length) return false;
        const recebidos = new Set<number>();
        for (const item of cotacao.itens) {
            if (!item || !ids.includes(item.produtoId) || recebidos.has(item.produtoId) || item.quantidade !== 1
                || item.produto?.id !== item.produtoId || !Number.isSafeInteger(item.precoUnitarioCentavos)
                || item.precoUnitarioCentavos <= 0 || !Number.isSafeInteger(item.subtotalCentavos) || item.subtotalCentavos <= 0) return false;
            recebidos.add(item.produtoId);
        }
        return true;
    }

    private falhar(status: number, codigo: string, mensagem: string): void {
        this.cotacaoEstado.set(null);
        this.carregandoEstado.set(false);
        this.erroEstado.set({ status, codigo, mensagem });
    }

    private cancelar(): void {
        this.versao++;
        this.requisicao?.unsubscribe();
        this.requisicao = undefined;
        this.carregandoEstado.set(false);
    }

    private alterar(ids: number[]): void {
        this.cancelar();
        this.idsEstado.set(Object.freeze(ids));
        this.cotacaoEstado.set(null);
        this.erroEstado.set(null);
        this.inconsistenciasEstado.set([]);
        this.persistir();
    }

    private restaurar(): void {
        try {
            const valor: unknown = JSON.parse(this.storage?.getItem(CARRINHO_STORAGE_KEY) ?? '[]');
            const ids = Array.isArray(valor) ? [...new Set(valor.filter(idValido))].slice(0, 100) : [];
            this.idsEstado.set(Object.freeze(ids));
        } catch { this.idsEstado.set(Object.freeze([])); }
        this.persistir();
    }

    private persistir(): void {
        try {
            if (this.vazio()) this.storage?.removeItem(CARRINHO_STORAGE_KEY);
            else this.storage?.setItem(CARRINHO_STORAGE_KEY, JSON.stringify(this.ids()));
        } catch { /* A sessao continua em memoria quando o navegador bloqueia storage. */ }
    }
}
