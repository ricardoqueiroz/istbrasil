import express from 'express';
import eventosController from '../controllers/eventosController.js';

const router = express.Router();

// GET /api/eventos - Lista todos os eventos para a página de cards
router.get('/', eventosController.listarEventos);

// GET /api/eventos/:slug - Busca os detalhes de um evento específico pelo Slug (incluindo etapas, documentos e programação)
router.get('/:slug', eventosController.obterEventoPorSlug);

export default router;