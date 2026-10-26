import express from 'express';
import { autenticarUsuario } from '../middlewares/authMiddleware.js';
import { autorizarTiposUsuario } from '../middlewares/authorizationMiddleware.js';
import adminEmailRoutes from './adminEmail.routes.js';
import adminUsuariosRoutes from './adminUsuarios.routes.js';
import adminEventosRoutes from './adminEventos.routes.js';
import lojaAdminRoutes from './lojaAdmin.routes.js';

export const criarAdminRouter = ({loja=lojaAdminRoutes}={}) => {
const router = express.Router();

router.get('/me', autenticarUsuario, autorizarTiposUsuario(1), (_req, res) => {
    return res.status(200).json({ autorizado: true });
});

router.use('/emails', adminEmailRoutes);
router.use('/usuarios', adminUsuariosRoutes);
router.use('/eventos', adminEventosRoutes);
router.use('/loja', loja);
return router;
};

export default criarAdminRouter();
