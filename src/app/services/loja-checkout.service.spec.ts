import { urlSdkPayPal } from './loja-checkout.service';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting, HttpTestingController } from '@angular/common/http/testing';
import { TestBed, fakeAsync, tick, flushMicrotasks } from '@angular/core/testing';
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
    const iniciar = async (duploClique = false, abrir = true) => {
        const preparacao = service.prepararAbertura();
        if (duploClique) await service.prepararAbertura();
        await sessao();
        http.expectOne('/api/loja/checkout/estado').flush(dto()); await micro();
        const r = http.expectOne('/api/loja/checkout/iniciar');
        expect(r.request.body).toEqual({ pedidoPublicId: id });
        expect(r.request.headers.get('Idempotency-Key')).toMatch(/^[a-f0-9-]{36}$/);
        expect(r.request.headers.get('X-CSRF-Token')).toBe('csrf-fixture');
        expect(r.request.headers.get('X-IST-Loja')).toBe('1'); expect(r.request.withCredentials).toBeTrue();
        r.flush(dto('AGUARDANDO_APROVACAO')); await micro();
        expect(inicio).not.toHaveBeenCalled();
        const intencao = http.expectOne('/api/loja/checkout/preparar-captura');
        expect(intencao.request.body).toEqual({ pagamentoPublicId: pgId });
        expect(intencao.request.headers.get('Idempotency-Key')).toBe(JSON.parse(dados.get(CHECKOUT_STORAGE_KEY)!).captura);
        expect(service.aberturaPronta()).toBeFalse();
        intencao.flush(null, { status: 204, statusText: 'No Content' }); await preparacao;
        expect(service.aberturaPronta()).toBeTrue();expect(inicio).not.toHaveBeenCalled();
        if (!abrir) return {p:Promise.resolve()};
        const p=service.pagar();expect(inicio).toHaveBeenCalledTimes(1); // mesma pilha do segundo gesto
        if (duploClique) await service.pagar();
        await micro();return {p};
    };
    it('popup exige preparacao pronta; segundo gesto abre sincronamente sem HTTP de preparacao',async()=>{
        await preparar();await service.pagar();expect(inicio).not.toHaveBeenCalled();
        await iniciar(false,false);const salvo=dados.get(CHECKOUT_STORAGE_KEY);let gestoAtivo=true;
        inicio.and.callFake(async()=>{expect(gestoAtivo).toBeTrue();callbacks.onCancel();});
        const p=service.pagar();expect(inicio).toHaveBeenCalledTimes(1);gestoAtivo=false;
        http.expectNone('/api/loja/checkout/iniciar');http.expectNone('/api/loja/checkout/preparar-captura');
        http.expectNone('/api/loja/checkout/capturar');http.expectNone('/api/loja/sessao');
        await p;expect(dados.get(CHECKOUT_STORAGE_KEY)).toBe(salvo);expect(service.aberturaPronta()).toBeFalse();
    });
    it('recarga restaura as chaves, mas exige preparar SDK e intencao antes de abrir',async()=>{
        await preparar();await iniciar(false,false);const salvo=dados.get(CHECKOUT_STORAGE_KEY);
        service=TestBed.runInInjectionContext(()=>new LojaCheckoutService());
        await service.pagar();expect(inicio).not.toHaveBeenCalled();expect(service.aberturaPronta()).toBeFalse();
        const sdk=service.preparar(id);await sessao();
        http.expectOne('/api/loja/checkout/estado').flush(dto('AGUARDANDO_APROVACAO'));await micro();
        http.expectOne('/api/loja/checkout/configuracao').flush({ambiente:'sandbox',clientId:'public-id'});await sdk;
        const prep=service.prepararAbertura();await sessao();
        http.expectOne('/api/loja/checkout/estado').flush(dto('AGUARDANDO_APROVACAO'));await micro();
        const r=http.expectOne('/api/loja/checkout/preparar-captura');
        expect(r.request.headers.get('Idempotency-Key')).toBe(JSON.parse(salvo!).captura);
        r.flush(null,{status:204,statusText:'No Content'});await prep;
        expect(service.aberturaPronta()).toBeTrue();expect(dados.get(CHECKOUT_STORAGE_KEY)).toBe(salvo);
        http.expectNone('/api/loja/checkout/iniciar');expect(inicio).not.toHaveBeenCalled();
    });
    it('nao habilita abertura se o pedido vencer durante a persistencia',async()=>{
        await preparar('AGUARDANDO_APROVACAO');const prep=service.prepararAbertura();await sessao();
        const e=dto('AGUARDANDO_APROVACAO');http.expectOne('/api/loja/checkout/estado').flush(e);await micro();
        (service.estado()!.pedido as {expiraEm:string}).expiraEm=new Date(Date.now()-1000).toISOString();
        http.expectOne('/api/loja/checkout/preparar-captura').flush(null,{status:204,statusText:'No Content'});await prep;
        expect(service.aberturaPronta()).toBeFalse();await service.pagar();expect(inicio).not.toHaveBeenCalled();
        http.expectNone('/api/loja/checkout/capturar');
    });
    it('S1 falha ao persistir intencao nao abre PayPal nem captura e preserva chaves', async () => {
        await preparar('AGUARDANDO_APROVACAO'); const original = dados.get(CHECKOUT_STORAGE_KEY);
        for (let i = 0; i < 2; i++) {
            const p = service.prepararAbertura(); await sessao();
            http.expectOne('/api/loja/checkout/estado').flush(dto('AGUARDANDO_APROVACAO')); await micro();
            const r = http.expectOne('/api/loja/checkout/preparar-captura');
            expect(r.request.headers.get('Idempotency-Key')).toBe(JSON.parse(original!).captura);
            r.error(new ProgressEvent('error')); await p;
        }
        expect(inicio).not.toHaveBeenCalled(); http.expectNone('/api/loja/checkout/capturar');
        expect(dados.get(CHECKOUT_STORAGE_KEY)).toBe(original); expect(service.ocupado()).toBeFalse();
    });
    it('nao carrega SDK nem inicia HTTP ao ser importado ou instanciado', () => { expect(carregar).not.toHaveBeenCalled(); expect(service.ocupado()).toBeFalse(); });
    it('rejeita ambiente desconhecido sem carregar SDK', async () => {
        const p = service.preparar(id); await sessao();
        http.expectOne('/api/loja/checkout/estado').flush({ ...dto('CAPTURADO'), ambiente: 'invalido' }); await p;
        expect(service.estado()).toBeNull(); expect(service.confirmado()).toBeFalse();
        expect(carregar).not.toHaveBeenCalled(); http.expectNone('/api/loja/checkout/configuracao');
    });
    it('rejeita configuracao divergente do ambiente persistido', async () => {
        const p = service.preparar(id); await sessao();
        http.expectOne('/api/loja/checkout/estado').flush(dto()); await micro();
        http.expectOne('/api/loja/checkout/configuracao').flush({ ambiente: 'live', clientId: 'public-id' }); await p;
        expect(service.estado()).toBeNull(); expect(service.pronto()).toBeFalse(); expect(carregar).not.toHaveBeenCalled();
    });
    it('prepara Live somente com contrato backend consistente e client ID publico',async()=>{
        const p=service.preparar(id);await sessao();
        http.expectOne('/api/loja/checkout/estado').flush({...dto(),ambiente:'live'});await micro();
        http.expectOne('/api/loja/checkout/configuracao').flush({ambiente:'live',clientId:'fixture-live-public'});await p;
        expect(carregar).toHaveBeenCalledOnceWith('live');expect(service.pronto()).toBeTrue();
    });
    it('rejeita configuracao com campos privados antes de carregar SDK',async()=>{
        const p=service.preparar(id);await sessao();http.expectOne('/api/loja/checkout/estado').flush(dto());await micro();
        http.expectOne('/api/loja/checkout/configuracao').flush({ambiente:'sandbox',clientId:'public-id',clientSecret:'fixture-private'});await p;
        expect(carregar).not.toHaveBeenCalled();expect(service.pronto()).toBeFalse();
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
        await preparar(); const p = service.prepararAbertura(); await service.prepararAbertura(); expect(inicio).not.toHaveBeenCalled();
        await sessao(); http.expectOne('/api/loja/checkout/estado').flush(dto('PENDENTE')); await p;
        http.expectNone('/api/loja/checkout/capturar');
    });
    it('S1 duplo clique persiste uma intencao, abre um popup e solicita uma captura', async () => {
        await preparar(); const { p } = await iniciar(true);
        http.expectOne('/api/loja/checkout/capturar').flush(dto('CAPTURADO').pagamento); await micro();
        http.expectOne('/api/loja/checkout/estado').flush(dto('CAPTURADO')); await p;
        expect(inicio).toHaveBeenCalledTimes(1); expect(service.confirmado()).toBeTrue();
    });
    it('falha de rede preserva chave e repetir criacao utiliza mesma chave', async () => {
        await preparar(); const chave = JSON.parse(dados.get(CHECKOUT_STORAGE_KEY)!).criacao;
        for (let i = 0; i < 2; i++) {
            const p = service.prepararAbertura(); await sessao(); http.expectOne('/api/loja/checkout/estado').flush(dto()); await micro();
            const r = http.expectOne('/api/loja/checkout/iniciar'); expect(r.request.headers.get('Idempotency-Key')).toBe(chave);
            r.error(new ProgressEvent('error')); await p;
        }
        expect(service.erro()).toContain('preservadas');
    });
    it('tentativa existente e reutilizada sem criar outra ordem', async () => {
        await preparar('AGUARDANDO_APROVACAO'); aprovar = false;
        const p = service.prepararAbertura(); await sessao(); http.expectOne('/api/loja/checkout/estado').flush(dto('AGUARDANDO_APROVACAO')); await micro();
        http.expectOne('/api/loja/checkout/preparar-captura').flush(null, { status: 204, statusText: 'No Content' }); await p;
        const abrir=service.pagar();expect(inicio).toHaveBeenCalledTimes(1);await abrir;
        http.expectNone('/api/loja/checkout/iniciar'); http.expectNone('/api/loja/checkout/capturar');
        expect(inicio).toHaveBeenCalledTimes(1); expect(service.estado()?.pagamento?.publicId).toBe(pgId);
    });
    it('sessao substituida impede criar ou capturar', async () => {
        await preparar(); const p = service.prepararAbertura(); await sessao(201); await p;
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
        const p = service.prepararAbertura(); await sessao(); http.expectOne('/api/loja/checkout/estado').flush(dto('AGUARDANDO_APROVACAO')); await micro();
        http.expectOne('/api/loja/checkout/preparar-captura').flush(null, { status: 204, statusText: 'No Content' }); await p;
        const abrir=service.pagar();expect(inicio).toHaveBeenCalledTimes(1);await abrir;
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
    it('B2 observa somente estado, sem sessao, reconciliacao ou captura; unsubscribe cancela HTTP', async () => {
        await preparar('PENDENTE');
        const antes = service.estado();
        const sub = service.observar(id).subscribe();
        const r = http.expectOne('/api/loja/checkout/estado');
        expect(r.request.body).toEqual({ pedidoPublicId: id });
        expect(r.request.headers.get('X-CSRF-Token')).toBe('csrf-fixture');
        http.expectNone('/api/loja/sessao'); http.expectNone('/api/loja/checkout/reconciliar');
        http.expectNone('/api/loja/checkout/capturar'); http.expectNone('/api/loja/checkout/iniciar');
        sub.unsubscribe(); expect(r.cancelled).toBeTrue(); expect(service.estado()).toBe(antes);
    });
    it('B2 impede observacoes sobrepostas e cancela resposta antiga antes da consulta manual', async () => {
        await preparar('PENDENTE');
        const sub = service.observar(id).subscribe(); const antigo = http.expectOne('/api/loja/checkout/estado');
        service.observar(id).subscribe(); http.expectNone('/api/loja/checkout/estado');
        const manual = service.consultar(id); expect(antigo.cancelled).toBeTrue();
        await sessao(); http.expectOne('/api/loja/checkout/estado').flush(dto()); await manual;
        expect(service.estado()?.pagamento).toBeNull(); sub.unsubscribe();
    });
    it('B2 direito repetido nao satisfaz dois itens do mesmo produto', async () => {
        await preparar('CAPTURADO');
        const e = service.estado()!;
        (e.pedido as unknown as { itens: any[] }).itens = [1,2].map(() => ({ produtoId:1,sku:'S',titulo:'Livro',tipo:'DIGITAL',quantidade:1,precoUnitarioCentavos:9500,subtotalCentavos:9500 }));
        const direito = { publicId:'40404040-4040-4040-8040-404040404040',pedidoPublicId:id,produtoId:1,itemPosicao:1,titulo:'Livro',estado:'ATIVO' as const,podeSolicitarArquivo:true };
        service.registrarDireitos(id,e,[direito]); expect(service.bibliotecaLiberada()).toBeFalse();
        service.registrarDireitos(id,e,[direito,{...direito,itemPosicao:2}]); expect(service.bibliotecaLiberada()).toBeFalse();
        service.registrarDireitos(id,e,[direito,{...direito,publicId:'50505050-5050-4050-8050-505050505050',itemPosicao:2}]);
        expect(service.bibliotecaLiberada()).toBeTrue();
        service.registrarDireitos(id,e,[{...direito,pedidoPublicId:pgId},{...direito,publicId:'50505050-5050-4050-8050-505050505050',itemPosicao:2}]);
        expect(service.bibliotecaLiberada()).toBeFalse();
    });

    it('S3 fechar popup preserva acompanhamento e chaves sem presumir cancelamento', async () => {
        await preparar();aprovar=false;
        const sub=service.observar(id).subscribe();const leitura=http.expectOne('/api/loja/checkout/estado');
        const {p}=await iniciar();expect(leitura.cancelled).toBeTrue();await p;
        expect(service.acompanhamento()?.pedidoPublicId).toBe(id);expect(dados.has(CHECKOUT_STORAGE_KEY)).toBeTrue();
        http.expectNone('/api/loja/checkout/capturar');sub.unsubscribe();
    });

    for (const estado of ['APROVADO','CRIANDO','CAPTURANDO','PENDENTE','DESCONHECIDO','CAPTURADO','RECUSADO','REVISAO']) {
        it(`S3 pagar nao abre popup ou nova operacao com estado ${estado}`,async()=>{
            await preparar(estado);const original=dados.get(CHECKOUT_STORAGE_KEY);
            await service.pagar();expect(inicio).not.toHaveBeenCalled();
            for(const acao of ['iniciar','preparar-captura','capturar'])http.expectNone(`/api/loja/checkout/${acao}`);
            expect(dados.get(CHECKOUT_STORAGE_KEY)).toBe(original);
        });
    }
    it('S3 callbacks duplicados compartilham uma captura e a chave original',async()=>{
        await preparar();inicio.and.callFake(async(_:unknown,ordem:Promise<{orderId:string}>)=>{
            const r=await ordem;await Promise.all([callbacks.onApprove(r),callbacks.onApprove(r)]);
        });
        const {p}=await iniciar();const r=http.expectOne('/api/loja/checkout/capturar');
        expect(r.request.headers.get('Idempotency-Key')).toBe(JSON.parse(dados.get(CHECKOUT_STORAGE_KEY)!).captura);
        r.flush(dto('CAPTURADO').pagamento);await micro();
        http.expectOne('/api/loja/checkout/estado').flush(dto('CAPTURADO'));await p;
        expect(service.confirmado()).toBeTrue();http.expectNone('/api/loja/checkout/capturar');
    });
    it('S3 callback perdido termina popup, permite acompanhar e nao captura pelo navegador',async()=>{
        await preparar();inicio.and.callFake(async(_:unknown,ordem:Promise<unknown>)=>{await ordem;});
        const {p}=await iniciar();await p;const original=dados.get(CHECKOUT_STORAGE_KEY);
        service.encerrarAcompanhamento(id);service.retomarAcompanhamento(id);
        expect(service.acompanhamento()?.pedidoPublicId).toBe(id);
        http.expectNone('/api/loja/checkout/capturar');expect(dados.get(CHECKOUT_STORAGE_KEY)).toBe(original);
    });
    it('S3 aprovacao apos encerrar primeiro prazo inicia uma unica janela de confirmacao',async()=>{
        await preparar();inicio.and.callFake(async(_:unknown,ordem:Promise<unknown>)=>{await ordem;});
        const {p}=await iniciar();await p;service.encerrarAcompanhamento(id);
        const confirmar=callbacks.onApprove({orderId:'ORDER123'});const fase=service.acompanhamento();
        const duplicado=callbacks.onApprove({orderId:'ORDER123'});expect(service.acompanhamento()).toBe(fase);
        expect(fase?.pedidoPublicId).toBe(id);
        http.expectOne('/api/loja/checkout/capturar').flush(dto('CAPTURADO').pagamento);await micro();
        http.expectOne('/api/loja/checkout/estado').flush(dto('CAPTURADO'));await Promise.all([confirmar,duplicado]);
        http.expectNone('/api/loja/checkout/iniciar');expect(service.confirmado()).toBeTrue();
    });
    it('S3 recarga e consulta de estado incerto preservam chaves sem nova captura',async()=>{
        await preparar('DESCONHECIDO');const original=dados.get(CHECKOUT_STORAGE_KEY);
        service=TestBed.runInInjectionContext(()=>new LojaCheckoutService());
        const p=service.consultar(id);await sessao();
        http.expectOne('/api/loja/checkout/estado').flush(dto('DESCONHECIDO'));await micro();
        http.expectOne('/api/loja/checkout/reconciliar').flush(dto('PENDENTE').pagamento);await micro();
        http.expectOne('/api/loja/checkout/estado').flush(dto('PENDENTE'));await p;
        service.retomarAcompanhamento(id);expect(service.acompanhamento()?.pedidoPublicId).toBe(id);
        expect(dados.get(CHECKOUT_STORAGE_KEY)).toBe(original);http.expectNone('/api/loja/checkout/capturar');
        http.expectNone('/api/loja/checkout/iniciar');
    });
    const pedidoB = '40404040-4040-4040-8040-404040404040';
    const verificar = async (resposta: CheckoutEstado, recarga = false) => {
        await preparar();
        if (recarga) service = TestBed.runInInjectionContext(() => new LojaCheckoutService());
        const original = dados.get(CHECKOUT_STORAGE_KEY);
        const p = service.verificarAnterior(pedidoB); await sessao();
        const r = http.expectOne('/api/loja/checkout/estado');
        expect(r.request.body).toEqual({pedidoPublicId:id});
        expect(r.request.headers.get('X-CSRF-Token')).toBe('csrf-fixture');
        r.flush(resposta); await p;
        http.expectNone('/api/loja/checkout/reconciliar'); http.expectNone('/api/loja/checkout/capturar');
        http.expectNone('/api/loja/checkout/iniciar');
        return original;
    };
    for (const recarga of [false,true]) it(`B5 resolve A paga sem preparar B, recarga=${recarga}`, async () => {
        const original = JSON.parse((await verificar(dto('CAPTURADO'),recarga))!);
        expect(service.pedidoSalvo()).toBeNull(); expect(dados.has(CHECKOUT_STORAGE_KEY)).toBeFalse();
        expect(service.pronto()).toBeFalse(); expect(service.estado()).toBeNull();
        const p=service.preparar(pedidoB); await sessao();
        const b=dto(); b.pedido={...b.pedido,publicId:pedidoB};
        http.expectOne('/api/loja/checkout/estado').flush(b); await micro();
        http.expectOne('/api/loja/checkout/configuracao').flush({ambiente:'sandbox',clientId:'public-id'});await p;
        const novas=JSON.parse(dados.get(CHECKOUT_STORAGE_KEY)!);
        expect(novas.pedidoPublicId).toBe(pedidoB);
        expect([original.criacao,original.captura]).not.toContain(novas.criacao);
        expect([original.criacao,original.captura,novas.criacao]).not.toContain(novas.captura);
    });
    for (const estado of [undefined,'AGUARDANDO_APROVACAO','APROVADO','CRIANDO','CAPTURANDO','PENDENTE','DESCONHECIDO','REVISAO','CANCELADO','EXPIRADO','RECUSADO']) {
        it(`B5 preserva tentativa nao comprovada: ${estado}`,async()=>{
            const original=await verificar(dto(estado));expect(dados.get(CHECKOUT_STORAGE_KEY)).toBe(original);
            expect(service.pedidoSalvo()).toBe(id);expect(service.erro()).toBeTruthy();
        });
    }
    for (const campo of ['pedido','pagamento','ambiente','valor','moeda','data','id']) it(`B5 rejeita inconsistencia ${campo}`,async()=>{
        const e=dto('CAPTURADO');
        if(campo==='pedido')e.pedido={...e.pedido,publicId:pedidoB};
        if(campo==='pagamento')e.pagamento!.pedidoPublicId=pedidoB;
        if(campo==='ambiente')e.ambiente='invalido' as 'live';
        if(campo==='valor')e.pagamento!.valorCentavos++;
        if(campo==='moeda')e.pagamento!.moeda='USD' as 'BRL';
        if(campo==='data')e.pagamento!.pagamentoConfirmadoEm='invalida';
        if(campo==='id')e.pagamento!.publicId='invalido';
        const original=await verificar(e);expect(dados.get(CHECKOUT_STORAGE_KEY)).toBe(original);
    });
    for(const status of [0,401,403,404,500])it(`B5 preserva chaves em erro HTTP ${status}`,async()=>{
        await preparar();const original=dados.get(CHECKOUT_STORAGE_KEY);
        const p=service.verificarAnterior(pedidoB);await sessao();const r=http.expectOne('/api/loja/checkout/estado');
        if(status===0)r.error(new ProgressEvent('error'));else r.flush({}, {status,statusText:'Erro'});
        await p;expect(dados.get(CHECKOUT_STORAGE_KEY)).toBe(original);expect(service.verificandoAnterior()).toBeFalse();
    });
    it('B5 sessao substituida preserva A sem consultar estado',async()=>{
        await preparar();const original=dados.get(CHECKOUT_STORAGE_KEY);const p=service.verificarAnterior(pedidoB);
        await sessao(201);await p;http.expectNone('/api/loja/checkout/estado');expect(dados.get(CHECKOUT_STORAGE_KEY)).toBe(original);
    });
    it('B5 cancela leitura antiga e serializa cliques e preparacao',async()=>{
        await preparar();service.observar(id).subscribe();const antiga=http.expectOne('/api/loja/checkout/estado');
        const p=service.verificarAnterior(pedidoB);expect(antiga.cancelled).toBeTrue();
        await service.verificarAnterior(pedidoB);await service.preparar(pedidoB);await sessao();
        http.expectOne('/api/loja/checkout/estado').flush(dto('CAPTURADO'));await p;
        expect(service.estado()).toBeNull();expect(service.direitosConsultados()).toBeNull();expect(service.acompanhamento()).toBeNull();
    });
    it('B5 nao encerra contexto nem acompanhamento do proprio pedido A',async()=>{
        await preparar();const original=dados.get(CHECKOUT_STORAGE_KEY);
        service.acompanhamento.set({pedidoPublicId:id,inicio:Date.now(),sequencia:1});
        await service.verificarAnterior(id);
        expect(dados.get(CHECKOUT_STORAGE_KEY)).toBe(original);expect(service.acompanhamento()?.pedidoPublicId).toBe(id);
        http.expectNone('/api/loja/checkout/estado');
    });

    it('B5 timeout cancela consulta e preserva contexto',fakeAsync(()=>{
        let terminou=false;
        const prepararPromise=service.preparar(id);
        http.expectOne('/api/loja/sessao').flush({sessao:{expiraEm:expira}},{headers:{'X-CSRF-Token':'csrf-fixture'}});flushMicrotasks();
        http.expectOne('/api/loja/checkout/estado').flush(dto());flushMicrotasks();
        http.expectOne('/api/loja/checkout/configuracao').flush({ambiente:'sandbox',clientId:'public-id'});flushMicrotasks();
        const original=dados.get(CHECKOUT_STORAGE_KEY);
        void service.verificarAnterior(pedidoB).then(()=>terminou=true);
        http.expectOne('/api/loja/sessao').flush({sessao:{expiraEm:expira}},{headers:{'X-CSRF-Token':'csrf-fixture'}});flushMicrotasks();
        const r=http.expectOne('/api/loja/checkout/estado');tick(15000);flushMicrotasks();
        expect(r.cancelled).toBeTrue();expect(terminou).toBeTrue();expect(dados.get(CHECKOUT_STORAGE_KEY)).toBe(original);
        expect(service.pedidoSalvo()).toBe(id);void prepararPromise;
    }));

    it('B5 ignora callbacks SDK tardios de A depois de preparar B',async()=>{
        await preparar();aprovar=false;const {p}=await iniciar();await p;const antigos=callbacks;
        const verificar=service.verificarAnterior(pedidoB);await sessao();
        http.expectOne('/api/loja/checkout/estado').flush(dto('CAPTURADO'));await verificar;
        const novo=service.preparar(pedidoB);await sessao();const b=dto();b.pedido={...b.pedido,publicId:pedidoB};
        http.expectOne('/api/loja/checkout/estado').flush(b);await micro();
        http.expectOne('/api/loja/checkout/configuracao').flush({ambiente:'sandbox',clientId:'public-id'});await novo;
        antigos.onCancel();antigos.onError();await antigos.onApprove({orderId:'ORDER123'});
        expect(service.estado()?.pedido.publicId).toBe(pedidoB);expect(service.erro()).toBeNull();
        http.expectNone('/api/loja/checkout/capturar');http.expectNone('/api/loja/checkout/estado');
    });

    const continuidadeDto=(estado?:string):CheckoutEstado=>{
        const e=dto(estado);
        e.pedido={...e.pedido,estado:e.pagamento?.pedidoEstado??'CRIADO',itens:[{produtoId:1,sku:'SKU1',titulo:'Livro',tipo:'DIGITAL',quantidade:1,precoUnitarioCentavos:19000,subtotalCentavos:19000}]};
        return e;
    };
    for(const recarga of [false,true]) it(`B6 observa e restaura contexto preservando chaves, recarga=${recarga}`,async()=>{
        await preparar();const original=dados.get(CHECKOUT_STORAGE_KEY);
        if(recarga)service=TestBed.runInInjectionContext(()=>new LojaCheckoutService());
        const p=service.consultarAnterior();await sessao();http.expectOne('/api/loja/checkout/estado').flush(continuidadeDto('AGUARDANDO_APROVACAO'));
        const e=await p;expect(e).not.toBeNull();expect(service.restaurarAnterior(e!)).toBeTrue();
        expect(service.estado()?.pedido.publicId).toBe(id);expect(service.pronto()).toBeFalse();
        expect(dados.get(CHECKOUT_STORAGE_KEY)).toBe(original);http.expectNone('/api/loja/checkout/iniciar');http.expectNone('/api/loja/checkout/capturar');http.expectNone('/api/loja/checkout/reconciliar');
    });
    it('B6 serializa consultas e cancela observacao antiga',async()=>{
        await preparar();service.observar(id).subscribe();const old=http.expectOne('/api/loja/checkout/estado');
        const p=service.consultarAnterior();expect(old.cancelled).toBeTrue();expect(await service.consultarAnterior()).toBeNull();
        service.observar(id).subscribe();await sessao();http.expectOne('/api/loja/checkout/estado').flush(continuidadeDto());await p;
    });
    it('B6 expira contexto local sem descartar chaves nem consultar sessao',async()=>{
        await preparar();const salvo=JSON.parse(dados.get(CHECKOUT_STORAGE_KEY)!);salvo.expiraSessao='2000-01-01T00:00:00.000Z';dados.set(CHECKOUT_STORAGE_KEY,JSON.stringify(salvo));
        service=TestBed.runInInjectionContext(()=>new LojaCheckoutService());const original=dados.get(CHECKOUT_STORAGE_KEY);
        expect(await service.consultarAnterior()).toBeNull();expect(dados.get(CHECKOUT_STORAGE_KEY)).toBe(original);http.expectNone('/api/loja/sessao');
    });
    for(const status of [401,403,404,500])it(`B6 erro ${status} preserva contexto`,async()=>{
        await preparar();const original=dados.get(CHECKOUT_STORAGE_KEY);const p=service.consultarAnterior();await sessao();
        http.expectOne('/api/loja/checkout/estado').flush({}, {status,statusText:'Erro'});expect(await p).toBeNull();expect(dados.get(CHECKOUT_STORAGE_KEY)).toBe(original);
    });
    for(const campo of ['pedido','pagamento','ambiente','valor','moeda'])it(`B6 rejeita resposta divergente ${campo}`,async()=>{
        await preparar();const original=dados.get(CHECKOUT_STORAGE_KEY);const p=service.consultarAnterior();await sessao();const e=continuidadeDto('APROVADO');
        if(campo==='pedido')e.pedido={...e.pedido,publicId:pedidoB};
        if(campo==='pagamento')e.pagamento!.pedidoPublicId=pedidoB;
        if(campo==='ambiente')e.ambiente='invalido' as 'live';
        if(campo==='valor')e.pagamento!.valorCentavos++;
        if(campo==='moeda')e.pagamento!.moeda='USD' as 'BRL';
        http.expectOne('/api/loja/checkout/estado').flush(e);expect(await p).toBeNull();expect(dados.get(CHECKOUT_STORAGE_KEY)).toBe(original);
    });
    it('B6 sessao substituida nao permite observacao ou retomada',async()=>{
        await preparar();const original=dados.get(CHECKOUT_STORAGE_KEY);const p=service.consultarAnterior();await sessao(201);expect(await p).toBeNull();
        http.expectNone('/api/loja/checkout/estado');expect(dados.get(CHECKOUT_STORAGE_KEY)).toBe(original);
    });
    it('B6 pedido expirado nao permite retomada mesmo sem pagamento',async()=>{
        await preparar();const p=service.consultarAnterior();await sessao();const e=continuidadeDto();e.pedido={...e.pedido,expiraEm:'2000-01-01T00:00:00.000Z'};
        http.expectOne('/api/loja/checkout/estado').flush(e);const observado=await p;expect(service.restaurarAnterior(observado!)).toBeFalse();
    });

    for(const campo of ['quantidade','subtotal','total','duplicado','ordem'])it(`B6 rejeita contrato inconsistente ${campo}`,async()=>{
        await preparar();const original=dados.get(CHECKOUT_STORAGE_KEY);const p=service.consultarAnterior();await sessao();const e=continuidadeDto();
        const i=e.pedido.itens[0];
        if(campo==='quantidade')e.pedido={...e.pedido,itens:[{...i,quantidade:2 as 1}]};
        if(campo==='subtotal')e.pedido={...e.pedido,itens:[{...i,subtotalCentavos:1}]};
        if(campo==='total')e.pedido={...e.pedido,totalCentavos:1};
        if(campo==='duplicado')e.pedido={...e.pedido,itens:[i,i]};
        if(campo==='ordem')e.ordemId='ORDER123';
        http.expectOne('/api/loja/checkout/estado').flush(e);expect(await p).toBeNull();expect(dados.get(CHECKOUT_STORAGE_KEY)).toBe(original);
    });

});

describe('SDK PayPal por ambiente',()=>{
 it('usa somente os dois destinos oficiais',()=>{
  expect(urlSdkPayPal('sandbox')).toBe('https://www.sandbox.paypal.com/web-sdk/v6/core');
  expect(urlSdkPayPal('live')).toBe('https://www.paypal.com/web-sdk/v6/core');
  expect(()=>urlSdkPayPal('outro' as any)).toThrow();
 });
});

describe('Carregador SDK real com DOM simulado, sem rede',()=>{
 let anterior: any;
 beforeEach(()=>{anterior=(window as any).paypal;delete (window as any).paypal;TestBed.configureTestingModule({});});
 afterEach(()=>{if(anterior===undefined)delete (window as any).paypal;else (window as any).paypal=anterior;});
 for(const ambiente of ['sandbox','live'] as const)it('carrega '+ambiente+' e rejeita mistura na mesma pagina',async()=>{
  const scripts:HTMLScriptElement[]=[];spyOn(document.head,'appendChild').and.callFake((n:any)=>{scripts.push(n);return n;});
  const carregar=TestBed.inject(CARREGAR_PAYPAL_V6),p=carregar(ambiente);expect(scripts.length).toBe(1);expect(scripts[0].src).toBe(urlSdkPayPal(ambiente));
  (window as any).paypal={createInstance:()=>Promise.resolve({})};scripts[0].onload!(new Event('load'));await p;
  await carregar(ambiente);expect(scripts.length).toBe(1);
  await expectAsync(carregar(ambiente==='live'?'sandbox':'live')).toBeRejected();expect(scripts.length).toBe(1);
 });
 it('nao reutiliza SDK legado ou global preexistente',async()=>{
  (window as any).paypal={Buttons:()=>({})};const append=spyOn(document.head,'appendChild');await expectAsync(TestBed.inject(CARREGAR_PAYPAL_V6)('live')).toBeRejected();expect(append).not.toHaveBeenCalled();
 });
});
