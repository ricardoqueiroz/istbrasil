import { NgModule } from '@angular/core';
import { BrowserModule } from '@angular/platform-browser';
import { RouterModule } from '@angular/router';
// Import the standalone component directly
import { CookieConsentComponent } from '../shared/cookie-consent/cookie-consent.component';
import { AppComponent } from '../../app.component';

@NgModule({
  declarations: [],
  imports: [
    BrowserModule,
    RouterModule,
    CookieConsentComponent // <-- Import standalone component
  ]
})
export class CoreModule2 {}
