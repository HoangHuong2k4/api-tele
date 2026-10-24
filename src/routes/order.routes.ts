import { Router } from 'express';
import * as orderController from '../controllers/order.controller';
import { authMiddleware } from '../middleware/auth.middleware';

const router = Router();

router.post('/checkout', authMiddleware, orderController.checkout);
router.get('/my-orders', authMiddleware, orderController.getMyOrders);

export default router;
