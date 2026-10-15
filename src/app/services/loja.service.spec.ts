import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { environment } from '../../environments/environment';
import { LojaCategoria, LojaCotacao, LojaProduto } from '../pages/loja/models/loja.model';
import { LojaService } from './loja.service';

describe('LojaService', () => {
    let service: LojaService;
    let http: HttpTestingController;
    const url = `${environment.apiUrl}/loja`;
    const categoria: LojaCategoria = { id: 2, nome: 'Música', slug: 'musica', categoriaPaiId: 1, ordem: 1 };
    const produto: LojaProduto = { id: 1, sku: '9788552911036EN2E', titulo: 'Livro', descricao: null, categoria,
        idioma: 'en-uk', imagemUrl: null, precoCentavos: 9500, moeda: 'BRL', disponivel: true, quantidadeMaxima: 1 };
    const cotacao: LojaCotacao = { itens: [{ produtoId: 1, quantidade: 1, produto, precoUnitarioCentavos: 9500, subtotalCentavos: 9500 }],
        moeda: 'BRL', totalCentavos: 9500, geradaEm: '2026-10-15T12:00:00.000Z' };

    beforeEach(() => {
        TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
        service = TestBed.inject(LojaService);
        http = TestBed.inject(HttpTestingController);
    });
    afterEach(() => http.verify());

    it('consulta categorias no ambiente configurado', () => {
        service.listarCategorias().subscribe((r) => expect(r).toEqual([categoria]));
        const req = http.expectOne(`${url}/categorias`); expect(req.request.method).toBe('GET'); req.flush([categoria]);
    });
    it('consulta produtos sem filtro', () => {
        service.listarProdutos().subscribe((r) => expect(r).toEqual([produto]));
        const req = http.expectOne(`${url}/produtos`); expect(req.request.method).toBe('GET'); expect(req.request.params.keys()).toEqual([]); req.flush([produto]);
    });
    it('envia filtro como parametro HTTP', () => {
        service.listarProdutos('musica').subscribe();
        const req = http.expectOne(`${url}/produtos?categoria=musica`); expect(req.request.params.keys()).toEqual(['categoria']); req.flush([]);
    });
    it('consulta detalhes mantendo valores em centavos e campos anulaveis', () => {
        service.obterProduto(1).subscribe((r) => { expect(r.precoCentavos).toBe(9500); expect(r.descricao).toBeNull(); expect(r.imagemUrl).toBeNull(); });
        const req = http.expectOne(`${url}/produtos/1`); expect(req.request.method).toBe('GET'); req.flush(produto);
    });
    it('envia cotacao contendo exclusivamente IDs e quantidades', () => {
        service.cotar([{ produtoId: 1, quantidade: 1 }]).subscribe((r) => expect(r).toEqual(cotacao));
        const req = http.expectOne(`${url}/cotacao`); expect(req.request.method).toBe('POST');
        expect(req.request.body).toEqual({ itens: [{ produtoId: 1, quantidade: 1 }] }); req.flush(cotacao);
    });
    it('preserva o total oficial recebido sem recalcular', () => {
        service.cotar([]).subscribe((r) => expect(r.totalCentavos).toBe(19000));
        http.expectOne(`${url}/cotacao`).flush({ ...cotacao, totalCentavos: 19000 });
    });
    it('permite cotacao vazia com payload explicito', () => {
        service.cotar([]).subscribe((r) => expect(r.itens).toEqual([]));
        const req = http.expectOne(`${url}/cotacao`); expect(req.request.body).toEqual({ itens: [] });
        req.flush({ itens: [], moeda: 'BRL', totalCentavos: 0, geradaEm: cotacao.geradaEm });
    });
    for (const status of [400, 404, 422, 429]) it(`propaga HTTP ${status} e seu corpo`, () => {
        const body = { erro: { codigo: 'TESTE', mensagem: 'Mensagem da API' } };
        service.cotar([]).subscribe({ next: () => fail('Sucesso inesperado'), error: (e: HttpErrorResponse) => { expect(e.status).toBe(status); expect(e.error).toEqual(body); } });
        http.expectOne(`${url}/cotacao`).flush(body, { status, statusText: 'Erro' });
    });
    it('propaga falha de rede', () => {
        service.listarProdutos().subscribe({ next: () => fail('Sucesso inesperado'), error: (e: HttpErrorResponse) => expect(e.status).toBe(0) });
        http.expectOne(`${url}/produtos`).error(new ProgressEvent('error'));
    });
    it('nao dispara HTTP antes da assinatura nem conserva cache entre chamadas', () => {
        const consulta = service.listarCategorias(); http.expectNone(`${url}/categorias`);
        consulta.subscribe((r) => expect(r).toEqual([])); http.expectOne(`${url}/categorias`).flush([]);
        consulta.subscribe((r) => expect(r).toEqual([categoria])); http.expectOne(`${url}/categorias`).flush([categoria]);
    });
});
