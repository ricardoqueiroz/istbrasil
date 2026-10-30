import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZoneChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { environment } from '../../../environments/environment';
import { CARRINHO_STORAGE, CarrinhoService } from '../../services/carrinho.service';
import { pedidosEquivalentes, LojaCarrinhoComponent } from './loja-carrinho.component';
import { CHECKOUT_STORAGE_KEY, CheckoutEstado } from '../../services/loja-checkout.service';
import { LojaCotacao } from './models/loja.model';

describe('LojaCarrinhoComponent', () => {
    let fixture: ComponentFixture<LojaCarrinhoComponent>;
    let http: HttpTestingController;
    let carrinho: CarrinhoService;
    let dados: Map<string, string>;
    const url = `${environment.apiUrl}/loja/cotacao`;
    const dto = (ids = [1, 2], totalCentavos = 19000): LojaCotacao => ({ moeda: 'BRL', totalCentavos, geradaEm: '2026-10-15T12:00:00Z', itens: ids.map((id) => ({ produtoId: id, quantidade: 1, precoUnitarioCentavos: 9500, subtotalCentavos: 9500,
        produto: { id, sku: `SKU${id}`, titulo: `Livro ${id}`, descricao: null, categoria: { id: 2, nome: 'Música', slug: 'musica', categoriaPaiId: 1, ordem: 1 }, idioma: 'pt-br', imagemUrl: null, precoCentavos: 9500, moeda: 'BRL', disponivel: true, tipo: 'DIGITAL', livroId: 1, formatoEditorial: 'E-Book', quantidadeMaxima: 1 } })) });
    beforeEach(() => { dados = new Map(); TestBed.configureTestingModule({ imports: [LojaCarrinhoComponent], providers: [provideZoneChangeDetection(), provideRouter([]), provideHttpClient(), provideHttpClientTesting(), { provide: CARRINHO_STORAGE, useValue: { getItem: (k: string) => dados.get(k) ?? null, setItem: (k: string, v: string) => dados.set(k, v), removeItem: (k: string) => dados.delete(k) } }] }); http = TestBed.inject(HttpTestingController); carrinho = TestBed.inject(CarrinhoService); });
    afterEach(() => http.verify());
    const pagina = (ids = [1, 2]) => { ids.forEach((id) => carrinho.adicionar(id)); fixture = TestBed.createComponent(LojaCarrinhoComponent); fixture.detectChanges(); };
    const carregar = () => { pagina(); http.expectOne(url).flush(dto()); fixture.detectChanges(); };
    const texto = () => fixture.nativeElement.textContent as string;
    it('identifica email real persistido sem associar conta PayPal', () => {
        carregar();
        expect(fixture.nativeElement.querySelector('label[for="comprador-email"]').textContent).toBe('E-mail real para confirmação da compra');
        expect(texto()).toContain('independentemente do e-mail da conta PayPal');
    });

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

    const pedidoDto = (preco = 9500) => ({
        publicId: '20202020-2020-4020-8020-202020202020', estado: 'CRIADO', versao: 1, moeda: 'BRL', totalCentavos: preco * 2,
        criadoEm: '2026-10-16T12:00:00.000Z', expiraEm: '2026-10-16T12:30:00.000Z',
        itens: [1, 2].map((produtoId) => ({ produtoId, sku: `SKU${produtoId}`, titulo: `Livro confirmado ${produtoId}`, tipo: 'E-Book', quantidade: 1, precoUnitarioCentavos: preco, subtotalCentavos: preco }))
    });
    const validade = new Date(Date.now() + 86400000).toISOString();
    const prepararPedido = async (status = 201) => {
        http.expectOne('/api/loja/sessao').flush({ sessao: { expiraEm: validade } }, { status, statusText: 'OK', headers: { 'X-CSRF-Token': 'csrf-teste' } });
        await Promise.resolve();
        return http.expectOne('/api/loja/pedidos');
    };
    it('exige email valido e cotacao oficial antes de criar pedido', async () => {
        carregar(); fixture.componentInstance.email.setValue('invalido');
        await fixture.componentInstance.confirmarPedido(); fixture.detectChanges();
        http.expectNone('/api/loja/sessao');
        expect(texto()).toContain('Informe um endereço de e-mail válido');
        fixture.componentInstance.email.setValue('comprador@example.com');
        carrinho.cotar();
        await fixture.componentInstance.confirmarPedido(); http.expectNone('/api/loja/sessao');
        http.expectOne(url).flush(dto());
    });
    it('formulario cria pedido e exibe snapshots e total definitivos sem pagamento', async () => {
        carregar(); const componente = fixture.componentInstance;
        const input: HTMLInputElement = fixture.nativeElement.querySelector('#comprador-email');
        input.value = 'comprador@example.com'; input.dispatchEvent(new Event('input')); fixture.detectChanges();
        const concluir = spyOn(componente, 'confirmarPedido').and.callThrough();
        fixture.nativeElement.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        const req = await prepararPedido();
        expect(req.request.body).toEqual({ produtoIds: [1, 2], compradorEmail: 'comprador@example.com' });
        expect(carrinho.ids()).toEqual([1, 2]);
        req.flush(pedidoDto(), { status: 201, statusText: 'Created' });
        await concluir.calls.mostRecent().returnValue; fixture.detectChanges();
        expect(texto()).toContain('Pedido criado — pagamento ainda não realizado.');
        expect(texto()).toContain('Aguardando pagamento');
        expect(texto()).toContain('Livro confirmado 1');
        expect(texto()).toContain('Livro confirmado 2');
        expect(fixture.nativeElement.querySelector('[data-testid="pedido-total"]').textContent).toMatch(/190,00/);
        expect(carrinho.ids()).toEqual([1, 2]);
        expect(fixture.nativeElement.querySelector('a[download], iframe')).toBeNull();
        expect(fixture.nativeElement.querySelector('form')).toBeNull();
        expect(texto()).toContain('Preparar pagamento');
        expect(texto()).not.toMatch(/Mercado Pago|Pagar agora/);
        http.expectNone('/api/loja/checkout/iniciar');
        http.expectNone('/api/loja/checkout/capturar');
    });
    it('bloqueia duplo clique e edicoes enquanto processa', async () => {
        carregar(); const c = fixture.componentInstance; c.email.setValue('comprador@example.com');
        const operacao = c.confirmarPedido(); fixture.detectChanges();
        await c.confirmarPedido();
        expect(fixture.nativeElement.querySelector('#comprador-email').readOnly).toBeTrue();
        expect(fixture.nativeElement.querySelector('[data-remover="1"] button').disabled).toBeTrue();
        const req = await prepararPedido(); req.flush(pedidoDto()); await operacao; fixture.detectChanges();
    });
    it('falha de rede mantem carrinho e repete mesma chave sem duplicar pedido', async () => {
        carregar(); const c = fixture.componentInstance; c.email.setValue('comprador@example.com');
        const primeira = c.confirmarPedido(); const req = await prepararPedido();
        const chave = req.request.headers.get('Idempotency-Key');
        req.error(new ProgressEvent('error')); await primeira; fixture.detectChanges();
        expect(carrinho.ids()).toEqual([1, 2]);
        expect(texto()).toContain('Não foi possível confirmar o resultado');
        expect(c.bloqueado()).toBeTrue();
        const repeticao = c.confirmarPedido(); const replay = await prepararPedido(200);
        expect(replay.request.headers.get('Idempotency-Key')).toBe(chave);
        replay.flush(pedidoDto()); await repeticao; fixture.detectChanges();
        expect(texto()).toContain('Pedido criado'); expect(carrinho.ids()).toEqual([1, 2]);
    });
    for (const [status, codigo, mensagem] of [[401, 'SESSAO_INVALIDA', 'cookies'], [403, 'CSRF_INVALIDO', 'proteção'], [422, 'PRODUTO_INDISPONIVEL', 'indisponíveis']] as const) {
        it(`informa ${codigo} e preserva itens`, async () => {
            carregar(); const c = fixture.componentInstance; c.email.setValue('comprador@example.com');
            const operacao = c.confirmarPedido(); const req = await prepararPedido();
            req.flush({ erro: { codigo, mensagem: 'detalhes SQL privados' } }, { status, statusText: 'Erro' });
            await operacao; fixture.detectChanges();
            expect(carrinho.ids()).toEqual([1, 2]); expect(texto()).toContain(mensagem);
            expect(texto()).not.toContain('SQL privados'); expect(fixture.nativeElement.querySelector('[data-testid="pedido-id"]')).toBeNull();
        });
    }
    it('mostra mudanca do preco oficial sem enviar valores financeiros', async () => {
        carregar(); const c = fixture.componentInstance; c.email.setValue('comprador@example.com');
        const operacao = c.confirmarPedido(); const req = await prepararPedido();
        expect(Object.keys(req.request.body).sort()).toEqual(['compradorEmail', 'produtoIds']);
        req.flush(pedidoDto(10000)); await operacao; fixture.detectChanges();
        expect(fixture.nativeElement.querySelector('[data-testid="pedido-total"]').textContent).toMatch(/200,00/);
        expect(texto()).toContain('O preço mudou desde a cotação');
    });
    it('preserva produtos adicionados durante navegacao enquanto pedido era enviado', async () => {
        carregar(); const c = fixture.componentInstance; c.email.setValue('comprador@example.com');
        const operacao = c.confirmarPedido(); const req = await prepararPedido();
        carrinho.adicionar(3);
        req.flush(pedidoDto()); await operacao; fixture.detectChanges();
        expect(carrinho.ids()).toEqual([1, 2, 3]);
        http.expectOne(url).flush(dto([1, 2, 3], 28500));
    });
    it('B2 preserva Voltar e Avancar sem duplicar pedido nem alterar email confirmado', async () => {
        carregar();const c=fixture.componentInstance;c.email.setValue('comprador@example.com');
        const operacao=c.confirmarPedido();const req=await prepararPedido();req.flush(pedidoDto());await operacao;fixture.detectChanges();
        const id=c.pedidos.confirmado()!.publicId;
        c.etapaPagamento.set(false);fixture.detectChanges();
        expect(fixture.nativeElement.querySelector('#email-confirmado').readOnly).toBeTrue();
        expect(fixture.nativeElement.querySelector('#email-confirmado').value).toBe('comprador@example.com');
        expect(fixture.nativeElement.querySelector('app-loja-checkout')).toBeNull();
        await c.confirmarPedido();fixture.detectChanges();
        expect(c.pedidos.confirmado()!.publicId).toBe(id);expect(carrinho.ids()).toEqual([1,2]);
        http.expectNone('/api/loja/pedidos');
    });

    const anteriorId='60606060-6060-4060-8060-606060606060';
    const pagamentoId='70707070-7070-4070-8070-707070707070';
    const fim='2099-01-01T00:00:00.000Z';
    const antigo=(estado?:string):CheckoutEstado=>({ambiente:'sandbox',pedido:{publicId:anteriorId,
        estado:estado==='CAPTURADO'?'PAGO':estado?'AGUARDANDO_PAGAMENTO':'CRIADO',versao:1,moeda:'BRL',totalCentavos:19000,
        criadoEm:'2026-01-01T00:00:00.000Z',expiraEm:fim,
        itens:[1,2].map(produtoId=>({produtoId,sku:'SKU'+produtoId,titulo:'Livro '+produtoId,tipo:'DIGITAL',quantidade:1,precoUnitarioCentavos:9500,subtotalCentavos:9500}))},
        pagamento:estado?{publicId:pagamentoId,pedidoPublicId:anteriorId,estado,pedidoEstado:estado==='CAPTURADO'?'PAGO':'AGUARDANDO_PAGAMENTO',moeda:'BRL',valorCentavos:19000,pagamentoConfirmadoEm:estado==='CAPTURADO'?'2026-01-01T00:01:00.000Z':null}:null,
        ordemId:estado?'ORDER123':null});
    const gravar=()=>{dados.set(CHECKOUT_STORAGE_KEY,JSON.stringify({pedidoPublicId:anteriorId,criacao:anteriorId,captura:pagamentoId,expiraSessao:fim}));return dados.get(CHECKOUT_STORAGE_KEY);};
    const verificarAnterior=async(e=antigo())=>{
        const p=fixture.componentInstance.consultarPedidoAnterior();
        http.expectOne('/api/loja/sessao').flush({sessao:{expiraEm:fim}},{headers:{'X-CSRF-Token':'csrf-fixture'}});
        for(let i=0;i<8;i++)await Promise.resolve();
        const r=http.expectOne('/api/loja/checkout/estado');expect(r.request.body).toEqual({pedidoPublicId:anteriorId});r.flush(e);await p;fixture.detectChanges();
    };
    for(const estado of [undefined,'AGUARDANDO_APROVACAO','APROVADO'])it(`B6 retoma ${estado} sem criar pedido ou preparar pagamento`,async()=>{
        const original=gravar();carregar();await verificarAnterior(antigo(estado));
        expect(texto()).toContain('Retomar pedido anterior');fixture.componentInstance.retomarPedidoAnterior();fixture.detectChanges();
        expect(fixture.componentInstance.pedidos.confirmado()?.publicId).toBe(anteriorId);
        expect(texto()).toContain('Preparar pagamento');expect(dados.get(CHECKOUT_STORAGE_KEY)).toBe(original);
        expect(fixture.componentInstance.checkout.pronto()).toBeFalse();
        http.expectNone('/api/loja/pedidos');http.expectNone('/api/loja/checkout/iniciar');http.expectNone('/api/loja/checkout/capturar');http.expectNone('/api/loja/checkout/reconciliar');
    });
    it('B6 confirmar primeiro verifica A e nunca cria B automaticamente',async()=>{
        gravar();carregar();const c=fixture.componentInstance;c.email.setValue('comprador@example.com');
        const p=c.confirmarPedido();http.expectOne('/api/loja/sessao').flush({sessao:{expiraEm:fim}},{headers:{'X-CSRF-Token':'csrf-fixture'}});
        for(let i=0;i<8;i++)await Promise.resolve();http.expectOne('/api/loja/checkout/estado').flush(antigo());await p;
        expect(c.pedidos.confirmado()).toBeNull();http.expectNone('/api/loja/pedidos');
    });
    for(const estado of ['CRIANDO','CAPTURANDO','PENDENTE','DESCONHECIDO','REVISAO','RECUSADO','CANCELADO','EXPIRADO'])it(`B6 preserva estado ${estado}`,async()=>{
        const original=gravar();carregar();await verificarAnterior(antigo(estado));fixture.componentInstance.retomarPedidoAnterior();
        expect(fixture.componentInstance.pedidos.confirmado()).toBeNull();expect(dados.get(CHECKOUT_STORAGE_KEY)).toBe(original);
        expect(texto()).not.toContain('Retomar pedido anterior');http.expectNone('/api/loja/pedidos');
    });
    it('B6 pedido pago oferece biblioteca sem retomar ou criar outro automaticamente',async()=>{
        const original=gravar();carregar();await verificarAnterior(antigo('CAPTURADO'));
        expect(texto()).toContain('A compra anterior foi concluída');expect(texto()).not.toContain('Retomar pedido anterior');
        expect(fixture.nativeElement.querySelector('a[href="/loja/biblioteca"]')).not.toBeNull();
        expect(dados.get(CHECKOUT_STORAGE_KEY)).toBe(original);http.expectNone('/api/loja/pedidos');
    });
    it('B6 carrinho divergente preserva tentativa sem retomada',async()=>{
        const original=gravar();carregar();const e=antigo();e.pedido={...e.pedido,itens:e.pedido.itens.map((i,n)=>n?{...i,produtoId:3}:i)};
        await verificarAnterior(e);expect(texto()).toContain('Os itens ou valores diferem');
        fixture.componentInstance.retomarPedidoAnterior();expect(fixture.componentInstance.pedidos.confirmado()).toBeNull();expect(dados.get(CHECKOUT_STORAGE_KEY)).toBe(original);
    });
    it('B6 cancela resposta tardia ao trocar cotacao',async()=>{
        gravar();carregar();const p=fixture.componentInstance.consultarPedidoAnterior();
        http.expectOne('/api/loja/sessao').flush({sessao:{expiraEm:fim}},{headers:{'X-CSRF-Token':'csrf-fixture'}});
        for(let i=0;i<8;i++)await Promise.resolve();const r=http.expectOne('/api/loja/checkout/estado');
        carrinho.remover(2);fixture.detectChanges();expect(r.cancelled).toBeTrue();
        http.expectOne(url).flush(dto([1],9500));await p;fixture.detectChanges();expect(fixture.componentInstance.anterior()).toBeNull();
    });
    it('B6 ignora resposta apos destruir componente',async()=>{
        gravar();carregar();const p=fixture.componentInstance.consultarPedidoAnterior();
        http.expectOne('/api/loja/sessao').flush({sessao:{expiraEm:fim}},{headers:{'X-CSRF-Token':'csrf-fixture'}});
        for(let i=0;i<8;i++)await Promise.resolve();const r=http.expectOne('/api/loja/checkout/estado');fixture.destroy();
        expect(r.cancelled).toBeTrue();await p;
    });
    it('B6 compara todos os valores e ignora ordem e titulo',()=>{
        const p=antigo().pedido;expect(pedidosEquivalentes({...p,itens:[...p.itens].reverse().map(i=>({...i,titulo:'Outro título'}))},dto())).toBeTrue();
        for(const campo of ['produtoId','quantidade','precoUnitarioCentavos','subtotalCentavos']) {
            const itens=p.itens.map((i,n)=>n?i:{...i,[campo]:i[campo as keyof typeof i] as number+1});
            expect(pedidosEquivalentes({...p,itens},dto())).toBeFalse();
        }
        expect(pedidosEquivalentes({...p,moeda:'USD' as 'BRL'},dto())).toBeFalse();
        expect(pedidosEquivalentes({...p,totalCentavos:1},dto())).toBeFalse();
        expect(pedidosEquivalentes({...p,itens:[p.itens[0],p.itens[0]]},dto())).toBeFalse();
    });

});
