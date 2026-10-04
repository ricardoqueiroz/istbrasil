import express from 'express';
import { listarAvaliacoesAdmin } from '../controllers/admin/avaliacoesAdminController.js';
import { autenticarUsuario } from '../middlewares/authMiddleware.js';
import { autorizarTiposUsuario } from '../middlewares/authorizationMiddleware.js';

const router = express.Router();

router.get('/:slug/avaliacoes', autenticarUsuario, autorizarTiposUsuario(1), listarAvaliacoesAdmin);

export default router;