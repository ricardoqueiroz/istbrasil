import {criarEtagAdmin,conferirIfMatchAdmin} from './lojaAdminContratos.js';

const falhar=(statusAdmin=409)=>{throw Object.assign(Error('OPERACAO_COMERCIAL_INVALIDA'),{statusAdmin});};
const campos='id,livro_id,categoria_id,sku,titulo,autor,descricao,tipo,CAST(preco_centavos AS CHAR) AS preco_centavos,moeda,imagem_url,ativo,em_venda,disponivel';
export const lerProdutoDoLivro=async(c,livroId,lock=false)=>{
    const [rows]=await c.query(`SELECT ${campos} FROM ist_loja_produtos WHERE livro_id=?${lock?' FOR UPDATE':''}`,[livroId]);
    if(rows.length>1)falhar();return rows[0]??null;
};
export const projetarProdutoDoLivro=p=>{
    if(!p)return null;
    const valor=p.preco_centavos===null?null:Number(p.preco_centavos);
    if(valor!==null&&(!Number.isSafeInteger(valor)||valor<=0))throw Error('PRECO_COMERCIAL_INVALIDO');
    const flag=v=>v===null?null:Number(v)===1;
    const dto={livroId:Number(p.livro_id),categoriaId:Number(p.categoria_id),sku:p.sku,titulo:p.titulo,autor:p.autor,
        descricao:p.descricao,tipo:p.tipo,precoCentavos:valor,moeda:p.moeda,imagemUrl:p.imagem_url,
        ativo:flag(p.ativo),emVenda:flag(p.em_venda),disponivel:flag(p.disponivel)};
    const imagem=typeof p.imagem_url==='string'&&/^\/?assets\/images\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.(png|jpe?g|webp|avif|gif)$/i.test(p.imagem_url)?p.imagem_url:null;
    return {id:Number(p.id),...dto,imagemUrl:imagem,revisao:criarEtagAdmin('produtos',Number(p.id),dto)};
};
// All category locks precede product/book locks, as in the existing catalogue.
export const bloquearCategoriasProduto=async(c,ids,exigirAtiva)=>{
    const [rows]=await c.query('SELECT id,categoria_pai_id,ativo FROM ist_loja_categorias ORDER BY id');
    const mapa=new Map(rows.map(r=>[Number(r.id),r])),todos=new Set();
    for(const inicio of ids.filter(v=>v!=null)){
        let id=Number(inicio);const vistos=new Set();
        while(id){
            const r=mapa.get(id);if(!r||vistos.has(id))falhar(400);
            if(Number(inicio)===exigirAtiva&&Number(r.ativo)!==1)falhar(400);
            vistos.add(id);todos.add(id);id=r.categoria_pai_id===null?0:Number(r.categoria_pai_id);
        }
    }
    for(const id of [...todos].sort((a,b)=>a-b)){
        const [[r]]=await c.query('SELECT id,categoria_pai_id,ativo FROM ist_loja_categorias WHERE id=? LOCK IN SHARE MODE',[id]);
        const antes=mapa.get(id);
        if(!r||Number(r.ativo)!==Number(antes.ativo)||String(r.categoria_pai_id)!==String(antes.categoria_pai_id))falhar();
    }
};
export const bloquearProdutoDoLivro=async(c,livroId,categoriaId)=>{
    const anterior=await lerProdutoDoLivro(c,livroId);
    await bloquearCategoriasProduto(c,[anterior?.categoria_id,categoriaId],categoriaId);
    const atual=await lerProdutoDoLivro(c,livroId,true);
    if(String(atual?.id)!==String(anterior?.id)||String(atual?.categoria_id)!==String(anterior?.categoria_id))falhar();
    return atual;
};
export const criarProduto=async(c,livro,categoriaId)=>{
    const d=livro.comercial;
    const [r]=await c.query(`INSERT INTO ist_loja_produtos
        (livro_id,categoria_id,sku,tipo,titulo,autor,descricao,imagem_url,preco_centavos,moeda,ativo,em_venda,disponivel,ordem,perfil_fiscal_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,1,0,?,0,NULL)`,
        [livro.id,categoriaId,d.sku,livro.format==='E-Book'?'DIGITAL':'MERCADORIA',livro.title,
            livro.author??null,livro.description??null,livro.img??null,d.precoCentavos,'BRL',
            (livro.sincronizado||livro.inventory!==undefined)?(livro.inventory==='Esgotado'?0:1):0]);
    if(!Number.isSafeInteger(Number(r.insertId))||Number(r.insertId)<1)throw Error('PRODUTO_ID_INVALIDO');
    return lerProdutoDoLivro(c,livro.id);
};
export const atualizarProduto=async(c,produto,dados,tag)=>{
    if(!produto)falhar();
    conferirIfMatchAdmin(tag,projetarProdutoDoLivro(produto).revisao);
    const colunas={categoriaId:'categoria_id',sku:'sku',precoCentavos:'preco_centavos',titulo:'titulo',autor:'autor',moeda:'moeda',imagemUrl:'imagem_url',
        descricao:'descricao',ativo:'ativo',emVenda:'em_venda',disponivel:'disponivel'};
    const atual=projetarProdutoDoLivro(produto),chaves=Object.keys(dados).filter(k=>dados[k]!==atual[k]);
    if(chaves.length)await c.query(`UPDATE ist_loja_produtos SET ${chaves.map(k=>colunas[k]+'=?').join(',')} WHERE id=?`,
        [...chaves.map(k=>typeof dados[k]==='boolean'?(dados[k]?1:0):dados[k]),Number(produto.id)]);
    // Re-read the row already locked; a consistent read could use an old snapshot.
    return lerProdutoDoLivro(c,Number(produto.livro_id),true);
};
export const excluirProdutoSePermitido=async(c,livroId,produto,tag)=>{
    if(!produto)return;
    if(Number(produto.livro_id)!==livroId)falhar();
    conferirIfMatchAdmin(tag,projetarProdutoDoLivro(produto).revisao);
    for(const tabela of ['ist_loja_pedido_itens','ist_loja_arquivo_versoes']){
        const [rows]=await c.query(`SELECT id FROM ${tabela} WHERE produto_id=? LIMIT 1`,[Number(produto.id)]);
        if(rows.length)falhar();
    }
    await c.query('DELETE FROM ist_loja_produtos WHERE id=?',[Number(produto.id)]);
};

export const sincronizarComandoLivro=(dados,explicito={})=>{
    const comando={...explicito};
    const definir=(k,v)=>{if(Object.hasOwn(comando,k)&&comando[k]!==v)falhar(400);comando[k]=v;};
    const campos={title:'titulo',author:'autor',sku:'sku',description:'descricao',img:'imagemUrl',currency:'moeda',categoriaId:'categoriaId'};
    for(const [k,destino]of Object.entries(campos))if(Object.hasOwn(dados,k))definir(destino,dados[k]);
    if(Object.hasOwn(dados,'price')){
        if(typeof dados.price!=='string'||!/^(?:0|[1-9]\d{0,2})\.\d{2}$/.test(dados.price))falhar(400);
        const valor=Number(BigInt(dados.price.replace('.','')));if(valor<=0)falhar(400);definir('precoCentavos',valor);
    }
    if(Object.hasOwn(dados,'sku')&&(typeof dados.sku!=='string'||!dados.sku.trim()))falhar(400);
    if(Object.hasOwn(dados,'inventory'))definir('disponivel',dados.inventory!=='Esgotado');
    return comando;
};
export const nomeCategoriaDoLivro=async(c,id)=>{
    const [[r]]=await c.query('SELECT nome FROM ist_loja_categorias WHERE id=?',[id]);
    if(!r)falhar(400);return r.nome;
};
