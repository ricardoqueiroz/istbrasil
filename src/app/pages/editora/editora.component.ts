import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DataViewModule } from 'primeng/dataview';
import { ButtonModule } from 'primeng/button';
import { TagModule } from 'primeng/tag';
import { SelectButtonModule } from 'primeng/selectbutton';
import { FormsModule } from '@angular/forms';
import { RouterModule } from '@angular/router';
import { HttpClientModule } from '@angular/common/http'; // Importante para o Service funcionar no Standalone
import { BookService, Book, precoEditorial } from '../../services/book.service'; // Ajuste o caminho conforme necessário
import { JsonDescriptionPipe } from '../../pipes/json-description.pipe';
import { FooterWidget } from 'src/app/shared/footer';

@Component({
  selector: 'app-editora',
  standalone: true,
  imports: [
    CommonModule, 
    DataViewModule, 
    ButtonModule, 
    TagModule,
    SelectButtonModule,
    FormsModule,
    RouterModule,
    HttpClientModule,
    JsonDescriptionPipe,
    FooterWidget
  ],
  providers: [BookService], // Opcional se providedIn: 'root'
  templateUrl: './editora.component.html',
  styleUrls: ['./editora.component.css']
})
export class EditoraComponent implements OnInit {

  layout: 'list' | 'grid' = 'grid';

  options: { label: string; value: string }[] = [
    { label: 'List', value: 'list' },
    { label: 'Grid', value: 'grid' }
  ];

  // A lista começa vazia e será preenchida pela API
  books: Book[] = [];

  constructor(private bookService: BookService) { }

  ngOnInit(): void {
    this.loadBooks();
  }

  loadBooks() {
    this.bookService.getBooks().subscribe({
      next: (data) => {
        this.books = data;
      },
      error: (err) => {
        console.error('Error loading books:', err);
      }
    });
  }

  /**
   * Converte o campo description (JSON ou string) em HTML formatado para exibição.
   */
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

  readonly preco = precoEditorial;

  getSeverity(book: Book): 'success' | 'secondary' {
    return book.comercial?.podeComprar === true ? 'success' : 'secondary';
  }
  situacao(book: Book): string {
    return book.comercial?.podeComprar === true ? 'Disponível' : 'Indisponível para compra';
  }
}
