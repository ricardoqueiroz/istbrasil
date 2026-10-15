import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZoneChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { BehaviorSubject } from 'rxjs';
import { environment } from '../../../environments/environment';
import { CARRINHO_STORAGE, CarrinhoService } from '../../services/carrinho.service';
import { LojaProdutoComponent } from './loja-produto.component';
import { LojaProduto } from './models/loja.model';

describe('LojaProdutoComponent', () => {
    let fixture: ComponentFixture<LojaProdutoComponent>;
    let http: HttpTestingController;
    let params: BehaviorSubject<ReturnType<typeof convertToParamMap>>;
    const url = `${environment.apiUrl}/loja`;
    const livro: LojaProduto = { id: 1, sku: 'SKU1', titulo: 'Livro 1', descricao: 'Música &amp; memória\nSegunda linha', categoria: { id: 2, nome: 'Música', slug: 'musica', categoriaPaiId: 1, ordem: 1 }, idioma: 'en-uk', imagemUrl: null, precoCentavos: 9500, moeda: 'BRL', disponivel: true, quantidadeMaxima: 1 };
    beforeEach(() => {
        params = new BehaviorSubject(convertToParamMap({ id: '1' }));
        TestBed.configureTestingModule({ imports: [LojaProdutoComponent], providers: [provideZoneChangeDetection(), provideRouter([]), provideHttpClient(), provideHttpClientTesting(), { provide: CARRINHO_STORAGE, useValue: null }] });
        TestBed.overrideComponent(LojaProdutoComponent, { add: { providers: [{ provide: ActivatedRoute, useValue: { paramMap: params.asObservable() } }] } });
        http = TestBed.inject(HttpTestingController);
    });
    afterEach(() => http.verify());
    const pagina = (id = '1') => { params.next(convertToParamMap({ id })); fixture = TestBed.createComponent(LojaProdutoComponent); fixture.detectChanges(); };
    const carregar = () => { pagina(); http.expectOne(`${url}/produtos/1`).flush(livro); fixture.detectChanges(); };
    const texto = () => fixture.nativeElement.textContent as string;

    it('mostra carregamento', () => { pagina(); expect(texto()).toContain('Carregando produto'); http.expectOne(`${url}/produtos/1`).flush(livro); });
    for (const id of ['1', '2']) it(`consulta ID valido ${id}`, () => { pagina(id); http.expectOne(`${url}/produtos/${id}`).flush({ ...livro, id: Number(id) }); fixture.detectChanges(); expect(texto()).toContain('SKU1'); expect(texto()).toContain('Inglês'); expect(texto()).toMatch(/95,00/); });
    it('rejeita IDs invalidos sem HTTP', () => { pagina('0'); for (const id of ['abc', '-1', '1.5', '2147483648', '']) params.next(convertToParamMap({ id })); fixture.detectChanges(); expect(texto()).toContain('Identificador de produto inválido'); http.expectNone((req) => req.url.includes('/produtos/')); });
    it('distingue produto nao encontrado', () => { pagina(); http.expectOne(`${url}/produtos/1`).flush({}, { status: 404, statusText: 'Ausente' }); fixture.detectChanges(); expect(texto()).toContain('Produto não encontrado ou indisponível'); expect(fixture.componentInstance.podeTentar()).toBeFalse(); });
    it('falha de rede oferece nova tentativa', () => { pagina(); http.expectOne(`${url}/produtos/1`).error(new ProgressEvent('error')); fixture.detectChanges(); expect(fixture.componentInstance.podeTentar()).toBeTrue(); fixture.componentInstance.recarregar(); http.expectOne(`${url}/produtos/1`).flush(livro); fixture.detectChanges(); expect(texto()).toContain('Livro 1'); });
    it('trata erro HTTP interno sem exibir seu corpo', () => { pagina(); http.expectOne(`${url}/produtos/1`).flush({ segredo: 'SQL privado' }, { status: 500, statusText: 'Erro' }); fixture.detectChanges(); expect(texto()).toContain('Não foi possível carregar o produto'); expect(texto()).not.toContain('SQL privado'); });
    it('normaliza entidades uma vez e preserva quebras de linha', () => { carregar(); expect(fixture.nativeElement.querySelector('[data-testid="descricao"]').textContent).toBe('Música & memória\nSegunda linha'); });
    it('descricao permanece texto seguro mesmo com tags e entidades maliciosas', () => { pagina(); http.expectOne(`${url}/produtos/1`).flush({ ...livro, descricao: '&lt;img src=x onerror=alert(1)&gt; <script>alert(2)</script> &amp;lt;b&amp;gt;' }); fixture.detectChanges(); const descricao = fixture.nativeElement.querySelector('[data-testid="descricao"]'); expect(descricao.querySelector('img,script,b')).toBeNull(); expect(descricao.textContent).toContain('<img src=x'); expect(descricao.textContent).toContain('&lt;b&gt;'); });
    it('adiciona produto e desabilita botao ja adicionado', () => { carregar(); fixture.nativeElement.querySelector('[data-testid="adicionar"] button').click(); fixture.detectChanges(); expect(TestBed.inject(CarrinhoService).ids()).toEqual([1]); expect(fixture.nativeElement.querySelector('[data-testid="adicionar"] button').disabled).toBeTrue(); expect(texto()).toContain('Adicionado ao carrinho'); });
    it('contador e links de navegacao estao presentes', () => { carregar(); TestBed.inject(CarrinhoService).adicionar(1); fixture.detectChanges(); expect(texto()).toContain('Carrinho (1)'); expect(fixture.nativeElement.querySelector('a[href="/loja"]')).not.toBeNull(); expect(fixture.nativeElement.querySelector('a[href="/loja/carrinho"]')).not.toBeNull(); });
    it('troca de ID cancela resposta obsoleta', () => { pagina(); const antiga = http.expectOne(`${url}/produtos/1`); params.next(convertToParamMap({ id: '2' })); expect(antiga.cancelled).toBeTrue(); http.expectOne(`${url}/produtos/2`).flush({ ...livro, id: 2, titulo: 'Livro 2' }); fixture.detectChanges(); expect(texto()).toContain('Livro 2'); expect(texto()).not.toContain('Livro 1'); });
    it('ID invalido cancela consulta anterior', () => { pagina(); const antiga = http.expectOne(`${url}/produtos/1`); params.next(convertToParamMap({ id: 'invalido' })); expect(antiga.cancelled).toBeTrue(); expect(fixture.componentInstance.produto()).toBeNull(); });
    it('destruicao cancela HTTP pendente', () => { pagina(); const req = http.expectOne(`${url}/produtos/1`); fixture.destroy(); expect(req.cancelled).toBeTrue(); });
});
