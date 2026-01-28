import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { AccordionModule } from 'primeng/accordion';


@Component({
    selector: 'features-widget',
    standalone: true,
    imports: [CommonModule, RouterModule, AccordionModule],
    template: ` <div id="features" class="py-6 px-6 lg:px-20 mt-8 mx-0 lg:mx-20">
        <div class="grid grid-cols-12 gap-4 justify-center">
            <div class="col-span-12 text-center mt-20 mb-6">
                <div class="text-emerald-900 dark:text-surface-0 font-normal mb-2 text-4xl">Conheça o Instituto</div>
                <span class="text-muted-color text-2xl">Compromisso com a excelência e inovação</span>
            </div>
            <!-- link para a página /instituto -->
            <div class="col-span-12 md:col-span-12 lg:col-span-4 p-0 lg:pr-8 lg:pb-8 mt-6 lg:mt-0">
                <a routerLink="/instituto" class="block h-full">
                    <div style="height: 160px; padding: 2px; border-radius: 10px; background: linear-gradient(90deg, rgba(253, 228, 165, 0.2), rgba(187, 199, 205, 0.2)), linear-gradient(180deg, rgba(253, 228, 165, 0.2), rgba(187, 199, 205, 0.2))">
                        <div class="p-4 bg-surface-0 dark:bg-surface-900 h-full" style="border-radius: 8px">
                            <div class="flex items-center justify-center bg-yellow-200 mb-4" style="width: 3.5rem; height: 3.5rem; border-radius: 10px">
                                <i class="fa-solid fa-users text-2xl! text-yellow-700"></i>
                            </div>
                            <div class="mt-6 mb-1 text-emerald-900 dark:text-surface-0 text-xl font-semibold">Quem somos</div>
                            <span class="text-surface-600 dark:text-surface-200">Objetivos & princípios.</span>
                        </div>
                    </div>
                </a>
            </div>
            <!-- link para a página /transparencia -->
            <div class="col-span-12 md:col-span-12 lg:col-span-4 p-0 lg:pr-8 lg:pb-8 mt-6 lg:mt-0">
                <a routerLink="/transparencia" class="block h-full">
                    <div style="height: 160px; padding: 2px; border-radius: 10px; background: linear-gradient(90deg, rgba(145, 226, 237, 0.2), rgba(251, 199, 145, 0.2)), linear-gradient(180deg, rgba(253, 228, 165, 0.2), rgba(172, 180, 223, 0.2))">
                        <div class="p-4 bg-surface-0 dark:bg-surface-900 h-full" style="border-radius: 8px">
                            <div class="flex items-center justify-center bg-cyan-200 mb-4" style="width: 3.5rem; height: 3.5rem; border-radius: 10px">
                                <i class="fa-solid fa-magnifying-glass-chart text-2xl! text-cyan-700"></i>
                            </div>
                            <div class="mt-6 mb-1 text-emerald-900 dark:text-surface-0 text-xl font-semibold">Transparência</div>
                            <span class="text-surface-600 dark:text-surface-200">Informações claras e acessíveis.</span>
                        </div>
                    </div>
                </a>
            </div>
            <!-- link para a página /localizacao -->
            <div class="col-span-12 md:col-span-12 lg:col-span-4 p-0 lg:pb-8 mt-6 lg:mt-0">
                <a routerLink="/localizacao" class="block h-full">
                    <div style="height: 160px; padding: 2px; border-radius: 10px; background: linear-gradient(90deg, rgba(145, 226, 237, 0.2), rgba(172, 180, 223, 0.2)), linear-gradient(180deg, rgba(172, 180, 223, 0.2), rgba(246, 158, 188, 0.2))">
                        <div class="p-4 bg-surface-0 dark:bg-surface-900 h-full" style="border-radius: 8px">
                            <div class="flex items-center justify-center bg-indigo-200" style="width: 3.5rem; height: 3.5rem; border-radius: 10px">
                                <i class="fa-solid fa-map-location-dot text-2xl! text-indigo-700"></i>
                            </div>
                            <div class="mt-6 mb-1 text-emerald-900 dark:text-surface-0 text-xl font-semibold">Localização</div>
                            <span class="text-surface-600 dark:text-surface-200">Santarém - Pará - Brasil</span>
                        </div>
                    </div>
                </a>
            </div>
            <!-- link para a página /editora -->
            <div class="col-span-12 md:col-span-12 lg:col-span-4 p-0 lg:pr-8 lg:pb-8 mt-6 lg:mt-0">
                <a routerLink="/editora" class="block h-full">
                    <div style="height: 160px; padding: 2px; border-radius: 10px; background: linear-gradient(90deg, rgba(187, 199, 205, 0.2), rgba(251, 199, 145, 0.2)), linear-gradient(180deg, rgba(253, 228, 165, 0.2), rgba(145, 210, 204, 0.2))">
                        <div class="p-4 bg-surface-0 dark:bg-surface-900 h-full" style="border-radius: 8px">
                            <div class="flex items-center justify-center bg-slate-200 mb-4" style="width: 3.5rem; height: 3.5rem; border-radius: 10px">
                                <i class="fa-solid fa-book-open-reader text-2xl! text-slate-700"></i>
                            </div>
                            <div class="mt-6 mb-1 text-emerald-900 dark:text-surface-0 text-xl font-semibold">IST Editora</div>
                            <span class="text-surface-600 dark:text-surface-200">Publicações e conteúdos culturais.</span>
                        </div>
                    </div>
                </a>
            </div>
            <!-- link para a página /eventos -->
            <div class="col-span-12 md:col-span-12 lg:col-span-4 p-0 lg:pr-8 lg:pb-8 mt-6 lg:mt-0">
                <a routerLink="/eventos" class="block h-full">
                    <div style="height: 160px; padding: 2px; border-radius: 10px; background: linear-gradient(90deg, rgba(187, 199, 205, 0.2), rgba(246, 158, 188, 0.2)), linear-gradient(180deg, rgba(145, 226, 237, 0.2), rgba(160, 210, 250, 0.2))">
                        <div class="p-4 bg-surface-0 dark:bg-surface-900 h-full" style="border-radius: 8px">
                            <div class="flex items-center justify-center bg-orange-200 mb-4" style="width: 3.5rem; height: 3.5rem; border-radius: 10px">
                                <i class="fa-solid fa-calendar-days text-2xl! text-orange-700"></i>
                            </div>
                            <div class="mt-6 mb-1 text-emerald-900 dark:text-surface-0 text-xl font-semibold">Eventos</div>
                            <span class="text-surface-600 dark:text-surface-200">Eventos apoiados & programação.</span>
                        </div>
                    </div>
                </a>
            </div>
            <!-- link para a página /projetos -->
            <div class="col-span-12 md:col-span-12 lg:col-span-4 p-0 lg:pb-8 mt-6 lg:mt-0">
                <a routerLink="/projetos" class="block h-full">
                    <div style="height: 160px; padding: 2px; border-radius: 10px; background: linear-gradient(90deg, rgba(251, 199, 145, 0.2), rgba(246, 158, 188, 0.2)), linear-gradient(180deg, rgba(172, 180, 223, 0.2), rgba(212, 162, 221, 0.2))">
                        <div class="p-4 bg-surface-0 dark:bg-surface-900 h-full" style="border-radius: 8px">
                            <div class="flex items-center justify-center bg-pink-200 mb-4" style="width: 3.5rem; height: 3.5rem; border-radius: 10px">
                                <i class="fa-solid fa-children text-2xl! text-pink-700"></i>
                            </div>
                            <div class="mt-6 mb-1 text-emerald-900 dark:text-surface-0 text-xl font-semibold">Projetos</div>
                            <span class="text-surface-600 dark:text-surface-200">Gestão de recursos e projetos.</span>
                        </div>
                    </div>
                </a>
            </div>

            <!-- link para a página /patrono/info -->
            <div
                class="col-span-12 mt-6 mb-20 p-2 md:p-20"
                style="border-radius: 20px; background: linear-gradient(0deg, rgba(255, 255, 255, 0.6), rgba(255, 255, 255, 0.6)), radial-gradient(77.36% 256.97% at 77.36% 57.52%, #efe1af 0%, #c3dcfa 100%)"
            >
                <div class="block h-full">
                    <div class="flex flex-col justify-center items-center text-center px-4 py-4 md:py-0">
                        <div class="text-emerald-900 dark:text-surface-0 font-normal mb-2 text-4xl">Sebastião Tapajós</div>
                        <span class="text-muted-color text-2xl">Exemplo de dedicação e talento</span>
                        <img src="/assets/images/st-banner.jpg" class="mt-6 mb-6 rounded-2xl shadow-xl !max-w-full h-auto" alt="Sebastião Tapajós" />
                        <div class="text-gray-900 mb-2 text-3xl font-semibold">Vida & Obra</div>
                        <p class="text-gray-900 sm:line-height-2 md:line-height-4 text-2xl mt-6" style="max-width: 800px">
                            O encontro perfeito entre a alma brasileira e a técnica universal. Em mais de 50 anos de carreira, levou a cultura amazônica para dialogar com o Jazz e a música erudita mundial. Descubra a história, as lutas e as glórias deste ícone que carregou o nome de um rio e a força de um povo.
                        </p>
                        <!-- Links para as páginas /patrono/biografia, /patrono/obra, /patrono/museu -->
                        <div class="mt-8 flex flex-col md:flex-row gap-8 justify-center" style="max-width: 800px; width: 100%;">
                            <a routerLink="/patrono/biografia" class="px-6 py-3 bg-primary text-white font-semibold rounded-lg hover:bg-primary-dark transition-colors w-full md:w-56 text-center"><i class="layout-menuitem-icon pi pi-fw pi-info-circle mr-2"></i><span class="layout-menuitem-text ng-tns-c207508854-18">Biografia</span></a> 
                            <a routerLink="/patrono/obra" class="px-6 py-3 bg-primary text-white font-semibold rounded-lg hover:bg-primary-dark transition-colors w-full md:w-56 text-center"><i class="layout-menuitem-icon pi-fw  pi pi-volume-up mr-2"></i><span class="layout-menuitem-text ng-tns-c207508854-18">Obra Musical</span></a> 
                            <a routerLink="/patrono/discografia" class="px-6 py-3 bg-primary text-white font-semibold rounded-lg hover:bg-primary-dark transition-colors w-full md:w-56 text-center"><i class="layout-menuitem-icon pi pi-fw pi-fw pi-headphones mr-2"></i><span class="layout-menuitem-text ng-tns-c207508854-18">Discografia</span></a>
                        </div>

                        <div class="text-center mt-8">
                            <div class="text-emerald-900 dark:text-surface-0 font-normal mb-2 text-4xl">Reconhecimento da Obra</div>
                            <span class="text-muted-color text-2xl">Patrimônio Cultural</span>
                        </div>

                        <div class="mt-8 flex flex-col md:flex-row gap-8 justify-center" style="max-width: 800px; width: 100%;">
                            <p-accordion value="0">
                                <p-accordion-panel value="0">
                                    <p-accordion-header>
                                        <div  class="flex items-center text-left">
                                            <img src="/assets/images/brasao-federal.png" class="!max-w-[50px] h-fit mr-4" alt="Brasão Federal" />
                                            <div class="leading-none text-surface-900 dark:text-surface-0 text-2xl font-normal mb-4 text-left">Manifestação da Cultura Nacional</div>
                                        </div>
                                    </p-accordion-header>
                                    <p-accordion-content>
                                        <div class="text-surface-700 dark:text-surface-100 text-xl leading-normal text-left">
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
                                    </p-accordion-content>
                                </p-accordion-panel>

                                <p-accordion-panel value="1">
                                    <p-accordion-header>
                                        <div  class="flex items-center text-left">
                                            <img src="/assets/images/brasao-estadual.png" class="!max-w-[50px] h-fit mr-4" alt="Brasão Estadual" />
                                            <div class="leading-none text-surface-900 dark:text-surface-0 text-2xl font-normal mb-4">Patrimônio Cultural Imaterial do Estado do Pará</div>
                                        </div>
                                    </p-accordion-header>
                                    <p-accordion-content>
                                        <div class="text-surface-700 dark:text-surface-100 text-xl leading-normal text-left">
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
                                    </p-accordion-content>
                                </p-accordion-panel>

                                <p-accordion-panel value="2">
                                    <p-accordion-header>
                                        <div  class="flex items-center text-left">
                                            <img src="/assets/images/brasao-municipal.png" class="!max-w-[50px] h-fit mr-4" alt="Brasão Municipal" />
                                            <div class="leading-none text-surface-900 dark:text-surface-0 text-2xl font-normal mb-4 text-left">Patrimônio Cultural Imaterial do Município de Santarém</div>
                                        </div>
                                    </p-accordion-header>
                                    <p-accordion-content>
                                        <div class="text-surface-700 dark:text-surface-100 text-xl leading-normal text-left">
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
                                    </p-accordion-content>
                                </p-accordion-panel>
                            </p-accordion>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </div>`
})
export class FeaturesWidget {}
