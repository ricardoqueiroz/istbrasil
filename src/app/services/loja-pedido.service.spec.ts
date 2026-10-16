import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { LojaPedido } from '../pages/loja/models/loja.model';
import { CARRINHO_STORAGE, CarrinhoStorage } from './carrinho.service';
import { LojaPedidoService, PEDIDO_PENDENTE_STORAGE_KEY } from './loja-pedido.service';

describe('LojaPedidoService', () => {
    let service: LojaPedidoService;
    let http: HttpTestingController;
    let dados: Map<string, string>;
    let storage: CarrinhoStorage;
    let expiraEm: string;
    const entrada = { produtoIds: [1, 2], compradorEmail: 'comprador@example.com' };
    const pedido: LojaPedido = {
        publicId: '20202020-2020-4020-8020-202020202020', estado: 'CRIADO', versao: 1, moeda: 'BRL', totalCentavos: 19000,
        criadoEm: '2026-10-16T12:00:00.000Z', expiraEm: '2026-10-16T12:30:00.000Z',
        itens: [1, 2].map((produtoId) => ({ produtoId, sku: `SKU${produtoId}`, titulo: `Livro ${produtoId}`, tipo: 'E-Book',
            quantidade: 1 as const, precoUnitarioCentavos: 9500, subtotalCentavos: 9500 }))
    };
    const configurar = () => {
        TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting(), { provide: CARRINHO_STORAGE, useValue: storage }] });
        service = TestBed.inject(LojaPedidoService);
        http = TestBed.inject(HttpTestingController);
    };
    beforeEach(() => {
        dados = new Map();
        storage = { getItem: (k) => dados.get(k) ?? null, setItem: (k, v) => { dados.set(k, v); }, removeItem: (k) => { dados.delete(k); } };
        expiraEm = new Date(Date.now() + 86400000).toISOString();
        configurar();
    });
    afterEach(() => http.verify());
    const sessao = async (status = 201, validade = expiraEm) => {
        const req = http.expectOne('/api/loja/sessao');
        expect(req.request.body).toEqual({});
        expect(req.request.withCredentials).toBeTrue();
        expect(req.request.headers.get('X-IST-Loja')).toBe('1');
        req.flush({ sessao: { expiraEm: validade } }, { status, statusText: 'OK', headers: { 'X-CSRF-Token': 'csrf-somente-memoria' } });
        await Promise.resolve();
    };
    const falhaIncerta = async () => {
        const operacao = service.confirmar(entrada, 19000);
        await sessao();
        const req = http.expectOne('/api/loja/pedidos');
        const chave = req.request.headers.get('Idempotency-Key')!;
        req.error(new ProgressEvent('error'));
        await operacao;
        return chave;
    };

    it('envia somente IDs/email, UUID v4 e protecoes; confirma resposta oficial', async () => {
        const operacao = service.confirmar(entrada, 19000);
        await sessao();
        const req = http.expectOne('/api/loja/pedidos');
        expect(req.request.method).toBe('POST');
        expect(req.request.withCredentials).toBeTrue();
        expect(req.request.headers.get('Idempotency-Key')).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
        expect(req.request.headers.get('X-CSRF-Token')).toBe('csrf-somente-memoria');
        expect(req.request.headers.get('X-IST-Loja')).toBe('1');
        expect(req.request.body).toEqual(entrada);
        expect(dados.get(PEDIDO_PENDENTE_STORAGE_KEY)).not.toContain('csrf');
        req.flush(pedido, { status: 201, statusText: 'Created' });
        await operacao;
        expect(service.confirmado()).toEqual(pedido);
        expect(service.pendente()).toBeNull();
        expect(dados.has(PEDIDO_PENDENTE_STORAGE_KEY)).toBeFalse();
    });
    it('serializa duplo clique inclusive durante bootstrap', async () => {
        const operacao = service.confirmar(entrada, 19000);
        await service.confirmar(entrada, 19000);
        await sessao();
        await service.confirmar(entrada, 19000);
        http.expectOne('/api/loja/pedidos').flush(pedido);
        await operacao;
        expect(service.processando()).toBeFalse();
    });
    it('reusa chave e payload congelado apos falha de rede, aceitando replay 200', async () => {
        const chave = await falhaIncerta();
        expect(service.confirmado()).toBeNull();
        const operacao = service.confirmar({ produtoIds: [3], compradorEmail: 'outro@example.com' }, 1);
        await sessao(200);
        const req = http.expectOne('/api/loja/pedidos');
        expect(req.request.body).toEqual(entrada);
        expect(req.request.headers.get('Idempotency-Key')).toBe(chave);
        req.flush(pedido, { status: 200, statusText: 'OK' });
        await operacao;
        expect(service.confirmado()?.publicId).toBe(pedido.publicId);
    });
    it('restaura tentativa apos recarregar sem persistir CSRF ou token de sessao', async () => {
        const chave = await falhaIncerta();
        http.verify();
        TestBed.resetTestingModule();
        configurar();
        expect(service.pendente()?.chave).toBe(chave);
        const operacao = service.confirmar(entrada, 19000);
        await sessao(200);
        const req = http.expectOne('/api/loja/pedidos');
        expect(req.request.headers.get('Idempotency-Key')).toBe(chave);
        req.flush(pedido);
        await operacao;
        expect([...dados.values()].join('')).not.toContain('csrf');
    });
    for (const [status, codigo] of [[503, 'CONTENCAO_TEMPORARIA'], [500, 'ERRO_INTERNO'], [409, 'CONFLITO_IDEMPOTENCIA']] as const) {
        it(`preserva tentativa em HTTP ${status}`, async () => {
            const operacao = service.confirmar(entrada, 19000);
            await sessao();
            const req = http.expectOne('/api/loja/pedidos');
            const chave = req.request.headers.get('Idempotency-Key')!;
            req.flush({ erro: { codigo, mensagem: 'SQL segredo privado' } }, { status, statusText: 'Erro' });
            await operacao;
            expect(service.pendente()?.chave).toBe(chave);
            expect(service.erro()?.mensagem).not.toContain('SQL');
        });
    }
    for (const [status, codigo] of [[401, 'SESSAO_INVALIDA'], [403, 'CSRF_INVALIDO'], [422, 'PRODUTO_INDISPONIVEL'], [422, 'EMAIL_INVALIDO']] as const) {
        it(`trata recusa definitiva ${codigo} sem limpar carrinho nem confirmar`, async () => {
            const operacao = service.confirmar(entrada, 19000);
            await sessao();
            http.expectOne('/api/loja/pedidos').flush({ erro: { codigo } }, { status, statusText: 'Erro' });
            await operacao;
            expect(service.pendente()).toBeNull();
            expect(service.confirmado()).toBeNull();
            expect(service.erro()?.codigo).toBe(codigo);
        });
    }
    it('nao descarta resultado anterior incerto se repeticao receber 429', async () => {
        const chave = await falhaIncerta();
        const operacao = service.confirmar(entrada, 19000);
        await sessao(200);
        http.expectOne('/api/loja/pedidos').flush({ erro: { codigo: 'LIMITE_REQUISICOES' } }, { status: 429, statusText: 'Limite' });
        await operacao;
        expect(service.pendente()?.chave).toBe(chave);
    });
    it('preserva chave em timeout HTTP 408 ou erro fora do contrato', async () => {
        const operacao = service.confirmar(entrada, 19000);
        await sessao();
        const req = http.expectOne('/api/loja/pedidos');
        const chave = req.request.headers.get('Idempotency-Key')!;
        req.flush('Request Timeout', { status: 408, statusText: 'Timeout' });
        await operacao;
        expect(service.pendente()?.chave).toBe(chave);
    });
    it('nao repete POST se o bootstrap trocar a sessao original', async () => {
        await falhaIncerta();
        const operacao = service.confirmar(entrada, 19000);
        await sessao(201);
        await operacao;
        http.expectNone('/api/loja/pedidos');
        expect(service.pendente()).not.toBeNull();
        expect(service.erro()?.codigo).toBe('SESSAO_INVALIDA');
    });
    it('nao repete POST se a validade da sessao mudar', async () => {
        await falhaIncerta();
        const operacao = service.confirmar(entrada, 19000);
        await sessao(200, new Date(Date.now() + 3600000).toISOString());
        await operacao;
        http.expectNone('/api/loja/pedidos');
        expect(service.erro()?.codigo).toBe('SESSAO_INVALIDA');
    });
    it('bloqueia tentativa anterior com sessao expirada sem emitir HTTP', async () => {
        await falhaIncerta();
        const t = service.pendente()!;
        dados.set(PEDIDO_PENDENTE_STORAGE_KEY, JSON.stringify({ ...t, expiraEm: '2020-01-01T00:00:00.000Z' }));
        TestBed.resetTestingModule(); configurar();
        await service.confirmar(entrada, 19000);
        http.expectNone('/api/loja/sessao');
        expect(service.erro()?.codigo).toBe('SESSAO_INVALIDA');
    });
    it('nao envia pedido sem CSRF valido na resposta de sessao', async () => {
        const operacao = service.confirmar(entrada, 19000);
        http.expectOne('/api/loja/sessao').flush({ sessao: { expiraEm } });
        await operacao;
        http.expectNone('/api/loja/pedidos');
        expect(service.erro()?.codigo).toBe('SESSAO_INVALIDA');
    });
    it('falha de bootstrap nao inicia pedido nem conserva dados pessoais', async () => {
        const operacao = service.confirmar(entrada, 19000);
        http.expectOne('/api/loja/sessao').error(new ProgressEvent('error'));
        await operacao;
        http.expectNone('/api/loja/pedidos');
        expect(dados.size).toBe(0);
        expect(service.processando()).toBeFalse();
    });
    it('nao envia POST se nao consegue preservar a chave no armazenamento', async () => {
        spyOn(storage, 'setItem').and.throwError('bloqueado');
        const operacao = service.confirmar(entrada, 19000);
        await sessao(); await operacao;
        http.expectNone('/api/loja/pedidos');
        expect(service.confirmado()).toBeNull();
    });
    it('nao transforma falha de limpeza em erro apos sucesso', async () => {
        spyOn(storage, 'removeItem').and.throwError('bloqueado');
        const operacao = service.confirmar(entrada, 19000);
        await sessao(); http.expectOne('/api/loja/pedidos').flush(pedido); await operacao;
        expect(service.confirmado()).toEqual(pedido);
        expect(service.erro()).toBeNull();
    });
    it('bloqueia novo envio se tentativa persistida estiver corrompida', async () => {
        dados.set(PEDIDO_PENDENTE_STORAGE_KEY, '{invalido');
        TestBed.resetTestingModule(); configurar();
        await service.confirmar(entrada, 19000);
        http.expectNone('/api/loja/sessao');
        expect(service.erro()?.codigo).toBe('TENTATIVA_IRRECUPERAVEL');
    });
    it('apresenta total definitivo alterado e nao emite novo POST apos sucesso', async () => {
        const operacao = service.confirmar(entrada, 18000);
        await sessao(); http.expectOne('/api/loja/pedidos').flush(pedido); await operacao;
        expect(service.precoAlterado()).toBeTrue();
        await service.confirmar(entrada, 18000);
        http.expectNone('/api/loja/sessao');
    });
});
