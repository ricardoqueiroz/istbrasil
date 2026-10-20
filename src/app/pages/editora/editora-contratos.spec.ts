import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZoneChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, UrlTree, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { Book, BookService, precoEditorial } from '../../services/book.service';
import { EditoraComponent } from './editora.component';
import { LivroComponent } from './livro/livro.component';
import { CARRINHO_STORAGE, CarrinhoService } from '../../services/carrinho.service';

describe('Contratos editoriais e navegacao comercial R3.5/R3.6', () => {
    const livro: Book = { id: 2, title: 'Livro editorial', description: '{"Conteúdo":"Música & memória"}',
        language: 'pt-br', format: 'E-Book', img: 'assets/images/livros/capa.png', category: 'Música',
        comercial: { produtoId: 6, sku: 'SKU-OFICIAL', precoCentavos: 100, moeda: 'BRL', podeComprar: true } };
    beforeEach(() => TestBed.configureTestingModule({ imports: [EditoraComponent, LivroComponent],
        providers: [provideZoneChangeDetection(), provideRouter([]), provideHttpClient(), provideHttpClientTesting(),
            { provide: CARRINHO_STORAGE, useValue: { getItem: () => '[99]', setItem: () => {}, removeItem: () => {} } },
            { provide: ActivatedRoute, useValue: { snapshot: { paramMap: new Map([['id', '2']]) } } }] }));
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    const verificarCompra = (el: HTMLElement) => {
        const router = TestBed.inject(Router), carrinho = TestBed.inject(CarrinhoService);
        const navegar = spyOn(router, 'navigateByUrl').and.returnValue(Promise.resolve(true));
        const adicionar = spyOn(carrinho, 'adicionar').and.callThrough();
        const chamada = spyOn(window, 'fetch');
        const link = el.querySelector<HTMLAnchorElement>('a[href="/loja/produto/6"]');
        expect(link).not.toBeNull();
        expect(link?.textContent).toContain('Comprar');
        expect(link?.search).toBe('');
        link!.click();
        expect(navegar).toHaveBeenCalledTimes(1);
        const destino: string | UrlTree = navegar.calls.mostRecent().args[0];
        expect(typeof destino === 'string' ? destino : router.serializeUrl(destino)).toBe('/loja/produto/6');
        expect(adicionar).not.toHaveBeenCalled(); expect(carrinho.ids()).toEqual([99]);
        expect(chamada).not.toHaveBeenCalled();
        TestBed.inject(HttpTestingController).expectNone(req => /paypal|checkout|cotacao|pedidos/.test(req.url));
    };

    const detalhe = (book: Book) => {
        TestBed.overrideProvider(BookService, { useValue: { getById: () => of(book), getBooks: () => of([book]) } });
        const fixture = TestBed.createComponent(LivroComponent); fixture.detectChanges(); return fixture;
    };
    it('preserva metadados e IDs diferentes; preco vem da oferta e compra nao inicia checkout legado', () => {
        const f = detalhe(livro), el: HTMLElement = f.nativeElement;
        expect(el.textContent).toContain('Livro editorial'); expect(el.textContent).toContain('Música & memória');
        expect(el.textContent).toMatch(/1,00/); expect(f.componentInstance.livroEditorial?.id).toBe(2);
        expect(f.componentInstance.livroEditorial?.comercial?.produtoId).toBe(6);
        verificarCompra(el);
        expect(el.querySelector('iframe')).toBeNull();
        expect('renderPaypalButton' in f.componentInstance).toBeFalse();
        expect(window.fetch).not.toHaveBeenCalled();
    });
    for (const comercial of [null, undefined]) it(`livro sem oferta ${comercial} mantem descricao sem preco nem compra`, () => {
        const f = detalhe({ ...livro, comercial });
        expect(f.nativeElement.textContent).toContain('Livro editorial');
        expect(f.nativeElement.textContent).toContain('Indisponível para compra');
        expect(f.nativeElement.textContent).not.toContain('R$');
        expect(f.nativeElement.textContent).not.toContain('Comprar');
    });
    it('oferta fora de venda mostra preco mas nao botao de compra', () => {
        const f = detalhe({ ...livro, comercial: { ...livro.comercial!, podeComprar: false } });
        expect(f.nativeElement.textContent).toMatch(/1,00/);
        expect(f.nativeElement.textContent).toContain('Indisponível para compra');
        expect(f.nativeElement.textContent).not.toContain('Comprar');
    });
    it('campos comerciais legados adicionais nao sao usados pela apresentacao', () => {
        const dados = { ...livro, price: 999, currency: 'USD', sku: 'SKU-LEGADO', inventory: 'Esgotado', onsale: 0 };
        const f = detalhe(dados);
        expect(f.nativeElement.textContent).toMatch(/1,00/);
        expect(f.nativeElement.textContent).not.toContain('999');
        expect(f.nativeElement.textContent).not.toContain('SKU-LEGADO');
    });
    for (const valor of [null, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) it(`oculta preco invalido ${valor}`, () => {
        expect(precoEditorial({ ...livro, comercial: { ...livro.comercial!, precoCentavos: valor } })).toBeNull();
    });
    it('nao presume moeda BRL para oferta em outra moeda', () => {
        expect(precoEditorial({ ...livro, comercial: { ...livro.comercial!, moeda: 'USD' } })).toBeNull();
    });
    for (const layout of ['list', 'grid'] as const) it(`vitrine ${layout} preserva livros sem oferta e navegacao editorial`, async () => {
        const books = [livro, { ...livro, id: 3, title: 'Sem oferta', comercial: null },
            { ...livro, id: 4, title: 'Fora de venda', comercial: { ...livro.comercial!, podeComprar: false } }];
        TestBed.overrideComponent(EditoraComponent, { set: { providers: [{ provide: BookService, useValue: { getBooks: () => of(books) } }] } });
        const f = TestBed.createComponent(EditoraComponent); f.componentInstance.layout = layout;
        f.detectChanges(); await f.whenStable(); f.detectChanges();
        const el: HTMLElement = f.nativeElement;
        expect(f.componentInstance.books.length).toBe(3);
        expect(el.textContent).toContain('Sem oferta'); expect(el.textContent).toContain('Fora de venda');
        expect(el.textContent).toContain('SKU-OFICIAL');
        expect(el.querySelector('a[href="/editora/livro/2"]')).not.toBeNull();
        expect(Array.from(el.querySelectorAll('a')).filter(a => a.textContent?.includes('Comprar')).length).toBe(1);
        expect(el.querySelector('a[href="/loja/produto/2"]')).toBeNull();
        verificarCompra(el);
    });
});
