import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Router, RouterModule } from '@angular/router';

// Módulos do PrimeNG (Sakai / Aura UI)
import { CardModule } from 'primeng/card';
import { ButtonModule } from 'primeng/button';
import { TagModule } from 'primeng/tag';
import { SkeletonModule } from 'primeng/skeleton';

import { environment } from '../../../environments/environment';
import { FooterWidget } from 'src/app/shared/footer';
import { AppTopbar } from 'src/app/layout/component/app.topbar';
import { Evento, EventoStatus } from 'src/app/models/evento.model';

@Component({
  selector: 'app-eventos',
  standalone: true,
  imports: [
    CommonModule,
    RouterModule,
    CardModule,
    ButtonModule,
    TagModule,
    SkeletonModule,
    FooterWidget,
    AppTopbar
  ],
  templateUrl: './eventos.component.html',
  styleUrls: ['./eventos.component.css']
})
export class EventosComponent implements OnInit {
  eventos: Evento[] = [];
  carregando: boolean = true;

  constructor(
    private http: HttpClient,
    private router: Router
  ) {}

  ngOnInit(): void {
    this.carregarEventos();
  }
  
  carregarEventos(): void {
    this.carregando = true;
    const apiUrl = `${environment.apiUrl}/eventos`;
        
    this.http.get<Evento[]>(apiUrl).subscribe({
      next: (data) => {
        this.eventos = data;
        this.carregando = false;
      },
      error: (err) => {
        console.error('Erro ao carregar eventos:', err);
        this.carregando = false;
      }
    });
  }
  
  // Redireciona para a página individual do evento pelo Slug
  abrirEvento(slug: string): void {
    this.router.navigate(['/eventos', slug]);
  }

  // Helper para definir a cor e o rótulo da Badge (p-tag) do PrimeNG
  getSeverity(status: EventoStatus): 'success' | 'info' | 'warn' | 'danger' | 'secondary' {
    switch (status) {
      case 'Inscricoes_Abertas':
        return 'success';
      case 'Em_Andamento':
        return 'info';
      case 'Breve':
        return 'warn';
      case 'Concluido':
        return 'secondary';
      case 'Cancelado':
        return 'danger';
      default:
        return 'info';
    }
  }

  getLabel(status: EventoStatus): string {
    const mapaLabels: Record<EventoStatus, string> = {
      'Rascunho': 'Rascunho',
      'Breve': 'Em Breve',
      'Inscricoes_Abertas': 'Inscrições Abertas',
      'Em_Andamento': 'Em Andamento',
      'Concluido': 'Concluído',
      'Cancelado': 'Cancelado'
    };
    return mapaLabels[status] || status;
  }
}