import { Pipe, PipeTransform } from '@angular/core';

@Pipe({
  name: 'jsonDescription',
  standalone: true
})
export class JsonDescriptionPipe implements PipeTransform {

  transform(description: any): string {
    if (!description) {
      return '<div><strong>Descrição:</strong> Não disponível.</div>';
    }

    let obj: any;
    
    // Verifica se já é objeto ou precisa de parse
    if (typeof description === 'object') {
      obj = description;
    } else {
      try {
        obj = JSON.parse(description);
      } catch (e) {
        // Não é JSON válido, retorna como texto simples
        return `<div><strong>Descrição:</strong> ${description}</div>`;
      }
    }

    // Constrói o HTML
    let html = '<div>';
    for (const key of Object.keys(obj)) {
      // Formatação simples chave: valor
      html += `<span class="font-bold">${key}:</span> <span>${obj[key]}</span><br/>`;
    }
    html += '</div>';

    return html;
  }
}