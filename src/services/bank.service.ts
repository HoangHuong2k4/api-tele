import axios from 'axios';
import pool from '../config/db';
import { telegramService } from './telegram.service';
import { TABLES } from '../config/tables';
import { i18n } from './i18n.service';
import logger from '../config/logger';

// URL factory cho từng ngân hàng hỗ trợ
const BANK_API_URLS: Record<string, (token: string) => string> = {
    TPB:      t => `https://thueapibank.vn/historyapitpbv2/${t}`,
    VTLMONEY: t => `https://thueapibank.vn/historyapiviettelv2/${t}`,
    MB:       t => `https://thueapibank.vn/historyapimbv2/${t}`,
    ACB:      t => `https://thueapibank.vn/historyapiacbv2/${t}`,
};

class BankService {
    private isSyncing = false;
    private processedTxCache = new Set<string>();

    /** Xử lý giao dịch từ Webhook (payment-service) */
    public async processTransaction(tx: any, config: any, pendingCodes?: Set<string>) {
        const tenantId = config.tenant_id;
        const txId     = tx.transactionID || tx.tranId || tx.id || tx.referenceCode;
        const amount   = tx.amount || tx.creditAmount || tx.transferAmount;
        const desc     = tx.description || tx.content || '';
        const numAmt   = parseFloat(amount);

        if (!txId || !amount || numAmt <= 0) {
            logger.warn(`[Bank] Skipping invalid tx — id=${txId}, amount=${amount}`);
            return;
        }

        // 0. Cache bộ nhớ: kiểm tra O(1) ngay lập tức không cần chạm vào DB (0ms)
        const cacheKey = `${tenantId}_${txId}`;
        if (this.processedTxCache.has(cacheKey)) {
            return;
        }

        // 1. Kiểm tra trùng lặp nhanh theo tran_id_bank có UNIQUE INDEX (0ms)
        const [dupTran]: any = await pool.execute(
            `SELECT id FROM ${TABLES.BANK_WEBHOOKS} WHERE tran_id_bank = ? AND tenant_id = ? LIMIT 1`,
            [txId, tenantId]
        );
        if (dupTran.length) {
            if (this.processedTxCache.size > 5000) this.processedTxCache.clear();
            this.processedTxCache.add(cacheKey);
            return;
        }

        // Kiểm tra phụ theo nội dung + số tiền trong vòng 24h gần nhất
        const [dupDesc]: any = await pool.execute(
            `SELECT id FROM ${TABLES.BANK_WEBHOOKS} WHERE description = ? AND amount = ? AND tenant_id = ? AND created_at >= NOW() - INTERVAL 24 HOUR LIMIT 1`,
            [desc, numAmt, tenantId]
        );
        if (dupDesc.length) {
            this.processedTxCache.add(cacheKey);
            return;
        }

        logger.info(`[Bank] [tenant=${tenantId}] tx=${txId} amount=${numAmt} desc="${desc.substring(0, 60)}"`);

        const conn = await pool.getConnection();
        try {
            // 2. Tìm mã thanh toán trong nội dung
            const codes = pendingCodes ?? await this.fetchPendingCodes(conn, tenantId);
            let code  = this.findPaymentCode(desc, codes);

            // 2b. Nếu mã không ở trạng thái pending, kiểm tra xem desc có chứa mã đã xử lý (success/failed) hay không
            if (!code) {
                const hasProcessed = await this.hasAnyProcessedCodeInDesc(conn, tenantId, desc);
                if (hasProcessed) {
                    this.processedTxCache.add(cacheKey);
                    logger.info(`[Bank] [tenant=${tenantId}] Skipping auto-match: desc contains already processed code (${desc.substring(0, 60)})`);
                    return;
                }
            }

            // Fallback: Khi khách chuyển qua MoMo hoặc quên/nhập sai mã thanh toán (chỉ chạy khi desc KHÔNG chứa mã thanh toán nào)
            if (!code) {
                const [pendingMatches]: any = await conn.execute(
                    `SELECT id, payment_code, customer_id, created_at FROM ${TABLES.DEPOSIT_REQUESTS} d1
                     WHERE tenant_id = ? AND status = 'pending' AND amount = ?
                       AND created_at >= NOW() - INTERVAL 60 MINUTE
                       AND NOT EXISTS (
                           SELECT 1 FROM ${TABLES.DEPOSIT_REQUESTS} d2
                           WHERE d2.customer_id = d1.customer_id 
                             AND d2.status = 'success' 
                             AND d2.id > d1.id
                       )
                     ORDER BY created_at DESC`,
                    [tenantId, numAmt]
                );

                if (pendingMatches.length === 1) {
                    code = pendingMatches[0].payment_code;
                    logger.info(`[Bank] [tenant=${tenantId}] Auto-matched single pending deposit request for amount ${numAmt}: code=${code}`);
                } else if (pendingMatches.length > 1) {
                    const uniqueCustomers = new Set(pendingMatches.map((m: any) => m.customer_id));
                    if (uniqueCustomers.size === 1) {
                        code = pendingMatches[0].payment_code;
                        logger.info(`[Bank] [tenant=${tenantId}] Auto-matched latest pending deposit for single customer ${pendingMatches[0].customer_id} (amount ${numAmt}): code=${code}`);
                    } else {
                        logger.warn(`[Bank] [tenant=${tenantId}] Ambiguous match: ${pendingMatches.length} pending deposits across ${uniqueCustomers.size} customers for amount ${numAmt}`);
                    }
                }
            }

            if (!code) {
                this.processedTxCache.add(cacheKey);
                logger.warn(`[Bank] No code match — desc="${desc.substring(0, 100)}"`);
                await conn.execute(
                    `INSERT INTO ${TABLES.BANK_WEBHOOKS} (tenant_id, tran_id_bank, amount, description, raw_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NOW(), NOW())`,
                    [tenantId, txId, numAmt, desc, JSON.stringify(tx)]
                );
                telegramService.notifyAdmin(tenantId, [
                    `⚠️ <b>GIAO DỊCH KHÔNG KHỚP MÃ</b>`,
                    `💰 <b>Số tiền:</b> ${numAmt.toLocaleString()}đ`,
                    `📝 <b>Nội dung:</b> <code>${desc.substring(0, 200)}</code>`,
                    `🏦 <b>Mã GD:</b> <code>${txId}</code>`,
                    `📌 <i>Cần đối soát thủ công.</i>`
                ].join('\n')).catch(() => {});
                return;
            }

            // 3. Lock row & validate
            await conn.beginTransaction();
            const [reqs]: any = await conn.execute(
                `SELECT id, customer_id, product_id, quantity, combo_id, bonus_qty, amount, status
                 FROM ${TABLES.DEPOSIT_REQUESTS}
                 WHERE payment_code = ? AND tenant_id = ? FOR UPDATE`,
                [code, tenantId]
            );
            const req = reqs[0];
            if (!req) {
                logger.warn(`[Bank] Code ${code} not in deposit_requests`);
                await conn.rollback(); return;
            }
            if (req.status !== 'pending' && req.status !== 'failed') {
                logger.warn(`[Bank] Code ${code} already ${req.status}`);
                await conn.rollback(); return;
            }

            // 4. Atomic commit
            await conn.execute(
                `INSERT INTO ${TABLES.BANK_WEBHOOKS} (tenant_id, tran_id_bank, amount, description, raw_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NOW(), NOW())`,
                [tenantId, txId, numAmt, desc, JSON.stringify(tx)]
            );
            await conn.execute(
                `UPDATE ${TABLES.CUSTOMERS} SET balance = balance + ? WHERE id = ? AND tenant_id = ?`,
                [numAmt, req.customer_id, tenantId]
            );
            await conn.execute(
                `UPDATE ${TABLES.DEPOSIT_REQUESTS} SET status = "success" WHERE id = ?`,
                [req.id]
            );
            await conn.execute(
                `INSERT INTO ${TABLES.BALANCE_LOGS} (tenant_id, customer_id, amount, type, note, created_at, updated_at) VALUES (?, ?, ?, "IN", ?, NOW(), NOW())`,
                [tenantId, req.customer_id, numAmt, `Nạp tiền tự động qua mã ${code}`]
            );
            await conn.commit();
            this.processedTxCache.add(cacheKey);
            logger.info(`[Bank] tx=${txId} committed ✅`);

            // 5. Post-commit notifications
            await this.afterSuccess(tenantId, req, numAmt, code);

        } catch (e: any) {
            await conn.rollback();
            logger.error(`[Bank] Error tx=${txId}: ${e.message}`);
            telegramService.notifyAdmin(tenantId, [
                `🚨 <b>LỖI XỬ LÝ GIAO DỊCH NGÂN HÀNG</b>`,
                `🏦 <b>Mã GD:</b> <code>${txId}</code>`,
                `💰 <b>Số tiền:</b> ${numAmt.toLocaleString()}đ`,
                `❌ <b>Lỗi:</b> <code>${e.message}</code>`,
                `📌 <i>Cần kiểm tra thủ công!</i>`
            ].join('\n')).catch(() => {});
        } finally {
            conn.release();
        }
    }

    /** Đồng bộ từ API ngân hàng (polling liên tục) */
    public async syncAllBanks() {
        if (this.isSyncing) return;
        this.isSyncing = true;
        try {
            // Tối ưu: Nếu không có đơn chờ nào, thoát ngay lập tức (<1ms) không tốn CPU/network
            const [pendingCheck]: any = await pool.execute(
                `SELECT id FROM ${TABLES.DEPOSIT_REQUESTS} 
                 WHERE status = 'pending' OR (status = 'failed' AND created_at >= NOW() - INTERVAL 24 HOUR) LIMIT 1`
            );
            if (!pendingCheck?.length) return;

            const [configs]: any = await pool.execute(
                `SELECT * FROM ${TABLES.BOT_CONFIGS} WHERE status = "published"`
            );
            
            // Xử lý song song tất cả tenant configs để giảm tối đa độ trễ
            await Promise.allSettled(configs.map(async (cfg: any) => {
                const token = cfg.bank_api_token || cfg.webhook_signature;
                const urlFn = BANK_API_URLS[cfg.bank_code];
                if (!token || !urlFn) return;

                const [reqs]: any = await pool.execute(
                    `SELECT payment_code FROM ${TABLES.DEPOSIT_REQUESTS}
                     WHERE tenant_id = ? AND (status = 'pending' OR (status = 'failed' AND created_at >= NOW() - INTERVAL 24 HOUR))`,
                    [cfg.tenant_id]
                );
                if (!reqs?.length) return;

                const codes = new Set<string>(reqs.map((r: any) => r.payment_code));
                await this.syncFromApi(cfg, urlFn(token), codes);
            }));
        } catch (e: any) {
            logger.error(`[Bank] syncAll error: ${e.message}`);
        } finally {
            this.isSyncing = false;
        }
    }

    /** Dọn dẹp yêu cầu nạp hết hạn (>30 phút) */
    public async cleanupExpiredRequests() {
        try {
            const [rows]: any = await pool.execute(
                `SELECT id, payment_code FROM ${TABLES.DEPOSIT_REQUESTS}
                 WHERE status = "pending" AND created_at < NOW() - INTERVAL 30 MINUTE`
            );
            for (const row of rows) {
                await pool.execute(
                    `UPDATE ${TABLES.DEPOSIT_REQUESTS} SET status = "failed" WHERE id = ?`,
                    [row.id]
                );
                logger.info(`[Bank] Expired request cancelled: ${row.payment_code}`);
            }
        } catch (e: any) {
            logger.error(`[Bank] cleanup error: ${e.message}`);
        }
    }

    // --- Private helpers ---

    private async fetchPendingCodes(conn: any, tenantId: number): Promise<Set<string>> {
        const [reqs]: any = await conn.execute(
            `SELECT payment_code FROM ${TABLES.DEPOSIT_REQUESTS}
             WHERE tenant_id = ? AND (status = 'pending' OR (status = 'failed' AND created_at >= NOW() - INTERVAL 24 HOUR))`,
            [tenantId]
        );
        return new Set<string>(reqs.map((r: any) => r.payment_code));
    }

    /** Kiểm tra xem nội dung giao dịch có chứa mã nạp đã được xử lý thành công (status = 'success') hay không để tránh fallback nhầm */
    private async hasAnyProcessedCodeInDesc(conn: any, tenantId: number, desc: string): Promise<boolean> {
        const tokens = desc.match(/[A-Z0-9]{6,16}/gi) || [];
        if (!tokens.length) return false;
        const uppers = Array.from(new Set(tokens.map(t => t.toUpperCase())));
        const placeholders = uppers.map(() => '?').join(',');
        const [rows]: any = await conn.execute(
            `SELECT id FROM ${TABLES.DEPOSIT_REQUESTS} WHERE tenant_id = ? AND payment_code IN (${placeholders}) AND status = 'success' LIMIT 1`,
            [tenantId, ...uppers]
        );
        return rows.length > 0;
    }

    /** Tìm mã thanh toán trong nội dung chuyển khoản */
    private findPaymentCode(desc: string, codes: Set<string>): string | null {
        // Bước 1: prefix cũ (nap/mua + code)
        const legacy = desc.match(/(nap|mua)[\s-]?([A-Z0-9]{6,12})/i);
        if (legacy) {
            const code = legacy[2].toUpperCase();
            if (codes.has(code)) return code;
        }
        // Bước 2: scan token alphanumeric 6-16 ký tự trực tiếp
        for (const token of (desc.match(/[A-Z0-9]{6,16}/gi) || [])) {
            const upper = token.toUpperCase();
            if (codes.has(upper)) return upper;
        }
        // Bước 3: làm sạch dấu gạch/dấu phẩy/khoảng trắng rồi scan lại
        const cleaned = desc.replace(/[^A-Z0-9]/gi, ' ');
        for (const token of (cleaned.match(/[A-Z0-9]{6,16}/gi) || [])) {
            const upper = token.toUpperCase();
            if (codes.has(upper)) return upper;
        }
        return null;
    }

    private async syncFromApi(config: any, url: string, codes: Set<string>) {
        try {
            const txList: any[] = [];
            
            // Quét ĐỒNG THỜI cả Remote Bank API và Local payment-service (quét trực tiếp ACB)
            const [remoteRes, localRes] = await Promise.allSettled([
                axios.get(url, { timeout: 3500 }),
                axios.get('http://localhost:3006/payments', { timeout: 1500 })
            ]);

            // 1. Dữ liệu từ Remote API
            if (remoteRes.status === 'fulfilled') {
                const data = (remoteRes.value as any)?.data;
                const ok = data?.status === 'success' || data?.status?.code === '00';
                if (ok) {
                    const list = (data.transactions || data.data?.trans || []).slice(0, 30);
                    txList.push(...list);
                }
            }

            // 2. Dữ liệu từ Local payment-service (ACB trực tiếp, không phụ thuộc bên thứ 3)
            if (localRes.status === 'fulfilled') {
                const localData = (localRes.value as any)?.data;
                if (Array.isArray(localData)) {
                    txList.push(...localData);
                }
            }

            // Khử trùng lặp transactionID
            const seenIds = new Set<string>();
            const uniqueList: any[] = [];
            for (const tx of txList) {
                const id = String(tx.transactionID || tx.transactionId || tx.transaction_id || tx.id || tx.referenceCode || '');
                if (id && !seenIds.has(id)) {
                    seenIds.add(id);
                    uniqueList.push(tx);
                }
            }

            for (const tx of uniqueList) {
                const norm = {
                    transactionID: tx.transactionID || tx.transactionId || tx.transaction_id || tx.id || tx.referenceCode,
                    amount:        tx.amount || tx.creditAmount,
                    description:   tx.description || tx.transName || tx.content || '',
                    type:          tx.type || 'IN'
                };
                if (norm.type === 'IN' || tx.transName?.includes('Nhận tiền') || tx.gate) {
                    await this.processTransaction(norm, config, codes);
                }
            }
        } catch (e: any) {
            logger.warn(`[Bank] syncFromApi [tenant=${config.tenant_id}]: ${e.message}`);
        }
    }

    private async afterSuccess(tenantId: number, req: any, numAmt: number, code: string) {
        if (req.product_id) {
            await telegramService.processAutomatedPurchase(
                tenantId, req.customer_id,
                req.product_id, req.quantity, code,
                req.combo_id || undefined, req.bonus_qty || 0
            );
            return;
        }

        const [users]: any = await pool.execute(
            `SELECT telegram_id, full_name, username, language FROM ${TABLES.CUSTOMERS} WHERE id = ?`,
            [req.customer_id]
        );
        const user = users[0];
        const lang = user?.language || 'vi';

        if (user?.telegram_id) {
            await telegramService.notifyUser(
                tenantId, user.telegram_id,
                i18n.t(lang, 'deposit_success', { amount: numAmt.toLocaleString() }),
                {
                    parse_mode: 'HTML',
                    reply_markup: { inline_keyboard: [[{ text: i18n.t(lang, 'menu_button'), callback_data: 'menu' }]] }
                }
            ).catch(() => {});
        }

        telegramService.notifyAdmin(tenantId, [
            `💰 <b>NẠP TIỀN QR THÀNH CÔNG</b>`,
            `👤 <b>Khách:</b> ${user?.full_name || 'N/A'} | @${user?.username || 'N/A'} (ID: <code>${req.customer_id}</code>)`,
            `💵 <b>Số tiền:</b> ${numAmt.toLocaleString()}đ`,
            `📝 <b>Mã GD:</b> <code>${code}</code>`
        ].join('\n')).catch(() => {});
    }
}

export const bankService = new BankService();
