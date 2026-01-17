const express = require('express');
const router = express.Router();
const bookController = require('../controllers/bookController');

// GET /api/books
router.get('/', bookController.getAllBooks);

// GET /api/books/:id
router.get('/:id', bookController.getBookById);

// GET /api/books/download/:sku (Nova rota)
router.get('/download/:sku', bookController.downloadBook);

module.exports = router;