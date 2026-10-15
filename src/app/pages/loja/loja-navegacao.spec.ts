import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZoneChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { appRoutes } from '../../../app.routes';
import { environment } from '../../../environments/environment';
import { AppLayout } from '../../layout/component/app.layout';
import { AppMenu } from '../../layout/component/app.menu';
import { CARRINHO_STORAGE, CarrinhoService } from '../../services/carrinho.service';
import { LojaCatalogoComponent } from './loja-catalogo.component';
import { LojaCarrinhoComponent } from './loja-carrinho.component';
import { LojaProdutoComponent } from './loja-produto.component';
import { LojaProduto } from './models/loja.model';

describe('Integracao de navegacao da Loja', () => {
    let http: HttpTestingController;
    const url = `${environment.apiUrl}/loja`;
    const livro: LojaProduto = { id: 1, sku: 'SKU1', titulo: 'Livro de teste', descricao: null,
        categoria: { id: 2, nome: 'Música', slug: 'musica', categoriaPaiId: 1, ordem: 1 }, idioma: 'pt-br',
        imagemUrl: null, precoCentavos: 9500, moeda: 'BRL', disponivel: true, quantidadeMaxima: 1 };

    beforeEach(() => {
        TestBed.configureTestingModule({ providers: [provideZoneChangeDetection(), provideRouter(appRoutes),
            provideHttpClient(), provideHttpClientTesting(), { provide: CARRINHO_STORAGE, useValue: null }] });
        // Exercita as rotas e paginas reais; omite somente o chrome visual do layout.
        TestBed.overrideComponent(AppLayout, { set: { template: '<router-outlet />' } });
        http = TestBed.inject(HttpTestingController);
    });
    afterEach(() => http.verify());

    it('registra uma unica Loja em AppLayout com catalogo exato e filhos lazy', () => {
        const lojas = appRoutes.filter((route) => route.path === 'loja');
        expect(lojas.length).toBe(1); expect(lojas[0].component).toBe(AppLayout);
        expect(lojas[0].children?.map((route) => route.path)).toEqual(['', 'carrinho', 'produto/:id']);
        expect(lojas[0].children?.[0].pathMatch).toBe('full');
        expect(lojas[0].children?.every((route) => !!route.loadComponent && !route.component)).toBeTrue();
    });

    it('acesso direto a /loja resolve e renderiza o catalogo lazy', async () => {
        const harness = await RouterTestingHarness.create('/loja');
        http.expectOne(`${url}/categorias`).flush([livro.categoria]);
        http.expectOne(`${url}/produtos`).flush([livro]); harness.detectChanges();
        expect(TestBed.inject(Router).routerState.snapshot.root.firstChild?.firstChild?.component).toBe(LojaCatalogoComponent);
        expect(harness.routeNativeElement?.textContent).toContain('Livro de teste');
    });

    it('acesso direto a /loja/carrinho resolve o carrinho sem requisitar produto', async () => {
        const harness = await RouterTestingHarness.create('/loja/carrinho');
        expect(TestBed.inject(Router).routerState.snapshot.root.firstChild?.firstChild?.component).toBe(LojaCarrinhoComponent);
        expect(harness.routeNativeElement?.textContent).toContain('Seu carrinho está vazio');
        http.expectNone((request) => request.url.includes('/produtos/'));
    });

    for (const id of [1, 2]) it(`acesso direto a /loja/produto/${id} resolve detalhes com parametro correto`, async () => {
        const harness = await RouterTestingHarness.create(`/loja/produto/${id}`);
        http.expectOne(`${url}/produtos/${id}`).flush({ ...livro, id, titulo: `Livro ${id}` }); harness.detectChanges();
        const rota = TestBed.inject(Router).routerState.snapshot.root.firstChild?.firstChild;
        expect(rota?.component).toBe(LojaProdutoComponent); expect(rota?.params['id']).toBe(String(id));
        expect(harness.routeNativeElement?.textContent).toContain(`Livro ${id}`);
    });

    it('RouterLink interno preserva AppLayout e itens ao abrir o carrinho', async () => {
        const harness = await RouterTestingHarness.create('/loja');
        http.expectOne(`${url}/categorias`).flush([]); http.expectOne(`${url}/produtos`).flush([livro]);
        const layout = harness.routeDebugElement?.componentInstance;
        TestBed.inject(CarrinhoService).adicionar(1); harness.detectChanges();
        const link = harness.routeNativeElement?.querySelector<HTMLAnchorElement>('a[href="/loja/carrinho"]');
        expect(link).not.toBeNull(); link?.click(); await harness.fixture.whenStable(); harness.detectChanges();
        expect(TestBed.inject(Router).url).toBe('/loja/carrinho');
        expect(harness.routeDebugElement?.componentInstance).toBe(layout);
        const request = http.expectOne(`${url}/cotacao`);
        expect(request.request.body).toEqual({ itens: [{ produtoId: 1, quantidade: 1 }] });
        request.flush({ itens: [{ produtoId: 1, quantidade: 1, produto: livro, precoUnitarioCentavos: 9500, subtotalCentavos: 9500 }], moeda: 'BRL', totalCentavos: 9500, geradaEm: '2026-10-15T12:00:00Z' }); harness.detectChanges();
        expect(harness.routeNativeElement?.textContent).toContain('95,00');
    });

    it('preserva as duas declaracoes editora e seus filhos', () => {
        const editoras = appRoutes.filter((route) => route.path === 'editora');
        expect(editoras.length).toBe(2); expect(editoras.every((route) => route.component === AppLayout)).toBeTrue();
        expect(editoras.map((route) => route.children?.map((child) => child.path))).toEqual([[''], ['', 'livro/:id', 'checkout']]);
        expect(appRoutes[appRoutes.length - 1]).toEqual({ path: '**', redirectTo: '/notfound' });
    });

    it('menu mantem Editora e adiciona Loja Virtual sem duplicar secao', () => {
        const menu = new AppMenu(); menu.ngOnInit();
        expect(menu.model.length).toBe(4);
        const lojas = menu.model.filter((item) => item.label === 'LOJA'); expect(lojas.length).toBe(1);
        expect(lojas[0].items).toEqual([
            { label: 'IST Editora', icon: 'pi pi-fw pi-shopping-cart', routerLink: ['/editora'] },
            { label: 'Loja Virtual', icon: 'pi pi-fw pi-shopping-bag', routerLink: ['/loja'] }
        ]);
        expect(menu.model.slice(0, 3).map((item) => item.items?.length)).toEqual([4, 3, 4]);
    });
});
