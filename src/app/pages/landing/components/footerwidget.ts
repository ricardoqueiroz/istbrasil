import { Component } from '@angular/core';
import { Router, RouterModule } from '@angular/router';

@Component({
    selector: 'footer-widget',
    imports: [RouterModule],
    template: `
        <div class="py-12 px-12 mx-0 mt-20 lg:mx-20">
            <div class="grid grid-cols-12 gap-4">
                <div class="col-span-12 md:col-span-2">
                    <a (click)="router.navigate(['/pages/landing'], { fragment: 'home' })" class="flex flex-wrap items-center justify-center md:justify-start md:mb-0 mb-6 cursor-pointer">
                        <img src="assets/images/selo-small.png" alt="Logo IST" class="h-14 mr-2">
                        <h4 class="font-medium text-3xl text-surface-900 dark:text-surface-0">IST</h4>
                    </a>
                </div>

                <div class="col-span-12 md:col-span-10">
                    <div class="grid grid-cols-12 gap-8 text-center md:text-left">
                        <div class="col-span-12 md:col-span-3">
                            <h4 class="font-medium text-2xl leading-normal mb-6 text-surface-900 dark:text-surface-0">Institucional</h4>
                            <a class="leading-normal text-xl block cursor-pointer mb-2 text-surface-700 dark:text-surface-100">Sobre Nós</a>
                            <a class="leading-normal text-xl block cursor-pointer mb-2 text-surface-700 dark:text-surface-100">Diretoria</a>
                            <a class="leading-normal text-xl block cursor-pointer text-surface-700 dark:text-surface-100">Estatuto</a>
                        </div>

                        <div class="col-span-12 md:col-span-3">
                            <h4 class="font-medium text-2xl leading-normal mb-6 text-surface-900 dark:text-surface-0">Sebastião Tapajós</h4>
                            <a class="leading-normal text-xl block cursor-pointer mb-2 text-surface-700 dark:text-surface-100">Autorizações musicais</a>
                            <a class="leading-normal text-xl block cursor-pointer mb-2 text-surface-700 dark:text-surface-100">Livros e partituras</a>
                            <a class="leading-normal text-xl block cursor-pointer text-surface-700 dark:text-surface-100">Imagens</a>
                        </div>

                        <div class="col-span-12 md:col-span-3">
                            <h4 class="font-medium text-2xl leading-normal mb-6 text-surface-900 dark:text-surface-0">Contato</h4>
                            <a class="leading-normal text-xl block cursor-pointer mb-2 text-surface-700 dark:text-surface-100">WhatsApp</a>
                            <a class="leading-normal text-xl block cursor-pointer mb-2 text-surface-700 dark:text-surface-100">IST Editora</a>
                            <a class="leading-normal text-xl block cursor-pointer mb-2 text-surface-700 dark:text-surface-100">Fale Conosco</a>
                            <a class="leading-normal text-xl block cursor-pointer text-surface-700 dark:text-surface-100">Imprensa</a>
                        </div>

                        <div class="col-span-12 md:col-span-3">
                            <h4 class="font-medium text-2xl leading-normal mb-6 text-surface-900 dark:text-surface-0">Legal</h4>
                            <a class="leading-normal text-xl block cursor-pointer mb-2 text-surface-700 dark:text-surface-100">Política de marca</a>
                            <a class="leading-normal text-xl block cursor-pointer mb-2 text-surface-700 dark:text-surface-100">Política de privacidade</a>
                            <a class="leading-normal text-xl block cursor-pointer text-surface-700 dark:text-surface-100">Termos de Serviço</a>
                        </div>
                    </div>
                </div>
            </div>

            <div class="grid grid-cols-12 gap-4 mt-8 text-center">
                <div class="col-span-12">
                    <h4 class="font-medium text-2xl leading-normal mb-4 text-surface-900 dark:text-surface-0">Redes Sociais</h4>
                    <div class="flex justify-center gap-4">
                        <a class="cursor-pointer text-surface-700 dark:text-surface-100 hover:text-primary transition-colors">
                            <i class="pi pi-youtube !text-3xl"></i>
                        </a>
                        <a class="cursor-pointer text-surface-700 dark:text-surface-100 hover:text-primary transition-colors">
                            <i class="pi pi-facebook !text-3xl"></i>
                        </a>
                        <a class="cursor-pointer text-surface-700 dark:text-surface-100 hover:text-primary transition-colors">
                            <i class="fa-brands fa-spotify !text-3xl"></i>
                        </a>
                        <a class="cursor-pointer text-surface-700 dark:text-surface-100 hover:text-primary transition-colors">
                            <i class="pi pi-instagram !text-3xl"></i>
                        </a>
                    </div>
                </div>
            </div>

            <div class="grid grid-cols-12 gap-4 mt-12 text-center">
                <div class="col-span-12">
                    <p class="text-surface-700 dark:text-surface-100 font-bold">INSTITUTO SEBASTIAO TAPAJOS IST</p>
                    <p class="text-surface-700 dark:text-surface-100">
                        CNPJ 28.870.139/0001-05<br>
                        Estrada do Pajuçara, 33 - Praia de pajuçara (Zona Rural)<br>
                        Santarém - PA - Brasil 68005000
                    </p>
                </div>
            </div>

            <div class="grid grid-cols-12 gap-4 mt-8 text-center">
                <div class="col-span-12">
                    <hr class="mb-4 border-surface-300 dark:border-surface-700" />
                    <p class="text-surface-700 dark:text-surface-100">Copyright (c) Instituto Sebastião Tapajós IST - Todos os direitos reservados.</p>
                </div>
            </div>
        </div>
    `
})
export class FooterWidget {
    constructor(public router: Router) {}
}
