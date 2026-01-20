import express from 'express';
import bookController from '../controllers/bookController.js';
const router = express.Router();

// GET /api/books
router.get('/', bookController.getAllBooks);

// GET /api/books/:id
router.get('/:id', bookController.getBookById);

// GET /api/books/download/:sku (Nova rota)
router.get('/download/:sku', bookController.downloadBook);

export default router;