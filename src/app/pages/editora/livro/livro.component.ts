import { Component, ElementRef, OnInit, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { CardModule } from 'primeng/card';
import { ActivatedRoute, Router } from '@angular/router';
import { BookService } from '../../../services/book.service'; 
import { HttpClient } from '@angular/common/http';
import { ButtonModule } from 'primeng/button';
import { environment } from '../../../../environments/environment'; 
import { JsonDescriptionPipe } from '../../../pipes/json-description.pipe';
import express from "express";
// import "dotenv/config";
import {
    ApiError,
    CheckoutPaymentIntent,
    Client,
    Environment,
    LogLevel,
    OrdersController,
    PaymentsController,
    PaypalExperienceLandingPage,
    PaypalExperienceUserAction
} from "@paypal/paypal-server-sdk";

declare var paypal: any; 

@Component({
  standalone: true,
  selector: 'p-livro',
  imports: [
    CommonModule,
    CardModule,
    ButtonModule,
    JsonDescriptionPipe
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
          this.waitForPaypalScript().then(() => {
            console.log('[PayPal] SDK carregado, renderizando botão...');
            this.renderPaypalButton();
          });
        },
        error: (err) => {
          console.error('[PayPal] Erro ao buscar livro:', err);
        }
      });
    }
  }

    /** Aguarda o carregamento do script do PayPal antes de renderizar o botão */
    waitForPaypalScript(): Promise<void> {
      return new Promise((resolve) => {
        if (typeof window !== 'undefined' && (window as any).paypal) {
          resolve();
        } else {
          const interval = setInterval(() => {
            if (typeof window !== 'undefined' && (window as any).paypal) {
              clearInterval(interval);
              resolve();
            }
          }, 50);
        }
      });
    }

  renderPaypalButton() {
    if (!this.livro) return;
    console.log('[PayPal] Iniciando renderização do botão...');

    paypal.Buttons({
      createOrder: (data: any, actions: any) => {
        console.log('[PayPal] Criando ordem...');
        // [2] Correção: Uso de environment.apiUrl
        const descr = new JsonDescriptionPipe().transform(this.livro.description); 
        return fetch(`${environment.apiUrl}/paypal/create-order`, {
          method: 'post',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            livroId: this.livro.id,     
            sku: this.livro.sku,        
            titulo: this.livro.title,   
            preco: this.livro.price,
            imagem: this.livro.img,
            filename: this.livro.file,
            descricao: descr
          })
        })
        .then((res) => {
            console.log('[PayPal] Resposta da criação de ordem:', res);
            if (!res.ok) throw new Error('CREATE_ERROR');
            return res.json();
        })
        .then((order) => {
            console.log('[PayPal] Ordem criada:', order);
            return order.id;
        })
        .catch((err) => {
            console.error('[PayPal] Erro ao criar ordem:', err);
            this.router.navigate(['/editora/checkout'], { queryParams: { code: 'CREATE_ERROR' } });
        });
      },

      onApprove: (data: any, actions: any) => {
          console.log('[PayPal] Ordem aprovada, capturando pagamento...', data);
        // [3] Correção: Uso de environment.apiUrl
        return fetch(`${environment.apiUrl}/paypal/capture-order`, {
          method: 'post',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ orderID: data.orderID })
        })
        .then((res) => {
           console.log('[PayPal] Resposta da captura:', res);
          if (!res.ok) {
              return res.json().then(errJson => {
                  // Lança um objeto de erro com o tipo retornado pelo backend
                  // Se o backend não mandar nada, assume CAPTURE_ERROR
                  throw { 
                      type: errJson.errorType || 'CAPTURE_ERROR',
                      details: errJson 
                  }; 
              });
          }
          return res.json();
        })
        .then((details) => {
            console.log('[PayPal] Pagamento capturado com sucesso:', details);
            this.router.navigate(['/editora/checkout'], { 
                queryParams: { 
                    code: 'SUCCESS', 
                    orderId: details.id,
                    bookTitle: this.livro.title,
                    bookCategory: this.livro.description.Conteúdo + ' - ' + this.livro.description.Formato,
                    bookImg: this.livro.img,
                    bookSku: this.livro.sku,
                    bookFile: this.livro.file
              } 
            });
        })
        .catch((err) => {
            console.error("Erro no fluxo de aprovação:", err);
            
            // Pega o tipo do erro lançado acima ou usa 'CAPTURE_ERROR' como fallback
            const code = err.type || 'CAPTURE_ERROR';
            
            this.router.navigate(['/editora/checkout'], { queryParams: { code: code } });
        });
      },

      onError: (err: any) => {
          console.error('[PayPal] Erro genérico PayPal:', err);
        console.error('Erro genérico PayPal:', err);
        this.router.navigate(['/editora/checkout'], { queryParams: { code: 'CREATE_ERROR' } });
      }
    }).render(this.paypalRef.nativeElement);
    console.log('[PayPal] Botão renderizado.');
  }
}