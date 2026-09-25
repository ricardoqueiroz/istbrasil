import express from 'express';
import obraController from '../controllers/obraController.js';
const router = express.Router();

// GET /api/obra/composicoes-elegiveis
router.get('/composicoes-elegiveis', obraController.getComposicoesElegiveis);

// GET /api/obra
router.get('/', obraController.getAllObras);

export default router;
