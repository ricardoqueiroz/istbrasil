import { By } from '@angular/platform-browser';
import { Dialog } from 'primeng/dialog';
import { HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { Router } from '@angular/router';
import { of, Subject, tap, throwError } from 'rxjs';
import { CHECKOUT_STORAGE_KEY } from '../../services/loja-checkout.service';
import { LojaBibliotecaService, DireitoBiblioteca } from '../../services/loja-biblioteca.service';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, fakeAsync, flushMicrotasks, tick, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { CARRINHO_STORAGE } from '../../services/carrinho.service';
import { CheckoutEstado, LojaCheckoutService } from '../../services/loja-checkout.service';
import { LojaCheckoutComponent } from './loja-checkout.component';

describe('LojaCheckoutComponent', () => {
    beforeEach(() => TestBed.configureTestingModule({ providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting(),
        { provide: CARRINHO_STORAGE, useValue: null }] }));
    const montar = (estado: string, confirmado = false) => {
        const service = TestBed.inject(LojaCheckoutService);
        service.estado.set({ ambiente: 'sandbox', pedido: { publicId: 'pedido-fixture', estado: confirmado ? 'PAGO' : 'CRIADO', totalCentavos: 19000, itens: [
            { produtoId: 1, titulo: '<img src=x onerror=alert(1)>', subtotalCentavos: 9500 }
        ] }, pagamento: { pedidoPublicId: 'pedido-fixture', estado, pedidoEstado: confirmado ? 'PAGO' : 'AGUARDANDO_PAGAMENTO', pagamentoConfirmadoEm: confirmado ? '2026-10-18T12:00:00.000Z' : null }
        } as unknown as CheckoutEstado);
        const f = TestBed.createComponent(LojaCheckoutComponent); f.componentRef.setInput('pedidoId', 'pedido-fixture'); f.detectChanges();
        return f;
    };
    it('somente estado financeiro confirmado com pedido pago apresenta sucesso', () => {
        const f = montar('CAPTURADO', true); expect(f.nativeElement.textContent).toContain('Pagamento confirmado.');
        expect(f.nativeElement.textContent).toMatch(/190,00/); expect(f.nativeElement.querySelector('img')).toBeNull();
        expect(f.nativeElement.textContent).toContain('<img src=x onerror=alert(1)>');
        expect(f.nativeElement.textContent).toContain('Homologação — PayPal Sandbox — sem cobrança real');
        expect(f.nativeElement.querySelector('a')).toBeNull();
        expect(f.nativeElement.textContent).toContain('Estamos preparando seu livro digital.');
    });
    it('CAPTURADO isolado nao e confirmacao publica', () => {
        const f = montar('CAPTURADO'); expect(f.nativeElement.textContent).not.toContain('Pagamento confirmado.');
    });
    it('pendencia nao oferece outra cobranca, pagamento ou download ficticio', () => {
        const f = montar('PENDENTE'); expect(f.nativeElement.textContent).toContain('Nao efetue outro pagamento');
        expect(f.nativeElement.textContent).not.toContain('Pagar com PayPal'); expect(f.nativeElement.querySelector('a[download]')).toBeNull();
    });
    it('recusa nao e apresentada como pagamento confirmado', () => {
        const f = montar('RECUSADO'); expect(f.nativeElement.textContent).toContain('Pagamento recusado');
        expect(f.nativeElement.querySelector('a')).toBeNull();
    });
    for (const estado of ['AGUARDANDO_APROVACAO', 'APROVADO', 'CAPTURANDO']) it(`${estado} nao confirma pagamento nem libera biblioteca`, () => {
        const f = montar(estado);
        expect(f.nativeElement.textContent).not.toContain('Pagamento confirmado.');
        expect(f.nativeElement.querySelector('a')).toBeNull();
    });
    it('ambiente Live nao recebe identificacao Sandbox nem sucesso', () => {
        const f = montar('CAPTURADO', true), service = TestBed.inject(LojaCheckoutService);
        service.estado.update(e => ({ ...e!, ambiente: 'live' })); f.detectChanges();
        expect(f.nativeElement.textContent).not.toContain('Homologação — PayPal Sandbox');
        expect(f.nativeElement.textContent).not.toContain('Pagamento confirmado.');
    });
    it('B5 apresenta verificacao explicita sem preparar ou pagar automaticamente', () => {
        const service=TestBed.inject(LojaCheckoutService);
        service.pedidoSalvo.set('20202020-2020-4020-8020-202020202020');
        const verificar=spyOn(service,'verificarAnterior').and.resolveTo();
        const preparar=spyOn(service,'preparar').and.resolveTo();const pagar=spyOn(service,'pagar').and.resolveTo();
        const f=TestBed.createComponent(LojaCheckoutComponent);
        f.componentRef.setInput('pedidoId','40404040-4040-4040-8040-404040404040');f.detectChanges();
        const botao=f.nativeElement.querySelector('button');expect(botao.textContent).toContain('Verificar tentativa anterior');botao.click();
        expect(verificar).toHaveBeenCalledWith('40404040-4040-4040-8040-404040404040');
        service.verificandoAnterior.set(true);service.ocupado.set(true);f.detectChanges();
        expect(f.nativeElement.textContent).toContain('Verificando o pagamento anterior');expect(botao.disabled).toBeTrue();
        service.verificandoAnterior.set(false);service.ocupado.set(false);service.pedidoSalvo.set(null);f.detectChanges();
        expect(f.nativeElement.textContent).toContain('Preparar pagamento');expect(preparar).not.toHaveBeenCalled();expect(pagar).not.toHaveBeenCalled();
    });

});


describe('B2 acompanhamento do checkout', () => {
    const id = '20202020-2020-4020-8020-202020202020';
    const outro = '30303030-3030-4030-8030-303030303030';
    let f: ComponentFixture<LojaCheckoutComponent>, service: LojaCheckoutService, api: LojaBibliotecaService;
    let observar: jasmine.Spy, listar: jasmine.Spy, navegar: jasmine.Spy;
    const estado = (pago = false): CheckoutEstado => ({ ambiente:'sandbox',ordemId:'ORDER',
        pedido:{publicId:id,estado:pago?'PAGO':'AGUARDANDO_PAGAMENTO',versao:1,moeda:'BRL',totalCentavos:9500,
            criadoEm:'2026-10-28T12:00:00.000Z',expiraEm:'2099-01-01T00:00:00.000Z',
            itens:[{produtoId:1,tipo:'DIGITAL',sku:'S',titulo:'Livro',quantidade:1,precoUnitarioCentavos:9500,subtotalCentavos:9500}]},
        pagamento:{publicId:outro,pedidoPublicId:id,estado:pago?'CAPTURADO':'PENDENTE',pedidoEstado:pago?'PAGO':'AGUARDANDO_PAGAMENTO',
            moeda:'BRL',valorCentavos:9500,pagamentoConfirmadoEm:pago?'2026-10-28T12:05:00.000Z':null}
    });
    const direito = (s = 'ATIVO'): DireitoBiblioteca => ({ publicId:'40404040-4040-4040-8040-404040404040',
        pedidoPublicId:id,produtoId:1,itemPosicao:1,titulo:'Livro',estado:s as DireitoBiblioteca['estado'],podeSolicitarArquivo:s==='ATIVO' });
    beforeEach(() => {
        TestBed.configureTestingModule({providers:[provideRouter([]),provideHttpClient(),provideHttpClientTesting(),
            {provide:CARRINHO_STORAGE,useValue:{getItem:(k:string)=>k===CHECKOUT_STORAGE_KEY?JSON.stringify({pedidoPublicId:id,criacao:id,captura:outro,expiraSessao:'2099-01-01T00:00:00.000Z'}):null}}]});
        service=TestBed.inject(LojaCheckoutService);api=TestBed.inject(LojaBibliotecaService);
        observar=spyOn(service,'observar').and.callFake(()=>of(estado()).pipe(tap(e=>service.estado.set(e))));
        listar=spyOn(api,'listar').and.returnValue(of({direitos:[direito()],proximoCursor:null}));
        navegar=spyOn(TestBed.inject(Router),'navigateByUrl').and.resolveTo(true);
        f=TestBed.createComponent(LojaCheckoutComponent);f.componentRef.setInput('pedidoId',id);f.detectChanges();
    });
    const acompanhar=()=>{service.acompanhamento.set({pedidoPublicId:id,inicio:Date.now(),sequencia:1});f.detectChanges();};
    afterEach(()=>{if(!f.componentRef.hostView.destroyed)f.destroy();});
    it('consulta a cada cinco segundos e para em dois minutos sem reiniciar por erro',fakeAsync(()=>{acompanhar();
        tick(4999);expect(observar).not.toHaveBeenCalled();tick(1);expect(observar).toHaveBeenCalledTimes(1);
        observar.and.returnValue(throwError(()=>new HttpErrorResponse({status:503})));
        tick(115000);f.detectChanges();const n=observar.calls.count();tick(15000);
        expect(observar.calls.count()).toBe(n);expect(f.componentInstance.aviso()).toContain('não cancela o pagamento');
        expect(navegar).not.toHaveBeenCalled();
    }));
    it('nao sobrepoe consultas, cancela HTTP na destruicao e nao navega',fakeAsync(()=>{acompanhar();
        const pendente=new Subject<CheckoutEstado>();observar.and.returnValue(pendente);
        tick(5000);tick(15000);expect(observar).toHaveBeenCalledTimes(1);expect(pendente.observed).toBeTrue();
        f.destroy();expect(pendente.observed).toBeFalse();tick(20000);expect(observar).toHaveBeenCalledTimes(1);
    }));
    it('timeout cancela requisicao pendente sem cancelar a operacao financeira',fakeAsync(()=>{acompanhar();
        const pendente=new Subject<CheckoutEstado>();observar.and.returnValue(pendente);
        const captura=spyOn(service,'concluirCaptura');tick(5000);tick(115000);expect(pendente.observed).toBeFalse();
        expect(captura).not.toHaveBeenCalled();
    }));
    it('mudanca de pedido ou cancelamento encerra o timer',fakeAsync(()=>{acompanhar();
        tick(5000);service.encerrarAcompanhamento(id);f.detectChanges();tick(10000);expect(observar).toHaveBeenCalledTimes(1);
        service.acompanhamento.set({pedidoPublicId:id,inicio:Date.now(),sequencia:2});f.detectChanges();
        f.componentRef.setInput('pedidoId',outro);f.detectChanges();tick(10000);expect(observar).toHaveBeenCalledTimes(1);
    }));
    for(const s of ['AGUARDANDO_CONFIRMACAO','SUSPENSO','REVOGADO'])it(`pagamento confirmado com direito ${s} nao navega`,fakeAsync(()=>{acompanhar();
        observar.and.callFake(()=>of(estado(true)).pipe(tap(e=>service.estado.set(e))));
        listar.and.returnValue(of({direitos:[direito(s)],proximoCursor:null}));tick(5000);f.detectChanges();
        expect(navegar).not.toHaveBeenCalled();expect(f.nativeElement.textContent).toContain('Estamos preparando seu livro digital.');
    }));
    it('lista vazia, outro pedido e captura sem confirmacao nao navegam',fakeAsync(()=>{acompanhar();
        observar.and.callFake(()=>of(estado(true)).pipe(tap(e=>service.estado.set(e))));
        listar.and.returnValue(of({direitos:[],proximoCursor:null}));tick(5000);expect(navegar).not.toHaveBeenCalled();
        listar.and.returnValue(of({direitos:[{...direito(),pedidoPublicId:outro}],proximoCursor:null}));tick(5000);expect(navegar).not.toHaveBeenCalled();
        observar.and.callFake(()=>{const e=estado(true);e.pagamento!.pagamentoConfirmadoEm=null;return of(e).pipe(tap(x=>service.estado.set(x)));});
        tick(5000);expect(navegar).not.toHaveBeenCalled();
    }));
    it('direitos ativos completos navegam uma vez e encerram acompanhamento',fakeAsync(()=>{acompanhar();
        observar.and.callFake(()=>of(estado(true)).pipe(tap(e=>service.estado.set(e))));tick(5000);flushMicrotasks();f.detectChanges();tick(20000);
        expect(navegar).toHaveBeenCalledOnceWith('/loja/biblioteca');expect(listar).toHaveBeenCalledOnceWith(undefined,id);
    }));
    it('nao confirma pagina parcial; conclui somente apos receber todas as paginas',fakeAsync(()=>{acompanhar();
        observar.and.callFake(()=>{const e=estado(true);(e.pedido as any).itens.push({...e.pedido.itens[0],produtoId:2});return of(e).pipe(tap(x=>service.estado.set(x)));});
        const segunda=new Subject<any>();listar.and.callFake((apos?:string)=>apos?segunda:of({direitos:[direito()],proximoCursor:'cursor'}));
        tick(5000);expect(navegar).not.toHaveBeenCalled();expect(listar).toHaveBeenCalledTimes(2);
        segunda.next({direitos:[{...direito(),publicId:outro,produtoId:2,itemPosicao:2}],proximoCursor:null});segunda.complete();flushMicrotasks();
        expect(navegar).toHaveBeenCalledTimes(1);
    }));
    for(const status of [401,403,404])it(`HTTP ${status} nao tem repeticao automatica`,fakeAsync(()=>{acompanhar();
        observar.and.returnValue(throwError(()=>new HttpErrorResponse({status})));tick(5000);f.detectChanges();tick(20000);
        expect(observar).toHaveBeenCalledTimes(1);expect(navegar).not.toHaveBeenCalled();
    }));
    it('respeita Retry-After sem reiniciar o prazo',fakeAsync(()=>{acompanhar();
        observar.and.returnValue(throwError(()=>new HttpErrorResponse({status:429,headers:new HttpHeaders({'Retry-After':'60'})})));
        tick(5000);tick(55000);expect(observar).toHaveBeenCalledTimes(1);tick(5000);expect(observar).toHaveBeenCalledTimes(2);
    }));
    it('dialogo permanece aberto, adia navegacao e reconsulta ao fechar',fakeAsync(()=>{acompanhar();
        spyOn(service,'consultar').and.resolveTo();
        observar.and.callFake(()=>of(estado(true)).pipe(tap(e=>service.estado.set(e))));
        void f.componentInstance.consultarManual();flushMicrotasks();f.detectChanges();
        expect(f.componentInstance.dialogoAberto()).toBeTrue();expect(navegar).not.toHaveBeenCalled();
        const dialog=f.debugElement.query(By.directive(Dialog)).componentInstance as Dialog;
        expect(dialog.closeOnEscape).toBeFalse();expect(dialog.dismissableMask).toBeFalse();expect(dialog.closable).toBeFalse();
        tick(10000);f.detectChanges();expect(f.componentInstance.dialogoAberto()).toBeTrue();
        f.componentInstance.fecharConsulta();flushMicrotasks();expect(navegar).toHaveBeenCalledTimes(1);
    }));
    it('erro ou cancelamento de pagina pendente nao confirma direitos de estado antigo',fakeAsync(()=>{acompanhar();
        observar.and.callFake(()=>of(estado(true)).pipe(tap(e=>service.estado.set(e))));
        const pagina=new Subject<any>();listar.and.returnValue(pagina);tick(5000);
        expect(pagina.observed).toBeTrue();service.encerrarAcompanhamento(id);f.detectChanges();
        expect(pagina.observed).toBeFalse();pagina.next({direitos:[direito()],proximoCursor:null});
        expect(navegar).not.toHaveBeenCalled();
    }));

});
