import { Component } from '@angular/core';
import { ButtonModule } from 'primeng/button';
import { DividerModule } from 'primeng/divider';
import { RippleModule } from 'primeng/ripple';

@Component({
    selector: 'pricing-widget',
    imports: [DividerModule, ButtonModule, RippleModule],
    template: `
        <div id="pricing" class="py-6 px-6 lg:px-20 my-2 md:my-6">
            <div class="text-center mb-6">
                <div class="text-surface-900 dark:text-surface-0 font-normal mb-2 text-4xl">Conheça Santarém</div>
                <span class="text-muted-color text-2xl">Ecoturismo, cultura e negócios</span>
            </div>

            <div class="grid grid-cols-12 gap-4 justify-between mt-20 md:mt-0">
                <div class="col-span-12 lg:col-span-4 p-0 md:p-4">
                    <div class="p-4 flex flex-col border-surface-200 dark:border-surface-600 pricing-card cursor-pointer border-2 hover:border-primary duration-300 transition-all" style="border-radius: 10px">
                        <div class="text-surface-900 dark:text-surface-0 text-center my-8 text-3xl">Alter do Chão</div>
                        <img src="/assets/images/alter.png" class="w-10/12 mx-auto" alt="Alter do Chão" />
                        <div class="my-8 flex flex-col items-center gap-4"></div>
                        <p-divider class="w-full bg-surface-200"></p-divider>
                        <ul class="my-8 list-none p-0 flex text-surface-900 dark:text-surface-0 flex-col px-8">
                            <li class="py-2">
                                <i class="pi pi-fw pi-check text-xl text-cyan-500 mr-2"></i>
                                <span class="text-xl leading-normal">Ilha do Amor</span>
                            </li>
                            <li class="py-2">
                                <i class="pi pi-fw pi-check text-xl text-cyan-500 mr-2"></i>
                                <span class="text-xl leading-normal">Encontro das Águas</span>
                            </li>
                            <li class="py-2">
                                <i class="pi pi-fw pi-check text-xl text-cyan-500 mr-2"></i>
                                <span class="text-xl leading-normal">Festividade do Sairé</span>
                            </li>
                            <li class="py-2">
                                <i class="pi pi-fw pi-check text-xl text-cyan-500 mr-2"></i>
                                <span class="text-xl leading-normal">Vila de Alter do Chão</span>
                            </li>
                        </ul>
                    </div>
                </div>

                <div class="col-span-12 lg:col-span-4 p-0 md:p-4 mt-6 md:mt-0">
                    <div class="p-4 flex flex-col border-surface-200 dark:border-surface-600 pricing-card cursor-pointer border-2 hover:border-primary duration-300 transition-all" style="border-radius: 10px">
                        <div class="text-surface-900 dark:text-surface-0 text-center my-8 text-3xl">Centro de Convenções</div>
                        <img src="/assets/images/centro-convencoes.png" class="w-10/12 mx-auto" alt="Centro de Convenções" />
                        <div class="my-8 flex flex-col items-center gap-4"></div>
                        <p-divider class="w-full bg-surface-200"></p-divider>
                        <ul class="my-8 list-none p-0 flex text-surface-900 dark:text-surface-0 flex-col px-8">
                            <li class="py-2">
                                <i class="pi pi-fw pi-check text-xl text-cyan-500 mr-2"></i>
                                <span class="text-xl leading-normal">Polo de Negócios e Cultura</span>
                            </li>
                            <li class="py-2">
                                <i class="pi pi-fw pi-check text-xl text-cyan-500 mr-2"></i>
                                <span class="text-xl leading-normal">Visibilidade Regional e Nacional</span>
                            </li>
                            <li class="py-2">
                                <i class="pi pi-fw pi-check text-xl text-cyan-500 mr-2"></i>
                                <span class="text-xl leading-normal">Localização Estratégica</span>
                            </li>
                            <li class="py-2">
                                <i class="pi pi-fw pi-check text-xl text-cyan-500 mr-2"></i>
                                <span class="text-xl leading-normal">Espaço Amplo e Confortável</span>
                            </li>
                        </ul>
                    </div>
                </div>

                <div class="col-span-12 lg:col-span-4 p-0 md:p-4 mt-6 md:mt-0">
                    <div class="p-4 flex flex-col border-surface-200 dark:border-surface-600 pricing-card cursor-pointer border-2 hover:border-primary duration-300 transition-all" style="border-radius: 10px">
                        <div class="text-surface-900 dark:text-surface-0 text-center my-8 text-3xl">Floresta Nacional do Tapajós</div>
                        <img src="/assets/images/sumauma.png" class="w-10/12 mx-auto" alt="Sumaúma" />
                        <div class="my-8 flex flex-col items-center gap-4"></div>
                        <p-divider class="w-full bg-surface-200"></p-divider>
                        <ul class="my-8 list-none p-0 flex text-surface-900 dark:text-surface-0 flex-col px-8">
                            <li class="py-2">
                                <i class="pi pi-fw pi-check text-xl text-cyan-500 mr-2"></i>
                                <span class="text-xl leading-normal">Igarapés de águas claras</span>
                            </li>
                            <li class="py-2">
                                <i class="pi pi-fw pi-check text-xl text-cyan-500 mr-2"></i>
                                <span class="text-xl leading-normal">Sumaúma (Árvore da Vida)</span>
                            </li>
                            <li class="py-2">
                                <i class="pi pi-fw pi-check text-xl text-cyan-500 mr-2"></i>
                                <span class="text-xl leading-normal">Visitas às comunidades</span>
                            </li>
                            <li class="py-2">
                                <i class="pi pi-fw pi-check text-xl text-cyan-500 mr-2"></i>
                                <span class="text-xl leading-normal">Culinária Regional</span>
                            </li>
                        </ul>
                    </div>
                </div>
            </div>
        </div>
    `
})
export class PricingWidget {}
