import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { PerfilResponse } from '../../pages/perfil/models/perfil.model';
import { PerfilService } from '../../pages/perfil/services/perfil.service';
import { AuthService } from '../../shared/auth.service';
import { AppTopbar } from './app.topbar';

describe('AppTopbar', () => {
    let fixture: ComponentFixture<AppTopbar>;
    let component: AppTopbar;
    let authService: AuthService;
    let perfilService: jasmine.SpyObj<PerfilService>;

    const criarPerfil = (linkVideo1: string | null): PerfilResponse => ({
        usuario: {
            idUsuario: 20,
            idTipoUsuario: 2,
            idCargo: null,
            idSituacao: 3,
            nome: 'Concorrente Teste',
            foto: null,
            fotoUrl: null,
            dataNascimento: null,
            cpf: null,
            identidade: null,
            curriculo: null,
            email: 'concorrente@example.com',
            emailConfirmado: false,
            telefoneCelular: null,
            celularConfirmado: false,
            cep: null,
            logradouro: null,
            numero: null,
            complemento: null,
            bairro: null,
            cidade: null,
            uf: null
        },
        concorrente: {
            idEvento: 1,
            idConcorrente: 30,
            idEtapaInscricoes: 1,
            numeroConcorrente: null,
            idObra1: null,
            tituloObra1: null,
            linkVideo1,
            idObra2: null,
            tituloObra2: null,
            linkVideo2: null,
            aceiteRegulamento: false,
            dataCadastro: null
        }
    });

    beforeEach(async () => {
        perfilService = jasmine.createSpyObj<PerfilService>('PerfilService', ['obterPerfil']);
        await TestBed.configureTestingModule({
            imports: [AppTopbar],
            providers: [
                provideRouter([]),
                { provide: PerfilService, useValue: perfilService }
            ]
        }).compileComponents();

        fixture = TestBed.createComponent(AppTopbar);
        component = fixture.componentInstance;
        authService = TestBed.inject(AuthService);
    });

    it('oferece o envio após login de concorrente sem vídeo e mantém a opção no menu', async () => {
        perfilService.obterPerfil.and.resolveTo(criarPerfil(null));
        fixture.detectChanges();

        authService.definirUsuario({ id_usuario: 20, id_tipo_usuario: 2, nome: 'Concorrente Teste', foto_url: null });
        fixture.detectChanges();
        await fixture.whenStable();
        fixture.detectChanges();

        expect(perfilService.obterPerfil).toHaveBeenCalledTimes(1);
        expect(component.dialogoEnvioVideosVisivel).toBeTrue();
        expect(component.itensMenuPerfil.some((item) => item.label === 'Enviar Vídeos')).toBeTrue();
    });

    it('não oferece novamente o envio quando o vídeo obrigatório já existe', async () => {
        perfilService.obterPerfil.and.resolveTo(criarPerfil('https://youtu.be/abcdefghijk'));
        fixture.detectChanges();

        authService.definirUsuario({ id_usuario: 20, id_tipo_usuario: 2, nome: 'Concorrente Teste', foto_url: null });
        fixture.detectChanges();
        await fixture.whenStable();

        expect(component.dialogoEnvioVideosVisivel).toBeFalse();
    });

    it('não consulta participação para usuário que não é concorrente', async () => {
        fixture.detectChanges();

        authService.definirUsuario({ id_usuario: 21, id_tipo_usuario: 3, nome: 'Usuário Externo', foto_url: null });
        fixture.detectChanges();
        await fixture.whenStable();

        expect(perfilService.obterPerfil).not.toHaveBeenCalled();
        expect(component.dialogoEnvioVideosVisivel).toBeFalse();
        expect(component.itensMenuPerfil.some((item) => item.label === 'Enviar Vídeos')).toBeFalse();
    });

    it('redireciona para os vídeos somente quando o concorrente escolhe Sim', async () => {
        const navigate = spyOn(TestBed.inject(Router), 'navigate').and.resolveTo(true);
        component.dialogoEnvioVideosVisivel = true;

        await component.enviarVideosAgora();

        expect(component.dialogoEnvioVideosVisivel).toBeFalse();
        expect(navigate).toHaveBeenCalledOnceWith(['/cadastro/concorrente/videos']);
    });

    it('fecha o aviso sem navegar quando o concorrente escolhe Enviar mais tarde', () => {
        const navigate = spyOn(TestBed.inject(Router), 'navigate').and.resolveTo(true);
        authService.definirUsuario({ id_usuario: 20, id_tipo_usuario: 2, nome: 'Concorrente Teste', foto_url: null });
        component.dialogoEnvioVideosVisivel = true;

        component.adiarEnvioVideos();

        expect(component.dialogoEnvioVideosVisivel).toBeFalse();
        expect(authService.avisoEnvioVideosFoiAdiado(20)).toBeTrue();
        expect(navigate).not.toHaveBeenCalled();
    });
});
