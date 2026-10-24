import express from 'express';
import pool from '../config/db';
import { TABLES } from '../config/tables';
import { telegramService } from '../services/telegram.service';

const router = express.Router();

// Middleware to authenticate via X-API-KEY
const authenticateApiKey = async (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const apiKey = req.header('X-API-KEY');
    if (!apiKey) {
        return res.status(401).json({ success: false, error: 'Thiếu header X-API-KEY' });
    }

    try {
        const [rows]: any = await pool.execute(`
            SELECT id, tenant_id, full_name, balance, is_dealer 
            FROM ${TABLES.CUSTOMERS} 
            WHERE api_key = ? AND is_dealer = 1
        `, [apiKey]);

        if (rows.length === 0) {
            return res.status(403).json({ success: false, error: 'API key không hợp lệ hoặc bạn không phải là Cộng Tác Viên' });
        }

        (req as any).dealer = rows[0];
        next();
    } catch (err: any) {
        console.error('API Key Auth Error:', err);
        res.status(500).json({ success: false, error: 'Lỗi server' });
    }
};

router.use(authenticateApiKey);

// GET /api/v1/dealer/stock
router.get('/stock', async (req, res) => {
    try {
        const dealer = (req as any).dealer;
        const tenantId = dealer.tenant_id;
        const customerId = dealer.id;

        // Lấy danh sách sản phẩm (chỉ lấy các sản phẩm published)
        const [products]: any = await pool.execute(`
            SELECT p.id, p.name, p.price, p.price_usd, p.status, p.is_api_product, p.api_stock 
            FROM ${TABLES.PRODUCTS} p
            WHERE p.tenant_id = ? AND p.status = 'published'
        `, [tenantId]);

        // Lấy danh sách tồn kho cho các sản phẩm
        const [stocks]: any = await pool.execute(`
            SELECT product_id, COUNT(*) as stock 
            FROM ${TABLES.PRODUCT_ITEMS} 
            WHERE tenant_id = ? AND is_sold = 0
            GROUP BY product_id
        `, [tenantId]);

        // Lấy bảng giá sỉ của CTV này
        const [dealerPrices]: any = await pool.execute(`
            SELECT product_id, price, price_usd 
            FROM ${TABLES.DEALER_PRICES} 
            WHERE tenant_id = ? AND customer_id = ?
        `, [tenantId, customerId]);

        const stockMap = new Map(stocks.map((s: any) => [s.product_id, s.stock]));
        const priceMap = new Map(dealerPrices.map((p: any) => [p.product_id, p]));

        const resultProducts: Record<string, any> = {};

        for (const p of products) {
            const stock = p.is_api_product === 1 ? (p.api_stock || 0) : (stockMap.get(p.id) || 0);
            const dp: any = priceMap.get(p.id);
            const price = (dp && dp.price !== null && dp.price !== undefined) ? dp.price : p.price;
            const priceUsd = (dp && dp.price_usd !== null && dp.price_usd !== undefined) ? dp.price_usd : p.price_usd;

            resultProducts[p.id.toString()] = {
                name: p.name,
                price: Number(price),
                price_usd: priceUsd !== null && priceUsd !== undefined ? Number(priceUsd) : null,
                stock: Number(stock),
                type: 'account'
            };
        }

        res.json({
            success: true,
            dealer: dealer.full_name || 'Khách hàng',
            balance: Number(dealer.balance),
            products: resultProducts
        });

    } catch (err: any) {
        console.error('Dealer Stock Error:', err);
        res.status(500).json({ success: false, error: 'Lỗi server' });
    }
});

// GET /api/v1/dealer/balance
router.get('/balance', async (req, res) => {
    try {
        const dealer = (req as any).dealer;
        
        // Query again to get fresh balance
        const [rows]: any = await pool.execute(`
            SELECT balance FROM ${TABLES.CUSTOMERS} WHERE id = ?
        `, [dealer.id]);

        res.json({
            success: true,
            dealer: dealer.full_name || 'Khách hàng',
            balance: Number(rows[0].balance)
        });
    } catch (err: any) {
        console.error('Dealer Balance Error:', err);
        res.status(500).json({ success: false, error: 'Lỗi server' });
    }
});

// POST /api/v1/dealer/buy
router.post('/buy', async (req, res) => {
    try {
        const dealer = (req as any).dealer;
        const { product_key, qty, order_code } = req.body;

        if (!product_key) {
            return res.status(400).json({ success: false, error: 'Thiếu product_key' });
        }
        
        const quantity = parseInt(qty);
        if (isNaN(quantity) || quantity <= 0 || quantity > 100) {
            return res.status(400).json({ success: false, error: 'Số lượng không hợp lệ (1-100)' });
        }

        const purchaseResult = await telegramService.handleDirectPurchase(
            dealer.tenant_id, 
            dealer.id, 
            product_key, 
            quantity, 
            order_code
        );

        if (purchaseResult.success) {
            // Tính tổng tiền đã trừ (chênh lệch số dư)
            const oldBalance = Number(dealer.balance);
            const newBalance = Number(purchaseResult.remainingBalance);
            const totalCharged = oldBalance - newBalance;

            // Notify admin via bot
            const [prodRows]: any = await pool.execute(`SELECT name FROM ${TABLES.PRODUCTS} WHERE id = ?`, [product_key]);
            const prodName = prodRows[0]?.name || product_key;

            const itemsFormatted = purchaseResult.items.map((item: string) => {
                return item.split('\n').map(line => {
                    const trimmed = line.trim();
                    if (trimmed.startsWith('http')) return trimmed;
                    return `<code>${trimmed}</code>`;
                }).join('\n');
            }).join('\n');

            const adminMsg = [
                `🤝 <b>CTV MUA HÀNG QUA API</b>`,
                `👤 <b>CTV:</b> ${dealer.full_name} (ID: ${dealer.id})`,
                `📦 <b>Sản phẩm:</b> ${quantity} x ${prodName}`,
                `💵 <b>Tổng thanh toán:</b> ${new Intl.NumberFormat('vi-VN').format(totalCharged)}đ`,
                order_code ? `📑 <b>Mã đơn:</b> <code>${order_code}</code>` : '',
                `━━━━━━━━━━━━━━━━━━`,
                `📑 <b>Tài khoản xuất:</b>`,
                itemsFormatted
            ].filter(Boolean).join('\n');

            await telegramService.notifyAdmin(dealer.tenant_id, adminMsg);

            res.json({
                success: true,
                product: product_key,
                items: purchaseResult.items,
                qty: quantity,
                total_charged: totalCharged,
                balance_remaining: newBalance,
                order_code: order_code || purchaseResult.orderId?.toString()
            });
        } else {
            res.json({ success: false, error: purchaseResult.error });
        }
    } catch (err: any) {
        console.error('Dealer Buy Error:', err);
        res.status(500).json({ success: false, error: 'Lỗi server' });
    }
});

export default router;
