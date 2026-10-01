import { CommonModule } from '@angular/common';
import { Component, OnInit, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { DatePickerModule } from 'primeng/datepicker';
import { InputMaskModule } from 'primeng/inputmask';
import { InputTextModule } from 'primeng/inputtext';
import { SelectModule } from 'primeng/select';
import { AuthService } from '../../../../shared/auth.service';
import {
    CargoAdmin,
    SituacaoAdmin,
    TipoUsuarioAdmin,
    UsuarioAdminAtualizacaoPayload,
    UsuarioAdminDetalhe
} from '../cadastros.model';
import { CadastrosAdminService, CadastrosAdminServiceError } from '../cadastros.service';

interface FormularioUsuarioAdmin {
    nome: string;
    cpf: string;
    identidade: string;
    dataNascimento: Date | null;
    idTipoUsuario: number | null;
    idCargo: number | null;
    idSituacao: number | null;
    telefoneCelular: string;
    logradouro: string;
    numero: string;
    complemento: string;
    bairro: string;
    cidade: string;
    uf: string;
    cep: string;
}

const UFS = [
    'AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS',
    'MG', 'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC',
    'SP', 'SE', 'TO'
].map((uf) => ({ label: uf, value: uf }));

@Component({
    selector: 'app-admin-cadastros-editar',
    standalone: true,
    imports: [CommonModule, FormsModule, ButtonModule, DatePickerModule, InputMaskModule, InputTextModule, SelectModule],
    template: `
        <section class="space-y-6">
            <header class="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                <div>
                    <p class="text-sm font-semibold uppercase tracking-widest text-primary">Administração de cadastros</p>
                    <h2 class="mt-2 text-3xl font-bold text-surface-900 dark:text-white">Editar usuário</h2>
                    <p *ngIf="idUsuario" class="mt-2 text-sm text-surface-500">ID do usuário: {{ idUsuario }}</p>
                </div>
                <button pButton type="button" label="Voltar" icon="pi pi-arrow-left" class="p-button-outlined" (click)="cancelar()" [disabled]="salvando"></button>
            </header>

            <div *ngIf="carregando" class="rounded-lg border border-surface-200 bg-white px-5 py-10 text-center text-surface-600 dark:border-surface-800 dark:bg-surface-900 dark:text-surface-300">
                Carregando usuário...
            </div>

            <div *ngIf="!carregando && erroCarregamento" class="rounded-lg border border-red-200 bg-red-50 px-4 py-4 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/30 dark:text-red-200">
                {{ erroCarregamento }}
            </div>

            <form *ngIf="!carregando && !erroCarregamento && usuario" class="space-y-8" (ngSubmit)="salvar()" novalidate>
                <div *ngIf="mensagem" class="rounded-lg border px-4 py-3 text-sm" [ngClass]="{
                    'border-red-200 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950/30 dark:text-red-200': tipoMensagem === 'error',
                    'border-green-200 bg-green-50 text-green-700 dark:border-green-800 dark:bg-green-950/30 dark:text-green-200': tipoMensagem === 'success'
                }">{{ mensagem }}</div>

                <section aria-labelledby="dados-acesso">
                    <h3 id="dados-acesso" class="border-b border-surface-200 pb-3 text-lg font-semibold text-surface-900 dark:border-surface-800 dark:text-white">Identificação e classificação</h3>
                    <div class="mt-5 grid gap-5 md:grid-cols-2">
                        <div>
                            <label for="usuarioNome" class="mb-2 block text-sm font-medium text-surface-700 dark:text-surface-200">Nome</label>
                            <input id="usuarioNome" pInputText name="usuarioNome" [(ngModel)]="formulario.nome" maxlength="255" class="w-full" required />
                        </div>

                        <div>
                            <span class="mb-2 block text-sm font-medium text-surface-700 dark:text-surface-200">E-mail</span>
                            <div class="min-h-10 rounded-lg border border-surface-200 bg-surface-50 px-3 py-2.5 text-sm text-surface-700 dark:border-surface-700 dark:bg-surface-800 dark:text-surface-200">
                                {{ usuario.email }}
                            </div>
                            <p class="mt-1 text-xs text-surface-500">O e-mail não é alterado por esta tela.</p>
                        </div>

                        <div>
                            <label for="usuarioCpf" class="mb-2 block text-sm font-medium text-surface-700 dark:text-surface-200">CPF</label>
                            <p-inputMask id="usuarioCpf" name="usuarioCpf" [(ngModel)]="formulario.cpf" mask="999.999.999-99" placeholder="000.000.000-00" styleClass="w-full" [required]="true"></p-inputMask>
                        </div>

                        <div>
                            <label for="usuarioIdentidade" class="mb-2 block text-sm font-medium text-surface-700 dark:text-surface-200">Identidade (opcional)</label>
                            <input id="usuarioIdentidade" pInputText name="usuarioIdentidade" [(ngModel)]="formulario.identidade" maxlength="20" class="w-full" />
                        </div>

                        <div>
                            <label for="usuarioNascimento" class="mb-2 block text-sm font-medium text-surface-700 dark:text-surface-200">Data de nascimento</label>
                            <p-datepicker id="usuarioNascimento" name="usuarioNascimento" [(ngModel)]="formulario.dataNascimento" dateFormat="dd/mm/yy" [showIcon]="true" [maxDate]="hoje" placeholder="dd/mm/aaaa" styleClass="w-full" [required]="true"></p-datepicker>
                        </div>

                        <div>
                            <label for="usuarioTelefone" class="mb-2 block text-sm font-medium text-surface-700 dark:text-surface-200">Telefone celular</label>
                            <p-inputMask id="usuarioTelefone" name="usuarioTelefone" [(ngModel)]="formulario.telefoneCelular" mask="(99) 99999-9999" placeholder="(00) 00000-0000" styleClass="w-full" [required]="true"></p-inputMask>
                        </div>

                        <div>
                            <label for="usuarioTipo" class="mb-2 block text-sm font-medium text-surface-700 dark:text-surface-200">Tipo de usuário</label>
                            <p-select id="usuarioTipo" name="usuarioTipo" [(ngModel)]="formulario.idTipoUsuario" (ngModelChange)="alterarTipo($event)" [options]="tiposUsuario" optionLabel="tipo" optionValue="idTipoUsuario" placeholder="Selecione o tipo" styleClass="w-full" [disabled]="editandoProprioUsuario" [required]="true"></p-select>
                            <p *ngIf="editandoProprioUsuario" class="mt-1 text-xs text-surface-500">Seu próprio tipo não pode ser alterado.</p>
                        </div>

                        <div>
                            <label for="usuarioSituacao" class="mb-2 block text-sm font-medium text-surface-700 dark:text-surface-200">Situação</label>
                            <p-select id="usuarioSituacao" name="usuarioSituacao" [(ngModel)]="formulario.idSituacao" [options]="situacoesDisponiveis" optionLabel="situacao" optionValue="idSituacao" placeholder="Selecione a situação" styleClass="w-full" [disabled]="editandoProprioUsuario" [required]="true"></p-select>
                            <p *ngIf="editandoProprioUsuario" class="mt-1 text-xs text-surface-500">Sua própria situação não pode ser alterada.</p>
                        </div>

                        <div>
                            <label for="usuarioCargo" class="mb-2 block text-sm font-medium text-surface-700 dark:text-surface-200">Cargo</label>
                            <p-select id="usuarioCargo" name="usuarioCargo" [(ngModel)]="formulario.idCargo" [options]="cargos" optionLabel="cargo" optionValue="idCargo" [showClear]="true" placeholder="Nenhum cargo" styleClass="w-full"></p-select>
                        </div>
                    </div>
                </section>

                <section aria-labelledby="dados-endereco">
                    <h3 id="dados-endereco" class="border-b border-surface-200 pb-3 text-lg font-semibold text-surface-900 dark:border-surface-800 dark:text-white">Endereço</h3>
                    <div class="mt-5 grid gap-5 md:grid-cols-2 lg:grid-cols-3">
                        <div>
                            <label for="usuarioCep" class="mb-2 block text-sm font-medium text-surface-700 dark:text-surface-200">CEP</label>
                            <p-inputMask id="usuarioCep" name="usuarioCep" [(ngModel)]="formulario.cep" mask="99999-999" placeholder="00000-000" styleClass="w-full" [required]="true"></p-inputMask>
                        </div>
                        <div class="md:col-span-2">
                            <label for="usuarioLogradouro" class="mb-2 block text-sm font-medium text-surface-700 dark:text-surface-200">Logradouro</label>
                            <input id="usuarioLogradouro" pInputText name="usuarioLogradouro" [(ngModel)]="formulario.logradouro" maxlength="255" class="w-full" required />
                        </div>
                        <div>
                            <label for="usuarioNumero" class="mb-2 block text-sm font-medium text-surface-700 dark:text-surface-200">Número</label>
                            <input id="usuarioNumero" pInputText name="usuarioNumero" [(ngModel)]="formulario.numero" maxlength="20" class="w-full" required />
                        </div>
                        <div>
                            <label for="usuarioComplemento" class="mb-2 block text-sm font-medium text-surface-700 dark:text-surface-200">Complemento</label>
                            <input id="usuarioComplemento" pInputText name="usuarioComplemento" [(ngModel)]="formulario.complemento" maxlength="100" class="w-full" />
                        </div>
                        <div>
                            <label for="usuarioBairro" class="mb-2 block text-sm font-medium text-surface-700 dark:text-surface-200">Bairro</label>
                            <input id="usuarioBairro" pInputText name="usuarioBairro" [(ngModel)]="formulario.bairro" maxlength="100" class="w-full" required />
                        </div>
                        <div>
                            <label for="usuarioCidade" class="mb-2 block text-sm font-medium text-surface-700 dark:text-surface-200">Cidade</label>
                            <input id="usuarioCidade" pInputText name="usuarioCidade" [(ngModel)]="formulario.cidade" maxlength="100" class="w-full" required />
                        </div>
                        <div>
                            <label for="usuarioUf" class="mb-2 block text-sm font-medium text-surface-700 dark:text-surface-200">UF</label>
                            <p-select id="usuarioUf" name="usuarioUf" [(ngModel)]="formulario.uf" [options]="ufs" optionLabel="label" optionValue="value" placeholder="Selecione" styleClass="w-full" [required]="true"></p-select>
                        </div>
                    </div>
                </section>

                <div class="flex flex-col-reverse gap-3 border-t border-surface-200 pt-6 dark:border-surface-800 sm:flex-row sm:justify-end">
                    <button pButton type="button" label="Cancelar" class="p-button-outlined" (click)="cancelar()" [disabled]="salvando"></button>
                    <button pButton type="submit" label="Salvar" icon="pi pi-save" [loading]="salvando" [disabled]="salvando"></button>
                </div>
            </form>
        </section>
    `
})
export class EditarCadastroComponent implements OnInit {
    private readonly route = inject(ActivatedRoute);
    private readonly router = inject(Router);
    private readonly service = inject(CadastrosAdminService);
    readonly authService = inject(AuthService);

    idUsuario: number | null = null;
    usuario: UsuarioAdminDetalhe | null = null;
    tiposUsuario: TipoUsuarioAdmin[] = [];
    cargos: CargoAdmin[] = [];
    situacoes: SituacaoAdmin[] = [];
    readonly ufs = UFS;
    readonly hoje = new Date();

    formulario: FormularioUsuarioAdmin = this.formularioVazio();
    carregando = true;
    salvando = false;
    erroCarregamento: string | null = null;
    mensagem: string | null = null;
    tipoMensagem: 'success' | 'error' = 'error';

    get editandoProprioUsuario(): boolean {
        return this.idUsuario !== null && this.authService.usuario()?.id_usuario === this.idUsuario;
    }

    get situacoesDisponiveis(): SituacaoAdmin[] {
        if (this.formulario.idTipoUsuario === null) return [];
        return this.situacoes.filter((situacao) => situacao.idTipoUsuario === this.formulario.idTipoUsuario);
    }

    ngOnInit(): void {
        const idUsuario = Number(this.route.snapshot.paramMap.get('id'));
        if (!Number.isInteger(idUsuario) || idUsuario <= 0) {
            this.carregando = false;
            this.erroCarregamento = 'O identificador do usuário é inválido.';
            return;
        }
        this.idUsuario = idUsuario;
        void this.carregar();
    }

    alterarTipo(idTipoUsuario: number | null): void {
        if (this.editandoProprioUsuario) return;
        this.formulario.idTipoUsuario = idTipoUsuario;
        this.formulario.idSituacao = null;
    }

    async salvar(): Promise<void> {
        if (this.salvando || this.idUsuario === null || !this.usuario) return;

        const erro = this.validarFormulario();
        if (erro) {
            this.tipoMensagem = 'error';
            this.mensagem = erro;
            return;
        }

        const payload: UsuarioAdminAtualizacaoPayload = {
            nome: this.formulario.nome.trim(),
            cpf: this.formulario.cpf,
            identidade: this.formulario.identidade.trim() || null,
            dataNascimento: this.formatarDataIso(this.formulario.dataNascimento),
            idTipoUsuario: this.formulario.idTipoUsuario!,
            idCargo: this.formulario.idCargo,
            idSituacao: this.formulario.idSituacao!,
            telefoneCelular: this.formulario.telefoneCelular,
            logradouro: this.formulario.logradouro.trim(),
            numero: this.formulario.numero.trim(),
            complemento: this.formulario.complemento.trim(),
            bairro: this.formulario.bairro.trim(),
            cidade: this.formulario.cidade.trim(),
            uf: this.formulario.uf,
            cep: this.formulario.cep
        };

        this.salvando = true;
        this.mensagem = null;
        try {
            const resposta = await this.service.atualizarUsuario(this.idUsuario, payload);
            this.usuario = resposta.usuario;
            if (this.editandoProprioUsuario) {
                this.authService.atualizarNomeUsuarioLogado(resposta.usuario.nome);
            }
            this.tipoMensagem = 'success';
            this.mensagem = 'Usuário atualizado com sucesso.';
            await new Promise((resolve) => setTimeout(resolve, 700));
            await this.router.navigate(['/admin/cadastros/listar']);
        } catch (error) {
            this.tipoMensagem = 'error';
            this.mensagem = this.mensagemErroSalvar(error);
        } finally {
            this.salvando = false;
        }
    }

    async cancelar(): Promise<void> {
        await this.router.navigate(['/admin/cadastros/listar']);
    }

    private async carregar(): Promise<void> {
        if (this.idUsuario === null) return;
        this.carregando = true;
        this.erroCarregamento = null;

        try {
            const [detalhe, opcoes] = await Promise.all([
                this.service.obterUsuario(this.idUsuario),
                this.service.listarOpcoes()
            ]);
            this.usuario = detalhe.usuario;
            this.tiposUsuario = opcoes.tiposUsuario;
            this.cargos = opcoes.cargos;
            this.situacoes = opcoes.situacoes;
            this.formulario = {
                nome: detalhe.usuario.nome || '',
                cpf: detalhe.usuario.cpf || '',
                identidade: detalhe.usuario.identidade || '',
                dataNascimento: this.criarData(detalhe.usuario.dataNascimento),
                idTipoUsuario: detalhe.usuario.idTipoUsuario,
                idCargo: detalhe.usuario.idCargo,
                idSituacao: detalhe.usuario.idSituacao,
                telefoneCelular: detalhe.usuario.telefoneCelular || '',
                logradouro: detalhe.usuario.logradouro || '',
                numero: detalhe.usuario.numero || '',
                complemento: detalhe.usuario.complemento || '',
                bairro: detalhe.usuario.bairro || '',
                cidade: detalhe.usuario.cidade || '',
                uf: detalhe.usuario.uf || '',
                cep: detalhe.usuario.cep || ''
            };
        } catch (error) {
            if (error instanceof CadastrosAdminServiceError && error.status === 404) {
                this.erroCarregamento = 'Usuário não encontrado.';
            } else {
                this.erroCarregamento = 'Não foi possível carregar o usuário e as opções do formulário.';
            }
        } finally {
            this.carregando = false;
        }
    }

    private validarFormulario(): string | null {
        const dados = this.formulario;
        if (!dados.nome.trim() || !dados.dataNascimento
            || dados.idTipoUsuario === null || dados.idSituacao === null
            || !dados.telefoneCelular.trim() || !dados.logradouro.trim() || !dados.numero.trim()
            || !dados.bairro.trim() || !dados.cidade.trim() || !dados.uf || !dados.cep.trim()) {
            return 'Preencha todos os campos obrigatórios.';
        }
        if (dados.cpf.replace(/\D/g, '').length !== 11) return 'Informe um CPF válido.';
        const telefone = dados.telefoneCelular.replace(/\D/g, '');
        if (telefone.length !== 10 && telefone.length !== 11) return 'Informe um telefone celular válido.';
        if (dados.dataNascimento > this.hoje) return 'A data de nascimento não pode estar no futuro.';
        if (!/^[A-Z]{2}$/.test(dados.uf)) return 'Informe uma UF válida.';
        if (dados.cep.replace(/\D/g, '').length !== 8) return 'Informe um CEP válido.';
        if (!this.situacoesDisponiveis.some((situacao) => situacao.idSituacao === dados.idSituacao)) {
            return 'Selecione uma situação compatível com o tipo de usuário.';
        }
        return null;
    }

    private formatarDataIso(data: Date | null): string {
        if (!data) return '';
        const ano = data.getFullYear();
        const mes = String(data.getMonth() + 1).padStart(2, '0');
        const dia = String(data.getDate()).padStart(2, '0');
        return `${ano}-${mes}-${dia}`;
    }

    private criarData(valor: string | null): Date | null {
        const iso = String(valor || '').slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
        const data = new Date(`${iso}T00:00:00`);
        return Number.isNaN(data.getTime()) ? null : data;
    }

    private mensagemErroSalvar(error: unknown): string {
        if (!(error instanceof CadastrosAdminServiceError)) {
            return 'Não foi possível salvar o usuário. Tente novamente.';
        }
        if (error.status === 400) return error.message || 'Verifique os dados informados.';
        if (error.status === 403) return 'Esta alteração não é permitida para o usuário selecionado.';
        if (error.status === 404) return error.message || 'Usuário ou referência não encontrada.';
        if (error.status === 409) return 'O CPF informado já está sendo utilizado por outro usuário.';
        return 'Não foi possível salvar o usuário. Tente novamente.';
    }

    private formularioVazio(): FormularioUsuarioAdmin {
        return {
            nome: '',
            cpf: '',
            identidade: '',
            dataNascimento: null,
            idTipoUsuario: null,
            idCargo: null,
            idSituacao: null,
            telefoneCelular: '',
            logradouro: '',
            numero: '',
            complemento: '',
            bairro: '',
            cidade: '',
            uf: '',
            cep: ''
        };
    }
}
