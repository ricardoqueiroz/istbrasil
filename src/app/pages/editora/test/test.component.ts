// Adiciona declaração global para evitar erro TS2339
declare global {
  interface Window {
    paypal: any;
  }
}
import { Component, ElementRef, AfterViewInit, ViewChild } from '@angular/core';

@Component({
  standalone: true,
  selector: 'p-test-paypal',
  template: `
    <div class="container mx-auto max-w-xl p-6">
      <h2 class="text-2xl font-bold mb-4">Teste de Integração PayPal</h2>
      <div #paypalButtonContainer></div>
      <div id="result-message" class="mt-4 text-green-700 font-semibold"></div>
    </div>
  `,
  styles: [``]
})
export class TestComponent implements AfterViewInit {
  @ViewChild('paypalButtonContainer', { static: true }) paypalButtonContainer!: ElementRef;

  ngAfterViewInit() {
    this.loadPaypalScript().then(() => {
      window.paypal.Buttons({
        style: {
          shape: 'rect',
          layout: 'vertical',
          color: 'gold',
          label: 'paypal',
        },
        createOrder: async () => {
          const response = await fetch('/api/orders', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cart: [{ id: '123456', quantity: '1' }] })
          });
          const orderData = await response.json();
          return orderData.id;
        },
        onApprove: async (data: any) => {
          document.getElementById('result-message')!.textContent = 'Pagamento aprovado!';
        },
        onError: (err: any) => {
          document.getElementById('result-message')!.textContent = 'Erro no pagamento: ' + err;
        }
      }).render(this.paypalButtonContainer.nativeElement);
    });
  }

  loadPaypalScript(): Promise<void> {
    return new Promise((resolve, reject) => {
      if ((window as any).paypal) return resolve();
      const script = document.createElement('script');
      script.src = 'https://www.paypal.com/sdk/js?client-id=ARW8yGawDLNIBlNh-nUztnLcrW5ApnDF06DKfa1c_HOi-Ho6MQqH4CopEu8waaH0BkMdRkWHSmLQxKIw&currency=USD&components=buttons';
      script.onload = () => resolve();
      script.onerror = (err) => reject(err);
      document.body.appendChild(script);
    });
  }
}
