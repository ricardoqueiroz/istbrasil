import { AsyncPipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { Component, inject } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { EMPTY, catchError, map } from 'rxjs';
import { JuradoService } from '../../shared/jurado.service';

@Component({
    selector: 'p-jurado-eventos',
    standalone: true,
    imports: [AsyncPipe, RouterLink],
    template: `
        <section class="mx-auto w-full max-w-5xl px-4 py-8">
            <h1 class="mb-6 text-2xl font-semibold">Eventos do Jurado</h1>
            @if (eventos$ | async; as eventos) {
                <ul class="divide-y divide-surface-200 dark:divide-surface-700">
                    @for (evento of eventos; track evento.id) {
                        <li>
                            <a class="flex items-center justify-between gap-4 py-4 text-primary hover:underline" [routerLink]="['/jurado', evento.slug, 'avaliacoes']">
                                <span class="min-w-0 break-words">{{ evento.nome }}</span>
                                <i class="pi pi-arrow-right shrink-0" aria-hidden="true"></i>
                            </a>
                        </li>
                    } @empty {
                        <li class="py-4">Nenhum evento dispon&iacute;vel.</li>
                    }
                </ul>
            } @else {
                <p role="status">Carregando eventos...</p>
            }
        </section>
    `
})
export class JuradoEventosComponent {
    private readonly router = inject(Router);
    readonly eventos$ = inject(JuradoService).listarAcessos().pipe(
        map(({ eventos }) => eventos),
        catchError((error: unknown) => {
            void this.router.navigate([error instanceof HttpErrorResponse && error.status === 401 ? '/login' : '/']);
            return EMPTY;
        })
    );
}