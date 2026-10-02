import { AsyncPipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { Component, inject } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { EMPTY, catchError, map, switchMap } from 'rxjs';
import { AuthService } from '../../shared/auth.service';
import { JuradoService } from '../../shared/jurado.service';

@Component({
    selector: 'p-jurado-avaliacoes',
    standalone: true,
    imports: [AsyncPipe],
    template: `
        <section class="mx-auto w-full max-w-5xl px-4 py-8">
            <h1 class="mb-6 text-2xl font-semibold">Avalia&ccedil;&atilde;o dos Concorrentes</h1>
            @if (evento$ | async; as evento) {
                <h2 class="mb-3 break-words text-xl font-medium">{{ evento.nome }}</h2>
                @if (authService.usuario(); as usuario) {
                    <p class="mb-4 break-words">Jurado: {{ usuario.nome }}</p>
                }
                <p role="status">A &aacute;rea de avalia&ccedil;&atilde;o est&aacute; dispon&iacute;vel.</p>
            } @else {
                <p role="status">Carregando evento...</p>
            }
        </section>
    `
})
export class JuradoAvaliacoesComponent {
    readonly authService = inject(AuthService);
    private readonly route = inject(ActivatedRoute);
    private readonly router = inject(Router);
    private readonly juradoService = inject(JuradoService);

    readonly evento$ = this.route.paramMap.pipe(
        switchMap((params) => this.juradoService.obterEvento(params.get('slug') || '')),
        map(({ evento }) => {
            if (!evento) {
                void this.router.navigate(['/']);
            }
            return evento;
        }),
        catchError((error: unknown) => {
            void this.router.navigate([error instanceof HttpErrorResponse && error.status === 401 ? '/login' : '/']);
            return EMPTY;
        })
    );
}