import express from 'express';
import projetosController from '../controllers/projetosController.js';
const router = express.Router();
router.get('/', projetosController.listarProjetos);
router.get('/:slug', projetosController.obterProjetoPorSlug);
export default router;
