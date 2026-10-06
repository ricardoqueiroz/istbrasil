import express from 'express';
import { listarAcessosJurado, listarConcorrentesJurado, obterAvaliacaoJurado, obterConcorrenteJurado, obterEventoJurado, salvarAvaliacaoJurado } from '../controllers/juradoController.js';
import { autenticarUsuario } from '../middlewares/authMiddleware.js';
import { autorizarJuradoEvento } from '../middlewares/juradoAuthorizationMiddleware.js';

// A mesma definicao de rotas permite injetar navegacao nos testes; avaliacao permanece legacy.
export const criarJuradoRouter = ({
    navegacao = { listarAcessosJurado, listarConcorrentesJurado, obterConcorrenteJurado, obterEventoJurado }
} = {}) => {
    const router = express.Router();

    router.get('/acessos', autenticarUsuario, navegacao.listarAcessosJurado);
    router.get('/eventos/:slug', autenticarUsuario, autorizarJuradoEvento, navegacao.obterEventoJurado);
    router.get('/eventos/:slug/concorrentes', autenticarUsuario, autorizarJuradoEvento, navegacao.listarConcorrentesJurado);
    router.get('/eventos/:slug/concorrentes/:idParticipacao', autenticarUsuario, autorizarJuradoEvento, navegacao.obterConcorrenteJurado);
    router.get('/eventos/:slug/concorrentes/:idParticipacao/avaliacao', autenticarUsuario, autorizarJuradoEvento, obterAvaliacaoJurado);
    router.put('/eventos/:slug/concorrentes/:idParticipacao/avaliacao', autenticarUsuario, autorizarJuradoEvento, salvarAvaliacaoJurado);

    return router;
};
export default criarJuradoRouter();