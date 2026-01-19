import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { environment } from '../../../environments/environment';

@Component({
  selector: 'app-transparencia',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './transparencia.component.html',
  styleUrls: ['./transparencia.component.css']
})
export class TransparenciaComponent {
  documents = [
    {
      name: 'Ata de Eleição da Diretoria',
      file: 'ist_ata_eleicao.pdf'
    },
    {
      name: 'Estatuto Social',
      file: 'ist_estatuto_social.pdf'
    },
    {
      name: 'CNPJ',
      file: 'ist_cnpj.pdf'
    },
    {
      name: 'Utilidade Pública Municipal',
      file: 'ist_utilidade_publ_municipal.pdf'
    },
    {
      name: 'Utilidade Pública Estadual',
      file: 'ist_utilidade_publ_estadual.pdf'
    }
  ];

  constructor(public http: HttpClient) {}

openDocument(doc: any) {
    let apiUrl = environment.apiUrl;
    
    // Remove o /api se existir, pois seus arquivos estáticos 
    // também estão mapeados na raiz conforme seu server.js
    if (apiUrl.endsWith('/api')) {
      apiUrl = apiUrl.slice(0, -4);
    }

    // Remove barras duplicadas caso existam para garantir uma URL limpa
    const baseUrl = apiUrl.replace(/\/$/, '');
    
    // Monta a URL direta
    const url = `${baseUrl}/istbrasil.private/documents/${doc.file}`;
    
    // Abre diretamente em nova aba. O navegador cuida do PDF.
    window.open(url, '_blank');
  }
}