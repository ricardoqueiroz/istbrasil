import express from 'express';
import paypalController from '../controllers/paypalController.js';
const router = express.Router();

router.post('/create-order', paypalController.createOrder);
router.post('/capture-order', paypalController.captureOrder);
router.post('/webhook', paypalController.handleWebhook);

export default router;