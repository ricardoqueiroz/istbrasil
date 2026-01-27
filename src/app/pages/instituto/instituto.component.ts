import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FooterWidget } from 'src/app/shared/footer';

// Interfaces para tipagem dos dados
interface TeamMember {
  name: string;
  role: string;
  image?: string;
}

interface Objective {
  title: string;
  description: string;
  icon: string;
}

@Component({
  selector: 'app-instituto',
  standalone: true,
  imports: [
    CommonModule,
    FooterWidget,
    // ...other imports if any...
  ],
  templateUrl: './instituto.component.html',
  styleUrls: ['./instituto.component.css']
})
export class InstitutoComponent implements OnInit {
  // Dados atualizados conforme arquivo "Informações de contato.csv"
  team: TeamMember[] = [
    {
      name: 'Vanessa Barros',
      role: 'Presidente',
      image: 'assets/images/team/vanessa-ataide.jpg'
    },
    {
      name: 'Anderson Pereira',
      role: 'Vice-presidente',
      image: 'assets/images/team/anderson-pereira.jpg'  
    },
    {
      name: 'Elizangila Dezincourt',
      role: '1º Secretária',
      image: 'assets/images/team/elizangila-dezincourt.jpg'
    },
    {
      name: 'Ricardo Queiroz',
      role: 'Diretor de Planejamento e Projetos',
      image: 'assets/images/team/ricardo-queiroz.jpg'
    },
    {
      name: 'Jamile Fernandes',
      role: 'Diretor de Eventos',
      image: 'assets/images/team/jamile-santos.jpg'
    },
    {
      name: 'Mourrambert Flexa',
      role: 'Diretor de Patrimônio',
      image: 'assets/images/team/mourrambert-flexa.jpg'
    }
  ];

  objectives: Objective[] = [
    {
      title: 'Educação Musical',
      description: 'Projetos de ensino para jovens de baixa renda da região.',
      icon: 'pi pi-user'
    },
    {
      title: 'Acervo Digital',
      description: 'Digitalização e disponibilização das obras para o mundo.',
      icon: 'pi pi-cloud'
    },
    {
      title: 'Museu IST',
      description: 'Construção do espaço físico para memória do artista.',
      icon: 'pi pi-building'
    }
  ];

  constructor() {}

  ngOnInit(): void {
    console.log('Página Sobre Nós carregada.');
  }
}