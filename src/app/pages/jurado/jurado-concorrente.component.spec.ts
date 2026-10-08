import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { DomSanitizer } from '@angular/platform-browser';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { By } from '@angular/platform-browser';
import { ActivatedRoute, Router, UrlTree, convertToParamMap, provideRouter } from '@angular/router';
import { ConfirmationService } from 'primeng/api';
import { InputNumber } from 'primeng/inputnumber';
import { Slider } from 'primeng/slider';
import { BehaviorSubject } from 'rxjs';
import { appRoutes } from '../../../app.routes';
import { juradoGuard } from '../../guards/jurado.guard';
import { AvaliacaoJuradoResponse, ConcorrenteJurado, ConcorrenteJuradoResponse } from '../../shared/jurado.service';
import { JuradoConcorrenteComponent } from './jurado-concorrente.component';

describe('JuradoConcorrenteComponent', () => {
    let http: HttpTestingController;
    let parametros: BehaviorSubject<ReturnType<typeof convertToParamMap>>;
    let trust: jasmine.Spy;
    const evento = { id: 17, slug: 'evento-teste', nome: 'Evento Autorizado' };
    const concorrente: ConcorrenteJurado = {
        idParticipacao: 20, numeroConcorrente: 'FVST2-020', nome: 'Nome do Concorrente', cidade: null, uf: null,
        dataInscricao: '2026-10-02T12:00:00.000Z', obraPrincipal: { id: 22, titulo: 'Obra Principal' },
        linkVideoPrincipal: 'https://youtu.be/abcdefghijk', obraOpcional: null, linkVideoOpcional: null
    };

    beforeEach(() => {
        parametros = new BehaviorSubject(convertToParamMap({ slug: evento.slug, idParticipacao: '20' }));
        TestBed.configureTestingModule({ imports: [JuradoConcorrenteComponent], providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting(), provideNoopAnimations()] });
        TestBed.overrideComponent(JuradoConcorrenteComponent, {
            add: { providers: [{ provide: ActivatedRoute, useValue: { paramMap: parametros.asObservable() } }] }
        });
        http = TestBed.inject(HttpTestingController);
        const sanitizer = TestBed.inject(DomSanitizer);
        const original = sanitizer.bypassSecurityTrustResourceUrl.bind(sanitizer);
        trust = spyOn(sanitizer, 'bypassSecurityTrustResourceUrl').and.callFake(() => original('about:blank'));
    });

    afterEach(() => http.verify());

    function criarPagina(): ComponentFixture<JuradoConcorrenteComponent> {
        const fixture = TestBed.createComponent(JuradoConcorrenteComponent);
        fixture.detectChanges();
        return fixture;
    }

    function dados(campos: Partial<ConcorrenteJurado> = {}): ConcorrenteJuradoResponse {
        return { evento, concorrente: { ...concorrente, ...campos } };
    }

    function avaliacaoPendente(slug = evento.slug, id = 20): AvaliacaoJuradoResponse {
        return {
            evento: slug === evento.slug ? evento : { id: 28, slug, nome: 'Novo Evento' },
            concorrente: { ...concorrente, idSnapshot: 320, idParticipacao: id, numeroConcorrente: `FVST2-${id}` },
            contexto: { idCiclo: 100, numeroCiclo: 1, numeroTentativa: null },
            podeGravar: true,
            autorizacaoGravacao: { estado: 'autorizada', code: null, motivo: null },
            estado: 'pendente', versao: 0, escala: { min: 0, max: 100, passo: 1 },
            criterios: [
                { idCriterio: 112, idCriterioOrigem: 112, idCriterioCiclo: 12, nome: 'Criterio A', descricao: null, ordem: 1, peso: '40.00' },
                { idCriterio: 191, idCriterioOrigem: 191, idCriterioCiclo: 91, nome: 'Criterio B', descricao: null, ordem: 2, peso: '60.00' }
            ],
            avaliacao: null
        };
    }

    function consulta(slug = evento.slug, id = 20, avaliacao: AvaliacaoJuradoResponse | null = avaliacaoPendente(slug, id)) {
        if (avaliacao) http.expectOne(`/api/jurado/eventos/${slug}/concorrentes/${id}/avaliacao`).flush(avaliacao);
        return http.expectOne(`/api/jurado/eventos/${slug}/concorrentes/${id}`);
    }

    function avaliacaoPersistida(estado: 'rascunho' | 'concluida' = 'rascunho', versao = 7): AvaliacaoJuradoResponse {
        return {
            ...avaliacaoPendente(), estado, versao,
            contexto: { idCiclo: 100, numeroCiclo: 1, numeroTentativa: 1 },
            podeGravar: estado === 'rascunho',
            autorizacaoGravacao: estado === 'rascunho'
                ? { estado: 'autorizada', code: null, motivo: null }
                : { estado: 'avaliacao_concluida', code: 'AVALIACAO_CONCLUIDA', motivo: 'AVALIACAO_CONCLUIDA' },
            avaliacao: {
                idAvaliacao: 50,
                notas: [{ idCriterio: 191, idCriterioOrigem: 191, idCriterioCiclo: 91, nota: 80 }, { idCriterio: 112, idCriterioOrigem: 112, idCriterioCiclo: 12, nota: 0 }],
                possivelDesclassificacao: false, motivoDesclassificacao: null, media: '48.00',
                dataInclusao: '2026-10-03T12:00:00.000Z', dataAtualizacao: '2026-10-04T12:00:00.000Z',
                dataConclusao: estado === 'concluida' ? '2026-10-04T12:00:00.000Z' : null
            }
        };
    }

    function paginaComAvaliacao(resposta = avaliacaoPendente()) {
        const fixture = criarPagina();
        consulta(evento.slug, 20, resposta).flush(dados());
        fixture.detectChanges();
        return fixture;
    }

    function consultaGravacao() {
        return http.expectOne((req) => req.method === 'PUT' && req.url === `/api/jurado/eventos/${evento.slug}/concorrentes/20/avaliacao`);
    }

    async function paginaUI(resposta = avaliacaoPendente()) {
        const fixture = paginaComAvaliacao(resposta);
        await fixture.whenStable();
        fixture.detectChanges();
        return fixture;
    }

    function clicarAcao(fixture: ComponentFixture<JuradoConcorrenteComponent>, acao: string) {
        const button = fixture.nativeElement.querySelector(`[data-testid="${acao}"]`) as HTMLButtonElement;
        expect(button).not.toBeNull();
        button.click();
        fixture.detectChanges();
    }

    it('UI mostra loading apenas na avaliacao e mantem o video disponivel', () => {
        const fixture = criarPagina();
        consulta(evento.slug, 20, null).flush(dados());
        fixture.detectChanges();
        expect(fixture.nativeElement.querySelector('[data-testid="loading-avaliacao"]').textContent).toContain('Carregando avalia\u00e7\u00e3o');
        expect(fixture.nativeElement.querySelector('[aria-labelledby="criterios"]').getAttribute('aria-busy')).toBe('true');
        expect(fixture.nativeElement.querySelector('[aria-labelledby="obra-principal"] a')).not.toBeNull();
        expect(fixture.nativeElement.querySelector('form')).toBeNull();
        http.expectOne(`/api/jurado/eventos/${evento.slug}/concorrentes/20/avaliacao`).flush(avaliacaoPendente());
    });

    it('UI renderiza criterios, descricoes e pesos dinamicos com labels e escala recebida', async () => {
        const resposta = avaliacaoPendente();
        resposta.criterios[0].descricao = 'Descricao explicita';
        resposta.criterios[1].descricao = '   ';
        resposta.escala = { min: 10, max: 90, passo: 2 };
        const fixture = await paginaUI(resposta);
        const campos = fixture.debugElement.queryAll(By.directive(InputNumber));
        expect(campos.length).toBe(2);
        const sliders = fixture.debugElement.queryAll(By.directive(Slider));
        expect(sliders.length).toBe(2);
        for (const slider of sliders) {
            const controle = slider.componentInstance as Slider;
            expect(controle.min).toBe(10);
            expect(controle.max).toBe(90);
            expect(controle.step).toBe(2);
            expect(controle.disabled()).toBeTrue();
        }
        expect(fixture.nativeElement.querySelectorAll('[data-testid="criterio-avaliacao"]').length).toBe(2);
        for (const criterio of resposta.criterios) {
            const label = fixture.nativeElement.querySelector(`label[for="nota-${criterio.idCriterioCiclo}"]`);
            expect(label.textContent).toBe(criterio.nome);
            expect(fixture.nativeElement.querySelector(`#nota-${criterio.idCriterioCiclo}`)).not.toBeNull();
            expect(fixture.nativeElement.querySelector(`#peso-${criterio.idCriterioCiclo}`).textContent).toContain(`${criterio.peso}%`);
        }
        expect(fixture.nativeElement.querySelector('#descricao-12').textContent).toBe('Descricao explicita');
        expect(fixture.nativeElement.querySelector('#descricao-91')).toBeNull();
        for (const campo of campos) {
            const controle = campo.componentInstance as InputNumber;
            expect(controle.min()).toBe(10);
            expect(controle.max()).toBe(90);
            expect(controle.step()).toBe(2);
            expect(controle.allowEmpty).toBeTrue();
            expect(controle.useGrouping).toBeFalse();
        }
        expect(fixture.nativeElement.querySelector('#nota-12').getAttribute('aria-describedby')).toContain('descricao-12');
    });

    it('UI apresenta zero e restaura vazio sem transformar ausencia em zero', async () => {
        const fixture = await paginaUI(avaliacaoPersistida());
        const input = fixture.nativeElement.querySelector('#nota-12') as HTMLInputElement;
        expect(input.value).toBe('0');
        const slider = fixture.debugElement.queryAll(By.directive(Slider))[0].componentInstance as Slider;
        expect(slider.value).toBe(0);
        expect(slider.disabled()).toBeFalse();
        input.value = '';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('blur'));
        await fixture.whenStable();
        fixture.detectChanges();
        expect(fixture.componentInstance.notasEditaveis()[12]).toBeNull();
        expect(input.value).toBe('');
        expect(slider.disabled()).toBeTrue();
        http.expectNone((req) => req.method === 'PUT' || req.method === 'POST');
        clicarAcao(fixture, 'salvar-rascunho');
        const request = consultaGravacao();
        expect(request.request.body.notas).toEqual([{ idCriterioCiclo: 91, nota: 80 }]);
        request.flush(avaliacaoPersistida());
    });

    it('Slider vazio permanece desabilitado e oculto da acessibilidade sem atribuir zero', async () => {
        const fixture = await paginaUI();
        for (const elemento of fixture.debugElement.queryAll(By.directive(Slider))) {
            const slider = elemento.componentInstance as Slider;
            expect(slider.disabled()).toBeTrue();
            expect(elemento.nativeElement.getAttribute('aria-hidden')).toBe('true');
            expect(slider.min).toBe(0);
            expect(slider.max).toBe(100);
            expect(slider.step).toBe(1);
        }
        expect(fixture.nativeElement.querySelectorAll('[data-testid="nota-nao-atribuida"]').length).toBe(2);
        expect((fixture.nativeElement.querySelector('#nota-12') as HTMLInputElement).value).toBe('');
        fixture.componentInstance.alterarNotaPeloSlider(12, 0);
        await fixture.whenStable();
        fixture.detectChanges();
        expect(fixture.componentInstance.notasEditaveis()).toEqual({ 12: null, 91: null });
        http.expectNone((req) => req.method !== 'GET');
    });

    it('InputNumber e Slider compartilham nota e limpar nao atribui minimo nem persiste', async () => {
        const fixture = await paginaUI();
        const component = fixture.componentInstance;
        const sliderElement = fixture.debugElement.queryAll(By.directive(Slider))[0];
        const slider = sliderElement.componentInstance as Slider;
        const input = fixture.nativeElement.querySelector('#nota-12') as HTMLInputElement;
        input.value = '72';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('blur'));
        fixture.detectChanges();
        await fixture.whenStable();
        fixture.detectChanges();
        expect(component.notasEditaveis()[12]).toBe(72);
        expect(slider.value).toBe(72);
        expect(slider.disabled()).toBeFalse();
        expect(sliderElement.nativeElement.hasAttribute('aria-hidden')).toBeFalse();
        expect(slider.ariaLabelledBy).toBe('label-nota-12');
        const alterar = spyOn(component, 'alterarNota').and.callThrough();
        const handle = sliderElement.nativeElement.querySelector('[role="slider"]') as HTMLElement;
        handle.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowRight', bubbles: true }));
        fixture.detectChanges();
        await fixture.whenStable();
        fixture.detectChanges();
        expect(alterar).toHaveBeenCalledOnceWith(12, 73);
        expect(component.notasEditaveis()[12]).toBe(73);
        expect(input.value).toBe('73');
        input.value = '';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('blur'));
        fixture.detectChanges();
        await fixture.whenStable();
        fixture.detectChanges();
        expect(component.notasEditaveis()[12]).toBeNull();
        expect(input.value).toBe('');
        expect(slider.disabled()).toBeTrue();
        component.alterarNotaPeloSlider(12, 0);
        expect(component.notasEditaveis()[12]).toBeNull();
        http.expectNone((req) => req.method !== 'GET');
    });

    for (const bloqueio of ['concluida', 'permissao', 'confirmando'] as const) {
        it(`Slider ignora eventos quando bloqueado por ${bloqueio}`, async () => {
            const resposta = avaliacaoPersistida(bloqueio === 'concluida' ? 'concluida' : 'rascunho');
            if (bloqueio === 'permissao') resposta.podeGravar = false;
            const fixture = await paginaUI(resposta);
            const component = fixture.componentInstance;
            if (bloqueio === 'confirmando') expect(component.solicitarConclusao()).toBeTrue();
            fixture.detectChanges();
            const antes = component.notasEditaveis();
            const alterar = spyOn(component, 'alterarNota').and.callThrough();
            for (const elemento of fixture.debugElement.queryAll(By.directive(Slider))) {
                expect((elemento.componentInstance as Slider).disabled()).toBeTrue();
                elemento.triggerEventHandler('ngModelChange', 42);
            }
            expect(alterar).not.toHaveBeenCalled();
            expect(component.notasEditaveis()).toBe(antes);
            if (bloqueio === 'confirmando') expect(component.confirmando).toBeTrue();
            http.expectNone((req) => req.method !== 'GET');
        });
    }

    it('handler do Slider rejeita valores invalidos sem alterar a nota ou persistir', async () => {
        const fixture = await paginaUI(avaliacaoPersistida());
        const component = fixture.componentInstance;
        const antes = component.notasEditaveis();
        const alterar = spyOn(component, 'alterarNota').and.callThrough();
        for (const nota of [null, NaN, Infinity, -1, 101, 1.5]) component.alterarNotaPeloSlider(12, nota);
        expect(alterar).not.toHaveBeenCalled();
        expect(component.notasEditaveis()).toBe(antes);
        http.expectNone((req) => req.method !== 'GET');
    });

    for (const [estado, texto] of [['pendente', 'Avalia\u00e7\u00e3o n\u00e3o iniciada'], ['rascunho', 'Rascunho'], ['concluida', 'Avalia\u00e7\u00e3o conclu\u00edda']] as const) {
        it(`UI identifica ${estado} por texto, nao apenas por cor`, async () => {
            const fixture = await paginaUI(estado === 'pendente' ? avaliacaoPendente() : avaliacaoPersistida(estado));
            expect(fixture.nativeElement.querySelector('[data-testid="estado-avaliacao"]').textContent).toContain(texto);
            expect(fixture.nativeElement.querySelector('[data-testid="estado-avaliacao"]').getAttribute('role')).toBe('status');
            if (estado === 'concluida') {
                expect(fixture.nativeElement.querySelector('[data-testid="salvar-rascunho"], [data-testid="concluir-avaliacao"]')).toBeNull();
            } else {
                expect(fixture.nativeElement.querySelector('[data-testid="salvar-rascunho"]')).not.toBeNull();
                expect(fixture.nativeElement.querySelector('[data-testid="concluir-avaliacao"]')).not.toBeNull();
            }
        });
    }

    it('UI concluida mostra motivo/data e desabilita todos os controles de avaliacao', async () => {
        const resposta = avaliacaoPersistida('concluida');
        resposta.avaliacao!.possivelDesclassificacao = true;
        resposta.avaliacao!.motivoDesclassificacao = 'Motivo salvo';
        const fixture = await paginaUI(resposta);
        const controles = fixture.nativeElement.querySelectorAll('form input, form textarea');
        expect(controles.length).toBeGreaterThan(2);
        for (const controle of controles) expect(controle.disabled).toBeTrue();
        const motivo = fixture.nativeElement.querySelector('#motivo-desclassificacao') as HTMLTextAreaElement;
        expect(motivo.readOnly).toBeTrue();
        expect(motivo.value).toBe('Motivo salvo');
        expect(fixture.nativeElement.querySelector('#nota-12').readOnly).toBeTrue();
        expect(fixture.nativeElement.querySelector('[data-testid="data-conclusao"]').textContent).toContain(fixture.componentInstance.formatarData(resposta.avaliacao!.dataConclusao!));
        fixture.componentInstance.salvarRascunho();
        fixture.componentInstance.abrirConfirmacaoConclusao();
        http.expectNone((req) => req.method === 'PUT');
    });

    it('UI sem media informa necessidade de todas as notas salvas', async () => {
        const fixture = await paginaUI();
        expect(fixture.nativeElement.querySelector('[data-testid="media-avaliacao"]').textContent).toContain('todas as notas necess\u00e1rias');
        fixture.componentInstance.alterarNota(12, 100);
        fixture.componentInstance.alterarNota(91, 100);
        fixture.detectChanges();
        expect(fixture.nativeElement.querySelector('[data-testid="media-avaliacao"]').textContent).not.toContain('100.00');
    });

    it('UI diferencia media do ultimo estado salvo enquanto ha edicao sem recalcular', async () => {
        const fixture = await paginaUI(avaliacaoPersistida());
        expect(fixture.nativeElement.querySelector('[data-testid="media-avaliacao"]').textContent).toContain('M\u00e9dia do rascunho salvo');
        fixture.componentInstance.alterarNota(12, 100);
        fixture.detectChanges();
        const media = fixture.nativeElement.querySelector('[data-testid="media-avaliacao"]').textContent;
        expect(media).toContain('M\u00e9dia do \u00faltimo estado salvo');
        expect(media).toContain('48.00');
        expect(fixture.nativeElement.querySelector('[data-testid="alteracoes-nao-salvas"]')).not.toBeNull();
    });

    it('UI concluida identifica a media final autoritativa', async () => {
        const fixture = await paginaUI(avaliacaoPersistida('concluida'));
        const media = fixture.nativeElement.querySelector('[data-testid="media-avaliacao"]').textContent;
        expect(media).toContain('M\u00e9dia final');
        expect(media).toContain('48.00');
    });

    it('UI checkbox exibe motivo e preserva texto local quando desmarcado', async () => {
        const fixture = await paginaUI();
        expect(fixture.nativeElement.querySelector('#motivo-desclassificacao')).toBeNull();
        expect(fixture.nativeElement.textContent).toContain('A decis\u00e3o final cabe \u00e0 coordena\u00e7\u00e3o do Festival');
        const checkbox = fixture.nativeElement.querySelector('#possivel-desclassificacao') as HTMLInputElement;
        expect(fixture.nativeElement.querySelector('label[for="possivel-desclassificacao"]').textContent).toContain('Poss\u00edvel desclassifica\u00e7\u00e3o');
        checkbox.click();
        await fixture.whenStable();
        fixture.detectChanges();
        await fixture.whenStable();
        fixture.detectChanges();
        expect(fixture.componentInstance.possivelDesclassificacao()).toBeTrue();
        const motivo = fixture.nativeElement.querySelector('#motivo-desclassificacao') as HTMLTextAreaElement;
        expect(motivo.required).toBeTrue();
        expect(fixture.nativeElement.querySelector('label[for="motivo-desclassificacao"]')).not.toBeNull();
        motivo.value = 'Sinalizacao local';
        motivo.dispatchEvent(new Event('input'));
        await fixture.whenStable();
        checkbox.click();
        await fixture.whenStable();
        fixture.detectChanges();
        expect(fixture.nativeElement.querySelector('#motivo-desclassificacao')).toBeNull();
        expect(fixture.componentInstance.motivoDesclassificacao()).toBe('Sinalizacao local');
        clicarAcao(fixture, 'salvar-rascunho');
        const request = consultaGravacao();
        expect(request.request.body.motivoDesclassificacao).toBeNull();
        request.flush(avaliacaoPersistida());
    });

    it('UI apresenta erro acessivel de motivo obrigatorio sem PUT', async () => {
        const fixture = await paginaUI();
        fixture.componentInstance.alterarDesclassificacao(true);
        fixture.detectChanges();
        clicarAcao(fixture, 'salvar-rascunho');
        const erro = fixture.nativeElement.querySelector('#erro-gravacao');
        expect(erro.textContent).toContain('motivo');
        expect(erro.getAttribute('role')).toBe('alert');
        const textarea = fixture.nativeElement.querySelector('#motivo-desclassificacao');
        expect(textarea.getAttribute('aria-invalid')).toBe('true');
        expect(textarea.getAttribute('aria-describedby')).toContain('erro-gravacao');
        http.expectNone((req) => req.method === 'PUT');
    });

    it('UI contador usa code points apos trim e nao trunca texto maior que o limite', async () => {
        const fixture = await paginaUI();
        fixture.componentInstance.alterarDesclassificacao(true);
        fixture.componentInstance.alterarMotivo(`  ${'\u{1F3B5}'.repeat(2000)}  `);
        fixture.detectChanges();
        expect(fixture.nativeElement.querySelector('[data-testid="contador-motivo"]').textContent).toContain('2000 / 2000');
        const textarea = fixture.nativeElement.querySelector('#motivo-desclassificacao') as HTMLTextAreaElement;
        expect(textarea.maxLength).toBe(-1);
        fixture.componentInstance.alterarMotivo('\u{1F3B5}'.repeat(2001));
        fixture.detectChanges();
        clicarAcao(fixture, 'salvar-rascunho');
        expect(fixture.nativeElement.querySelector('[data-testid="contador-motivo"]').textContent).toContain('2001 / 2000');
        expect(fixture.componentInstance.motivoDesclassificacao()).toBe('\u{1F3B5}'.repeat(2001));
        expect(fixture.nativeElement.querySelector('#erro-gravacao')).not.toBeNull();
        http.expectNone((req) => req.method === 'PUT');
    });

    it('UI salvar rascunho usa a acao existente, aceita ausencia e mostra processamento', async () => {
        const fixture = await paginaUI();
        const salvar = spyOn(fixture.componentInstance, 'salvarRascunho').and.callThrough();
        clicarAcao(fixture, 'salvar-rascunho');
        expect(salvar).toHaveBeenCalledTimes(1);
        const request = consultaGravacao();
        expect(request.request.body.notas).toEqual([]);
        expect(request.request.body.estado).toBe('rascunho');
        expect(fixture.nativeElement.textContent).toContain('Salvando...');
        for (const controle of fixture.nativeElement.querySelectorAll('form input, form textarea, form button')) expect(controle.disabled).toBeTrue();
        expect(fixture.nativeElement.querySelector('[aria-labelledby="criterios"]').getAttribute('aria-busy')).toBe('true');
        clicarAcao(fixture, 'salvar-rascunho');
        http.expectNone((req) => req.method === 'PUT');
        request.flush(avaliacaoPersistida());
        fixture.detectChanges();
        expect(fixture.nativeElement.querySelector('[data-testid="salvar-rascunho"]').disabled).toBeFalse();
        expect(fixture.nativeElement.querySelector('[data-testid="estado-avaliacao"]').textContent).toContain('Rascunho');
    });

    it('UI concluir incompleta mostra erro e nao abre confirmacao nem grava', async () => {
        const fixture = await paginaUI();
        const confirm = spyOn(fixture.debugElement.injector.get(ConfirmationService), 'confirm').and.callThrough();
        clicarAcao(fixture, 'concluir-avaliacao');
        expect(confirm).not.toHaveBeenCalled();
        expect(fixture.nativeElement.querySelector('#erro-gravacao').textContent).toContain('preencha todos');
        expect(fixture.nativeElement.querySelector('#erro-gravacao').getAttribute('role')).toBe('alert');
        expect(fixture.nativeElement.querySelector('#nota-12').getAttribute('aria-describedby')).toContain('erro-gravacao');
        expect(fixture.nativeElement.querySelector('#nota-12').classList.contains('p-invalid')).toBeTrue();
        expect((fixture.debugElement.query(By.directive(InputNumber)).componentInstance as InputNumber).invalid()).toBeTrue();
        for (const elemento of fixture.debugElement.queryAll(By.directive(Slider))) {
            expect((elemento.componentInstance as Slider).invalid()).toBeTrue();
            expect(elemento.nativeElement.classList.contains('p-invalid')).toBeTrue();
        }
        http.expectNone((req) => req.method === 'PUT');
    });

    it('UI confirmacao explica irreversibilidade e cancelar nao modifica avaliacao', async () => {
        const fixture = await paginaUI(avaliacaoPersistida());
        const antes = fixture.componentInstance.avaliacao();
        const confirm = spyOn(fixture.debugElement.injector.get(ConfirmationService), 'confirm').and.callThrough();
        clicarAcao(fixture, 'concluir-avaliacao');
        await fixture.whenStable();
        fixture.detectChanges();
        expect(confirm).toHaveBeenCalledTimes(1);
        const mensagem = confirm.calls.mostRecent().args[0];
        expect(mensagem.message).toContain('irrevers\u00edvel');
        expect(mensagem.message).toContain('n\u00e3o poder\u00e1 alter\u00e1-la');
        expect(mensagem.defaultFocus).toBe('reject');
        http.expectNone((req) => req.method === 'PUT');
        expect(fixture.nativeElement.querySelector('[data-testid="salvar-rascunho"]').disabled).toBeTrue();
        const cancelar = document.querySelector('.p-confirmdialog-reject-button') as HTMLButtonElement;
        expect(cancelar).not.toBeNull();
        cancelar.click();
        await fixture.whenStable();
        fixture.detectChanges();
        expect(fixture.componentInstance.confirmando).toBeFalse();
        expect(fixture.componentInstance.avaliacao()).toBe(antes);
        expect(fixture.componentInstance.notasEditaveis()).toEqual({ 12: 0, 91: 80 });
        expect(fixture.nativeElement.querySelector('[data-testid="salvar-rascunho"]').disabled).toBeFalse();
        http.expectNone((req) => req.method === 'PUT');
    });

    it('UI aceite explicito envia exatamente um PUT e mostra concluida read-only', async () => {
        const fixture = await paginaUI(avaliacaoPersistida());
        clicarAcao(fixture, 'concluir-avaliacao');
        await fixture.whenStable();
        fixture.detectChanges();
        http.expectNone((req) => req.method === 'PUT');
        const aceitar = document.querySelector('.p-confirmdialog-accept-button') as HTMLButtonElement;
        expect(aceitar).not.toBeNull();
        aceitar.click();
        aceitar.click();
        const request = consultaGravacao();
        expect(request.request.body.estado).toBe('concluida');
        expect(request.request.body.versao).toBe(7);
        request.flush(avaliacaoPersistida('concluida', 8));
        await fixture.whenStable();
        fixture.detectChanges();
        expect(fixture.nativeElement.querySelector('[data-testid="estado-avaliacao"]').textContent).toContain('Avalia\u00e7\u00e3o conclu\u00edda');
        expect(fixture.nativeElement.querySelector('[data-testid="salvar-rascunho"], [data-testid="concluir-avaliacao"]')).toBeNull();
        http.expectNone((req) => req.url.includes('/api/jurado'));
    });

    it('UI callback antigo nao conclui outra participacao mesmo com nova confirmacao aberta', async () => {
        const fixture = await paginaUI(avaliacaoPersistida());
        const confirm = spyOn(fixture.debugElement.injector.get(ConfirmationService), 'confirm').and.callThrough();
        clicarAcao(fixture, 'concluir-avaliacao');
        const antiga = confirm.calls.mostRecent().args[0];
        parametros.next(convertToParamMap({ slug: evento.slug, idParticipacao: '21' }));
        const nova = { ...avaliacaoPersistida(), concorrente: { ...avaliacaoPendente().concorrente, idParticipacao: 21, numeroConcorrente: 'FVST2-021' } };
        consulta(evento.slug, 21, nova).flush(dados({ idParticipacao: 21 }));
        await fixture.whenStable();
        fixture.detectChanges();
        clicarAcao(fixture, 'concluir-avaliacao');
        const atual = confirm.calls.mostRecent().args[0];
        antiga.accept?.();
        antiga.reject?.();
        expect(fixture.componentInstance.confirmando).toBeTrue();
        http.expectNone((req) => req.method === 'PUT');
        atual.reject?.();
        fixture.debugElement.injector.get(ConfirmationService).close();
    });

    for (const status of [409, 500]) {
        it(`UI conflito com reconciliacao ${status === 409 ? 'falha' : 'bem sucedida'} preserva video e evita mensagem de sucesso`, async () => {
            const fixture = await paginaUI(avaliacaoPersistida());
            fixture.componentInstance.reproduzirVideo(false);
            fixture.detectChanges();
            const player = fixture.nativeElement.querySelector('iframe');
            clicarAcao(fixture, 'salvar-rascunho');
            consultaGravacao().flush({}, { status: 409, statusText: 'Conflict' });
            fixture.detectChanges();
            expect(fixture.nativeElement.querySelector('[data-testid="conflito-avaliacao"]').textContent).toContain('alterado');
            expect(fixture.nativeElement.querySelector('[data-testid="recarregar-avaliacao"]')).not.toBeNull();
            expect(fixture.nativeElement.querySelector('[data-testid="salvar-rascunho"]').disabled).toBeTrue();
            http.expectNone((req) => req.url.includes('/api/jurado'));
            clicarAcao(fixture, 'recarregar-avaliacao');
            expect(fixture.nativeElement.textContent).toContain('Atualizando o estado');
            const reconciliation = http.expectOne(`/api/jurado/eventos/${evento.slug}/concorrentes/20/avaliacao`);
            if (status === 409) reconciliation.flush({}, { status: 409, statusText: 'Conflict' });
            else reconciliation.flush(avaliacaoPersistida('rascunho', 8));
            fixture.detectChanges();
            expect(fixture.nativeElement.querySelector('iframe')).toBe(player);
            if (status === 409) {
                expect(fixture.nativeElement.querySelector('[data-testid="erro-avaliacao"]')).not.toBeNull();
                expect(fixture.nativeElement.querySelector('[data-testid="salvar-rascunho"], [data-testid="concluir-avaliacao"]')).toBeNull();
                for (const controle of fixture.nativeElement.querySelectorAll('form input')) expect(controle.disabled).toBeTrue();
            } else {
                expect(fixture.nativeElement.querySelector('[data-testid="conflito-avaliacao"]').textContent).toContain('Estado atualizado');
                expect(fixture.componentInstance.avaliacao()?.versao).toBe(8);
            }
            expect(fixture.nativeElement.querySelector('[data-testid="conflito-avaliacao"]').textContent).not.toContain('salva com sucesso');
            http.expectNone((req) => req.url.includes('/api/jurado'));
        });
    }

    it('UI erro de avaliacao mantem dados/video e mensagem neutra sem controles', () => {
        const fixture = criarPagina();
        consulta(evento.slug, 20, null).flush(dados());
        fixture.componentInstance.reproduzirVideo(false);
        fixture.detectChanges();
        const player = fixture.nativeElement.querySelector('iframe');
        http.expectOne(`/api/jurado/eventos/${evento.slug}/concorrentes/20/avaliacao`).flush({ message: 'SQL interno' }, { status: 500, statusText: 'Erro' });
        fixture.detectChanges();
        expect(fixture.nativeElement.querySelector('iframe')).toBe(player);
        expect(fixture.nativeElement.textContent).toContain(concorrente.nome);
        expect(fixture.nativeElement.querySelector('[data-testid="erro-avaliacao"]').getAttribute('role')).toBe('alert');
        expect(fixture.nativeElement.textContent).not.toContain('SQL interno');
        expect(fixture.nativeElement.querySelector('form')).toBeNull();
    });

    it('rascunho restaura notas por ID, preserva zero e nao recalcula a media ao editar', () => {
        const fixture = paginaComAvaliacao(avaliacaoPersistida());
        const component = fixture.componentInstance;
        expect(component.notasEditaveis()).toEqual({ 12: 0, 91: 80 });
        expect(component.mediaSalva()).toBe('48.00');
        expect(component.alteracoesNaoSalvas()).toBeFalse();
        component.alterarNota(12, 100);
        expect(component.notasEditaveis()[12]).toBe(100);
        expect(component.mediaSalva()).toBe('48.00');
        expect(component.avaliacao()?.avaliacao?.notas).toEqual(avaliacaoPersistida().avaliacao?.notas);
        expect(component.alteracoesNaoSalvas()).toBeTrue();
        component.alterarNota(12, 0);
        expect(component.alteracoesNaoSalvas()).toBeFalse();
        component.alterarNota(999, 70);
        expect(component.notasEditaveis()[999]).toBeUndefined();
        http.expectNone((req) => req.method === 'PUT');
    });

    for (const nota of [1.5, -1, 101, NaN, Infinity, -Infinity, '80']) {
        it(`rejeita nota ${String(nota)} sem coercao, clamp, arredondamento ou PUT`, () => {
            const component = paginaComAvaliacao().componentInstance;
            component.alterarNota(12, nota as number);
            component.salvarRascunho();
            expect(component.erroGravacao()).not.toBeNull();
            expect(component.salvando()).toBeFalse();
            expect(component.avaliacao()?.versao).toBe(0);
            http.expectNone((req) => req.method === 'PUT');
        });
    }

    for (const nota of [9, 91]) {
        it(`valida nota ${nota} usando limites recebidos, nao uma escala local fixa`, () => {
            const resposta = { ...avaliacaoPendente(), escala: { min: 10, max: 90, passo: 1 } };
            const component = paginaComAvaliacao(resposta).componentInstance;
            component.alterarNota(12, nota);
            component.salvarRascunho();
            expect(component.erroGravacao()).not.toBeNull();
            http.expectNone((req) => req.method === 'PUT');
        });
    }

    it('rascunho vazio e permitido e PUT substitui o estado apenas pela resposta', () => {
        const component = paginaComAvaliacao().componentInstance;
        component.salvarRascunho();
        const request = consultaGravacao();
        expect(request.request.body).toEqual({ contexto: { idCiclo: 100, numeroTentativa: null }, versao: 0, estado: 'rascunho', notas: [], possivelDesclassificacao: false, motivoDesclassificacao: null });
        expect(component.avaliacao()?.estado).toBe('pendente');
        expect(component.avaliacao()?.versao).toBe(0);
        expect(component.salvando()).toBeTrue();
        request.flush({ ...avaliacaoPersistida(), versao: 1 });
        expect(component.avaliacao()?.versao).toBe(1);
        expect(component.salvando()).toBeFalse();
    });

    it('rascunho parcial envia zero, omite ausencia e normaliza motivo false para null', () => {
        const component = paginaComAvaliacao().componentInstance;
        component.alterarNota(12, 0);
        component.alterarMotivo('texto nao enviado');
        component.salvarRascunho();
        const request = consultaGravacao();
        expect(request.request.withCredentials).toBeTrue();
        expect(request.request.body).toEqual({ contexto: { idCiclo: 100, numeroTentativa: null }, versao: 0, estado: 'rascunho', notas: [{ idCriterioCiclo: 12, nota: 0 }], possivelDesclassificacao: false, motivoDesclassificacao: null });
        request.flush(avaliacaoPersistida());
    });

    it('usa versao atual, bloqueia duplo submit e reconstrui a edicao com PUT autoritativo', () => {
        const component = paginaComAvaliacao(avaliacaoPersistida()).componentInstance;
        component.alterarNota(91, null);
        component.salvarRascunho();
        component.salvarRascunho();
        expect(component.solicitarConclusao()).toBeFalse();
        component.alterarNota(12, 77);
        const request = consultaGravacao();
        expect(request.request.body).toEqual({ contexto: { idCiclo: 100, numeroTentativa: 1 }, versao: 7, estado: 'rascunho', notas: [{ idCriterioCiclo: 12, nota: 0 }], possivelDesclassificacao: false, motivoDesclassificacao: null });
        expect(component.notasEditaveis()[12]).toBe(0);
        expect(component.avaliacao()?.versao).toBe(7);
        const resposta = avaliacaoPersistida('rascunho', 12);
        resposta.avaliacao!.notas = [{ idCriterio: 191, idCriterioOrigem: 191, idCriterioCiclo: 91, nota: 20 }];
        resposta.avaliacao!.media = null;
        resposta.avaliacao!.possivelDesclassificacao = true;
        resposta.avaliacao!.motivoDesclassificacao = 'Motivo do servidor';
        resposta.criterios = [
            { ...resposta.criterios[0], peso: '30.00' }, resposta.criterios[1],
            { idCriterio: 305, idCriterioOrigem: 305, idCriterioCiclo: 205, nome: 'Novo criterio', descricao: null, ordem: 3, peso: '10.00' }
        ];
        request.flush(resposta);
        expect(component.avaliacao()).toEqual(resposta);
        expect(component.notasEditaveis()).toEqual({ 12: null, 91: 20, 205: null });
        expect(component.possivelDesclassificacao()).toBeTrue();
        expect(component.motivoDesclassificacao()).toBe('Motivo do servidor');
        expect(component.mediaSalva()).toBeNull();
        expect(component.alteracoesNaoSalvas()).toBeFalse();
        expect(component.salvando()).toBeFalse();
        http.expectNone((req) => req.url.includes('/api/jurado'));
    });

    it('conclusao incompleta e rejeitada e executar sem preparar nao envia PUT', () => {
        const component = paginaComAvaliacao().componentInstance;
        component.executarConclusao();
        component.alterarNota(12, 80);
        expect(component.solicitarConclusao()).toBeFalse();
        component.executarConclusao();
        expect(component.erroGravacao()).not.toBeNull();
        http.expectNone((req) => req.method === 'PUT');
    });

    it('conclusao separa solicitacao, cancelamento e execucao unica com todas as notas', () => {
        const component = paginaComAvaliacao(avaliacaoPersistida()).componentInstance;
        expect(component.solicitarConclusao()).toBeTrue();
        http.expectNone((req) => req.method === 'PUT');
        component.cancelarConclusao();
        component.executarConclusao();
        http.expectNone((req) => req.method === 'PUT');
        expect(component.solicitarConclusao()).toBeTrue();
        component.executarConclusao();
        component.executarConclusao();
        const request = consultaGravacao();
        expect(request.request.body).toEqual({ contexto: { idCiclo: 100, numeroTentativa: 1 }, versao: 7, estado: 'concluida', notas: [{ idCriterioCiclo: 12, nota: 0 }, { idCriterioCiclo: 91, nota: 80 }], possivelDesclassificacao: false, motivoDesclassificacao: null });
        const resposta = avaliacaoPersistida('concluida', 8);
        request.flush(resposta);
        expect(component.avaliacao()).toEqual(resposta);
        expect(component.concluida()).toBeTrue();
        expect(component.podeEditar()).toBeFalse();
    });

    it('alterar uma nota invalida a preparacao anterior da conclusao', () => {
        const component = paginaComAvaliacao(avaliacaoPersistida()).componentInstance;
        expect(component.solicitarConclusao()).toBeTrue();
        component.alterarNota(12, 70);
        component.executarConclusao();
        http.expectNone((req) => req.method === 'PUT');
    });

    for (const motivo of ['', '   ', '\u{1F3B5}'.repeat(2001)]) {
        it(`motivo invalido com ${Array.from(motivo).length} code points impede rascunho e conclusao`, () => {
            const component = paginaComAvaliacao(avaliacaoPersistida()).componentInstance;
            component.alterarDesclassificacao(true);
            component.alterarMotivo(motivo);
            component.salvarRascunho();
            expect(component.solicitarConclusao()).toBeFalse();
            expect(component.motivoDesclassificacao()).toBe(motivo);
            expect(component.erroGravacao()).not.toBeNull();
            http.expectNone((req) => req.method === 'PUT');
        });
    }

    it('aceita 2000 code points apos trim sem truncar e nao converte motivo invalido', () => {
        const component = paginaComAvaliacao().componentInstance;
        const motivo = '\u{1F3B5}'.repeat(2000);
        component.alterarDesclassificacao(true);
        component.alterarMotivo(`  ${motivo}  `);
        component.alterarMotivo({ texto: 'invalido' } as unknown as string);
        component.alterarDesclassificacao(1 as unknown as boolean);
        component.salvarRascunho();
        const request = consultaGravacao();
        expect(request.request.body.motivoDesclassificacao).toBe(motivo);
        expect(request.request.body.possivelDesclassificacao).toBeTrue();
        expect(component.motivoDesclassificacao()).toBe(`  ${motivo}  `);
        request.flush(avaliacaoPersistida());
    });

    it('concluida impede alteracao efetiva, rascunho e nova conclusao nos metodos', () => {
        const component = paginaComAvaliacao(avaliacaoPersistida('concluida')).componentInstance;
        const antes = { notas: component.notasEditaveis(), possivel: component.possivelDesclassificacao(), motivo: component.motivoDesclassificacao() };
        component.alterarNota(12, 100);
        component.alterarDesclassificacao(true);
        component.alterarMotivo('alteracao indevida');
        component.salvarRascunho();
        expect(component.solicitarConclusao()).toBeFalse();
        component.executarConclusao();
        expect({ notas: component.notasEditaveis(), possivel: component.possivelDesclassificacao(), motivo: component.motivoDesclassificacao() }).toEqual(antes);
        expect(Object.isFrozen(component.notasEditaveis())).toBeTrue();
        http.expectNone((req) => req.method === 'PUT');
    });

    for (const [estado, code, motivo, mensagem] of [
        ['ciclo_fechado', 'CONTEXTO_NAO_GRAVAVEL', 'CONTEXTO_NAO_GRAVAVEL', 'Ciclo de julgamento fechado'],
        ['jurado_inelegivel', 'ACESSO_OPERACIONAL_NEGADO', 'ACESSO_OPERACIONAL_NEGADO', 'Sem autoriza\u00e7\u00e3o'],
        ['concorrente_inelegivel', 'CONCORRENTE_NAO_INCLUIDO', 'CONCORRENTE_NAO_INCLUIDO', 'Participa\u00e7\u00e3o indispon\u00edvel'],
        ['contexto_invalido', 'CONTEXTO_NAO_GRAVAVEL', 'limite_versao', 'n\u00e3o permite novas grava\u00e7\u00f5es'],
        ['criterios_invalidos', 'CRITERIOS_INVALIDOS', 'CRITERIOS_INVALIDOS', 'Grava\u00e7\u00e3o indispon\u00edvel']
    ]) {
        it(`backend podeGravar=false (${estado}) bloqueia inputs e acoes mesmo em draft`, async () => {
            const resposta = avaliacaoPersistida();
            resposta.podeGravar = false;
            resposta.autorizacaoGravacao = { estado, code, motivo };
            const fixture = await paginaUI(resposta), component = fixture.componentInstance;
            const antes = component.notasEditaveis();
            expect(component.podeEditar()).toBeFalse();
            expect(fixture.nativeElement.querySelector('[data-testid="autorizacao-gravacao"]').textContent).toContain(mensagem);
            expect(fixture.nativeElement.textContent).not.toContain(code);
            for (const controle of fixture.nativeElement.querySelectorAll('form input, form textarea, form button'))
                expect(controle.disabled).toBeTrue();
            component.alterarNota(12, 100);
            component.alterarDesclassificacao(true);
            component.alterarMotivo('nao permitido');
            component.salvarRascunho();
            expect(component.solicitarConclusao()).toBeFalse();
            component.executarConclusao();
            expect(component.notasEditaveis()).toBe(antes);
            http.expectNone((req) => req.method === 'PUT');
        });
    }

    it('identidade de gravacao e snapshot, nao origem; detalhe nunca substitui criterios/contexto da avaliacao', () => {
        const resposta = avaliacaoPersistida();
        const fixture = criarPagina();
        const detalhe = consulta(evento.slug, 20, resposta);
        detalhe.flush(dados({ nome: 'Outra apresentacao', obraPrincipal: { id: 999, titulo: 'Outro material' } }));
        const component = fixture.componentInstance;
        expect(component.avaliacao()).toBe(resposta);
        component.alterarNota(112, 99);
        expect(component.notasEditaveis()[112]).toBeUndefined();
        component.alterarNota(12, 99);
        component.salvarRascunho();
        const request = consultaGravacao();
        expect(request.request.body).toEqual({
            contexto: { idCiclo: 100, numeroTentativa: 1 }, versao: 7, estado: 'rascunho',
            notas: [{ idCriterioCiclo: 12, nota: 99 }, { idCriterioCiclo: 91, nota: 80 }],
            possivelDesclassificacao: false, motivoDesclassificacao: null
        });
        for (const nota of request.request.body.notas) {
            expect(Object.keys(nota).sort()).toEqual(['idCriterioCiclo', 'nota']);
        }
        const novo = avaliacaoPersistida('rascunho', 8);
        novo.podeGravar = false;
        novo.autorizacaoGravacao = { estado: 'ciclo_fechado', code: 'CONTEXTO_NAO_GRAVAVEL', motivo: 'CONTEXTO_NAO_GRAVAVEL' };
        request.flush(novo);
        expect(component.avaliacao()).toBe(novo);
        expect(component.podeEditar()).toBeFalse();
        http.expectNone((req) => req.url.includes('/api/jurado'));
    });

    it('material congelado sem cidade/uf/data live e exibido sem inventar metadados', () => {
        const fixture = criarPagina();
        const { cidade, uf, dataInscricao, ...snapshot } = concorrente;
        consulta().flush({ evento, concorrente: { ...snapshot, idSnapshot: 320 } });
        fixture.detectChanges();
        expect(fixture.nativeElement.textContent).toContain(concorrente.obraPrincipal.titulo);
        expect(fixture.nativeElement.querySelector('[data-testid="localidade"]')).toBeNull();
        expect(fixture.nativeElement.textContent).not.toContain('Data da inscri\u00e7\u00e3o');
        expect(fixture.componentInstance.avaliacao()?.contexto.idCiclo).toBe(100);
        http.expectNone((req) => req.url.includes('/api/jurado'));
    });

    for (const code of ['CICLO_DESATUALIZADO', 'TENTATIVA_DESATUALIZADA', 'VERSAO_DESATUALIZADA', 'CONFLITO_CONCORRENCIA', 'AVALIACAO_CONCLUIDA', 'CONTEXTO_NAO_GRAVAVEL']) {
        it(`409 ${code} nao faz GET/PUT automatico; reload explicito substitui tokens, notas e permissao`, () => {
            const component = paginaComAvaliacao(avaliacaoPersistida()).componentInstance;
            const antes = component.avaliacao();
            component.alterarNota(12, 99);
            component.salvarRascunho();
            consultaGravacao().flush({ code, message: 'SQL stack interno' }, { status: 409, statusText: 'Conflict' });
            expect(component.avaliacao()).toBe(antes);
            expect(component.salvando()).toBeFalse();
            expect(component.podeEditar()).toBeFalse();
            expect(component.mensagemConflito()).not.toContain('SQL');
            component.salvarRascunho();
            component.executarConclusao();
            expect(component.solicitarConclusao()).toBeFalse();
            http.expectNone((req) => req.url.includes('/api/jurado'));
            component.recarregarAvaliacao();
            const request = http.expectOne(`/api/jurado/eventos/${evento.slug}/concorrentes/20/avaliacao`);
            expect(request.request.method).toBe('GET');
            const atual = avaliacaoPendente();
            atual.contexto = { idCiclo: 200, numeroCiclo: 2, numeroTentativa: null };
            atual.criterios = atual.criterios.map(c => ({ ...c, idCriterioCiclo: c.idCriterioCiclo + 1000 }));
            request.flush(atual);
            expect(component.avaliacao()).toBe(atual);
            expect(component.notasEditaveis()).toEqual({ 1012: null, 1091: null });
            expect(component.conflito()).toBeFalse();
            expect(component.podeEditar()).toBeTrue();
            http.expectNone((req) => req.url.includes('/api/jurado'));
            component.alterarNota(1012, 50);
            component.salvarRascunho();
            const nova = consultaGravacao();
            expect(nova.request.body).toEqual({
                contexto: { idCiclo: 200, numeroTentativa: null }, versao: 0, estado: 'rascunho',
                notas: [{ idCriterioCiclo: 1012, nota: 50 }], possivelDesclassificacao: false, motivoDesclassificacao: null
            });
            nova.flush({ ...avaliacaoPersistida('rascunho', 1), contexto: { idCiclo: 200, numeroCiclo: 2, numeroTentativa: 1 } });
        });
    }

    for (const estado of ['rascunho', 'concluida'] as const) {
        it(`409 bloqueia tokens; reload explicito preserva videos e adota ${estado} sem reaplicar edicao`, () => {
            const fixture = paginaComAvaliacao(avaliacaoPersistida());
            const component = fixture.componentInstance;
            component.reproduzirVideo(false);
            const player = component.playerPrincipal();
            component.alterarNota(12, 99);
            component.salvarRascunho();
            consultaGravacao().flush({ message: 'Interno nao deve aparecer' }, { status: 409, statusText: 'Conflict' });
            expect(component.conflito()).toBeTrue();
            expect(component.reconciliando()).toBeFalse();
            expect(component.salvando()).toBeFalse();
            expect(component.podeEditar()).toBeFalse();
            component.salvarRascunho();
            expect(component.solicitarConclusao()).toBeFalse();
            component.alterarNota(12, 20);
            expect(component.notasEditaveis()[12]).toBe(99);
            http.expectNone((req) => req.url.includes('/api/jurado'));
            component.recarregarAvaliacao();
            component.recarregarAvaliacao();
            const reconciliation = http.expectOne(`/api/jurado/eventos/${evento.slug}/concorrentes/20/avaliacao`);
            expect(reconciliation.request.method).toBe('GET');
            const resposta = avaliacaoPersistida(estado, 8);
            reconciliation.flush(resposta);
            expect(component.avaliacao()).toEqual(resposta);
            expect(component.notasEditaveis()).toEqual({ 12: 0, 91: 80 });
            expect(component.alteracoesNaoSalvas()).toBeFalse();
            expect(component.conflito()).toBeFalse();
            expect(component.mensagemConflito()).toContain('Estado atualizado');
            expect(component.mensagemConflito()).not.toContain('Interno');
            expect(component.playerPrincipal()).toBe(player);
            expect(component.detalhe()).not.toBeNull();
            expect(component.reconciliando()).toBeFalse();
            expect(component.salvando()).toBeFalse();
            expect(component.podeEditar()).toBe(estado === 'rascunho');
            http.expectNone((req) => req.url.includes('/api/jurado'));
        });
    }

    for (const status of [409, 500, 0]) {
        it(`falha ${status} na reconciliacao bloqueia gravacao sem loop`, () => {
            const component = paginaComAvaliacao(avaliacaoPersistida()).componentInstance;
            component.salvarRascunho();
            consultaGravacao().flush({}, { status: 409, statusText: 'Conflict' });
            http.expectNone((req) => req.url.includes('/api/jurado'));
            component.recarregarAvaliacao();
            const reconciliation = http.expectOne(`/api/jurado/eventos/${evento.slug}/concorrentes/20/avaliacao`);
            if (status === 0) reconciliation.error(new ProgressEvent('error'));
            else reconciliation.flush({ message: 'Informacao interna' }, { status, statusText: 'Erro' });
            expect(component.erroAvaliacao()).not.toBeNull();
            expect(component.erroAvaliacao()).not.toContain('Informacao interna');
            expect(component.conflito()).toBeTrue();
            expect(component.podeEditar()).toBeFalse();
            expect(component.salvando()).toBeFalse();
            expect(component.reconciliando()).toBeFalse();
            component.salvarRascunho();
            http.expectNone((req) => req.url.includes('/api/jurado'));
        });
    }

    for (const status of [400, 401, 403, 404, 500, 0]) {
        it(`PUT ${status} nao presume sucesso nem reenvia e respeita navegacao existente`, () => {
            const component = paginaComAvaliacao(avaliacaoPersistida()).componentInstance;
            const navigate = spyOn(TestBed.inject(Router), 'navigate').and.resolveTo(true);
            const antes = component.avaliacao();
            component.alterarNota(12, 60);
            component.salvarRascunho();
            const request = consultaGravacao();
            if (status === 0) request.error(new ProgressEvent('error'));
            else request.flush({ message: 'SQL interno nao exibir' }, { status, statusText: 'Erro' });
            expect(component.avaliacao()).toBe(antes);
            expect(component.notasEditaveis()[12]).toBe(60);
            expect(component.salvando()).toBeFalse();
            expect(component.erroGravacao()).not.toBeNull();
            expect(component.erroGravacao()).not.toContain('SQL');
            if ([401, 403].includes(status)) expect(navigate).toHaveBeenCalledOnceWith([status === 401 ? '/login' : '/']);
            else expect(navigate).not.toHaveBeenCalled();
            if ([401, 403, 404].includes(status)) {
                component.salvarRascunho();
                expect(component.solicitarConclusao()).toBeFalse();
            }
            http.expectNone((req) => req.url.includes('/api/jurado'));
        });
    }

    for (const status of [401, 403, 404, 409, 500, 0]) {
        it(`GET avaliacao ${status} preserva detalhe e player sem loop`, () => {
            const fixture = criarPagina();
            const component = fixture.componentInstance;
            const navigate = spyOn(TestBed.inject(Router), 'navigate').and.resolveTo(true);
            consulta(evento.slug, 20, null).flush(dados());
            component.reproduzirVideo(false);
            const player = component.playerPrincipal();
            const request = http.expectOne(`/api/jurado/eventos/${evento.slug}/concorrentes/20/avaliacao`);
            if (status === 0) request.error(new ProgressEvent('error'));
            else request.flush({ message: 'SQL interno nao exibir' }, { status, statusText: 'Erro' });
            expect(component.detalhe()).not.toBeNull();
            expect(component.playerPrincipal()).toBe(player);
            expect(component.erroAvaliacao()).not.toBeNull();
            expect(component.erroAvaliacao()).not.toContain('SQL');
            expect(component.carregandoAvaliacao()).toBeFalse();
            expect(component.podeEditar()).toBeFalse();
            if ([401, 403].includes(status)) expect(navigate).toHaveBeenCalledOnceWith([status === 401 ? '/login' : '/']);
            else expect(navigate).not.toHaveBeenCalled();
            http.expectNone((req) => req.url.includes('/api/jurado'));
        });
    }

    it('cancela GET antigo de avaliacao e resposta anterior nao altera outra participacao', () => {
        const fixture = criarPagina();
        consulta(evento.slug, 20, null).flush(dados());
        const antiga = http.expectOne(`/api/jurado/eventos/${evento.slug}/concorrentes/20/avaliacao`);
        parametros.next(convertToParamMap({ slug: evento.slug, idParticipacao: '21' }));
        expect(antiga.cancelled).toBeTrue();
        expect(fixture.componentInstance.avaliacao()).toBeNull();
        consulta(evento.slug, 21).flush(dados({ idParticipacao: 21 }));
        expect(() => antiga.flush(avaliacaoPersistida())).toThrowError();
        expect(fixture.componentInstance.avaliacao()?.concorrente.idParticipacao).toBe(21);
        expect(fixture.componentInstance.notasEditaveis()).toEqual({ 12: null, 91: null });
    });

    for (const operacao of ['PUT', 'reconciliacao']) {
        it(`cancela ${operacao} de A sem modificar ou desbloquear uma gravacao de B`, () => {
            const component = paginaComAvaliacao(avaliacaoPersistida()).componentInstance;
            component.salvarRascunho();
            let antiga = consultaGravacao();
            if (operacao === 'reconciliacao') {
                antiga.flush({}, { status: 409, statusText: 'Conflict' });
                component.recarregarAvaliacao();
                antiga = http.expectOne(`/api/jurado/eventos/${evento.slug}/concorrentes/20/avaliacao`);
            }
            parametros.next(convertToParamMap({ slug: 'outro-evento', idParticipacao: '22' }));
            expect(antiga.cancelled).toBeTrue();
            expect(component.conflito()).toBeFalse();
            consulta('outro-evento', 22).flush({ ...dados({ idParticipacao: 22 }), evento: { id: 28, slug: 'outro-evento', nome: 'Novo Evento' } });
            component.alterarNota(12, 30);
            component.salvarRascunho();
            const nova = http.expectOne('/api/jurado/eventos/outro-evento/concorrentes/22/avaliacao');
            expect(nova.request.method).toBe('PUT');
            expect(component.salvando()).toBeTrue();
            expect(() => antiga.flush(avaliacaoPersistida('concluida'))).toThrowError();
            expect(component.salvando()).toBeTrue();
            expect(component.avaliacao()?.concorrente.idParticipacao).toBe(22);
            expect(component.notasEditaveis()[12]).toBe(30);
            const resposta = { ...avaliacaoPersistida(), evento: { id: 28, slug: 'outro-evento', nome: 'Novo Evento' }, concorrente: { idParticipacao: 22, numeroConcorrente: 'FVST2-22' } };
            nova.flush(resposta);
            expect(component.salvando()).toBeFalse();
        });
    }

    it('mudanca de rota invalida uma conclusao preparada', () => {
        const component = paginaComAvaliacao(avaliacaoPersistida()).componentInstance;
        expect(component.solicitarConclusao()).toBeTrue();
        parametros.next(convertToParamMap({ slug: evento.slug, idParticipacao: '21' }));
        consulta(evento.slug, 21).flush(dados({ idParticipacao: 21 }));
        component.executarConclusao();
        http.expectNone((req) => req.method === 'PUT');
    });

    it('destruir componente cancela PUT sem envio adicional', () => {
        const fixture = paginaComAvaliacao(avaliacaoPersistida());
        fixture.componentInstance.salvarRascunho();
        const request = consultaGravacao();
        fixture.destroy();
        expect(request.cancelled).toBeTrue();
        parametros.next(convertToParamMap({ slug: evento.slug, idParticipacao: '21' }));
        http.expectNone((req) => req.url.includes('/api/jurado'));
    });

    it('carrega detalhe e avaliacao independentemente sem metadados extras', () => {
        const fixture = criarPagina();
        const detalhe = consulta(evento.slug, 20, null);
        const avaliacao = http.expectOne(`/api/jurado/eventos/${evento.slug}/concorrentes/20/avaliacao`);
        expect(detalhe.request.method).toBe('GET');
        expect(avaliacao.request.method).toBe('GET');
        detalhe.flush(dados());
        expect(fixture.componentInstance.detalhe()).not.toBeNull();
        expect(fixture.componentInstance.carregando()).toBeFalse();
        expect(fixture.componentInstance.carregandoAvaliacao()).toBeTrue();
        expect(fixture.componentInstance.podeEditar()).toBeFalse();
        avaliacao.flush(avaliacaoPendente());
        expect(fixture.componentInstance.podeEditar()).toBeTrue();
        http.expectNone((req) => req.url.includes('/api/jurado'));
    });

    it('pendente usa criterios dinamicos e inicializa ausencia como null', () => {
        const fixture = criarPagina();
        consulta().flush(dados());
        expect(fixture.componentInstance.avaliacao()?.versao).toBe(0);
        expect(fixture.componentInstance.notasEditaveis()).toEqual({ 12: null, 91: null });
        expect(fixture.componentInstance.mediaSalva()).toBeNull();
        expect(fixture.componentInstance.alteracoesNaoSalvas()).toBeFalse();
    });

    it('rota individual e lazy e usa exatamente o guard existente', async () => {
        const rota = appRoutes.find((item) => item.path === 'jurado')?.children?.find((item) => item.path === ':slug/avaliacoes/:idParticipacao');
        expect(rota?.canActivate).toEqual([juradoGuard]);
        expect(await rota?.loadComponent?.()).toBe(JuradoConcorrenteComponent);
    });

    it('faz uma carga inicial, mostra dados publicos e nao carrega player automaticamente', () => {
        const fixture = criarPagina();
        expect(fixture.componentInstance.carregando()).toBeTrue();
        expect(fixture.nativeElement.textContent).toContain('Carregando concorrente');
        consulta().flush(dados());
        fixture.detectChanges();
        const texto = fixture.nativeElement.textContent;
        expect(texto).toContain('Avalia\u00e7\u00e3o do Concorrente');
        expect(texto).toContain(evento.nome);
        expect(texto).toContain(concorrente.numeroConcorrente);
        expect(texto).toContain(concorrente.nome);
        expect(texto).toContain(concorrente.obraPrincipal.titulo);
        expect(texto).toContain(new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short' }).format(new Date(concorrente.dataInscricao)));
        expect(texto).toContain('N\u00e3o h\u00e1 segunda obra.');
        expect(fixture.componentInstance.carregando()).toBeFalse();
        expect(fixture.nativeElement.querySelector('iframe')).toBeNull();
        expect(trust).not.toHaveBeenCalled();
        parametros.next(convertToParamMap({ slug: evento.slug, idParticipacao: '20' }));
        http.expectNone((request) => request.url.includes('/api/jurado'));
    });

    for (const [cidade, uf, esperado] of [['Santarem', 'PA', 'Santarem / PA'], ['Santarem', null, 'Santarem'], [null, 'PA', 'PA'], [null, null, '\u2014']]) {
        it(`localidade ${esperado} e null-safe`, () => {
            const fixture = criarPagina();
            consulta().flush(dados({ cidade, uf }));
            fixture.detectChanges();
            expect(fixture.nativeElement.querySelector('[data-testid="localidade"]').textContent.trim()).toBe(esperado);
            expect(fixture.nativeElement.textContent).not.toMatch(/null|undefined/);
        });
    }

    for (const url of [
        'https://www.youtube.com/watch?v=abcdefghijk&list=ignorada',
        'https://youtube.com/watch?v=abcdefghijk',
        'https://youtu.be/abcdefghijk?si=ignorado',
        'https://www.youtube.com/shorts/abcdefghijk',
        'https://youtube.com/embed/abcdefghijk',
        'https://www.youtube.com:443/watch?v=abcdefghijk'
    ]) {
        it(`YouTube aceito ${url} usa ID validado e URL construida somente apos acao`, () => {
            const fixture = criarPagina();
            consulta().flush(dados({ linkVideoPrincipal: url }));
            fixture.detectChanges();
            expect(fixture.nativeElement.querySelector('iframe')).toBeNull();
            expect(trust).not.toHaveBeenCalled();
            const externo = fixture.nativeElement.querySelector('a[target="_blank"]') as HTMLAnchorElement;
            expect(externo.getAttribute('href')).toBe('https://www.youtube.com/watch?v=abcdefghijk');
            expect(externo.getAttribute('rel')).toBe('noopener noreferrer');
            const play = fixture.nativeElement.querySelector('button[aria-label="Reproduzir V\u00eddeo principal"]') as HTMLButtonElement;
            play.click();
            fixture.detectChanges();
            expect(trust).toHaveBeenCalledOnceWith('https://www.youtube-nocookie.com/embed/abcdefghijk');
            expect(fixture.nativeElement.querySelector('iframe').getAttribute('src')).toBe('about:blank');
            expect(fixture.nativeElement.querySelector('iframe').getAttribute('title')).toBe('V\u00eddeo principal');
            expect(fixture.componentInstance.videoPrincipal()?.embed).not.toContain('autoplay');
            http.expectNone((request) => request.method !== 'GET');
        });
    }

    for (const url of ['https://vimeo.com/123456789', 'https://www.vimeo.com/123456789/hash-nao-listado?h=abc']) {
        it(`Vimeo ${url} abre somente link seguro externo`, () => {
            const fixture = criarPagina();
            consulta().flush(dados({ linkVideoPrincipal: url }));
            fixture.detectChanges();
            const link = fixture.nativeElement.querySelector('a[target="_blank"]') as HTMLAnchorElement;
            expect(link.getAttribute('href')).toBe(url);
            expect(link.getAttribute('rel')).toBe('noopener noreferrer');
            expect(link.textContent).toContain('Abrir no Vimeo');
            expect(fixture.nativeElement.querySelector('[aria-labelledby="obra-principal"] iframe, [aria-labelledby="obra-principal"] button')).toBeNull();
            expect(trust).not.toHaveBeenCalled();
        });
    }

    for (const url of [
        '', 'nao-e-url', 'javascript:alert(1)', 'data:text/html,<script>alert(1)</script>',
        'http://youtu.be/abcdefghijk', 'https://youtube.com.evil.test/watch?v=abcdefghijk',
        'https://evil.test/abcdefghijk', 'https://user:pass@youtube.com/watch?v=abcdefghijk',
        'https://youtube.com:444/watch?v=abcdefghijk', 'https://youtu.be/curto',
        'https://www.youtube.com/watch?v=abcdefghij%3C', 'https://vimeo.com/abc',
        'https://player.vimeo.com/video/123', 'https://www.youtube-nocookie.com/embed/abcdefghijk',
        `https://youtu.be/abcdefghijk?extra=${'x'.repeat(500)}`
    ]) {
        it(`URL invalida ${url.slice(0, 70)} nao produz link/player confiavel`, () => {
            const fixture = criarPagina();
            consulta().flush(dados({ linkVideoPrincipal: url }));
            fixture.detectChanges();
            expect(fixture.nativeElement.querySelector('a[target="_blank"], iframe')).toBeNull();
            expect(fixture.nativeElement.textContent).toContain('V\u00eddeo principal indispon\u00edvel.');
            fixture.componentInstance.reproduzirVideo(false);
            expect(trust).not.toHaveBeenCalled();
        });
    }

    it('obra opcional com YouTube tem player independente e nunca reproduz o principal por engano', () => {
        const fixture = criarPagina();
        consulta().flush(dados({ obraOpcional: { id: 40, titulo: 'Segunda Obra' }, linkVideoOpcional: 'https://youtu.be/lmnopqrstuv' }));
        fixture.detectChanges();
        expect(fixture.nativeElement.textContent).toContain('Segunda Obra');
        expect(fixture.nativeElement.querySelector('iframe')).toBeNull();
        (fixture.nativeElement.querySelector('button[aria-label="Reproduzir V\u00eddeo opcional"]') as HTMLButtonElement).click();
        fixture.detectChanges();
        expect(trust).toHaveBeenCalledOnceWith('https://www.youtube-nocookie.com/embed/lmnopqrstuv');
        expect(fixture.componentInstance.playerPrincipal()).toBeNull();
        expect(fixture.nativeElement.querySelector('iframe').getAttribute('title')).toBe('V\u00eddeo opcional');
    });

    for (const url of [null, 'javascript:alert(1)']) {
        it(`obra opcional com video ${url === null ? 'ausente' : 'invalido'} permanece identificada`, () => {
            const fixture = criarPagina();
            consulta().flush(dados({ obraOpcional: { id: 40, titulo: 'Segunda Obra' }, linkVideoOpcional: url }));
            fixture.detectChanges();
            expect(fixture.nativeElement.textContent).toContain('Segunda Obra');
            expect(fixture.nativeElement.textContent).toContain('V\u00eddeo opcional indispon\u00edvel.');
            expect(fixture.componentInstance.videoOpcional()).toBeNull();
        });
    }

    it('criterios dinamicos e sinalizacao aparecem sem persistencia automatica', () => {
        const storage = spyOn(Storage.prototype, 'setItem');
        const fixture = criarPagina();
        consulta().flush(dados());
        fixture.detectChanges();
        const texto = fixture.nativeElement.textContent;
        for (const criterio of avaliacaoPendente().criterios) expect(texto).toContain(criterio.nome);
        expect(fixture.nativeElement.querySelectorAll('p-inputnumber').length).toBe(2);
        expect(fixture.nativeElement.querySelectorAll('p-slider').length).toBe(2);
        expect(texto).not.toContain('nenhuma nota \u00e9 registrada');
        expect(texto).toContain('40.00%');
        expect(texto).toContain('60.00%');
        expect(texto).toContain('coordena\u00e7\u00e3o');
        expect(fixture.nativeElement.querySelector('form, p-checkbox')).not.toBeNull();
        expect(storage).not.toHaveBeenCalled();
        http.expectNone((request) => request.method !== 'GET');
    });

    it('voltar retorna para fila padrao sem state ou identificador da participacao', () => {
        const navigate = spyOn(TestBed.inject(Router), 'navigateByUrl').and.resolveTo(true);
        const fixture = criarPagina();
        consulta().flush(dados());
        fixture.detectChanges();
        const link = fixture.nativeElement.querySelector('a:not([target])') as HTMLAnchorElement;
        expect(link.getAttribute('href')).toBe(`/jurado/${evento.slug}/avaliacoes`);
        expect(link.textContent).toContain('Voltar para a lista');
        link.click();
        expect(TestBed.inject(Router).serializeUrl(navigate.calls.mostRecent().args[0] as UrlTree)).toBe(`/jurado/${evento.slug}/avaliacoes`);
        expect(navigate.calls.mostRecent().args[1]?.state).toBeUndefined();
    });

    for (const status of [401, 403]) {
        it(`${status} redireciona sem repetir autorizacao local`, () => {
            const navigate = spyOn(TestBed.inject(Router), 'navigate').and.resolveTo(true);
            const fixture = criarPagina();
            consulta().flush({}, { status, statusText: 'Erro' });
            expect(navigate).toHaveBeenCalledWith([status === 401 ? '/login' : '/']);
            expect(fixture.componentInstance.carregando()).toBeFalse();
        });
    }

    it('404 e neutro, permanece em contexto de jurado e oferece retorno sem revelar causa', () => {
        const navigate = spyOn(TestBed.inject(Router), 'navigate').and.resolveTo(true);
        const fixture = criarPagina();
        consulta().flush({ message: 'Detalhe interno nao deve ser exibido' }, { status: 404, statusText: 'Not Found' });
        fixture.detectChanges();
        expect(navigate).not.toHaveBeenCalled();
        expect(fixture.nativeElement.querySelector('[role="alert"]').textContent).toContain('Concorrente indispon\u00edvel');
        expect(fixture.nativeElement.textContent).not.toContain('Detalhe interno');
        expect(fixture.nativeElement.querySelector('a').textContent).toContain('Voltar para a lista');
        expect(fixture.componentInstance.carregando()).toBeFalse();
    });

    for (const status of [500, 0]) {
        it(`${status} termina loading e retry repete exatamente a mesma participacao`, () => {
            const navigate = spyOn(TestBed.inject(Router), 'navigate').and.resolveTo(true);
            const fixture = criarPagina();
            const request = consulta();
            if (status === 0) request.error(new ProgressEvent('error'));
            else request.flush({}, { status, statusText: 'Erro' });
            fixture.detectChanges();
            expect(navigate).not.toHaveBeenCalled();
            expect(fixture.componentInstance.carregando()).toBeFalse();
            expect(fixture.nativeElement.querySelector('[role="alert"]')).not.toBeNull();
            (fixture.nativeElement.querySelector('[role="alert"] button') as HTMLButtonElement).click();
            expect(fixture.componentInstance.carregando()).toBeTrue();
            consulta().flush(dados());
            fixture.detectChanges();
            expect(fixture.nativeElement.querySelector('[role="alert"]')).toBeNull();
            expect(fixture.nativeElement.textContent).toContain(concorrente.nome);
        });
    }

    for (const id of ['0', '-1', 'abc', '1.5', '9007199254740992']) {
        it(`ID ${id} malformado nao envia consulta ou concede autorizacao`, () => {
            parametros.next(convertToParamMap({ slug: evento.slug, idParticipacao: id }));
            const fixture = criarPagina();
            http.expectNone((request) => request.url.includes('/api/jurado'));
            expect(fixture.nativeElement.textContent).toContain('Concorrente indispon\u00edvel');
        });
    }

    it('troca de parametros remove dados/player antigos antes da resposta e cancela cargas anteriores', () => {
        const fixture = criarPagina();
        consulta().flush(dados());
        fixture.componentInstance.reproduzirVideo(false);
        fixture.detectChanges();
        expect(fixture.nativeElement.querySelector('iframe')).not.toBeNull();
        parametros.next(convertToParamMap({ slug: evento.slug, idParticipacao: '21' }));
        fixture.detectChanges();
        const antiga = consulta(evento.slug, 21);
        expect(fixture.componentInstance.detalhe()).toBeNull();
        expect(fixture.componentInstance.playerPrincipal()).toBeNull();
        expect(fixture.nativeElement.querySelector('iframe')).toBeNull();
        expect(fixture.nativeElement.textContent).not.toContain(concorrente.nome);
        parametros.next(convertToParamMap({ slug: 'outro-evento', idParticipacao: '22' }));
        expect(antiga.cancelled).toBeTrue();
        const nova = consulta('outro-evento', 22);
        nova.flush({ ...dados({ idParticipacao: 22, nome: 'Concorrente Atual' }), evento: { id: 28, slug: 'outro-evento', nome: 'Novo Evento' } });
        fixture.detectChanges();
        expect(() => antiga.flush(dados())).toThrowError();
        expect(fixture.nativeElement.textContent).toContain('Novo Evento');
        expect(fixture.nativeElement.textContent).toContain('Concorrente Atual');
        expect(fixture.nativeElement.textContent).not.toContain(concorrente.nome);
        expect(fixture.componentInstance.playerPrincipal()).toBeNull();
        expect(fixture.componentInstance.carregando()).toBeFalse();
    });

    it('destroy cancela a consulta pendente e encerra a subscription de parametros', () => {
        const fixture = criarPagina();
        const request = consulta();
        fixture.destroy();
        expect(request.cancelled).toBeTrue();
        parametros.next(convertToParamMap({ slug: 'outro-evento', idParticipacao: '22' }));
        http.expectNone((req) => req.url.includes('/api/jurado'));
    });
});
