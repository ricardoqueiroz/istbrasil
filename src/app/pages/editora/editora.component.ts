import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DataViewModule } from 'primeng/dataview';
import { ButtonModule } from 'primeng/button';
import { TagModule } from 'primeng/tag';
import { SelectButtonModule } from 'primeng/selectbutton';
import { FormsModule } from '@angular/forms';
import { RouterModule } from '@angular/router';
import { HttpClientModule } from '@angular/common/http'; // Importante para o Service funcionar no Standalone
import { BookService, Book } from '../../services/book.service'; // Ajuste o caminho conforme necessário
import { JsonDescriptionPipe } from '../../pipes/json-description.pipe';

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
    JsonDescriptionPipe
  ],
  providers: [BookService], // Opcional se providedIn: 'root'
  templateUrl: './editora.component.html',
  styleUrls: ['./editora.component.css']
})
export class EditoraComponent implements OnInit {

  layout: 'list' | 'grid' = 'grid';

  options: any[] = [
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
        this.books = data.map(book => {
          return {
            ...book,
            inventoryStatus: book.inventory
          };
        });
        console.log('Books loaded from DB:', this.books);
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

  getSeverity(book: Book): 'success' | 'warning' | 'danger' | 'info' | 'secondary' | 'contrast' | undefined {
    // Verifica inventory ou inventoryStatus
    const status = book.inventory || book.inventoryStatus;
    switch (status) {
        case 'Em estoque':
            return 'success';
        case 'Poucas unidades':
            return 'warning';
        case 'Esgotado':
            return 'danger';
        default:
            return 'info';
    }
  }
}