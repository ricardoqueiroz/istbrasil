import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';

export interface ViaCepResponse {
    cep: string;
    logradouro: string;
    complemento: string;
    bairro: string;
    localidade: string;
    uf: string;
    erro?: boolean;
}

@Injectable({ providedIn: 'root' })
export class EnderecoService {
    constructor(private readonly http: HttpClient) {}

    async consultarCep(cep: string): Promise<ViaCepResponse | null> {
        const cepLimpo = (cep || '').replace(/\D/g, '');

        if (cepLimpo.length !== 8) {
            return null;
        }

        const resposta = await firstValueFrom(this.http.get<ViaCepResponse>(`https://viacep.com.br/ws/${cepLimpo}/json/`));
        return resposta?.erro ? null : resposta;
    }
}
