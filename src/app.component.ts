

import { Component } from '@angular/core';
import { RouterModule } from '@angular/router';
import { CookieConsentComponent } from './app/shared/cookie-consent/cookie-consent.component';


@Component({
    selector: 'app-root',
    standalone: true,
    imports: [RouterModule, CookieConsentComponent],
    template: `
        <router-outlet></router-outlet>
        <p-cookie-consent></p-cookie-consent>
    `
})
export class AppComponent {}
