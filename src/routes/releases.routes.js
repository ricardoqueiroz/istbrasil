const express = require('express');
const router = express.Router();
const releasesController = require('../controllers/releasesController');
// atualização para refletir a nova estrutura de rotas no server.js
// GET /api/releases
router.get('/', releasesController.getAllReleases);

// GET /api/releases/:releaseNum/tracks
router.get('/:releaseNum/tracks', releasesController.getReleaseTracks);

module.exports = router;
