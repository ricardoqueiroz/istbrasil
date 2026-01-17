import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { CardModule } from 'primeng/card';
import { ButtonModule } from 'primeng/button';

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
  statusType: string = ''; // 'success' | 'error' | 'warning'
  orderId: string | null = null;

  // Dicionário de Mensagens (Conforme sua especificação A)
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

  constructor(private route: ActivatedRoute, private router: Router) {}

  ngOnInit() {
    // Lê os parâmetros da URL (ex: /editora/checkout?code=SUCCESS&orderId=123)
    this.route.queryParams.subscribe(params => {
      const code = params['code'] || 'DEFAULT';
      this.orderId = params['orderId'] || null;
      
      // B) Rotina para testar o tipo de mensagem
      const statusData = this.checkoutStatus[code] || this.checkoutStatus['DEFAULT'];
      
      this.title = statusData.title;
      this.message = statusData.message;
      this.statusType = statusData.type;
    });
  }

  goHome() {
    this.router.navigate(['/']);
  }
  
  downloadBook() {
      // Lógica futura de download
      alert('Iniciando download para o pedido: ' + this.orderId);
  }
}