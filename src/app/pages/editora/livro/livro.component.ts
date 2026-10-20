import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { CardModule } from 'primeng/card';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { BookService, Book, precoEditorial } from '../../../services/book.service';
import { ButtonModule } from 'primeng/button';
import { JsonDescriptionPipe } from '../../../pipes/json-description.pipe';
import { FooterWidget } from 'src/app/shared/footer';

@Component({
  standalone: true,
  selector: 'p-livro',
  imports: [
    CommonModule,
    CardModule,
    ButtonModule,
    RouterLink,
    JsonDescriptionPipe,
    FooterWidget
  ],
  templateUrl: './livro.component.html',
  styleUrls: ['./livro.component.css']
})
export class LivroComponent implements OnInit {
  livroEditorial: Book | null = null;
  readonly preco = precoEditorial;
  livroId: string | null = null;

  constructor(
    private route: ActivatedRoute,
    private bookService: BookService
  ) {}

  ngOnInit() {
    this.livroId = this.route.snapshot.paramMap.get('id');

    if (this.livroId) {
      this.bookService.getById(this.livroId).subscribe({
        next: (data) => {
          this.livroEditorial = data;
        },
        error: (err) => {
          console.error('Erro ao buscar livro:', err);
        }
      });
    }
  }
}
