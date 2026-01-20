import express from 'express';
import timelineController from '../controllers/timelineController.js';
const router = express.Router();
// Rota GET: /api/timeline
// Exemplo de uso: /api/timeline?page=1&limit=10
router.get('/', timelineController.getTimelineEvents);

export default router;
