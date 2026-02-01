import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { contact } from '../controllers/contact.controller';

const router = Router();

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10
});

router.post('/contact', limiter, contact);

export default router;
