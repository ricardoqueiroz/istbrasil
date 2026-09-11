import { AfterViewInit, Component, ElementRef, HostListener, Input, OnDestroy, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { TooltipModule } from 'primeng/tooltip';
import { PageFlip } from 'page-flip';

@Component({
  selector: 'app-flipbook',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, TooltipModule],
  templateUrl: './flipbook.component.html',
  styleUrls: ['./flipbook.component.scss']
})
export class FlipbookComponent implements AfterViewInit, OnDestroy {
  @Input() pages: string[] = [];
  @Input() showCover: boolean = true;
  @Input() title: string = '';

  @ViewChild('bookContainer') bookContainer!: ElementRef<HTMLElement>;
  @ViewChild('flipbookWrapper') flipbookWrapper!: ElementRef<HTMLElement>;

  private pageFlip?: PageFlip;

  currentPage: number = 0; // 0-based
  totalPages: number = 0;
  targetPageInput: number = 1;
  isPortrait: boolean = false;
  isFullscreen: boolean = false;

  ngAfterViewInit(): void {
    if (this.pages.length > 0) {
      this.initFlipBook();
    }
  }

  private initFlipBook(): void {
    const htmlElement = this.bookContainer.nativeElement;
    this.totalPages = this.pages.length;

    this.pageFlip = new PageFlip(htmlElement, {
      width: 793,           // Largura exata de cada página (px)
      height: 595,          // Altura exata de cada página (px) - proporção 793:595
      size: 'stretch',      // Redimensiona mantendo a proporção exata da página
      minWidth: 320,
      maxWidth: 793,
      minHeight: 240,
      maxHeight: 595,
      drawShadow: true,     // Sombra realista na dobra central
      maxShadowOpacity: 0.5,
      flippingTime: 700,    // Duração da animação em ms
      usePortrait: true,    // 1 página no celular, 2 páginas no desktop se houver espaço
      startPage: 0,
      showCover: this.showCover,
      autoSize: true
    });

    const pageElements = htmlElement.querySelectorAll<HTMLElement>('.page');
    this.pageFlip.loadFromHTML(pageElements);

    // Registra manipuladores de eventos
    this.pageFlip.on('flip', (e: { data: number }) => {
      this.currentPage = e.data;
      this.targetPageInput = this.currentPage + 1;
      this.updateOrientationState();
    });

    this.pageFlip.on('changeOrientation', (e: { data: 'portrait' | 'landscape' }) => {
      this.isPortrait = e.data === 'portrait';
    });

    this.updateOrientationState();
  }

  private updateOrientationState(): void {
    if (this.pageFlip) {
      this.isPortrait = this.pageFlip.getOrientation() === 'portrait';
    }
  }

  // Métodos de navegação
  prevPage(): void {
    this.pageFlip?.flipPrev();
  }

  nextPage(): void {
    this.pageFlip?.flipNext();
  }

  firstPage(): void {
    this.pageFlip?.turnToPage(0);
  }

  lastPage(): void {
    if (this.totalPages > 0) {
      this.pageFlip?.turnToPage(this.totalPages - 1);
    }
  }

  onJumpToPage(): void {
    if (!this.targetPageInput || this.targetPageInput < 1) {
      this.targetPageInput = 1;
    } else if (this.targetPageInput > this.totalPages) {
      this.targetPageInput = this.totalPages;
    }
    this.pageFlip?.turnToPage(this.targetPageInput - 1);
  }

  toggleFullscreen(): void {
    const elem = this.flipbookWrapper.nativeElement;
    if (!document.fullscreenElement) {
      elem.requestFullscreen().then(() => {
        this.isFullscreen = true;
      }).catch(err => console.error(err));
    } else {
      document.exitFullscreen().then(() => {
        this.isFullscreen = false;
      }).catch(err => console.error(err));
    }
  }

  @HostListener('document:fullscreenchange')
  onFullscreenChange(): void {
    this.isFullscreen = !!document.fullscreenElement;
  }

  @HostListener('window:keydown', ['$event'])
  handleKeyboardEvent(event: KeyboardEvent): void {
    // Evita interferir se o usuário estiver digitando em um campo de texto
    const target = event.target as HTMLElement;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) {
      return;
    }

    if (event.key === 'ArrowLeft') {
      this.prevPage();
    } else if (event.key === 'ArrowRight') {
      this.nextPage();
    }
  }

  // Texto formatado indicando a página atual
  get pageLabel(): string {
    if (this.totalPages === 0) return '';

    if (this.showCover) {
      if (this.currentPage === 0) {
        return `Capa (Pág. 1 de ${this.totalPages})`;
      }
      if (this.currentPage === this.totalPages - 1) {
        return `Contracapa (Pág. ${this.totalPages} de ${this.totalPages})`;
      }
      if (!this.isPortrait) {
        const p1 = this.currentPage + 1;
        const p2 = Math.min(this.currentPage + 2, this.totalPages);
        return `Páginas ${p1} - ${p2} de ${this.totalPages}`;
      }
    }

    return `Página ${this.currentPage + 1} de ${this.totalPages}`;
  }

  ngOnDestroy(): void {
    this.pageFlip?.destroy();
  }
}