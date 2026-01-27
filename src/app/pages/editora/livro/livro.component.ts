import { Component, ElementRef, OnInit, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { CardModule } from 'primeng/card';
import { ActivatedRoute, Router } from '@angular/router';
import { BookService } from '../../../services/book.service'; 
import { HttpClient } from '@angular/common/http';
import { ButtonModule } from 'primeng/button';
import { environment } from '../../../../environments/environment'; 
import { JsonDescriptionPipe } from '../../../pipes/json-description.pipe';
import { FooterWidget } from 'src/app/shared/footer';

declare var paypal: any; 

@Component({
  standalone: true,
  selector: 'p-livro',
  imports: [
    CommonModule,
    CardModule,
    ButtonModule,
    JsonDescriptionPipe,
    FooterWidget
  ],
  templateUrl: './livro.component.html',
  styleUrls: ['./livro.component.css']
})
export class LivroComponent implements OnInit {
  @ViewChild('paypalRef', { static: true }) private paypalRef!: ElementRef;
  
  livro: any;
  livroId: string | null = null;

  constructor(
    private route: ActivatedRoute,
    private bookService: BookService,
    private http: HttpClient,
    private router: Router
  ) {}

  ngOnInit() {
    this.livroId = this.route.snapshot.paramMap.get('id');

    if (this.livroId) {
      this.bookService.getById(this.livroId).subscribe({
        next: (data) => {
          this.livro = data;
          console.log('[PayPal] Livro carregado:', this.livro);
          
          // Aguarda o carregamento do SDK do PayPal já incluído em index.html
          const waitForPaypal = () => {
            if ((window as any).paypal) {
              console.log('[PayPal] SDK carregado, renderizando botão...');
              this.renderPaypalButton();
            } else {
              // Tenta novamente a cada 50ms se o script ainda não carregou
              setTimeout(waitForPaypal, 50);
            }
          };
          waitForPaypal();
        },
        error: (err) => {
          console.error('[PayPal] Erro ao buscar livro:', err);
        }
      });
    }
  }

  renderPaypalButton() {
    if (!this.livro) return;
    console.log('[PayPal] Iniciando renderização do botão...');

    paypal.Buttons({
      // --- CRIAÇÃO DO PEDIDO ---
      createOrder: async (data: any, actions: any) => {
        console.log('[PayPal] Criando ordem...');
        
        // Tratamento seguro da descrição para não quebrar o fluxo se o Pipe falhar
        let descr = '';
        try {
            // Tenta usar o pipe existente para formatar
            descr = new JsonDescriptionPipe().transform(this.livro.description);
            // Se o resultado for objeto ou HTML complexo, o backend irá truncar, 
            // mas garantimos que seja string aqui.
            if (typeof descr !== 'string') {
                descr = String(descr); 
            }
        } catch (e) {
            console.warn('[PayPal] Erro ao formatar descrição, usando título.', e);
            descr = this.livro.title;
        }

        try {
            const response = await fetch(`${environment.apiUrl}/paypal/create-order`, {
                method: 'post',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    livroId: String(this.livro.id), // Força string para segurança
                    sku: this.livro.sku,        
                    titulo: this.livro.title,   
                    preco: this.livro.price,
                    imagem: this.livro.img,
                    filename: this.livro.file,
                    descricao: descr
                })
            });

            const order = await response.json();

            if (!response.ok) {
                console.error('[PayPal] Erro retornado pelo backend na criação:', order);
                throw new Error(order.error || 'Erro ao criar pedido no servidor');
            }

            console.log('[PayPal] Ordem criada com ID:', order.id);
            return order.id;

        } catch (err) {
            console.error('[PayPal] Falha crítica no createOrder:', err);
            // Redireciona para tela de erro
            this.router.navigate(['/editora/checkout'], { queryParams: { code: 'CREATE_ERROR' } });
            // Retorna vazio para cancelar o fluxo do botão
            return null; 
        }
      },

      // --- APROVAÇÃO E CAPTURA ---
      onApprove: async (data: any, actions: any) => {
        console.log('[PayPal] Ordem aprovada pelo usuário. ID:', data.orderID);
        
        try {
            const response = await fetch(`${environment.apiUrl}/paypal/capture-order`, {
                method: 'post',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ orderID: data.orderID })
            });

            const details = await response.json();

            if (!response.ok) {
                // Se o backend retornar erro (ex: cartão recusado na captura)
                console.error('[PayPal] Erro na captura:', details);
                throw { 
                    type: details.errorType || 'CAPTURE_ERROR', 
                    details: details 
                };
            }

            console.log('[PayPal] Pagamento capturado com sucesso:', details);

            // Preparando categoria para exibição no sucesso
            let catDisplay = 'Livro Digital';
            if (this.livro.description && typeof this.livro.description === 'object') {
                 catDisplay = (this.livro.description.Conteúdo || '') + ' - ' + (this.livro.description.Formato || '');
            } else if (this.livro.category) {
                 catDisplay = this.livro.category;
            }

            this.router.navigate(['/editora/checkout'], { 
                queryParams: { 
                    code: 'SUCCESS', 
                    // O ID da ordem vem na raiz do objeto retornado pelo controller
                    orderId: details.id, 
                    bookTitle: this.livro.title,
                    bookCategory: catDisplay,
                    bookImg: this.livro.img,
                    bookSku: this.livro.sku,
                    bookFile: this.livro.file
              } 
            });

        } catch (err: any) {
            console.error("Erro no fluxo de aprovação/captura:", err);
            
            // Usa o código de erro vindo do throw acima ou fallback
            const code = err.type || 'CAPTURE_ERROR';
            this.router.navigate(['/editora/checkout'], { queryParams: { code: code } });
        }
      },

      // --- ERROS GENÉRICOS ---
      onError: (err: any) => {
        console.error('[PayPal] Erro genérico do componente Buttons:', err);
        // this.router.navigate(['/editora/checkout'], { queryParams: { code: 'CREATE_ERROR' } });
      }

    }).render(this.paypalRef.nativeElement);
    
    console.log('[PayPal] Botão renderizado no DOM.');
  }
}