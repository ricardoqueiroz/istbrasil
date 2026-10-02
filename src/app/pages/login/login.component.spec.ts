import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Router, provideRouter } from '@angular/router';
import { AuthService } from '../../shared/auth.service';
import { LoginComponent } from './login.component';

describe('LoginComponent', () => {
  let component: LoginComponent;
  let fixture: ComponentFixture<LoginComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [LoginComponent], 
      providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()]
    }).compileComponents();

    fixture = TestBed.createComponent(LoginComponent);
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

  for (const falha of [false, true]) {
    it(`preserva login bem-sucedido com ${falha ? 'falha nos acessos' : 'evento autorizado'}`, async () => {
      const usuario = { id_usuario: 10, id_tipo_usuario: 3, nome: 'Jurado Teste', foto_url: null };
      spyOn(window, 'fetch').and.resolveTo(new Response(JSON.stringify(usuario), { status: 200 }));
      spyOn(component, 'criptografarSenha').and.resolveTo('hash');
      const navigate = spyOn(TestBed.inject(Router), 'navigate').and.resolveTo(true);
      component.email = 'jurado@example.com';
      component.password = 'senha';
      const login = component.login();
      await Promise.resolve();
      await Promise.resolve();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      const http = TestBed.inject(HttpTestingController);
      const request = http.expectOne('/api/jurado/acessos');
      if (falha) {
        request.flush({}, { status: 500, statusText: 'Erro' });
      } else {
        request.flush({ eventos: [{ id: 17, slug: 'evento-teste', nome: 'Evento Teste' }] });
      }
      await login;
      expect(navigate).toHaveBeenCalledWith(falha ? ['/'] : ['/jurado', 'evento-teste', 'avaliacoes']);
      expect(TestBed.inject(AuthService).usuario()).toEqual(usuario);
      expect(component.tipoMensagem).toBe('success');
      expect(component.isLoading).toBeFalse();
      http.verify();
    });
  }
});
