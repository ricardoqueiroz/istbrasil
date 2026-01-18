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
      file: 'is‌t_cnpj.pdf'
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
    // Usa o environment.apiUrl importado corretamente
    let apiUrl = environment.apiUrl;
    if (apiUrl.endsWith('/api')) {
      apiUrl = apiUrl.slice(0, -4);
    }
    const url = `${apiUrl}/istbrasil.private/documents/${doc.file}`;
    this.http.get(url, { responseType: 'blob' }).subscribe(blob => {
      const fileURL = URL.createObjectURL(blob);
      window.open(fileURL, '_blank');
      setTimeout(() => URL.revokeObjectURL(fileURL), 60000);
    });
  }
}