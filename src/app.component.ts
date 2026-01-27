

import { Component } from '@angular/core';

@Component({
    selector: 'app-root',
    template: `
        <router-outlet></router-outlet>
        <p-cookie-consent></p-cookie-consent>
    `
})
export class AppComponent {}
