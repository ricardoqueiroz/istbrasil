import { Component } from '@angular/core';
import { FooterWidget } from 'src/app/shared/footer';

@Component({
  selector: 'p-privacypolicy',
  standalone: true,
  templateUrl: './privacypolicy.component.html',
  styleUrls: ['./privacypolicy.component.css'],
  imports: [FooterWidget],
})
export class PrivacyPolicyComponent {}
