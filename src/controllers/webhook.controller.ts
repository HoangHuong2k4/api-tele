import { Request, Response } from 'express';
import pool from '../config/db';
import { TABLES } from '../config/tables';
import logger from '../config/logger';

export const checkActive = (req: Request, res: Response) => {
    return res.json({ success: true, message: 'Webhook is active and reachable' });
};

export const handleCallback = async (req: Request, res: Response) => {
    try {
        const payload: any = req.body;
        
        logger.info('----------------------------------------------------');
        logger.info(`📩 [Webhook] Received Payload: ${JSON.stringify(payload)}`);
        logger.info(`📋 [Webhook] Headers: ${JSON.stringify(req.headers)}`);
        const signature = req.headers['x-api-key'] || req.headers['signature'] || req.headers['x-signature'] || payload.signature;
        logger.info(`🔑 [Webhook] Extracted Signature: ${signature}`);

        // 1. Validation / Ping check
        if (!signature && (Object.keys(payload).length === 0 || payload.status === 'success')) {
            logger.info('ℹ️ [Webhook] Ping check detected.');
            return res.json({ success: true, message: 'Webhook reached successfully' });
        }

        // 2. Tìm Tenant dựa trên Signature
        let config: any = null;
        if (signature) {
            const [configs]: any = await pool.execute(
                `SELECT * FROM ${TABLES.BOT_CONFIGS} WHERE webhook_signature = ?`, 
                [signature]
            );
            if (configs.length > 0) {
                config = configs[0];
                logger.info(`✅ [Webhook] Matched Tenant ${config.tenant_id} via Signature.`);
            } else {
                logger.warn(`⚠️ [Webhook] No tenant found for signature: ${signature}`);
            }
        }

        const transactions = Array.isArray(payload) ? payload : (payload.transactions ? payload.transactions : [payload]);
        const { bankService } = await import('../services/bank.service');

        for (const transaction of transactions) {
            logger.info(`🔍 [Webhook] Processing transaction: ${transaction.transactionID || transaction.tranId}`);
            
            // Nếu đã tìm thấy config qua Signature, xử lý luôn
            if (config) {
                await bankService.processTransaction(transaction, config);
                continue;
            }

            // Fallback: Tìm qua mã trong nội dung (hỗ trợ mã mới random và mã cũ có prefix)
            const description = transaction.description || transaction.content || '';
            
            // Bước 1: Tìm legacy format (nap-/mua-)
            const legacyMatch = description.match(/(nap|mua)-?([A-Z0-9]{6,12})/i);
            let code: string | null = null;
            
            if (legacyMatch) {
                const potentialCode = legacyMatch[2].toUpperCase();
                const [checkRows]: any = await pool.execute(`SELECT tenant_id FROM ${TABLES.DEPOSIT_REQUESTS} WHERE payment_code = ? AND (status = 'pending' OR (status = 'failed' AND created_at >= NOW() - INTERVAL 24 HOUR))`, [potentialCode]);
                if (checkRows.length > 0) code = potentialCode;
            }
            
            // Bước 2: Nếu chưa tìm thấy, scan token alphanumeric 6-16 ký tự
            if (!code) {
                const tokens = description.match(/[A-Z0-9]{6,16}/gi) || [];
                for (const token of tokens) {
                    const upperToken = token.toUpperCase();
                    const [checkRows]: any = await pool.execute(`SELECT tenant_id FROM ${TABLES.DEPOSIT_REQUESTS} WHERE payment_code = ? AND (status = 'pending' OR (status = 'failed' AND created_at >= NOW() - INTERVAL 24 HOUR)) LIMIT 1`, [upperToken]);
                    if (checkRows.length > 0) { code = upperToken; break; }
                }
            }

            if (code) {
                logger.info(`🔎 [Webhook] Fallback: Searching for code ${code} in DB...`);
                const [reqs]: any = await pool.execute(`SELECT tenant_id FROM ${TABLES.DEPOSIT_REQUESTS} WHERE payment_code = ?`, [code]);
                if (reqs.length > 0) {
                    const tenantId = reqs[0].tenant_id;
                    const [configs]: any = await pool.execute(`SELECT * FROM ${TABLES.BOT_CONFIGS} WHERE tenant_id = ?`, [tenantId]);
                    if (configs.length > 0) {
                        logger.info(`✅ [Webhook] Fallback: Found Tenant ${tenantId} via code ${code}.`);
                        await bankService.processTransaction(transaction, configs[0]);
                    }
                } else {
                    logger.warn(`❌ [Webhook] Fallback: Code ${code} not found in DEPOSIT_REQUESTS.`);
                }
            } else {
                logger.warn(`❌ [Webhook] No signature match and no payment code found in description: "${description}"`);
            }
        }

        return res.json({ success: true, message: 'Webhook processed' });

    } catch (error: any) {
        logger.error(`🚨 [Webhook] Error: ${error.message}`);
        return res.status(500).json({ error: 'Internal Server Error' });
    }
};

/**
 * ACB Webhook Handler
 * ACB gửi payload dạng:
 * {
 *   "id": "...",
 *   "referenceCode": "FT2600001234",
 *   "creditAmount": 100000,
 *   "description": "NAP-ABC123 chuyen tien",
 *   "content": "NAP-ABC123 chuyen tien",
 *   "transactionDate": "2026-05-30T08:00:00+07:00",
 *   "accountNumber": "26031311"
 * }
 * Token được truyền qua query: /callback-acb?token=b2a5e32b6824c8f7d0ec62855e69e28a
 */
export const handleCallbackAcb = async (req: Request, res: Response) => {
    try {
        const payload: any = req.body;

        logger.info('----------------------------------------------------');
        logger.info(`📩 [Webhook-ACB] Received Payload: ${JSON.stringify(payload)}`);
        logger.info(`📋 [Webhook-ACB] Headers: ${JSON.stringify(req.headers)}`);

        // Ping / health check (payload rỗng)
        if (!payload || Object.keys(payload).length === 0) {
            logger.info('ℹ️ [Webhook-ACB] Ping check detected.');
            return res.json({ success: true, message: 'ACB Webhook reached successfully' });
        }

        // Lấy token từ query string hoặc header để tìm tenant
        // ACB thực tế gửi qua header 'signature'
        const token = (req.query.token as string)
            || req.headers['x-api-key'] as string
            || req.headers['signature'] as string
            || req.headers['authorization']?.toString().replace('Bearer ', '')
            || payload.token;

        logger.info(`🔑 [Webhook-ACB] Token: ${token}`);

        // Tìm Tenant dựa trên bank_api_token hoặc webhook_signature (tùy cẫu hình ACB gửi)
        let config: any = null;
        if (token) {
            const [configs]: any = await pool.execute(
                `SELECT * FROM ${TABLES.BOT_CONFIGS} WHERE (bank_api_token = ? OR webhook_signature = ?) AND bank_code = 'ACB'`,
                [token, token]
            );
            if (configs.length > 0) {
                config = configs[0];
                logger.info(`✅ [Webhook-ACB] Matched Tenant ${config.tenant_id} via ACB Token.`);
            } else {
                logger.warn(`⚠️ [Webhook-ACB] No tenant found for token: ${token}`);
            }
        }

        // Normalize ACB payload → format chuẩn mà bankService hiểu
        // Hỗ trợ đầy đủ các field name: transactionID, transactionId, referenceCode, id
        const normalizeAcbTransaction = (tx: any) => ({
            transactionID: tx.transactionID || tx.transactionId || tx.id || tx.referenceCode,
            amount:        tx.creditAmount || tx.amount,
            description:   tx.description || tx.content || '',
            type:          'IN',
        });

        // Hỗ trợ cả single object lẫn array
        const rawList: any[] = Array.isArray(payload)
            ? payload
            : (payload.transactions ? payload.transactions : [payload]);

        const { bankService } = await import('../services/bank.service');

        for (const rawTx of rawList) {
            // Bỏ qua nếu không phải giao dịch tiền vào (creditAmount = 0 hoặc null)
            if (rawTx.creditAmount !== undefined && (!rawTx.creditAmount || rawTx.creditAmount <= 0)) {
                logger.info(`ℹ️ [Webhook-ACB] Skipping debit/zero transaction: ${rawTx.referenceCode}`);
                continue;
            }

            const transaction = normalizeAcbTransaction(rawTx);
            logger.info(`🔍 [Webhook-ACB] Processing: ID=${transaction.transactionID}, Amount=${transaction.amount}, Desc="${transaction.description}"`);

            if (config) {
                await bankService.processTransaction(transaction, config);
                continue;
            }

            // Fallback: tìm tenant qua payment code trong nội dung (mã mới hoặc cũ)
            let foundCode2: string | null = null;
            
            // Bước 1: Legacy format
            const legacyMatch2 = transaction.description.match(/(nap|mua)[\s-]?([A-Z0-9]{6,12})/i);
            if (legacyMatch2) {
                const potentialCode2 = legacyMatch2[2].toUpperCase();
                const [checkRows2]: any = await pool.execute(`SELECT tenant_id FROM ${TABLES.DEPOSIT_REQUESTS} WHERE payment_code = ? AND (status = 'pending' OR (status = 'failed' AND created_at >= NOW() - INTERVAL 24 HOUR)) LIMIT 1`, [potentialCode2]);
                if (checkRows2.length > 0) foundCode2 = potentialCode2;
            }
            
            // Bước 2: Token scan
            if (!foundCode2) {
                const tokens2 = transaction.description.match(/[A-Z0-9]{6,16}/gi) || [];
                for (const t2 of tokens2) {
                    const upperToken2 = t2.toUpperCase();
                    const [checkRows2]: any = await pool.execute(`SELECT tenant_id FROM ${TABLES.DEPOSIT_REQUESTS} WHERE payment_code = ? AND (status = 'pending' OR (status = 'failed' AND created_at >= NOW() - INTERVAL 24 HOUR)) LIMIT 1`, [upperToken2]);
                    if (checkRows2.length > 0) { foundCode2 = upperToken2; break; }
                }
            }
            
            if (foundCode2) {
                logger.info(`🔎 [Webhook-ACB] Fallback: Searching code ${foundCode2}...`);
                const [reqs]: any = await pool.execute(
                    `SELECT tenant_id FROM ${TABLES.DEPOSIT_REQUESTS} WHERE payment_code = ?`, [foundCode2]
                );
                if (reqs.length > 0) {
                    const tenantId = reqs[0].tenant_id;
                    const [configs]: any = await pool.execute(
                        `SELECT * FROM ${TABLES.BOT_CONFIGS} WHERE tenant_id = ?`, [tenantId]
                    );
                    if (configs.length > 0) {
                        logger.info(`✅ [Webhook-ACB] Fallback found Tenant ${tenantId} via code ${foundCode2}.`);
                        await bankService.processTransaction(transaction, configs[0]);
                    }
                } else {
                    logger.warn(`❌ [Webhook-ACB] Code ${foundCode2} not found in DEPOSIT_REQUESTS.`);
                }
            } else {
                logger.warn(`❌ [Webhook-ACB] No payment code in description: "${transaction.description}"`);
            }
        }

        return res.json({ success: true, message: 'ACB Webhook processed' });

    } catch (error: any) {
        logger.error(`🚨 [Webhook-ACB] Error: ${error.message}`);
        return res.status(500).json({ error: 'Internal Server Error' });
    }
};
