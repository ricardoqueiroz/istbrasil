import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { imagemSegura } from './projeto-apresentacao';
import { Component, OnInit, DestroyRef, inject } from '@angular/core';
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
import { Projeto, ProjetoStatus } from 'src/app/models/projeto.model';

@Component({
  selector: 'app-projetos',
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
  templateUrl: './projetos.component.html',
  styleUrls: ['./projetos.component.css']
})
export class ProjetosComponent implements OnInit {
  projetos: Projeto[] = [];
  carregando: boolean = true;
  erro = false;
  readonly skeletons = Array.from({ length: 6 });
  readonly imagemSegura = imagemSegura;
  private readonly destroyRef = inject(DestroyRef);
  imagemFalhou(event: Event): void { (event.target as HTMLImageElement).src = "/assets/images/eventos/default-event.jpg"; }

  constructor(
    private http: HttpClient,
    private router: Router
  ) {}

  ngOnInit(): void {
    this.carregarProjetos();
  }

  carregarProjetos(): void {
    this.carregando = true;
    this.erro = false;
    const apiUrl = `${environment.apiUrl}/projetos`;

    this.http.get<Projeto[]>(apiUrl).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (data) => {
        this.projetos = data;
        this.carregando = false;
      },
      error: (err) => {
        this.erro = true;
        this.carregando = false;
      }
    });
  }

  // Redireciona para a página individual do projeto pelo Slug
  abrirProjeto(slug: string): void {
    this.router.navigate(['/projetos', slug]);
  }

  // Helper para definir a cor e o rótulo da Badge (p-tag) do PrimeNG
  getSeverity(status: ProjetoStatus): 'success' | 'info' | 'warn' | 'danger' | 'secondary' {
    switch (status) {
      case 'Em Planejamento':
        return 'success';
      case 'Captação de Recursos':
        return 'info';
      case 'Pré-produção':
        return 'warn';
      case 'Produção':
        return 'warn';
      case 'Pós-produção':
        return 'warn';
      case 'Prestação de contas':
        return 'warn';
      case 'Concluído':
        return 'secondary';
      case 'Cancelado':
        return 'danger';
      default:
        return 'info';
    }
  }

  getLabel(status: ProjetoStatus): string {
    const mapaLabels: Record<ProjetoStatus, string> = {
      'Em Planejamento': 'Em Planejamento',
      'Captação de Recursos': 'Captação de Recursos',
      'Pré-produção': 'Pré-produção',
      'Produção': 'Produção',
      'Pós-produção': 'Pós-produção',
      'Prestação de contas': 'Prestação de contas',
      'Concluído': 'Concluído',
      'Cancelado': 'Cancelado'
    };
    return mapaLabels[status] || status;
  }
}