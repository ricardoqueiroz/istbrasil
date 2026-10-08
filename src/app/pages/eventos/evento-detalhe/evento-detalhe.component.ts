import { Component, OnInit, DestroyRef, effect, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Subscription } from 'rxjs';
import { AuthService } from 'src/app/shared/auth.service';
import { PerfilService } from '../../perfil/services/perfil.service';
import { FESTIVAL_II_SLUG, personalizarEventoCta } from './evento-cta-contextual';
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
import { EventoCtaResolvido, resolverEventoCta, validarLinkCta } from './evento-cta';
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
  cta: EventoCtaResolvido | null = null;
  private readonly auth = inject(AuthService);
  private readonly perfilService = inject(PerfilService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly eventoContexto = signal<Evento | null>(null);
  private ctaPadrao: EventoCtaResolvido | null = null;
  private requisicaoEvento?: Subscription;
  private geracaoPerfil = 0;
  private chaveContexto = '';
  carregando: boolean = true;
  erroCarregamento: boolean = false;

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private http: HttpClient
  ) {
    effect(() => {
      const evento = this.eventoContexto();
      const usuario = this.auth.usuario();
      const carregandoSessao = this.auth.carregando();
      const chave = JSON.stringify([evento?.id, evento?.slug, this.ctaPadrao?.etapa?.id,
        this.ctaPadrao?.etapa?.status, usuario?.id_usuario, usuario?.id_tipo_usuario, carregandoSessao]);
      if (chave === this.chaveContexto) return;
      this.chaveContexto = chave;
      const geracao = ++this.geracaoPerfil;
      this.cta = this.ctaPadrao;
      const padrao = this.ctaPadrao;
      if (carregandoSessao || !usuario || usuario.id_tipo_usuario !== 2 || !evento || !padrao
          || evento.slug !== FESTIVAL_II_SLUG || padrao.etapa?.status !== 'Em_Andamento') return;
      void this.perfilService.obterPerfil().then(perfil => {
        if (geracao === this.geracaoPerfil && !this.destroyRef.destroyed
            && !this.auth.carregando() && this.auth.usuario()?.id_usuario === usuario.id_usuario
            && this.auth.usuario()?.id_tipo_usuario === 2 && this.eventoContexto() === evento) {
          this.cta = personalizarEventoCta(padrao, evento, usuario, perfil);
        }
      }).catch(() => {
        // Falha do perfil mantém o CTA editorial; não compromete a página pública.
        if (geracao === this.geracaoPerfil && !this.destroyRef.destroyed) this.cta = padrao;
      });
    });
    this.destroyRef.onDestroy(() => { ++this.geracaoPerfil; this.requisicaoEvento?.unsubscribe(); });
  }

  ngOnInit(): void {
    this.route.paramMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(params => {
      const slug = params.get('slug');
      if (slug) {
        this.carregarDetalhesEvento(slug);
      } else {
        this.limparContexto();
        this.erroCarregamento = true;
        this.carregando = false;
      }
    });
  }

  carregarDetalhesEvento(slug: string): void {
    this.limparContexto();
    this.carregando = true;
    this.erroCarregamento = false;
    const apiUrl = environment.apiUrl.replace(/\/\$/, '');

    this.requisicaoEvento = this.http.get<Evento>(`${apiUrl}/eventos/${slug}`).subscribe({
      next: (data) => {
        this.evento = data;
        this.ctaPadrao = resolverEventoCta(data, new Date());
        this.cta = this.ctaPadrao;
        this.eventoContexto.set(data);
        this.carregando = false;
      },
      error: (err) => {
        console.error('Erro ao buscar detalhes do evento:', err);
        this.erroCarregamento = true;
        this.carregando = false;
      }
    });
  }

  private limparContexto(): void {
    this.requisicaoEvento?.unsubscribe();
    ++this.geracaoPerfil;
    this.chaveContexto = '';
    this.ctaPadrao = null;
    this.cta = null;
    this.evento = null;
    this.eventoContexto.set(null);
  }

  abrirDocumento(url: string): void {
    if (url) {
      window.open(url, '_blank');
    }
  }

  isInternalLink(link: string): boolean {
    return validarLinkCta(link)?.tipoLink === 'interno';
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