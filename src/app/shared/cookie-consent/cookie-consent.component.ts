import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { CookieService } from '../cookie.service';

@Component({
  selector: 'p-cookie-consent',
  standalone: true,
  imports: [CommonModule],
  providers: [CookieService],
  templateUrl: './cookie-consent.component.html',
  styleUrls: ['./cookie-consent.component.css']
})
export class CookieConsentComponent {
  visible = false;
  constructor(public cookieService: CookieService) {
    if (!this.cookieService.hasConsent()) {
      setTimeout(() => this.visible = true, 2000);
    }
  }
  acceptAll() {
    this.cookieService.setConsent('accepted');
    this.visible = false;
  }
  rejectOptional() {
    this.cookieService.setConsent('rejected');
    this.visible = false;
  }
}
