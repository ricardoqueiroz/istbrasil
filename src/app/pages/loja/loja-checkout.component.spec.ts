import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { CARRINHO_STORAGE } from '../../services/carrinho.service';
import { CheckoutEstado, LojaCheckoutService } from '../../services/loja-checkout.service';
import { LojaCheckoutComponent } from './loja-checkout.component';

describe('LojaCheckoutComponent', () => {
    beforeEach(() => TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting(),
        { provide: CARRINHO_STORAGE, useValue: null }] }));
    const montar = (estado: string, confirmado = false) => {
        const service = TestBed.inject(LojaCheckoutService);
        service.estado.set({ pedido: { publicId: 'pedido-fixture', totalCentavos: 19000, itens: [
            { produtoId: 1, titulo: '<img src=x onerror=alert(1)>', subtotalCentavos: 9500 }
        ] }, pagamento: { estado, pedidoEstado: confirmado ? 'PAGO' : 'AGUARDANDO_PAGAMENTO', pagamentoConfirmadoEm: confirmado ? '2026-10-18T12:00:00.000Z' : null }
        } as unknown as CheckoutEstado);
        const f = TestBed.createComponent(LojaCheckoutComponent); f.componentRef.setInput('pedidoId', 'pedido-fixture'); f.detectChanges();
        return f;
    };
    it('somente estado financeiro confirmado com pedido pago apresenta sucesso', () => {
        const f = montar('CAPTURADO', true); expect(f.nativeElement.textContent).toContain('Pagamento confirmado.');
        expect(f.nativeElement.textContent).toMatch(/190,00/); expect(f.nativeElement.querySelector('img')).toBeNull();
        expect(f.nativeElement.textContent).toContain('<img src=x onerror=alert(1)>');
    });
    it('CAPTURADO isolado nao e confirmacao publica', () => {
        const f = montar('CAPTURADO'); expect(f.nativeElement.textContent).not.toContain('Pagamento confirmado.');
    });
    it('pendencia nao oferece outra cobranca, pagamento ou download ficticio', () => {
        const f = montar('PENDENTE'); expect(f.nativeElement.textContent).toContain('Nao efetue outro pagamento');
        expect(f.nativeElement.textContent).not.toContain('Pagar com PayPal'); expect(f.nativeElement.querySelector('a[download]')).toBeNull();
    });
    it('recusa nao e apresentada como pagamento confirmado', () => {
        const f = montar('RECUSADO'); expect(f.nativeElement.textContent).toContain('Pagamento nao confirmado');
        expect(f.nativeElement.querySelector('a')).toBeNull();
    });
});
