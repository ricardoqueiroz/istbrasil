import { Component, DestroyRef, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { ActivatedRoute, RouterModule } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Subscription } from 'rxjs';
import { ButtonModule } from 'primeng/button';
import { TagModule } from 'primeng/tag';
import { SkeletonModule } from 'primeng/skeleton';
import { FooterWidget } from 'src/app/shared/footer';
import { AppTopbar } from 'src/app/layout/component/app.topbar';
import { Projeto } from 'src/app/models/projeto.model';
import { environment } from 'src/environments/environment';
import { documentoSeguro, imagemSegura, validarLinkCta } from '../projeto-apresentacao';

@Component({
  selector: 'app-projeto-detalhe', standalone: true,
  imports: [CommonModule, RouterModule, ButtonModule, TagModule, SkeletonModule, FooterWidget, AppTopbar],
  templateUrl: './projeto-detalhe.component.html',
  styleUrl: './projeto-detalhe.component.css'
})
export class ProjetoDetalheComponent implements OnInit {
  projeto: Projeto | null = null;
  carregando = true;
  erro = false;
  naoEncontrado = false;
  readonly imagemSegura = imagemSegura;
  readonly documentoSeguro = documentoSeguro;
  private readonly route = inject(ActivatedRoute);
  private readonly http = inject(HttpClient);
  private readonly destroyRef = inject(DestroyRef);
  private requisicao?: Subscription;
  private slug = '';
  get cta() { return validarLinkCta(this.projeto?.link_cta); }
  constructor() { this.destroyRef.onDestroy(() => this.requisicao?.unsubscribe()); }
  ngOnInit(): void {
    this.route.paramMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(params => {
      this.slug = params.get('slug') || '';
      this.carregar();
    });
  }
  carregar(): void {
    this.requisicao?.unsubscribe();
    this.projeto = null;
    this.carregando = true;
    this.erro = this.naoEncontrado = false;
    this.requisicao = this.http.get<Projeto>(`${environment.apiUrl}/projetos/${encodeURIComponent(this.slug)}`)
      .subscribe({ next: projeto => { this.projeto = projeto; this.carregando = false; },
        error: (error: HttpErrorResponse) => {
          this.naoEncontrado = error.status === 404;
          this.erro = !this.naoEncontrado;
          this.carregando = false;
        } });
  }
  imagemFalhou(event: Event): void {
    (event.target as HTMLImageElement).src = '/assets/images/eventos/default-event.jpg';
  }
}
