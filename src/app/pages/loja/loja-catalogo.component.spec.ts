import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, TestRequest, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZoneChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { environment } from '../../../environments/environment';
import { CARRINHO_STORAGE, CarrinhoService } from '../../services/carrinho.service';
import { LojaCatalogoComponent } from './loja-catalogo.component';
import { LojaCategoria, LojaProduto } from './models/loja.model';

describe('LojaCatalogoComponent', () => {
    let fixture: ComponentFixture<LojaCatalogoComponent>;
    let http: HttpTestingController;
    let produtos: TestRequest;
    let categorias: TestRequest;
    const url = `${environment.apiUrl}/loja`;
    const categoria: LojaCategoria = { id: 2, nome: 'Música', slug: 'musica', categoriaPaiId: 1, ordem: 1 };
    const livros: LojaProduto[] = [1, 2].map((id) => ({ id, sku: `SKU${id}`, titulo: `Livro ${id}`, descricao: null,
        categoria, idioma: 'pt-br', imagemUrl: null, precoCentavos: 9500, moeda: 'BRL', disponivel: true, quantidadeMaxima: 1 }));
    beforeEach(() => {
        TestBed.configureTestingModule({ imports: [LojaCatalogoComponent], providers: [provideZoneChangeDetection(), provideRouter([]), provideHttpClient(), provideHttpClientTesting(), { provide: CARRINHO_STORAGE, useValue: null }] });
        http = TestBed.inject(HttpTestingController);
        fixture = TestBed.createComponent(LojaCatalogoComponent); fixture.detectChanges();
        categorias = http.expectOne(`${url}/categorias`); produtos = http.expectOne(`${url}/produtos`);
    });
    afterEach(() => http.verify());
    const carregar = () => { categorias.flush([categoria]); produtos.flush(livros); fixture.detectChanges(); };
    const texto = () => fixture.nativeElement.textContent as string;

    it('mostra carregamento e placeholders', () => { expect(texto()).toContain('Carregando livros'); expect(fixture.nativeElement.querySelector('p-skeleton')).not.toBeNull(); });
    it('lista livros, idioma e preco BRL', () => { carregar(); expect(texto()).toContain('Livro 1'); expect(texto()).toContain('Livro 2'); expect(texto()).toContain('Português'); expect(texto()).toMatch(/95,00/); });
    it('carrega categorias no Select', () => { carregar(); expect(fixture.componentInstance.categorias()).toEqual([categoria]); expect(fixture.nativeElement.querySelector('label[for="loja-categoria"]')).not.toBeNull(); });
    it('filtra por musica', () => { carregar(); fixture.componentInstance.filtrar('musica'); const req = http.expectOne(`${url}/produtos?categoria=musica`); req.flush([livros[0]]); fixture.detectChanges(); expect(texto()).toContain('Livro 1'); expect(texto()).not.toContain('Livro 2'); });
    it('limpa filtro para listar todas as categorias', () => { carregar(); fixture.componentInstance.filtrar(null); http.expectOne(`${url}/produtos`).flush(livros); expect(fixture.componentInstance.categoria()).toBeNull(); });
    it('exibe categoria sem produtos', () => { carregar(); fixture.componentInstance.filtrar('musica'); http.expectOne(`${url}/produtos?categoria=musica`).flush([]); fixture.detectChanges(); expect(texto()).toContain('Esta categoria ainda não tem livros'); });
    it('exibe catalogo vazio', () => { categorias.flush([]); produtos.flush([]); fixture.detectChanges(); expect(texto()).toContain('Nenhum livro encontrado'); });
    it('trata erro de produtos e permite nova tentativa', () => { categorias.flush([categoria]); produtos.flush({}, { status: 500, statusText: 'Erro' }); fixture.detectChanges(); expect(texto()).toContain('Não foi possível carregar os livros'); fixture.componentInstance.recarregar(); http.expectOne(`${url}/produtos`).flush(livros); fixture.detectChanges(); expect(texto()).toContain('Livro 1'); });
    it('falha de categorias preserva produtos e permite recarregar categorias', () => { categorias.flush({}, { status: 500, statusText: 'Erro' }); produtos.flush(livros); fixture.detectChanges(); expect(texto()).toContain('Não foi possível carregar as categorias'); expect(texto()).toContain('Livro 1'); fixture.componentInstance.recarregarCategorias(); http.expectOne(`${url}/categorias`).flush([categoria]); expect(fixture.componentInstance.erroCategorias()).toBeNull(); });
    it('botao adiciona e indica item ja adicionado', () => { carregar(); fixture.nativeElement.querySelector('p-button[data-produto="1"] button').click(); fixture.detectChanges(); expect(TestBed.inject(CarrinhoService).ids()).toEqual([1]); expect(texto()).toContain('Adicionado ao carrinho'); expect(fixture.nativeElement.querySelector('p-button[data-produto="1"] button').disabled).toBeTrue(); });
    it('contador reage a mudancas externas no carrinho', () => { carregar(); TestBed.inject(CarrinhoService).adicionar(2); fixture.detectChanges(); expect(texto()).toContain('Carrinho (1)'); });
    it('links apontam aos destinos do Bloco F sem controles aninhados', () => { carregar(); expect(fixture.nativeElement.querySelector('a[href="/loja/produto/1"]')).not.toBeNull(); expect(fixture.nativeElement.querySelector('a[href="/loja/carrinho"]')).not.toBeNull(); expect(fixture.nativeElement.querySelector('a button, button a')).toBeNull(); });
    it('filtros concorrentes cancelam resposta anterior', () => { categorias.flush([categoria]); fixture.componentInstance.filtrar('musica'); expect(produtos.cancelled).toBeTrue(); const antiga = http.expectOne(`${url}/produtos?categoria=musica`); fixture.componentInstance.filtrar(null); expect(antiga.cancelled).toBeTrue(); http.expectOne(`${url}/produtos`).flush([livros[1]]); fixture.detectChanges(); expect(texto()).toContain('Livro 2'); expect(texto()).not.toContain('Livro 1'); });
    it('destruicao cancela consultas pendentes', () => { fixture.destroy(); expect(produtos.cancelled).toBeTrue(); expect(categorias.cancelled).toBeTrue(); });
});
