import { Request, Response } from 'express';
import pool from '../config/db';
import ExcelJS from 'exceljs';
import { TABLES } from '../config/tables';

export const getUsers = async (req: Request, res: Response) => {
    try {
        const page = parseInt(req.query.page as string) || 1;
        const limit = parseInt(req.query.limit as string) || 10;
        const search = req.query.search as string || '';
        const offset = (page - 1) * limit;

        let query = `SELECT id, full_name as telegram_username, balance FROM ${TABLES.CUSTOMERS}`;
        let countQuery = `SELECT COUNT(*) as total FROM ${TABLES.CUSTOMERS}`;
        const params: any[] = [];

        if (search) {
            query += ' WHERE full_name LIKE ? OR telegram_id LIKE ?';
            countQuery += ' WHERE full_name LIKE ? OR telegram_id LIKE ?';
            params.push(`%${search}%`, `%${search}%`);
        }

        query += ' ORDER BY id DESC LIMIT ? OFFSET ?';
        
        const [rows]: any = await pool.execute(query, [...params, limit.toString(), offset.toString()]);
        const [totalRows]: any = await pool.execute(countQuery, params);

        res.json({ 
            success: true, 
            users: rows,
            pagination: {
                total: totalRows[0].total,
                page,
                limit,
                totalPages: Math.ceil(totalRows[0].total / limit)
            }
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
};

export const updateUserBalance = async (req: Request, res: Response) => {
    const { id } = req.params;
    const { balance } = req.body;
    try {
        await pool.execute(`UPDATE ${TABLES.CUSTOMERS} SET balance = balance + ? WHERE id = ?`, [balance, id]);
        
        // Log transaction
        const [user]: any = await pool.execute(`SELECT balance, tenant_id FROM ${TABLES.CUSTOMERS} WHERE id = ?`, [id]);
        if (!user.length) return res.status(404).json({ error: 'User not found' });
        
        await pool.execute(
            `INSERT INTO ${TABLES.BALANCE_LOGS} (tenant_id, customer_id, amount, type, note, created_at, updated_at) VALUES (?, ?, ?, "IN", ?, NOW(), NOW())`,
            [user[0].tenant_id, id, balance, `Admin nạp hộ: ${balance.toLocaleString()}đ`]
        );

        res.json({ success: true, message: 'Balance updated' });
    } catch (error) {
        res.status(500).json({ error: 'Internal Server Error' });
    }
};

export const getProducts = async (req: Request, res: Response) => {
    try {
        const page = parseInt(req.query.page as string) || 1;
        const limit = parseInt(req.query.limit as string) || 10;
        const search = req.query.search as string || '';
        const offset = (page - 1) * limit;

        let query = `SELECT p.* FROM ${TABLES.PRODUCTS} p`;
        let countQuery = `SELECT COUNT(*) as total FROM ${TABLES.PRODUCTS}`;
        const params: any[] = [];

        if (search) {
            query += ' WHERE p.name LIKE ?';
            countQuery += ' WHERE name LIKE ?';
            params.push(`%${search}%`);
        }

        query += ' LIMIT ? OFFSET ?';

        const [rows]: any = await pool.execute(query, [...params, limit.toString(), offset.toString()]);
        const [totalRows]: any = await pool.execute(countQuery, params);

        // Add stocks
        for (const p of rows) {
            const [stock]: any = await pool.execute(`SELECT COUNT(*) as count FROM ${TABLES.PRODUCT_ITEMS} WHERE product_id = ? AND is_sold = 0`, [p.id]);
            const [sold]: any = await pool.execute(`SELECT COUNT(*) as count FROM ${TABLES.PRODUCT_ITEMS} WHERE product_id = ? AND is_sold = 1`, [p.id]);
            p.stock_count = stock[0].count;
            p.sold_count = sold[0].count;
        }

        res.json({ 
            success: true, 
            products: rows,
            pagination: {
                total: totalRows[0].total,
                page,
                limit,
                totalPages: Math.ceil(totalRows[0].total / limit)
            }
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
};

export const importItems = async (req: Request, res: Response) => {
    const { id } = req.params;
    const { items, tenant_id } = req.body; 

    if (!Array.isArray(items)) return res.status(400).json({ error: 'Items must be an array' });

    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        for (const line of items) {
            const parts = line.split('|');
            const content = parts.slice(0, 2).join('|');
            const note = parts.slice(2).join('|') || '';
            
            await connection.execute(
                `INSERT INTO ${TABLES.PRODUCT_ITEMS} (tenant_id, product_id, content, note, is_sold) VALUES (?, ?, ?, ?, 0)`,
                [tenant_id || 1, id, content, note]
            );
        }
        await connection.commit();
        res.json({ success: true, message: `Imported ${items.length} items` });
    } catch (error) {
        await connection.rollback();
        res.status(500).json({ error: 'Internal Server Error' });
    } finally {
        connection.release();
    }
};

export const getProductItems = async (req: Request, res: Response) => {
    const { id } = req.params;
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const search = req.query.search as string || '';
    const status = req.query.status as string || '';
    const offset = (page - 1) * limit;

    try {
        let query = `SELECT * FROM ${TABLES.PRODUCT_ITEMS} WHERE product_id = ?`;
        let countQuery = `SELECT COUNT(*) as total FROM ${TABLES.PRODUCT_ITEMS} WHERE product_id = ?`;
        const params: any[] = [id];

        if (search) {
            query += ' AND (content LIKE ? OR note LIKE ?)';
            countQuery += ' AND (content LIKE ? OR note LIKE ?)';
            params.push(`%${search}%`, `%${search}%`);
        }
        if (status) {
            const isSold = status === 'sold' ? 1 : 0;
            query += ' AND is_sold = ?';
            countQuery += ' AND is_sold = ?';
            params.push(isSold);
        }

        query += ' ORDER BY id DESC LIMIT ? OFFSET ?';
        const [rows]: any = await pool.execute(query, [...params, limit.toString(), offset.toString()]);
        const [totalRows]: any = await pool.execute(countQuery, params);

        res.json({
            success: true,
            items: rows,
            pagination: {
                total: totalRows[0].total,
                page,
                limit,
                totalPages: Math.ceil(totalRows[0].total / limit)
            }
        });
    } catch (error) {
        res.status(500).json({ error: 'Internal Server Error' });
    }
};

export const deleteProductItem = async (req: Request, res: Response) => {
    const { itemId } = req.params;
    try {
        await pool.execute(`DELETE FROM ${TABLES.PRODUCT_ITEMS} WHERE id = ?`, [itemId]);
        res.json({ success: true, message: 'Item deleted' });
    } catch (error) {
        res.status(500).json({ error: 'Internal Server Error' });
    }
};

export const deleteUser = async (req: Request, res: Response) => {
    const { id } = req.params;
    try {
        await pool.execute(`DELETE FROM ${TABLES.CUSTOMERS} WHERE id = ?`, [id]);
        res.json({ success: true, message: 'User deleted' });
    } catch (error) {
        res.status(500).json({ error: 'Internal Server Error' });
    }
};

export const importExcel = async (req: Request, res: Response) => {
    const { id } = req.params;
    const { base64, tenant_id } = req.body;

    if (!base64) return res.status(400).json({ error: 'No file data provided' });

    try {
        const buffer = Buffer.from(base64, 'base64');
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load(buffer as any);
        const worksheet = workbook.getWorksheet(1);
        if (!worksheet) return res.status(400).json({ error: 'Invalid Excel file' });

        const items: any[] = [];
        worksheet.eachRow((row, rowNumber) => {
            if (rowNumber === 1) return; // Skip header
            const content = row.getCell(1).text;
            const note = row.getCell(2).text || '';
            if (content) {
                items.push({ content, note });
            }
        });

        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();
            for (const item of items) {
                const parts = item.content.split('|');
                const finalContent = parts.slice(0, 2).join('|');
                const finalNote = item.note || parts.slice(2).join('|') || '';
                
                await connection.execute(
                    `INSERT INTO ${TABLES.PRODUCT_ITEMS} (tenant_id, product_id, content, note, is_sold) VALUES (?, ?, ?, ?, 0)`,
                    [tenant_id || 1, id, finalContent, finalNote]
                );
            }
            await connection.commit();
            res.json({ success: true, message: `Imported ${items.length} items from Excel` });
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
};

export const downloadSampleExcel = async (req: Request, res: Response) => {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Sample');
    worksheet.columns = [
        { header: 'Nội dung (Email|Pass)', key: 'content', width: 30 },
        { header: 'Ghi chú (Tùy chọn)', key: 'note', width: 20 }
    ];
    worksheet.addRow({ content: 'account1|pass123', note: 'Ghi chú 1' });
    worksheet.addRow({ content: 'account2|pass456', note: 'Ghi chú 2' });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="sample_import.xlsx"');

    await workbook.xlsx.write(res);
    res.end();
};

export const updateUser = async (req: Request, res: Response) => {
    const { id } = req.params;
    const { balance, full_name } = req.body;
    try {
        const [user]: any = await pool.execute(`SELECT * FROM ${TABLES.CUSTOMERS} WHERE id = ?`, [id]);
        if (!user.length) return res.status(404).json({ error: 'User not found' });

        await pool.execute(
            `UPDATE ${TABLES.CUSTOMERS} SET full_name = ?, balance = ? WHERE id = ?`,
            [full_name || user[0].full_name, balance !== undefined ? balance : user[0].balance, id]
        );
        res.json({ success: true, message: 'User updated' });
    } catch (error) {
        res.status(500).json({ error: 'Internal Server Error' });
    }
};

export const getStats = async (req: Request, res: Response) => {
    try {
        const [userCount]: any = await pool.execute(`SELECT COUNT(*) as count FROM ${TABLES.CUSTOMERS}`);
        const [productCount]: any = await pool.execute(`SELECT COUNT(*) as count FROM ${TABLES.PRODUCTS}`);
        const [orderCount]: any = await pool.execute('SELECT COUNT(*) as count FROM telehub_orders');
        const [revenue]: any = await pool.execute('SELECT SUM(total_amount) as total FROM telehub_orders WHERE status = "completed"');

        res.json({
            success: true,
            stats: {
                userCount: userCount[0].count,
                productCount: productCount[0].count,
                orderCount: orderCount[0].count,
                revenue: revenue[0].total || 0
            }
        });
    } catch (error) {
        res.status(500).json({ error: 'Internal Server Error' });
    }
};

export const reloadBots = async (req: Request, res: Response) => {
    try {
        const { telegramService } = await import('../services/telegram.service');
        await telegramService.initAllBots();
        res.json({ success: true, message: 'Bots reloaded successfully' });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message });
    }
};

export const broadcastNotification = async (req: Request, res: Response) => {
    try {
        const { tenant_id, message, image, reply_markup } = req.body;
        if (!tenant_id || !message) {
            return res.status(400).json({ success: false, message: 'tenant_id and message are required' });
        }
        const { telegramService } = await import('../services/telegram.service');
        telegramService.broadcastNotification(parseInt(tenant_id), message, image, reply_markup).catch(err => {
            console.error('[Admin] Broadcast async error:', err);
        });
        res.json({ success: true, message: 'Broadcast initiated successfully in background at 25 msg/s' });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message });
    }
};

