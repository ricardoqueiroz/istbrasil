const express = require('express');
const router = express.Router();
const releasesController = require('../controllers/releasesController');

// GET /api/releases
router.get('/', releasesController.getAllReleases);

module.exports = router;
