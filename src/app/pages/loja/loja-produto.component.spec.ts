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
    const livro: LojaProduto = { id: 1, sku: 'SKU1', titulo: 'Livro 1', descricao: 'Música &amp; memória\nSegunda linha', categoria: { id: 2, nome: 'Música', slug: 'musica', categoriaPaiId: 1, ordem: 1 }, idioma: 'en-uk', imagemUrl: null, precoCentavos: 9500, moeda: 'BRL', disponivel: true, tipo: 'DIGITAL', livroId: 1, formatoEditorial: 'E-Book', quantidadeMaxima: 1 };
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
    const carregarDescricao = (descricao: string | null) => {
        pagina();
        http.expectOne(`${url}/produtos/1`).flush({ ...livro, descricao });
        fixture.detectChanges();
    };

    it('renderiza JSON em linhas separadas, com chaves em negrito e na ordem recebida', () => {
        carregarDescricao(JSON.stringify({ Title: 'Livro de partituras', Content: '105 partituras', Format: 'PDF-XA, A4' }));
        const linhas = [...fixture.nativeElement.querySelectorAll('[data-testid="descricao-propriedade"]')] as HTMLElement[];
        expect(linhas.length).toBe(3);
        expect(linhas.map((linha) => linha.querySelector('strong')?.textContent)).toEqual(['Title:', 'Content:', 'Format:']);
        expect(linhas.map((linha) => linha.textContent?.trim())).toEqual(['Title: Livro de partituras', 'Content: 105 partituras', 'Format: PDF-XA, A4']);
        expect(linhas.every((linha) => getComputedStyle(linha).display === 'block')).toBeTrue();
        expect(Number(getComputedStyle(linhas[0].querySelector('strong')!).fontWeight)).toBeGreaterThanOrEqual(600);
        expect(fixture.componentInstance.descricao()).toBe('');
    });
    it('preserva caracteres especiais, aspas, quebras de linha e normaliza entidades somente uma vez', () => {
        carregarDescricao(JSON.stringify({ 'Title &amp; Content': 'Música & memória "viva"\n105 partituras &quot;A4&quot; &amp;lt;b&amp;gt;' }));
        expect(fixture.componentInstance.descricaoPropriedades()).toEqual([
            { chave: 'Title & Content', valor: 'Música & memória "viva"\n105 partituras "A4" &lt;b&gt;' }
        ]);
        expect(fixture.nativeElement.querySelector('[data-testid="descricao"]').textContent).toContain('Música & memória "viva"');
    });
    it('JSON invalido permanece texto seguro sem impedir os detalhes', () => {
        const descricao = '{"Title": "Livro", <img src=x onerror=alert(1)>';
        carregarDescricao(descricao);
        expect(fixture.componentInstance.descricaoPropriedades()).toEqual([]);
        const elemento = fixture.nativeElement.querySelector('[data-testid="descricao"]');
        expect(elemento.textContent).toBe(descricao);
        expect(elemento.querySelector('img')).toBeNull();
        expect(texto()).toContain('SKU1');
    });
    for (const descricao of ['null', '[]', '42', '"texto"', '{"Content":{"nested":"valor"}}']) {
        it(`JSON sem objeto simples de valores textuais usa fallback: ${descricao}`, () => {
            carregarDescricao(descricao);
            expect(fixture.componentInstance.descricaoPropriedades()).toEqual([]);
            expect(fixture.nativeElement.querySelector('[data-testid="descricao"]').textContent).toBe(descricao);
        });
    }
    for (const descricao of ['', null, '   ', '{}']) {
        it(`descricao vazia nao exibe secao: ${JSON.stringify(descricao)}`, () => {
            carregarDescricao(descricao);
            expect(fixture.nativeElement.querySelector('.descricao')).toBeNull();
            expect(fixture.componentInstance.descricaoPropriedades()).toEqual([]);
        });
    }
    it('chaves e valores HTML maliciosos em JSON sao exibidos exclusivamente como texto', () => {
        carregarDescricao(JSON.stringify({ '<img src=x onerror=alert(1)>': '<script>alert(2)</script> &lt;iframe src=x&gt;' }));
        const elemento = fixture.nativeElement.querySelector('[data-testid="descricao"]');
        expect(elemento.querySelector('img,script,iframe')).toBeNull();
        expect(elemento.querySelector('strong').textContent).toBe('<img src=x onerror=alert(1)>:');
        expect(elemento.textContent).toContain('<script>alert(2)</script> <iframe src=x>');
    });
    it('troca de produto limpa propriedades anteriores antes da nova resposta', () => {
        carregarDescricao('{"Title":"Livro 1"}');
        params.next(convertToParamMap({ id: '2' })); fixture.detectChanges();
        expect(fixture.componentInstance.descricaoPropriedades()).toEqual([]);
        http.expectOne(`${url}/produtos/2`).flush({ ...livro, id: 2, descricao: 'Texto simples do livro 2' }); fixture.detectChanges();
        expect(fixture.nativeElement.querySelector('[data-testid="descricao"]').textContent).toBe('Texto simples do livro 2');
    });
    it('descricao estruturada preserva adicao e links de navegacao', () => {
        carregarDescricao('{"Title":"Livro"}');
        fixture.nativeElement.querySelector('[data-testid="adicionar"] button').click(); fixture.detectChanges();
        expect(TestBed.inject(CarrinhoService).ids()).toEqual([1]);
        expect(fixture.nativeElement.querySelector('a[href="/loja"]')).not.toBeNull();
        expect(fixture.nativeElement.querySelector('a[href="/loja/carrinho"]').textContent).toContain('Carrinho (1)');
    });

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
    for (const tipo of ['DIGITAL', 'MERCADORIA', 'SERVICO'] as const) it(`detalhe ${tipo} sem livro nao presume E-Book`, () => {
        pagina(); http.expectOne(`${url}/produtos/1`).flush({ ...livro, tipo, livroId: null, formatoEditorial: null, disponivel: false });
        fixture.detectChanges(); expect(texto()).toContain(fixture.componentInstance.tipoProduto(tipo));
        expect(texto()).not.toContain('Livro digital'); expect(texto()).not.toContain('E-Book');
        expect(fixture.nativeElement.querySelector('[data-testid="adicionar"] button').disabled).toBeTrue();
        fixture.componentInstance.adicionar(); expect(TestBed.inject(CarrinhoService).ids()).toEqual([]);
    });
});
