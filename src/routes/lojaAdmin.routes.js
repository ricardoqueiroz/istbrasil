import express from 'express';
import {pool} from '../config/db.js';
import {criarProtecaoLojaAdmin,tratarErroAdmin} from '../middlewares/lojaAdminMiddleware.js';
import {criarLojaLivrosAdminController} from '../controllers/admin/lojaLivrosAdminController.js';
import {criarLojaProdutosAdminController} from '../controllers/admin/lojaProdutosAdminController.js';
import {criarLojaCategoriasAdminController} from '../controllers/admin/lojaCategoriasAdminController.js';
import {receberCapaAdmin,armazenarCapaAdmin} from '../services/lojaCapaService.js';
import {criarConfiguracaoCapasLoja} from '../config/lojaArmazenamento.js';
import {criarConfiguracaoArquivosLoja} from '../config/lojaArquivos.js';
import {receberPdfAdmin,registrarPdfAdmin,publicarPdfAdmin} from '../services/lojaAdminPdfService.js';

export const criarLojaAdminRouter=({db=pool,env=process.env,
    configuracaoCapas=criarConfiguracaoCapasLoja({env}),
    configuracaoArquivos=criarConfiguracaoArquivosLoja({raizPrivada:env.PRODUCTS_LIVROS_PATH})}={})=>{
    const router=express.Router(),protecao=criarProtecaoLojaAdmin({db,env});
    const controller=criarLojaLivrosAdminController({db});
    const csrf=(req,res,next)=>{
        try {res.set('X-CSRF-Token',protecao.emitirCsrf(req));next();}catch(e){next(e);}
    };
    router.get('/livros',protecao.entrada,csrf,controller.listarLivros);
    router.get('/livros/:id',protecao.entrada,csrf,controller.obterLivro);
    const jsonEditorial=express.json({limit:'144kb',strict:true,inflate:false});
    const parserEditorial=(req,res,next)=>{
        const tipo=req.get('Content-Type')??'';
        if(!/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(tipo)){
            return next(Object.assign(Error('MIDIA_INVALIDA'),{statusAdmin:415}));
        }
        jsonEditorial(req,res,e=>{
            if(!e)return next();
            const statusAdmin=e.type==='entity.too.large'?413:
                ['charset.unsupported','encoding.unsupported'].includes(e.type)?415:400;
            next(Object.assign(Error('CORPO_INVALIDO'),{statusAdmin}));
        });
    };
    router.post('/livros',protecao.entrada,protecao.protegerEscrita,parserEditorial,controller.criarLivro);
    router.post('/livros/capa',protecao.entrada,protecao.protegerEscrita,receberCapaAdmin,async(req,res,next)=>{
        try{
            if(Object.keys(req.query).length)throw Object.assign(Error('ENTRADA_INVALIDA'),{statusAdmin:400});
            const item=await armazenarCapaAdmin(req.file?.buffer,{env,configuracaoCapas});
            res.status(201).json({item});
        }catch(e){next(e);}
    });
    router.delete('/livros/:id',protecao.entrada,protecao.protegerEscrita,controller.excluirLivro);
    router.post('/livros/:id/pdf',protecao.entrada,protecao.protegerEscrita,controller.conferirPdf,receberPdfAdmin,async(req,res,next)=>{
        try{res.status(201).json({item:await registrarPdfAdmin({buffer:req.file?.buffer,
            ...req.livroPdfAdmin,db,arquivos:configuracaoArquivos})});}catch(e){next(e);}
    });
    router.patch('/livros/:id',protecao.entrada,protecao.protegerEscrita,parserEditorial,controller.atualizarLivro);
    router.post('/livros/:id/versoes-pdf/:versaoPublicId/publicar',protecao.entrada,protecao.protegerEscrita,
        parserEditorial,controller.prepararPublicacao,async(req,res,next)=>{
            try{res.json({item:await publicarPdfAdmin({...req.publicacaoPdfAdmin,db,arquivos:configuracaoArquivos})});}
            catch(e){next(e);}
        });
    const produtos=criarLojaProdutosAdminController({db,env});
    const categorias=criarLojaCategoriasAdminController({db});
    router.get('/produtos',protecao.entrada,csrf,produtos.listarProdutos);
    router.get('/produtos/:id',protecao.entrada,csrf,produtos.obterProduto);
    router.get('/categorias',protecao.entrada,csrf,categorias.listarCategorias);
    router.use(tratarErroAdmin);
    return router;
};
export default criarLojaAdminRouter();
