import { ConcorrenteVideosComponent } from './concorrente-videos.component';
import { PerfilService, PerfilServiceError } from '../../../perfil/services/perfil.service';

describe('ConcorrenteVideosComponent', () => {
    const perfil = {
        usuario: {
            idUsuario: 20,
            idTipoUsuario: 2,
            idCargo: null,
            idSituacao: 3,
            nome: 'Concorrente Teste',
            foto: null,
            fotoUrl: null,
            dataNascimento: '2000-01-01',
            cpf: '00000000000',
            identidade: null,
            curriculo: null,
            email: 'concorrente@example.com',
            emailConfirmado: true,
            telefoneCelular: '00000000000',
            celularConfirmado: false,
            cep: '00000000',
            logradouro: 'Rua Teste',
            numero: '1',
            complemento: null,
            bairro: 'Centro',
            cidade: 'Santarém',
            uf: 'PA'
        },
        concorrente: {
            idEvento: 1,
            idConcorrente: 30,
            idEtapaInscricoes: 1,
            numeroConcorrente: null,
            idObra1: null,
            tituloObra1: null,
            linkVideo1: null,
            idObra2: null,
            tituloObra2: null,
            linkVideo2: null,
            aceiteRegulamento: false,
            dataCadastro: null
        }
    };

    const criarComponente = (service: jasmine.SpyObj<PerfilService>) => new ConcorrenteVideosComponent(
        service,
        { bypassSecurityTrustResourceUrl: (url: string) => url } as never,
        { navigate: jasmine.createSpy('navigate').and.resolveTo(true) } as never
    );

    it('carrega o formulário mesmo quando apenas a lista de obras opcionais falha', async () => {
        const service = jasmine.createSpyObj<PerfilService>('PerfilService', ['obterPerfil', 'carregarObrasParticipacao', 'atualizarParticipacaoConcorrente']);
        service.obterPerfil.and.resolveTo(perfil);
        service.carregarObrasParticipacao.and.rejectWith(new PerfilServiceError('Falha nas obras.', 500));
        const component = criarComponente(service);

        component.ngOnInit();
        await Promise.resolve();
        await Promise.resolve();

        expect(component.carregando).toBeFalse();
        expect(component.usuario?.idUsuario).toBe(20);
        expect(component.tipoMensagem).toBe('warning');
        expect(component.obrasElegiveis).toEqual([]);
        expect(component.mensagem).toContain('lista de obras opcionais');
    });

    it('mantém o formulário fechado e permite nova tentativa quando o perfil falha', async () => {
        const service = jasmine.createSpyObj<PerfilService>('PerfilService', ['obterPerfil', 'carregarObrasParticipacao', 'atualizarParticipacaoConcorrente']);
        service.obterPerfil.and.rejectWith(new PerfilServiceError('Sessão inválida.', 401));
        service.carregarObrasParticipacao.and.resolveTo({
            obraPrincipal: { idObra: 22, titulo: 'Obra obrigatória', partitura: null },
            obrasElegiveis: []
        });
        const component = criarComponente(service);

        component.ngOnInit();
        await Promise.resolve();
        await Promise.resolve();

        expect(component.carregando).toBeFalse();
        expect(component.usuario).toBeNull();
        expect(component.tipoMensagem).toBe('error');
        expect(component.mensagem).toBe('Sessão inválida.');
    });
});
