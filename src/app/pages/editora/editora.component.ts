import { Component } from '@angular/core';
import { AccordionModule } from 'primeng/accordion';
import { FooterWidget } from 'src/app/shared/footer';

@Component({
  selector: 'app-editora',
  standalone: true,
  imports: [AccordionModule, FooterWidget],
  templateUrl: './editora.component.html',
  styleUrls: ['./editora.component.css']
})
export class EditoraComponent {}
