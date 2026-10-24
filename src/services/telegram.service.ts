import { Telegraf } from 'telegraf';
import axios from 'axios';
import * as https from 'https';
import sharp from 'sharp';
import pool from '../config/db';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { TABLES } from '../config/tables';
import logger from '../config/logger';
import { i18n } from './i18n.service';

const ipv4HttpsAgent = new https.Agent({ family: 4, keepAlive: true });


interface UserState {
    step: string;
    productId?: string;
}

interface ComboInfo {
    id: number;
    min_quantity: number;
    type: 'discount' | 'bonus';
    discount_percent: number | null;
    discount_amount: number | null;
    bonus_qty: number | null;
    label: string | null;
    is_active: boolean;
}

/**
 * TelegramService - Senior Refactor
 * Implements a modular, scalable architecture for bot interactions.
 */
class TelegramService {
    private bots: Map<number, { selling: Telegraf, notifying: Telegraf, adminId: string, token: string }> = new Map();
    private userStates: Map<string, UserState> = new Map();

    // Consolidated UI Elements
    private readonly UI = {
        SEP: '━━━━━━━━━━━━━━━━━━',
        SUCCESS: '🎉',
        ERROR: '❌',
        WAITING: '⏳',
        INFO: '📌',
        WALLET: '💰',
        CART: '🛒',
        HISTORY: '📊',
        BACK: '🔙',
        SECURE: '🔐',
        DONE: '✅'
    };

    constructor() {
        this.initAllBots();
        this.startReservationCleanupJob();
    }

    public async initAllBots() {
        try {
            logger.info(`🔄 Đang tải cấu hình Bot từ Database [${process.env.DB_NAME}]...`);
            const [configs]: any = await pool.execute(`SELECT * FROM ${TABLES.BOT_CONFIGS} WHERE status = "published"`);

            const activeTenantIds = new Set<number>();

            for (const config of configs) {
                const tenantId = config.tenant_id;
                activeTenantIds.add(tenantId);
                const existingBot = this.bots.get(tenantId);

                // Nếu bot đã tồn tại nhưng token thay đổi, hoặc cấu hình admin thay đổi -> Khởi động lại
                if (existingBot && (existingBot.token !== config.bot_token || existingBot.adminId !== config.telegram_admin_id)) {
                    logger.info(`♻️ [Tenant #${tenantId}] Cấu hình thay đổi, đang khởi động lại bot...`);
                    await this.stopBot(tenantId);
                    await this.initBot(config);
                } else if (!existingBot) {
                    await this.initBot(config);
                }
            }

            // Dọn dẹp các bot không còn trong DB hoặc bị gỡ (status != published)
            for (const [tenantId] of this.bots) {
                if (!activeTenantIds.has(tenantId)) {
                    logger.info(`🗑️ [Tenant #${tenantId}] Bot đã bị gỡ hoặc xóa, đang dừng bot...`);
                    await this.stopBot(tenantId);
                }
            }

            logger.info(`✅ Đã đồng bộ ${this.bots.size} bot.`);
        } catch (err: any) {
            logger.error(`🚨 [TelegramService] initAllBots error: ${err.message}`);
        }
    }

    private async stopBot(tenantId: number) {
        const botInfo = this.bots.get(tenantId);
        if (botInfo) {
            try {
                // Xóa webhook và dừng bot
                await botInfo.selling.telegram.deleteWebhook();
                this.bots.delete(tenantId);
            } catch (e: any) {
                logger.error(`[Tenant #${tenantId}] Stop bot error: ${e.message}`);
            }
        }
    }

    private async initBot(config: any) {
        const tenantId = config.tenant_id;
        const agent = new (require('https').Agent)({ family: 4, keepAlive: true });
        const options: any = { telegram: { agent } };
        if (process.env.TELEGRAM_API_URL) {
            options.telegram.apiRoot = process.env.TELEGRAM_API_URL;
        }
        const sellingBot = new Telegraf(config.bot_token, options);
        const notifyingBot = (config.telegram_notification_id && config.telegram_notification_id !== config.bot_token)
            ? new Telegraf(config.telegram_notification_id, options)
            : sellingBot;

        // Inject tenant + hot-reload config per request
        sellingBot.use(async (ctx: any, next) => {
            ctx.tenantId = tenantId;
            try {
                const [rows]: any = await pool.execute(`SELECT * FROM ${TABLES.BOT_CONFIGS} WHERE tenant_id = ?`, [tenantId]);
                ctx.config = rows[0] || config;
            } catch { ctx.config = config; }
            return next();
        });

        this.configureBot(sellingBot);
        this.bots.set(tenantId, { selling: sellingBot, notifying: notifyingBot, adminId: config.telegram_admin_id, token: config.bot_token });
        await this.launchBot(sellingBot, `Bot Sales #${tenantId}`, tenantId);
    }

    // --- Lifecycle Management ---
    private async launchBot(bot: Telegraf, name: string, tenantId: number) {
        try {
            // Tạo mã băm ngắn từ token để phân biệt các bot, tránh xung đột webhook cũ
            const token = bot.telegram.token;
            const tokenHash = crypto.createHash('md5').update(token).digest('hex').substring(0, 8);
            const webhookUrl = `https://api.cataishop.shop/api/v1/webhooks/telegram/${tenantId}/${tokenHash}`;

            // Set webhook
            await bot.telegram.setWebhook(webhookUrl);
            logger.info(`[${name}] Token suffix: ...${token.substring(token.length - 4)}`);
            logger.info(`[${name}] Webhook set: ${webhookUrl} ✅`);
        } catch (err: any) {
            logger.error(`[${name}] Webhook error: ${err.message}`);
        }
    }

    public async handleUpdate(tenantId: number, update: any) {
        const botInfo = this.bots.get(tenantId);
        if (botInfo?.selling) {
            return botInfo.selling.handleUpdate(update);
        }
    }

    // --- Bot Configuration ---
    private configureBot(bot: Telegraf) {
        // Log incoming messages
        bot.use(async (ctx: any, next) => {
            const from = ctx.from?.username || ctx.from?.id || 'Unknown';
            const text = ctx.message?.text || 'non-text';
            logger.info(`[Tenant #${ctx.tenantId}] msg @${from}: ${text.substring(0, 50)}`);
            return next();
        });

        // Auto-register user on first contact
        bot.use(async (ctx: any, next) => {
            if (ctx.from?.id) {
                const fullName = ctx.from.first_name + (ctx.from.last_name ? ' ' + ctx.from.last_name : '');
                const username = ctx.from.username || 'unknown';
                const telegramId = ctx.from.id.toString();
                try {
                    await pool.execute(
                        `INSERT INTO ${TABLES.CUSTOMERS} (tenant_id, telegram_id, full_name, username, balance, status, created_at, updated_at)
                         VALUES (?, ?, ?, ?, 0, 'published', NOW(), NOW())
                         ON DUPLICATE KEY UPDATE full_name = VALUES(full_name), username = VALUES(username), status = 'published', updated_at = NOW()`,
                        [ctx.tenantId, telegramId, fullName, username]
                    );
                } catch (err: any) {
                    logger.error(`[Tenant #${ctx.tenantId}] auto-reg error: ${err.message}`);
                }

                // Activity tracking (hourly bucket) — fire-and-forget so it never slows the bot down
                pool.execute(
                    `INSERT INTO ${TABLES.CUSTOMER_ACTIVITIES} (tenant_id, customer_id, activity_date, activity_hour, hits, last_seen_at)
                     SELECT c.tenant_id, c.id, CURDATE(), HOUR(NOW()), 1, NOW()
                     FROM ${TABLES.CUSTOMERS} c WHERE c.tenant_id = ? AND c.telegram_id = ? LIMIT 1
                     ON DUPLICATE KEY UPDATE hits = hits + 1, last_seen_at = NOW()`,
                    [ctx.tenantId, telegramId]
                ).catch((err: any) => logger.error(`[Tenant #${ctx.tenantId}] activity log error: ${err.message}`));
            }
            return next();
        });

        bot.start(async (ctx: any) => {
            const user = await this.getUser(ctx.tenantId, ctx.from.id.toString());
            const lang = user?.language || 'vi';
            let welcomeMsg = lang === 'en' && ctx.config?.welcome_message_en ? ctx.config.welcome_message_en : (ctx.config?.welcome_message || 'Chào mừng bạn đến với hệ thống Telehub! 🚀');
            welcomeMsg = this.formatWelcomeMessage(welcomeMsg);

            await ctx.reply(welcomeMsg, {
                parse_mode: 'HTML',
                reply_markup: {
                    keyboard: [
                        [{ text: i18n.t(lang, 'menu_products') }, { text: i18n.t(lang, 'menu_orders') }],
                        [{ text: i18n.t(lang, 'menu_profile') }, { text: i18n.t(lang, 'menu_deposit') }],
                        [{ text: i18n.t(lang, 'menu_api') }, { text: i18n.t(lang, 'menu_language') }]
                    ],
                    resize_keyboard: true
                }
            });

            return ctx.reply(this.langPickerMsg(), { parse_mode: 'HTML', reply_markup: this.langPickerKeyboard() });
        });

        bot.command('menu',     (ctx) => this.sendMenu(ctx));
        bot.command('history',  (ctx) => this.sendHistory(ctx));
        bot.command('balance',  (ctx) => this.handleBalanceAction(ctx, ctx.from.id.toString()));
        bot.command('profile',  (ctx) => this.handleBalanceAction(ctx, ctx.from.id.toString()));
        bot.command('nap',      (ctx) => this.handleDepositAction(ctx));
        bot.command('deposit',  (ctx) => this.handleDepositAction(ctx));
        bot.command('language', (ctx) => ctx.reply(this.langPickerMsg(), { parse_mode: 'HTML', reply_markup: this.langPickerKeyboard() }));

        const sendSupportMsg = (ctx: any) => {
            const msg = `<tg-emoji emoji-id="5409376292720123855">📞</tg-emoji> <b>THÔNG TIN HỖ TRỢ</b>\n\n` +
                        `<tg-emoji emoji-id="6293971347596907631">👨‍💻</tg-emoji> <b>Admin chính:</b>\n` +
                        `• Telegram: @ZeroBit2k4\n` +
                        `• Zalo: 0932507102\n` +
                        `• Hỗ trợ khi gặp lỗi hoặc cần tư vấn nạp/mua hàng.\n\n` +
                        `<tg-emoji emoji-id="5453957997418004470">👥</tg-emoji> <b>Nhóm cộng đồng:</b>\n` +
                        `• https://t.me/+Z43dsALfC11kMTdl\n\n` +
                        `<tg-emoji emoji-id="5188566277366493996">⏰</tg-emoji> <b>Thời gian hỗ trợ:</b>\n` +
                        `• Hỗ trợ nhanh nhất trong khung giờ hoạt động.\n` +
                        `• Vui lòng mô tả rõ lỗi gặp phải để được hỗ trợ hiệu quả hơn.`;
            return ctx.reply(msg, { parse_mode: 'HTML' });
        };
        bot.command('support', sendSupportMsg);

        bot.hears([/Sản phẩm/i, /Products/i],          (ctx: any) => this.sendMenu(ctx));
        bot.hears([/Tài khoản/i, /Profile/i],           (ctx: any) => this.handleBalanceAction(ctx, ctx.from.id.toString()));
        bot.hears([/Nạp tiền/i, /Deposit/i],            (ctx: any) => this.handleDepositAction(ctx));
        bot.hears([/Đơn hàng/i, /Orders/i],             (ctx: any) => this.sendHistory(ctx));
        bot.hears([/Liên hệ hỗ trợ/i, /Support/i],     (ctx: any) => sendSupportMsg(ctx));
        bot.hears([/Lấy API CTV/i, /Reseller API/i],    (ctx: any) => this.handleGetAPIAction(ctx));
        bot.hears([/Ngôn ngữ/i, /Language/i],           (ctx: any) => ctx.reply(this.langPickerMsg(), { parse_mode: 'HTML', reply_markup: this.langPickerKeyboard() }));

        bot.on('callback_query', (ctx) => this.dispatchCallback(ctx));
        bot.on('text', (ctx, next) => this.dispatchText(ctx, next));
    }

    // --- Action Dispatchers ---
    private async dispatchCallback(ctx: any) {
        const data = ctx.callbackQuery.data;
        const tgId = ctx.from.id.toString();
        const tenantId = ctx.tenantId;

        try {
            if (data === 'balance' || data === 'balance_keep') return this.handleBalanceAction(ctx, tgId, data === 'balance_keep');
            if (data === 'history') return this.handleHistoryAction(ctx, 1);
            if (data.startsWith('history_page:')) return this.handleHistoryAction(ctx, parseInt(data.split(':')[1]) || 1);
            if (data.startsWith('history_order:')) return this.sendHistoryOrderDetail(ctx, parseInt(data.split(':')[1]));
            if (data === 'deposit') return this.handleDepositAction(ctx);
            if (data === 'menu' || data === 'menu_keep') return this.handleMenuAction(ctx, tgId, data === 'menu_keep');
            if (data === 'cancel') return this.handleCancelAction(ctx, tgId);
            if (data === 'get_api') return this.handleGetAPIAction(ctx);
            if (data === 'reset_api') return this.handleResetAPIAction(ctx);
            if (data.startsWith('setlang_')) return this.handleLanguageChange(ctx, tgId, data);
            
            const user = await this.getUser(tenantId, tgId);
            const lang = user?.language || 'vi';

            if (data === 'notify_out_of_stock') return ctx.answerCbQuery(i18n.t(lang, 'out_of_stock_alert'), { show_alert: true });
            if (data === 'ask_quantity') return ctx.answerCbQuery(i18n.t(lang, 'ask_quantity_alert'), { show_alert: true });
            
            if (data === 'usdt_deposit') return this.handleUSDTDepositAction(ctx, tgId);

            // Pattern-based dispatching
            if (data.startsWith('genqr_')) return this.handleGenQRFlow(ctx, tgId, data);
            if (data.startsWith('genusdt_')) return this.handleGenUSDTFlow(ctx, tgId, data);
            if (data.startsWith('checkqr_')) return this.handleCheckQRFlow(ctx, data);
            if (data.startsWith('cancelqr_')) return this.handleCancelQRFlow(ctx, data);
            if (data.startsWith('buy_')) return this.handlePurchaseInitiation(ctx, tgId, data);
            if (data.startsWith('confirm_')) return this.handlePurchaseConfirmation(ctx, tgId, data);
            if (data.startsWith('pay_')) return this.handleWalletPayment(ctx, tgId, data);

        } catch (error: any) {
            logger.error(`[Tenant #${tenantId}] dispatchCallback error: ${error.message}`);
            ctx.answerCbQuery('Lỗi hệ thống, vui lòng thử lại.', { show_alert: true });
        }
    }

    private async handleGetAPIAction(ctx: any, edit: boolean = false) {
        const tgId = ctx.from.id.toString();
        const tenantId = ctx.tenantId;

        try {
            const [rows]: any = await pool.execute(`SELECT id, api_key, is_dealer FROM ${TABLES.CUSTOMERS} WHERE telegram_id = ? AND tenant_id = ?`, [tgId, tenantId]);
            if (!rows || rows.length === 0) {
                if (ctx.callbackQuery) return ctx.answerCbQuery('Không tìm thấy tài khoản.');
                return ctx.reply('Không tìm thấy tài khoản.');
            }

            let user = rows[0];
            let apiKey = user.api_key;

            if (!user.is_dealer || !apiKey) {
                apiKey = 'DLR_' + crypto.randomBytes(16).toString('hex');
                await pool.execute(`UPDATE ${TABLES.CUSTOMERS} SET is_dealer = 1, api_key = ? WHERE id = ?`, [apiKey, user.id]);
            }

            const msg = `
<tg-emoji emoji-id="6293853394910057834">⭐</tg-emoji> <b>THÔNG TIN API CỘNG TÁC VIÊN</b>

<tg-emoji emoji-id="5465443379917629504">🔑</tg-emoji> <b>API Key của bạn:</b> 
<code>${apiKey}</code>

<tg-emoji emoji-id="5373098009640836781">📚</tg-emoji> <b>Tài liệu hướng dẫn tích hợp:</b>
<tg-emoji emoji-id="5471978009449731768">👉</tg-emoji> <a href="https://cms.cataishop.shop/api-docs.html">Xem tài liệu API</a>

<i>Lưu ý: Tuyệt đối không chia sẻ API Key cho người khác!</i>
`;
            const options = { 
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🔄 Đổi API Key khác', callback_data: 'reset_api' }]
                    ]
                }
            };

            if (edit && ctx.callbackQuery) {
                return ctx.editMessageText(msg, options as any);
            }
            return ctx.reply(msg, options as any);
        } catch (e: any) {
            if (ctx.callbackQuery) return ctx.answerCbQuery('Lỗi lấy API: ' + e.message);
            return ctx.reply('Lỗi lấy API: ' + e.message);
        }
    }

    private async handleResetAPIAction(ctx: any) {
        const tgId = ctx.from.id.toString();
        const tenantId = ctx.tenantId;

        try {
            const [rows]: any = await pool.execute(`SELECT id FROM ${TABLES.CUSTOMERS} WHERE telegram_id = ? AND tenant_id = ?`, [tgId, tenantId]);
            if (!rows || rows.length === 0) return ctx.answerCbQuery('Không tìm thấy tài khoản.');

            let user = rows[0];
            const newApiKey = 'DLR_' + crypto.randomBytes(16).toString('hex');
            await pool.execute(`UPDATE ${TABLES.CUSTOMERS} SET is_dealer = 1, api_key = ? WHERE id = ?`, [newApiKey, user.id]);

            await ctx.answerCbQuery('✅ Đã đổi API Key mới thành công!');
            return this.handleGetAPIAction(ctx, true);
        } catch (e: any) {
            return ctx.answerCbQuery('Lỗi đổi API: ' + e.message, { show_alert: true });
        }
    }

    private async dispatchText(ctx: any, next: () => Promise<void>) {
        const tgId = ctx.from.id.toString();
        const text = ctx.message.text?.trim();
        if (!text || !/^\d+$/.test(text)) return next();

        const state = this.userStates.get(tgId);
        const amount = parseInt(text);

        if (state?.step === 'AWAITING_QUANTITY') return this.handleQuantityInput(ctx, tgId, state.productId!, amount);
        if (amount >= 1000 && amount <= 500000000) return this.handleDirectDeposit(ctx, tgId, amount);

        return next();
    }

    // --- Action Handlers: Wallet & Profile ---
    private async handleBalanceAction(ctx: any, tgId: string, keepMsg: boolean = false) {
        try {
            const user = await this.getUser(ctx.tenantId, tgId);
            if (!user) return ctx.answerCbQuery?.('Tài khoản chưa liên kết.', { show_alert: true });

            const [dep] = await pool.execute(`SELECT SUM(amount) as total FROM ${TABLES.BALANCE_LOGS} WHERE customer_id = ? AND type = "deposit" AND tenant_id = ?`, [user.id, ctx.tenantId]) as any;
            const [spent] = await pool.execute(`SELECT SUM(amount) as total FROM ${TABLES.BALANCE_LOGS} WHERE customer_id = ? AND type = "purchase" AND tenant_id = ?`, [user.id, ctx.tenantId]) as any;

            const [configRows]: any = await pool.execute(`SELECT usdt_exchange_rate FROM ${TABLES.BOT_CONFIGS} WHERE tenant_id = ?`, [ctx.tenantId]);
            const usdtRate = configRows[0]?.usdt_exchange_rate || 26000;

            const balUsd = (user.balance / usdtRate).toFixed(2);
            const depUsd = ((dep[0].total || 0) / usdtRate).toFixed(2);
            const spentUsd = ((spent[0].total || 0) / usdtRate).toFixed(2);

            const lang = user?.language || 'vi';
            const msg = [
                i18n.t(lang, 'wallet_title'),
                '',
                i18n.t(lang, 'balance', { amount: this.fmt(user.balance) + ` ($${balUsd})` }),
                i18n.t(lang, 'total_deposit', { amount: this.fmt(dep[0].total || 0) + ` ($${depUsd})` }),
                i18n.t(lang, 'total_spent', { amount: this.fmt(spent[0].total || 0) + ` ($${spentUsd})` }),
                '',
                i18n.t(lang, 'tele_id', { id: tgId }),
                '',
                i18n.t(lang, 'wallet_note')
            ].join('\n');

            const keyboard = {
                inline_keyboard: [
                    [{ text: i18n.t(lang, 'btn_deposit'), callback_data: 'deposit' }],
                    [{ text: i18n.t(lang, 'btn_history'), callback_data: 'history' }],
                    [{ text: i18n.t(lang, 'btn_continue_shopping'), callback_data: 'menu' }]
                ]
            };

            if (ctx.callbackQuery && !keepMsg) {
                await ctx.answerCbQuery();
                return await ctx.editMessageText(msg, { parse_mode: 'HTML', reply_markup: keyboard });
            } else {
                if (ctx.callbackQuery) await ctx.answerCbQuery();
                return await ctx.reply(msg, { parse_mode: 'HTML', reply_markup: keyboard });
            }
        } catch (err: any) {
            logger.error(`[Tenant ${ctx.tenantId}] handleBalanceAction error: ${err.message}`);
        }
    }

    private async handleHistoryAction(ctx: any, page: number = 1) {
        try {
            await ctx.answerCbQuery?.();
            return this.sendHistory(ctx, page);
        } catch (err: any) {
            logger.error(`[Tenant ${ctx.tenantId}] handleHistoryAction error: ${err.message}`);
        }
    }

    private async handleDepositAction(ctx: any) {
        try {
            const tgId = ctx.from.id.toString();
            const user = await this.getUser(ctx.tenantId, tgId);
            const lang = user?.language || 'vi';
            const msg = i18n.t(lang, 'deposit_choose_amount');
            const keyboard = {
                inline_keyboard: [
                    [{ text: '20,000đ', callback_data: 'genqr_20000' }, { text: '50,000đ', callback_data: 'genqr_50000' }],
                    [{ text: '100,000đ', callback_data: 'genqr_100000' }, { text: '200,000đ', callback_data: 'genqr_200000' }],
                    [{ text: '500,000đ', callback_data: 'genqr_500000' }, { text: '1,000,000đ', callback_data: 'genqr_1000000' }],
                    [{ text: i18n.t(lang, 'btn_deposit_usdt'), callback_data: 'usdt_deposit' }],
                    [{ text: i18n.t(lang, 'btn_back'), callback_data: 'balance', icon_custom_emoji_id: '6086673312241424329' } as any]
                ]
            };

            if (ctx.callbackQuery) {
                await ctx.answerCbQuery?.();
                return await ctx.editMessageText(msg, { parse_mode: 'HTML', reply_markup: keyboard });
            } else {
                return await ctx.reply(msg, { parse_mode: 'HTML', reply_markup: keyboard });
            }
        } catch (err: any) {
            logger.error(`[Tenant ${ctx.tenantId}] handleDepositAction error: ${err.message}`);
        }
    }

    // --- Action Handlers: Commerce ---
    private async handleMenuAction(ctx: any, tgId: string, keepMsg: boolean = false) {
        try {
            this.userStates.delete(tgId);
            await ctx.answerCbQuery?.();
            return this.sendMenu(ctx, keepMsg);
        } catch (err: any) {
            logger.error(`[Tenant ${ctx.tenantId}] handleMenuAction error: ${err.message}`);
        }
    }

    private async handleCancelAction(ctx: any, tgId: string) {
        try {
            this.userStates.delete(tgId);
            await ctx.answerCbQuery?.();
            return this.deleteMsg(ctx);
        } catch (err: any) {
            logger.error(`[Tenant ${ctx.tenantId}] handleCancelAction error: ${err.message}`);
        }
    }

    // --- Combo Helpers ---
    private async getActiveCombos(tenantId: number, productId: string): Promise<ComboInfo[]> {
        const [rows]: any = await pool.execute(
            `SELECT * FROM ${TABLES.PRODUCT_COMBOS} WHERE product_id = ? AND tenant_id = ? AND is_active = 1 ORDER BY min_quantity ASC, sort_order ASC`,
            [productId, tenantId]
        );
        return rows || [];
    }

    /**
     * Tìm combo tốt nhất cho qty và giá hiện tại.
     * So sánh effective_discount = lợi ích quy đổi thành tiền để chọn combo có lợi nhất.
     */
    private getBestCombo(combos: ComboInfo[], qty: number, pricePerAcc: number): ComboInfo | null {
        const eligible = combos.filter(c => c.min_quantity <= qty);
        if (!eligible.length) return null;

        let best: ComboInfo | null = null;
        let bestDiscount = -1;

        for (const c of eligible) {
            let effectiveDiscount = 0;
            if (c.type === 'bonus') {
                effectiveDiscount = (c.bonus_qty || 0) * pricePerAcc;
            } else {
                if ((c.discount_percent || 0) > 0) {
                    effectiveDiscount = qty * pricePerAcc * (c.discount_percent! / 100);
                } else {
                    effectiveDiscount = qty * (c.discount_amount || 0);
                }
            }
            if (effectiveDiscount > bestDiscount) {
                bestDiscount = effectiveDiscount;
                best = c;
            }
        }
        return best;
    }

    /**
     * Tính tổng tiền và số acc thực nhận sau khi áp dụng combo.
     */
    private applyCombo(combo: any, qty: number, pricePerAcc: number, lang: string = 'vi'): {
        total: number;
        actualQty: number;
        bonusQty: number;
        finalPricePerAcc: number;
        discountText: string;
    } {
        if (!combo) {
            return { total: qty * pricePerAcc, actualQty: qty, bonusQty: 0, finalPricePerAcc: pricePerAcc, discountText: '' };
        }
        if (combo.type === 'bonus') {
            const bonus = combo.bonus_qty || 0;
            return {
                total: qty * pricePerAcc,
                actualQty: qty + bonus,
                bonusQty: bonus,
                finalPricePerAcc: pricePerAcc,
                discountText: `<tg-emoji emoji-id="5445408903670022363">🎁</tg-emoji> <b>${i18n.t(lang, 'bonus_combo', { bonus: bonus, total: qty + bonus })}</b>`
            };
        }
        // discount type
        let discountPerAcc = 0;
        let discountText = '';
        if ((combo.discount_percent || 0) > 0) {
            discountPerAcc = pricePerAcc * (combo.discount_percent! / 100);
            const finalP = Math.max(0, pricePerAcc - discountPerAcc);
            discountText = `<tg-emoji emoji-id="5240228673738527951">🏷️</tg-emoji> <b>${i18n.t(lang, 'discount_percent', { percent: combo.discount_percent, price: Math.floor(finalP).toLocaleString() })}</b>`;
        } else {
            discountPerAcc = combo.discount_amount || 0;
            const fmt = Math.floor(discountPerAcc).toLocaleString();
            const finalP = Math.max(0, pricePerAcc - discountPerAcc);
            discountText = `<tg-emoji emoji-id="5240228673738527951">🏷️</tg-emoji> <b>${i18n.t(lang, 'discount_amount', { amount: fmt, price: Math.floor(finalP).toLocaleString() })}</b>`;
        }
        const finalPrice = Math.max(0, pricePerAcc - discountPerAcc);
        return {
            total: qty * finalPrice,
            actualQty: qty,
            bonusQty: 0,
            finalPricePerAcc: finalPrice,
            discountText
        };
    }

    private async handlePurchaseInitiation(ctx: any, tgId: string, data: string) {
        try {
            const productId = data.split('_')[1];
            this.userStates.set(tgId, { step: 'AWAITING_QUANTITY', productId });

            const user = await this.getUser(ctx.tenantId, tgId);
            const [prodRows] = await pool.execute(`
                SELECT p.name, p.name_en, p.icon, p.description, p.description_en, p.price as retail_price,
                       p.is_api_product, p.api_stock, p.api_sold,
                       CASE WHEN p.is_api_product = 1 THEN p.api_stock ELSE COUNT(DISTINCT CASE WHEN pi.is_sold = 0 THEN pi.id END) END as stock,
                       CASE WHEN p.is_api_product = 1 THEN COALESCE(p.api_sold, 0) ELSE COUNT(DISTINCT CASE WHEN pi.is_sold = 1 THEN pi.id END) END as sold
                FROM ${TABLES.PRODUCTS} p
                LEFT JOIN ${TABLES.PRODUCT_ITEMS} pi ON p.id = pi.product_id AND pi.tenant_id = p.tenant_id
                WHERE p.id = ? AND p.tenant_id = ?
                GROUP BY p.id
            `, [productId, ctx.tenantId]) as any;

            if (!prodRows || !prodRows.length) {
                if (ctx.callbackQuery) {
                    return ctx.answerCbQuery('Sản phẩm không tồn tại hoặc đã bị xóa.', { show_alert: true });
                }
                return ctx.reply('❌ Sản phẩm không tồn tại hoặc đã bị xóa.');
            }

            const product = prodRows[0];

            // Lấy giá hiệu dụng (CTV hoặc retail)
            const [configRows]: any = await pool.execute(`SELECT usdt_exchange_rate FROM ${TABLES.BOT_CONFIGS} WHERE tenant_id = ?`, [ctx.tenantId]);
            const usdtRate = configRows[0]?.usdt_exchange_rate || 26000;

            let activePrice = product.retail_price;
            let activePriceUsd = product.price_usd;
            let isDealerPrice = false;
            if (user && user.is_dealer) {
                const [dealerRows]: any = await pool.execute(`SELECT price, price_usd FROM ${TABLES.DEALER_PRICES} WHERE customer_id = ? AND product_id = ? AND tenant_id = ? LIMIT 1`, [user.id, productId, ctx.tenantId]);
                if (dealerRows && dealerRows.length > 0) {
                    if (dealerRows[0].price !== null && dealerRows[0].price !== undefined) {
                        activePrice = dealerRows[0].price;
                        isDealerPrice = true;
                    } else if (dealerRows[0].price_usd !== null && dealerRows[0].price_usd !== undefined) {
                        activePriceUsd = dealerRows[0].price_usd;
                        activePrice = Math.round(activePriceUsd * usdtRate);
                        isDealerPrice = true;
                    }
                }
            }

            let usdPrice = 0;
            if (activePriceUsd && parseFloat(activePriceUsd) > 0) {
                usdPrice = parseFloat(activePriceUsd);
            } else {
                usdPrice = (activePrice / usdtRate) * 1.02;
            }
            const priceStrUsd = `$${usdPrice.toFixed(2)}`;

            const lang = user?.language || 'vi';

            let priceHtml = `\n${i18n.t(lang, 'price_label', { price: `${this.fmt(activePrice)} (${priceStrUsd})`, dealer: isDealerPrice ? i18n.t(lang, 'dealer_price_text') : '' })}\n`;

            // Xử lý hiển thị Emoji của sản phẩm
            let productIconHtml = '';
            if (product.icon) {
                if (/^\d+$/.test(product.icon.trim())) {
                    productIconHtml = `<tg-emoji emoji-id="${product.icon.trim()}">🤖</tg-emoji> `;
                } else {
                    productIconHtml = `${product.icon.trim()} `;
                }
            } else {
                productIconHtml = `<tg-emoji emoji-id="5312361253610475399">🛒</tg-emoji> `;
            }

            let descHtml = '';
            let activeDescription = (lang === 'en' && product.description_en) ? product.description_en : product.description;
            if (activeDescription) {
                let formattedDesc = activeDescription;
                formattedDesc = formattedDesc.replace(/(emoji-id=")?\[?(\d{18,19})\]?(")?/g, (match, prefix, id, suffix) => {
                    if (prefix === 'emoji-id="' && suffix === '"') return match;
                    return `<tg-emoji emoji-id="${id}">✨</tg-emoji>`;
                });
                formattedDesc = formattedDesc.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>');
                formattedDesc = formattedDesc.replace(/\*(.*?)\*/g, '<i>$1</i>');
                descHtml = `\n<blockquote>${i18n.t(lang, 'desc_label')}\n${formattedDesc}</blockquote>\n`;
            }

            // === COMBO SECTION ===
            const combos = await this.getActiveCombos(ctx.tenantId, productId);
            let comboHtml = '';
            const comboButtons: any[] = [];

            if (combos.length > 0) {
                comboHtml = `\n<tg-emoji emoji-id="5445408903670022363">🎁</tg-emoji> <b>${i18n.t(lang, 'combo_offer', {})}</b>\n`;
                for (const c of combos) {
                    const applied = this.applyCombo(c, c.min_quantity, activePrice, lang);
                    let detail = '';
                    if (c.type === 'bonus') {
                        detail = i18n.t(lang, 'combo_detail_bonus', { min: c.min_quantity, bonus: c.bonus_qty });
                    } else if ((c.discount_percent || 0) > 0) {
                        const perAcc = Math.floor(applied.finalPricePerAcc);
                        detail = i18n.t(lang, 'combo_detail_percent', { min: c.min_quantity, percent: c.discount_percent, price: this.fmt(perAcc) });
                    } else {
                        const perAcc = Math.floor(applied.finalPricePerAcc);
                        detail = i18n.t(lang, 'combo_detail_amount', { min: c.min_quantity, amount: this.fmt(c.discount_amount || 0), price: this.fmt(perAcc) });
                    }
                    if (c.label) detail = `<b>${c.label}</b>: ` + detail;
                    comboHtml += `• ${detail}\n`;

                    // Nút bấm nhanh cho mốc combo
                    const requiredQty = c.type === 'bonus' ? c.min_quantity + (c.bonus_qty || 0) : c.min_quantity;
                    if (product.stock < requiredQty) {
                        comboButtons.push({
                            text: i18n.t(lang, 'btn_buy_insufficient', { qty: c.min_quantity }),
                            callback_data: 'notify_out_of_stock'
                        });
                    } else {
                        const btnLabel = c.type === 'bonus'
                            ? i18n.t(lang, 'btn_buy_bonus', { qty: c.min_quantity, bonus: c.bonus_qty })
                            : i18n.t(lang, 'btn_buy_combo', { qty: c.min_quantity });
                        comboButtons.push({ 
                            text: btnLabel, 
                            callback_data: `confirm_${productId}_${c.min_quantity}`,
                            icon_custom_emoji_id: c.type === 'bonus' ? '5445408903670022363' : '5240228673738527951'
                        } as any);
                    }
                }
            }

            let activeName = (lang === 'en' && product.name_en) ? product.name_en : product.name;
            const msg = i18n.t(lang, 'selected_product', { icon: productIconHtml, name: activeName, stock: product.stock, sold: parseInt(product.sold) > 0 ? parseInt(product.sold).toLocaleString() : '0' }) +
                priceHtml +
                descHtml +
                comboHtml +
                `\n${i18n.t(lang, 'choose_quantity')}`;

            // Build keyboard: nút số lượng thường + nút combo
            const qtyRow = [
                product.stock >= 1 ? { text: '1', callback_data: `confirm_${productId}_1` } : { text: '❌ 1', callback_data: 'notify_out_of_stock' },
                product.stock >= 2 ? { text: '2', callback_data: `confirm_${productId}_2` } : { text: '❌ 2', callback_data: 'notify_out_of_stock' },
                product.stock >= 5 ? { text: '5', callback_data: `confirm_${productId}_5` } : { text: '❌ 5', callback_data: 'notify_out_of_stock' },
                product.stock >= 10 ? { text: '10', callback_data: `confirm_${productId}_10` } : { text: '❌ 10', callback_data: 'notify_out_of_stock' },
                product.stock >= 20 ? { text: '20', callback_data: `confirm_${productId}_20` } : { text: '❌ 20', callback_data: 'notify_out_of_stock' }
            ];
            const inlineRows: any[] = [
                qtyRow,
                [{ text: i18n.t(lang, 'btn_custom_qty'), callback_data: 'ask_quantity' }]
            ];
            // Thêm nút combo (mỗi nút 1 hàng nếu có label dài)
            comboButtons.forEach(btn => inlineRows.push([btn]));
            inlineRows.push([{ text: i18n.t(lang, 'btn_back'), callback_data: 'menu', icon_custom_emoji_id: '6086673312241424329' } as any]);

            const keyboard = { inline_keyboard: inlineRows };

            if (ctx.callbackQuery) {
                await ctx.answerCbQuery?.();
                return await ctx.editMessageText(msg, { parse_mode: 'HTML', reply_markup: keyboard });
            } else {
                return await ctx.reply(msg, { parse_mode: 'HTML', reply_markup: keyboard });
            }
        } catch (err: any) {
            logger.error(`[Tenant ${ctx.tenantId}] handlePurchaseInitiation error: ${err.message}`);
        }
    }

    private safeAnswerCb(ctx: any, text?: string, options?: any) {
        if (ctx.callbackQuery) {
            return ctx.answerCbQuery(text, options).catch(() => {});
        } else if (text) {
            return ctx.reply(text).catch(() => {});
        }
    }

    private async handleQuantityInput(ctx: any, tgId: string, productId: string, qty: number) {
        if (qty <= 0) return ctx.reply('❌ Số lượng phải lớn hơn 0.');
        this.userStates.delete(tgId);
        return this.handlePurchaseConfirmation(ctx, tgId, `confirm_${productId}_${qty}`);
    }

    private async handlePurchaseConfirmation(ctx: any, tgId: string, data: string) {
        const [, productId, qtyStr] = data.split('_');
        const quantity = parseInt(qtyStr);

        const user = await this.getUser(ctx.tenantId, tgId);
        const lang = user?.language || 'vi';

        const [prodRows] = await pool.execute(`
            SELECT p.name, p.name_en, p.icon, p.price as retail_price, p.price_usd,
                   p.is_api_product, p.api_stock,
                   CASE WHEN p.is_api_product = 1 THEN p.api_stock ELSE COUNT(pi.id) END as stock 
            FROM ${TABLES.PRODUCTS} p 
            LEFT JOIN ${TABLES.PRODUCT_ITEMS} pi ON p.id = pi.product_id 
                AND pi.is_sold = 0
                AND (pi.reserved_until IS NULL OR pi.reserved_until < NOW())
            WHERE p.id = ? AND p.tenant_id = ?
            GROUP BY p.id
        `, [productId, ctx.tenantId]) as any;

        const [configRows]: any = await pool.execute(`SELECT usdt_exchange_rate FROM ${TABLES.BOT_CONFIGS} WHERE tenant_id = ?`, [ctx.tenantId]);
        const usdtRate = configRows[0]?.usdt_exchange_rate || 26000;

        if (!prodRows.length) return this.safeAnswerCb(ctx, 'Sản phẩm đã bị xóa.', { show_alert: true });

        const product = prodRows[0];
        const stock = parseInt(product.stock);

        let activePrice = product.retail_price;
        let activePriceUsd = product.price_usd;
        let isDealerPrice = false;
        if (user && user.is_dealer) {
            const [dealerRows]: any = await pool.execute(`SELECT price, price_usd FROM ${TABLES.DEALER_PRICES} WHERE customer_id = ? AND product_id = ? AND tenant_id = ? LIMIT 1`, [user.id, productId, ctx.tenantId]);
            if (dealerRows && dealerRows.length > 0) {
                if (dealerRows[0].price !== null && dealerRows[0].price !== undefined) {
                    activePrice = dealerRows[0].price;
                    isDealerPrice = true;
                } else if (dealerRows[0].price_usd !== null && dealerRows[0].price_usd !== undefined) {
                    activePriceUsd = dealerRows[0].price_usd;
                    activePrice = Math.round(activePriceUsd * usdtRate);
                    isDealerPrice = true;
                }
            }
        }

        // === ÁP DỤNG COMBO ===
        const combos = await this.getActiveCombos(ctx.tenantId, productId);
        const bestCombo = this.getBestCombo(combos, quantity, activePrice);
        const comboResult = this.applyCombo(bestCombo, quantity, activePrice, lang);
        const { total, actualQty, bonusQty, discountText } = comboResult;

        // Kiểm tra kho thực sự còn (đã trừ các slot đang reserved bởi người khác)
        if (stock < actualQty) {
            const errorMsg = i18n.t(lang, 'error_stock_only', { stock, needed: actualQty });
            return this.safeAnswerCb(ctx, errorMsg, { show_alert: true });
        }

        // === TẠM GIỮ SLOT cho thanh toán Ví (5 phút) ===
        if (user) {
            await this.reserveStock(ctx.tenantId, parseInt(productId), actualQty, `tg_${tgId}`, 5);
        }

        const buttons = [];

        if (user && user.balance >= total) {
            buttons.push([{ text: `💳 Thanh toán Ví (${this.fmt(user.balance)}đ)`, callback_data: `pay_${productId}_${quantity}` }]);
        }

        // Encode combo id vào QR callback nếu có
        const comboParam = bestCombo ? `_${bestCombo.id}` : '';
        buttons.push([{ text: `🏦 Chuyển khoản QR (Tự động)`, callback_data: `genqr_${total}_${productId}_${quantity}${comboParam}` }]);
        buttons.push([{ text: `💎 Thanh toán USDT (Tự động)`, callback_data: `genusdt_${total}_${productId}_${quantity}${comboParam}` }]);

        buttons.push([{ text: 'Thay đổi số lượng', callback_data: `buy_${productId}`, icon_custom_emoji_id: '6086673312241424329' } as any]);
        buttons.push([{ text: '❌ Hủy đơn', callback_data: 'menu' }]);

        // Icon sản phẩm
        let productIconHtml = '';
        if (product.icon) {
            if (/^\d+$/.test(product.icon.trim())) {
                productIconHtml = `<tg-emoji emoji-id="${product.icon.trim()}">🤖</tg-emoji> `;
            } else {
                productIconHtml = `${product.icon.trim()} `;
            }
        } else {
            productIconHtml = `<tg-emoji emoji-id="5312361253610475399">🛒</tg-emoji> `;
        }

        const pName = lang === 'en' && product.name_en ? product.name_en : product.name;

        // Xây dựng message xác nhận
        let comboLine = '';
        if (bestCombo) {
            comboLine = `\n${discountText}`;
            comboLine += '\n';
        }

        let usdPrice = 0;
        if (activePriceUsd && parseFloat(activePriceUsd) > 0) {
            usdPrice = parseFloat(activePriceUsd);
        } else {
            usdPrice = (activePrice / usdtRate) * 1.02; // 2% fee
        }
        let totalUsd = usdPrice * quantity;
        if (activePrice * quantity > 0) {
            totalUsd = totalUsd * (total / (activePrice * quantity));
        }

        const priceLineText = isDealerPrice ? (lang === 'en' ? ' <i>(Reseller Price)</i>' : ' <i>(Giá CTV)</i>') : '';
        const msg = `${i18n.t(lang, 'confirm_order_title')}\n\n` +
            `${i18n.t(lang, 'confirm_product', { icon: productIconHtml, name: pName })}\n` +
            `${bonusQty > 0 ? i18n.t(lang, 'confirm_qty_bonus', { qty: quantity, bonus: bonusQty, actual: actualQty }) : i18n.t(lang, 'confirm_qty', { qty: quantity })}\n` +
            comboLine +
            `\n${i18n.t(lang, 'confirm_total', { total: this.fmt(total) + 'đ ($' + totalUsd.toFixed(2) + ')', dealer: priceLineText })}\n\n` +
            `${i18n.t(lang, 'choose_payment')}`;

        buttons.length = 0; // Clear buttons and re-add with translations
        const userBalance = parseFloat(user?.balance || '0');
        if (user && userBalance >= total) {
            buttons.push([{ text: i18n.t(lang, 'pay_wallet', { balance: this.fmt(userBalance) }), callback_data: `pay_${productId}_${quantity}${comboParam}` }]);
        }
        buttons.push([{ text: i18n.t(lang, 'pay_qr'), callback_data: `genqr_${total}_${productId}_${quantity}${comboParam}` }]);
        buttons.push([{ text: i18n.t(lang, 'pay_usdt'), callback_data: `genusdt_${total}_${productId}_${quantity}${comboParam}` }]);
        buttons.push([{ text: i18n.t(lang, 'change_qty'), callback_data: `buy_${productId}`, icon_custom_emoji_id: '6086673312241424329' } as any]);
        buttons.push([{ text: i18n.t(lang, 'cancel_order'), callback_data: 'menu' }]);

        this.safeAnswerCb(ctx);
        const options = { parse_mode: 'HTML' as const, reply_markup: { inline_keyboard: buttons } };
        return ctx.callbackQuery ? ctx.editMessageText(msg, options) : ctx.reply(msg, options);
    }

    private async handleWalletPayment(ctx: any, tgId: string, data: string) {
        const parts = data.split('_');
        const productId = parts[1];
        const quantity = parseInt(parts[2]);
        const comboId = parts[3] ? parseInt(parts[3]) : undefined;

        const user = await this.getUser(ctx.tenantId, tgId);
        const [prod] = await pool.execute(`SELECT name, price as retail_price FROM ${TABLES.PRODUCTS} WHERE id = ? AND tenant_id = ?`, [productId, ctx.tenantId]) as any;

        if (!user || !prod.length) return this.safeAnswerCb(ctx, 'Lỗi đồng bộ.', { show_alert: true });

        let activePrice = prod[0].retail_price;
        const [configRows]: any = await pool.execute(`SELECT usdt_exchange_rate FROM ${TABLES.BOT_CONFIGS} WHERE tenant_id = ?`, [ctx.tenantId]);
        const usdtRate = configRows[0]?.usdt_exchange_rate || 26000;
        let dealerRows: any = [];
        if (user && user.is_dealer) {
            [dealerRows] = await pool.execute(`SELECT price, price_usd FROM ${TABLES.DEALER_PRICES} WHERE customer_id = ? AND product_id = ? AND tenant_id = ? LIMIT 1`, [user.id, productId, ctx.tenantId]);
        }
        if (dealerRows && dealerRows.length > 0) {
            if (dealerRows[0].price !== null && dealerRows[0].price !== undefined) {
                activePrice = dealerRows[0].price;
            } else if (dealerRows[0].price_usd !== null && dealerRows[0].price_usd !== undefined) {
                activePrice = Math.round(dealerRows[0].price_usd * usdtRate);
            }
        }

        // Tự động tìm combo nếu không truyền trực tiếp trong callback
        let selectedComboId = comboId;
        if (!selectedComboId) {
            const combos = await this.getActiveCombos(ctx.tenantId, productId);
            const bestCombo = this.getBestCombo(combos, quantity, activePrice);
            if (bestCombo) selectedComboId = bestCombo.id;
        }

        let total = activePrice * quantity;
        let bonusQty = 0;
        if (selectedComboId) {
            const [comboRows]: any = await pool.execute(
                `SELECT * FROM ${TABLES.PRODUCT_COMBOS} WHERE id = ? AND tenant_id = ? AND is_active = 1`,
                [selectedComboId, ctx.tenantId]
            );
            if (comboRows && comboRows.length > 0) {
                const applied = this.applyCombo(comboRows[0], quantity, activePrice);
                total = applied.total;
                bonusQty = applied.bonusQty;
            }
        }

        const userBalance = parseFloat(user.balance || '0');
        if (userBalance < total) return this.safeAnswerCb(ctx, 'Số dư không đủ.', { show_alert: true });

        this.safeAnswerCb(ctx, '🚀 Đang xử lý thanh toán...');
        const result = await this.handleDirectPurchase(ctx.tenantId, user.id, productId, quantity, undefined, bonusQty, selectedComboId, `tg_${tgId}`);

        if (result.success) {
            await this.sendSuccessDelivery({
                ctx,
                tenantId: ctx.tenantId,
                telegramId: tgId,
                productName: prod[0].name,
                quantity: quantity + bonusQty,
                total,
                remainingBalance: result.remainingBalance,
                items: result.items,
                orderId: result.orderId,
                code: (result as any).code,
                bonusQty: (result as any).bonusQty || bonusQty
            });

            const itemsFormatted = result.items.map((item: string) => {
                return item.split('\n').map(line => {
                    const trimmed = line.trim();
                    if (trimmed.startsWith('http')) return trimmed;
                    return `<code>${trimmed}</code>`;
                }).join('\n');
            }).join('\n');

            const timeVN = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
            const orderCodeDisplay = (result as any).code ? `<code>${(result as any).code}</code>` : `<code>#${result.orderId}</code>`;
            const adminMsg = [
                `🛒 <b>ĐƠN HÀNG MỚI (Thanh toán Ví)</b>`,
                `🕒 <b>Thời gian:</b> ${timeVN}`,
                `📝 <b>Mã đơn:</b> ${orderCodeDisplay}`,
                `👤 <b>Khách hàng:</b> ${ctx.from.first_name || ''} ${ctx.from.last_name || ''} | @${ctx.from.username || 'N/A'} (ID: <code>${tgId}</code>)`,
                `📦 <b>Sản phẩm:</b> ${quantity + bonusQty} x ${prod[0].name}`,
                `💵 <b>Tổng thanh toán:</b> ${this.fmt(total)}đ`,
                `━━━━━━━━━━━━━━━━━━`,
                `📑 <b>Tài khoản bàn giao:</b>`,
                itemsFormatted
            ].join('\n');

            this.notifyAdmin(ctx.tenantId, adminMsg);
            this.deleteMsg(ctx);
        } else {
            ctx.reply(`❌ Lỗi xử lý: ${result.error}`);
        }
    }

    private async sendSuccessDelivery(data: {
        ctx?: any,
        tenantId: number,
        telegramId: string | number,
        productName: string,
        quantity: number,
        total: number,
        remainingBalance: number,
        items: string[],
        orderId: number,
        code?: string,
        bonusQty?: number
    }) {
        const bonusLine = data.bonusQty && data.bonusQty > 0
            ? `<tg-emoji emoji-id="5445408903670022363">🎁</tg-emoji> <b>Tặng thêm:</b> ${data.bonusQty} acc (tổng: ${data.quantity + data.bonusQty} acc)\n`
            : '';

        const timeVN = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
        const orderCodeDisplay = data.code ? `<code>${data.code}</code>` : `#${data.orderId}`;
        const keyboard = { inline_keyboard: [[{ text: '🛒 Tiếp tục', callback_data: 'menu_keep' }, { text: '💳 Ví', callback_data: 'balance_keep' }]] };

        const formattedItems = data.items.map(item => {
            return item.split('\n').map(line => {
                const trimmed = line.trim();
                if (trimmed.startsWith('http')) return trimmed;
                return `<code>${trimmed}</code>`;
            }).join('\n');
        });

        const itemsCombined = formattedItems.join('\n');
        const isBulk = data.quantity > 5 || itemsCombined.length > 2000;

        const fakeDocCtx = data.ctx || {
            tenantId: data.tenantId,
            replyWithDocument: (d: any, o: any) => {
                const botInfo = this.bots.get(Number(data.tenantId));
                if (botInfo?.selling) {
                    return botInfo.selling.telegram.sendDocument(data.telegramId, d, o);
                }
                return Promise.resolve();
            }
        };

        if (isBulk) {
            const previewCount = Math.min(3, formattedItems.length);
            const previewItems = formattedItems.slice(0, previewCount).join('\n');
            const summaryMsg = [
                `<tg-emoji emoji-id="5208541126583136130">✅</tg-emoji> <b>GIAO DỊCH THÀNH CÔNG</b>`,
                `🕒 <b>Thời gian:</b> ${timeVN}`,
                `📝 <b>Mã đơn:</b> ${orderCodeDisplay}`,
                this.UI.SEP,
                `<tg-emoji emoji-id="6327806696227870775">📦</tg-emoji> <b>SP:</b> ${data.productName}`,
                `<tg-emoji emoji-id="5226929552319594190">🔢</tg-emoji> <b>SL nhận:</b> ${data.quantity}  |  <tg-emoji emoji-id="5287231198098117669">💰</tg-emoji> <b>Tổng:</b> ${this.fmt(data.total)}đ`,
                bonusLine,
                `<tg-emoji emoji-id="6197489709065704487">💳</tg-emoji> <b>SD còn lại:</b> ${this.fmt(data.remainingBalance)}đ`,
                this.UI.SEP,
                `<tg-emoji emoji-id="6084365261241062593">🔑</tg-emoji> <b>Tài khoản bàn giao:</b>`,
                previewItems,
                data.quantity > previewCount ? `\n<i>...và ${data.quantity - previewCount} tài khoản khác được đính kèm file và gửi chi tiết bên dưới.</i>` : '',
                data.code ? `\n<tg-emoji emoji-id="5323479695579163583">📑</tg-emoji> <b>Mã đơn:</b> <code>${data.code}</code>` : '',
            ].filter(Boolean).join('\n');

            if (data.ctx) {
                await data.ctx.reply(summaryMsg, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
            } else {
                await this.notifyUser(data.tenantId, data.telegramId, summaryMsg, { parse_mode: 'HTML', reply_markup: keyboard });
            }

            // Gửi file đính kèm
            await this.deliveryAsFile(fakeDocCtx, data.orderId, data.items);

            // Gửi chi tiết các phần link chia nhỏ nếu cần
            let chunk = '';
            let part = 1;
            for (let i = 0; i < data.items.length; i++) {
                const line = `${i + 1}. ${data.items[i]}\n\n`;
                if ((chunk + line).length > 3500) {
                    const chunkMsg = `<b>Danh sách (Phần ${part}):</b>\n${chunk}`;
                    if (data.ctx) {
                        await data.ctx.reply(chunkMsg, { parse_mode: 'HTML' }).catch(() => {});
                    } else {
                        await this.notifyUser(data.tenantId, data.telegramId, chunkMsg, { parse_mode: 'HTML' });
                    }
                    part++;
                    chunk = line;
                } else {
                    chunk += line;
                }
            }
            if (chunk) {
                const chunkMsg = `<b>Danh sách (Phần ${part}):</b>\n${chunk}`;
                if (data.ctx) {
                    await data.ctx.reply(chunkMsg, { parse_mode: 'HTML' }).catch(() => {});
                } else {
                    await this.notifyUser(data.tenantId, data.telegramId, chunkMsg, { parse_mode: 'HTML' });
                }
            }
        } else {
            const msg = [
                `<tg-emoji emoji-id="5208541126583136130">✅</tg-emoji> <b>GIAO DỊCH THÀNH CÔNG</b>`,
                `🕒 <b>Thời gian:</b> ${timeVN}`,
                `📝 <b>Mã đơn:</b> ${orderCodeDisplay}`,
                this.UI.SEP,
                `<tg-emoji emoji-id="6327806696227870775">📦</tg-emoji> <b>SP:</b> ${data.productName}`,
                `<tg-emoji emoji-id="5226929552319594190">🔢</tg-emoji> <b>SL nhận:</b> ${data.quantity}  |  <tg-emoji emoji-id="5287231198098117669">💰</tg-emoji> <b>Tổng:</b> ${this.fmt(data.total)}đ`,
                bonusLine,
                `<tg-emoji emoji-id="6197489709065704487">💳</tg-emoji> <b>SD còn lại:</b> ${this.fmt(data.remainingBalance)}đ`,
                this.UI.SEP,
                `<tg-emoji emoji-id="6084365261241062593">🔑</tg-emoji> <b>Tài khoản bàn giao:</b>`,
                itemsCombined,
                data.code ? `\n<tg-emoji emoji-id="5323479695579163583">📑</tg-emoji> <b>Mã đơn:</b> <code>${data.code}</code>` : '',
            ].filter(Boolean).join('\n');

            try {
                if (data.ctx) {
                    await data.ctx.reply(msg, { parse_mode: 'HTML', reply_markup: keyboard });
                } else {
                    await this.notifyUser(data.tenantId, data.telegramId, msg, { parse_mode: 'HTML', reply_markup: keyboard });
                }
            } catch (sendErr: any) {
                logger.error(`[Delivery] sendSuccessDelivery fallback triggered: ${sendErr.message}`);
                const fallbackMsg = `✅ <b>Giao dịch thành công #${data.code || data.orderId}</b>\nSP: ${data.productName} (SL: ${data.quantity})\n<i>Chi tiết tài khoản được đính kèm file bên dưới.</i>`;
                if (data.ctx) {
                    await data.ctx.reply(fallbackMsg, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
                } else {
                    await this.notifyUser(data.tenantId, data.telegramId, fallbackMsg, { parse_mode: 'HTML', reply_markup: keyboard });
                }
                await this.deliveryAsFile(fakeDocCtx, data.orderId, data.items);
            }
        }
    }

    // --- Action Handlers: Deposits & QR ---
    private async handleDirectDeposit(ctx: any, tgId: string, amount: number) {
        const user = await this.getUser(ctx.tenantId, tgId);
        if (!user) return ctx.reply('❌ Bạn chưa liên kết tài khoản.');

        const code = this.genId();
        const desc = code; // Chỉ dùng mã random, không có prefix nap-/mua-
        await pool.execute(`INSERT INTO ${TABLES.DEPOSIT_REQUESTS} (tenant_id, customer_id, amount, payment_code) VALUES (?, ?, ?, ?)`, [ctx.tenantId, user.id, amount, code]);

        const loader = await ctx.reply(`${this.UI.WAITING} **ĐANG TẠO MÃ QR...**\nSố tiền: ${this.fmt(amount)}đ`, { parse_mode: 'Markdown' });

        const config = ctx.config;
        const bankNum = config?.bank_num || '';
        await this.sendPhotoWithFallback(ctx, this.qr(ctx, amount, desc), {
            caption: `✅ **QR NẠP TIỀN**\n💰 Số tiền: ${this.fmt(amount)}đ\n📝 Nội dung: \`${desc}\``,
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: `📝 Copy ND: ${desc}`, copy_text: { text: desc } } as any,
                        { text: `💰 Copy ${this.fmt(amount)}đ`, copy_text: { text: amount.toString() } } as any
                    ],
                    bankNum ? [{ text: `🏦 Copy STK: ${bankNum}`, copy_text: { text: bankNum } } as any] : []
                ].filter(r => r.length > 0)
            }
        });

        this.deleteMsg(ctx, loader.message_id);
        // Note: Cập nhật message_id để cleanup sau này nếu cần
        await pool.execute(`UPDATE ${TABLES.DEPOSIT_REQUESTS} SET status = 'pending' WHERE payment_code = ? AND tenant_id = ?`, [code, ctx.tenantId]);
    }

    private async fetchAndConvertImage(url: string): Promise<Buffer> {
        const response = await axios.get(url, {
            httpsAgent: ipv4HttpsAgent,
            responseType: 'arraybuffer',
            timeout: 10000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'image/png,image/svg+xml,image/*;q=0.9,*/*;q=0.8'
            }
        } as any);

        let buffer = Buffer.from(response.data as any);
        const header = buffer.toString('utf8', 0, 100).toLowerCase();
        if (header.includes('<svg') || (response.headers['content-type'] && response.headers['content-type'].includes('svg'))) {
            buffer = await sharp(buffer).png().toBuffer();
        }
        return buffer;
    }

    private async sendPhotoWithFallback(ctx: any, url: string, options: any) {
        try {
            // Đối với VietQR (hoặc SVG): VietQR hiện redirect sang SVG.
            // Telegram Bot API không hỗ trợ SVG qua sendPhoto URL và sẽ báo lỗi 400:
            // "failed to get HTTP URL content" hoặc "IMAGE_PROCESS_FAILED".
            // Do đó: Server tải về trực tiếp qua IPv4, chuyển đổi SVG sang PNG bằng sharp rồi gửi buffer ảnh.
            if (url.includes('vietqr.io') || url.endsWith('.svg')) {
                const buffer = await this.fetchAndConvertImage(url);
                return await ctx.replyWithPhoto({ source: buffer, filename: 'vietqr.png' }, options);
            }

            // Với các nguồn ảnh khác: Thử gửi trực tiếp qua URL
            try {
                return await ctx.replyWithPhoto(url, options);
            } catch (err: any) {
                logger.warn(`⚠️ [Telegram] sendPhotoWithFallback (URL failed): ${err.message}. Falling back to download.`);
                const buffer = await this.fetchAndConvertImage(url);
                return await ctx.replyWithPhoto({ source: buffer, filename: 'photo.png' }, options);
            }
        } catch (err2: any) {
            logger.error(`❌ [Telegram] sendPhotoWithFallback (download/convert failed): ${err2.message}. Sending text fallback.`);
            // Dự phòng cuối: Gửi link text nếu cả tải ảnh lẫn convert đều lỗi
            const text = `${options.caption}\n\n🔗 **Link QR:** ${url}`;
            return await ctx.reply(text, {
                parse_mode: options.parse_mode || 'HTML',
                reply_markup: options.reply_markup
            });
        }
    }

    private async handleGenQRFlow(ctx: any, tgId: string, data: string) {
        try {
            const parts = data.split('_');
            const amount = parseInt(parts[1]);
            const productId = parts[2] || null;
            const qty = parts[3] ? parseInt(parts[3]) : 1;
            // parts[4] = comboId (optional, encoded từ handlePurchaseConfirmation)
            const comboId = parts[4] ? parseInt(parts[4]) : null;

            const user = await this.getUser(ctx.tenantId, tgId);
            const lang = user?.language || 'vi';
            if (!user) return ctx.reply('❌ Vui lòng sử dụng /menu trước.');

            if (productId && amount < 3000) {
                const errorMsg = lang === 'en' 
                    ? '❌ Minimum order for QR payment is 3,000 VND. Please deposit to your wallet to purchase.' 
                    : '❌ Đơn hàng dưới 3k vui lòng nạp tiền vào ví để thanh toán.';
                if (ctx.callbackQuery) {
                    return ctx.answerCbQuery(errorMsg, { show_alert: true });
                } else {
                    return ctx.reply(errorMsg);
                }
            }

            // Nếu là mua hàng (có productId), xác định bonus_qty từ combo và kiểm tra kho
            let bonusQty = 0;
            let isDealerPrice = false;

            if (productId) {
                // Tính bonus nếu có combo
                if (comboId) {
                    const [comboRows]: any = await pool.execute(
                        `SELECT * FROM ${TABLES.PRODUCT_COMBOS} WHERE id = ? AND tenant_id = ? AND is_active = 1`,
                        [comboId, ctx.tenantId]
                    );
                    if (comboRows && comboRows.length > 0 && comboRows[0].type === 'bonus') {
                        bonusQty = comboRows[0].bonus_qty || 0;
                    }
                }

                const totalNeeded = qty + bonusQty;
                const [pRowCheck]: any = await pool.execute(`SELECT is_api_product, api_stock FROM ${TABLES.PRODUCTS} WHERE id = ? AND tenant_id = ?`, [productId, ctx.tenantId]);
                let availableStock = 0;
                if (pRowCheck?.[0]?.is_api_product === 1) {
                    availableStock = parseInt(pRowCheck[0].api_stock || 0);
                } else {
                    const [stockCheck]: any = await pool.execute(`
                        SELECT COUNT(id) as stock FROM ${TABLES.PRODUCT_ITEMS} 
                        WHERE product_id = ? AND is_sold = 0 AND tenant_id = ?
                        AND (reserved_until IS NULL OR reserved_until < NOW())
                    `, [productId, ctx.tenantId]);
                    availableStock = parseInt(stockCheck[0]?.stock || 0);
                }

                if (availableStock < totalNeeded) {
                    return this.safeAnswerCb(ctx, i18n.t(lang, 'error_just_out', { stock: availableStock, needed: totalNeeded }), { show_alert: true });
                }

                let dealerRows: any = [];
                if (user && user.is_dealer) {
                    [dealerRows] = await pool.execute(`SELECT price FROM ${TABLES.DEALER_PRICES} WHERE customer_id = ? AND product_id = ? AND tenant_id = ? LIMIT 1`, [user.id, productId, ctx.tenantId]);
                }
                if (dealerRows && dealerRows.length > 0) isDealerPrice = true;

                // === TẠM GIỮ SLOT cho QR (5 phút) ===
                await this.reserveStock(ctx.tenantId, parseInt(productId), totalNeeded, `qr_${user.id}`, 5);
            }

            const code = this.genId();
            const desc = code;

            // Lưu deposit_request kèm combo_id và bonus_qty
            await pool.execute(
                `INSERT INTO ${TABLES.DEPOSIT_REQUESTS} (tenant_id, customer_id, product_id, quantity, combo_id, bonus_qty, amount, payment_code) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [ctx.tenantId, user.id, productId, qty, comboId, bonusQty || null, amount, code]
            );

            await ctx.answerCbQuery?.('🚀 Đang gửi mã QR...');

            // Dòng thông tin combo trong caption QR
            const comboCaption = bonusQty > 0 ? `\n<tg-emoji emoji-id="5445408903670022363">🎁</tg-emoji> <i>Combo: Tặng ${bonusQty} acc (nhận ${qty + bonusQty} acc)</i>` : '';

            const config = ctx.config;
            const bankNum = config?.bank_num || '';
            const copyRows: any[][] = [
                [
                    { text: `📝 Copy ND: ${desc}`, copy_text: { text: desc } } as any,
                    { text: `💰 Copy ${this.fmt(amount)}đ`, copy_text: { text: amount.toString() } } as any
                ]
            ];
            if (bankNum) {
                copyRows.push([{ text: `🏦 Copy STK: ${bankNum}`, copy_text: { text: bankNum } } as any]);
            }
            copyRows.push([
                { text: '⚡ Đã chuyển tiền (Kiểm tra ngay)', callback_data: `checkqr_${code}` }
            ]);
            copyRows.push([{ text: i18n.t(lang, 'btn_cancel_order'), callback_data: `cancelqr_${code}` }]);

            await this.sendPhotoWithFallback(ctx, this.qr(ctx, amount, desc), {
                caption: [
                    i18n.t(lang, 'qr_invoice_title', { type: productId ? i18n.t(lang, 'qr_invoice_buy') : i18n.t(lang, 'qr_invoice_deposit') }),
                    i18n.t(lang, 'qr_invoice_money', { amount: this.fmt(amount), dealer: isDealerPrice ? i18n.t(lang, 'qr_invoice_dealer') : '', combo: comboCaption }),
                    i18n.t(lang, 'qr_invoice_content', { desc: desc }),
                    '',
                    i18n.t(lang, 'qr_invoice_note')
                ].join('\n'),
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: copyRows }
            });

            this.deleteMsg(ctx);
        } catch (err: any) {
            logger.error(`[Tenant ${ctx.tenantId}] handleGenQRFlow error: ${err.message}`);
        }
    }

    private async handleCheckQRFlow(ctx: any, data: string) {
        try {
            const code = data.split('_')[1];
            if (!code) {
                return this.safeAnswerCb(ctx, 'Mã giao dịch không hợp lệ.', true);
            }

            // Kích hoạt ngay một lượt quét kiểm tra tức thì
            const { bankService } = await import('./bank.service');
            bankService.syncAllBanks().catch(() => {});

            // Kiểm tra trạng thái đơn
            const [rows]: any = await pool.execute(
                `SELECT status FROM ${TABLES.DEPOSIT_REQUESTS} WHERE payment_code = ? AND tenant_id = ? LIMIT 1`,
                [code, ctx.tenantId]
            );

            if (!rows.length) {
                return this.safeAnswerCb(ctx, 'Không tìm thấy yêu cầu này.', true);
            }

            const req = rows[0];
            if (req.status === 'success') {
                return this.safeAnswerCb(ctx, '✅ Đã nhận được thanh toán! Đơn hàng đang được bàn giao...', true);
            }
            if (req.status === 'failed') {
                return this.safeAnswerCb(ctx, '❌ Đơn hàng này đã bị hủy hoặc hết hạn.', true);
            }

            return this.safeAnswerCb(ctx, '⏳ Đang quét giao dịch ACB liên tục (1.5s). Bot sẽ tự động gửi tài khoản ngay khi tiền vào!', true);
        } catch (err: any) {
            logger.error(`[Tenant ${ctx.tenantId}] handleCheckQRFlow error: ${err.message}`);
            return this.safeAnswerCb(ctx, 'Đang kiểm tra giao dịch...', true);
        }
    }

    private async handleCancelQRFlow(ctx: any, data: string) {
        const tgId = ctx.from.id.toString();
        const user = await this.getUser(ctx.tenantId, tgId);
        const lang = user?.language || 'vi';
        
        const code = data.split('_')[1];
        // Lấy thông tin đơn trước khi hủy để giải phóng reservation
        const [reqRows]: any = await pool.execute(
            `SELECT product_id, quantity, bonus_qty FROM ${TABLES.DEPOSIT_REQUESTS} WHERE payment_code = ? AND tenant_id = ? AND status = 'pending'`,
            [code, ctx.tenantId]
        );
        const [res] = await pool.execute(`UPDATE ${TABLES.DEPOSIT_REQUESTS} SET status = "failed" WHERE payment_code = ? AND tenant_id = ? AND status = "pending"`, [code, ctx.tenantId]) as any;
        if (res.affectedRows > 0) {
            // Giải phóng reserved slots khi hủy QR
            if (reqRows.length > 0 && reqRows[0].product_id && user) {
                const totalNeeded = (reqRows[0].quantity || 0) + (reqRows[0].bonus_qty || 0);
                await this.releaseReservation(ctx.tenantId, reqRows[0].product_id, `qr_${user.id}`, totalNeeded).catch(() => {});
            }
            this.deleteMsg(ctx);
            return ctx.reply(i18n.t(lang, 'order_cancelled', { code: code }), { reply_markup: { inline_keyboard: [[{ text: i18n.t(lang, 'btn_back'), callback_data: 'menu', icon_custom_emoji_id: '6086673312241424329' } as any]] } });
        }
        return ctx.answerCbQuery(i18n.t(lang, 'cannot_cancel'), { show_alert: true });
    }

    private async handleUSDTDepositAction(ctx: any, tgId: string) {
        const user = await this.getUser(ctx.tenantId, tgId);
        const lang = user?.language || 'vi';
        
        const msg = i18n.t(lang, 'deposit_choose_amount');
        const keyboard = {
            inline_keyboard: [
                [{ text: '2 USDT', callback_data: 'genusdt_2' }, { text: '5 USDT', callback_data: 'genusdt_5' }],
                [{ text: '10 USDT', callback_data: 'genusdt_10' }, { text: '20 USDT', callback_data: 'genusdt_20' }],
                [{ text: '50 USDT', callback_data: 'genusdt_50' }, { text: '100 USDT', callback_data: 'genusdt_100' }],
                [{ text: i18n.t(lang, 'btn_back'), callback_data: 'deposit', icon_custom_emoji_id: '6086673312241424329' } as any]
            ]
        };

        if (ctx.callbackQuery) {
            await ctx.answerCbQuery?.();
            return await ctx.editMessageText(msg, { parse_mode: 'HTML', reply_markup: keyboard });
        } else {
            return await ctx.reply(msg, { parse_mode: 'HTML', reply_markup: keyboard });
        }
    }

    private async handleGenUSDTFlow(ctx: any, tgId: string, data: string) {
        try {
            const parts = data.split('_');
            const isPurchase = parts.length >= 4;
            let usdtAmount = 0;
            let amountVnd = 0;
            let productId = null;
            let qty = 1;
            let comboId = null;

            const [configs]: any = await pool.execute(
                `SELECT usdt_wallet_address, usdt_network, usdt_exchange_rate, binance_pay_id FROM ${TABLES.BOT_CONFIGS} WHERE tenant_id = ? AND status = "published"`, 
                [ctx.tenantId]
            );
            
            const user = await this.getUser(ctx.tenantId, tgId);
            const lang = user?.language || 'vi';

            if (!configs || configs.length === 0 || !configs[0].usdt_wallet_address) {
                return ctx.answerCbQuery(i18n.t(lang, 'usdt_not_configured'), { show_alert: true });
            }

            const config = configs[0];
            const exchangeRate = parseFloat(config.usdt_exchange_rate) || 25500;

            if (isPurchase) {
                // genusdt_{totalVnd}_{productId}_{qty}_{comboId}
                amountVnd = parseInt(parts[1]);
                productId = parts[2] || null;
                qty = parts[3] ? parseInt(parts[3]) : 1;
                comboId = parts[4] ? parseInt(parts[4]) : null;

                let usdPrice = 0;
                let activePrice = 0;
                let activePriceUsd = null;
                const [prodRows] = await pool.execute(`SELECT price, price_usd FROM ${TABLES.PRODUCTS} WHERE id = ? AND tenant_id = ?`, [productId, ctx.tenantId]) as any;
                if (prodRows.length) {
                    activePrice = prodRows[0].price;
                    activePriceUsd = prodRows[0].price_usd;

                    if (user && user.is_dealer) {
                        const [dealerRows]: any = await pool.execute(
                            `SELECT price, price_usd FROM ${TABLES.DEALER_PRICES} WHERE customer_id = ? AND product_id = ? AND tenant_id = ? LIMIT 1`,
                            [user.id, productId, ctx.tenantId]
                        );
                        if (dealerRows && dealerRows.length > 0) {
                            if (dealerRows[0].price !== null && dealerRows[0].price !== undefined) {
                                activePrice = dealerRows[0].price;
                            } else if (dealerRows[0].price_usd !== null && dealerRows[0].price_usd !== undefined) {
                                activePriceUsd = dealerRows[0].price_usd;
                                activePrice = Math.round(activePriceUsd * exchangeRate);
                            }
                        }
                    }

                    if (activePriceUsd && parseFloat(activePriceUsd) > 0) {
                        usdPrice = parseFloat(activePriceUsd);
                    } else {
                        usdPrice = (activePrice / exchangeRate) * 1.02; // 2% fee
                    }
                }
                
                let totalUsd = usdPrice * qty;
                if (activePrice > 0 && (activePrice * qty) > 0) {
                    totalUsd = totalUsd * (amountVnd / (activePrice * qty));
                }
                usdtAmount = totalUsd || (amountVnd / exchangeRate);
            } else {
                // genusdt_{usdt}
                usdtAmount = parseFloat(parts[1]);
                amountVnd = usdtAmount * exchangeRate;
            }

            if (!user) return ctx.reply(i18n.t(lang, 'use_menu_first'));

            // Đảm bảo usdtAmount sinh ra là ĐỘC NHẤT (không trùng với các request pending hoặc trong 2 giờ gần nhất)
            // Sinh 4 chữ số thập phân (e.g. 23.8845) để tương thích hoàn toàn với Binance Pay và ví On-Chain, tránh bị app/sàn làm tròn hoặc cắt bớt chữ số thứ 5
            let isUnique = false;
            let attempts = 0;
            const baseUsdtAmount = parseFloat(usdtAmount.toFixed(2));
            while (!isUnique && attempts < 30) {
                const fraction = (Math.floor(Math.random() * 900) + 100) / 10000; // e.g. 0.0100 đến 0.0999 (4 số thập phân)
                usdtAmount = parseFloat((baseUsdtAmount + fraction).toFixed(4));

                const [checkRows]: any = await pool.execute(
                    `SELECT id FROM ${TABLES.DEPOSIT_REQUESTS} 
                     WHERE tenant_id = ? 
                       AND (status = 'pending' OR created_at >= NOW() - INTERVAL 2 HOUR) 
                       AND usdt_amount = ?`,
                    [ctx.tenantId, usdtAmount]
                );
                
                if (!checkRows || checkRows.length === 0) {
                    isUnique = true;
                }
                attempts++;
            }

            const code = this.genId();

            // Reserve stock cho USDT payment (5 phút)
            if (isPurchase && productId) {
                const [comboRowsCheck]: any = comboId ? await pool.execute(
                    `SELECT bonus_qty FROM ${TABLES.PRODUCT_COMBOS} WHERE id = ? AND type = 'bonus' AND is_active = 1`, [comboId]
                ) : [[]]; 
                const bonusCheck = comboRowsCheck?.[0]?.bonus_qty || 0;
                const totalNeededUsdt = qty + bonusCheck;
                // Check stock available before reserve
                const [pRowUsdt]: any = await pool.execute(`SELECT is_api_product, api_stock FROM ${TABLES.PRODUCTS} WHERE id = ? AND tenant_id = ?`, [productId, ctx.tenantId]);
                let availableStockUsdt = 0;
                if (pRowUsdt?.[0]?.is_api_product === 1) {
                    availableStockUsdt = parseInt(pRowUsdt[0].api_stock || 0);
                } else {
                    const [stockCheckUsdt]: any = await pool.execute(
                        `SELECT COUNT(id) as stock FROM ${TABLES.PRODUCT_ITEMS} WHERE product_id = ? AND is_sold = 0 AND tenant_id = ? AND (reserved_until IS NULL OR reserved_until < NOW())`,
                        [productId, ctx.tenantId]
                    );
                    availableStockUsdt = parseInt(stockCheckUsdt[0]?.stock || 0);
                }
                if (availableStockUsdt < totalNeededUsdt) {
                    const lang2 = user?.language || 'vi';
                    return this.safeAnswerCb(ctx, i18n.t(lang2, 'error_just_out', { stock: availableStockUsdt, needed: totalNeededUsdt }), { show_alert: true });
                }
                if (!pRowUsdt?.[0]?.is_api_product) {
                    await this.reserveStock(ctx.tenantId, parseInt(productId), totalNeededUsdt, `usdt_${user.id}`, 5);
                }
            }

            await pool.execute(
                `INSERT INTO ${TABLES.DEPOSIT_REQUESTS} (tenant_id, customer_id, product_id, quantity, combo_id, amount, usdt_amount, payment_code) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [ctx.tenantId, user.id, productId, qty, comboId, amountVnd, usdtAmount, code]
            );

            await ctx.answerCbQuery?.(i18n.t(lang, 'creating_usdt_order'));

            // ĐỊA CHỈ VÍ USDT CỐ ĐỊNH - KHÔNG THAY ĐỔI
            const FIXED_USDT_WALLET = '0x7a02f34f89bc01d76303ff87c56d3eb4f08fed1d';
            const binanceId = config.binance_pay_id || '1076336156';

            const msg = [
                i18n.t(lang, 'usdt_invoice_title'),
                i18n.t(lang, 'usdt_invoice_vnd', { amount: this.fmt(amountVnd) }),
                i18n.t(lang, 'usdt_invoice_amount'),
                `<pre><code>${usdtAmount.toFixed(4)}</code></pre>`,
                ``,
                i18n.t(lang, 'usdt_invoice_methods', {
                    binanceId: binanceId,
                    network: config.usdt_network || 'BSC',
                    wallet: FIXED_USDT_WALLET
                }),
                ``,
                i18n.t(lang, 'usdt_invoice_note'),
                ``,
                i18n.t(lang, 'usdt_invoice_security_warning', {
                    binanceId: binanceId,
                    network: config.usdt_network || 'BSC',
                    wallet: FIXED_USDT_WALLET
                })
            ].join('\n');

            const usdtStr = usdtAmount.toFixed(4);
            const copyAmountText = lang === 'en' ? `📋 Copy Amount: ${usdtStr} USDT` : `📋 Copy Số tiền: ${usdtStr} USDT`;
            const copyBinanceText = lang === 'en' ? `💸 Copy Binance ID` : `💸 Copy ID Binance`;
            const copyWalletText = lang === 'en' ? `🏦 Copy BSC Wallet` : `🏦 Copy Ví BSC`;

            await ctx.reply(msg, {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: copyAmountText, copy_text: { text: usdtStr } } as any
                        ],
                        [
                            { text: copyBinanceText, copy_text: { text: binanceId } } as any,
                            { text: copyWalletText, copy_text: { text: FIXED_USDT_WALLET } } as any
                        ],
                        [
                            { text: i18n.t(lang, 'btn_cancel_order'), callback_data: `cancelqr_${code}` }
                        ]
                    ]
                }
            });

            this.deleteMsg(ctx);
        } catch (err: any) {
            logger.error(`[Tenant ${ctx.tenantId}] handleGenUSDTFlow error: ${err.message}`);
        }
    }

    // --- View Generators ---
    public async sendMenu(ctx: any, keepMsg: boolean = false) {
        const tgId = ctx.from.id.toString();
        const user = await this.getUser(ctx.tenantId, tgId);

        const lang = user?.language || 'vi';

        const [rows] = await pool.execute(`
            SELECT p.id, p.name, p.name_en, p.icon, p.price as retail_price, p.price_usd,
                   p.is_api_product, p.api_stock,
                   CASE WHEN p.is_api_product = 1 THEN p.api_stock ELSE COUNT(DISTINCT CASE WHEN pi.is_sold = 0 THEN pi.id END) END as stock
            FROM ${TABLES.PRODUCTS} p
            LEFT JOIN ${TABLES.PRODUCT_ITEMS} pi ON p.id = pi.product_id AND pi.tenant_id = p.tenant_id
            WHERE p.status = 'published' AND p.tenant_id = ?
            GROUP BY p.id
            ORDER BY p.name ASC
        `, [ctx.tenantId]) as any;

        const [configRows]: any = await pool.execute(`SELECT usdt_exchange_rate FROM ${TABLES.BOT_CONFIGS} WHERE tenant_id = ?`, [ctx.tenantId]);
        const usdtRate = configRows[0]?.usdt_exchange_rate || 26000;

        let priceMap = new Map();
        if (user && user.is_dealer) {
            const [dealerPrices]: any = await pool.execute(`SELECT product_id, price, price_usd FROM ${TABLES.DEALER_PRICES} WHERE customer_id = ? AND tenant_id = ?`, [user.id, ctx.tenantId]);
            priceMap = new Map(dealerPrices.map((p: any) => [p.product_id, p]));
        }

        let msg = `<tg-emoji emoji-id="5312361253610475399">🛒</tg-emoji> <b>${i18n.t(lang, 'menu_products').replace('🛒 ', '')}</b>\n${this.UI.SEP}\n\n`;
        const buttons = [];

        if (rows.length === 0) {
            msg += `❌ ${i18n.t(lang, 'product_deleted')}`;
        } else {
            const productButtons = [];
            rows.forEach((p: any, i: number) => {
                const isOutOfStock = parseInt(p.stock) === 0;
                const pName = lang === 'en' && p.name_en ? p.name_en : p.name;

                // Lấy thông tin kho
                const statusText = isOutOfStock ? i18n.t(lang, 'out_of_stock_status') : i18n.t(lang, 'stock_status', { stock: p.stock });
                
                // Tự động gán icon dự phòng nếu DB trống (Dùng icon giỏ hàng Premium làm mặc định)
                let fallbackIcon = isOutOfStock ? '5210952531676504517' : '5312361253610475399';
                const nameLower = p.name.toLowerCase();
                if (!isOutOfStock) {
                    if (nameLower.includes('grok')) fallbackIcon = '✖️';
                    if (nameLower.includes('meitu')) fallbackIcon = '🔴';
                    if (nameLower.includes('claude')) fallbackIcon = '🌿';
                    if (nameLower.includes('gpt') || nameLower.includes('chat')) fallbackIcon = '⚡';
                    if (nameLower.includes('netflix')) fallbackIcon = '🎥';
                    if (nameLower.includes('office') || nameLower.includes('microsoft')) fallbackIcon = '🟦';
                    if (nameLower.includes('premium')) fallbackIcon = '💎';
                    if (nameLower.includes('vip')) fallbackIcon = '🌟';
                }

                // Xử lý hiển thị Emoji trong tin nhắn (hỗ trợ cả Unicode thường và Custom Emoji ID)
                let textIconHtml = '';
                if (isOutOfStock) {
                    textIconHtml = `<tg-emoji emoji-id="5210952531676504517">❌</tg-emoji>`;
                } else if (p.icon) {
                    if (/^\d+$/.test(p.icon.trim())) {
                        textIconHtml = `<tg-emoji emoji-id="${p.icon.trim()}">🤖</tg-emoji>`;
                    } else {
                        textIconHtml = p.icon.trim();
                    }
                } else {
                    if (/^\d+$/.test(fallbackIcon.trim())) {
                        textIconHtml = `<tg-emoji emoji-id="${fallbackIcon.trim()}">🤖</tg-emoji>`;
                    } else {
                        textIconHtml = fallbackIcon;
                    }
                }

                let activePrice = p.retail_price;
                let activePriceUsd = p.price_usd;
                let isDealerPrice = false;

                if (priceMap.has(p.id)) {
                    const dp: any = priceMap.get(p.id);
                    if (dp.price !== null && dp.price !== undefined) {
                        activePrice = dp.price;
                        isDealerPrice = true;
                    } else if (dp.price_usd !== null && dp.price_usd !== undefined) {
                        activePriceUsd = dp.price_usd;
                        activePrice = Math.round(activePriceUsd * usdtRate);
                        isDealerPrice = true;
                    }
                }

                let usdPrice = 0;
                if (activePriceUsd && parseFloat(activePriceUsd) > 0) {
                    usdPrice = parseFloat(activePriceUsd);
                } else {
                    usdPrice = (activePrice / usdtRate) * 1.02; // 2% fee
                }
                const priceStrUsd = `$${usdPrice.toFixed(2)}`;
                const dealerTag = isDealerPrice ? (lang === 'en' ? ' <i>(Reseller)</i>' : ' <i>(CTV)</i>') : '';

                // Định dạng dòng hiển thị trong tin nhắn
                msg += `${i + 1}. ${textIconHtml} ${pName} — ${this.fmt(activePrice)}đ (${priceStrUsd})${dealerTag}${statusText}\n`;

                const priceK = activePrice >= 1000 ? `${activePrice / 1000}k` : `${activePrice}đ`;
                const priceStr = `${priceK}`;

                // Định dạng nút bấm mua hàng
                const buttonObj: any = {
                    text: `${pName} | ${priceStr}` + (isOutOfStock ? ' [HẾT HÀNG]' : ''),
                    callback_data: isOutOfStock ? `notify_out_of_stock` : `buy_${p.id}`,
                    style: isOutOfStock ? 'danger' : 'success'
                };

                if (isOutOfStock) {
                    buttonObj.icon_custom_emoji_id = '5210952531676504517';
                } else if (p.icon) {
                    if (/^\d+$/.test(p.icon.trim())) {
                        // Nếu là Custom Emoji ID dạng số -> Truyền vào thuộc tính icon_custom_emoji_id cho nút bấm Telegram
                        buttonObj.icon_custom_emoji_id = p.icon.trim();
                    } else {
                        // Nếu là Unicode Emoji thường -> Ghép thẳng vào đầu chữ của nút
                        buttonObj.text = `${p.icon.trim()} ${buttonObj.text}`;
                    }
                } else {
                    if (/^\d+$/.test(fallbackIcon.trim())) {
                        buttonObj.icon_custom_emoji_id = fallbackIcon.trim();
                    } else {
                        buttonObj.text = `${fallbackIcon} ${buttonObj.text}`;
                    }
                }

                productButtons.push(buttonObj);
            });

            // Mỗi sản phẩm 1 hàng cho dễ nhìn
            productButtons.forEach(btn => buttons.push([btn]));

            msg += `\n${this.UI.SEP}\n`;
            msg += `\n<tg-emoji emoji-id="5463392464314315076">👉</tg-emoji> <b>${i18n.t(lang, 'choose_payment').replace('👉 ', '')}</b>`; // close enough
        }

        // Nút chức năng ở cuối
        buttons.push([{
            text: i18n.t(lang, 'btn_deposit').replace(/^[\p{Emoji_Presentation}\p{Extended_Pictographic}]\s*/u, ''),
            callback_data: 'deposit',
            icon_custom_emoji_id: '5170194808160912299'
        } as any]);
        buttons.push([{ text: i18n.t(lang, 'btn_history'), callback_data: 'history' }, { text: i18n.t(lang, 'menu_profile'), callback_data: 'balance' }]);
        buttons.push([{
            text: i18n.t(lang, 'menu_api').replace(/^[\p{Emoji_Presentation}\p{Extended_Pictographic}]\s*/u, ''),
            callback_data: 'get_api',
            icon_custom_emoji_id: '5465443379917629504'
        } as any]);
        buttons.push([{
            text: 'Tham gia Group',
            url: 'https://t.me/+Z43dsALfC11kMTdl',
            icon_custom_emoji_id: '5364125616801073577'
        } as any]);

        const options = { reply_markup: { inline_keyboard: buttons }, parse_mode: 'HTML' as const };
        if (ctx.callbackQuery && !keepMsg) {
            return ctx.editMessageText(msg, options);
        } else {
            return ctx.reply(msg, options);
        }
    }

    public async sendHistory(ctx: any, page: number = 1) {
        const user = await this.getUser(ctx.tenantId, ctx.from.id.toString());
        const lang = user?.language || 'vi';
        const limit = 5;
        const offset = (page - 1) * limit;

        try {
            if (!user) return ctx.reply('❌ Bạn chưa có tài khoản.');

            const [countRes] = await pool.execute(`SELECT COUNT(*) as total FROM ${TABLES.BALANCE_LOGS} WHERE customer_id = ? AND tenant_id = ?`, [user.id, ctx.tenantId]) as any;
            const totalItems = countRes[0].total;
            const totalPages = Math.ceil(totalItems / limit) || 1;

            if (page > totalPages) page = totalPages;

            const [history] = await pool.execute(`SELECT order_id, type, amount, note as description, created_at FROM ${TABLES.BALANCE_LOGS} WHERE customer_id = ? AND tenant_id = ? ORDER BY id DESC LIMIT ? OFFSET ?`, [user.id, ctx.tenantId, limit, offset]) as any;
            if (!history.length) return ctx.reply(i18n.t(lang, 'history_empty'));

            let msg = `${i18n.t(lang, 'history_title')}\n`;
            if (totalPages > 1) {
                msg += `<i>${i18n.t(lang, 'page_info', { current: page, total: totalPages })}</i>\n`;
            }
            msg += `${this.UI.SEP}\n\n`;

            const inline_keyboard: any[] = [];
            
            for (const t of history) {
                const dateStr = t.created_at ? new Date(t.created_at).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', timeZone: 'Asia/Ho_Chi_Minh' }) : 'Gần đây';
                const isDeposit = (t.type === 'deposit' || t.type === 'IN');
                const sign = isDeposit ? '+' : '-';

                if (isDeposit) {
                    msg += `<tg-emoji emoji-id="5287231198098117669">💰</tg-emoji> <b>${sign}${this.fmt(t.amount)}đ</b> | <i>${dateStr}</i>\n`;
                    msg += `<tg-emoji emoji-id="6084365261241062593">📝</tg-emoji> ${t.description}\n`;
                } else {
                    // Parse payment code từ note: "Mua X x Product [CODE]" (bot) hoặc "Mua X x Product @ price (API)"
                    const codeMatch = t.description.match(/\[([A-Z0-9]{4,8})\]$/);
                    const displayCode = codeMatch ? codeMatch[1] : null;
                    // Xóa suffix [CODE] hoặc @ price... (API format)
                    const cleanDesc = t.description.replace(/\s*\[[A-Z0-9]{4,8}\]$/, '').replace(/\s*@[\s\S]*$/, '');

                    msg += `<tg-emoji emoji-id="5226929552319594190">🛒</tg-emoji> <b>${sign}${this.fmt(t.amount)}đ</b> | <i>${dateStr}</i>\n`;
                    if (displayCode) {
                        msg += `<tg-emoji emoji-id="5323479695579163583">📑</tg-emoji> <b>Mã đơn:</b> <code>${displayCode}</code>\n`;
                    } else if (t.order_id) {
                        // Lấy order code từ DB nếu không parse được từ note
                        try {
                            const [orderCodeRows]: any = await pool.execute(`SELECT code FROM telehub_orders WHERE id = ? LIMIT 1`, [t.order_id]);
                            const oCode = orderCodeRows?.[0]?.code;
                            if (oCode) {
                                msg += `<tg-emoji emoji-id="5323479695579163583">📑</tg-emoji> <b>Mã đơn:</b> <code>${oCode}</code>\n`;
                            } else {
                                msg += `<tg-emoji emoji-id="5323479695579163583">📑</tg-emoji> <b>Mã đơn:</b> #${t.order_id}\n`;
                            }
                        } catch { msg += `<tg-emoji emoji-id="5323479695579163583">📑</tg-emoji> <b>Mã đơn:</b> #${t.order_id}\n`; }
                    }
                    const productName = cleanDesc.replace(/^Mua \d+ x /, '');
                    const qtyMatch = cleanDesc.match(/^Mua (\d+) x/);
                    if (productName) msg += i18n.t(lang, 'history_product', { name: productName }) + '\n';
                    if (qtyMatch?.[1]) msg += i18n.t(lang, 'history_quantity', { qty: qtyMatch[1] }) + '\n';

                    if (t.order_id) {
                        const orderCode = displayCode ? displayCode : `#${t.order_id}`;
                        inline_keyboard.push([{ text: i18n.t(lang, 'btn_view_order', { id: orderCode }), callback_data: `history_order:${t.order_id}` }]);
                    }
                }

                msg += `\n${this.UI.SEP}\n\n`;
            }

            const paginationRow = [];
            if (page > 1) {
                paginationRow.push({ text: i18n.t(lang, 'btn_prev_page'), callback_data: `history_page:${page - 1}` });
            }
            if (page < totalPages) {
                paginationRow.push({ text: i18n.t(lang, 'btn_next_page'), callback_data: `history_page:${page + 1}` });
            }
            if (paginationRow.length > 0) inline_keyboard.push(paginationRow);
            inline_keyboard.push([{ text: i18n.t(lang, 'btn_back'), callback_data: 'balance', icon_custom_emoji_id: '6086673312241424329' } as any]);

            if (ctx.callbackQuery) {
                return await ctx.editMessageText(msg, { parse_mode: 'HTML', reply_markup: { inline_keyboard } });
            } else {
                return await ctx.reply(msg, { parse_mode: 'HTML', reply_markup: { inline_keyboard } });
            }
        } catch (err: any) {
            logger.error(`[Tenant ${ctx.tenantId}] sendHistory error: ${err.message}`);
        }
    }

    public async sendHistoryOrderDetail(ctx: any, orderId: number) {
        const user = await this.getUser(ctx.tenantId, ctx.from.id.toString());
        const lang = user?.language || 'vi';

        try {
            await ctx.answerCbQuery?.();
            if (!user) return ctx.reply('❌ Bạn chưa có tài khoản.');

            const [orderRows] = await pool.execute(
                `SELECT o.total_amount, o.code, o.created_at,
                        p.name as product_name, od.quantity, od.price
                 FROM telehub_orders o
                 LEFT JOIN telehub_order_details od ON od.order_id = o.id
                 LEFT JOIN telehub_products p ON p.id = od.product_id
                 WHERE o.id = ? AND o.tenant_id = ? AND o.customer_id = ?
                 LIMIT 1`,
                [orderId, ctx.tenantId, user.id]
            ) as any;
            if (!orderRows.length) return ctx.reply('❌ Không tìm thấy đơn hàng.');

            const order = orderRows[0];

            const [items] = await pool.execute(`SELECT username, password, note, content FROM ${TABLES.PRODUCT_ITEMS} WHERE order_id = ? AND tenant_id = ?`, [orderId, ctx.tenantId]) as any;
            if (!items || items.length === 0) {
                return ctx.reply('📭 Đơn hàng này không có tài khoản nào.', { reply_markup: { inline_keyboard: [[{ text: i18n.t(lang, 'btn_back'), callback_data: 'history' }]] } });
            }

            const formattedItems = items.map((i: any) => {
                // Ưu tiên content (dùng cho API order), sau đó mới username/password/note
                if (i.content && !i.username) {
                    return i.content.split('\n').map((line: string) => {
                        const trimmed = line.trim();
                        return trimmed.startsWith('http') ? trimmed : `<code>${trimmed}</code>`;
                    }).join('\n');
                }
                const accInfo = [i.username, i.password, i.note].filter(Boolean).join('\n');
                return accInfo.split('\n').map((line: string) => {
                    const trimmed = line.trim();
                    return trimmed.startsWith('http') ? trimmed : `<code>${trimmed}</code>`;
                }).join('\n');
            });

            const orderCode = order.code || `#${orderId}`;
            const orderDate = order.created_at ? new Date(order.created_at).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Asia/Ho_Chi_Minh' }) : '';
            let msg = `📦 <b>Chi tiết đơn hàng <code>${orderCode}</code></b>\n`;
            if (orderDate) msg += `🕒 <i>${orderDate}</i>\n`;
            if (order.product_name) {
                msg += `📦 <b>Sản phẩm:</b> ${order.product_name}\n`;
                if (order.quantity) msg += `🔢 <b>Số lượng:</b> ${order.quantity} acc\n`;
                if (order.price) msg += `💵 <b>Đơn giá:</b> ${this.fmt(order.price)}đ/acc\n`;
            }
            msg += `💳 <b>Tổng:</b> ${this.fmt(order.total_amount)}đ\n`;
            msg += `\n━━━━━━━━━━━━━━━━━━\n📑 <b>Tài khoản bàn giao:</b>\n\n`;

            if (formattedItems.length > 5) {
                msg += `<i>Do danh sách quá dài, hệ thống đã gửi kèm file txt cho bạn ở bên dưới.</i>`;
                await ctx.reply(msg, { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: i18n.t(lang, 'btn_back'), callback_data: 'history' }]] } });
                await this.deliveryAsFile(ctx, orderId, items.map((i: any) => (i.content || [i.username, i.password, i.note].filter(Boolean).join('\n'))));
            } else {
                msg += formattedItems.join('\n\n');
                await ctx.reply(msg, { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: i18n.t(lang, 'btn_back'), callback_data: 'history' }]] } });
            }
        } catch (err: any) {
            logger.error(`[Tenant ${ctx.tenantId}] sendHistoryOrderDetail error: ${err.message}`);
        }
    }

    // --- Business Logic ---
    public async handleDirectPurchase(
        tenantId: number,
        userId: number,
        productId: string,
        quantity: number,
        paymentCode?: string,
        bonusQty: number = 0,
        comboId?: number,
        reservedBy?: string  // Key reservation để ưu tiên lấy slot đã giữ
    ) {
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();
            const [u] = await conn.execute(`SELECT balance, is_dealer FROM ${TABLES.CUSTOMERS} WHERE id = ? AND tenant_id = ? FOR UPDATE`, [userId, tenantId]) as any;
            const [prodRows]: any = await conn.execute(`SELECT name, price, is_api_product, api_provider_id, api_product_id, api_stock, api_delivery_mode FROM ${TABLES.PRODUCTS} WHERE id = ? AND tenant_id = ?`, [productId, tenantId]);
            if (!prodRows || prodRows.length === 0) throw new Error('Không tìm thấy sản phẩm');
            const product = prodRows[0];

            const [configRows]: any = await conn.execute(`SELECT usdt_exchange_rate FROM ${TABLES.BOT_CONFIGS} WHERE tenant_id = ?`, [tenantId]);
            const usdtRate = configRows[0]?.usdt_exchange_rate || 26000;

            // Check for dealer price
            let activePrice = product.price;
            let dealerRows: any = [];
            if (u[0] && u[0].is_dealer) {
                [dealerRows] = await conn.execute(`SELECT price, price_usd FROM ${TABLES.DEALER_PRICES} WHERE customer_id = ? AND product_id = ? AND tenant_id = ? LIMIT 1`, [userId, productId, tenantId]);
            }
            if (dealerRows && dealerRows.length > 0) {
                if (dealerRows[0].price !== null && dealerRows[0].price !== undefined) {
                    activePrice = dealerRows[0].price;
                } else if (dealerRows[0].price_usd !== null && dealerRows[0].price_usd !== undefined) {
                    activePrice = Math.round(dealerRows[0].price_usd * usdtRate);
                }
            }

            if (!comboId) {
                const combos = await this.getActiveCombos(tenantId, productId);
                const bestCombo = this.getBestCombo(combos, quantity, activePrice);
                if (bestCombo) {
                    comboId = bestCombo.id;
                }
            }

            let effectiveTotal = activePrice * quantity;
            if (comboId) {
                const [comboRows]: any = await conn.execute(
                    `SELECT * FROM ${TABLES.PRODUCT_COMBOS} WHERE id = ? AND tenant_id = ? AND is_active = 1`,
                    [comboId, tenantId]
                );
                if (comboRows && comboRows.length > 0) {
                    const combo = comboRows[0];
                    const applied = this.applyCombo(combo, quantity, activePrice);
                    effectiveTotal = applied.total;
                    bonusQty = applied.bonusQty; // Always update bonusQty based on the active combo
                }
            }
            const total = effectiveTotal; // Tiền sau khi áp dụng combo

            // Tổng acc cần lấy từ kho (mua + tặng)
            const totalAccNeeded = quantity + bonusQty;

            if (parseFloat(u[0].balance) < total) throw new Error('Cạn số dư');

            // --- XỬ LÝ HÀNG TỰ ĐỘNG QUA API KHO SỈ (NẾU LÀ API PRODUCT) ---
            if (product.is_api_product === 1) {
                const [providers]: any = await conn.execute(
                    `SELECT * FROM ${TABLES.API_PROVIDERS} WHERE id = ? AND tenant_id = ? AND (status = 'active' OR status = 1 OR status = '1')`,
                    [product.api_provider_id, tenantId]
                );
                if (!providers || providers.length === 0) {
                    throw new Error('Nhà cung cấp API của sản phẩm này đang tạm dừng hoặc không tồn tại');
                }
                const provider = providers[0];

                const orderCode = paymentCode || ('API' + Math.random().toString(36).substring(2, 8).toUpperCase());
                const endpoint = provider.endpoint_orders || '/api/v2/orders';
                const orderUrl = provider.base_url.replace(/\/+$/, '') + '/' + endpoint.replace(/^\/+/, '');
                const authHeader = provider.header_name || 'X-API-Key';
                const headers: Record<string, string> = {
                    'Idempotency-Key': orderCode,
                    'x-idempotency-key': orderCode,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                };
                if (provider.auth_type === 'bearer') {
                    headers['Authorization'] = `Bearer ${provider.api_key}`;
                } else {
                    headers[authHeader] = provider.api_key;
                }

                let apiResp: any = null;
                try {
                    const reqBody: Record<string, any> = {
                        product_id: product.api_product_id,
                        quantity: totalAccNeeded,
                        partner_ref: orderCode,
                        request_id: orderCode,
                        key: provider.api_key,
                    };

                    apiResp = await axios.post(
                        orderUrl,
                        reqBody,
                        {
                            headers,
                            timeout: 45000
                        }
                    );
                } catch (apiErr: any) {
                    logger.error(`[API Provider Order Error] ${orderUrl}: ${apiErr.response?.data?.detail || apiErr.response?.data?.message || apiErr.message}`);
                    const errDetail = apiErr.response?.data?.detail || apiErr.response?.data?.message || apiErr.response?.data?.error || apiErr.message;
                    if (apiErr.response?.status === 409) {
                        throw new Error(`Sản phẩm hiện đang tạm hết hàng, vui lòng thử lại sau.`);
                    } else if (apiErr.response?.status === 402 || (apiErr.response?.status === 400 && String(errDetail).toLowerCase().includes('balance'))) {
                        this.notifyAdmin(tenantId, `⚠️ **THÔNG BÁO CẠN SỐ DƯ API KHO SỈ**\n\n- Khách: \`${userId}\` đang mua \`${product.name}\` (SL: ${totalAccNeeded})\n- Nhà cung cấp: \`${provider.name || provider.id}\`\n- Lỗi: ${errDetail}\n- Vui lòng nạp thêm tiền vào kho sỉ để đơn hàng API tiếp theo không bị lỗi.`);
                        throw new Error(`Hệ thống đang bận hoặc gián đoạn kết nối, vui lòng thử lại sau ít phút.`);
                    } else {
                        throw new Error(`Hệ thống đang bận hoặc gián đoạn kết nối, vui lòng thử lại sau ít phút.`);
                    }
                }

                if (!apiResp?.data) {
                    throw new Error('Hệ thống đang bận hoặc gián đoạn kết nối, vui lòng thử lại sau ít phút.');
                }

                if (apiResp.data.success === false || apiResp.data.ok === false) {
                    throw new Error('Hệ thống đang bận hoặc gián đoạn kết nối, vui lòng thử lại sau ít phút.');
                }

                const respData = apiResp.data.data || apiResp.data.order || apiResp.data;
                const apiOrderCode = respData.order_code || respData.orderCode || apiResp.data.order?.orderCode || respData.order_id || respData.id || respData.request_id || null;
                const apiStatus = respData.status || apiResp.data.order?.status || 'done';
                const apiItemsRaw = apiResp.data.delivery?.accounts || respData.delivery?.accounts || respData.items || respData.accounts || respData.cards || [];
                const results: string[] = [];

                if (Array.isArray(apiItemsRaw) && apiItemsRaw.length > 0) {
                    for (const item of apiItemsRaw) {
                        if (typeof item === 'object' && item !== null) {
                            if (item.user && item.password) {
                                let accStr = `${item.user} | ${item.password}`;
                                if (item.verifyEmail) accStr += ` | ${item.verifyEmail}`;
                                if (item.twoFa || item['2fa']) accStr += ` | ${item.twoFa || item['2fa']}`;
                                results.push(accStr);
                            } else {
                                results.push(item.value || item.content || item.account || item.data || item.credentials || JSON.stringify(item));
                            }
                        } else {
                            results.push(String(item));
                        }
                    }
                } else if (respData.message) {
                    results.push(respData.message);
                } else {
                    results.push(`Đơn hàng API #${apiOrderCode || orderCode} đã được tiếp nhận.`);
                }

                const newBalance = parseFloat(u[0].balance) - total;
                await conn.execute(`UPDATE ${TABLES.CUSTOMERS} SET balance = ? WHERE id = ? AND tenant_id = ?`, [newBalance, userId, tenantId]);

                const [order] = await conn.execute(
                    `INSERT INTO telehub_orders (tenant_id, customer_id, code, total_amount, status, api_provider_id, api_order_code, api_response, api_status, created_at, updated_at) 
                     VALUES (?, ?, ?, ?, "completed", ?, ?, ?, ?, NOW(), NOW())`,
                    [tenantId, userId, orderCode, total, provider.id, apiOrderCode, JSON.stringify(apiResp.data), apiStatus]
                ) as any;

                const bonusSuffix = bonusQty > 0 ? ` (tặng ${bonusQty})` : '';
                const noteText = paymentCode
                    ? `Mua ${quantity}${bonusSuffix} x ${product.name} (API) [${paymentCode}]`
                    : `Mua ${quantity}${bonusSuffix} x ${product.name} (API)`;
                await conn.execute(
                    `INSERT INTO ${TABLES.BALANCE_LOGS} (tenant_id, customer_id, order_id, amount, type, note, created_at, updated_at) VALUES (?, ?, ?, ?, "OUT", ?, NOW(), NOW())`,
                    [tenantId, userId, order.insertId, total, noteText]
                );

                await conn.execute(
                    `INSERT INTO telehub_order_details (tenant_id, order_id, product_id, quantity, price, combo_id, bonus_qty, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
                    [tenantId, order.insertId, productId, totalAccNeeded, activePrice, comboId || null, bonusQty || null]
                );

                const balanceAfter = apiResp.data.payment?.balance ?? respData.payment?.balance ?? respData.balance;
                if (balanceAfter !== undefined && balanceAfter !== null) {
                    await conn.execute(
                        `UPDATE ${TABLES.API_PROVIDERS} SET balance = ? WHERE id = ?`,
                        [balanceAfter, provider.id]
                    );
                }

                await conn.execute(
                    `UPDATE ${TABLES.PRODUCTS} SET api_stock = GREATEST(0, api_stock - ?) WHERE id = ?`,
                    [totalAccNeeded, productId]
                );

                await conn.commit();
                return { success: true, items: results, remainingBalance: newBalance, orderId: order.insertId, code: orderCode, bonusQty };
            }

            // Lấy item đã reserved trước (ưu tiên), sau đó mới lấy slot chưa reserved
            let items: any[] = [];
            if (reservedBy) {
                // Bước 1: Lấy slot mình đã reserved (hỗ trợ cả qr_ và usdt_ của user)
                const [reservedItems] = await conn.execute(
                    `SELECT id, username, password, note FROM ${TABLES.PRODUCT_ITEMS}
                     WHERE product_id = ? AND is_sold = 0 AND tenant_id = ?
                       AND (reserved_by = ? OR reserved_by = ? OR reserved_by = ?)
                     LIMIT ? FOR UPDATE`,
                    [productId, tenantId, reservedBy, `qr_${userId}`, `usdt_${userId}`, totalAccNeeded]
                ) as any;
                items = reservedItems;
            }

            // Bước 2: Nếu chưa đủ, lấy thêm slot chưa reserved (hoặc expired)
            if (items.length < totalAccNeeded) {
                const needed = totalAccNeeded - items.length;
                const existingIds = items.map((i: any) => i.id);
                const excludeClause = existingIds.length > 0
                    ? `AND id NOT IN (${existingIds.map(() => '?').join(',')})`
                    : '';
                const [extraItems] = await conn.execute(
                    `SELECT id, username, password, note FROM ${TABLES.PRODUCT_ITEMS}
                     WHERE product_id = ? AND is_sold = 0 AND tenant_id = ?
                     AND (reserved_until IS NULL OR reserved_until < NOW())
                     ${excludeClause}
                     LIMIT ? FOR UPDATE SKIP LOCKED`,
                    [productId, tenantId, ...existingIds, needed]
                ) as any;
                items = [...items, ...extraItems];
            }

            if (items.length < totalAccNeeded) throw new Error('Hết hàng');

            const newBalance = parseFloat(u[0].balance) - total;
            await conn.execute(`UPDATE ${TABLES.CUSTOMERS} SET balance = ? WHERE id = ? AND tenant_id = ?`, [newBalance, userId, tenantId]);

            const orderCode = paymentCode || ('WL' + Math.random().toString(36).substring(2, 8).toUpperCase());

            const [order] = await conn.execute(`INSERT INTO telehub_orders (tenant_id, customer_id, code, total_amount, status, created_at, updated_at) VALUES (?, ?, ?, ?, "completed", NOW(), NOW())`, [tenantId, userId, orderCode, total]) as any;

            const bonusSuffix = bonusQty > 0 ? ` (tặng ${bonusQty})` : '';
            const noteText = paymentCode
                ? `Mua ${quantity}${bonusSuffix} x ${product.name} [${paymentCode}]`
                : `Mua ${quantity}${bonusSuffix} x ${product.name}`;
            await conn.execute(
                `INSERT INTO ${TABLES.BALANCE_LOGS} (tenant_id, customer_id, order_id, amount, type, note, created_at, updated_at) VALUES (?, ?, ?, ?, "OUT", ?, NOW(), NOW())`,
                [tenantId, userId, order.insertId, total, noteText]
            );

            const results: string[] = [];
            for (const i of items) {
                // Clear reservation khi bán thành công
                await conn.execute(
                    `UPDATE ${TABLES.PRODUCT_ITEMS} SET is_sold = 1, order_id = ?, customer_id = ?, reserved_by = NULL, reserved_until = NULL WHERE id = ? AND tenant_id = ?`,
                    [order.insertId, userId, i.id, tenantId]
                );
                const finalItem = [i.username, i.password, i.note].filter(Boolean).join('\n');
                results.push(finalItem);
            }

            // Lưu combo_id và bonus_qty vào order_details để tracking thống kê
            await conn.execute(
                `INSERT INTO telehub_order_details (tenant_id, order_id, product_id, quantity, price, combo_id, bonus_qty, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
                [tenantId, order.insertId, productId, totalAccNeeded, activePrice, comboId || null, bonusQty || null]
            );

            await conn.commit();
            return { success: true, items: results, remainingBalance: newBalance, orderId: order.insertId, code: orderCode, bonusQty };
        } catch (e: any) {
            await conn.rollback();
            return { success: false, error: e.message };
        } finally { conn.release(); }
    }

    // --- Utilities ---
    private async getUser(tenantId: number, tgId: string) {
        const [rows] = await pool.execute(`SELECT id, balance, is_dealer, api_key, language FROM ${TABLES.CUSTOMERS} WHERE telegram_id = ? AND tenant_id = ?`, [tgId, tenantId]) as any;
        return rows[0] || null;
    }

    /**
     * Tạm giữ N slot hàng trong kho cho 1 người dùng (tránh race condition)
     * @param tenantId 
     * @param productId 
     * @param qty - Số slot cần giữ
     * @param reservedBy - Key định danh người giữ (vd: 'tg_123456', 'qr_789')
     * @param ttlMinutes - Thời gian giữ (phút)
     */
    public async reserveStock(tenantId: number, productId: number, qty: number, reservedBy: string, ttlMinutes: number) {
        try {
            // Giải phóng reservation cũ của cùng user trước (nếu có)
            await pool.execute(
                `UPDATE ${TABLES.PRODUCT_ITEMS} SET reserved_by = NULL, reserved_until = NULL
                 WHERE product_id = ? AND tenant_id = ? AND reserved_by = ? AND is_sold = 0`,
                [productId, tenantId, reservedBy]
            );
            // Lock N slot mới
            const until = new Date(Date.now() + ttlMinutes * 60 * 1000);
            const untilStr = until.toISOString().slice(0, 19).replace('T', ' ');
            await pool.execute(
                `UPDATE ${TABLES.PRODUCT_ITEMS}
                 SET reserved_by = ?, reserved_until = ?
                 WHERE product_id = ? AND tenant_id = ? AND is_sold = 0
                   AND (reserved_until IS NULL OR reserved_until < NOW())
                 LIMIT ?`,
                [reservedBy, untilStr, productId, tenantId, qty]
            );
            logger.info(`[Reserve] product=${productId} qty=${qty} by=${reservedBy} until=${untilStr}`);
        } catch (e: any) {
            logger.warn(`[Reserve] failed: ${e.message}`);
        }
    }

    /**
     * Giải phóng reservation khi hủy đơn hoặc hết hạn
     */
    public async releaseReservation(tenantId: number, productId: number, reservedBy: string, qty?: number) {
        try {
            const qtyClause = qty ? `LIMIT ${qty}` : '';
            await pool.execute(
                `UPDATE ${TABLES.PRODUCT_ITEMS} SET reserved_by = NULL, reserved_until = NULL
                 WHERE product_id = ? AND tenant_id = ? AND reserved_by = ? AND is_sold = 0 ${qtyClause}`,
                [productId, tenantId, reservedBy]
            );
            logger.info(`[Reserve] Released: product=${productId} by=${reservedBy}`);
        } catch (e: any) {
            logger.warn(`[Reserve] release failed: ${e.message}`);
        }
    }

    /**
     * Dọn dẹp các reservation đã hết hạn (chạy định kỳ)
     */
    private startReservationCleanupJob() {
        setInterval(async () => {
            try {
                const [res]: any = await pool.execute(
                    `UPDATE ${TABLES.PRODUCT_ITEMS} SET reserved_by = NULL, reserved_until = NULL
                     WHERE reserved_until IS NOT NULL AND reserved_until < NOW() AND is_sold = 0`
                );
                if (res.affectedRows > 0) {
                    logger.info(`[Reserve] Cleaned up ${res.affectedRows} expired reservations`);
                }
            } catch (e: any) {
                logger.warn(`[Reserve] cleanup error: ${e.message}`);
            }
        }, 60 * 1000); // Chạy mỗi 1 phút
    }


    private async handleLanguageChange(ctx: any, tgId: string, data: string) {
        const lang = data.replace('setlang_', '');
        await pool.execute(`UPDATE ${TABLES.CUSTOMERS} SET language = ? WHERE telegram_id = ? AND tenant_id = ?`, [lang, tgId, ctx.tenantId]);
        await ctx.answerCbQuery(i18n.t(lang, 'lang_updated'));
        this.deleteMsg(ctx);
        // Resend welcome message to update keyboards
        const msg = lang === 'en' && ctx.config?.welcome_message_en ? ctx.config.welcome_message_en : (ctx.config?.welcome_message || 'Chào mừng bạn!');
        return ctx.reply(this.formatWelcomeMessage(msg), {
            parse_mode: 'HTML',
            reply_markup: {
                keyboard: [
                    [{ text: i18n.t(lang, 'menu_products') }, { text: i18n.t(lang, 'menu_orders') }],
                    [{ text: i18n.t(lang, 'menu_profile') }, { text: i18n.t(lang, 'menu_deposit') }],
                    [{ text: i18n.t(lang, 'menu_api') }, { text: i18n.t(lang, 'menu_language') }]
                ],
                resize_keyboard: true
            }
        });
    }
    private fmt(v: number) { return Math.floor(v || 0).toLocaleString(); }

    // Mã random 12 ký tự, loại bỏ ký tự dễ nhầm (0,O,1,I)
    private genId() {
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        const bytes = crypto.randomBytes(12);
        return Array.from(bytes, b => chars[b % chars.length]).join('');
    }

    private langPickerMsg() {
        return `<tg-emoji emoji-id="5332618260703624145">🌐</tg-emoji> <b>Vui lòng chọn ngôn ngữ / Please select your language:</b>\n` +
               `<tg-emoji emoji-id="6296529082226054237">🇻🇳</tg-emoji> Tiếng Việt - <tg-emoji emoji-id="6323266361745215975">🇬🇧</tg-emoji> English`;
    }

    private langPickerKeyboard() {
        return { inline_keyboard: [[{ text: '🇻🇳 Tiếng Việt', callback_data: 'setlang_vi' }], [{ text: '🇬🇧 English', callback_data: 'setlang_en' }]] };
    }

    private formatWelcomeMessage(msg: string) {
        let parsed = msg.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>').replace(/\*(.*?)\*/g, '<i>$1</i>');
        parsed = parsed.replace(/(emoji-id=")?\[?(\d{18,19})\]?(")?/g, (match, prefix, id, suffix) => {
            if (prefix === 'emoji-id="' && suffix === '"') return match;
            return `<tg-emoji emoji-id="${id}">✨</tg-emoji>`;
        });
        return parsed;
    }
    private qr(ctx: any, a: number, d: string) {
        const config = ctx.config;
        let bankCode = config?.bank_code || 'TPB';
        const bankNum = config?.bank_num || '10000960969';
        const bankAccountName = encodeURIComponent(config?.bank_account_name || 'PHAM HOANG HUONG');

        // Map common names to VietQR codes
        const bankMap: { [key: string]: string } = {
            'TPBank': 'TPB',
            'TPB': 'TPB',
            'MBBank': 'MB',
            'MB': 'MB',
            'Vietcombank': 'VCB',
            'VCB': 'VCB',
            'Techcombank': 'TCB',
            'TCB': 'TCB',
            'ViettelMoney': 'VTLMONEY',
            'VTLMONEY': 'VTLMONEY'
        };

        if (bankMap[bankCode]) {
            bankCode = bankMap[bankCode];
        }

        const template = config?.qr_template || 'compact';
        return `https://img.vietqr.io/image/${bankCode}-${bankNum}-${template}.png?amount=${a}&addInfo=${d}&accountName=${bankAccountName}`;
    }

    public async deleteMessage(tenantId: number, chatId: string, messageId: number) {
        try {
            const botInfo = this.bots.get(tenantId);
            if (botInfo?.selling) {
                await botInfo.selling.telegram.deleteMessage(chatId, messageId);
            }
        } catch { }
    }

    private async deleteMsg(ctx: any, id?: number) {
        try {
            const mid = id || ctx.callbackQuery?.message?.message_id;
            if (mid) await this.deleteMessage(ctx.tenantId, ctx.chat.id.toString(), mid);
        } catch (err: any) {
            logger.error(`🚨 [Telegram] deleteMsg error: ${err.message}`);
        }
    }

    private async deliveryAsFile(ctx: any, id: number, items: string[]) {
        try {
            const p = path.join(os.tmpdir(), `Order_${id}.txt`);
            fs.writeFileSync(p, items.join('\n'));
            await ctx.replyWithDocument({ source: p, filename: `Order_${id}.txt` }, { caption: `📄 Danh sách tài khoản.` });
            setTimeout(() => { try { fs.unlinkSync(p); } catch { } }, 60000);
        } catch (err: any) {
            logger.error(`🚨 [Telegram] deliveryAsFile error: ${err.message}`);
        }
    }



    public formatPremiumEmoji(message: string): string {
        if (!message) return '';
        if (message.includes('<tg-emoji')) return message;
        let formatted = message;
        formatted = formatted.replace(/\[(?:emoji[:_])?(\d{18,20})\]/g, '___EMOJI_$1___');
        formatted = formatted.replace(/(?<!["'=])\b(\d{18,20})\b(?!["'=])/g, '___EMOJI_$1___');
        formatted = formatted.replace(/___EMOJI_(\d{18,20})___/g, '<tg-emoji emoji-id="$1">📢</tg-emoji>');
        return formatted;
    }

    public async pruneDeadCustomer(customerId: number, telegramId: string, reason: string = '') {
        try {
            const [rows]: any = await pool.execute(
                `SELECT c.balance,
                    (SELECT COUNT(*) FROM ${TABLES.ORDERS} o WHERE o.customer_id = c.id) as order_count,
                    (SELECT COUNT(*) FROM ${TABLES.DEPOSIT_REQUESTS} d WHERE d.customer_id = c.id) as deposit_count
                 FROM ${TABLES.CUSTOMERS} c WHERE c.id = ? LIMIT 1`,
                [customerId]
            );
            const cust = rows?.[0];
            if (!cust) return;

            const hasBalance = parseFloat(cust.balance) > 0;
            const hasOrders = parseInt(cust.order_count) > 0;
            const hasDeposits = parseInt(cust.deposit_count) > 0;

            if (!hasBalance && !hasOrders && !hasDeposits) {
                await pool.execute(`DELETE FROM ${TABLES.CUSTOMER_ACTIVITIES} WHERE customer_id = ?`, [customerId]).catch(() => {});
                await pool.execute(`DELETE FROM ${TABLES.DEALER_PRICES} WHERE customer_id = ?`, [customerId]).catch(() => {});
                await pool.execute(`DELETE FROM ${TABLES.CUSTOMERS} WHERE id = ?`, [customerId]);
                logger.info(`[Broadcast] Auto-deleted blocked customer ID ${customerId} (TG: ${telegramId}) - Reason: ${reason}`);
            } else {
                await pool.execute(`UPDATE ${TABLES.CUSTOMERS} SET status = 'draft', updated_at = NOW() WHERE id = ?`, [customerId]);
                logger.info(`[Broadcast] Marked blocked customer ID ${customerId} (TG: ${telegramId}) as DRAFT - Reason: ${reason}`);
            }
        } catch (err: any) {
            logger.error(`[Broadcast] pruneDeadCustomer error for ID ${customerId}: ${err.message}`);
        }
    }

    public async broadcastNotification(
        tenantId: number,
        message: string,
        image?: string | null,
        replyMarkup?: any
    ): Promise<{ total: number; success: number; fail: number; pruned: number }> {
        const botInfo = this.bots.get(tenantId);
        if (!botInfo?.selling) {
            throw new Error(`Bot bán hàng cho Tenant #${tenantId} chưa sẵn sàng hoặc không tồn tại.`);
        }

        const formattedMessage = this.formatPremiumEmoji(message);
        const [customers]: any = await pool.execute(
            `SELECT id, telegram_id FROM ${TABLES.CUSTOMERS} WHERE tenant_id = ? AND status = "published"`,
            [tenantId]
        );

        const total = customers.length;
        if (total === 0) {
            return { total: 0, success: 0, fail: 0, pruned: 0 };
        }

        logger.info(`[Broadcast] Bắt đầu phát broadcast tới ${total} user của Tenant #${tenantId} (25 tin/giây)...`);

        let success = 0;
        let fail = 0;
        let pruned = 0;
        const BATCH_SIZE = 25; // Chuẩn 25 req/s tương đương BroadcastTelegramNotificationJob của CMS Botble

        const sendSingle = async (c: any) => {
            if (!c.telegram_id) return;
            try {
                if (image) {
                    await botInfo.selling.telegram.sendPhoto(c.telegram_id, image, {
                        caption: formattedMessage,
                        parse_mode: 'HTML',
                        reply_markup: replyMarkup
                    });
                } else {
                    await botInfo.selling.telegram.sendMessage(c.telegram_id, formattedMessage, {
                        parse_mode: 'HTML',
                        reply_markup: replyMarkup
                    });
                }
                success++;
            } catch (err: any) {
                fail++;
                const statusCode = err?.response?.error_code || err?.code;
                const desc = (err?.response?.description || err?.message || '').toLowerCase();

                if (statusCode === 429) {
                    const retryAfter = (err?.response?.parameters?.retry_after || 3) + 1;
                    await new Promise(r => setTimeout(r, retryAfter * 1000));
                    try {
                        if (image) {
                            await botInfo.selling.telegram.sendPhoto(c.telegram_id, image, {
                                caption: formattedMessage,
                                parse_mode: 'HTML',
                                reply_markup: replyMarkup
                            });
                        } else {
                            await botInfo.selling.telegram.sendMessage(c.telegram_id, formattedMessage, {
                                parse_mode: 'HTML',
                                reply_markup: replyMarkup
                            });
                        }
                        success++;
                        fail--;
                    } catch {}
                    return;
                }

                if (
                    statusCode === 403 ||
                    (statusCode === 400 && (
                        desc.includes('chat not found') ||
                        desc.includes('user not found') ||
                        desc.includes('user is deactivated') ||
                        desc.includes('bot was blocked')
                    ))
                ) {
                    await this.pruneDeadCustomer(c.id, c.telegram_id, desc);
                    pruned++;
                }
            }
        };

        for (let i = 0; i < total; i += BATCH_SIZE) {
            const batch = customers.slice(i, i + BATCH_SIZE);
            const batchStart = Date.now();

            await Promise.allSettled(batch.map((c: any) => sendSingle(c)));

            const elapsed = Date.now() - batchStart;
            if (elapsed < 1000 && i + BATCH_SIZE < total) {
                await new Promise(r => setTimeout(r, 1000 - elapsed));
            }
        }

        logger.info(`[Broadcast] Hoàn tất Tenant #${tenantId}. Tổng: ${total}, Thành công: ${success}, Thất bại: ${fail}, Pruned: ${pruned}`);
        return { total, success, fail, pruned };
    }

    public async notifyAdmin(tenantId: number, m: string) {
        try {
            const botInfo = this.bots.get(tenantId);
            if (botInfo?.adminId && botInfo.notifying) {
                try {
                    await botInfo.notifying.telegram.sendMessage(botInfo.adminId, `${this.UI.INFO} [ADMIN]\n${m}`, { parse_mode: 'HTML' });
                    return;
                } catch (err: any) {
                    if (err?.code === 429 || err?.response?.error_code === 429) {
                        const retryAfter = ((err?.parameters?.retry_after || 3) + 1) * 1000;
                        await new Promise(r => setTimeout(r, retryAfter));
                        await botInfo.notifying.telegram.sendMessage(botInfo.adminId, `${this.UI.INFO} [ADMIN]\n${m}`, { parse_mode: 'HTML' }).catch(() => {});
                        return;
                    }
                    logger.warn(`[Telegram] notifyAdmin Telegraf error: ${err.message}`);
                }
            }
            // Fallback: lấy token từ DB gửi HTTP trực tiếp
            const [rows]: any = await pool.execute(
                `SELECT bot_token, telegram_notification_id, telegram_admin_id FROM ${TABLES.BOT_CONFIGS} WHERE tenant_id = ? AND status = "published" LIMIT 1`,
                [tenantId]
            );
            const cfg = rows?.[0];
            if (!cfg?.telegram_admin_id) return;
            const notifyToken = cfg.telegram_notification_id || cfg.bot_token;
            if (!notifyToken) return;
            try {
                await axios.post(`https://api.telegram.org/bot${notifyToken}/sendMessage`, {
                    chat_id: cfg.telegram_admin_id,
                    text: `${this.UI.INFO} [ADMIN]\n${m}`,
                    parse_mode: 'HTML'
                });
            } catch (err: any) {
                if (err?.response?.status === 429) {
                    const retryAfter = ((err?.response?.data?.parameters?.retry_after || 3) + 1) * 1000;
                    await new Promise(r => setTimeout(r, retryAfter));
                    await axios.post(`https://api.telegram.org/bot${notifyToken}/sendMessage`, {
                        chat_id: cfg.telegram_admin_id,
                        text: `${this.UI.INFO} [ADMIN]\n${m}`,
                        parse_mode: 'HTML'
                    }).catch(() => {});
                }
            }
        } catch (err: any) {
            logger.error(`🚨 [Telegram] notifyAdmin error: ${err.message}`);
        }
    }

    public async notifyUser(tenantId: number, id: string | number, m: string, x?: any) {
        const tid = Number(tenantId);
        try {
            const botInfo = this.bots.get(tid);
            if (botInfo?.selling) {
                await botInfo.selling.telegram.sendMessage(id, m, x);
                return;
            }
            // Fallback: Lấy token từ DB nếu botInfo trong memory chưa load
            const [rows]: any = await pool.execute(
                `SELECT bot_token FROM ${TABLES.BOT_CONFIGS} WHERE tenant_id = ? AND status = "published" LIMIT 1`,
                [tid]
            );
            const token = rows?.[0]?.bot_token;
            if (token) {
                await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
                    chat_id: id,
                    text: m,
                    parse_mode: x?.parse_mode || 'HTML',
                    reply_markup: x?.reply_markup
                }, { timeout: 15000 });
            }
        } catch (err: any) {
            logger.error(`🚨 [Telegram] notifyUser error for user ${id} (tenant ${tid}): ${err.message}`);
        }
    }

    public async processAutomatedPurchase(
        tenantId: number,
        customerId: number,
        productId: number,
        quantity: number,
        code: string,
        comboId?: number,
        bonusQty: number = 0
    ) {
        try {
            const [userRows]: any = await pool.execute(`SELECT telegram_id, full_name, username, balance, language, is_dealer FROM ${TABLES.CUSTOMERS} WHERE id = ? AND tenant_id = ?`, [customerId, tenantId]);
            const [prodRows]: any = await pool.execute(`SELECT name, price FROM ${TABLES.PRODUCTS} WHERE id = ? AND tenant_id = ?`, [productId, tenantId]);

            if (!userRows.length || !prodRows.length) return;
            const user = userRows[0];
            const prod = prodRows[0];

            let activePrice = prod.price;
            let dealerRows: any = [];
            if (user && user.is_dealer) {
                [dealerRows] = await pool.execute(`SELECT price FROM ${TABLES.DEALER_PRICES} WHERE customer_id = ? AND product_id = ? AND tenant_id = ? LIMIT 1`, [customerId, productId, tenantId]);
            }
            if (dealerRows && dealerRows.length > 0 && dealerRows[0].price !== null) {
                activePrice = dealerRows[0].price;
            }

            // Nếu combo_id là discount, tính lại giá tổng
            let effectiveTotal = activePrice * quantity;
            if (comboId) {
                const [comboRows]: any = await pool.execute(
                    `SELECT * FROM ${TABLES.PRODUCT_COMBOS} WHERE id = ? AND tenant_id = ? AND is_active = 1`,
                    [comboId, tenantId]
                );
                if (comboRows && comboRows.length > 0) {
                    const combo = comboRows[0] as ComboInfo;
                    const applied = this.applyCombo(combo, quantity, activePrice);
                    effectiveTotal = applied.total;
                    if (applied.bonusQty > 0) bonusQty = applied.bonusQty;
                }
            }

            // NOTE: Không check balance ở đây vì có thể gây race condition với USDT deposit.
            // Balance vừa được cộng trong processDeposit() ngay trước lời gọi này.
            // handleDirectPurchase() sẽ tự kiểm tra balance trong transaction FOR UPDATE.

            // Truyền reservedBy để ưu tiên lấy slot đã giữ qua QR hoặc USDT
            const reservedByKey = code ? `qr_${customerId}` : undefined;
            const result = await this.handleDirectPurchase(tenantId, customerId, productId.toString(), quantity, code, bonusQty, comboId, reservedByKey);
            const actualQty = quantity + bonusQty;

            if (result.success && user.telegram_id) {
                await this.sendSuccessDelivery({
                    tenantId,
                    telegramId: user.telegram_id,
                    productName: prod.name,
                    quantity: actualQty,
                    total: effectiveTotal,
                    remainingBalance: result.remainingBalance,
                    items: result.items,
                    orderId: result.orderId,
                    code,
                    bonusQty
                });

                const itemsFormatted = result.items.map((item: string) => {
                    return item.split('\n').map(line => {
                        const trimmed = line.trim();
                        if (trimmed.startsWith('http')) return trimmed;
                        return `<code>${trimmed}</code>`;
                    }).join('\n');
                }).join('\n');

                let paymentMethodStr = 'Ví';
                const [reqRows]: any = await pool.execute(
                    `SELECT usdt_amount FROM ${TABLES.DEPOSIT_REQUESTS} WHERE payment_code = ? AND tenant_id = ?`,
                    [code, tenantId]
                );
                if (reqRows && reqRows.length > 0) {
                    if (reqRows[0].usdt_amount && parseFloat(reqRows[0].usdt_amount) > 0) {
                        paymentMethodStr = 'USDT Binance';
                    } else {
                        paymentMethodStr = 'QR Ngân hàng';
                    }
                }

                const comboNote = bonusQty > 0 ? ` (Tặng ${bonusQty} acc)` : (comboId ? ' (Combo giảm giá)' : '');
                const timeVN = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
                const orderCodeDisplay = code ? `<code>${code}</code>` : `<code>#${result.orderId}</code>`;
                const adminMsg = [
                    `🛒 <b>ĐƠN HÀNG TỰ ĐỘNG (Thanh toán ${paymentMethodStr}: ${code})</b>`,
                    `🕒 <b>Thời gian:</b> ${timeVN}`,
                    `📝 <b>Mã đơn:</b> ${orderCodeDisplay}`,
                    `👤 <b>Khách hàng:</b> ${user.full_name || ''} | @${user.username || 'N/A'} (ID: <code>${user.telegram_id}</code>)`,
                    `📦 <b>Sản phẩm:</b> ${quantity}${comboNote} x ${prod.name}`,
                    `💵 <b>Tổng thanh toán:</b> ${this.fmt(effectiveTotal)}đ`,
                    `━━━━━━━━━━━━━━━━━━`,
                    `📑 <b>Tài khoản bàn giao:</b>`,
                    itemsFormatted
                ].join('\n');

                this.notifyAdmin(tenantId, adminMsg);
            } else {
                logger.error(`[Tenant ${tenantId}] processAutomatedPurchase failed: ${result.error || 'Unknown error'} (user=${customerId}, product=${productId}, qty=${quantity})`);
                if (user.telegram_id) {
                    const isOutOfStock = result.error === 'Hết hàng';
                    const errMsg = isOutOfStock
                        ? i18n.t(user.language || 'vi', 'notify_stock_error', { code: code, name: prod.name, qty: quantity })
                        : i18n.t(user.language || 'vi', 'notify_purchase_error', { code: code, name: prod.name, qty: quantity, error: result.error });
                    await this.notifyUser(tenantId, user.telegram_id, errMsg);
                }
                // Thông báo admin khi mua hàng tự động thất bại
                this.notifyAdmin(tenantId, [
                    `⚠️ <b>LỖI MUA HÀNG TỰ ĐỘNG</b>`,
                    `👤 <b>Khách:</b> ${user.full_name || 'N/A'} | @${user.username || 'N/A'} (ID: <code>${user.telegram_id}</code>)`,
                    `📦 <b>Sản phẩm:</b> ${quantity} x ${prod.name}`,
                    `📝 <b>Mã đơn:</b> <code>${code}</code>`,
                    `❌ <b>Lỗi:</b> <code>${result.error || 'Unknown'}</code>`,
                    `📌 <i>Tiền đã cộng vào ví khách. Cần kiểm tra thủ công!</i>`
                ].join('\n'));
            }
        } catch (err: any) {
            logger.error(`[Tenant ${tenantId}] processAutomatedPurchase error: ${err.message}`);
            // Thông báo admin khi có exception nghiêm trọng
            this.notifyAdmin(tenantId, [
                `🚨 <b>LỖI HỆ THỐNG - MUA HÀNG TỰ ĐỘNG</b>`,
                `📝 <b>Mã đơn:</b> <code>${code}</code>`,
                `❌ <b>Exception:</b> <code>${err.message}</code>`,
                `📌 <i>Cần kiểm tra thủ công!</i>`
            ].join('\n'));
        }
    }
}

export const telegramService = new TelegramService();
