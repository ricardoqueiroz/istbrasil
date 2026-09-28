import express from 'express';
import { autenticarUsuario } from '../middlewares/authMiddleware.js';
import { autorizarTiposUsuario } from '../middlewares/authorizationMiddleware.js';
import {
    atualizarAssinatura,
    criarAssinatura,
    listarAssinaturas,
    obterAssinatura
} from '../controllers/admin/emailAssinaturasController.js';
import {
    atualizarModelo,
    criarModelo,
    listarModelos,
    obterModelo
} from '../controllers/admin/emailModelosController.js';
import {
    gerarPreviewDoModelo,
    listarPlaceholdersDoModelo
} from '../controllers/admin/emailPreviewController.js';

const router = express.Router();
const protegerAdmin = [autenticarUsuario, autorizarTiposUsuario(1)];

router.get('/assinaturas', ...protegerAdmin, listarAssinaturas);
router.get('/assinaturas/:id', ...protegerAdmin, obterAssinatura);
router.post('/assinaturas', ...protegerAdmin, criarAssinatura);
router.put('/assinaturas/:id', ...protegerAdmin, atualizarAssinatura);

router.get('/modelos', ...protegerAdmin, listarModelos);
router.get('/modelos/:id', ...protegerAdmin, obterModelo);
router.get('/modelos/:id/placeholders', ...protegerAdmin, listarPlaceholdersDoModelo);
router.post('/modelos', ...protegerAdmin, criarModelo);
router.post('/modelos/:id/preview', ...protegerAdmin, gerarPreviewDoModelo);
router.put('/modelos/:id', ...protegerAdmin, atualizarModelo);

export default router;
