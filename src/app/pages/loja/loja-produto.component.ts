import { Component, DestroyRef, OnInit, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { HttpErrorResponse } from '@angular/common/http';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { BehaviorSubject, catchError, combineLatest, of, switchMap } from 'rxjs';
import { ButtonModule } from 'primeng/button';
import { SkeletonModule } from 'primeng/skeleton';
import { MessageModule } from 'primeng/message';
import { LojaService } from '../../services/loja.service';
import { CarrinhoService } from '../../services/carrinho.service';
import { LojaProdutoDetalhe, tipoProduto } from './models/loja.model';

interface DescricaoPropriedade {
    readonly chave: string;
    readonly valor: string;
}

@Component({
    selector: 'app-loja-produto', standalone: true,
    imports: [RouterLink, ButtonModule, SkeletonModule, MessageModule],
    templateUrl: './loja-produto.component.html', styleUrl: './loja-produto.component.scss'
})
export class LojaProdutoComponent implements OnInit {
    readonly tipoProduto = tipoProduto;
    readonly carrinho = inject(CarrinhoService);
    private readonly loja = inject(LojaService);
    private readonly route = inject(ActivatedRoute);
    private readonly destroyRef = inject(DestroyRef);
    private readonly tentativas = new BehaviorSubject<void>(undefined);
    readonly produto = signal<LojaProdutoDetalhe | null>(null);
    readonly descricao = signal('');
    readonly descricaoPropriedades = signal<readonly DescricaoPropriedade[]>([]);
    readonly carregando = signal(true);
    readonly erro = signal<string | null>(null);
    readonly podeTentar = signal(false);
    readonly aviso = signal<string | null>(null);
    private readonly formato = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
    readonly preco = (centavos: number) => this.formato.format(centavos / 100);

    ngOnInit(): void {
        combineLatest([this.route.paramMap, this.tentativas]).pipe(switchMap(([params]) => {
            this.produto.set(null);
            this.descricao.set('');
            this.descricaoPropriedades.set([]);
            this.erro.set(null);
            this.aviso.set(null);
            this.podeTentar.set(false);
            const id = params.get('id') ?? '';
            if (!/^[1-9]\d{0,9}$/.test(id) || Number(id) > 2147483647) {
                this.carregando.set(false);
                this.erro.set('Identificador de produto inválido.');
                return of(null);
            }
            this.carregando.set(true);
            return this.loja.obterProduto(Number(id)).pipe(catchError((erro: unknown) => {
                const naoEncontrado = erro instanceof HttpErrorResponse && erro.status === 404;
                this.erro.set(naoEncontrado ? 'Produto não encontrado ou indisponível.' : 'Não foi possível carregar o produto. Tente novamente.');
                this.podeTentar.set(!naoEncontrado);
                return of(null);
            }));
        }), takeUntilDestroyed(this.destroyRef)).subscribe((produto) => {
            this.produto.set(produto);
            this.apresentarDescricao(produto?.descricao ?? '');
            this.carregando.set(false);
        });
    }
    private apresentarDescricao(descricao: string): void {
        this.descricao.set('');
        this.descricaoPropriedades.set([]);
        if (!descricao.trim()) return;
        try {
            // Analisar antes de normalizar entidades, para preservar aspas nos valores.
            const dados: unknown = JSON.parse(descricao);
            if (dados === null || typeof dados !== 'object' || Array.isArray(dados)
                || Object.getPrototypeOf(dados) !== Object.prototype) throw new Error('Descricao nao estruturada');
            const propriedades: DescricaoPropriedade[] = [];
            for (const [chave, valor] of Object.entries(dados as Record<string, unknown>)) {
                // Estruturas inesperadas ficam no fallback, sem descartar nem converter valores.
                if (typeof valor !== 'string') throw new Error('Valor nao textual');
                propriedades.push({ chave: this.normalizarEntidades(chave), valor: this.normalizarEntidades(valor) });
            }
            this.descricaoPropriedades.set(propriedades);
        } catch {
            this.descricao.set(this.normalizarEntidades(descricao));
        }
    }
    private normalizarEntidades(texto: string): string {
        // Uma unica passagem, apenas nos tokens de entidades; nunca interpretar HTML original.
        return texto.replace(/&(?:#[0-9]+|#x[0-9a-f]+|[a-z][a-z0-9]+);/gi,
            (entidade) => new DOMParser().parseFromString(entidade, 'text/html').body.textContent ?? entidade);
    }
    recarregar(): void { this.tentativas.next(); }
    adicionar(): void {
        const produto = this.produto();
        if (produto?.disponivel && !this.carrinho.adicionar(produto.id) && !this.carrinho.contem(produto.id)) this.aviso.set('O carrinho permite até 100 títulos.');
    }
    idioma(codigo: string): string { return codigo === 'en-uk' ? 'Inglês' : codigo === 'pt-br' ? 'Português' : codigo; }
}
