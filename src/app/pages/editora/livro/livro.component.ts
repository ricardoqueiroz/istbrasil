import { Component, ElementRef, OnInit, ViewChild, Input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { CardModule } from 'primeng/card';
import { ActivatedRoute } from '@angular/router';
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
    private http: HttpClient 
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
    paypal.Buttons({
      // 1. Configura a transação
      createOrder: (data: any, actions: any) => {
        return fetch('http://localhost:3000/api/paypal/create-order', {
          method: 'post',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            livroId: this.livro.id,
            preco: this.livro.preco
          })
        }).then((res) => res.json())
          .then((order) => order.id); // Retorna o ID da ordem criada no backend
      },

      // 2. Finaliza a transação
      onApprove: (data: any, actions: any) => {
        return fetch('http://localhost:3000/api/paypal/capture-order', {
          method: 'post',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            orderID: data.orderID,
            livroId: this.livro.id
          })
        }).then((res) => res.json())
          .then((details) => {
            if (details.status === 'COMPLETED') {
                alert('Transação concluída por ' + details.payer.name.given_name);
                // Redirecionar para uma página de sucesso
            } else {
                alert('Ocorreu um erro na transação.');
            }
          });
      },

      onError: (err: any) => {
        console.error('Erro no PayPal:', err);
      }
    }).render(this.paypalRef.nativeElement);
  }
}