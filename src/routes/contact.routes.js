import express from 'express';
import rateLimit from 'express-rate-limit';
import contactController from '../controllers/contactController.js';
const router = express.Router();

const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10
});

// POST /api/contact
router.post('/contact', limiter, contactController.sendContact);

export default router;
