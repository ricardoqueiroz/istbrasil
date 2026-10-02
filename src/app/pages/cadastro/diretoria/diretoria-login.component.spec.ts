import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { DiretoriaLoginComponent } from './diretoria-login.component';

describe('DiretoriaLoginComponent', () => {
  let component: DiretoriaLoginComponent;
  let fixture: ComponentFixture<DiretoriaLoginComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [DiretoriaLoginComponent],
      providers: [provideRouter([])]
    }).compileComponents();

    fixture = TestBed.createComponent(DiretoriaLoginComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('should validate required fields before login', () => {
    component.email = '';
    component.password = '';

    const result = component.validarCampos();

    expect(result).toBeFalse();
  });

  it('should hash password in sha256 format', async () => {
    const hash = await component.criptografarSenha('123456');

    expect(hash).toBe('8d969eef6ecad3c29a3a629280e686cf0c3f5d5a86aff3ca12020c923adc6c92');
  });

  it('preserva o destino legado de Diretoria sem consultar acessos de jurado', async () => {
    const fetchSpy = spyOn(window, 'fetch').and.resolveTo(new Response(JSON.stringify({
      id_usuario: 10, id_tipo_usuario: 1, nome: 'Diretoria', foto_url: null
    }), { status: 200 }));
    spyOn(component, 'criptografarSenha').and.resolveTo('hash');
    const navigate = spyOn(TestBed.inject(Router), 'navigate').and.resolveTo(true);
    component.email = 'diretoria@example.com';
    component.password = 'senha';
    await component.login();
    expect(navigate).toHaveBeenCalledWith(['/cadastro/diretoria/cadastro']);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.calls.mostRecent().args[0]).toBe('/api/usuarios/login');
    expect(component.tipoMensagem).toBe('success');
  });
});
