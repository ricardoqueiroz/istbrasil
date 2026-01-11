const express = require('express');
const router = express.Router();
const releasesController = require('../controllers/releasesController');

// GET /api/releases
router.get('/', releasesController.getAllReleases);

// GET /api/releases/:releaseNum/tracks
router.get('/:releaseNum/tracks', releasesController.getReleaseTracks);

module.exports = router;
