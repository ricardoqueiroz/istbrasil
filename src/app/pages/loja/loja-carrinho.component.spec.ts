import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZoneChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { environment } from '../../../environments/environment';
import { CARRINHO_STORAGE, CarrinhoService } from '../../services/carrinho.service';
import { LojaCarrinhoComponent } from './loja-carrinho.component';
import { LojaCotacao } from './models/loja.model';

describe('LojaCarrinhoComponent', () => {
    let fixture: ComponentFixture<LojaCarrinhoComponent>;
    let http: HttpTestingController;
    let carrinho: CarrinhoService;
    const url = `${environment.apiUrl}/loja/cotacao`;
    const dto = (ids = [1, 2], totalCentavos = 19000): LojaCotacao => ({ moeda: 'BRL', totalCentavos, geradaEm: '2026-10-15T12:00:00Z', itens: ids.map((id) => ({ produtoId: id, quantidade: 1, precoUnitarioCentavos: 9500, subtotalCentavos: 9500,
        produto: { id, sku: `SKU${id}`, titulo: `Livro ${id}`, descricao: null, categoria: { id: 2, nome: 'Música', slug: 'musica', categoriaPaiId: 1, ordem: 1 }, idioma: 'pt-br', imagemUrl: null, precoCentavos: 9500, moeda: 'BRL', disponivel: true, quantidadeMaxima: 1 } })) });
    beforeEach(() => { TestBed.configureTestingModule({ imports: [LojaCarrinhoComponent], providers: [provideZoneChangeDetection(), provideRouter([]), provideHttpClient(), provideHttpClientTesting(), { provide: CARRINHO_STORAGE, useValue: null }] }); http = TestBed.inject(HttpTestingController); carrinho = TestBed.inject(CarrinhoService); });
    afterEach(() => http.verify());
    const pagina = (ids = [1, 2]) => { ids.forEach((id) => carrinho.adicionar(id)); fixture = TestBed.createComponent(LojaCarrinhoComponent); fixture.detectChanges(); };
    const carregar = () => { pagina(); http.expectOne(url).flush(dto()); fixture.detectChanges(); };
    const texto = () => fixture.nativeElement.textContent as string;

    it('carrinho vazio nao solicita HTTP', () => { pagina([]); expect(texto()).toContain('Seu carrinho está vazio'); http.expectNone(url); });
    it('exibe placeholders durante cotacao', () => { pagina(); expect(texto()).toContain('Consultando preços'); expect(fixture.nativeElement.querySelector('[data-testid="total"]')).toBeNull(); http.expectOne(url).flush(dto()); });
    it('exibe itens e quantidade fixa', () => { carregar(); expect(texto()).toContain('Livro 1'); expect(texto()).toContain('Livro 2'); expect(texto()).toContain('Quantidade: 1'); expect(fixture.nativeElement.querySelectorAll('[data-testid="subtotal"]').length).toBe(2); });
    it('preserva ordem do carrinho mesmo com resposta invertida', () => { pagina([2, 1]); http.expectOne(url).flush(dto([1, 2])); fixture.detectChanges(); const links = fixture.nativeElement.querySelectorAll('.informacoes h2 a'); expect(links[0].textContent).toBe('Livro 2'); expect(links[1].textContent).toBe('Livro 1'); });
    it('total vem exclusivamente da resposta oficial', () => { pagina(); http.expectOne(url).flush(dto([1, 2], 18000)); fixture.detectChanges(); expect(fixture.nativeElement.querySelector('[data-testid="total"]').textContent).toMatch(/180,00/); });
    it('remover recalcula oficialmente e oculta total antigo enquanto aguarda', () => { carregar(); fixture.nativeElement.querySelector('[data-remover="2"] button').click(); fixture.detectChanges(); const req = http.expectOne(url); expect(req.request.body).toEqual({ itens: [{ produtoId: 1, quantidade: 1 }] }); expect(fixture.nativeElement.querySelector('[data-testid="total"]')).toBeNull(); req.flush(dto([1], 9500)); fixture.detectChanges(); expect(texto()).toMatch(/95,00/); expect(texto()).not.toContain('Livro 2'); });
    it('limpar remove itens e total sem nova cotacao HTTP', () => { carregar(); carrinho.limpar(); fixture.detectChanges(); expect(texto()).toContain('Seu carrinho está vazio'); expect(fixture.nativeElement.querySelector('[data-testid="total"]')).toBeNull(); http.expectNone(url); });
    it('mudanca externa nos IDs atualiza cotacao', () => { carregar(); carrinho.remover(1); fixture.detectChanges(); http.expectOne(url).flush(dto([2], 9500)); fixture.detectChanges(); expect(texto()).toContain('Livro 2'); expect(texto()).not.toContain('Livro 1'); });
    it('falha de rede preserva itens e permite nova tentativa', () => { pagina(); http.expectOne(url).error(new ProgressEvent('error')); fixture.detectChanges(); expect(texto()).toContain('Não foi possível consultar'); expect(carrinho.ids()).toEqual([1, 2]); carrinho.cotar(); http.expectOne(url).flush(dto()); fixture.detectChanges(); expect(fixture.nativeElement.querySelector('[data-testid="total"]')).not.toBeNull(); });
    it('422 informa revisao sem atribuir indisponibilidade definitiva', () => { pagina(); http.expectOne(url).flush({}, { status: 422, statusText: 'Indisponivel' }); fixture.detectChanges(); expect(texto()).toContain('A cotação precisa ser revisada'); expect(carrinho.ids()).toEqual([1, 2]); expect(texto()).not.toContain('Livro 1 indisponível'); expect(fixture.nativeElement.querySelector('[data-testid="total"]')).toBeNull(); });
    it('429 informa espera e preserva itens', () => { pagina(); http.expectOne(url).flush({}, { status: 429, statusText: 'Limite' }); fixture.detectChanges(); expect(texto()).toContain('Aguarde um minuto'); expect(carrinho.ids()).toEqual([1, 2]); });
    it('limpeza durante cotacao cancela resposta antiga', () => { pagina(); const req = http.expectOne(url); carrinho.limpar(); fixture.detectChanges(); expect(req.cancelled).toBeTrue(); expect(texto()).toContain('Seu carrinho está vazio'); });
    it('remocao durante cotacao cancela resposta obsoleta', () => { pagina(); const req = http.expectOne(url); carrinho.remover(2); fixture.detectChanges(); expect(req.cancelled).toBeTrue(); http.expectOne(url).flush(dto([1], 9500)); fixture.detectChanges(); expect(fixture.nativeElement.querySelector('[data-testid="total"]').textContent).toMatch(/95,00/); });
    it('nova cotacao com falha nao confirma valor anterior', () => { carregar(); carrinho.cotar(); http.expectOne(url).flush({}, { status: 422, statusText: 'Indisponivel' }); fixture.detectChanges(); expect(fixture.nativeElement.querySelector('[data-testid="total"]')).toBeNull(); expect(texto()).not.toMatch(/190,00/); });
    it('links apontam ao catalogo e detalhes, sem pagamento', () => { carregar(); expect(fixture.nativeElement.querySelector('a[href="/loja"]')).not.toBeNull(); expect(fixture.nativeElement.querySelector('a[href="/loja/produto/1"]')).not.toBeNull(); expect(texto()).not.toMatch(/Pagar|Finalizar compra/); });
});
