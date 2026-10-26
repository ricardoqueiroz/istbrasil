import {pool} from '../../config/db.js';
import {validarConsultaAdmin} from '../../services/lojaAdminContratos.js';

export const criarLojaCategoriasAdminController=({db=pool}={})=>({
    async listarCategorias(req,res,next){
        let c;
        try{
            const q=validarConsultaAdmin('categorias',req.query),condicoes=[],args=[];
            if(q.busca!==undefined){
                condicoes.push("(nome LIKE ? ESCAPE '!' OR slug LIKE ? ESCAPE '!')");
                const busca='%'+q.busca.replace(/[!%_]/g,c=>'!'+c)+'%';args.push(busca,busca);
            }
            if(Object.hasOwn(q,'ativo')){condicoes.push('ativo=?');args.push(q.ativo?1:0);}
            const where=condicoes.length?' WHERE '+condicoes.join(' AND '):'';
            c=await db.getConnection();
            await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
            await c.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
            const [[n]]=await c.query(`SELECT COUNT(*) AS total FROM ist_loja_categorias${where}`,args);
            const total=Number(n.total);if(!Number.isSafeInteger(total)||total<0)throw Error('CONTAGEM_INVALIDA');
            const [rows]=await c.query(`SELECT id,nome,slug,categoria_pai_id,ativo,ordem FROM ist_loja_categorias${where}
                ORDER BY ordem ASC,id ASC LIMIT ? OFFSET ?`,[...args,q.limite,(q.pagina-1)*q.limite]);
            const itens=rows.map(x=>({id:Number(x.id),nome:x.nome,slug:x.slug,
                categoriaPaiId:x.categoria_pai_id===null?null:Number(x.categoria_pai_id),ativo:Number(x.ativo)===1,ordem:Number(x.ordem)}));
            await c.commit();res.json({itens,paginacao:{pagina:q.pagina,limite:q.limite,total}});
        }catch(e){if(c)try{await c.rollback();}catch{}next(e);}finally{c?.release();}
    }
});
