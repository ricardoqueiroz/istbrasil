import { Component, DestroyRef, OnInit, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { BehaviorSubject, catchError, of, switchMap } from 'rxjs';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { SkeletonModule } from 'primeng/skeleton';
import { MessageModule } from 'primeng/message';
import { LojaService } from '../../services/loja.service';
import { CarrinhoService } from '../../services/carrinho.service';
import { LojaCategoria, LojaProduto, tipoProduto } from './models/loja.model';

@Component({
    selector: 'app-loja-catalogo', standalone: true,
    imports: [FormsModule, RouterLink, ButtonModule, SelectModule, SkeletonModule, MessageModule],
    templateUrl: './loja-catalogo.component.html', styleUrl: './loja-catalogo.component.scss'
})
export class LojaCatalogoComponent implements OnInit {
    readonly tipoProduto = tipoProduto;
    readonly carrinho = inject(CarrinhoService);
    private readonly loja = inject(LojaService);
    private readonly destroyRef = inject(DestroyRef);
    private readonly filtro = new BehaviorSubject<string | undefined>(undefined);
    private readonly tentarCategorias = new BehaviorSubject<void>(undefined);
    readonly categorias = signal<LojaCategoria[]>([]);
    readonly produtos = signal<LojaProduto[]>([]);
    readonly categoria = signal<string | null>(null);
    readonly carregando = signal(true);
    readonly carregandoCategorias = signal(true);
    readonly erro = signal<string | null>(null);
    readonly erroCategorias = signal<string | null>(null);
    readonly aviso = signal<string | null>(null);
    private readonly formato = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
    readonly preco = (centavos: number) => this.formato.format(centavos / 100);

    ngOnInit(): void {
        this.tentarCategorias.pipe(switchMap(() => {
            this.carregandoCategorias.set(true);
            this.erroCategorias.set(null);
            return this.loja.listarCategorias().pipe(catchError(() => {
                this.erroCategorias.set('Não foi possível carregar as categorias.');
                return of([]);
            }));
        }), takeUntilDestroyed(this.destroyRef)).subscribe((categorias) => {
            this.categorias.set(categorias);
            this.carregandoCategorias.set(false);
        });
        this.filtro.pipe(switchMap((categoria) => {
            this.carregando.set(true);
            this.erro.set(null);
            this.produtos.set([]);
            return this.loja.listarProdutos(categoria).pipe(catchError(() => {
                this.erro.set('Não foi possível carregar os livros. Tente novamente.');
                return of([]);
            }));
        }), takeUntilDestroyed(this.destroyRef)).subscribe((produtos) => {
            this.produtos.set(produtos);
            this.carregando.set(false);
        });
    }

    filtrar(categoria: string | null): void {
        this.categoria.set(categoria);
        this.filtro.next(categoria ?? undefined);
    }
    recarregar(): void { this.filtro.next(this.categoria() ?? undefined); }
    recarregarCategorias(): void { this.tentarCategorias.next(); }
    adicionar(id: number): void {
        if (!this.produtos().find(produto => produto.id === id)?.disponivel) return;
        this.aviso.set(null);
        if (!this.carrinho.adicionar(id) && !this.carrinho.contem(id)) this.aviso.set('O carrinho permite até 100 títulos.');
    }
    idioma(codigo: string): string {
        return codigo === 'en-uk' ? 'Inglês' : codigo === 'pt-br' ? 'Português' : codigo;
    }
}
