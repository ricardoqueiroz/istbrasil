import { Component, ElementRef, OnInit, ViewChild, Input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { CardModule } from 'primeng/card';
import { ActivatedRoute, Router } from '@angular/router';
import { BookService } from '../../../services/book.service'; // Seu serviço de livros
import { HttpClient } from '@angular/common/http';
import { ButtonModule } from 'primeng/button';

declare var paypal: any; // Declaração para o TS não reclamar

@Component({
  selector: 'app-livro',
  standalone: true,
  imports: [CommonModule, CardModule, ButtonModule],
  templateUrl: './livro.component.html',
  styleUrls: ['./livro.component.css']
})
export class LivroComponent implements OnInit {
  @ViewChild('paypalRef', { static: true }) private paypalRef!: ElementRef;
  
  livro: any;
  livroId: string | null = null;

  convertDescriptionToHtml(description: any): string {
    if (!description) {
      return '<div><strong>Descrição:</strong> Não disponível.</div>';
    }
    let obj: any;
    if (typeof description === 'object') {
      obj = description;
    } else {
      try {
        obj = JSON.parse(description);
      } catch (e) {
        // Não é JSON válido, retorna como texto simples
        return `<div><strong>Descrição:</strong> ${description}</div>`;
      }
    }
    let html = '<div>';
    for (const key of Object.keys(obj)) {
      html += `<span class="font-bold">${key}:</span> <span>${obj[key]}</span><br/>`;
    }
    html += '</div>';
    return html;
  }

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
                this.renderPaypalButton();
            },
            error: (err) => {
                console.error('Erro ao buscar livro:', err);
                // Trate o erro conforme necessário
            }
        });
    }
  }

  renderPaypalButton() {
    if (!this.livro) return;

    paypal.Buttons({
      createOrder: (data: any, actions: any) => {
        return fetch('http://localhost:3000/api/paypal/create-order', {
          method: 'post',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            livroId: this.livro.id,     // ID do banco (vai virar custom_id)
            sku: this.livro.sku,        // SKU do livro
            titulo: this.livro.title,   // Título do livro
            preco: this.livro.price     // Preço (ex: "50.00")
          })
        })
        .then((res) => {
          if (!res.ok) throw new Error('CREATE_ERROR'); // Lança erro se não for 200
          return res.json();
        })
        .then((order) => order.id)
        .catch((err) => {
          console.error(err);
          // Redireciona para página de erro de criação
          this.router.navigate(['/editora/checkout'], { queryParams: { code: 'CREATE_ERROR' } });
        });
      },

      onApprove: (data: any, actions: any) => {
        return fetch('http://localhost:3000/api/paypal/capture-order', {
          method: 'post',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ orderID: data.orderID })
        })
        .then((res) => {
          // Aqui testamos se o backend retornou erro (ex: 500)
          if (!res.ok) {
              // Tenta ler o JSON de erro para ver se foi erro SQL ou erro PayPal
              return res.json().then(errData => {
                  throw { type: errData.errorType || 'CAPTURE_ERROR' }; 
              });
          }
          return res.json();
        })
        .then((details) => {
            // SUCESSO: Redireciona para página de sucesso
            this.router.navigate(['/editora/checkout'], { 
                queryParams: { 
                    code: 'SUCCESS', 
                    orderId: details.id // Passa o ID para o usuário ver
                } 
            });
        })
        .catch((err) => {
            console.error("Erro no fluxo:", err);
            // Redireciona baseada no tipo de erro lançado acima
            const code = err.type || 'CAPTURE_ERROR';
            this.router.navigate(['/editora/checkout'], { queryParams: { code: code } });
        });
      },

      onError: (err: any) => {
        console.error('Erro genérico PayPal:', err);
        this.router.navigate(['/editora/checkout'], { queryParams: { code: 'CREATE_ERROR' } });
      }
    }).render(this.paypalRef.nativeElement);
  }
}