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

  it('garante a participação e deixa o diálogo global decidir o envio dos vídeos', async () => {
    const usuario = { id_usuario: 20, id_tipo_usuario: 2, nome: 'Concorrente Teste', foto_url: null };
    const fetchSpy = spyOn(window, 'fetch').and.callFake(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/usuarios/login') {
        return new Response(JSON.stringify(usuario), { status: 200 });
      }
      if (url === '/api/usuarios/concorrente/aderir') {
        return new Response(JSON.stringify({ usuario }), { status: 200 });
      }
      throw new Error(`URL inesperada: ${url}`);
    });
    spyOn(component, 'criptografarSenha').and.resolveTo('hash');
    const navigate = spyOn(TestBed.inject(Router), 'navigate').and.resolveTo(true);
    component.email = 'concorrente@example.com';
    component.password = 'senha';

    await component.login();

    expect(fetchSpy.calls.allArgs().map(([url]) => String(url))).toEqual([
      '/api/usuarios/login',
      '/api/usuarios/concorrente/aderir'
    ]);
    expect(navigate).toHaveBeenCalledOnceWith(['/']);
    expect(TestBed.inject(AuthService).usuario()).toEqual(usuario);
    TestBed.inject(HttpTestingController).verify();
  });

  it('não abre a página de vídeos quando a participação do concorrente não pode ser preparada', async () => {
    const usuario = { id_usuario: 20, id_tipo_usuario: 2, nome: 'Concorrente Teste', foto_url: null };
    spyOn(window, 'fetch').and.callFake(async (input: RequestInfo | URL) => {
      if (String(input) === '/api/usuarios/login') {
        return new Response(JSON.stringify(usuario), { status: 200 });
      }
      return new Response(JSON.stringify({ message: 'Participação indisponível.' }), { status: 409 });
    });
    spyOn(component, 'criptografarSenha').and.resolveTo('hash');
    const navigate = spyOn(TestBed.inject(Router), 'navigate').and.resolveTo(true);
    component.email = 'concorrente@example.com';
    component.password = 'senha';

    await component.login();

    expect(navigate).not.toHaveBeenCalled();
    expect(component.tipoMensagem).toBe('error');
    expect(component.mensagem).toBe('Participação indisponível.');
    TestBed.inject(HttpTestingController).verify();
  });
});
