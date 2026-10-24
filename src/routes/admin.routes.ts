import { Router } from 'express';
import * as adminController from '../controllers/admin.controller';
import { adminMiddleware } from '../middleware/admin.middleware';
import jwt from 'jsonwebtoken';

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || 'supersecretkey';

// Middleware to verify JWT and attach user
const authMiddleware = (req: any, res: any, next: any) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'No token provided' });

    const token = authHeader.split(' ')[1];
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded;
        next();
    } catch (error) {
        res.status(401).json({ error: 'Invalid token' });
    }
};

router.use(authMiddleware);
router.use(adminMiddleware);

router.get('/stats', adminController.getStats);
router.get('/users', adminController.getUsers);
router.put('/users/:id', adminController.updateUser);
router.delete('/users/:id', adminController.deleteUser);
router.put('/users/:id/balance', adminController.updateUserBalance);
router.get('/products', adminController.getProducts);
router.post('/products/:id/import', adminController.importItems);
router.get('/products/:id/items', adminController.getProductItems);
router.delete('/products/items/:itemId', adminController.deleteProductItem);
router.post('/products/:id/import-excel', adminController.importExcel);
router.get('/products/sample-excel', adminController.downloadSampleExcel);
router.post('/broadcast', adminController.broadcastNotification);

export default router;
