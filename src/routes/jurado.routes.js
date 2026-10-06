import express from 'express';
import { listarAcessosJurado, listarConcorrentesJurado, obterConcorrenteJurado, obterEventoJurado } from '../controllers/juradoController.js';
import {
    obterAvaliacaoJuradoCycleAwareController, salvarAvaliacaoJuradoCycleAwareController
} from '../controllers/juradoAvaliacaoCycleAwareController.js';
import { autenticarUsuario } from '../middlewares/authMiddleware.js';
import { autorizarJuradoEvento } from '../middlewares/juradoAuthorizationMiddleware.js';

// A mesma definicao de rotas permite injetar adapters nos testes, sem trocar middlewares.
export const criarJuradoRouter = ({
    navegacao = { listarAcessosJurado, listarConcorrentesJurado, obterConcorrenteJurado, obterEventoJurado },
    avaliacao = { obterAvaliacaoJurado: obterAvaliacaoJuradoCycleAwareController, salvarAvaliacaoJurado: salvarAvaliacaoJuradoCycleAwareController }
} = {}) => {
    const router = express.Router();

    router.get('/acessos', autenticarUsuario, navegacao.listarAcessosJurado);
    router.get('/eventos/:slug', autenticarUsuario, autorizarJuradoEvento, navegacao.obterEventoJurado);
    router.get('/eventos/:slug/concorrentes', autenticarUsuario, autorizarJuradoEvento, navegacao.listarConcorrentesJurado);
    router.get('/eventos/:slug/concorrentes/:idParticipacao', autenticarUsuario, autorizarJuradoEvento, navegacao.obterConcorrenteJurado);
    router.get('/eventos/:slug/concorrentes/:idParticipacao/avaliacao', autenticarUsuario, autorizarJuradoEvento, avaliacao.obterAvaliacaoJurado);
    router.put('/eventos/:slug/concorrentes/:idParticipacao/avaliacao', autenticarUsuario, autorizarJuradoEvento, avaliacao.salvarAvaliacaoJurado);

    return router;
};
export default criarJuradoRouter();