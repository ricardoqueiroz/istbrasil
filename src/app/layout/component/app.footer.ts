import { Component } from '@angular/core';

@Component({
    standalone: true,
    selector: 'app-footer',
    template: `<div class="layout-footer">
        <div class="flex w-full flex-col items-center gap-4 text-center">
            <a href="https://istbrasil.org.br" rel="noopener noreferrer" class="text-primary font-bold hover:underline">Copyright &copy; Instituto Sebastião Tapajós IST - Todos os direitos reservados.</a>
            <p class="m-0 text-surface-700 dark:text-surface-100">
                CNPJ 28.870.139/0001-05<br>
                Estr. do Pajuçara, 33 - Pr. do Pajuçara (Zona Rural) - Santarém - PA - Brasil 68005000
            </p>
        </div>
    </div>`
})
export class AppFooter {}
