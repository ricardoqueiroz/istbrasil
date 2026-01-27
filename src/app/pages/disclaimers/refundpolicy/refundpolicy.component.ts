import { Component } from '@angular/core';
import { FooterWidget } from 'src/app/shared/footer';

@Component({
  selector: 'p-refundpolicy',
  standalone: true,
  templateUrl: './refundpolicy.component.html',
  styleUrls: ['./refundpolicy.component.css'],
  imports: [FooterWidget],
})
export class RefundPolicyComponent {}
