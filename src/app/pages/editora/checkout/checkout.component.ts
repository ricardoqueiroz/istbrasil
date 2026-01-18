import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { CardModule } from 'primeng/card';
import { ButtonModule } from 'primeng/button';
import { HttpClient, HttpHeaders } from '@angular/common/http'; // Importante para o download
import { BookService } from '../../../services/book.service';
import { environment } from '../../../../environments/environment';

@Component({
  selector: 'app-checkout',
  standalone: true,
  imports: [CommonModule, CardModule, ButtonModule, RouterModule],
  templateUrl: './checkout.component.html',
  styleUrls: ['./checkout.component.scss']
})
export class CheckoutComponent implements OnInit {
  title: string = '';
  message: string = '';
  statusType: string = ''; 
  orderId: string | null = null;
  
  // [1] Variáveis expostas para o HTML
  bookImg: string = '';
  bookTitle: string = '';
  bookCategory: string = '';
  bookFile: string = '';
  sku: string = ''; // Necessário para o download

  checkoutStatus: any = {
    'SUCCESS': {
      title: "Obrigado por sua compra",
      message: "Clique no botão 'Baixar Livro' para receber o seu livro digital. Guarde o número do seu pedido em segurança pois ele será necessário caso precise baixar novamente.",
      type: 'success'
    },
    'CREATE_ERROR': {
      title: "Tivemos um problema técnico",
      message: "Pedimos desculpas, mas não foi possível iniciar seu pedido neste momento. Nosso suporte já foi avisado. Tente novamente mais tarde.",
      type: 'error'
    },
    'CAPTURE_ERROR': {
      title: "Problema na identificação do pagamento",
      message: "Pedimos desculpas, mas não foi possível identificar corretamente sua compra. Nosso suporte já foi avisado. Caso você tenha sido debitado, pedimos que envie um print do comprovante para suporte@istbrasil.com com seu nome e telefone. Após identificarmos o pagamento, enviaremos imediatamente seu livro.",
      type: 'error'
    },
    'SQL_ERROR': {
      title: "Pagamento Aprovado com Aviso",
      message: "Seu pagamento foi processado pelo PayPal, mas tivemos uma instabilidade ao salvar seu pedido em nosso sistema. Por favor, tire um print desta tela e do recibo do PayPal. Entre em contato com nosso suporte para liberarmos seu download imediatamente.",
      type: 'warning'
    },
    'DEFAULT': {
      title: "Status do Pedido",
      message: "Verifique o status da sua compra em seu e-mail.",
      type: 'info'
    }
  };

  constructor(
    private route: ActivatedRoute, 
    private router: Router,
    private bookService: BookService, // Injetar serviço
    private http: HttpClient // Injetar HTTP
  ) {}

  ngOnInit() {
    this.route.queryParams.subscribe(params => {
      const code = params['code'] || 'DEFAULT';
      this.orderId = params['orderId'] || null;
      this.bookImg = params['bookImg'] || null;
      this.bookTitle = params['bookTitle'] || null;
      this.bookCategory = params['bookCategory'] || null;
      this.sku = params['bookSku'] || null;
      this.bookFile = params['bookFile'] || null;

      // Supondo que o redirecionamento anterior envie o ID do livro ou SKU
      const bookId = params['bookId']; 

      const statusData = this.checkoutStatus[code] || this.checkoutStatus['DEFAULT'];
      
      this.title = statusData.title;
      this.message = statusData.message;
      this.statusType = statusData.type;

    });
  }


  // [2] Função de Download
  downloadBook() {
      if (!this.bookFile) {
          alert('Erro: Arquivo do produto não identificado.');
            return;
      }

      // [2.1] e [2.2] Chama o backend para buscar o arquivo e fazer download
      // O endpoint correto é: environment.apiUrl + '/istbrasil.private/products/livros/' + this.bookFile
      const url = `${environment.apiUrl}/istbrasil.private/products/livros/${this.bookFile}`;

      this.http.get(url, { responseType: 'blob' }).subscribe({
          next: (blob: Blob) => {
              // Cria um link temporário no navegador para baixar o arquivo
              const downloadUrl = window.URL.createObjectURL(blob);
              const link = document.createElement('a');
              link.href = downloadUrl;
              link.download = `${this.bookFile}`; // Ou detecte a extensão do blob
              link.click();
              window.URL.revokeObjectURL(downloadUrl);

              // [2.3] Redirecionar para home após o sucesso
              setTimeout(() => {
                  this.router.navigate(['/']);
              }, 2000); // Pequeno delay para garantir que o download iniciou
          },
          error: (err) => {
              console.error('Erro no download:', err);
              alert('Não foi possível baixar o arquivo. Entre em contato com o suporte.');
          }
      });
  }

  goHome() {
    this.router.navigate(['/']);
  }
}