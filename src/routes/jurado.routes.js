import express from 'express';
import { listarAcessosJurado, obterEventoJurado } from '../controllers/juradoController.js';
import { autenticarUsuario } from '../middlewares/authMiddleware.js';
import { autorizarJuradoEvento } from '../middlewares/juradoAuthorizationMiddleware.js';

const router = express.Router();

router.get('/acessos', autenticarUsuario, listarAcessosJurado);
router.get('/eventos/:slug', autenticarUsuario, autorizarJuradoEvento, obterEventoJurado);

export default router;