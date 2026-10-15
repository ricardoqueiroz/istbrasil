import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { Observable, PartialObserver, Subject, Subscription } from 'rxjs';
import { environment } from '../../environments/environment';
import { LojaCotacao, LojaProduto } from '../pages/loja/models/loja.model';
import { CARRINHO_STORAGE, CARRINHO_STORAGE_KEY, CarrinhoService, CarrinhoStorage } from './carrinho.service';
import { LojaService } from './loja.service';

const cotacaoPara = (ids: number[], totalCentavos = ids.length * 9500): LojaCotacao => ({
    moeda: 'BRL', totalCentavos, geradaEm: '2026-10-15T12:00:00.000Z',
    itens: ids.map((produtoId) => {
        const produto: LojaProduto = { id: produtoId, sku: `SKU${produtoId}`, titulo: 'Livro', descricao: null,
            categoria: { id: 2, nome: 'Música', slug: 'musica', categoriaPaiId: 1, ordem: 1 }, idioma: 'pt-br',
            imagemUrl: null, moeda: 'BRL', precoCentavos: 9500, quantidadeMaxima: 1, disponivel: true };
        return { produtoId, quantidade: 1, produto, precoUnitarioCentavos: 9500, subtotalCentavos: 9500 };
    })
});

describe('CarrinhoService', () => {
    let loja: jasmine.SpyObj<LojaService>;
    let storage: jasmine.SpyObj<CarrinhoStorage>;
    let respostas: Subject<LojaCotacao>[];

    beforeEach(() => {
        respostas = [];
        loja = jasmine.createSpyObj<LojaService>('LojaService', ['cotar']);
        loja.cotar.and.callFake(() => { const resposta = new Subject<LojaCotacao>(); respostas.push(resposta); return resposta; });
        storage = jasmine.createSpyObj<CarrinhoStorage>('sessionStorage', ['getItem', 'setItem', 'removeItem']);
        storage.getItem.and.returnValue(null);
        TestBed.configureTestingModule({ providers: [{ provide: LojaService, useValue: loja }, { provide: CARRINHO_STORAGE, useValue: storage }] });
    });
    const criar = () => TestBed.inject(CarrinhoService);

    it('inicia vazio com estados seguros', () => {
        const c = criar(); expect(c.ids()).toEqual([]); expect(c.vazio()).toBeTrue(); expect(c.quantidadeTitulos()).toBe(0);
        expect(c.cotacao()).toBeNull(); expect(c.erro()).toBeNull(); expect(c.inconsistencias()).toEqual([]); expect(c.carregando()).toBeFalse();
    });
    it('adiciona e atualiza sinais derivados', () => { const c = criar(); expect(c.adicionar(1)).toBeTrue(); expect(c.ids()).toEqual([1]); expect(c.contem(1)).toBeTrue(); expect(c.vazio()).toBeFalse(); expect(c.quantidadeTitulos()).toBe(1); });
    it('ignora adicao duplicada', () => { const c = criar(); c.adicionar(1); expect(c.adicionar(1)).toBeFalse(); expect(c.ids()).toEqual([1]); });
    it('preserva ordem de adicao', () => { const c = criar(); c.adicionar(2); c.adicionar(1); expect(c.ids()).toEqual([2, 1]); });
    it('remove somente o ID solicitado', () => { const c = criar(); c.adicionar(1); c.adicionar(2); c.remover(1); expect(c.ids()).toEqual([2]); expect(c.contem(1)).toBeFalse(); });
    it('remocao inexistente nao invalida cotacao', () => { const c = criar(); c.adicionar(1); c.cotar(); respostas[0].next(cotacaoPara([1])); c.remover(2); expect(c.cotacao()).not.toBeNull(); });
    it('limpa itens e remove a chave de armazenamento', () => { const c = criar(); c.adicionar(1); c.limpar(); expect(c.ids()).toEqual([]); expect(storage.removeItem).toHaveBeenCalledWith(CARRINHO_STORAGE_KEY); });
    it('limita a 100 titulos', () => { const c = criar(); for (let id = 1; id <= 100; id++) expect(c.adicionar(id)).toBeTrue(); expect(c.adicionar(101)).toBeFalse(); expect(c.quantidadeTitulos()).toBe(100); });
    it('rejeita IDs invalidos sem alterar armazenamento', () => {
        const c = criar(); for (const id of [0, -1, 1.5, NaN, Infinity, 2147483648, Number.MAX_SAFE_INTEGER]) expect(c.adicionar(id)).toBeFalse();
        expect(c.ids()).toEqual([]); expect(storage.setItem).not.toHaveBeenCalled();
    });
    it('persiste exclusivamente array de IDs', () => { const c = criar(); c.adicionar(2); c.adicionar(1); expect(storage.setItem).toHaveBeenCalledWith(CARRINHO_STORAGE_KEY, '[2,1]'); });
    it('restaura IDs eliminando valores invalidos e duplicatas', () => {
        storage.getItem.and.returnValue('[2,1,2,0,-1,1.5,"3",null,{},2147483648]');
        const c = criar(); expect(c.ids()).toEqual([2, 1]); expect(c.cotacao()).toBeNull(); expect(storage.setItem).toHaveBeenCalledWith(CARRINHO_STORAGE_KEY, '[2,1]');
    });
    it('restauracao aplica limite de 100', () => { storage.getItem.and.returnValue(JSON.stringify(Array.from({ length: 120 }, (_, i) => i + 1))); const c = criar(); expect(c.quantidadeTitulos()).toBe(100); expect(c.ids()[99]).toBe(100); });
    for (const valor of ['{', '{"ids":[1],"totalCentavos":1}', 'null', '"1"']) it(`tolera storage corrompido ou formato indevido: ${valor}`, () => { storage.getItem.and.returnValue(valor); expect(criar().ids()).toEqual([]); });
    it('tolera falha na leitura do storage', () => { storage.getItem.and.throwError('bloqueado'); expect(criar().ids()).toEqual([]); });
    it('tolera falha na escrita e na remocao', () => { storage.setItem.and.throwError('quota'); storage.removeItem.and.throwError('bloqueado'); const c = criar(); expect(c.adicionar(1)).toBeTrue(); c.limpar(); expect(c.vazio()).toBeTrue(); });
    it('funciona sem storage', () => { TestBed.overrideProvider(CARRINHO_STORAGE, { useValue: null }); const c = criar(); c.adicionar(1); c.cotar(); respostas[0].next(cotacaoPara([1])); expect(c.cotacao()?.totalCentavos).toBe(9500); });
    it('array de IDs exposto nao pode ser modificado externamente', () => { const c = criar(); c.adicionar(1); expect(Object.isFrozen(c.ids())).toBeTrue(); expect(() => (c.ids() as number[]).push(2)).toThrow(); expect(c.ids()).toEqual([1]); });
    it('carrinho vazio nao solicita cotacao', () => { const c = criar(); c.cotar(); expect(loja.cotar).not.toHaveBeenCalled(); expect(c.cotacao()).toBeNull(); expect(c.carregando()).toBeFalse(); });
    it('solicita quantidade fixa 1 e aceita exclusivamente total oficial', () => {
        const c = criar(); c.adicionar(2); c.adicionar(1); c.cotar(); expect(c.carregando()).toBeTrue(); expect(c.cotacao()).toBeNull();
        expect(loja.cotar).toHaveBeenCalledOnceWith([{ produtoId: 2, quantidade: 1 }, { produtoId: 1, quantidade: 1 }]);
        respostas[0].next(cotacaoPara([2, 1], 18000)); expect(c.cotacao()?.totalCentavos).toBe(18000); expect(c.carregando()).toBeFalse();
        expect(storage.setItem.calls.mostRecent().args[1]).toBe('[2,1]');
    });
    it('adicao invalida a cotacao', () => { const c = criar(); c.adicionar(1); c.cotar(); respostas[0].next(cotacaoPara([1])); c.adicionar(2); expect(c.cotacao()).toBeNull(); });
    it('duplicata preserva cotacao e requisicao', () => { const c = criar(); c.adicionar(1); c.cotar(); c.adicionar(1); respostas[0].next(cotacaoPara([1])); expect(c.cotacao()?.totalCentavos).toBe(9500); });
    it('remocao invalida cotacao e resposta antiga nao sobrescreve a nova', () => {
        const c = criar(); c.adicionar(1); c.adicionar(2); c.cotar(); c.remover(2); c.cotar();
        respostas[1].next(cotacaoPara([1])); respostas[0].next(cotacaoPara([1, 2])); expect(c.cotacao()?.totalCentavos).toBe(9500); expect(c.ids()).toEqual([1]);
    });
    it('duas cotacoes simultaneas conservam somente a mais recente', () => {
        const c = criar(); c.adicionar(1); c.cotar(); c.cotar(); respostas[1].next(cotacaoPara([1], 9000)); respostas[0].next(cotacaoPara([1])); expect(c.cotacao()?.totalCentavos).toBe(9000);
    });
    it('limpar durante requisicao impede resposta tardia', () => { const c = criar(); c.adicionar(1); c.cotar(); c.limpar(); respostas[0].next(cotacaoPara([1])); expect(c.cotacao()).toBeNull(); expect(c.carregando()).toBeFalse(); expect(c.vazio()).toBeTrue(); });
    it('falha antiga nao apaga a cotacao nova', () => { const c = criar(); c.adicionar(1); c.cotar(); c.cotar(); respostas[1].next(cotacaoPara([1])); respostas[0].error(new HttpErrorResponse({ status: 500 })); expect(c.cotacao()?.totalCentavos).toBe(9500); expect(c.erro()).toBeNull(); });
    it('permite repetir cotacao sem mudar os itens e descarta preco anterior enquanto aguarda', () => {
        const c = criar(); c.adicionar(1); c.cotar(); respostas[0].next(cotacaoPara([1])); c.cotar(); expect(c.cotacao()).toBeNull(); expect(c.carregando()).toBeTrue();
        respostas[1].next(cotacaoPara([1], 9000)); expect(c.cotacao()?.totalCentavos).toBe(9000); expect(loja.cotar).toHaveBeenCalledTimes(2);
    });
    for (const status of [0, 400, 404, 422, 429, 500]) it(`preserva itens e informa falha HTTP ${status}`, () => {
        const c = criar(); c.adicionar(1); c.cotar(); respostas[0].error(new HttpErrorResponse({ status }));
        expect(c.ids()).toEqual([1]); expect(c.cotacao()).toBeNull(); expect(c.carregando()).toBeFalse(); expect(c.erro()?.status).toBe(status);
        expect(c.inconsistencias().length).toBe(status === 422 ? 1 : 0);
    });
    it('422 identifica IDs pendentes sem afirmar qual produto foi recusado', () => {
        const c = criar(); c.adicionar(1); c.adicionar(2); c.cotar(); respostas[0].error(new HttpErrorResponse({ status: 422 }));
        expect(c.inconsistencias().map((i) => i.produtoId)).toEqual([1, 2]); expect(c.inconsistencias().every((i) => i.codigo === 'DISPONIBILIDADE_NAO_CONFIRMADA')).toBeTrue();
        c.remover(2); expect(c.inconsistencias()).toEqual([]); expect(c.erro()).toBeNull();
    });
    it('recupera de erro mediante nova cotacao', () => { const c = criar(); c.adicionar(1); c.cotar(); respostas[0].error(new HttpErrorResponse({ status: 429 })); c.cotar(); expect(c.erro()).toBeNull(); respostas[1].next(cotacaoPara([1])); expect(c.cotacao()?.totalCentavos).toBe(9500); });
    it('nao aceita cotacao de outro conjunto de IDs', () => { const c = criar(); c.adicionar(1); c.cotar(); respostas[0].next(cotacaoPara([2])); expect(c.cotacao()).toBeNull(); expect(c.erro()?.codigo).toBe('COTACAO_INVALIDA'); expect(c.ids()).toEqual([1]); });
    it('nao aceita cotacao com IDs duplicados', () => { const c = criar(); c.adicionar(1); c.adicionar(2); c.cotar(); respostas[0].next(cotacaoPara([1, 1])); expect(c.erro()?.codigo).toBe('COTACAO_INVALIDA'); });
    it('nao aceita total fracionario', () => { const c = criar(); c.adicionar(1); c.cotar(); respostas[0].next(cotacaoPara([1], 95.5)); expect(c.cotacao()).toBeNull(); });
    it('versionamento bloqueia callbacks antigos mesmo se o transporte ignorar cancelamento', () => {
        const observadores: PartialObserver<LojaCotacao>[] = [];
        loja.cotar.and.callFake(() => ({ subscribe: (observer: PartialObserver<LojaCotacao>) => { observadores.push(observer); return new Subscription(); } }) as unknown as Observable<LojaCotacao>);
        const c = criar(); c.adicionar(1); c.adicionar(2); c.cotar(); c.remover(2); c.cotar();
        observadores[1].next?.(cotacaoPara([1])); observadores[0].next?.(cotacaoPara([1, 2])); observadores[0].error?.(new HttpErrorResponse({ status: 500 }));
        expect(c.cotacao()?.totalCentavos).toBe(9500); expect(c.erro()).toBeNull();
    });
    it('destruicao do servico cancela a assinatura', () => { const c = criar(); c.adicionar(1); c.cotar(); expect(respostas[0].observed).toBeTrue(); TestBed.resetTestingModule(); expect(respostas[0].observed).toBeFalse(); });
});

describe('CarrinhoService com HTTP real de teste', () => {
    it('cancela a requisicao HTTP ao alterar itens', () => {
        TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting(), { provide: CARRINHO_STORAGE, useValue: null }] });
        const c = TestBed.inject(CarrinhoService); const http = TestBed.inject(HttpTestingController);
        c.adicionar(1); c.adicionar(2); c.cotar(); const antiga = http.expectOne(`${environment.apiUrl}/loja/cotacao`);
        c.remover(2); expect(antiga.cancelled).toBeTrue(); c.cotar(); const atual = http.expectOne(`${environment.apiUrl}/loja/cotacao`);
        expect(atual.request.body).toEqual({ itens: [{ produtoId: 1, quantidade: 1 }] }); atual.flush(cotacaoPara([1])); expect(c.cotacao()?.totalCentavos).toBe(9500); http.verify();
    });
});
