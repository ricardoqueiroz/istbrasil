import express from 'express';
import {
    listarOpcoesUsuariosAdmin,
    listarSituacoesUsuarioAdmin,
    listarUsuariosAdmin,
    obterUsuarioAdmin
} from '../controllers/admin/usuariosAdminController.js';
import { autenticarUsuario } from '../middlewares/authMiddleware.js';
import { autorizarTiposUsuario } from '../middlewares/authorizationMiddleware.js';

const router = express.Router();
const protegerAdmin = [autenticarUsuario, autorizarTiposUsuario(1)];

router.get('/', ...protegerAdmin, listarUsuariosAdmin);
router.get('/opcoes', ...protegerAdmin, listarOpcoesUsuariosAdmin);
router.get('/situacoes', ...protegerAdmin, listarSituacoesUsuarioAdmin);
router.get('/:id', ...protegerAdmin, obterUsuarioAdmin);

export default router;
