const express = require('express');
const router = express.Router();
const bookController = require('../controllers/bookController');

// GET /api/books
router.get('/', bookController.getAllBooks);

// GET /api/books/:id
router.get('/:id', bookController.getBookById);

module.exports = router;