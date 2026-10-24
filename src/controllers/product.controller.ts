import { Request, Response } from 'express';
import pool from '../config/db';

export const getAllProducts = async (req: Request, res: Response) => {
    try {
        const [rows]: any = await pool.execute(`
            SELECT p.*, COUNT(pi.id) as stock_count 
            FROM products p 
            LEFT JOIN product_items pi ON p.id = pi.product_id AND pi.status = 'available'
            GROUP BY p.id
        `);
        return res.json({ success: true, products: rows });
    } catch (error) {
        return res.status(500).json({ error: 'Internal Server Error' });
    }
};

export const createProduct = async (req: Request, res: Response) => {
    const { name, retail_price, wholesale_price, description, status } = req.body;
    try {
        const [result]: any = await pool.execute(
            'INSERT INTO products (name, retail_price, wholesale_price, description, status) VALUES (?, ?, ?, ?, ?)',
            [name, retail_price, wholesale_price, description || null, status || 'published']
        );
        return res.status(201).json({ success: true, productId: result.insertId });
    } catch (error) {
        return res.status(500).json({ error: 'Internal Server Error' });
    }
};

export const updateProduct = async (req: Request, res: Response) => {
    const { id } = req.params;
    const { name, retail_price, wholesale_price, description, status } = req.body;
    try {
        await pool.execute(
            'UPDATE products SET name = ?, retail_price = ?, wholesale_price = ?, description = ?, status = ? WHERE id = ?',
            [name, retail_price, wholesale_price, description || null, status || 'published', id]
        );
        return res.json({ success: true, message: 'Product updated' });
    } catch (error) {
        return res.status(500).json({ error: 'Internal Server Error' });
    }
};

export const deleteProduct = async (req: Request, res: Response) => {
    const { id } = req.params;
    try {
        await pool.execute('DELETE FROM products WHERE id = ?', [id]);
        return res.json({ success: true, message: 'Product deleted' });
    } catch (error) {
        return res.status(500).json({ error: 'Internal Server Error' });
    }
};

export const importItems = async (req: Request, res: Response) => {
    const { id } = req.params;
    const { items } = req.body; // Expecting array of strings ["user|pass", "user2|pass2"]

    if (!Array.isArray(items)) {
        return res.status(400).json({ error: 'Items must be an array' });
    }

    try {
        const values = items.map(item => [id, item, 'available']);
        await pool.query(
            'INSERT INTO product_items (product_id, content, status) VALUES ?',
            [values]
        );
        return res.json({ success: true, message: `Imported ${items.length} items` });
    } catch (error) {
        console.error('Import error:', error);
        return res.status(500).json({ error: 'Internal Server Error' });
    }
};
