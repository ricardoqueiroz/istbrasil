import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';

@Component({
    selector: 'features-widget',
    standalone: true,
    imports: [CommonModule, RouterModule],
    template: ` <div id="features" class="py-6 px-6 lg:px-20 mt-8 mx-0 lg:mx-20">
        <div class="grid grid-cols-12 gap-4 justify-center">
            <div class="col-span-12 text-center mt-20 mb-6">
                <div class="text-surface-900 dark:text-surface-0 font-normal mb-2 text-4xl">Conheça o Instituto</div>
                <span class="text-muted-color text-2xl">Compromisso com a excelência e inovação</span>
            </div>
            <!-- link para a página /instituto/quem-somos -->
            <div class="col-span-12 md:col-span-12 lg:col-span-4 p-0 lg:pr-8 lg:pb-8 mt-6 lg:mt-0">
                <a routerLink="/instituto/quem-somos" class="block h-full">
                    <div style="height: 160px; padding: 2px; border-radius: 10px; background: linear-gradient(90deg, rgba(253, 228, 165, 0.2), rgba(187, 199, 205, 0.2)), linear-gradient(180deg, rgba(253, 228, 165, 0.2), rgba(187, 199, 205, 0.2))">
                        <div class="p-4 bg-surface-0 dark:bg-surface-900 h-full" style="border-radius: 8px">
                            <div class="flex items-center justify-center bg-yellow-200 mb-4" style="width: 3.5rem; height: 3.5rem; border-radius: 10px">
                                <i class="fa-solid fa-users text-2xl! text-yellow-700"></i>
                            </div>
                            <div class="mt-6 mb-1 text-surface-900 dark:text-surface-0 text-xl font-semibold">Quem somos</div>
                            <span class="text-surface-600 dark:text-surface-200">Objetivos & princípios.</span>
                        </div>
                    </div>
                </a>
            </div>
            <!-- link para a página /instituto/transparencia -->
            <div class="col-span-12 md:col-span-12 lg:col-span-4 p-0 lg:pr-8 lg:pb-8 mt-6 lg:mt-0">
                <a routerLink="/instituto/transparencia" class="block h-full">
                    <div style="height: 160px; padding: 2px; border-radius: 10px; background: linear-gradient(90deg, rgba(145, 226, 237, 0.2), rgba(251, 199, 145, 0.2)), linear-gradient(180deg, rgba(253, 228, 165, 0.2), rgba(172, 180, 223, 0.2))">
                        <div class="p-4 bg-surface-0 dark:bg-surface-900 h-full" style="border-radius: 8px">
                            <div class="flex items-center justify-center bg-cyan-200 mb-4" style="width: 3.5rem; height: 3.5rem; border-radius: 10px">
                                <i class="fa-solid fa-magnifying-glass-chart text-2xl! text-cyan-700"></i>
                            </div>
                            <div class="mt-6 mb-1 text-surface-900 dark:text-surface-0 text-xl font-semibold">Transparência</div>
                            <span class="text-surface-600 dark:text-surface-200">Informações claras e acessíveis.</span>
                        </div>
                    </div>
                </a>
            </div>
            <!-- link para a página /instituto/localizacao -->
            <div class="col-span-12 md:col-span-12 lg:col-span-4 p-0 lg:pb-8 mt-6 lg:mt-0">
                <a routerLink="/instituto/localizacao" class="block h-full">
                    <div style="height: 160px; padding: 2px; border-radius: 10px; background: linear-gradient(90deg, rgba(145, 226, 237, 0.2), rgba(172, 180, 223, 0.2)), linear-gradient(180deg, rgba(172, 180, 223, 0.2), rgba(246, 158, 188, 0.2))">
                        <div class="p-4 bg-surface-0 dark:bg-surface-900 h-full" style="border-radius: 8px">
                            <div class="flex items-center justify-center bg-indigo-200" style="width: 3.5rem; height: 3.5rem; border-radius: 10px">
                                <i class="fa-solid fa-map-location-dot text-2xl! text-indigo-700"></i>
                            </div>
                            <div class="mt-6 mb-1 text-surface-900 dark:text-surface-0 text-xl font-semibold">Localização</div>
                            <span class="text-surface-600 dark:text-surface-200">Santarém - Pará - Brasil</span>
                        </div>
                    </div>
                </a>
            </div>
            <!-- link para a página /instituto/editora -->
            <div class="col-span-12 md:col-span-12 lg:col-span-4 p-0 lg:pr-8 lg:pb-8 mt-6 lg:mt-0">
                <a routerLink="/instituto/editora" class="block h-full">
                    <div style="height: 160px; padding: 2px; border-radius: 10px; background: linear-gradient(90deg, rgba(187, 199, 205, 0.2), rgba(251, 199, 145, 0.2)), linear-gradient(180deg, rgba(253, 228, 165, 0.2), rgba(145, 210, 204, 0.2))">
                        <div class="p-4 bg-surface-0 dark:bg-surface-900 h-full" style="border-radius: 8px">
                            <div class="flex items-center justify-center bg-slate-200 mb-4" style="width: 3.5rem; height: 3.5rem; border-radius: 10px">
                                <i class="fa-solid fa-book-open-reader text-2xl! text-slate-700"></i>
                            </div>
                            <div class="mt-6 mb-1 text-surface-900 dark:text-surface-0 text-xl font-semibold">IST Editora</div>
                            <span class="text-surface-600 dark:text-surface-200">Publicações e conteúdos culturais.</span>
                        </div>
                    </div>
                </a>
            </div>
            <!-- link para a página /instituto/eventos -->
            <div class="col-span-12 md:col-span-12 lg:col-span-4 p-0 lg:pr-8 lg:pb-8 mt-6 lg:mt-0">
                <a routerLink="/instituto/eventos" class="block h-full">
                    <div style="height: 160px; padding: 2px; border-radius: 10px; background: linear-gradient(90deg, rgba(187, 199, 205, 0.2), rgba(246, 158, 188, 0.2)), linear-gradient(180deg, rgba(145, 226, 237, 0.2), rgba(160, 210, 250, 0.2))">
                        <div class="p-4 bg-surface-0 dark:bg-surface-900 h-full" style="border-radius: 8px">
                            <div class="flex items-center justify-center bg-orange-200 mb-4" style="width: 3.5rem; height: 3.5rem; border-radius: 10px">
                                <i class="fa-solid fa-calendar-days text-2xl! text-orange-700"></i>
                            </div>
                            <div class="mt-6 mb-1 text-surface-900 dark:text-surface-0 text-xl font-semibold">Eventos</div>
                            <span class="text-surface-600 dark:text-surface-200">Projetos & programação.</span>
                        </div>
                    </div>
                </a>
            </div>
            <!-- link para a página /instituto/socioeducativo -->
            <div class="col-span-12 md:col-span-12 lg:col-span-4 p-0 lg:pb-8 mt-6 lg:mt-0">
                <a routerLink="/instituto/socioeducativo" class="block h-full">
                    <div style="height: 160px; padding: 2px; border-radius: 10px; background: linear-gradient(90deg, rgba(251, 199, 145, 0.2), rgba(246, 158, 188, 0.2)), linear-gradient(180deg, rgba(172, 180, 223, 0.2), rgba(212, 162, 221, 0.2))">
                        <div class="p-4 bg-surface-0 dark:bg-surface-900 h-full" style="border-radius: 8px">
                            <div class="flex items-center justify-center bg-pink-200 mb-4" style="width: 3.5rem; height: 3.5rem; border-radius: 10px">
                                <i class="fa-solid fa-children text-2xl! text-pink-700"></i>
                            </div>
                            <div class="mt-6 mb-1 text-surface-900 dark:text-surface-0 text-xl font-semibold">Socioecologia</div>
                            <span class="text-surface-600 dark:text-surface-200">Gestão de recursos e projetos sociais.</span>
                        </div>
                    </div>
                </a>
            </div>

            <div class="col-span-12 text-center mt-20 mb-6">
                <div class="text-surface-900 dark:text-surface-0 font-normal mb-2 text-4xl">Nosso Patrono</div>
                <span class="text-muted-color text-2xl">Um exemplo de dedicação e talento</span>
            </div>
            <!-- link para a página /patrono/info -->
            <div
                class="col-span-12 mt-6 mb-20 p-2 md:p-20"
                style="border-radius: 20px; background: linear-gradient(0deg, rgba(255, 255, 255, 0.6), rgba(255, 255, 255, 0.6)), radial-gradient(77.36% 256.97% at 77.36% 57.52%, #efe1af 0%, #c3dcfa 100%)"
            >
                <a routerLink="/patrono/info" class="block h-full">
                    <div class="flex flex-col justify-center items-center text-center px-4 py-4 md:py-0">
                        <img src="/assets/images/st-banner.jpg" class="mt-6 mb-6 rounded-2xl shadow-xl !max-w-full h-auto" alt="Sebastião Tapajós" />
                        <div class="text-gray-900 mb-2 text-3xl font-semibold">Sebastião Tapajós</div>
                        <span class="text-gray-600 text-2xl">Vida & Obra</span>
                        <p class="text-gray-900 sm:line-height-2 md:line-height-4 text-2xl mt-6" style="max-width: 800px">
                            O encontro perfeito entre a alma brasileira e a técnica universal. Em mais de 50 anos de carreira, levou a cultura amazônica para dialogar com o Jazz e a música erudita mundial. Descubra a história, as lutas e as glórias deste ícone que carregou o nome de um rio e a força de um povo
                        </p>
                    </div>
                </a>
            </div>
        </div>
    </div>`
})
export class FeaturesWidget {}
