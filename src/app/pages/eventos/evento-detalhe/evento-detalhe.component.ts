import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';

// Componentes do PrimeNG
import { CardModule } from 'primeng/card';
import { ButtonModule } from 'primeng/button';
import { TagModule } from 'primeng/tag';
import { TimelineModule } from 'primeng/timeline';
import { SkeletonModule } from 'primeng/skeleton';
import { DividerModule } from 'primeng/divider';

import { environment } from 'src/environments/environment';
import { FooterWidget } from 'src/app/shared/footer';
import { AppTopbar } from 'src/app/layout/component/app.topbar';
import { Evento, EventoStatus, EtapaStatus } from 'src/app/models/evento.model';

@Component({
  selector: 'app-evento-detalhe',
  standalone: true,
  imports: [
    CommonModule,
    RouterModule,
    CardModule,
    ButtonModule,
    TagModule,
    TimelineModule,
    SkeletonModule,
    DividerModule,
    FooterWidget,
    AppTopbar
  ],
  templateUrl: './evento-detalhe.component.html',
  styleUrls: ['./evento-detalhe.component.css']
})
export class EventoDetalheComponent implements OnInit {
  evento: Evento | null = null;
  carregando: boolean = true;
  erroCarregamento: boolean = false;

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private http: HttpClient
  ) {}

  ngOnInit(): void {
    this.route.paramMap.subscribe(params => {
      const slug = params.get('slug');
      if (slug) {
        this.carregarDetalhesEvento(slug);
      } else {
        this.erroCarregamento = true;
        this.carregando = false;
      }
    });
  }

  carregarDetalhesEvento(slug: string): void {
    this.carregando = true;
    this.erroCarregamento = false;
    const apiUrl = environment.apiUrl.replace(/\/\$/, '');

    this.http.get<Evento>(`${apiUrl}/eventos/${slug}`).subscribe({
      next: (data) => {
        this.evento = data;
        this.carregando = false;
      },
      error: (err) => {
        console.error('Erro ao buscar detalhes do evento:', err);
        this.erroCarregamento = true;
        this.carregando = false;
      }
    });
  }

  abrirDocumento(url: string): void {
    if (url) {
      window.open(url, '_blank');
    }
  }

  isInternalLink(link: string): boolean {
    return link.startsWith('/');
  }

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

  getEtapaBadgeClass(status: EtapaStatus): string {
    switch (status) {
      case 'Concluido':
        return 'bg-slate-200 text-slate-700';
      case 'Em_Andamento':
        return 'bg-emerald-100 text-emerald-800 border border-emerald-300 font-bold';
      default:
        return 'bg-amber-50 text-amber-700 border border-amber-200';
    }
  }
}