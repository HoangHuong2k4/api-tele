import dns from 'dns';
dns.setDefaultResultOrder('ipv4first');

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import bodyParser from 'body-parser';
import dotenv from 'dotenv';
import webhookRoutes from './routes/webhook.routes';
import authRoutes from './routes/auth.routes';
import productRoutes from './routes/product.routes';
import orderRoutes from './routes/order.routes';
import dealerRoutes from './routes/dealer.routes';
import { bankService } from './services/bank.service';
import { cryptoService } from './services/crypto.service';
import { apiProviderService } from './services/api-provider.service';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

app.use(helmet());
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Cleanup expired deposit requests every 1 minute
setInterval(() => {
    bankService.cleanupExpiredRequests();
}, 60000);

// Polling bank transactions every 1.5 seconds for instant fulfillment
setInterval(() => {
    bankService.syncAllBanks();
}, 1500);

// Polling Binance deposits every 10 seconds
setInterval(() => {
    cryptoService.syncAllBinance();
}, 10000);

// Polling API providers stock & balance every 30 seconds
setInterval(() => {
    apiProviderService.syncAllProviders();
}, 30000);

// Initial tasks
bankService.cleanupExpiredRequests();
bankService.syncAllBanks();
cryptoService.syncAllBinance();
apiProviderService.syncAllProviders();

import adminRoutes from './routes/admin.routes';

// Routes
app.use('/api/v1/webhooks', webhookRoutes);
app.post('/api/v1/webhooks/telegram/:tenantId/:tokenHash', async (req, res) => {
    const { tenantId, tokenHash } = req.params;
    try {
        const { telegramService } = await import('./services/telegram.service');
        await telegramService.handleUpdate(parseInt(tenantId), req.body);
        res.sendStatus(200);
    } catch (error) {
        console.error(`Webhook error for Tenant ${tenantId}:`, error);
        res.sendStatus(500);
    }
});
app.use('/api/v1/auth', authRoutes);
app.post('/api/v1/internal/restart', (req, res) => {
    res.json({ success: true, message: 'Restarting API...' });
    setTimeout(() => {
        process.exit(0);
    }, 500);
});
app.use('/api/v1/products', productRoutes);
app.use('/api/v1/orders', orderRoutes);
app.use('/api/v1/dealer', dealerRoutes);
app.use('/api/v1/admin', adminRoutes);

// Hot-reload bots API (for CMS integration)
app.get('/api/v1/admin/reload', async (req, res) => {
    const secret = req.query.secret;
    const expectedSecret = process.env.RELOAD_SECRET || 'phh_secret_reload';
    
    if (secret !== expectedSecret) {
        return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    try {
        const { telegramService } = await import('./services/telegram.service');
        await telegramService.initAllBots();
        res.json({ success: true, message: 'Bots reloaded successfully' });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html lang="vi">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Central Hub - Hương MMO</title>
            <style>
                body { font-family: 'Inter', sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #0f172a; color: white; }
                .card { background: rgba(255, 255, 255, 0.05); backdrop-filter: blur(10px); padding: 2rem; border-radius: 1rem; border: 1px solid rgba(255, 255, 255, 0.1); text-align: center; max-width: 400px; width: 90%; }
                h1 { color: #38bdf8; margin-bottom: 0.5rem; }
                p { color: #94a3b8; font-size: 1.1rem; }
                .contact { margin-top: 1.5rem; font-weight: bold; color: #f8fafc; }
                .badge { display: inline-block; padding: 0.25rem 0.75rem; background: #10b981; color: white; border-radius: 9999px; font-size: 0.8rem; margin-top: 1rem; }
            </style>
        </head>
        <body>
            <div class="card">
                <h1>Hương MMO</h1>
                <p>Hệ thống Central Hub API (Node-TS)</p>
                <div class="contact">
                    Phạm Hoàng Hương<br>
                    0932507102
                </div>
                <div class="badge">System Online</div>
            </div>
        </body>
        </html>
    `);
});

app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});
