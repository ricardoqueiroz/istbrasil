import express from 'express';
import {criarMiddlewareDownloads,tratarErroDownload,responderDownload} from '../middlewares/lojaDownloadsMiddleware.js';
import {criarLojaDownloadsController} from '../controllers/lojaDownloadsController.js';
import {carregarConfiguracaoLojaSessao} from '../config/lojaSessao.js';
import {carregarConfiguracaoLojaPedido} from '../config/lojaPedido.js';
import {criarLojaSessaoService} from '../services/lojaSessaoService.js';
import {criarLojaDownloadAutorizacaoService} from '../services/lojaDownloadAutorizacaoService.js';
import {criarLojaDownloadDireitosService} from '../services/lojaDownloadDireitosService.js';
import {prepararArquivoValidado} from '../services/lojaDownloadArquivoService.js';
import {criarConfiguracaoArquivosLoja} from '../config/lojaArquivos.js';

export const criarLojaDownloadsRouter=({db,env=process.env,agora,agoraMs,
    sessaoService=criarLojaSessaoService({db,agora}),obterConfiguracaoSessao=()=>carregarConfiguracaoLojaSessao(env),
    contextoEsperado,autorizacaoService,direitosService,prepararArquivo=prepararArquivoValidado,
    configuracaoArquivos=criarConfiguracaoArquivosLoja({raizPrivada:env.PRODUCTS_PATH})}={})=>{
    let servicos;
    const obterServicos=()=>{
        if(servicos)return servicos;
        const contexto=contextoEsperado??{provedor:'paypal',ambiente:env.IST_LOJA_PAYPAL_ENV,contaRecebedora:env.IST_LOJA_PAYPAL_CONTA_RECEBEDORA};
        if(!contextoEsperado&&(contexto.ambiente!=='sandbox'||carregarConfiguracaoLojaPedido(env).ambiente!==contexto.ambiente
            ||!/^[2-9A-HJ-NP-Z]{13}$/.test(contexto.contaRecebedora??'')))throw Error('CONFIGURACAO_INVALIDA');
        servicos={contexto:Object.freeze({...contexto}),
            autorizacao:autorizacaoService??criarLojaDownloadAutorizacaoService({db,contextoEsperado:contexto,agora}),
            direitos:direitosService??criarLojaDownloadDireitosService({db,agora})};return servicos;
    };
    const m=criarMiddlewareDownloads({sessaoService,obterConfiguracaoSessao,agoraMs});
    const c=criarLojaDownloadsController({db,obterServicos,prepararArquivo,obterRaiz:()=>configuracaoArquivos.obterRaizValidada()});
    const router=express.Router();
    router.use(m.entrada,m.autenticar);
    router.get('/direitos',m.limitar('lista',30),c.listar);
    router.post('/itens/:direitoPublicId/reavaliar',m.protegerPost,m.limitar('post',10),express.json({limit:'1kb'}),c.reavaliar);
    router.route('/itens/:direitoPublicId/arquivo').get(m.limitar('arquivo',10),m.entrega,c.arquivo)
        .head(m.limitar('arquivo',10),m.entrega,c.arquivo);
    router.use((req,res)=>responderDownload(res,404,{erro:{codigo:'ROTA_NAO_ENCONTRADA'}}));
    router.use(tratarErroDownload);return router;
};
