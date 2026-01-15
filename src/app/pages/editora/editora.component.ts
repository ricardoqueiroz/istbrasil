import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { CardModule } from 'primeng/card';
import { ButtonModule } from 'primeng/button';

interface Book {
  title: string;
  author: string;
  content: string;
  format: string;
  dimensionsIn: string;
  dimensionsCm: string;
  publisher: string;
  language: string;
  imageUrl: string;
  learnMoreUrl: string;
}

@Component({
  selector: 'app-editora',
  standalone: true,
  imports: [CommonModule, CardModule, ButtonModule],
  templateUrl: './editora.component.html',
  styleUrls: ['./editora.component.css']
})
export class EditoraComponent implements OnInit {

  books: Book[] = [
    {
      title: 'Catálogo de Partituras, Sebastião Tapajós',
      author: 'Ricardo Queiroz',
      content: '105 partituras, biografia & discografia',
      format: 'Ebook PDF-XA, A4, 426 págs.',
      dimensionsIn: '8.27 × 11.69 (A4)',
      dimensionsCm: '21.0 × 29.7 (A4)',
      publisher: 'BRMUSIC',
      language: 'Português ou Inglês',
      imageUrl: 'assets/images/livros/partituras-sebastiao-tapajos-pt.png',
      learnMoreUrl: '#'
    }
  ];

  constructor() { }

  ngOnInit(): void {
  }

}
