import {createHash} from 'node:crypto';

export const MAX_PDF_ADMIN=32*1024*1024;
const erro=(statusAdmin=400)=>Object.assign(new Error('Contrato administrativo invalido.'),{statusAdmin});
const id=v=>Number.isSafeInteger(v)&&v>0&&v<=2147483647;
const objeto=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v));
const texto=(v,max,obrigatorio=true)=>typeof v==='string'&&(!obrigatorio||v.trim().length>0)
    &&Buffer.byteLength(v,'utf8')<=max&&Buffer.from(v).toString('utf8')===v&&!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(v);
const nullable=fn=>v=>v===null||fn(v);
const imagem=v=>v===null||(typeof v==='string'&&/^\/?assets\/images\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.(png|jpe?g|webp|avif|gif)$/i.test(v));
// MariaDB latin1 = cp1252. Tabela explicita dos caracteres imprimiveis estendidos,
// sem depender de aliases TextDecoder/ICU nem truncar com Buffer(...,'latin1').
// Bytes 80..9F nao correspondem aos controles Unicode U+0080..U+009F.
const extrasCp1252=[0x20ac,0x201a,0x0192,0x201e,0x2026,0x2020,0x2021,0x02c6,0x2030,
    0x0160,0x2039,0x0152,0x017d,0x2018,0x2019,0x201c,0x201d,0x2022,0x2013,0x2014,
    0x02dc,0x2122,0x0161,0x203a,0x0153,0x017e,0x0178];
const caracteresLatin1=new Set([...Array.from({length:128},(_,n)=>String.fromCodePoint(n)),
    ...Array.from({length:96},(_,n)=>String.fromCodePoint(n+160)),...extrasCp1252.map(n=>String.fromCodePoint(n))]);
const editorial=(max)=>v=>texto(v,max*4)&&Array.from(v).length<=max
    &&Array.from(v).every(c=>caracteresLatin1.has(c)&&!/[\u0080-\u009f]/.test(c));
// Mesmos criterios de SKU usados pela politica comercial: texto nao vazio,
// UTF-16 integro, ate 65.535 bytes e 50 caracteres; sem nova whitelist de sinais.
const skuValido=v=>typeof v==='string'&&v.trim().length>0&&[...v].length<=50
    &&Buffer.byteLength(v,'utf8')<=65535&&Buffer.from(v,'utf8').toString('utf8')===v;
const descricaoJson=v=>{
    if(!texto(v,65535,false))return false;
    try{const valor=JSON.parse(v);return objeto(valor);}catch{return false;}
};
export const precoLegadoValido=v=>v===null||(typeof v==='string'&&/^(?:0|[1-9]\d{0,2})\.\d{2}$/.test(v));
const livro={title:editorial(255),author:nullable(editorial(100)),currency:v=>v==='BRL',description:nullable(descricaoJson),
    language:nullable(v=>typeof v==='string'&&/^(?:[a-z]{2}(?:-(?:[a-z]{2}|[A-Z]{2}))?|es-419)$/.test(v)),
    format:v=>['E-Book','Livro Físico'].includes(v),category:editorial(50),img:imagem,
    pertenceEditoraIst:v=>v===null||typeof v==='boolean',sku:nullable(editorial(50)),price:precoLegadoValido,
    onsale:v=>v===0||v===1,inventory:v=>['Em estoque','Poucas unidades','Esgotado'].includes(v)};
const camposPatchLivro=Object.freeze(Object.keys(livro));
const produto={livroId:nullable(id),categoriaId:id,sku:skuValido,autor:nullable(v=>texto(v,400,false)&&[...v].length<=100),
    titulo:v=>texto(v,65535),descricao:nullable(v=>texto(v,65535,false)),tipo:v=>v==='DIGITAL',
    precoCentavos:v=>Number.isSafeInteger(v)&&v>0,moeda:v=>v==='BRL',imagemUrl:imagem,
    ativo:v=>typeof v==='boolean',emVenda:v=>typeof v==='boolean',disponivel:v=>typeof v==='boolean'};
const situacao={ativo:produto.ativo,emVenda:produto.emVenda,disponivel:produto.disponivel};
const comercial={categoriaId:id,sku:skuValido,precoCentavos:produto.precoCentavos,autor:produto.autor,
    titulo:produto.titulo,imagemUrl:imagem,descricao:produto.descricao,
    ativo:produto.ativo,emVenda:produto.emVenda,disponivel:produto.disponivel};
const validarComercial=(v,metodo)=>{
    if(!objeto(v)||!Object.keys(v).length||Object.keys(v).some(k=>!Object.hasOwn(comercial,k)||!comercial[k](v[k])))throw erro();
    if(metodo==='POST'&&(['categoriaId','sku','precoCentavos'].some(k=>!Object.hasOwn(v,k))
        ||Object.keys(v).some(k=>!['categoriaId','sku','precoCentavos'].includes(k))))throw erro();
    return {...v};
};
const definir=(metodo,rota,campos,obrigatorios=[],bloqueado=false)=>Object.freeze({metodo,rota,
    campos:Object.freeze([...campos]),obrigatorios:Object.freeze([...obrigatorios]),
    permissao:1,ifMatch:['PATCH','DELETE'].includes(metodo),bloqueado});
export const CONTRATOS_LOJA_ADMIN=Object.freeze([
    definir('GET','/api/admin/loja/livros',[]),definir('GET','/api/admin/loja/livros/:id',[]),
    definir('POST','/api/admin/loja/livros',[...Object.keys(livro),'categoriaId','comercial'],['title','format','pertenceEditoraIst']),
    definir('PATCH','/api/admin/loja/livros/:id',[...camposPatchLivro,'categoriaId','comercial']),
    definir('DELETE','/api/admin/loja/livros/:id',[]),
    definir('GET','/api/admin/loja/produtos',[]),definir('GET','/api/admin/loja/produtos/:id',[]),
    definir('POST','/api/admin/loja/produtos',Object.keys(produto),
        ['livroId','categoriaId','sku','titulo','tipo','precoCentavos','moeda','ativo','emVenda','disponivel']),
    definir('PATCH','/api/admin/loja/produtos/:id',Object.keys(produto)),
    definir('PATCH','/api/admin/loja/produtos/:id/situacao',Object.keys(situacao)),
    definir('GET','/api/admin/loja/categorias',[])
]);
export const validarIdAdmin=v=>{
    if(typeof v!=='string'||!/^[1-9]\d{0,9}$/.test(v)||!id(Number(v)))throw erro();return Number(v);
};
export const validarEntradaAdmin=(recurso,metodo,entrada)=>{
    const esquemas={livros:livro,produtos:produto,situacao};
    const regras=Object.hasOwn(esquemas,recurso)?esquemas[recurso]:null;
    if(!regras||!['POST','PATCH'].includes(metodo)||(recurso==='situacao'&&metodo!=='PATCH')||!objeto(entrada))throw erro();
    let comando;
    if(recurso==='livros'&&Object.hasOwn(entrada,'comercial')){
        comando=validarComercial(entrada.comercial,metodo);
        entrada={...entrada};delete entrada.comercial;
    }
    let categoriaId;
    if(recurso==='livros'&&Object.hasOwn(entrada,'categoriaId')){
        if(!id(entrada.categoriaId))throw erro();categoriaId=entrada.categoriaId;
        entrada={...entrada};delete entrada.categoriaId;
    }
    if(recurso==='livros'&&metodo==='POST'){
        if(!comando&&(!categoriaId||!skuValido(entrada.sku)||!precoLegadoValido(entrada.price)||entrada.price===null||entrada.price==='0.00'))throw erro();
        if(comando&&!categoriaId&&!Object.hasOwn(entrada,'category'))throw erro();
    }
    const chaves=Object.keys(entrada);
    if(recurso==='livros'&&metodo==='PATCH'&&chaves.some(k=>!camposPatchLivro.includes(k)))throw erro();
    if((!chaves.length&&!comando)||chaves.some(k=>!Object.hasOwn(regras,k)||!regras[k](entrada[k])))throw erro();
    if(metodo==='POST'){
        const contrato=CONTRATOS_LOJA_ADMIN.find(c=>c.metodo===metodo&&c.rota===`/api/admin/loja/${recurso}`);
        if(!contrato||contrato.obrigatorios.some(k=>k==='comercial'?!comando:!Object.hasOwn(entrada,k)))throw erro();
        if(contrato.bloqueado)throw erro(503); // Contratos ainda indisponiveis falham fechado.
    }
    return {...entrada,...(categoriaId?{categoriaId}:{}),...(comando?{comercial:comando}:{})};
};
export const validarConsultaAdmin=(recurso,query)=>{
    if(!['livros','produtos','categorias'].includes(recurso)||!objeto(query))throw erro();
    const permitidos=recurso==='categorias'?['pagina','limite','busca','ativo']:
        recurso==='livros'?['pagina','limite','busca','pertenceEditoraIst']:['pagina','limite','busca','categoriaId','ativo','emVenda','disponivel'];
    if(Object.keys(query).some(k=>!permitidos.includes(k)||typeof query[k]!=='string'))throw erro();
    const inteiro=(k,padrao,max)=>{const v=query[k];if(v===undefined)return padrao;
        if(!/^[1-9]\d*$/.test(v)||!Number.isSafeInteger(Number(v))||Number(v)>max)throw erro();return Number(v);};
    const r={pagina:inteiro('pagina',1,1000000),limite:inteiro('limite',20,100)};
    for(const [k,v]of Object.entries(query)){
        if(['pagina','limite'].includes(k))continue;
        if(k==='busca'){if(!texto(v,200))throw erro();r[k]=v.trim();}
        else if(k==='categoriaId')r[k]=validarIdAdmin(v);
        else {if(!['true','false',...(k==='pertenceEditoraIst'?['null']:[])].includes(v))throw erro();r[k]=v==='null'?null:v==='true';}
    }return r;
};
const canonico=v=>{
    if(v===null||typeof v==='string'||typeof v==='boolean')return v;
    if(typeof v==='number'&&Number.isSafeInteger(v))return v;
    if(Array.isArray(v))return v.map(canonico);
    if(objeto(v))return Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonico(v[k])]));
    throw erro();
};
export const CAMPOS_REVISAO_ADMIN=Object.freeze({
    livros:Object.freeze(Object.keys(livro)),produtos:Object.freeze(Object.keys(produto))
});
// Projecao do estado persistido, nao validacao de comando. Valores legados nulos
// continuam representaveis. Falta de campo falha fechado; extras sao ignorados.
export const projetarRevisaoAdmin=(recurso,dto)=>{
    const campos=Object.hasOwn(CAMPOS_REVISAO_ADMIN,recurso)?CAMPOS_REVISAO_ADMIN[recurso]:null;
    if(!campos||!objeto(dto)||campos.some(k=>!Object.hasOwn(dto,k)||dto[k]===undefined))throw erro();
    return Object.fromEntries(campos.map(k=>[k,canonico(dto[k])]));
};
// Revisao forte da projecao editavel + identidade. Comparar sob lock na futura
// transacao de escrita. Nao e ETag de um envelope com campos derivados.
export const criarEtagAdmin=(recurso,idRegistro,dto)=>{
    if(!['livros','produtos'].includes(recurso)||!id(idRegistro)||!objeto(dto))throw erro();
    return '"'+createHash('sha256').update(JSON.stringify([recurso,idRegistro,canonico(projetarRevisaoAdmin(recurso,dto))])).digest('hex')+'"';
};
export const conferirIfMatchAdmin=(recebido,atual)=>{
    if(recebido===undefined)throw erro(428);
    if(typeof recebido!=='string'||!/^"[a-f0-9]{64}"$/.test(recebido))throw erro();
    if(recebido!==atual)throw erro(412);
};
