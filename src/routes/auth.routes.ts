import { Router } from 'express';
import * as authController from '../controllers/auth.controller';
import { authMiddleware } from '../middleware/auth.middleware';

const router = Router();

router.post('/register', authController.register);
router.post('/login', authController.login);
router.get('/profile', authMiddleware, authController.getProfile);
router.delete('/:id', authMiddleware, authController.deleteUser); // Ideally restricted to admin

export default router;
