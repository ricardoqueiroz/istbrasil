import express from 'express';
import releasesController from '../controllers/releasesController.js';
const router = express.Router();
// GET /api/releases
router.get('/', releasesController.getAllReleases);

// GET /api/releases/:releaseNum/tracks
router.get('/:releaseNum/tracks', releasesController.getReleaseTracks);

export default router;
