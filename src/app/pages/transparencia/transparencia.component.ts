import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';

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
      link: '/downloads/ist_ata_eleicao.pdf'
    },
    {
      name: 'Estatuto Social',
      link: '/downloads/ist_estatuto_social.pdf'
    },
    {
      name: 'CNPJ',
      link: '/downloads/ist_cnpj.pdf'
    },
    {
      name: 'Utilidade Pública Municipal',
      link: '/downloads/ist_utilidade_publ_municipal.pdf'
    },
    {
      name: 'Utilidade Pública Estadual',
      link: '/downloads/ist_utilidade_publ_estadual.pdf'
    }
  ];
}