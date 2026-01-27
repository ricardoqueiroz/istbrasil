import { Injectable } from '@angular/core';

@Injectable({
  providedIn: 'root'
})
export class CookieService {
  private consentKey = 'cookie_consent';

  hasConsent(): boolean {
    return localStorage.getItem(this.consentKey) !== null;
  }

  setConsent(value: 'accepted' | 'rejected'): void {
    localStorage.setItem(this.consentKey, value);
  }

  getConsent(): string | null {
    return localStorage.getItem(this.consentKey);
  }
}
