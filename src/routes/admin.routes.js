import express from 'express';
import { autenticarUsuario } from '../middlewares/authMiddleware.js';
import { autorizarTiposUsuario } from '../middlewares/authorizationMiddleware.js';
import adminEmailRoutes from './adminEmail.routes.js';

const router = express.Router();

router.get('/me', autenticarUsuario, autorizarTiposUsuario(1), (_req, res) => {
    return res.status(200).json({ autorizado: true });
});

router.use('/emails', adminEmailRoutes);

export default router;
