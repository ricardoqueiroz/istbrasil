import {of,throwError,Subject} from 'rxjs';
import {ActivatedRoute,Router,convertToParamMap} from '@angular/router';
import {LojaAdminService,LojaAdminErro} from '../loja-admin.service';
import {FormularioLivroComponent} from './formulario-livro.component';
import {LivroAdmin} from '../loja-admin.model';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed, fakeAsync, tick } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { ListarLivrosComponent } from './listar-livros.component';
import adminRoutes from '../../admin.routes';
import { adminGuard } from '../../../../guards/admin.guard';

describe('Listagem administrativa de Livros', () => {
    let fixture: ComponentFixture<ListarLivrosComponent>;
    let c: ListarLivrosComponent;
    let http: HttpTestingController;
    const url = '/api/admin/loja/livros';
    const dto = (total = 0) => ({ itens: total ? [{ id: 1, author: null, currency: 'BRL', sku: null, price: null, onsale: 1, inventory: 'Em estoque', produtoTipo: null, title: 'Livro sintético', description: null, language: null,
        category: null, format: 'Legado', img: null, pertenceEditoraIst: null, produtoId: null, revisao: 'opaca' }] : [],
        paginacao: { pagina: 1, limite: 20, total } });
    const requisicao = () => http.expectOne(r => r.url === url);
    beforeEach(() => {
        TestBed.configureTestingModule({ imports: [ListarLivrosComponent], providers: [provideRouter([]),
            provideNoopAnimations(), provideHttpClient(), provideHttpClientTesting()] });
        http = TestBed.inject(HttpTestingController); fixture = TestBed.createComponent(ListarLivrosComponent);
        c = fixture.componentInstance; fixture.detectChanges();
    });
    afterEach(() => { fixture.destroy(); http.verify(); });
    it('mostra carregamento, sucesso e classificacao nullable', () => {
        expect(c.carregando()).toBeTrue(); expect(fixture.nativeElement.textContent).toContain('Carregando');
        requisicao().flush(dto(1)); fixture.detectChanges();
        expect(c.carregando()).toBeFalse(); expect(fixture.nativeElement.textContent).toContain('Livro sintético');
        expect(fixture.nativeElement.textContent).toContain('Não informado');
        expect(c.classificar(true)).toBe('Sim'); expect(c.classificar(false)).toBe('Não');
        expect(c.classificar(null)).toBe('Não informado');
    });
    it('mostra vazio sem confundir com erro', () => {
        requisicao().flush(dto()); fixture.detectChanges();
        expect(fixture.nativeElement.textContent).toContain('Nenhum livro encontrado'); expect(c.erro()).toBeNull();
    });
    it('publicacao exige selecao explicita inclusive com multiplos rascunhos e impede clique duplicado',()=>{
        requisicao().flush(dto());
        const livro={...dto(1).itens[0],versoesPdf:[{versaoPublicId:'a',numeroVersao:1,estado:'RASCUNHO' as const},
            {versaoPublicId:'b',numeroVersao:2,estado:'RASCUNHO' as const}]} as LivroAdmin;
        const pendente=new Subject<unknown>(),api=TestBed.inject(LojaAdminService);
        const publicar=spyOn(api,'publicarPdf').and.returnValue(pendente);
        c.abrirPublicacao(livro);expect(c.versaoPublicacao).toBeNull();expect(c.opcoesPublicacao.length).toBe(2);
        c.publicar();expect(publicar).not.toHaveBeenCalled();
        c.versaoPublicacao='a';c.publicar();c.publicar();expect(publicar).toHaveBeenCalledOnceWith(livro,'a');
        expect(c.publicando()).toBeTrue();pendente.next({});pendente.complete();
        expect(c.sucesso()).toContain('PDF publicado');expect(c.livroPublicacao).toBeNull();requisicao().flush(dto());
    });
    it('mostra erro sanitizado e permite nova tentativa', () => {
        requisicao().flush({ erro: { mensagem: 'SEGREDO' } }, { status: 503, statusText: 'Erro' }); fixture.detectChanges();
        expect(c.erro()).toContain('indisponível'); expect(fixture.nativeElement.textContent).not.toContain('SEGREDO');
        c.recarregar(); expect(c.erro()).toBeNull(); expect(c.carregando()).toBeTrue();
        requisicao().flush(dto(1)); expect(c.dados()?.paginacao.total).toBe(1);
    });
    it('converte pagina e reinicia ao trocar tamanho', () => {
        requisicao().flush(dto()); c.paginar({ first: 40, rows: 20 });
        let r = requisicao(); expect(r.request.params.get('pagina')).toBe('3'); r.flush(dto());
        c.paginar({ first: 100, rows: 50 }); r = requisicao();
        expect(r.request.params.get('pagina')).toBe('1'); expect(r.request.params.get('limite')).toBe('50'); r.flush(dto());
    });
    it('reinicia pagina nos filtros e distingue todos de NULL', () => {
        requisicao().flush(dto()); c.first = 40;
        for (const [f, valor] of [['nulo', 'null'], ['sim', 'true'], ['nao', 'false'], ['todos', null]]) {
            c.filtrar(f!); const r = requisicao(); expect(c.first).toBe(0);
            expect(r.request.params.get('pertenceEditoraIst')).toBe(valor); r.flush(dto());
        }
    });
    it('aplica debounce na busca e reinicia pagina', fakeAsync(() => {
        requisicao().flush(dto()); c.first = 40; c.buscar('  Sintético  ');
        tick(399); http.expectNone(r => r.url === url); tick(1);
        const r = requisicao(); expect(r.request.params.get('busca')).toBe('Sintético');
        expect(r.request.params.get('pagina')).toBe('1'); r.flush(dto());
    }));
    it('cancela consulta obsoleta, atualiza somente a recente e encerra no destroy', () => {
        const antiga = requisicao(); c.filtrar('sim'); expect(antiga.cancelled).toBeTrue();
        const atual = requisicao(); atual.flush(dto(1)); expect(c.dados()?.paginacao.total).toBe(1);
        c.recarregar(); const final = requisicao(); fixture.destroy(); expect(final.cancelled).toBeTrue();
    });
    it('rota lazy preserva guard e nao oferece operacoes de escrita', async () => {
        requisicao().flush(dto());
        const rota = adminRoutes[0].children?.find(r => r.path === 'loja/livros');
        expect(rota?.canActivate).toEqual([adminGuard]);
        expect(await (rota!.loadComponent! as () => Promise<unknown>)()).toBe(ListarLivrosComponent);
        expect(fixture.nativeElement.querySelectorAll('a[href*="editar"],input[type="file"]').length).toBe(0);
        c.recarregar(); const r = requisicao(); expect(r.request.method).toBe('GET'); r.flush(dto());
    });
});


describe('Formulario de livros: mensagens e estados PDF isolados',()=>{
    let fixture: ComponentFixture<FormularioLivroComponent>;
    let api: jasmine.SpyObj<LojaAdminService>;
    const livro=(): LivroAdmin=>({id:6,title:'Livro',author:null,currency:'BRL',description:null,language:null,format:'E-Book',
        category:'Musica',img:null,pertenceEditoraIst:true,produtoId:7,produtoTipo:'DIGITAL',sku:'SKU',price:'10.00',onsale:1,inventory:'Em estoque',
        revisao:'"'+'a'.repeat(64)+'"',comercial:null,versoesPdf:[]});
    const criar=(id: string | null='6',respostas=[of(livro())])=>{
        api=jasmine.createSpyObj<LojaAdminService>('api',['obterLivro','listarCategorias','criarLivro','obterElegibilidade','atualizarLivro']);
        api.obterElegibilidade.and.returnValue(of(false));
        api.obterLivro.and.returnValues(...respostas);
        api.listarCategorias.and.returnValue(of([{id:1,nome:'Musica',ativo:true,categoriaPaiId:null,ordem:0}]));
        TestBed.configureTestingModule({imports:[FormularioLivroComponent],providers:[provideRouter([]),provideNoopAnimations(),
            {provide:ActivatedRoute,useValue:{snapshot:{paramMap:convertToParamMap(id?{id}:{}),queryParamMap:convertToParamMap({})}}},
            {provide:LojaAdminService,useValue:api}]});
        fixture=TestBed.createComponent(FormularioLivroComponent);fixture.detectChanges();return fixture.componentInstance;
    };
    afterEach(()=>fixture?.destroy());
    it('encerra consulta sem rascunho e permite envio',()=>{
        const c=criar();expect(c.estadoPdf()).toBe('SEM_RASCUNHO');expect(c.podeEnviarNovoPdf()).toBeTrue();
    });
    it('situacao comercial envia somente emVenda e mostra inelegibilidade calculada no backend',()=>{
        const item={...livro(),comercial:{id:7,categoriaId:1,sku:'SKU',precoCentavos:1000,tipo:'DIGITAL',autor:null,
            titulo:'Livro',descricao:null,imagemUrl:null,ativo:true,emVenda:false,disponivel:true,revisao:'"'+'b'.repeat(64)+'"'}};
        const c=criar('6',[of(item)]);api.atualizarLivro.and.returnValue(throwError(()=>new LojaAdminErro(412)));
        c.emVenda=true;fixture.detectChanges();
        expect(fixture.nativeElement.textContent).toContain('ainda não elegível');c.salvar();
        expect(api.atualizarLivro).toHaveBeenCalledOnceWith(6,{comercial:{emVenda:true}},item.revisao,item.comercial.revisao);
    });
    it('encerra consulta com rascunho e bloqueia envio',()=>{
        const c=criar('6',[of({...livro(),versoesPdf:[{versaoPublicId:'v1',numeroVersao:1,estado:'RASCUNHO'}]})]);
        expect(c.estadoPdf()).toBe('COM_RASCUNHO');expect(c.podeEnviarNovoPdf()).toBeFalse();
    });
    it('metadados ausentes viram erro, permitem retry e preservam campos nao salvos',()=>{
        const c=criar('6',[of({...livro(),versoesPdf:undefined}),of(livro())]);
        expect(c.estadoPdf()).toBe('ERRO');expect(c.podeEnviarNovoPdf()).toBeFalse();
        expect(fixture.nativeElement.textContent).toContain('Tentar consultar versoes novamente');
        c.valores.title='Nao salvo';c.atualizarVersoesPdf();expect(c.estadoPdf()).toBe('SEM_RASCUNHO');expect(c.valores.title).toBe('Nao salvo');
    });
    it('falha de consulta finaliza carregamento e permite tentar novamente',()=>{
        const c=criar('6',[of(livro()),throwError(()=>new LojaAdminErro(503)),of(livro())]);
        c.atualizarVersoesPdf();expect(c.estadoPdf()).toBe('ERRO');expect(c.podeEnviarNovoPdf()).toBeFalse();
        c.atualizarVersoesPdf();expect(c.estadoPdf()).toBe('SEM_RASCUNHO');
    });
    it('consulta pendente bloqueia upload ate a resposta',()=>{
        const pendente=new Subject<LivroAdmin>();const c=criar('6',[of(livro()),pendente]);
        c.atualizarVersoesPdf();expect(c.estadoPdf()).toBe('CARREGANDO');expect(c.podeEnviarNovoPdf()).toBeFalse();
        pendente.next(livro());pendente.complete();expect(c.estadoPdf()).toBe('SEM_RASCUNHO');
    });
    const preencher=(c: FormularioLivroComponent)=>{c.mudar('title','Livro');c.mudar('sku','SKU');c.mudarPreco('10,00');c.selecionarCategoria(1);};
    it('POST 409 aparece uma unica vez junto ao Salvar',()=>{
        const c=criar(null);preencher(c);const e=new LojaAdminErro(409,false,'SKU comercial j\u00e1 cadastrado. Informe outro SKU.');
        api.criarLivro.and.returnValue(throwError(()=>e));c.salvar();fixture.detectChanges();
        const mensagens=fixture.nativeElement.querySelectorAll('p-message[severity="error"]');expect(mensagens.length).toBe(1);
        expect(mensagens[0].textContent).toContain(e.message);
    });
    it('cadastro confirmado navega para edicao do livro persistido',()=>{
        const c=criar(null);preencher(c);api.criarLivro.and.returnValue(of(livro()));
        const navegar=spyOn(TestBed.inject(Router),'navigate').and.resolveTo(true);c.salvar();
        expect(navegar).toHaveBeenCalledOnceWith(['/admin/loja/livros',6,'editar']);
    });
});
