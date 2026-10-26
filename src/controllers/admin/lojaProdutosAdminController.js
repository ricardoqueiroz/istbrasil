import {pool} from '../../config/db.js';
import {validarConsultaAdmin,validarIdAdmin,projetarRevisaoAdmin,criarEtagAdmin} from '../../services/lojaAdminContratos.js';
import {imagemPublica,criarContextoCategorias,avaliarPoliticaComercial} from '../../services/lojaCatalogoService.js';

const origem='FROM ist_loja_produtos p LEFT JOIN ist_livros l ON l.id=p.livro_id';
const campos=`p.id,p.livro_id,p.categoria_id,p.sku,p.titulo,p.autor,p.descricao,p.tipo,
    CAST(p.preco_centavos AS CHAR) AS preco_centavos,p.moeda,p.imagem_url,p.ativo,p.em_venda,p.disponivel,
    l.format AS formato_editorial,
    EXISTS(SELECT 1 FROM ist_loja_arquivo_versoes v WHERE v.produto_id=p.id
        AND v.estado='PUBLICADA' AND v.publicacao_atual=1) AS versao_publicada`;
const centavos=v=>{
    if(v===null)return null;
    if(!((typeof v==='string'&&/^[0-9]+$/.test(v))||typeof v==='number'))throw Error('PRECO_INVALIDO');
    const n=Number(v);if(!Number.isSafeInteger(n)||n<=0)throw Error('PRECO_INVALIDO');return n;
};
const flag=v=>v===null?null:Number(v)===1;
const mapear=(p,caminho,contexto)=>{
    const preco=centavos(p.preco_centavos);
    const linha={...p,id:Number(p.id),categoria_id:Number(p.categoria_id),
        livro_id:p.livro_id===null?null:Number(p.livro_id),ativo:p.ativo===null?null:Number(p.ativo),
        em_venda:p.em_venda===null?null:Number(p.em_venda),disponivel:p.disponivel===null?null:Number(p.disponivel),
        versao_publicada:Number(p.versao_publicada)};
    const editavel=projetarRevisaoAdmin('produtos',{livroId:linha.livro_id,categoriaId:linha.categoria_id,
        sku:p.sku,titulo:p.titulo,autor:p.autor,descricao:p.descricao,tipo:p.tipo,precoCentavos:preco,moeda:p.moeda,
        imagemUrl:p.imagem_url,ativo:flag(p.ativo),emVenda:flag(p.em_venda),disponivel:flag(p.disponivel)});
    return {id:linha.id,...editavel,imagemUrl:imagemPublica(p.imagem_url),
        formatoEditorial:p.formato_editorial,temVersaoPublicada:linha.versao_publicada===1,
        podeComprar:avaliarPoliticaComercial(linha,caminho,contexto).elegivel,
        revisao:criarEtagAdmin('produtos',linha.id,editavel)};
};

export const criarLojaProdutosAdminController=({db=pool,env=process.env}={})=>{
    const ler=async operacao=>{
        const c=await db.getConnection();
        try {
            await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
            await c.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
            // Contexto completo, nunca apenas a categoria da pagina filtrada.
            const [categorias]=await c.query('SELECT id,categoria_pai_id,ativo FROM ist_loja_categorias ORDER BY id');
            const normalizadas=categorias.map(x=>({id:Number(x.id),categoria_pai_id:x.categoria_pai_id===null?null:Number(x.categoria_pai_id),ativo:Number(x.ativo)}));
            const {caminho}=criarContextoCategorias(normalizadas);
            const contexto={ambienteBackend:env.NODE_ENV,ambientePaypal:env.IST_LOJA_PAYPAL_ENV};
            const r=await operacao(c,p=>mapear(p,caminho,contexto));await c.commit();return r;
        }catch(e){try{await c.rollback();}catch{}throw e;}finally{c.release();}
    };
    return {
        async listarProdutos(req,res,next){
            try{
                const q=validarConsultaAdmin('produtos',req.query),condicoes=[],args=[];
                if(q.busca!==undefined){
                    condicoes.push("(p.titulo LIKE ? ESCAPE '!' OR p.sku LIKE ? ESCAPE '!')");
                    const busca='%'+q.busca.replace(/[!%_]/g,c=>'!'+c)+'%';args.push(busca,busca);
                }
                for(const [f,col]of [['categoriaId','categoria_id'],['ativo','ativo'],['emVenda','em_venda'],['disponivel','disponivel']]){
                    if(Object.hasOwn(q,f)){condicoes.push(`p.${col}=?`);args.push(typeof q[f]==='boolean'?(q[f]?1:0):q[f]);}
                }
                const where=condicoes.length?' WHERE '+condicoes.join(' AND '):'';
                const resultado=await ler(async(c,map)=>{
                    const [[n]]=await c.query(`SELECT COUNT(*) AS total ${origem}${where}`,args);
                    const total=Number(n.total);if(!Number.isSafeInteger(total)||total<0)throw Error('CONTAGEM_INVALIDA');
                    const [rows]=await c.query(`SELECT ${campos} ${origem}${where} ORDER BY p.id ASC LIMIT ? OFFSET ?`,[...args,q.limite,(q.pagina-1)*q.limite]);
                    return {itens:rows.map(map),paginacao:{pagina:q.pagina,limite:q.limite,total}};
                });res.json(resultado);
            }catch(e){next(e);}
        },
        async obterProduto(req,res,next){
            try{
                const id=validarIdAdmin(req.params.id);
                if(Object.keys(req.query).length)throw Object.assign(Error('CONSULTA_INVALIDA'),{statusAdmin:400});
                const item=await ler(async(c,map)=>{
                    const [rows]=await c.query(`SELECT ${campos} ${origem} WHERE p.id=?`,[id]);return rows.length?map(rows[0]):null;
                });
                if(!item)throw Object.assign(Error('AUSENTE'),{statusAdmin:404});res.json({item});
            }catch(e){next(e);}
        }
    };
};
