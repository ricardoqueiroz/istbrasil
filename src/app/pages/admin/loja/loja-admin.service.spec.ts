import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { LojaAdminErro, LojaAdminService } from './loja-admin.service';
import { LivrosAdminResposta } from './loja-admin.model';

describe('LojaAdminService somente GET', () => {
    let api: LojaAdminService;
    let http: HttpTestingController;
    const url = '/api/admin/loja/livros';
    const resposta: LivrosAdminResposta = { itens: [{ id: 1, author: null, currency: 'BRL', sku: null, price: null, onsale: 1, inventory: 'Em estoque', produtoTipo: null, title: null, description: null, language: null,
        format: 'Formato legado', category: null, img: null, pertenceEditoraIst: null, produtoId: null, revisao: 'opaca' }],
        paginacao: { pagina: 1, limite: 20, total: 1 } };
    beforeEach(() => {
        TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
        api = TestBed.inject(LojaAdminService); http = TestBed.inject(HttpTestingController);
    });
    afterEach(() => http.verify());
    it('usa endpoint relativo, credenciais e preserva nullable/legados sem headers de escrita', () => {
        api.listarLivros({}).subscribe(v => expect(v).toEqual(resposta));
        const r = http.expectOne(url);
        expect(r.request.method).toBe('GET'); expect(r.request.withCredentials).toBeTrue();
        expect(r.request.body).toBeNull(); expect(r.request.headers.has('Authorization')).toBeFalse();
        expect(r.request.headers.has('X-CSRF-Token')).toBeFalse(); r.flush(resposta);
    });
    for (const author of ['Autor IST', null]) it(`preserva author ${author} na listagem e no detalhe`, () => {
        const item = {...resposta.itens[0], author};
        api.listarLivros({pagina: 1, limite: 20}).subscribe(v => expect(v.itens[0].author).toBe(author));
        http.expectOne(r => r.url === url).flush({...resposta, itens: [item]});
        api.obterLivro(1).subscribe(v => expect(v.author).toBe(author));
        http.expectOne(url+'/1').flush({item: {...item, comercial: null, versoesPdf: []}});
    });
    it('preserva dois rascunhos historicos no detalhe sem links ou conteudo privado', () => {
        const versoesPdf = [
            {versaoPublicId:'11111111-1111-4111-8111-111111111111',numeroVersao:1,estado:'RASCUNHO'},
            {versaoPublicId:'22222222-2222-4222-8222-222222222222',numeroVersao:2,estado:'RASCUNHO'}
        ];
        api.obterLivro(1).subscribe(v=>expect(v.versoesPdf).toEqual(versoesPdf as NonNullable<typeof v.versoesPdf>));
        http.expectOne(url+'/1').flush({item:{...resposta.itens[0],comercial:null,versoesPdf}});
    });
    it('mapeia 409 de rascunho existente sem repetir upload', () => {
        const erro=jasmine.createSpy('erro');
        api.enviarPdf(1,new File(['%PDF-1.7'],'sintetico.pdf',{type:'application/pdf'}),'"'+'a'.repeat(64)+'"').subscribe({error:erro});
        http.expectOne(r=>r.url===url).flush({itens:[]},{headers:{'X-CSRF-Token':'1234567890123.'+'a'.repeat(43)+'.'+'b'.repeat(43)}});
        http.expectOne(url+'/1/pdf').flush({erro:{codigo:'ADMIN_RASCUNHO_EXISTENTE',mensagem:'SEGREDO'}},{status:409,statusText:'Conflict'});
        expect(erro).toHaveBeenCalledTimes(1);
        expect(erro.calls.mostRecent().args[0].status).toBe(409);
        expect(erro.calls.mostRecent().args[0].message).not.toContain('SEGREDO');
    });
    for (const valor of [undefined, true, false, null]) it(`serializa classificacao ${valor} sem confundir ausencia`, () => {
        api.listarLivros({ pagina: 2, limite: 50, busca: "  %_!'  ", pertenceEditoraIst: valor }).subscribe();
        const r = http.expectOne(q => q.url === url);
        expect(r.request.params.get('pagina')).toBe('2'); expect(r.request.params.get('limite')).toBe('50');
        expect(r.request.params.get('busca')).toBe("%_!'");
        expect(r.request.params.get('pertenceEditoraIst')).toBe(valor === undefined ? null : String(valor));
        expect(r.request.params.keys().sort()).toEqual(['pagina', 'limite', 'busca', ...(valor === undefined ? [] : ['pertenceEditoraIst'])].sort());
        r.flush({ itens: [], paginacao: { pagina: 2, limite: 50, total: 0 } });
    });
    it('omite busca vazia', () => {
        api.listarLivros({ busca: '   ' }).subscribe(); const r = http.expectOne(url);
        expect(r.request.params.has('busca')).toBeFalse();
        r.flush({ itens: [], paginacao: { pagina: 1, limite: 20, total: 0 } });
    });
    for(const status of [400,409,412,428,503]) it(`prioriza mensagem administrativa segura em ${status}`,()=>{
        const falha=jasmine.createSpy();api.listarLivros({}).subscribe({error:falha});
        http.expectOne(url).flush({erro:{codigo:'ADMIN_ENTRADA_INVALIDA',mensagem:'Confira os campos informados.'}},{status,statusText:'Erro'});
        expect(falha).toHaveBeenCalledTimes(1);expect(falha.calls.mostRecent().args[0].message).toBe('Confira os campos informados.');
    });
    it('POST SKU duplicado exibe mensagem especifica, com acento, uma unica vez',()=>{
        const falha=jasmine.createSpy();
        api.criarLivro({title:'Livro',format:'E-Book',categoriaId:1,sku:'SKU',price:'10.00',pertenceEditoraIst:true}).subscribe({error:falha});
        http.expectOne(r=>r.url===url).flush({itens:[]},{headers:{'X-CSRF-Token':'1234567890123.'+'a'.repeat(43)+'.'+'b'.repeat(43)}});
        http.expectOne(url).flush({erro:{codigo:'ADMIN_SKU_DUPLICADO',mensagem:'SKU comercial ja cadastrado. Informe outro SKU.'}},{status:409,statusText:'Conflict'});
        expect(falha).toHaveBeenCalledTimes(1);
        expect(falha.calls.mostRecent().args[0].message).toBe('SKU comercial j\u00e1 cadastrado. Informe outro SKU.');
    });
    for(const mensagem of ['<html>Falha</html>','SELECT id FROM usuarios','Falha em C:\\privado\\arquivo','/privado/arquivo.pdf','Error stack: segredo'])
        it('rejeita detalhes internos na mensagem da API',()=>{
            const falha=jasmine.createSpy();api.listarLivros({}).subscribe({error:falha});
            http.expectOne(url).flush({erro:{codigo:'ADMIN_ENTRADA_INVALIDA',mensagem}},{status:400,statusText:'Erro'});
            expect(falha.calls.mostRecent().args[0].message).not.toBe(mensagem);
        });
    for (const status of [400, 401, 403, 503, 500]) it(`trata ${status} sem refletir detalhes nem fabricar sucesso`, () => {
        const falha = jasmine.createSpy('falha');
        api.listarLivros({}).subscribe({ next: () => fail('Erro nao e lista vazia'), error: falha });
        http.expectOne(url).flush({ erro: { codigo: 'INTERNO', mensagem: 'SEGREDO SQL' } }, { status, statusText: 'Erro' });
        expect(falha).toHaveBeenCalledTimes(1);
        const e = falha.calls.mostRecent().args[0] as LojaAdminErro;
        expect(e.status).toBe(status); expect(e.message).not.toContain('SEGREDO');
    });
    it('publicacao explicita envia CSRF, revisao e publicacao esperada, sem comando comercial',()=>{
        const versao='11111111-1111-4111-8111-111111111111';
        const livro={...resposta.itens[0],versoesPdf:[{versaoPublicId:versao,numeroVersao:1,estado:'RASCUNHO' as const}]};
        const token='1234567890123.'+'a'.repeat(43)+'.'+'b'.repeat(43);
        api.publicarPdf(livro,versao).subscribe();
        http.expectOne(r=>r.url===url&&r.params.get('limite')==='1').flush({}, {headers:{'X-CSRF-Token':token}});
        const r=http.expectOne(`${url}/1/versoes-pdf/${versao}/publicar`);
        expect(r.request.withCredentials).toBeTrue();expect(r.request.body).toEqual({publicacaoAtualEsperada:null});
        expect(r.request.headers.get('If-Match')).toBe(livro.revisao);expect(r.request.headers.get('X-CSRF-Token')).toBe(token);
        r.flush({item:{versaoPublicId:versao,numeroVersao:1,estado:'PUBLICADA'}});
    });
    it('trata erro de rede sem retry', () => {
        api.listarLivros({}).subscribe({ error: (e: LojaAdminErro) => expect(e.status).toBe(0) });
        http.expectOne(url).error(new ProgressEvent('error'));
    });
    for (const v of [null, {}, { itens: [], paginacao: { pagina: 0, limite: 20, total: 0 } },
        { itens: [{}], paginacao: { pagina: 1, limite: 20, total: 1 } }]) it('rejeita resposta inesperada', () => {
        const erro = jasmine.createSpy(); api.listarLivros({}).subscribe({ next: () => fail('Contrato invalido'), error: erro });
        http.expectOne(url).flush(v); expect(erro).toHaveBeenCalledTimes(1);
        expect(erro.calls.mostRecent().args[0].status).toBe(502);
    });
});
