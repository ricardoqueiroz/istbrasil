import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { ProjetosComponent } from './projetos.component';
import { ProjetoDetalheComponent } from './projeto-detalhe/projeto-detalhe.component';
import { AppTopbar } from 'src/app/layout/component/app.topbar';
import { FooterWidget } from 'src/app/shared/footer';
import { Projeto } from 'src/app/models/projeto.model';
import { documentoSeguro, imagemSegura } from './projeto-apresentacao';

@Component({ selector: 'app-topbar', template: '', inputs: ['showMenuButton'] })
class TopbarStub {}
@Component({ selector: 'footer-widget', template: '' })
class FooterStub {}

describe('Projetos públicos', () => {
    const projeto: Projeto = { id: 1, id_tipicidade: 9, id_tipologia: 65,
        tipicidade: 'Projetos Especiais', tipologia: 'Museus', slug: 'novo_museu_em_santarem',
        nome: 'Museu', status: 'Em Planejamento', resumo: 'Apresentação', destaque: false };
    let http: HttpTestingController;
    beforeEach(async () => {
        await TestBed.configureTestingModule({ imports: [ProjetosComponent, ProjetoDetalheComponent],
            providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting(),
                { provide: ActivatedRoute, useValue: { paramMap: of(convertToParamMap({ slug: projeto.slug })) } }]
        }).overrideComponent(ProjetosComponent, {
            remove: { imports: [AppTopbar, FooterWidget] }, add: { imports: [TopbarStub, FooterStub] }
        }).overrideComponent(ProjetoDetalheComponent, {
            remove: { imports: [AppTopbar, FooterWidget] }, add: { imports: [TopbarStub, FooterStub] }
        }).compileComponents();
        http = TestBed.inject(HttpTestingController);
    });
    afterEach(() => http.verify());
    it('distingue carregamento, erro, nova tentativa e lista vazia', () => {
        const fixture = TestBed.createComponent(ProjetosComponent);
        fixture.detectChanges();
        expect(fixture.nativeElement.querySelectorAll('p-skeleton').length).toBe(30);
        http.expectOne(req => req.url.endsWith('/projetos')).flush({}, { status: 500, statusText: 'Erro' });
        fixture.detectChanges();
        expect(fixture.nativeElement.querySelector('[role="alert"]')).not.toBeNull();
        fixture.componentInstance.carregarProjetos();
        http.expectOne(req => req.url.endsWith('/projetos')).flush([]);
        fixture.detectChanges();
        expect(fixture.nativeElement.textContent).toContain('Nenhum projeto encontrado');
        expect(fixture.nativeElement.querySelector('[role="alert"]')).toBeNull();
    });
    it('cards usam links nativos e não inventam mecanismo', () => {
        const fixture = TestBed.createComponent(ProjetosComponent);
        fixture.detectChanges();
        http.expectOne(req => req.url.endsWith('/projetos')).flush([projeto]);
        fixture.detectChanges();
        expect(fixture.nativeElement.querySelector('a[href="/projetos/novo_museu_em_santarem"]')).not.toBeNull();
        expect(fixture.nativeElement.textContent).not.toContain('Lei Rouanet');
    });
    it('detalhe sanitiza HTML e oculta CTA inseguro e dados ausentes', () => {
        const fixture = TestBed.createComponent(ProjetoDetalheComponent);
        fixture.detectChanges();
        http.expectOne(req => req.url.endsWith('/projetos/' + projeto.slug)).flush({ ...projeto,
            descricao_completa: '<p>Descrição <img src="x" onerror="alert(1)"></p>',
            link_cta: 'javascript:alert(1)', documentos: [] });
        fixture.detectChanges();
        expect(fixture.nativeElement.querySelector('.descricao').innerHTML).not.toContain('onerror');
        expect(fixture.componentInstance.cta).toBeNull();
        expect(fixture.nativeElement.textContent).not.toContain('Documentos');
    });
    it('detalhe diferencia 404 de falha de comunicação', () => {
        const fixture = TestBed.createComponent(ProjetoDetalheComponent);
        fixture.detectChanges();
        http.expectOne(req => req.url.endsWith('/projetos/' + projeto.slug)).flush({}, { status: 404, statusText: 'Ausente' });
        fixture.detectChanges();
        expect(fixture.componentInstance.naoEncontrado).toBeTrue();
        fixture.componentInstance.carregar();
        http.expectOne(req => req.url.endsWith('/projetos/' + projeto.slug)).flush({}, { status: 500, statusText: 'Erro' });
        fixture.detectChanges();
        expect(fixture.componentInstance.erro).toBeTrue();
        expect(fixture.componentInstance.naoEncontrado).toBeFalse();
    });
    it('rejeita URLs perigosas e aceita documentos com acentos', () => {
        expect(documentoSeguro('javascript:alert(1)')).toBeNull();
        expect(documentoSeguro('//example.com/arquivo')).toBeNull();
        expect(documentoSeguro('/uploads/documentos/Santarém.pdf')).toContain('Santar%C3%A9m.pdf');
        expect(imagemSegura('data:text/html,test')).toBe('/assets/images/eventos/default-event.jpg');
    });
    it('renderiza etiquetas e todos os documentos com URL dinâmica e nome acessível', () => {
        const fixture = TestBed.createComponent(ProjetoDetalheComponent);
        fixture.detectChanges();
        const caminho = '/istbrasil.private/projetos/Novo_Museu_de_Santarém.pdf';
        http.expectOne(req => req.url.endsWith('/projetos/' + projeto.slug)).flush({ ...projeto,
            tipologia: 'Construção, restauração e reforma de museus',
            descricao_completa: '<p>Como participar?</p>', documentos: [
                { id: 1, projeto_id: 1, titulo: 'Apresentação do Projeto', arquivo_url: caminho, formato: 'PDF', tamanho: '1.2 MB', ordem: 1 },
                { id: 2, projeto_id: 1, titulo: 'Outro documento', arquivo_url: '/documentos/outro.pdf', formato: 'PDF', ordem: 2 }
            ] });
        fixture.detectChanges();
        const etiquetas = fixture.nativeElement.querySelectorAll('.projeto-etiqueta');
        expect(etiquetas.length).toBe(2);
        expect(etiquetas[1].textContent).toContain('Construção, restauração e reforma de museus');
        expect(fixture.nativeElement.querySelector('.projeto-classificacoes').textContent).not.toContain('?');
        const documentos = fixture.nativeElement.querySelectorAll('a.projeto-documento');
        expect(documentos.length).toBe(2);
        expect(documentos[0].getAttribute('href')).toBe(encodeURI(caminho));
        expect(documentos[0].target).toBe('_blank');
        expect(documentos[0].getAttribute('rel')).toBe('noopener noreferrer');
        expect(documentos[0].getAttribute('aria-label')).toContain('abre em nova aba');
        expect(documentos[0].textContent).not.toContain('abre em nova aba');
        expect(documentos[0].querySelector('.projeto-documento-meta').textContent).not.toContain('?');
        expect(fixture.nativeElement.querySelector('.descricao').textContent).toContain('Como participar?');
        expect(fixture.nativeElement.querySelector('.projeto-informacoes')).toBeNull();
    });
});
