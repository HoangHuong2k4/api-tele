import axios from 'axios';
import * as crypto from 'crypto';
import pool from '../config/db';
import { TABLES } from '../config/tables';
import { i18n } from './i18n.service';
import logger from '../config/logger';
import { telegramService } from './telegram.service';

class CryptoService {
    // Bù lệch đồng hồ VPS vs Binance server để tránh HTTP 400
    private serverTimeOffset = 0;
    private lastOffsetFetch = 0;
    private readonly OFFSET_TTL = 5 * 60 * 1000; // 5 phút
    private unmatchedNotified = new Set<string>();
    private consecutiveErrors: Map<number, number> = new Map();
    private lastErrorAlertTime: Map<number, number> = new Map();

    private async getTimestamp(): Promise<number> {
        const now = Date.now();
        if (now - this.lastOffsetFetch >= this.OFFSET_TTL) {
            try {
                const { data } = await axios.get<{ serverTime: number }>(
                    'https://api.binance.com/api/v3/time',
                    { timeout: 5000 }
                );
                this.serverTimeOffset = data.serverTime - Date.now();
                this.lastOffsetFetch = Date.now();
                if (Math.abs(this.serverTimeOffset) > 1000) {
                    logger.warn(`[Binance] Clock drift: ${this.serverTimeOffset}ms — correcting.`);
                }
            } catch { /* giữ offset cũ */ }
        }
        return Date.now() + this.serverTimeOffset;
    }

    private isSyncing = false;

    public async syncAllBinance() {
        if (this.isSyncing) return;
        this.isSyncing = true;
        try {
            const [configs]: any = await pool.execute(
                `SELECT tenant_id FROM ${TABLES.BOT_CONFIGS} WHERE status = "published"`
            );
            for (const { tenant_id } of configs) {
                await this.checkBinanceDeposits(tenant_id);
            }
        } catch (e: any) {
            logger.error(`[Binance] syncAll error: ${e.message}`);
        } finally {
            this.isSyncing = false;
        }
    }

    public async checkBinanceDeposits(tenantId: number) {
        try {
            // Lấy danh sách request pending VÀ các request failed trong 4 giờ gần nhất (để cứu đơn nếu khách chuyển trễ hoặc sàn làm tròn số)
            const [requests]: any = await pool.execute(
                `SELECT id, customer_id, amount, product_id, quantity, combo_id, bonus_qty, payment_code, usdt_amount, created_at, status
                 FROM telehub_deposit_requests
                 WHERE tenant_id = ? AND usdt_amount IS NOT NULL 
                   AND (status = "pending" OR (status = "failed" AND created_at >= NOW() - INTERVAL 4 HOUR))
                 ORDER BY (status = "pending") DESC, id DESC`,
                [tenantId]
            );

            // Tối ưu: Nếu không có request nạp USDT nào cần kiểm tra, bỏ qua gọi Binance API để tiết kiệm tài nguyên và rate limit
            if (!requests || requests.length === 0) return;

            const [configs]: any = await pool.execute(
                `SELECT binance_api_key, binance_secret_key, binance_pay_id, usdt_network
                 FROM ${TABLES.BOT_CONFIGS} WHERE tenant_id = ? AND status = "published"`,
                [tenantId]
            );
            const cfg = configs?.[0];
            if (!cfg?.binance_api_key || !cfg?.binance_secret_key) return;

            const apiKey = cfg.binance_api_key.trim();
            const secretKey = cfg.binance_secret_key.trim();

            let startTimeMs = Date.now() - 4 * 60 * 60 * 1000; // default 4 giờ gần nhất
            if (requests?.length) {
                const oldest = requests[0];
                const ts = new Date(oldest.created_at).getTime();
                if (!isNaN(ts)) {
                    startTimeMs = Math.min(startTimeMs, ts - 10 * 60 * 1000);
                }
            }

            const timestamp = await this.getTimestamp();

            // 1. Quét giao dịch On-Chain (BSC/BEP20, ...)
            let deposits: any[] = [];
            try {
                let qs = `coin=USDT&status=1&startTime=${startTimeMs}&timestamp=${timestamp}&recvWindow=60000`;
                if (cfg.usdt_network) qs += `&network=${cfg.usdt_network.trim()}`;
                qs += `&signature=${crypto.createHmac('sha256', secretKey).update(qs).digest('hex')}`;

                const { data } = await axios.get<any[]>(
                    `https://api.binance.com/sapi/v1/capital/deposit/hisrec?${qs}`,
                    { headers: { 'X-MBX-APIKEY': apiKey }, timeout: 15000 }
                );
                deposits = data || [];
            } catch (errDep: any) {
                logger.warn(`[Binance] deposit/hisrec error [tenant=${tenantId}]: ${errDep.message}`);
            }

            // 2. Quét giao dịch Binance Pay (nhận qua Binance ID / Pay ID)
            let payTransactions: any[] = [];
            try {
                let payQs = `startTimestamp=${startTimeMs}&timestamp=${timestamp}&recvWindow=60000`;
                payQs += `&signature=${crypto.createHmac('sha256', secretKey).update(payQs).digest('hex')}`;

                const { data: payRes } = await axios.get<any>(
                    `https://api.binance.com/sapi/v1/pay/transactions?${payQs}`,
                    { headers: { 'X-MBX-APIKEY': apiKey }, timeout: 15000 }
                );
                if (payRes?.data && Array.isArray(payRes.data)) {
                    payTransactions = payRes.data;
                }
            } catch (errPay: any) {
                logger.warn(`[Binance] pay/transactions error [tenant=${tenantId}]: ${errPay.message}`);
            }

            // Thành công: Reset bộ đếm lỗi liên tiếp
            this.consecutiveErrors.set(tenantId, 0);

            interface IncomingTx {
                txId: string;
                amount: number;
                time: number;
                type: 'ONCHAIN' | 'BINANCE_PAY';
            }

            const unifiedIncoming: IncomingTx[] = [];

            for (const dep of deposits) {
                if (dep.status === 1) {
                    unifiedIncoming.push({
                        txId: dep.txId,
                        amount: parseFloat(dep.amount),
                        time: dep.insertTime ? parseInt(dep.insertTime) : Date.now(),
                        type: 'ONCHAIN'
                    });
                }
            }

            for (const pay of payTransactions) {
                if (pay.currency === 'USDT') {
                    const payAmt = parseFloat(pay.amount);
                    if (payAmt <= 0) continue; // Bỏ qua giao dịch chuyển đi (outgoing), chỉ nhận giao dịch nạp vào (incoming)

                    const receiverId = pay.receiverInfo?.binanceId || pay.uid;
                    // Nếu tenant cấu hình binance_pay_id thì kiểm tra đúng người nhận
                    if (cfg.binance_pay_id && receiverId && String(receiverId) !== String(cfg.binance_pay_id)) {
                        continue;
                    }
                    unifiedIncoming.push({
                        txId: `PAY_${pay.orderId || pay.transactionId}`,
                        amount: payAmt,
                        time: pay.transactionTime ? parseInt(pay.transactionTime) : Date.now(),
                        type: 'BINANCE_PAY'
                    });
                }
            }

            if (!unifiedIncoming.length) return;

            logger.info(`[Binance] tenant=${tenantId} startTime=${new Date(startTimeMs).toISOString()} got ${unifiedIncoming.length} incoming transactions (${deposits.length} on-chain, ${payTransactions.filter(p => parseFloat(p.amount) > 0).length} pay), ${requests?.length || 0} candidate requests`);

            const requestList = [...(requests || [])];
            for (const item of unifiedIncoming) {
                const usdtAmt = item.amount;

                // Kiểm tra txId đã được xử lý chưa (tránh duplicate trên mọi tenant dùng chung ví)
                const [dup]: any = await pool.execute(
                    `SELECT id FROM telehub_balance_logs WHERE note LIKE ?`,
                    [`%${item.txId}%`]
                );
                if (dup?.length) continue;

                const depTime = item.time;

                // Lọc các request nằm trong khung thời gian hợp lệ:
                // depTime không được xảy ra trước khi tạo đơn (> 2 phút) và không được quá 35 phút sau khi tạo đơn
                const validTimeRequests = requestList.filter(r => {
                    const reqTime = new Date(r.created_at).getTime();
                    if (isNaN(reqTime)) return false;
                    return depTime >= reqTime - 2 * 60 * 1000 && depTime <= reqTime + 35 * 60 * 1000;
                });

                let matchedReq: any = null;

                // 1. Khớp chính xác (lệch tuyệt đối < 0.000005 USDT)
                const exactMatches = validTimeRequests.filter(r => {
                    const reqAmt = parseFloat(r.usdt_amount);
                    if (isNaN(reqAmt)) return false;
                    return Math.abs(reqAmt - usdtAmt) < 0.000005;
                });

                if (exactMatches.length > 0) {
                    exactMatches.sort((a, b) => {
                        const aPending = a.status === 'pending' ? 1 : 0;
                        const bPending = b.status === 'pending' ? 1 : 0;
                        if (aPending !== bPending) return bPending - aPending;

                        const timeDiffA = Math.abs(new Date(a.created_at).getTime() - depTime);
                        const timeDiffB = Math.abs(new Date(b.created_at).getTime() - depTime);
                        return timeDiffA - timeDiffB;
                    });
                    matchedReq = exactMatches[0];
                }

                // 2. Khớp lệch siêu nhỏ (sai số <= 0.00015 USDT do sàn/app cắt hoặc làm tròn 4 chữ số thập phân, VD: yêu cầu 23.88889 nhưng sàn Binance Pay chuyển 23.8889)
                if (!matchedReq) {
                    const microDiffCandidates = validTimeRequests.filter(r => {
                        if (r.status !== 'pending') return false;
                        const reqAmt = parseFloat(r.usdt_amount);
                        if (isNaN(reqAmt)) return false;
                        const diff = Math.abs(reqAmt - usdtAmt);
                        const rounded4 = Math.round(reqAmt * 10000) / 10000;
                        const floor4 = Math.floor(reqAmt * 10000) / 10000;
                        const matches4 = Math.abs(rounded4 - usdtAmt) < 0.000005 || Math.abs(floor4 - usdtAmt) < 0.000005;
                        return matches4 || diff <= 0.00015;
                    });

                    if (microDiffCandidates.length === 1) {
                        matchedReq = microDiffCandidates[0];
                    } else if (microDiffCandidates.length > 1) {
                        microDiffCandidates.sort((a, b) => {
                            const diffA = Math.abs(parseFloat(a.usdt_amount) - usdtAmt);
                            const diffB = Math.abs(parseFloat(b.usdt_amount) - usdtAmt);
                            return diffA - diffB;
                        });
                        matchedReq = microDiffCandidates[0];
                    }
                }

                // 3. Khớp nếu khách hoặc sàn làm tròn / cắt bớt còn 3 số thập phân (sai số < 0.0015 USDT)
                if (!matchedReq) {
                    const threeDecCandidates = validTimeRequests.filter(r => {
                        if (r.status !== 'pending') return false;
                        const reqAmt = parseFloat(r.usdt_amount);
                        if (isNaN(reqAmt)) return false;
                        const rounded3 = Math.round(reqAmt * 1000) / 1000;
                        const floor3 = Math.floor(reqAmt * 1000) / 1000;
                        return Math.abs(rounded3 - usdtAmt) < 0.000005 || Math.abs(floor3 - usdtAmt) < 0.000005;
                    });
                    if (threeDecCandidates.length === 1) {
                        matchedReq = threeDecCandidates[0];
                    }
                }

                // 4. Với đơn lớn (>= 2.0 USDT), nếu khách bị sàn cắt bớt số lẻ chỉ chuyển đúng 2 số thập phân:
                if (!matchedReq && usdtAmt >= 2.0) {
                    const isTwoDecimalsOnly = Math.abs(usdtAmt - Math.round(usdtAmt * 100) / 100) < 0.000005;
                    if (isTwoDecimalsOnly) {
                        const candidates = validTimeRequests.filter(r => {
                            if (r.status !== 'pending') return false;
                            const reqAmt = parseFloat(r.usdt_amount);
                            if (isNaN(reqAmt) || reqAmt < 2.0) return false;
                            const sameTwoDecimals = Math.floor(reqAmt * 100) === Math.floor(usdtAmt * 100)
                                                 || Math.round(reqAmt * 100) === Math.round(usdtAmt * 100);
                            return sameTwoDecimals && Math.abs(reqAmt - usdtAmt) < 0.015;
                        });

                        if (candidates.length === 1) {
                            matchedReq = candidates[0];
                        } else if (candidates.length > 1) {
                            logger.warn(`[Binance] Multiple pending candidates for 2-decimal deposit ${usdtAmt}: ${candidates.map(c => c.id).join(', ')} - Skip auto match`);
                        }
                    }
                }

                if (matchedReq) {
                    const req = matchedReq;
                    const matchedIdx = requestList.findIndex(r => r.id === req.id);
                    logger.info(`[Binance] Matched: txId=${item.txId} (${item.type}) usdt=${usdtAmt} (reqUsdt=${req.usdt_amount}, status=${req.status}) → req.id=${req.id} code=${req.payment_code} customer=${req.customer_id}`);

                    await this.processDeposit(tenantId, req, item.txId);
                    if (matchedIdx !== -1) requestList.splice(matchedIdx, 1);
                } else {
                    // Giao dịch không khớp đơn nào: Chỉ báo Telegram cho Admin nếu là giao dịch mới (trong vòng 30 phút)
                    const isRecent = (Date.now() - depTime) <= 30 * 60 * 1000;
                    if (isRecent && !this.unmatchedNotified.has(item.txId)) {
                        this.unmatchedNotified.add(item.txId);
                        logger.warn(`[Binance] Unmatched deposit txId=${item.txId} (${item.type}) amount=${usdtAmt}`);
                        telegramService.notifyAdmin(tenantId, [
                            `⚠️ <b>GIAO DỊCH USDT CHƯA KHỚP ĐƠN (${item.type === 'BINANCE_PAY' ? 'Binance Pay' : 'Ví On-Chain'})</b>`,
                            `💰 <b>Số tiền nhận:</b> <code>${usdtAmt}</code> USDT`,
                            `🏦 <b>TxID:</b> <code>${item.txId}</code>`,
                            `🕒 <b>Thời gian:</b> ${new Date(depTime).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}`,
                            `📌 <i>Không tìm thấy đơn nạp tiền/mua hàng khớp số tiền này. Cần kiểm tra đối soát thủ công!</i>`
                        ].join('\n')).catch(() => {});
                    }
                }
            }
        } catch (e: any) {
            const errorMsg = e.response?.data ? JSON.stringify(e.response.data) : e.message;
            logger.warn(`[Binance] checkDeposits [tenant=${tenantId}]: ${errorMsg}`);

            const currentFails = (this.consecutiveErrors.get(tenantId) || 0) + 1;
            this.consecutiveErrors.set(tenantId, currentFails);

            const isFatalAuthError = e.response?.status === 401 || e.response?.status === 403;
            // Chỉ gửi cảnh báo Telegram khi lỗi API nghiêm trọng (401/403) hoặc lỗi mạng kéo dài liên tục >= 5 lần (~2 phút)
            const shouldAlert = isFatalAuthError || currentFails >= 5;

            const lastAlert = this.lastErrorAlertTime.get(tenantId) || 0;
            const ALERT_COOLDOWN = 30 * 60 * 1000; // Cách nhau ít nhất 30 phút mới gửi 1 lần để tránh spam

            if (shouldAlert && (Date.now() - lastAlert > ALERT_COOLDOWN)) {
                this.lastErrorAlertTime.set(tenantId, Date.now());
                telegramService.notifyAdmin(tenantId, [
                    `🚨 <b>CẢNH BÁO KẾT NỐI BINANCE USDT</b>`,
                    `❌ <b>Lỗi:</b> <code>${errorMsg}</code>`,
                    `⚠️ <i>Lỗi kết nối liên tục ${currentFails} lần. Hệ thống đang tự động kết nối lại.</i>`
                ].join('\n')).catch(() => {});
            }
        }
    }

    private async processDeposit(tenantId: number, req: any, txId: string) {
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();
            await conn.execute(
                `UPDATE telehub_deposit_requests SET status = "completed" WHERE id = ?`,
                [req.id]
            );
            await conn.execute(
                `UPDATE ${TABLES.CUSTOMERS} SET balance = balance + ? WHERE id = ?`,
                [req.amount, req.customer_id]
            );
            const isPay = txId.startsWith('PAY_');
            const noteText = isPay 
                ? `Nạp qua Binance Pay [${txId}]`
                : `Nạp qua USDT Binance [${txId}]`;

            await conn.execute(
                `INSERT INTO telehub_balance_logs
                 (tenant_id, customer_id, amount, type, note, created_at, updated_at)
                 VALUES (?, ?, ?, "deposit", ?, NOW(), NOW())`,
                [tenantId, req.customer_id, req.amount, noteText]
            );
            await conn.commit();
        } catch (e: any) {
            await conn.rollback();
            throw e;
        } finally {
            conn.release();
        }

        // Thông báo sau khi commit
        const [users]: any = await pool.execute(
            `SELECT telegram_id, full_name, username, language FROM ${TABLES.CUSTOMERS} WHERE id = ?`,
            [req.customer_id]
        );
        const user = users[0];
        const lang = user?.language || 'vi';

        if (user?.telegram_id) {
            await telegramService.notifyUser(
                tenantId, user.telegram_id,
                i18n.t(lang, 'deposit_usdt_success', { amount: Math.floor(req.amount).toLocaleString() }),
                { parse_mode: 'HTML' }
            );
        }

        if (req.product_id && req.quantity > 0) {
            await telegramService.processAutomatedPurchase(
                tenantId, req.customer_id, req.product_id,
                req.quantity, req.payment_code, req.combo_id, req.bonus_qty || 0
            );
        } else {
            const isPay = txId.startsWith('PAY_');
            telegramService.notifyAdmin(tenantId, [
                `💸 <b>NẠP USDT THÀNH CÔNG (${isPay ? 'Binance Pay' : 'Ví On-Chain'})</b>`,
                `👤 <b>Khách:</b> ${user?.full_name || 'N/A'} | @${user?.username || 'N/A'} (ID: <code>${req.customer_id}</code>)`,
                `💵 <b>Số tiền:</b> ${Math.floor(req.amount).toLocaleString()}đ`,
                `💸 <b>USDT:</b> ${req.usdt_amount} USDT`,
                `📝 <b>TxID:</b> <code>${txId}</code>`
            ].join('\n')).catch(() => {});
        }
    }
}

export const cryptoService = new CryptoService();
