import { Component } from '@angular/core';
import { Router, RouterModule } from '@angular/router';

@Component({
    selector: 'footer-widget',
    standalone: true,
    imports: [RouterModule],
    templateUrl: './footerwidget.html'
})
export class FooterWidget {
    constructor(public router: Router) {}

    navigateAndScrollTop(commands: any[], extras?: any) {
        this.router.navigate(commands, extras).then(() => {
            window.scrollTo({ top: 0, behavior: 'auto' });
        });
    }
}
