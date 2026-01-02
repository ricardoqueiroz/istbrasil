import { Component } from '@angular/core';

@Component({
    selector: 'highlights-widget',
    template: `
        <div id="highlights" class="py-6 px-6 lg:px-20 mx-0 my-12 lg:mx-20">
            <div class="text-center">
                <div class="text-surface-900 dark:text-surface-0 font-normal mb-2 text-4xl">Reconhecimento da Obra</div>
                <span class="text-muted-color text-2xl">Patrimônio Cultural</span>
            </div>

            <div class="grid grid-cols-12 gap-4 mt-10 mb-10 p-6 md:p-10 items-center bg-surface-0 dark:bg-surface-900 shadow-lg rounded-3xl border border-surface-200 dark:border-surface-700">
                <div class="col-span-12 lg:col-span-8 text-left">
                    <div class="leading-none text-surface-900 dark:text-surface-0 text-3xl font-normal mb-4">Manifestação da Cultura Nacional</div>
                    <div class="text-surface-700 dark:text-surface-100 text-2xl leading-normal">
                        <div class="mb-4">
                            <strong>Legislação:</strong> Lei Federal nº 15.319, de 29 de dezembro de 2025.
                        </div>
                        <div class="mb-4">
                            <strong>Autoria:</strong> Deputado Federal Airton Luiz Faleiro
                        </div>
                        <div>
                            <strong>Sobre o reconhecimento:</strong> Esta lei eleva a obra de Sebastião Tapajós ao mais alto patamar da cultura brasileira, assegurando sua proteção e difusão em todo o território nacional. É o reconhecimento definitivo de que seus acordes são fundamentais para a identidade musical do Brasil.
                        </div>
                    </div>
                </div>
                <div class="col-span-12 lg:col-span-4 flex justify-center">
                    <img src="/assets/images/brasao-federal.png" class="!max-w-[195px] h-fit" alt="Brasão Federal" />
                </div>
            </div>

            <div class="grid grid-cols-12 gap-4 mb-10 p-6 md:p-10 items-center bg-surface-0 dark:bg-surface-900 shadow-lg rounded-3xl border border-surface-200 dark:border-surface-700">
                <div class="col-span-12 lg:col-span-8 text-left">
                    <div class="leading-none text-surface-900 dark:text-surface-0 text-3xl font-normal mb-4">Patrimônio Cultural Imaterial do Estado do Pará</div>
                    <div class="text-surface-700 dark:text-surface-100 text-2xl leading-normal">
                        <div class="mb-4">
                            <strong>Legislação:</strong> Lei Estadual nº 9.652, de 1º de julho de 2022.
                        </div>
                        <div class="mb-4">
                            <strong>Autoria:</strong> Deputada Estadual Dilvanda Faro.
                        </div>
                        <div>
                            <strong>Sobre o reconhecimento:</strong> Consagra o legado artístico de Tapajós como um bem de natureza imaterial essencial para a memória do povo paraense. A lei garante a preservação de sua técnica violonística única como um tesouro do Estado do Pará.
                        </div>
                    </div>
                </div>
                <div class="col-span-12 lg:col-span-4 flex justify-center">
                    <img src="/assets/images/brasao-estadual.png" class="!max-w-[195px] h-fit" alt="Brasão Estadual" />
                </div>
            </div>

            <div class="grid grid-cols-12 gap-4 mb-10 p-6 md:p-10 items-center bg-surface-0 dark:bg-surface-900 shadow-lg rounded-3xl border border-surface-200 dark:border-surface-700">
                <div class="col-span-12 lg:col-span-8 text-left">
                    <div class="leading-none text-surface-900 dark:text-surface-0 text-3xl font-normal mb-4">Patrimônio Cultural Imaterial do Município de Santarém</div>
                    <div class="text-surface-700 dark:text-surface-100 text-2xl leading-normal">
                        <div class="mb-4">
                            <strong>Legislação:</strong> Lei Municipal nº 21.444, de 13 de dezembro de 2021.
                        </div>
                        <div class="mb-4">
                            <strong>Autoria:</strong> Vereador Carlos Martins.
                        </div>
                        <div>
                            <strong>Sobre o reconhecimento:</strong> Oficializa o orgulho da terra natal do artista, reconhecendo sua obra como pilar da cultura santarena. Este ato fortalece as raízes amazônicas de sua música e incentiva as novas gerações de músicos da Pérola do Tapajós.
                        </div>
                    </div>
                </div>
                <div class="col-span-12 lg:col-span-4 flex justify-center">
                    <img src="/assets/images/brasao-municipal.png" class="!max-w-[195px] h-fit" alt="Brasão Municipal" />
                </div>
            </div>
        </div>
    `
})
export class HighlightsWidget {}
