import express from 'express';
import { listarAcessosJurado, listarConcorrentesJurado, obterConcorrenteJurado, obterEventoJurado } from '../controllers/juradoController.js';
import { autenticarUsuario } from '../middlewares/authMiddleware.js';
import { autorizarJuradoEvento } from '../middlewares/juradoAuthorizationMiddleware.js';

const router = express.Router();

router.get('/acessos', autenticarUsuario, listarAcessosJurado);
router.get('/eventos/:slug', autenticarUsuario, autorizarJuradoEvento, obterEventoJurado);
router.get('/eventos/:slug/concorrentes', autenticarUsuario, autorizarJuradoEvento, listarConcorrentesJurado);
router.get('/eventos/:slug/concorrentes/:idParticipacao', autenticarUsuario, autorizarJuradoEvento, obterConcorrenteJurado);

export default router;