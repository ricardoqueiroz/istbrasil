import { Component } from '@angular/core';
import { FooterWidget } from 'src/app/shared/footer';

@Component({
  selector: 'p-termsofservice',
  standalone: true,
  templateUrl: './termsofservice.component.html',
  styleUrls: ['./termsofservice.component.css'],
  imports: [FooterWidget],
})
export class TermsOfServiceComponent {}
