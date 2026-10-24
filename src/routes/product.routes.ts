import { Router } from 'express';
import * as productController from '../controllers/product.controller';
import { authMiddleware } from '../middleware/auth.middleware';

const router = Router();

router.get('/', productController.getAllProducts);
router.post('/', authMiddleware, productController.createProduct); // Admin only ideally
router.put('/:id', authMiddleware, productController.updateProduct);
router.delete('/:id', authMiddleware, productController.deleteProduct);
router.post('/:id/import', authMiddleware, productController.importItems);

export default router;
