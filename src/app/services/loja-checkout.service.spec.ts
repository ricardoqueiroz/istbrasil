import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting, HttpTestingController } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { CARRINHO_STORAGE } from './carrinho.service';
import { CARREGAR_PAYPAL_V6, CHECKOUT_STORAGE_KEY, CheckoutEstado, LojaCheckoutService } from './loja-checkout.service';

describe('Checkout da Loja', () => {
    const id = '20202020-2020-4020-8020-202020202020', pgId = '30303030-3030-4030-8030-303030303030';
    let http: HttpTestingController, service: LojaCheckoutService, dados: Map<string, string>;
    let expira: string, aprovar: boolean, callbacks: any, inicio: jasmine.Spy, carregar: jasmine.Spy;
    const dto = (estado?: string): CheckoutEstado => ({
        ambiente:'sandbox',
        pedido: { publicId: id, estado: estado === 'CAPTURADO' ? 'PAGO' : 'CRIADO', versao: 1, moeda: 'BRL', totalCentavos: 19000,
            criadoEm: '2026-10-18T12:00:00.000Z', expiraEm: '2099-10-18T12:30:00.000Z', itens: [] },
        pagamento: estado ? { publicId: pgId, pedidoPublicId: id, estado, pedidoEstado: estado === 'CAPTURADO' ? 'PAGO' : 'AGUARDANDO_PAGAMENTO',
            moeda: 'BRL', valorCentavos: 19000, pagamentoConfirmadoEm: estado === 'CAPTURADO' ? '2026-10-18T12:05:00.000Z' : null } : null,
        ordemId: estado ? 'ORDER123' : null
    });
    beforeEach(() => {
        dados = new Map(); expira = new Date(Date.now() + 86400000).toISOString(); aprovar = true;
        inicio = jasmine.createSpy('start').and.callFake(async (_: unknown, ordem: Promise<{ orderId: string }>) => {
            const r = await ordem; if (aprovar) await callbacks.onApprove(r); else callbacks.onCancel();
        });
        carregar = jasmine.createSpy('carregar').and.resolveTo({ createInstance: async () => ({
            findEligibleMethods: async () => ({ isEligible: () => true }),
            createPayPalOneTimePaymentSession: (c: unknown) => { callbacks = c; return { start: inicio }; }
        }) });
        TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting(),
            { provide: CARRINHO_STORAGE, useValue: { getItem: (k: string) => dados.get(k) ?? null, setItem: (k: string, v: string) => dados.set(k, v), removeItem: (k: string) => dados.delete(k) } },
            { provide: CARREGAR_PAYPAL_V6, useValue: carregar }] });
        http = TestBed.inject(HttpTestingController); service = TestBed.inject(LojaCheckoutService);
    });
    afterEach(() => http.verify());
    const micro = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
    const sessao = async (status = 200, validade = expira) => {
        http.expectOne('/api/loja/sessao').flush({ sessao: { expiraEm: validade } }, { status, statusText: 'OK', headers: { 'X-CSRF-Token': 'csrf-fixture' } });
        await micro();
    };
    const preparar = async (estado?: string) => {
        const p = service.preparar(id); await sessao();
        http.expectOne('/api/loja/checkout/estado').flush(dto(estado)); await micro();
        http.expectOne('/api/loja/checkout/configuracao').flush({ ambiente: 'sandbox', clientId: 'public-id' }); await p;
    };
    const iniciar = async () => {
        const p = service.pagar(); await sessao();
        http.expectOne('/api/loja/checkout/estado').flush(dto()); await micro();
        const r = http.expectOne('/api/loja/checkout/iniciar');
        expect(r.request.body).toEqual({ pedidoPublicId: id });
        expect(r.request.headers.get('Idempotency-Key')).toMatch(/^[a-f0-9-]{36}$/);
        expect(r.request.headers.get('X-CSRF-Token')).toBe('csrf-fixture');
        expect(r.request.headers.get('X-IST-Loja')).toBe('1'); expect(r.request.withCredentials).toBeTrue();
        r.flush(dto('AGUARDANDO_APROVACAO')); await micro(); return { p };
    };
    it('nao carrega SDK nem inicia HTTP ao ser importado ou instanciado', () => { expect(carregar).not.toHaveBeenCalled(); expect(service.ocupado()).toBeFalse(); });
    it('rejeita estado Live sem carregar SDK ou apresentar confirmacao Sandbox', async () => {
        const p = service.preparar(id); await sessao();
        http.expectOne('/api/loja/checkout/estado').flush({ ...dto('CAPTURADO'), ambiente: 'live' }); await p;
        expect(service.estado()).toBeNull(); expect(service.confirmado()).toBeFalse();
        expect(carregar).not.toHaveBeenCalled(); http.expectNone('/api/loja/checkout/configuracao');
    });
    it('rejeita configuracao divergente do ambiente persistido', async () => {
        const p = service.preparar(id); await sessao();
        http.expectOne('/api/loja/checkout/estado').flush(dto()); await micro();
        http.expectOne('/api/loja/checkout/configuracao').flush({ ambiente: 'live', clientId: 'public-id' }); await p;
        expect(service.estado()).toBeNull(); expect(service.pronto()).toBeFalse(); expect(carregar).not.toHaveBeenCalled();
    });
    it('prepara sem criar ordem, guarda apenas UUIDs e validade da sessao', async () => {
        await preparar(); expect(service.pronto()).toBeTrue();
        const salvo = JSON.parse(dados.get(CHECKOUT_STORAGE_KEY)!);
        expect(Object.keys(salvo).sort()).toEqual(['captura', 'criacao', 'expiraSessao', 'pedidoPublicId']);
        expect(salvo.captura).not.toBe(salvo.criacao); expect(dados.get(CHECKOUT_STORAGE_KEY)).not.toContain('csrf');
        http.expectNone('/api/loja/checkout/iniciar');
    });
    for (const estado of ['CAPTURADO', 'PENDENTE', 'RECUSADO']) it(`aprovacao solicita captura backend e apresenta ${estado} oficial`, async () => {
        await preparar(); const { p } = await iniciar();
        const r = http.expectOne('/api/loja/checkout/capturar');
        expect(r.request.body).toEqual({ pagamentoPublicId: pgId });
        expect(service.confirmado()).toBeFalse();
        r.flush(dto(estado).pagamento); await micro(); expect(service.confirmado()).toBeFalse();
        http.expectOne('/api/loja/checkout/estado').flush(dto(estado)); await p;
        expect(service.estado()?.pagamento?.estado).toBe(estado); expect(service.estado()?.pagamento?.valorCentavos).toBe(19000);
    });
    it('duplo clique nao inicia segundo fluxo', async () => {
        await preparar(); const p = service.pagar(); await service.pagar(); expect(inicio).toHaveBeenCalledTimes(1);
        await sessao(); http.expectOne('/api/loja/checkout/estado').flush(dto('PENDENTE')); await p;
        http.expectNone('/api/loja/checkout/capturar');
    });
    it('falha de rede preserva chave e repetir criacao utiliza mesma chave', async () => {
        await preparar(); const chave = JSON.parse(dados.get(CHECKOUT_STORAGE_KEY)!).criacao;
        for (let i = 0; i < 2; i++) {
            const p = service.pagar(); await sessao(); http.expectOne('/api/loja/checkout/estado').flush(dto()); await micro();
            const r = http.expectOne('/api/loja/checkout/iniciar'); expect(r.request.headers.get('Idempotency-Key')).toBe(chave);
            r.error(new ProgressEvent('error')); await p;
        }
        expect(service.erro()).toContain('preservadas');
    });
    it('tentativa existente e reutilizada sem criar outra ordem', async () => {
        await preparar('AGUARDANDO_APROVACAO'); aprovar = false;
        const p = service.pagar(); await sessao(); http.expectOne('/api/loja/checkout/estado').flush(dto('AGUARDANDO_APROVACAO')); await p;
        http.expectNone('/api/loja/checkout/iniciar'); http.expectNone('/api/loja/checkout/capturar');
        expect(inicio).toHaveBeenCalledTimes(1); expect(service.estado()?.pagamento?.publicId).toBe(pgId);
    });
    it('sessao substituida impede criar ou capturar', async () => {
        await preparar(); const p = service.pagar(); await sessao(201); await p;
        http.expectNone('/api/loja/checkout/estado'); http.expectNone('/api/loja/checkout/capturar'); expect(service.erro()).toContain('sessao original');
    });
    it('consulta posterior reconcilia sem criar ordem ou capturar', async () => {
        await preparar('PENDENTE'); const p = service.consultar(); await sessao();
        http.expectOne('/api/loja/checkout/estado').flush(dto('PENDENTE')); await micro();
        http.expectOne('/api/loja/checkout/reconciliar').flush(dto('CAPTURADO').pagamento); await micro();
        http.expectOne('/api/loja/checkout/estado').flush(dto('CAPTURADO')); await p;
        expect(service.estado()?.pedido.estado).toBe('PAGO'); http.expectNone('/api/loja/checkout/capturar');
    });
    it('recusa de acesso a pedido alheio nao carrega SDK', async () => {
        const p = service.preparar(id); await sessao();
        http.expectOne('/api/loja/checkout/estado').flush({ erro: { codigo: 'PEDIDO_NAO_ENCONTRADO' } }, { status: 404, statusText: 'Not Found' }); await p;
        expect(carregar).not.toHaveBeenCalled(); expect(service.erro()).toContain('nesta sessao');
    });
    it('repeticao de captura com resposta perdida conserva a chave original', async () => {
        await preparar('APROVADO'); const chave = JSON.parse(dados.get(CHECKOUT_STORAGE_KEY)!).captura;
        for (let i = 0; i < 2; i++) {
            const p = service.concluirCaptura(); await sessao();
            http.expectOne('/api/loja/checkout/estado').flush(dto('APROVADO')); await micro();
            const r = http.expectOne('/api/loja/checkout/capturar'); expect(r.request.headers.get('Idempotency-Key')).toBe(chave);
            r.error(new ProgressEvent('error')); await micro();
            http.expectOne('/api/loja/checkout/estado').flush(dto('APROVADO')); await p;
        }
    });
    it('callback de ordem diferente nao envia captura', async () => {
        await preparar(); inicio.and.callFake(async (_: unknown, ordem: Promise<unknown>) => {
            await ordem; await callbacks.onApprove({ orderId: 'OTHERORDER' });
        });
        const p = service.pagar(); await sessao(); http.expectOne('/api/loja/checkout/estado').flush(dto('AGUARDANDO_APROVACAO')); await p;
        http.expectNone('/api/loja/checkout/capturar'); expect(service.erro()).toBeTruthy();
    });
    it('apos recarregar conserva identificador do pedido e chaves sem tokens', async () => {
        await preparar(); const original = dados.get(CHECKOUT_STORAGE_KEY);
        const salvo = JSON.parse(original!);
        // Construcao nova por runInInjectionContext simula a instancia apos recarga.
        const novo = TestBed.runInInjectionContext(() => new LojaCheckoutService());
        expect(novo.pedidoSalvo()).toBe(id); expect(dados.get(CHECKOUT_STORAGE_KEY)).toBe(original);
        const p = novo.preparar(id); await sessao(); http.expectOne('/api/loja/checkout/estado').flush(dto('AGUARDANDO_APROVACAO')); await micro();
        http.expectOne('/api/loja/checkout/configuracao').flush({ ambiente: 'sandbox', clientId: 'public-id' }); await p;
        expect(JSON.parse(dados.get(CHECKOUT_STORAGE_KEY)!).criacao).toBe(salvo.criacao);
    });
});
