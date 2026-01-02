import { Component } from '@angular/core';
import { ButtonModule } from 'primeng/button';

@Component({
    selector: 'app-dashboard',
    imports: [ButtonModule],
    template: `
        <div class="grid grid-cols-12 gap-4">
            <div class="col-span-12 md:col-span-6 lg:col-span-4">
                <div class="card mb-0 shadow-md hover:shadow-xl transition-all duration-500">
                    <div class="flex justify-between mb-3">
                        <div>
                            <span class="block text-gray-500 font-medium mb-3">Conheça</span>
                            <div class="text-gray-900 font-bold text-xl">Cidade de Santarém</div>
                        </div>
                        <div class="flex items-center justify-center bg-blue-100 rounded-lg" style="width:2.5rem;height:2.5rem">
                            <i class="pi pi-map-marker text-blue-500 text-xl"></i>
                        </div>
                    </div>
                    <p class="text-gray-600">Descubra a pérola do Tapajós.</p>
                    <button pButton label="Ver Detalhes" class="p-button-text"></button>
                </div>
            </div>

            <div class="col-span-12 md:col-span-6 lg:col-span-4">
                <div class="card mb-0 shadow-md hover:shadow-xl transition-all duration-500">
                    <div class="flex justify-between mb-3">
                        <div>
                            <span class="block text-gray-500 font-medium mb-3">Espaço</span>
                            <div class="text-gray-900 font-bold text-xl">Centro de Convenções</div>
                        </div>
                        <div class="flex items-center justify-center bg-orange-100 rounded-lg" style="width:2.5rem;height:2.5rem">
                            <i class="pi pi-building text-orange-500 text-xl"></i>
                        </div>
                    </div>
                    <p class="text-gray-600">Infraestrutura Sebastião Tapajós.</p>
                    <button pButton label="Explorar" class="p-button-text"></button>
                </div>
            </div>

            <div class="col-span-12 md:col-span-6 lg:col-span-4">
                <div class="card mb-0 shadow-md hover:shadow-xl transition-all duration-500">
                    <div class="flex justify-between mb-3">
                        <div>
                            <span class="block text-gray-500 font-medium mb-3">Acervo</span>
                            <div class="text-gray-900 font-bold text-xl">Museu Virtual</div>
                        </div>
                        <div class="flex items-center justify-center bg-purple-100 rounded-lg" style="width:2.5rem;height:2.5rem">
                            <i class="pi pi-camera text-purple-500 text-xl"></i>
                        </div>
                    </div>
                    <ul class="list-none p-0 m-0">
                        <li class="flex items-center mb-2 text-gray-600"><i class="pi pi-music mr-2"></i> Acervo Musical</li>
                        <li class="flex items-center mb-2 text-gray-600"><i class="pi pi-youtube mr-2"></i> Acervo Visual</li>
                        <li class="flex items-center text-gray-600"><i class="pi pi-images mr-2"></i> Fotos Históricas</li>
                    </ul>
                </div>
            </div>
        </div>
    `
})
export class Dashboard {}
