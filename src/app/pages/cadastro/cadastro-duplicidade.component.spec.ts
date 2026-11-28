import { TestBed } from '@angular/core/testing';
import { CadastroComponent } from './cadastro.component';
import { CadastroStateService } from './services/cadastro-state.service';

describe('CadastroComponent: duplicidade no cadastro', () => {
    let component: CadastroComponent;
    let navigate: jasmine.Spy;

    beforeEach(() => {
        const state = new CadastroStateService();
        state.setTipo('externo');
        state.atualizarDadosPessoais({ dataNascimento: '2000-01-01' });
        navigate = jasmine.createSpy('navigate');
        component = TestBed.runInInjectionContext(() => new CadastroComponent(
            { navigate } as never, {} as never, {} as never, state, {} as never, {} as never, {} as never
        ));
        component.nome = 'Pessoa';
        component.email = component.confirmarEmail = 'pessoa@example.org';
        component.cpf = '12345678901';
        component.telefoneCelular = '11999999999';
        component.senha = component.confirmarSenha = 'senha123';
        component.cep = '01001000';
        component.logradouro = 'Rua'; component.numero = '1'; component.bairro = 'Centro';
        component.cidade = 'Cidade'; component.uf = 'SP';
        component.dataNascimentoSelecionada = new Date(2000, 0, 1);
    });

    it('exibe mensagem do CPF no 409 sem concluir ou redirecionar', async () => {
        spyOn(window, 'fetch').and.resolveTo({ ok: false, status: 409,
            json: async () => ({ message: 'Este CPF já está cadastrado.' }) } as Response);
        await component.finalizarCadastro();
        expect(component.tipoMensagem).toBe('error');
        expect(component.mensagem).toBe('Este CPF já está cadastrado.');
        expect(component.cadastroBasicoConcluido).toBeFalse();
        expect(component.step).toBe(1);
        expect(component.isLoading).toBeFalse();
        expect(navigate).not.toHaveBeenCalled();
    });

    it('mantém a resposta neutra recebida para e-mail duplicado', async () => {
        const neutra = 'Se for possível concluir o cadastro, enviaremos as instruções para o e-mail informado.';
        spyOn(window, 'fetch').and.resolveTo({ ok: true, status: 200, json: async () => ({ message: neutra }) } as Response);
        spyOn(window, 'setTimeout');
        await component.finalizarCadastro();
        expect(component.mensagem).toBe(neutra);
        expect(component.tipoMensagem).toBe('info');
        expect(component.cadastroBasicoConcluido).toBeTrue();
    });
});
