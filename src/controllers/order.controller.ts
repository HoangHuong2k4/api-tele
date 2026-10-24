import { Request, Response } from 'express';
import pool from '../config/db';

export const checkout = async (req: any, res: Response) => {
    const { product_id, quantity } = req.body;
    const userId = req.user.id;

    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        // 1. Get user balance and lock the row
        const [userRows]: any = await connection.execute(
            'SELECT balance FROM users WHERE id = ? FOR UPDATE',
            [userId]
        );
        const balance = userRows[0].balance;

        // 2. Get product price
        const [productRows]: any = await connection.execute(
            'SELECT retail_price FROM products WHERE id = ?',
            [product_id]
        );
        const price = productRows[0].retail_price;
        const total = price * quantity;

        if (balance < total) {
            throw new Error('Insufficient balance');
        }

        // 3. Check inventory and lock items
        const [items]: any = await connection.execute(
            'SELECT id FROM product_items WHERE product_id = ? AND status = "available" LIMIT ? FOR UPDATE SKIP LOCKED',
            [product_id, quantity]
        );

        if (items.length < quantity) {
            throw new Error('Not enough items in stock');
        }

        // 4. Record order
        const [orderResult]: any = await connection.execute(
            'INSERT INTO orders (user_id, total_amount, status, type) VALUES (?, ?, "completed", "purchase")',
            [userId, total]
        );
        const orderId = orderResult.insertId;

        // 5. Deduct balance
        await connection.execute(
            'UPDATE users SET balance = balance - ? WHERE id = ?',
            [total, userId]
        );

        // 6. Update items status and link to order
        for (const item of items) {
            await connection.execute(
                'UPDATE product_items SET status = "sold" WHERE id = ?',
                [item.id]
            );
            // Assuming we have an order_details table
            await connection.execute(
                'INSERT INTO order_details (order_id, product_id, quantity, price) VALUES (?, ?, 1, ?)',
                [orderId, product_id, price]
            );
        }

        await connection.commit();
        return res.json({ success: true, orderId, message: 'Purchase successful' });

    } catch (error: any) {
        await connection.rollback();
        return res.status(400).json({ error: error.message });
    } finally {
        connection.release();
    }
};

export const getMyOrders = async (req: any, res: Response) => {
    try {
        const [rows]: any = await pool.execute(
            'SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC',
            [req.user.id]
        );
        return res.json({ success: true, orders: rows });
    } catch (error) {
        return res.status(500).json({ error: 'Internal Server Error' });
    }
};
