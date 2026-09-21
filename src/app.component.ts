

import { Component, OnInit } from '@angular/core';
import { RouterModule } from '@angular/router';
import { CookieConsentComponent } from './app/shared/cookie-consent/cookie-consent.component';
import { AuthService } from './app/shared/auth.service';


@Component({
    selector: 'app-root',
    standalone: true,
    imports: [RouterModule, CookieConsentComponent],
    template: `
        <router-outlet></router-outlet>
        <p-cookie-consent></p-cookie-consent>
    `
})
export class AppComponent implements OnInit {
    constructor(private readonly authService: AuthService) {}

    ngOnInit(): void {
        this.authService.verificarSessao();
    }
}
