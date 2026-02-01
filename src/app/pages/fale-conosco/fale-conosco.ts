import { Component } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { MessageService } from 'primeng/api';

@Component({
  selector: 'app-fale-conosco',
  imports: [],
  providers: [MessageService],
  templateUrl: './fale-conosco.html',
  styleUrls: ['./fale-conosco.scss']
})

export class FaleConosco {
  form = {
    name: '',
    email: '',
    subject: '',
    message: '',
    honeypot: ''
  };

  subjects = [
    { label: 'Dúvida', value: 'Dúvida' },
    { label: 'Solicitação', value: 'Solicitação' },
    { label: 'Parceria', value: 'Parceria' },
    { label: 'Outro assunto', value: 'Outro' }
  ];

  loading = false;

  constructor(private http: HttpClient, private message: MessageService) {}

  send() {
    this.loading = true;
    this.http.post('/api/contact', this.form).subscribe({
      next: () => {
        this.message.add({
          severity: 'success',
          summary: 'Mensagem enviada',
          detail: 'Entraremos em contato em breve.'
        });
        this.form = { name: '', email: '', subject: '', message: '', honeypot: '' };
        this.loading = false;
      },
      error: () => {
        this.message.add({
          severity: 'error',
          summary: 'Erro',
          detail: 'Não foi possível enviar sua mensagem.'
        });
        this.loading = false;
      }
    });
  }
}
