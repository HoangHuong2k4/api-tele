import axios from 'axios';
import pool from '../config/db';
import { TABLES } from '../config/tables';
import logger from '../config/logger';

class ApiProviderService {
    private isSyncing = false;

    /**
     * Tự động đồng bộ số lượng tồn kho và giá sỉ từ tất cả nhà cung cấp API đang hoạt động
     */
    public async syncAllProviders(): Promise<void> {
        if (this.isSyncing) return;
        this.isSyncing = true;

        try {
            const [providers]: any = await pool.execute(
                `SELECT * FROM ${TABLES.API_PROVIDERS} WHERE status = 'active' OR status = '1'`
            );

            if (!providers || providers.length === 0) {
                return;
            }

            for (const provider of providers) {
                await this.syncSingleProvider(provider);
            }
        } catch (error: any) {
            logger.error(`[ApiProviderSync] Lỗi tổng hợp: ${error.message}`);
        } finally {
            this.isSyncing = false;
        }
    }

    /**
     * Đồng bộ tồn kho và giá sỉ cho 1 nhà cung cấp cụ thể
     */
    public async syncSingleProvider(provider: any): Promise<void> {
        try {
            const baseUrl = (provider.base_url || '').replace(/\/+$/, '');
            if (!baseUrl) return;

            const catalogEndpoint = '/' + (provider.endpoint_catalog || '/api/v2/catalog').replace(/^\/+/, '');
            const catalogUrl = baseUrl + catalogEndpoint;
            const authHeader = provider.header_name || 'X-API-Key';

            const headers: Record<string, string> = {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
            };
            if (provider.auth_type === 'bearer') {
                headers['Authorization'] = `Bearer ${provider.api_key}`;
            } else {
                headers[authHeader] = provider.api_key;
            }

            // 1. Lấy danh sách catalog từ API đối tác
            const requestParams: Record<string, any> = {
                limit: 500,
                key: provider.api_key,
            };

            const response = await axios.get(catalogUrl, {
                headers,
                timeout: 15000,
                params: requestParams
            });

            if (!response.data) return;

            const data: any = response.data;
            const productsList: any[] = Array.isArray(data)
                ? data
                : (data.data?.products || data.products || data.data || []);

            if (!Array.isArray(productsList) || productsList.length === 0) {
                return;
            }

            let updatedCount = 0;
            for (const apiProd of productsList) {
                const apiProdId = String(apiProd.product_id || apiProd.productId || apiProd.id || '').trim();
                if (!apiProdId) continue;

                let costPrice = 0;
                if (typeof apiProd.price === 'object' && apiProd.price !== null) {
                    costPrice = parseFloat(apiProd.price.amount || apiProd.price.value || 0);
                } else {
                    costPrice = parseFloat(apiProd.price || apiProd.cost_price || 0);
                }

                const isAvailable = (apiProd.available !== false && apiProd.available !== 0 && apiProd.status !== 'inactive' && apiProd.status !== 0);
                let stockCount = 0;
                let soldCount = 0;
                if (typeof apiProd.availability === 'object' && apiProd.availability !== null) {
                    stockCount = parseInt(apiProd.availability.available || 0);
                    soldCount = parseInt(apiProd.availability.sold || 0);
                } else {
                    stockCount = isAvailable ? parseInt(apiProd.stock_count ?? apiProd.stock ?? apiProd.quantity ?? 0) : 0;
                    soldCount = parseInt(apiProd.sold ?? apiProd.sold_count ?? apiProd.sales ?? 0);
                }
                const deliveryMode = apiProd.delivery_mode || apiProd.productType || 'instant_items';

                // Kiểm tra xem sản phẩm có vừa lên hàng (từ hết hàng 0 lên >0) để thông báo
                try {
                    const [existingProds]: any = await pool.execute(
                        `SELECT id, tenant_id, name, price, api_stock FROM ${TABLES.PRODUCTS}
                         WHERE api_provider_id = ? AND api_product_id = ? AND is_api_product = 1`,
                        [provider.id, apiProdId]
                    );

                    if (existingProds && existingProds.length > 0) {
                        for (const prod of existingProds) {
                            const oldStock = prod.api_stock || 0;
                            if (oldStock <= 0 && stockCount > 0) {
                                logger.info(`[ApiProviderSync] Sản phẩm #${prod.id} (${prod.name}) VỪA LÊN HÀNG: kho cũ ${oldStock} -> mới ${stockCount}`);
                                const { telegramService } = await import('./telegram.service');
                                const restockMsg = `🎉 <b>THÔNG BÁO LÊN HÀNG (RESTOCK)</b>\n\n` +
                                    `🛍️ <b>Sản phẩm:</b> ${prod.name}\n` +
                                    `📦 <b>Số lượng kho mới:</b> <code>${stockCount}</code>\n` +
                                    `💰 <b>Giá bán:</b> <code>${Number(prod.price).toLocaleString()}đ</code>\n` +
                                    `🏪 <b>Kho sỉ:</b> ${provider.name || 'API Partner'}\n\n` +
                                    `👉 Đã cập nhật trên bot, khách hàng có thể mua ngay!`;
                                await telegramService.notifyAdmin(prod.tenant_id, restockMsg);

                                // Nếu có kênh thông báo bán hàng (telegram_sales_id), gửi tiếp vào kênh
                                const [cfgRows]: any = await pool.execute(
                                    `SELECT telegram_sales_id, bot_token FROM ${TABLES.BOT_CONFIGS} WHERE tenant_id = ? LIMIT 1`,
                                    [prod.tenant_id]
                                );
                                const salesChannel = cfgRows?.[0]?.telegram_sales_id;
                                if (salesChannel && cfgRows?.[0]?.bot_token) {
                                    axios.post(`https://api.telegram.org/bot${cfgRows[0].bot_token}/sendMessage`, {
                                        chat_id: salesChannel,
                                        text: restockMsg,
                                        parse_mode: 'HTML'
                                    }).catch((e: any) => logger.warn(`[ApiProviderSync] Không thể gửi vào channel ${salesChannel}: ${e.message}`));
                                }
                            }
                        }
                    }
                } catch (notifErr: any) {
                    logger.warn(`[ApiProviderSync] Kiểm tra thông báo lên hàng thất bại: ${notifErr.message}`);
                }

                // Cập nhật telehub_products cho tất cả sản phẩm đang liên kết với api_product_id này
                const [updateResult]: any = await pool.execute(
                    `UPDATE ${TABLES.PRODUCTS}
                     SET api_stock = ?,
                         api_sold = ?,
                         api_cost_price = ?,
                         api_delivery_mode = ?,
                         price = CASE 
                             WHEN api_markup_percent IS NOT NULL AND api_markup_percent > 0 
                             THEN ROUND(? * (1 + (api_markup_percent / 100)), -3)
                             ELSE price 
                         END,
                         updated_at = NOW()
                     WHERE api_provider_id = ? AND api_product_id = ? AND is_api_product = 1`,
                    [stockCount, soldCount, costPrice, deliveryMode, costPrice, provider.id, apiProdId]
                );

                if (updateResult.affectedRows > 0) {
                    updatedCount += updateResult.affectedRows;
                }
            }

            // 2. Lấy số dư ví nhà cung cấp (nếu có endpoint)
            let balance = provider.balance;
            try {
                const balanceEndpoint = '/' + (provider.endpoint_balance || '/api/v2/me').replace(/^\/+/, '');
                const balanceUrl = baseUrl + balanceEndpoint;
                const balRes: any = await axios.get(balanceUrl, {
                    headers,
                    params: { key: provider.api_key },
                    timeout: 8000
                });
                const balData: any = balRes.data?.data || balRes.data;
                if (balData) {
                    if (typeof balData.balance !== 'undefined') {
                        balance = balData.balance;
                    } else if (typeof balData.balanceVnd !== 'undefined') {
                        balance = balData.balanceVnd;
                    } else if (typeof balData.amount !== 'undefined') {
                        balance = balData.amount;
                    }
                }
            } catch {
                // Bỏ qua lỗi check balance
            }

            // Cập nhật last_sync_at và balance cho provider
            await pool.execute(
                `UPDATE ${TABLES.API_PROVIDERS} SET last_sync_at = NOW(), balance = ? WHERE id = ?`,
                [balance, provider.id]
            );

            if (updatedCount > 0) {
                logger.info(`[ApiProviderSync] Provider #${provider.id} (${provider.name}): Đồng bộ thành công ${updatedCount} sản phẩm (kho sỉ).`);
            }
        } catch (err: any) {
            logger.warn(`[ApiProviderSync] Lỗi đồng bộ provider #${provider.id}: ${err.message}`);
        }
    }
}

export const apiProviderService = new ApiProviderService();
