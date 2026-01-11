const express = require('express');
const router = express.Router();
const timelineController = require('../controllers/timelineController');

// Rota GET: /api/timeline
// Exemplo de uso: /api/timeline?page=1&limit=10
router.get('/', timelineController.getTimelineEvents);

module.exports = router;
