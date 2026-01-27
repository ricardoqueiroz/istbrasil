import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ButtonModule } from 'primeng/button';
import { RouterModule } from '@angular/router';
import { CookieConsentComponent } from './cookie-consent.component';

@NgModule({
  declarations: [CookieConsentComponent],
  imports: [CommonModule, ButtonModule, RouterModule],
  exports: [CookieConsentComponent]
})
export class CookieConsentModule2 {}
