import axios from 'axios';
import * as https from 'https';
import pool from '../config/db';
import { TABLES } from '../config/tables';
import logger from '../config/logger';
import { telegramService } from './telegram.service';

const ipv4HttpsAgent = new https.Agent({ family: 4, keepAlive: true });

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
                httpsAgent: ipv4HttpsAgent,
                timeout: 15000,
                params: requestParams
            } as any);

            if (!response.data) return;

            const data: any = response.data;
            let balance = provider.balance;
            if (typeof data.balance !== 'undefined') {
                balance = data.balance;
            } else if (typeof data.credit !== 'undefined') {
                balance = data.credit;
            }

            let productsList: any[] = [];
            if (Array.isArray(data)) {
                productsList = data;
            } else if (data.data?.products) {
                if (Array.isArray(data.data.products)) {
                    productsList = data.data.products;
                } else if (typeof data.data.products === 'object') {
                    productsList = Object.entries(data.data.products).map(([name, info]: [string, any]) => ({
                        product_id: name,
                        product_key: name,
                        name: (typeof info === 'object' && info?.name) ? info.name : name,
                        ...(typeof info === 'object' && info !== null ? info : { stock: info })
                    }));
                }
            } else if (data.products) {
                if (Array.isArray(data.products)) {
                    productsList = data.products;
                } else if (typeof data.products === 'object') {
                    productsList = Object.entries(data.products).map(([name, info]: [string, any]) => ({
                        product_id: name,
                        product_key: name,
                        name: (typeof info === 'object' && info?.name) ? info.name : name,
                        ...(typeof info === 'object' && info !== null ? info : { stock: info })
                    }));
                }
            } else if (Array.isArray(data.data)) {
                productsList = data.data;
            }

            // Hỗ trợ API chuyên biệt đơn lẻ (như Safe24 / Offer Pixel Bot qua /api/profile)
            if (productsList.length === 0 && (typeof data.price !== 'undefined' || typeof data.credit !== 'undefined' || baseUrl.includes('apisafe24'))) {
                const priceUsd = parseFloat(data.price || 1.2);
                const priceVnd = Math.round(priceUsd * 26000);
                productsList = [{
                    product_id: 'offer_pixel_google_one',
                    product_key: 'offer_pixel_google_one',
                    name: 'Kích Hoạt Gói Google One 2TB (Pixel Offer)',
                    price: priceVnd,
                    cost_price: priceVnd,
                    price_usd: priceUsd,
                    stock: 999,
                    available: true,
                    delivery_mode: 'account_upgrade'
                }];
            }

            if (!Array.isArray(productsList) || productsList.length === 0) {
                return;
            }

            let updatedCount = 0;
            for (const apiProd of productsList) {
                const apiProdId = String(apiProd.product_id || apiProd.product_key || apiProd.productId || apiProd.id || apiProd.name || '').trim();
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
                if (stockCount < 0) {
                    stockCount = 0;
                }
                const deliveryMode = apiProd.delivery_mode || apiProd.productType || apiProd.type || 'instant_items';

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
                         api_sold = CASE WHEN ? > 0 THEN ? ELSE api_sold END,
                         api_cost_price = ?,
                         api_delivery_mode = ?,
                         price = CASE 
                             WHEN api_markup_percent IS NOT NULL AND api_markup_percent > 0 
                             THEN ROUND(? * (1 + (api_markup_percent / 100)), -3)
                             ELSE price 
                         END,
                         updated_at = NOW()
                     WHERE api_provider_id = ? AND api_product_id = ? AND is_api_product = 1`,
                    [stockCount, soldCount, soldCount, costPrice, deliveryMode, costPrice, provider.id, apiProdId]
                );

                if (updateResult.affectedRows > 0) {
                    updatedCount += updateResult.affectedRows;
                }
            }

            // 2. Lấy số dư ví nhà cung cấp (nếu có endpoint)
            try {
                const balanceEndpoint = '/' + (provider.endpoint_balance || '/api/v2/me').replace(/^\/+/, '');
                const balanceUrl = baseUrl + balanceEndpoint;
                const balRes: any = await axios.get(balanceUrl, {
                    headers,
                    httpsAgent: ipv4HttpsAgent,
                    params: { key: provider.api_key },
                    timeout: 8000
                } as any);
                const balData: any = balRes.data?.data || balRes.data;
                if (balData) {
                    if (typeof balData.balance !== 'undefined') {
                        balance = balData.balance;
                    } else if (typeof balData.credit !== 'undefined') {
                        balance = balData.credit;
                    } else if (typeof balData.balance_remaining !== 'undefined') {
                        balance = balData.balance_remaining;
                    } else if (typeof balData.balanceVnd !== 'undefined') {
                        balance = balData.balanceVnd;
                    } else if (typeof balData.amount !== 'undefined') {
                        balance = balData.amount;
                    } else if (typeof balData.new_balance !== 'undefined') {
                        balance = balData.new_balance;
                    }
                }
            } catch {
                // Bỏ qua lỗi check balance
            }

            // Cập nhật last_sync_at, balance và raw_data cho provider
            await pool.execute(
                `UPDATE ${TABLES.API_PROVIDERS} SET last_sync_at = NOW(), balance = ?, raw_data = ? WHERE id = ?`,
                [balance, JSON.stringify(data.data || data), provider.id]
            );

            if (updatedCount > 0) {
                logger.info(`[ApiProviderSync] Provider #${provider.id} (${provider.name}): Đồng bộ thành công ${updatedCount} sản phẩm (kho sỉ).`);
            }
        } catch (err: any) {
            logger.warn(`[ApiProviderSync] Lỗi đồng bộ provider #${provider.id}: ${err.message}`);
        }
    }

    private isCheckingJobs = false;

    /**
     * Tự động kiểm tra trạng thái các đơn hàng API bất đồng bộ (như Safe24 Google One / Pixel Offer)
     */
    public async checkPendingJobs(): Promise<void> {
        if (this.isCheckingJobs) return;
        this.isCheckingJobs = true;

        try {
            // Lấy các đơn hàng API đang ở trạng thái chờ hoặc đang xử lý
            const [orders]: any = await pool.execute(`
                SELECT o.id, o.code, o.tenant_id, o.customer_id, o.api_provider_id, o.api_order_code, 
                       o.api_status, o.api_response, o.created_at,
                       p.base_url, p.auth_type, p.header_name, p.api_key
                FROM ${TABLES.ORDERS} o
                JOIN ${TABLES.API_PROVIDERS} p ON p.id = o.api_provider_id
                WHERE o.api_order_code IS NOT NULL
                  AND o.api_status IN ('queued', 'pending', 'processing')
                  AND o.created_at >= NOW() - INTERVAL 48 HOUR
                ORDER BY o.id ASC
                LIMIT 30
            `);

            if (!orders || orders.length === 0) return;

            for (const order of orders) {
                await this.checkSingleJobStatus(order);
            }
        } catch (error: any) {
            logger.error(`[JobStatusCheck] Lỗi kiểm tra tiến trình: ${error.message}`);
        } finally {
            this.isCheckingJobs = false;
        }
    }

    /**
     * Kiểm tra và cập nhật trạng thái của 1 Job cụ thể
     */
    public async checkSingleJobStatus(order: any): Promise<any> {
        try {
            let baseUrl = (order.base_url || '').replace(/\/+$/, '');
            let apiKey = order.api_key;
            let headerName = order.header_name || 'x-api-key';
            let authType = order.auth_type || 'header';

            // Nếu order chưa join provider info
            if (!baseUrl && order.api_provider_id) {
                const [provs]: any = await pool.execute(`SELECT * FROM ${TABLES.API_PROVIDERS} WHERE id = ?`, [order.api_provider_id]);
                if (provs && provs.length > 0) {
                    baseUrl = (provs[0].base_url || '').replace(/\/+$/, '');
                    apiKey = provs[0].api_key;
                    headerName = provs[0].header_name || 'x-api-key';
                    authType = provs[0].auth_type || 'header';
                }
            }

            if (!baseUrl || !order.api_order_code) return null;

            const headers: Record<string, string> = {
                'Accept': 'application/json',
            };
            if (authType === 'bearer') {
                headers['Authorization'] = `Bearer ${apiKey}`;
            } else {
                headers[headerName] = apiKey;
            }

            const statusUrl = `${baseUrl}/api/jobs/status/${encodeURIComponent(order.api_order_code)}`;
            const resp = await axios.get(statusUrl, {
                headers,
                httpsAgent: ipv4HttpsAgent,
                timeout: 15000
            } as any);

            if (!resp?.data) return null;
            const data: any = resp.data;
            const newStatus = (data.status || '').toLowerCase();
            const progress = data.progress !== undefined ? data.progress : null;
            const note = data.note || '';
            const resultLink = data.result_link || '';

            if (!newStatus || newStatus === (order.api_status || '').toLowerCase()) {
                // Vẫn update api_response nếu có thay đổi progress/note
                if (progress !== null || note) {
                    await pool.execute(
                        `UPDATE ${TABLES.ORDERS} SET api_response = ? WHERE id = ?`,
                        [JSON.stringify(data), order.id]
                    );
                }
                return data;
            }

            logger.info(`[JobStatusCheck] Order #${order.code} (Job ${order.api_order_code}) đổi trạng thái: ${order.api_status} -> ${newStatus}`);

            // Cập nhật database
            await pool.execute(
                `UPDATE ${TABLES.ORDERS} SET api_status = ?, api_response = ?, updated_at = NOW() WHERE id = ?`,
                [newStatus, JSON.stringify(data), order.id]
            );

            // Lấy thông tin khách hàng và ngôn ngữ
            const [custRows]: any = await pool.execute(
                `SELECT telegram_id, language, full_name, username FROM ${TABLES.CUSTOMERS} WHERE id = ? AND tenant_id = ?`,
                [order.customer_id, order.tenant_id]
            );
            const customer = custRows?.[0];

            // Lấy thông tin tài khoản đã giao
            const [itemRows]: any = await pool.execute(
                `SELECT id, content FROM ${TABLES.PRODUCT_ITEMS} WHERE order_id = ? AND tenant_id = ?`,
                [order.id, order.tenant_id]
            );

            // Trích xuất credentials nếu có trong deposit_requests
            let targetEmail = '';
            let credentialsStr = '';
            const [depRows]: any = await pool.execute(
                `SELECT credentials FROM ${TABLES.DEPOSIT_REQUESTS} WHERE payment_code = ? AND tenant_id = ? LIMIT 1`,
                [order.code, order.tenant_id]
            );
            if (depRows?.[0]?.credentials) {
                credentialsStr = depRows[0].credentials;
                targetEmail = credentialsStr.split('|')[0]?.trim();
            }

            const timeVN = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
            const lang = customer?.language || 'vi';

            if (newStatus === 'completed' || newStatus === 'success') {
                const completedContent = [
                    `🎉 <b>NÂNG CẤP TÀI KHOẢN THÀNH CÔNG!</b>`,
                    targetEmail ? `📧 <b>Tài khoản:</b> <code>${targetEmail}</code>` : '',
                    `🆔 <b>Mã tiến trình (Job ID):</b> <code>${order.api_order_code}</code>`,
                    resultLink ? `🎁 <b>Kết quả:</b> ${resultLink}` : '',
                    note ? `📝 <b>Ghi chú:</b> ${note}` : '',
                    `🕒 <b>Thời gian hoàn tất:</b> ${timeVN}`
                ].filter(Boolean).join('\n');

                if (itemRows && itemRows.length > 0) {
                    await pool.execute(
                        `UPDATE ${TABLES.PRODUCT_ITEMS} SET content = ? WHERE id = ?`,
                        [completedContent, itemRows[0].id]
                    );
                }

                if (customer?.telegram_id) {
                    const custMsg = (lang === 'en')
                        ? [
                            `🎉 <b>ACCOUNT UPGRADE COMPLETED!</b>`,
                            ``,
                            `📦 <b>Order:</b> <code>${order.code}</code>`,
                            targetEmail ? `📧 <b>Account:</b> <code>${targetEmail}</code>` : '',
                            `🆔 <b>Job ID:</b> <code>${order.api_order_code}</code>`,
                            resultLink ? `🎁 <b>Gift/Activation Link:</b> ${resultLink}` : '',
                            note ? `📝 <b>Note:</b> ${note}` : '',
                            `🕒 <b>Completed at:</b> ${timeVN}`,
                            ``,
                            `✨ <i>Thank you for using our service! Your package is now active.</i>`
                          ].filter(Boolean).join('\n')
                        : [
                            `🎉 <b>CHÚC MỪNG: TÀI KHOẢN ĐÃ ĐƯỢC NÂNG CẤP THÀNH CÔNG!</b>`,
                            ``,
                            `📦 <b>Đơn hàng:</b> <code>${order.code}</code>`,
                            targetEmail ? `📧 <b>Tài khoản:</b> <code>${targetEmail}</code>` : '',
                            `🆔 <b>Mã tiến trình (Job ID):</b> <code>${order.api_order_code}</code>`,
                            resultLink ? `🎁 <b>Link kích hoạt / Quà tặng:</b> ${resultLink}` : '',
                            note ? `📝 <b>Ghi chú:</b> ${note}` : '',
                            `🕒 <b>Hoàn tất lúc:</b> ${timeVN}`,
                            ``,
                            `✨ <i>Cảm ơn bạn đã tin tưởng sử dụng dịch vụ!</i>`
                          ].filter(Boolean).join('\n');

                    await telegramService.notifyUser(order.tenant_id, customer.telegram_id, custMsg, { parse_mode: 'HTML' });
                }

                const adminMsg = [
                    `✅ <b>[ĐƠN HÀNG API HOÀN TẤT THÀNH CÔNG]</b>`,
                    `🕒 <b>Thời gian:</b> ${timeVN}`,
                    `📝 <b>Mã đơn:</b> <code>${order.code}</code> (Job: <code>${order.api_order_code}</code>)`,
                    `👤 <b>Khách hàng:</b> ${customer?.full_name || ''} | @${customer?.username || 'N/A'} (ID: <code>${customer?.telegram_id}</code>)`,
                    targetEmail ? `📧 <b>Tài khoản:</b> <code>${targetEmail}</code>` : '',
                    resultLink ? `🎁 <b>Kết quả:</b> ${resultLink}` : '',
                    note ? `📝 <b>Ghi chú:</b> ${note}` : ''
                ].filter(Boolean).join('\n');
                telegramService.notifyAdmin(order.tenant_id, adminMsg);

            } else if (newStatus === 'failed' || newStatus === 'error') {
                const failedContent = [
                    `⚠️ <b>KÍCH HOẠT KHÔNG THÀNH CÔNG</b>`,
                    targetEmail ? `📧 <b>Tài khoản:</b> <code>${targetEmail}</code>` : '',
                    `🆔 <b>Job ID:</b> <code>${order.api_order_code}</code>`,
                    `❌ <b>Lý do:</b> ${note || 'Hệ thống Google từ chối hoặc yêu cầu bảo mật'}`,
                    progress !== null ? `📊 <b>Tiến trình dừng ở:</b> ${progress}%` : '',
                    `📌 <i>Vui lòng liên hệ Admin để được hỗ trợ kiểm tra hoặc đổi tài khoản.</i>`
                ].filter(Boolean).join('\n');

                if (itemRows && itemRows.length > 0) {
                    await pool.execute(
                        `UPDATE ${TABLES.PRODUCT_ITEMS} SET content = ? WHERE id = ?`,
                        [failedContent, itemRows[0].id]
                    );
                }

                if (customer?.telegram_id) {
                    const custMsg = (lang === 'en')
                        ? [
                            `⚠️ <b>ORDER STATUS NOTIFICATION</b>`,
                            ``,
                            `📝 <b>Order:</b> <code>${order.code}</code>`,
                            targetEmail ? `📧 <b>Account:</b> <code>${targetEmail}</code>` : '',
                            `🆔 <b>Job ID:</b> <code>${order.api_order_code}</code>`,
                            `❌ <b>Status:</b> Failed (${note || 'System processing error'})`,
                            ``,
                            `📌 <b>Common reasons:</b>`,
                            `• Google prompt/2FA verification required on your phone.`,
                            `• Account already used this promotional offer or is in a Family Group.`,
                            `• Incorrect password or 2FA credentials.`,
                            ``,
                            `👉 <i>Please contact Admin to re-process or replace with another account!</i>`
                          ].filter(Boolean).join('\n')
                        : [
                            `⚠️ <b>THÔNG BÁO TIẾN TRÌNH ĐƠN HÀNG</b>`,
                            ``,
                            `📝 <b>Mã đơn:</b> <code>${order.code}</code>`,
                            targetEmail ? `📧 <b>Tài khoản:</b> <code>${targetEmail}</code>` : '',
                            `🆔 <b>Mã tiến trình (Job ID):</b> <code>${order.api_order_code}</code>`,
                            `❌ <b>Trạng thái:</b> Kích hoạt không thành công (${note || 'Lỗi xử lý từ Google'})`,
                            ``,
                            `📌 <b>Lý do thường gặp:</b>`,
                            `• Google phát hiện đăng nhập lạ và yêu cầu bấm xác nhận trên điện thoại của bạn.`,
                            `• Tài khoản không đủ điều kiện (đã từng nhận gói ưu đãi này hoặc đang trong Family Group khác).`,
                            `• Mật khẩu hoặc mã 2FA bị thay đổi/không đúng.`,
                            ``,
                            `👉 <i>Vui lòng nhắn tin trực tiếp cho Admin để được hỗ trợ kiểm tra, xử lý lại hoặc đổi tài khoản khác nhé!</i>`
                          ].filter(Boolean).join('\n');

                    await telegramService.notifyUser(order.tenant_id, customer.telegram_id, custMsg, { parse_mode: 'HTML' });
                }

                const adminMsg = [
                    `🚨 <b>[CẢNH BÁO ĐƠN HÀNG API THẤT BẠI]</b>`,
                    `🕒 <b>Thời gian:</b> ${timeVN}`,
                    `📝 <b>Mã đơn:</b> <code>${order.code}</code>`,
                    `🆔 <b>Job ID:</b> <code>${order.api_order_code}</code>`,
                    `👤 <b>Khách hàng:</b> ${customer?.full_name || ''} | @${customer?.username || 'N/A'} (ID: <code>${customer?.telegram_id}</code>)`,
                    credentialsStr ? `📧 <b>Tài khoản:</b> <code>${credentialsStr}</code>` : (targetEmail ? `📧 <b>Tài khoản:</b> <code>${targetEmail}</code>` : ''),
                    `❌ <b>Lỗi từ nhà cung cấp:</b> ${note || 'Failed'} ${progress !== null ? `(dừng ở ${progress}%)` : ''}`,
                    `💰 <b>Lưu ý:</b> Số dư kho sỉ Safe24 KHÔNG bị trừ tiền cho đơn lỗi này.`,
                    `📌 <i>Vui lòng vào CMS kiểm tra hoặc hỗ trợ khách!</i>`
                ].filter(Boolean).join('\n');
                telegramService.notifyAdmin(order.tenant_id, adminMsg);
            }

            return data;
        } catch (err: any) {
            logger.warn(`[JobStatusCheck] Không thể check job ${order.api_order_code}: ${err.message}`);
            return null;
        }
    }
}

export const apiProviderService = new ApiProviderService();
