const express = require('express');
const router = express.Router();
const obraController = require('../controllers/obraController');

// GET /api/obra
router.get('/', obraController.getAllObras);

module.exports = router;
