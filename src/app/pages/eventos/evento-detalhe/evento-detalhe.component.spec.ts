import { Component } from '@angular/core';
import { TestBed, ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting, HttpTestingController } from '@angular/common/http/testing';
import { ActivatedRoute, RouterLink, convertToParamMap, provideRouter } from '@angular/router';
import { By } from '@angular/platform-browser';
import { of, BehaviorSubject } from 'rxjs';
import { AuthService } from 'src/app/shared/auth.service';
import { PerfilService } from '../../perfil/services/perfil.service';
import { PerfilResponse } from '../../perfil/models/perfil.model';
import { FESTIVAL_II_SLUG } from './evento-cta-contextual';
import { AppTopbar } from 'src/app/layout/component/app.topbar';
import { FooterWidget } from 'src/app/shared/footer';
import { Evento } from 'src/app/models/evento.model';
import { EventoDetalheComponent } from './evento-detalhe.component';

@Component({ selector: 'app-topbar', standalone: true, template: '', inputs: ['showMenuButton'] })
class TopbarStub {}
@Component({ selector: 'footer-widget', standalone: true, template: '' })
class FooterStub {}

describe('EventoDetalheComponent CTA e regressão do card', () => {
    let fixture: ComponentFixture<EventoDetalheComponent>;
    let http: HttpTestingController;
    const base: Evento = {
        id: 1, slug: 'teste', nome: 'Evento', categoria: 'Festival', status: 'Em_Andamento',
        modalidade: 'Virtual', resumo: 'Resumo', destaque: false, valor_inscricao: 'Gratuito',
        data_inicio: '2026-11-13', data_fim: '2026-11-14', local_nome: 'Local geral',
        endereco: 'Endereço geral', cidade: 'Santarém', estado: 'PA',
        etapas: [{ id: 1, evento_id: 1, titulo: 'Inscrições Virtuais', status: 'Pendente', ordem: 1,
            data_inicio: '2026-10-15 00:00:00', cta_etapa_pendente: 'Inscrições em breve', link_etapa_pendente: null }]
    };
    beforeEach(async () => {
        await TestBed.configureTestingModule({ imports: [EventoDetalheComponent], providers: [
            provideRouter([]), provideHttpClient(), provideHttpClientTesting(),
            { provide: ActivatedRoute, useValue: { paramMap: of(convertToParamMap({ slug: 'teste' })) } }
        ] }).overrideComponent(EventoDetalheComponent, {
            remove: { imports: [AppTopbar, FooterWidget] }, add: { imports: [TopbarStub, FooterStub] }
        }).compileComponents();
        http = TestBed.inject(HttpTestingController);
        fixture = TestBed.createComponent(EventoDetalheComponent);
    });
    afterEach(() => http.verify());
    function carregar(evento: Evento = base) {
        fixture.detectChanges();
        http.expectOne(req => req.url.endsWith('/eventos/teste')).flush(evento);
        fixture.detectChanges();
    }
    it('informativo não é âncora e preserva texto e contagem', () => {
        jasmine.clock().withMock(() => {
            // 07/10/2026 às 12h em America/Santarem; inclui o efeito do componente.
            jasmine.clock().mockDate(new Date('2026-10-07T15:00:00Z'));
            carregar();
            const info = fixture.nativeElement.querySelector('[data-testid="cta-informativo"]');
            expect(info.tagName).toBe('P'); expect(info.textContent).toContain('Inscrições em breve');
            expect(fixture.nativeElement.querySelector('[data-testid="cta-contagem"]').textContent).toContain('Faltam 8 dias');
            expect(fixture.nativeElement.querySelector('[data-testid="cta-acao"]')).toBeNull();
        });
    });
    it('ação interna usa RouterLink', () => {
        carregar({ ...base, etapas: [{ ...base.etapas![0], link_etapa_pendente: '/cadastro/concorrente' }] });
        const a = fixture.debugElement.query(By.css('[data-testid="cta-acao"]'));
        expect(a.injector.get(RouterLink).urlTree).not.toBeNull();
        expect(a.nativeElement.getAttribute('href')).toBe('/cadastro/concorrente');
        expect(a.nativeElement.hasAttribute('target')).toBeFalse();
    });
    it('ação externa usa href e atributos seguros', () => {
        carregar({ ...base, etapas: [{ ...base.etapas![0], link_etapa_pendente: 'https://example.com' }] });
        const a = fixture.nativeElement.querySelector('[data-testid="cta-acao"]');
        expect(a.getAttribute('href')).toBe('https://example.com'); expect(a.target).toBe('_blank');
        expect(a.getAttribute('rel')).toBe('noopener noreferrer');
    });
    it('CTA vazio não gera ação, informação ou href=# nem recorre ao legado', () => {
        carregar({ ...base, texto_cta: 'Legado', link_cta: '/legado', etapas: [{ ...base.etapas![0], cta_etapa_pendente: null }] });
        expect(fixture.nativeElement.querySelector('[data-testid="cta-acao"]')).toBeNull();
        expect(fixture.nativeElement.querySelector('[data-testid="cta-informativo"]')).toBeNull();
        expect(fixture.nativeElement.querySelector('a[href="#"]')).toBeNull();
    });
    it('mostra título/status e mantém período, local e modalidade gerais e timeline original', () => {
        carregar();
        const el = fixture.nativeElement;
        expect(el.querySelector('[data-testid="cta-etapa"]').textContent).toContain('Inscrições Virtuais · Pendente');
        const card = el.querySelector('aside').textContent;
        for (const text of ['13/11/2026', '14/11/2026', 'Local geral', 'Endereço geral', 'Santarém/PA', 'Virtual', 'Realização Oficial']) expect(card).toContain(text);
        const timeline = fixture.debugElement.query(By.css('p-timeline'));
        expect(timeline.componentInstance.value).toBe(fixture.componentInstance.evento!.etapas);
    });
    it('resolve o CTA após receber o evento', () => {
        fixture.detectChanges();
        http.expectOne(req => req.url.endsWith('/eventos/teste')).flush(base);
        expect(fixture.componentInstance.cta?.estado).toBe('informativo');
        expect(fixture.componentInstance.isInternalLink('//example.com')).toBeFalse();
    });
});

describe('EventoDetalheComponent contexto assíncrono', () => {
    let fixture: ComponentFixture<EventoDetalheComponent>;
    let http: HttpTestingController;
    let auth: AuthService;
    let obterPerfil: jasmine.Spy;
    let rota: BehaviorSubject<ReturnType<typeof convertToParamMap>>;
    let respostas: { resolve: (perfil: PerfilResponse) => void; reject: (erro: Error) => void }[];
    const evento: Evento = { id: 1, slug: FESTIVAL_II_SLUG, nome: 'Festival', categoria: 'Festival',
        status: 'Em_Andamento', modalidade: 'Virtual', resumo: '', destaque: false,
        etapas: [{ id: 1, evento_id: 1, titulo: 'Inscrições Virtuais', ordem: 1, status: 'Em_Andamento',
            cta_etapa_andamento: 'Inscreva-se', link_etapa_andamento: '/cadastro/concorrente' }] };
    const perfil = (idUsuario = 7, idEvento = 1): PerfilResponse => ({
        usuario: { idUsuario, idTipoUsuario: 2 }, concorrente: { idEvento, idConcorrente: 17, idEtapaInscricoes: 1 }
    } as PerfilResponse);
    function usuario(id = 7, tipo = 2) {
        auth.definirUsuario({ id_usuario: id, id_tipo_usuario: tipo, nome: 'Usuário', foto_url: null });
        auth.carregando.set(false);
    }
    function atualizar() { fixture.detectChanges(); TestBed.tick(); fixture.detectChanges(); }
    function carregar(dados = evento) {
        atualizar(); http.expectOne(req => req.url.endsWith(`/eventos/${FESTIVAL_II_SLUG}`)).flush(dados); atualizar();
    }
    async function responder(indice = 0, dados = perfil()) { respostas[indice].resolve(dados); await Promise.resolve(); await Promise.resolve(); atualizar(); }
    beforeEach(async () => {
        respostas = [];
        rota = new BehaviorSubject(convertToParamMap({ slug: FESTIVAL_II_SLUG }));
        obterPerfil = jasmine.createSpy('obterPerfil').and.callFake(() => new Promise<PerfilResponse>((resolve, reject) => respostas.push({ resolve, reject })));
        await TestBed.configureTestingModule({ imports: [EventoDetalheComponent], providers: [
            provideRouter([]), provideHttpClient(), provideHttpClientTesting(),
            { provide: PerfilService, useValue: { obterPerfil } },
            { provide: ActivatedRoute, useValue: { paramMap: rota } }
        ] }).overrideComponent(EventoDetalheComponent, {
            remove: { imports: [AppTopbar, FooterWidget] }, add: { imports: [TopbarStub, FooterStub] }
        }).compileComponents();
        auth = TestBed.inject(AuthService); http = TestBed.inject(HttpTestingController);
        fixture = TestBed.createComponent(EventoDetalheComponent);
    });
    afterEach(() => http.verify());
    it('sessão carregando mantém padrão sem buscar perfil; restauração personaliza', async () => {
        carregar(); expect(obterPerfil).not.toHaveBeenCalled(); expect(fixture.componentInstance.cta?.texto).toBe('Inscreva-se');
        usuario(); atualizar(); expect(obterPerfil).toHaveBeenCalledTimes(1);
        expect(fixture.componentInstance.cta?.texto).toBe('Inscreva-se');
        await responder(); expect(fixture.componentInstance.cta?.texto).toBe('Enviar seu vídeo');
    });
    it('visitante e externo não buscam perfil', () => {
        auth.carregando.set(false); carregar(); expect(obterPerfil).not.toHaveBeenCalled();
        usuario(7, 3); atualizar(); expect(obterPerfil).not.toHaveBeenCalled();
    });
    it('login personaliza com rota interna e preserva título/status', async () => {
        auth.carregando.set(false); carregar(); usuario(); atualizar(); await responder();
        const a = fixture.debugElement.query(By.css('[data-testid="cta-acao"]'));
        expect(a.nativeElement.textContent).toContain('Enviar seu vídeo');
        expect(a.nativeElement.getAttribute('href')).toBe('/cadastro/concorrente/videos');
        expect(a.injector.get(RouterLink).urlTree).not.toBeNull();
        expect(fixture.nativeElement.querySelector('[data-testid="cta-etapa"]').textContent).toContain('Inscrições Virtuais · Em andamento');
    });
    it('logout restaura padrão e resposta tardia não personaliza', async () => {
        usuario(); carregar(); auth.usuario.set(null); atualizar(); await responder();
        expect(fixture.componentInstance.cta?.texto).toBe('Inscreva-se');
    });
    it('logout após personalização restaura padrão', async () => {
        usuario(); carregar(); await responder(); auth.usuario.set(null); atualizar();
        expect(fixture.componentInstance.cta?.texto).toBe('Inscreva-se');
    });
    it('troca de usuário descarta perfil antigo e evita chamada por mudança só de nome', async () => {
        usuario(); carregar(); usuario(8); atualizar();
        expect(obterPerfil).toHaveBeenCalledTimes(2); await responder(0, perfil(7));
        expect(fixture.componentInstance.cta?.texto).toBe('Inscreva-se'); await responder(1, perfil(8));
        expect(fixture.componentInstance.cta?.texto).toBe('Enviar seu vídeo');
        auth.atualizarNomeUsuarioLogado('Novo nome'); atualizar(); expect(obterPerfil).toHaveBeenCalledTimes(2);
    });
    it('falha de perfil mantém padrão', async () => {
        usuario(); carregar(); respostas[0].reject(new Error('falha')); await Promise.resolve(); await Promise.resolve(); atualizar();
        expect(fixture.componentInstance.cta?.texto).toBe('Inscreva-se');
    });
    it('participação de outro evento não personaliza', async () => {
        usuario(); carregar(); await responder(0, perfil(7, 2)); expect(fixture.componentInstance.cta?.texto).toBe('Inscreva-se');
    });
    it('navegação descarta perfil anterior sem buscar perfil de outro festival', async () => {
        usuario(); carregar(); rota.next(convertToParamMap({ slug: 'outro' })); atualizar();
        http.expectOne(req => req.url.endsWith('/eventos/outro')).flush({ ...evento, id: 2, slug: 'outro', etapas: [] }); atualizar();
        await responder(); expect(fixture.componentInstance.cta?.texto).not.toBe('Enviar seu vídeo');
        expect(obterPerfil).toHaveBeenCalledTimes(1);
    });
    it('navegação cancela carregamento antigo do evento', () => {
        atualizar(); const antiga = http.expectOne(req => req.url.endsWith(`/eventos/${FESTIVAL_II_SLUG}`));
        rota.next(convertToParamMap({ slug: 'outro' })); atualizar(); expect(antiga.cancelled).toBeTrue();
        http.expectOne(req => req.url.endsWith('/eventos/outro')).flush({ ...evento, slug: 'outro' }); atualizar();
        expect(fixture.componentInstance.evento?.slug).toBe('outro');
    });
    it('destruição descarta perfil pendente', async () => {
        usuario(); carregar(); const antes = fixture.componentInstance.cta;
        fixture.destroy(); respostas[0].resolve(perfil()); await Promise.resolve(); await Promise.resolve();
        expect(fixture.componentInstance.cta).toBe(antes);
    });
    for (const status of ['Pendente', 'Concluido'] as const) it(`${status} não carrega perfil`, () => {
        usuario(); carregar({ ...evento, etapas: [{ ...evento.etapas![0], status }] }); expect(obterPerfil).not.toHaveBeenCalled();
    });
});
