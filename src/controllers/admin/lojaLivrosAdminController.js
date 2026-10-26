import {criarProduto,atualizarProduto,excluirProdutoSePermitido,bloquearCategoriasProduto,bloquearProdutoDoLivro,lerProdutoDoLivro,projetarProdutoDoLivro,sincronizarComandoLivro,nomeCategoriaDoLivro} from '../../services/lojaAdminProdutosService.js';
import {pool} from '../../config/db.js';
import {validarConsultaAdmin,validarIdAdmin,validarEntradaAdmin,projetarRevisaoAdmin,criarEtagAdmin,conferirIfMatchAdmin} from '../../services/lojaAdminContratos.js';

const campos=`l.id,l.title,l.author AS author,l.currency,l.description,l.language,l.format,l.category,l.img,
    l.pertence_editora_ist,l.sku,l.price,l.onsale,l.inventory,p.id AS produto_id,p.tipo AS produto_tipo`;
const selecaoLivro='SELECT id,title,author,currency,description,language,format,category,img,pertence_editora_ist,sku,price,onsale,inventory FROM ist_livros WHERE id=?';
const origem='FROM ist_livros l LEFT JOIN ist_loja_produtos p ON p.livro_id=l.id';
const imagemPublica=v=>typeof v==='string'&&/^\/?assets\/images\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.(png|jpe?g|webp|avif|gif)$/i.test(v)?v:null;
const editorialPersistido=l=>projetarRevisaoAdmin('livros',{title:l.title,author:l.author,currency:l.currency,description:l.description,
        language:l.language,format:l.format,category:l.category,img:l.img,
        pertenceEditoraIst:l.pertence_editora_ist===null?null:Number(l.pertence_editora_ist)===1,
        sku:l.sku,price:l.price,onsale:l.onsale===null?null:Number(l.onsale),inventory:l.inventory});
const mapear=l=>{
    const editorial=editorialPersistido(l);
    return {id:Number(l.id),...editorial,img:imagemPublica(l.img),
        produtoId:l.produto_id===null?null:Number(l.produto_id),
        produtoTipo:l.produto_tipo??null,
        revisao:criarEtagAdmin('livros',Number(l.id),editorial)};
};

const lerVersoesPdf=async(c,produtoId)=>{
    if(!produtoId)return [];
    const [rows]=await c.query(`SELECT public_id AS versaoPublicId,numero_versao AS numeroVersao,estado
        FROM ist_loja_arquivo_versoes WHERE produto_id=? ORDER BY numero_versao DESC`,[produtoId]);
    return rows.map(r=>({versaoPublicId:r.versaoPublicId,numeroVersao:Number(r.numeroVersao),estado:r.estado}));
};

const descricaoComAutor=(texto,autor,criar=false)=>{
    if(texto===null||texto===undefined)return criar?JSON.stringify({'Autor:':autor??''}):null;
    try{
        const obj=JSON.parse(texto);
        if(!obj||typeof obj!=='object'||Array.isArray(obj))return texto;
        delete obj.Autor;delete obj.Author;delete obj['Author:'];
        obj['Autor:']=autor??'';return JSON.stringify(obj);
    }catch{return texto;}
};

export const criarLojaLivrosAdminController=({db=pool}={})=>{
    const ler=async operacao=>{
        const c=await db.getConnection();
        try {
            await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
            await c.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
            const resultado=await operacao(c);
            await c.commit();return resultado;
        } catch(e) {
            try {await c.rollback();} catch {} // Nunca substituir o erro por detalhes do rollback.
            throw e;
        } finally {c.release();}
    };
    return {
        async prepararPublicacao(req,res,next){
            try{
                const id=validarIdAdmin(req.params.id),versao=req.params.versaoPublicId;
                const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
                const body=req.body;
                if(Object.keys(req.query).length||!uuid(versao)||!body||Array.isArray(body)
                    ||Object.keys(body).length!==1||!Object.hasOwn(body,'publicacaoAtualEsperada')
                    ||!(body.publicacaoAtualEsperada===null||uuid(body.publicacaoAtualEsperada)))
                    throw Object.assign(Error('ENTRADA_INVALIDA'),{statusAdmin:400});
                const item=await ler(async c=>{
                    const [rows]=await c.query(`SELECT ${campos} ${origem} WHERE l.id=?`,[id]);
                    return rows.length?mapear(rows[0]):null;
                });
                if(!item)throw Object.assign(Error('AUSENTE'),{statusAdmin:404});
                conferirIfMatchAdmin(req.get('If-Match'),item.revisao);
                if(item.format!=='E-Book'||item.produtoTipo!=='DIGITAL'||!item.produtoId)
                    throw Object.assign(Error('PDF_NAO_ELEGIVEL'),{statusAdmin:409});
                req.publicacaoPdfAdmin={livroId:id,produtoId:item.produtoId,versaoPublicId:versao,
                    publicacaoAtualEsperada:body.publicacaoAtualEsperada};next();
            }catch(e){next(e);}
        },
        async criarLivro(req,res,next){
            let c,commitIniciado=false,commitConfirmado=false,descartar=false;
            try{
                if(Object.keys(req.query).length)throw Object.assign(Error('CONSULTA_INVALIDA'),{statusAdmin:400});
                const dados=validarEntradaAdmin('livros','POST',req.body);
                c=await db.getConnection();
                await c.query('START TRANSACTION READ WRITE');
                const categoriaId=dados.categoriaId??dados.comercial.categoriaId;
                await bloquearCategoriasProduto(c,[categoriaId],categoriaId);
                {
                    const nome=await nomeCategoriaDoLivro(c,categoriaId);
                    if(dados.category!==undefined&&dados.category!==nome)throw Object.assign(Error('CATEGORIA_DIVERGENTE'),{statusAdmin:400});
                    dados.category=nome;validarEntradaAdmin('livros','PATCH',{category:nome});
                }
                const [colunas]=await c.query(`SELECT DATA_TYPE,NUMERIC_PRECISION,NUMERIC_SCALE,IS_NULLABLE
                    FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='ist_livros' AND COLUMN_NAME='price'`);
                const price=colunas[0];
                if(colunas.length!==1||price.DATA_TYPE!=='decimal'||Number(price.NUMERIC_PRECISION)!==5
                    ||Number(price.NUMERIC_SCALE)!==2||!['YES','NO'].includes(price.IS_NULLABLE))throw Error('SCHEMA_PRICE_INCOMPATIVEL');
                if(price.IS_NULLABLE==='NO'&&dados.price==null)
                    throw Object.assign(Error('PRECO_OBRIGATORIO'),{statusAdmin:400,codigoAdmin:'ADMIN_PRECO_OBRIGATORIO'});
                const comando=sincronizarComandoLivro(dados,dados.comercial);
                if(dados.description!=null||Object.hasOwn(dados,'author')){dados.description=descricaoComAutor(dados.description,dados.author??null,Object.hasOwn(dados,'author'));validarEntradaAdmin('livros','PATCH',{description:dados.description});}

                // No DDL, cache or invented legacy price. Fail closed on incompatible schema.
                const nomes=['title','format','category','pertence_editora_ist','price'];
                const valores=[dados.title,dados.format,dados.category,dados.pertenceEditoraIst===null?null:dados.pertenceEditoraIst?1:0,dados.price??null];
                for(const campo of ['author','currency','language','img','description','sku','onsale','inventory'])if(Object.hasOwn(dados,campo)){
                    nomes.push(campo);valores.push(dados[campo]);
                }
                const [insercao]=await c.query(`INSERT INTO ist_livros (${nomes.join(',')}) VALUES (${nomes.map(()=>'?').join(',')})`,valores);
                const id=Number(insercao.insertId);
                if(!Number.isSafeInteger(id)||id<1||id>2147483647)throw Error('ID_INSERCAO_INVALIDO');
                const [rows]=await c.query(selecaoLivro,[id]);
                if(rows.length!==1)throw Error('RELEITURA_INVALIDA');
                const produto=await criarProduto(c,{...dados,id,comercial:comando,sincronizado:!dados.comercial},categoriaId);
                if(!produto)throw Error('RELEITURA_PRODUTO_INVALIDA');
                const item={...mapear({...rows[0],produto_id:produto.id,produto_tipo:produto.tipo}),comercial:projetarProdutoDoLivro(produto)};
                commitIniciado=true;await c.commit();commitConfirmado=true;
                res.status(201).json({item});
            }catch(e){
                if(c&&!commitIniciado)try{await c.rollback();}catch{descartar=true;}
                next(!commitIniciado&&e?.errno===1062?Object.assign(Error('SKU_DUPLICADO'),{statusAdmin:409,codigoAdmin:'ADMIN_SKU_DUPLICADO'}):e);
            }finally{
                if(c){if(descartar||(commitIniciado&&!commitConfirmado))c.destroy();else c.release();}
            }
        },
        async excluirLivro(req,res,next){
            let c,commitIniciado=false,commitConfirmado=false,descartar=false;
            try{
                const id=validarIdAdmin(req.params.id),tag=req.get('If-Match');
                if(Object.keys(req.query).length||req.get('Transfer-Encoding')
                    ||(req.get('Content-Length')!==undefined&&req.get('Content-Length')!=='0')
                    ||(req.body!==undefined))throw Object.assign(Error('ENTRADA_INVALIDA'),{statusAdmin:400});
                conferirIfMatchAdmin(tag,tag);
                c=await db.getConnection();await c.query('START TRANSACTION READ WRITE');
                const produto=await bloquearProdutoDoLivro(c,id);
                const [rows]=await c.query(selecaoLivro+' FOR UPDATE',[id]);
                if(!rows.length)throw Object.assign(Error('AUSENTE'),{statusAdmin:404});
                conferirIfMatchAdmin(tag,criarEtagAdmin('livros',id,editorialPersistido(rows[0])));
                await excluirProdutoSePermitido(c,id,produto,req.get('If-Match-Produto'));
                await c.query('DELETE FROM ist_livros WHERE id=?',[id]);
                commitIniciado=true;await c.commit();commitConfirmado=true;
                res.status(204).end();
            }catch(e){
                if(c&&!commitIniciado)try{await c.rollback();}catch{descartar=true;}
                // FK is the final barrier, including concurrent associations. Never cascade.
                if(!commitIniciado&&(e?.errno===1451||e?.code==='ER_ROW_IS_REFERENCED_2'))
                    next(Object.assign(Error('LIVRO_VINCULADO'),{statusAdmin:409}));
                else next(e);
            }finally{
                if(c){if(descartar||(commitIniciado&&!commitConfirmado))c.destroy();else c.release();}
            }
        },
        async atualizarLivro(req,res,next){
            let c,commitIniciado=false,commitConfirmado=false,descartar=false;
            try {
                const id=validarIdAdmin(req.params.id);
                if(Object.keys(req.query).length)throw Object.assign(Error('CONSULTA_INVALIDA'),{statusAdmin:400});
                const entrada=validarEntradaAdmin('livros','PATCH',req.body),{comercial,categoriaId,...dados}=entrada,tag=req.get('If-Match');
                if(comercial)conferirIfMatchAdmin(req.get('If-Match-Produto'),req.get('If-Match-Produto'));
                // Validar presenca/formato antes de reservar conexao; comparar valor sob lock.
                conferirIfMatchAdmin(tag,tag);
                c=await db.getConnection();
                await c.query('START TRANSACTION READ WRITE');
                let produto=await bloquearProdutoDoLivro(c,id,categoriaId??comercial?.categoriaId);
                const selecao=selecaoLivro;
                const [rows]=await c.query(selecao+' FOR UPDATE',[id]);
                if(!rows.length)throw Object.assign(Error('AUSENTE'),{statusAdmin:404});
                const atual=editorialPersistido(rows[0]);
                conferirIfMatchAdmin(tag,criarEtagAdmin('livros',id,atual));
                if(categoriaId??comercial?.categoriaId){
                    const nome=await nomeCategoriaDoLivro(c,categoriaId??comercial.categoriaId);
                    if(dados.category!==undefined&&dados.category!==nome)throw Object.assign(Error('CATEGORIA_DIVERGENTE'),{statusAdmin:400});
                    dados.category=nome;validarEntradaAdmin('livros','PATCH',{category:nome});
                }
                if(produto&&dados.category!==undefined&&dados.category!==atual.category&&!(categoriaId??comercial?.categoriaId))
                    throw Object.assign(Error('INFORME_CATEGORIA_ID'),{statusAdmin:400});
                if(Object.hasOwn(dados,'description')||Object.hasOwn(dados,'author')){
                    const descricao=dados.description===undefined?rows[0].description:dados.description;
                    const nova=descricaoComAutor(descricao,Object.hasOwn(dados,'author')?dados.author:rows[0].author,Object.hasOwn(dados,'author'));
                    if(nova!==descricao||Object.hasOwn(dados,'description')){dados.description=nova;validarEntradaAdmin('livros','PATCH',{description:nova});}
                }
                const comando=produto?sincronizarComandoLivro({...dados,...(categoriaId?{categoriaId}:{})},comercial):comercial;
                const mudaComercial=comando&&Object.keys(comando).length>0;
                if(mudaComercial){
                    if(!produto)throw Object.assign(Error('PRODUTO_AUSENTE'),{statusAdmin:409});
                    conferirIfMatchAdmin(req.get('If-Match-Produto'),projetarProdutoDoLivro(produto).revisao);
                }
                if(Object.hasOwn(dados,'format')&&dados.format!==atual.format){
                    if(produto)throw Object.assign(Error('FORMATO_VINCULADO'),{statusAdmin:409});
                }
                const colunas={title:'title',author:'author',currency:'currency',language:'language',category:'category',img:'img',pertenceEditoraIst:'pertence_editora_ist',
                    format:'format',description:'description',sku:'sku',price:'price',onsale:'onsale',inventory:'inventory'};
                const alterados=Object.keys(dados).filter(k=>dados[k]!==atual[k]);
                if(alterados.length){
                    const valores=alterados.map(k=>k==='pertenceEditoraIst'&&dados[k]!==null?(dados[k]?1:0):dados[k]);
                    await c.query(`UPDATE ist_livros SET ${alterados.map(k=>colunas[k]+'=?').join(',')} WHERE id=?`,[...valores,id]);
                }
                const [depois]=await c.query(selecao,[id]);
                if(!depois.length)throw Error('RELEITURA_INVALIDA');
                if(mudaComercial)produto=await atualizarProduto(c,produto,comando,req.get('If-Match-Produto'));
                const item={...mapear({...depois[0],produto_id:produto?.id??null,produto_tipo:produto?.tipo??null}),comercial:projetarProdutoDoLivro(produto)};
                commitIniciado=true;await c.commit();commitConfirmado=true;
                res.json({item});
            } catch(e){
                // COMMIT incerto nao autoriza rollback/repeticao improvisados.
                if(c&&!commitIniciado)try{await c.rollback();}catch{descartar=true;}
                next(!commitIniciado&&[1062,1451,1452].includes(e?.errno)?Object.assign(Error('CONFLITO_COMERCIAL'),{statusAdmin:409,codigoAdmin:e.errno===1062?'ADMIN_SKU_DUPLICADO':'ADMIN_CONFLITO_COMERCIAL'}):e);
            } finally {
                if(c){
                    // Nao devolver ao pool uma sessao com resultado transacional desconhecido.
                    if(descartar||(commitIniciado&&!commitConfirmado))c.destroy();else c.release();
                }
            }
        },
        async conferirPdf(req,res,next){
            try{
                const id=validarIdAdmin(req.params.id);
                if(Object.keys(req.query).length)throw Object.assign(Error('ENTRADA_INVALIDA'),{statusAdmin:400});
                const item=await ler(async c=>{
                    const [rows]=await c.query(`SELECT ${campos} ${origem} WHERE l.id=?`,[id]);
                    return rows.length?{...mapear(rows[0]),versoesPdf:rows[0].produto_tipo==='DIGITAL'?await lerVersoesPdf(c,Number(rows[0].produto_id)):[]}:null;
                });
                if(!item)throw Object.assign(Error('AUSENTE'),{statusAdmin:404});
                conferirIfMatchAdmin(req.get('If-Match'),item.revisao);
                if(item.format!=='E-Book'||item.produtoTipo!=='DIGITAL'||!item.produtoId)
                    throw Object.assign(Error('PDF_NAO_ELEGIVEL'),{statusAdmin:400});
                if(item.versoesPdf.some(v=>v.estado==='RASCUNHO'))
                    throw Object.assign(Error('ADMIN_RASCUNHO_EXISTENTE'),{statusAdmin:409,codigoAdmin:'ADMIN_RASCUNHO_EXISTENTE'});
                req.livroPdfAdmin={livroId:id,produtoId:item.produtoId};next();
            }catch(e){next(e);}
        },
        async listarLivros(req,res,next){
            try {
                const q=validarConsultaAdmin('livros',req.query),condicoes=[],args=[];
                if(q.busca!==undefined){
                    condicoes.push("l.title LIKE ? ESCAPE '!'");
                    args.push('%'+q.busca.replace(/[!%_]/g,c=>'!'+c)+'%');
                }
                if(Object.hasOwn(q,'pertenceEditoraIst')){
                    condicoes.push(q.pertenceEditoraIst===null?'l.pertence_editora_ist IS NULL':'l.pertence_editora_ist=?');
                    if(q.pertenceEditoraIst!==null)args.push(q.pertenceEditoraIst?1:0);
                }
                const where=condicoes.length?' WHERE '+condicoes.join(' AND '):'';
                const resultado=await ler(async c=>{
                    const [[contagem]]=await c.query(`SELECT COUNT(*) AS total ${origem}${where}`,args);
                    const total=Number(contagem.total);
                    if(!Number.isSafeInteger(total)||total<0)throw Error('CONTAGEM_INVALIDA');
                    const [rows]=await c.query(`SELECT ${campos} ${origem}${where} ORDER BY l.id ASC LIMIT ? OFFSET ?`,
                        [...args,q.limite,(q.pagina-1)*q.limite]);
                    const ids=rows.filter(r=>r.produto_tipo==='DIGITAL').map(r=>Number(r.produto_id));
                    const versoes=ids.length?(await c.query(`SELECT produto_id,public_id AS versaoPublicId,numero_versao AS numeroVersao,estado
                        FROM ist_loja_arquivo_versoes WHERE produto_id IN (${ids.map(()=>'?').join(',')}) ORDER BY numero_versao DESC`,ids))[0]:[];
                    return {itens:rows.map(r=>({...mapear(r),versoesPdf:versoes.filter(v=>Number(v.produto_id)===Number(r.produto_id))
                        .map(v=>({versaoPublicId:v.versaoPublicId,numeroVersao:Number(v.numeroVersao),estado:v.estado}))})),paginacao:{pagina:q.pagina,limite:q.limite,total}};
                });
                res.json(resultado);
            }catch(e){next(e);}
        },
        async obterLivro(req,res,next){
            try {
                const id=validarIdAdmin(req.params.id);
                if(Object.keys(req.query).length)throw Object.assign(Error('CONSULTA_INVALIDA'),{statusAdmin:400});
                const item=await ler(async c=>{
                    const [rows]=await c.query(`SELECT ${campos} ${origem} WHERE l.id=?`,[id]);
                    return rows.length?{...mapear(rows[0]),comercial:projetarProdutoDoLivro(await lerProdutoDoLivro(c,id)),
                        versoesPdf:rows[0].produto_tipo==='DIGITAL'?await lerVersoesPdf(c,Number(rows[0].produto_id)):[]}:null;
                });
                if(!item)throw Object.assign(Error('AUSENTE'),{statusAdmin:404});
                res.json({item});
            }catch(e){next(e);}
        }
    };
};
