import { Response, NextFunction } from 'express';

export const adminMiddleware = (req: any, res: Response, next: NextFunction) => {
    if (!req.user || req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Access denied. Admin only.' });
    }
    next();
};
