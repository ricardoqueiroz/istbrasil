import { Component } from '@angular/core';

@Component({
    selector: 'highlights-widget',
    template: `
        <div id="highlights" class="py-6 px-6 lg:px-20 mx-0 my-12 lg:mx-20">
            <div class="text-center mb-8">
                <div class="text-surface-900 dark:text-surface-0 font-normal mb-2 text-4xl">Divulgação da Obra</div>
                <span class="text-muted-color text-2xl">Sebastião Tapajós</span>
            </div>

            <div class="grid grid-cols-12 gap-4 mb-10 p-6 md:p-10 items-center bg-surface-0 dark:bg-surface-900 shadow-lg rounded-3xl border border-surface-200 dark:border-surface-700">
                <div class="col-span-12 lg:col-span-8 text-left">
                    <div class="leading-none text-surface-900 dark:text-surface-0 text-3xl font-bold mb-4" style="color: var(--color-yellow-500)">Livro Partituras Sebastião Tapajós</div>
                    <div class="text-surface-700 dark:text-surface-100 text-2xl leading-normal">
                        <div class="mb-4">
                            <strong style="color: var(--p-gray-400)">E-book em formato PDF, A4 , 424 páginas.</strong>
                        </div>
                        <div>
                            <p class="text-base"><strong>Título:</strong>&nbsp;<em>Catálogo de Partituras, Sebastião Tapajós</em><br><strong>Conteúdo:</strong>&nbsp;<em>105 partituras, biografia &amp; discografia</em><br><strong>Formato:</strong>&nbsp;<em>PDF-XA, A4, 426 págs.</em><br><strong>Dimensões (pol):</strong>&nbsp;<em>8.27 × 11.69 (A4)</em><br><strong>Dimension (cm):</strong>&nbsp;<em>21.0 × 29.7 (A4)</em><br><strong>Editor:</strong>&nbsp;<em>Agência Brasileira ISBN</em><br><strong>Idioma:</strong>&nbsp;<em>Português ou Inglês</em><br><strong>Prefixo Ed.:</strong>&nbsp;<em>52911</em><br><strong>ISBN-10:</strong>&nbsp;<em>8552911036</em><br><strong>ISBN-13:</strong>&nbsp;<em>978-8552911036</em><br></p>
                        </div>
                    </div>
                </div>
                <div class="col-span-12 lg:col-span-4 flex justify-center">
                    <img src="/assets/images/capa-01.png" class="!max-w-[195px] h-fit" alt="Brasão Estadual" />
                </div>
            </div>

            <div class="grid grid-cols-12 gap-4 mt-10 mb-10 p-6 md:p-10 items-center bg-surface-0 dark:bg-surface-900 shadow-lg rounded-3xl border border-surface-200 dark:border-surface-700">
                <div class="col-span-12 lg:col-span-8 text-left">
                    <div class="leading-none text-surface-900 dark:text-surface-0 text-3xl font-bold mb-4" style="color: var(--color-yellow-500)">Camerata Amazônica Tapajós</div>
                    <div class="text-surface-700 dark:text-surface-100 text-2xl leading-normal">
                        <div class="mb-4">
                            <strong>A Música de Sebastião Tapajós</strong>
                        </div>
                        <div class="mb-4">
                            <strong style="color: var(--p-gray-400)">Regional, Jazz amazônico e clássicos de Sebastião Tapajós</strong>
                        </div>
                        <div>
                            Grupo oficial de divulgação da obra do violonista, reconhecido pelas três instâncias do Estado Brasileiro. A <strong>Camerata Amazônica Tapajós</strong> tem a missão de preservar e promover o legado musical de Sebastião Tapajós, levando sua arte para palcos nacionais e internacionais, fortalecendo a cultura brasileira.
                        </div>
                    </div>
                </div>
                <div class="col-span-12 lg:col-span-4 flex justify-center">
                    <img src="/assets/images/cat.png" class="!max-w-[195px] h-fit" alt="Brasão Federal" />
                </div>
            </div>

            <div class="grid grid-cols-12 gap-4 mb-10 p-6 md:p-10 items-center bg-surface-0 dark:bg-surface-900 shadow-lg rounded-3xl border border-surface-200 dark:border-surface-700">
                <div class="col-span-12 lg:col-span-8 text-left">
                    <div class="leading-none text-surface-900 dark:text-surface-0 text-3xl font-bold mb-4" style="color: var(--color-yellow-500)">2º Festival de Violões Sebastião Tapajós</div>
                    <div class="text-surface-700 dark:text-surface-100 text-2xl leading-normal">
                        <div class="mb-4">
                            <strong style="color: var(--p-gray-400)">Santarém - Pará - Brasil - 2026</strong>
                        </div>
                        <div class="mb-4">
                            <strong>Em Breve</strong>
                        </div>
                        <div>
                            A ser realizado no segundo semestre de 2026, o <em><strong>2º Festival de Violão Amazônico Sebastião Tapajós</strong></em> visa celebrar e perpetuar o legado do renomado violonista. O evento reunirá músicos, estudantes e entusiastas do violão para uma série de apresentações, workshops e competições, promovendo a cultura amazônica e a música brasileira em um cenário internacional.
                        </div>
                    </div>
                </div>
                <div class="col-span-12 lg:col-span-4 flex justify-center">
                    <img src="/assets/images/2-festival.png" class="!max-w-[195px] h-fit" alt="Festival de Violões" />
                </div>
            </div>
        </div>
    `
})
export class HighlightsWidget {}
