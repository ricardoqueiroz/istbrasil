import { Component, OnInit, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { TimelineModule } from 'primeng/timeline';
import { CardModule } from 'primeng/card';
import { ButtonModule } from 'primeng/button';
import { AnimateOnScrollModule } from 'primeng/animateonscroll'; // Para animações suaves
import { TimelineService, TimelineEvent } from 'src/app/service/timeline.service';

@Component({
    selector: 'app-biografia',
    standalone: true,
    imports: [CommonModule, TimelineModule, CardModule, ButtonModule, AnimateOnScrollModule],
    templateUrl: './biografia.component.html',
    styleUrls: ['./biografia.component.scss']
})
export class BiografiaComponent implements OnInit {
    events: TimelineEvent[] = [];
    loading: boolean = false;
    currentPage: number = 1;
    pageSize: number = 10; // Carrega de 10 em 10 para ser leve no celular
    allLoaded: boolean = false;

    constructor(private timelineService: TimelineService, private sanitizer: DomSanitizer) {}

    ngOnInit() {
        this.loadEvents();
    }

    loadEvents() {
        if (this.loading || this.allLoaded) return;

        this.loading = true;
        
        // Simulação de delay para ver o spinner (remover em produção se a API for rápida)
        this.timelineService.getEvents(this.currentPage, this.pageSize).subscribe({
            next: (data) => {
                if (data.length === 0) {
                    this.allLoaded = true;
                } else {
                    // Adiciona os novos eventos ao final do array existente
                    this.events = [...this.events, ...data];
                    this.currentPage++;
                }
                this.loading = false;
            },
            error: (err) => {
                console.error('Erro ao carregar timeline', err);
                this.loading = false;
            }
        });
    }

    // Detecta rolagem infinita
    @HostListener('window:scroll', ['$event'])
    onScroll(event: any) {
        // Verifica se chegou perto do final da página (ajuste o valor 100 conforme necessário)
        if ((window.innerHeight + window.scrollY) >= document.body.offsetHeight - 100) {
            this.loadEvents();
        }
    }
    
    // Helper para verificar se a mídia é imagem (extensão simples)
    isImage(url: string): boolean {
        return url ? (url.match(/\.(jpeg|jpg|gif|png)$/) != null) : false;
    }

    isYoutube(url: string): boolean {
        return url ? (url.includes('youtube.com') || url.includes('youtu.be')) : false;
    }

    getSafeUrl(url: string): SafeResourceUrl | null {
        if (!url) return null;
        
        // Se já for um link de embed, confia nele
        if (url.includes('youtube.com/embed/')) {
             return this.sanitizer.bypassSecurityTrustResourceUrl(url);
        }

        let videoId = '';
        if (url.includes('youtube.com/watch?v=')) {
            videoId = url.split('v=')[1].split('&')[0];
        } else if (url.includes('youtu.be/')) {
            videoId = url.split('youtu.be/')[1].split('?')[0];
        }

        if (videoId) {
            const embedUrl = `https://www.youtube.com/embed/${videoId}`;
            return this.sanitizer.bypassSecurityTrustResourceUrl(embedUrl);
        }
        return null;
    }
}
