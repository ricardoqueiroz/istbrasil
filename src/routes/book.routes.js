console.log('book.routes.js carregado!');
const express = require('express');
const router = express.Router();
const bookController = require('../controllers/bookController');

// GET /api/books
router.get('/', bookController.getAllBooks);

module.exports = router;