import dns from 'dns';
dns.setDefaultResultOrder('ipv4first');

import { Telegraf } from 'telegraf';
import mysql from 'mysql2/promise';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

// Token bot dùng để check emoji
const token = '8773539915:AAFvb6JJl_wX2ofrvT3EVika56CRNbYmluQ';
const ADMIN_ID = 7353915691;
const ipv4HttpsAgent = new (require('https').Agent)({ family: 4, keepAlive: true, maxSockets: 50 });
const bot = new Telegraf(token, { handlerTimeout: Infinity, telegram: { agent: ipv4HttpsAgent } });

const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

const states = new Map<number, any>();

async function pruneCustomer(customerId: number, telegramId: string, reason: string = '') {
    try {
        const [rows]: any = await pool.execute(
            `SELECT c.balance,
                (SELECT COUNT(*) FROM telehub_orders o WHERE o.customer_id = c.id) as order_count,
                (SELECT COUNT(*) FROM telehub_deposit_requests d WHERE d.customer_id = c.id) as deposit_count
             FROM telehub_bot_customers c WHERE c.id = ? LIMIT 1`,
            [customerId]
        );
        const cust = rows?.[0];
        if (!cust) return;

        const hasBalance = parseFloat(cust.balance) > 0;
        const hasOrders = parseInt(cust.order_count) > 0;
        const hasDeposits = parseInt(cust.deposit_count) > 0;

        if (!hasBalance && !hasOrders && !hasDeposits) {
            await pool.execute(`DELETE FROM telehub_customer_activities WHERE customer_id = ?`, [customerId]).catch(() => {});
            await pool.execute(`DELETE FROM telehub_dealer_prices WHERE customer_id = ?`, [customerId]).catch(() => {});
            await pool.execute(`DELETE FROM telehub_bot_customers WHERE id = ?`, [customerId]);
            console.log(`[Broadcast] Auto-deleted blocked customer ID ${customerId} (TG: ${telegramId}) - Reason: ${reason}`);
        } else {
            await pool.execute(`UPDATE telehub_bot_customers SET status = 'draft', updated_at = NOW() WHERE id = ?`, [customerId]);
            console.log(`[Broadcast] Marked blocked customer ID ${customerId} (TG: ${telegramId}) as DRAFT - Reason: ${reason}`);
        }
    } catch (err: any) {
        console.error(`[Broadcast] pruneCustomer error for ID ${customerId}: ${err.message}`);
    }
}

// Lệnh /start hiển thị bàn phím cố định (Reply Keyboard)
bot.start((ctx) => {
    if (ctx.from?.id !== ADMIN_ID) return;
    states.delete(ADMIN_ID);

    ctx.reply('🛠 <b>MENU ADMIN (BOT THÔNG BÁO)</b>\n\nBàn phím chức năng đã được mở ra bên dưới, vui lòng chọn!', {
        parse_mode: 'HTML',
        reply_markup: {
            keyboard: [
                [{ text: '✨ Công cụ lấy ID Emoji' }],
                [{ text: '📢 Gửi thông báo (Broadcast)' }]
            ],
            resize_keyboard: true
        }
    });
});

// Xử lý nút bấm trên Bàn phím cố định (Reply Keyboard)
bot.hears('✨ Công cụ lấy ID Emoji', async (ctx) => {
    if (ctx.from?.id !== ADMIN_ID) return;
    states.set(ADMIN_ID, { step: 'EMOJI' });
    return ctx.reply('✨ <b>CHẾ ĐỘ LẤY ID CUSTOM EMOJI</b>\n\nVui lòng gửi tin nhắn có chứa Custom Emoji vào đây.', { parse_mode: 'HTML' });
});

bot.hears('📢 Gửi thông báo (Broadcast)', async (ctx) => {
    if (ctx.from?.id !== ADMIN_ID) return;
    try {
        const [rows]: any = await pool.execute(`SELECT tenant_id FROM telehub_bot_configs WHERE status = 'published'`);
        if (rows.length === 0) return ctx.reply('Không có Bot Bán Hàng nào đang hoạt động!');

        states.set(ADMIN_ID, { step: 'BROADCAST_SELECT_TENANT' });

        const buttons = rows.map((r: any) => ([{ text: `Gửi cho Tenant ID: ${r.tenant_id}`, callback_data: `broadcast_tenant_${r.tenant_id}` }]));

        return ctx.reply('📢 <b>GỬI THÔNG BÁO</b>\n\nChọn Tenant (Bot Bán Hàng) muốn gửi:', {
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: buttons }
        });
    } catch (e) {
        console.error(e);
        return ctx.reply('❌ Lỗi Database');
    }
});

bot.on('callback_query', async (ctx: any) => {
    if (ctx.from?.id !== ADMIN_ID) return;
    const data = ctx.callbackQuery.data;

    // Tương thích lùi với inline_keyboard cũ nếu còn sót
    if (data === 'menu_emoji') {
        states.set(ADMIN_ID, { step: 'EMOJI' });
        await ctx.answerCbQuery();
        return ctx.reply('✨ <b>CHẾ ĐỘ LẤY ID CUSTOM EMOJI</b>\n\nVui lòng gửi tin nhắn có chứa Custom Emoji vào đây.', { parse_mode: 'HTML' });
    }

    if (data === 'menu_broadcast') {
        try {
            const [rows]: any = await pool.execute(`SELECT tenant_id FROM telehub_bot_configs WHERE status = 'published'`);
            if (rows.length === 0) return ctx.answerCbQuery('Không có Bot Bán Hàng nào đang hoạt động!', { show_alert: true });

            states.set(ADMIN_ID, { step: 'BROADCAST_SELECT_TENANT' });

            const buttons = rows.map((r: any) => ([{ text: `Gửi cho Tenant ID: ${r.tenant_id}`, callback_data: `broadcast_tenant_${r.tenant_id}` }]));

            await ctx.answerCbQuery();
            return ctx.reply('📢 <b>GỬI THÔNG BÁO</b>\n\nChọn Tenant (Bot Bán Hàng) muốn gửi:', {
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: buttons }
            });
        } catch (e) {
            console.error(e);
            return ctx.answerCbQuery('Lỗi Database', { show_alert: true });
        }
    }

    if (data.startsWith('broadcast_tenant_')) {
        const tenantId = data.replace('broadcast_tenant_', '');
        states.set(ADMIN_ID, { step: 'BROADCAST_MSG', tenantId });
        await ctx.answerCbQuery();
        return ctx.reply(`📢 Bạn đã chọn Tenant ${tenantId}.\n\n<b>Vui lòng nhập nội dung thông báo muốn gửi:</b>\n<i>(Hỗ trợ in đậm, bôi đen, Custom Emoji...)</i>`, { parse_mode: 'HTML' });
    }

    if (data === 'broadcast_confirm') {
        const state = states.get(ADMIN_ID);
        if (!state || state.step !== 'BROADCAST_CONFIRM') return ctx.answerCbQuery('Hết hạn hoặc lỗi', { show_alert: true });

        const { tenantId, rawText, entities, photo } = state;
        states.delete(ADMIN_ID);

        await ctx.answerCbQuery('Đang tính toán số lượng...');

        try {
            const [configRows]: any = await pool.execute('SELECT bot_token FROM telehub_bot_configs WHERE tenant_id = ? AND status = "published"', [tenantId]);
            if (configRows.length === 0) return ctx.reply('❌ Không tìm thấy Token của Bot Bán Hàng này.');
            const botToken = configRows[0].bot_token;

            const [userRows]: any = await pool.execute('SELECT id, telegram_id FROM telehub_bot_customers WHERE tenant_id = ? AND status = "published"', [tenantId]);
            const total = userRows.length;
            if (total === 0) return ctx.reply(`⚠️ Không có khách hàng nào đang ở trạng thái 'published' cho Tenant ${tenantId}.`);

            await ctx.editMessageText(`🚀 <b>Bắt đầu phát Broadcast tới ${total} user...</b>\n\nTiến độ: 0/${total}`, { parse_mode: 'HTML' }).catch(() => { });

            let success = 0;
            let fail = 0;
            let pruned = 0;

            let tenantFileId: string | null = null;
            let photoBuffer: Buffer | null = null;

            if (photo && photo.length > 0) {
                try {
                    const fileId = photo[photo.length - 1].file_id;
                    const fileLink = await bot.telegram.getFileLink(fileId);
                    const response = await axios.get(fileLink.href, { responseType: 'arraybuffer' });
                    photoBuffer = Buffer.from(response.data as any);
                } catch (err: any) {
                    return ctx.reply('❌ Lỗi tải ảnh từ hệ thống: ' + err.message);
                }
            }

            const tenantTelegram = new Telegraf(botToken, { telegram: { agent: ipv4HttpsAgent } }).telegram;

            // Cache trước file_id bằng cách gửi thử cho chính admin
            if (photo && photoBuffer) {
                try {
                    const testMsg = await tenantTelegram.sendPhoto(ADMIN_ID, { source: photoBuffer }, { caption: 'Broadcast cache test' });
                    if (testMsg.photo && testMsg.photo.length > 0) {
                        tenantFileId = testMsg.photo[testMsg.photo.length - 1].file_id;
                        await tenantTelegram.deleteMessage(ADMIN_ID, testMsg.message_id).catch(() => {});
                    }
                } catch {
                    // Nếu admin chưa chat với bot bán hàng thì tenantFileId sẽ được bắt ở user thành công đầu tiên
                }
            }

            const callWithTimeout = <T>(promise: Promise<T>, ms = 8000): Promise<T> => {
                return Promise.race([
                    promise,
                    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('REQUEST_TIMEOUT_8S')), ms))
                ]);
            };

            const sendSingleUser = async (u: any) => {
                if (!u.telegram_id) return;
                try {
                    if (photo) {
                        const payload = tenantFileId || (photoBuffer ? { source: photoBuffer } : null);
                        if (!payload) throw new Error('No photo payload');
                        const msgObj: any = await callWithTimeout(tenantTelegram.sendPhoto(u.telegram_id, payload, {
                            caption: rawText,
                            caption_entities: entities
                        }), 8000);
                        if (!tenantFileId && msgObj?.photo?.length) {
                            tenantFileId = msgObj.photo[msgObj.photo.length - 1].file_id;
                        }
                    } else {
                        await callWithTimeout(tenantTelegram.sendMessage(u.telegram_id, rawText, {
                            entities: entities
                        }), 8000);
                    }
                    success++;
                } catch (err: any) {
                    fail++;
                    const statusCode = err?.response?.error_code || err?.code;
                    const desc = (err?.response?.description || err?.message || '').toLowerCase();

                    // Xử lý Rate Limit 429
                    if (statusCode === 429) {
                        const retryAfter = (err?.response?.parameters?.retry_after || 3) + 1;
                        await new Promise(r => setTimeout(r, retryAfter * 1000));
                        try {
                            if (photo) {
                                await callWithTimeout(tenantTelegram.sendPhoto(u.telegram_id, tenantFileId || { source: photoBuffer! }, {
                                    caption: rawText,
                                    caption_entities: entities
                                }), 8000);
                            } else {
                                await callWithTimeout(tenantTelegram.sendMessage(u.telegram_id, rawText, { entities }), 8000);
                            }
                            success++;
                            fail--;
                        } catch {}
                        return;
                    }

                    // Tự động dọn dẹp (prune) user chết giống CMS Botble
                    if (
                        statusCode === 403 ||
                        (statusCode === 400 && (
                            desc.includes('chat not found') ||
                            desc.includes('user not found') ||
                            desc.includes('user is deactivated') ||
                            desc.includes('bot was blocked')
                        ))
                    ) {
                        await pruneCustomer(u.id, u.telegram_id, desc);
                        pruned++;
                    }
                }
            };

            const BATCH_SIZE = 25; // 25 tin/giây theo chuẩn Botble CMS và Telegram Rate Limits
            for (let i = 0; i < total; i += BATCH_SIZE) {
                const batch = userRows.slice(i, i + BATCH_SIZE);
                const batchStart = Date.now();

                // Gửi song song toàn bộ batch 25 user
                await Promise.allSettled(batch.map((u: any) => sendSingleUser(u)));

                const processed = Math.min(i + BATCH_SIZE, total);

                // Cập nhật tiến độ trực quan
                await ctx.editMessageText(
                    `🚀 <b>Đang phát Broadcast tới ${total} user...</b>\n\n` +
                    `📊 Tiến độ: <b>${processed}/${total}</b> (${Math.round((processed / total) * 100)}%)\n` +
                    `✅ Thành công: <b>${success}</b>\n` +
                    `❌ Thất bại: <b>${fail}</b>\n` +
                    `🧹 Khách chết đã dọn dẹp: <b>${pruned}</b>`,
                    { parse_mode: 'HTML' }
                ).catch(() => {});

                // Đảm bảo mỗi batch 25 user cách nhau tối thiểu 1.0 giây để tuân thủ ngưỡng 30 req/s của Telegram
                const elapsed = Date.now() - batchStart;
                if (elapsed < 1000 && processed < total) {
                    await new Promise(r => setTimeout(r, 1000 - elapsed));
                }
            }

            await ctx.editMessageText(
                `✅ <b>BROADCAST HOÀN TẤT CHO TENANT ${tenantId}</b>\n\n` +
                `👥 Tổng số user: <b>${total}</b>\n` +
                `✅ Thành công: <b>${success}</b>\n` +
                `❌ Thất bại: <b>${fail}</b>\n` +
                `🧹 Khách chết đã dọn dẹp khỏi DB: <b>${pruned}</b>`,
                { parse_mode: 'HTML' }
            ).catch(() => {});
            return ctx.reply(`🎉 <b>GỬI XONG!</b>\nĐã phát Broadcast thành công tới <b>${success}</b> khách hàng của Tenant ${tenantId} với tốc độ siêu nhanh (25 tin/giây).`, { parse_mode: 'HTML' });
        } catch (e: any) {
            return ctx.reply('❌ Lỗi: ' + e.message);
        }
    }

    if (data === 'broadcast_cancel') {
        states.delete(ADMIN_ID);
        await ctx.answerCbQuery('Đã hủy');
        return ctx.deleteMessage();
    }
});

bot.on('message', async (ctx) => {
    if (ctx.from?.id !== ADMIN_ID) return;
    const msg = ctx.message as any;

    // Bỏ qua các tin nhắn text đã được xử lý bởi command hoặc hears
    if (msg.text === '/start' || msg.text === '✨ Công cụ lấy ID Emoji' || msg.text === '📢 Gửi thông báo (Broadcast)') return;

    const state = states.get(ADMIN_ID);

    // Broadcast Message Processing
    if (state?.step === 'BROADCAST_MSG') {
        if (!msg.text && !msg.photo) return ctx.reply('❌ Chỉ hỗ trợ tin nhắn dạng văn bản hoặc hình ảnh. Vui lòng nhập lại!');

        states.set(ADMIN_ID, {
            step: 'BROADCAST_CONFIRM',
            tenantId: state.tenantId,
            rawText: msg.text || msg.caption || '',
            entities: msg.entities || msg.caption_entities || [],
            photo: msg.photo
        });

        await ctx.telegram.copyMessage(ADMIN_ID, ADMIN_ID, msg.message_id);

        return ctx.reply(`👀 <b>BẢN XEM TRƯỚC BÊN TRÊN 👆</b>\n\nBạn có chắc chắn gửi đi không?`, {
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '✅ Xác nhận Gửi', callback_data: 'broadcast_confirm' }],
                    [{ text: '❌ Hủy bỏ', callback_data: 'broadcast_cancel' }]
                ]
            }
        });
    }

    // Default Emoji Logic
    console.log('\n=============================================');
    console.log('📩 NHẬN ĐƯỢC TIN NHẮN MỚI TỪ ADMIN');

    let replyMsg = '';
    const text = msg.text || msg.caption || '';
    const ents = msg.entities || msg.caption_entities || [];

    const customEmojiEntities = ents
        .filter((e: any) => e.type === 'custom_emoji')
        .sort((a: any, b: any) => a.offset - b.offset);

    if (customEmojiEntities.length > 0) {
        const escapeHTML = (str: string) => str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

        let formattedParts = [];
        let rawIdParts = [];
        let bracketIdParts = [];
        let lastIndex = 0;
        const detectedEmojis: { emoji: string; id: string }[] = [];

        customEmojiEntities.forEach((entity: any) => {
            const start = entity.offset;
            const end = entity.offset + entity.length;
            
            const originalChar = text.substring(start, end);
            detectedEmojis.push({ emoji: originalChar, id: entity.custom_emoji_id });

            const beforeText = escapeHTML(text.substring(lastIndex, start));
            formattedParts.push(beforeText);
            rawIdParts.push(beforeText);
            bracketIdParts.push(beforeText);

            const escapedChar = escapeHTML(originalChar);
            formattedParts.push(`<tg-emoji emoji-id="${entity.custom_emoji_id}">${escapedChar}</tg-emoji>`);
            rawIdParts.push(entity.custom_emoji_id);
            bracketIdParts.push(`[${entity.custom_emoji_id}]`);

            lastIndex = end;
        });

        const remainingText = escapeHTML(text.substring(lastIndex));
        formattedParts.push(remainingText);
        rawIdParts.push(remainingText);
        bracketIdParts.push(remainingText);

        const formattedText = formattedParts.join('');
        const rawIdText = rawIdParts.join('');
        const bracketIdText = bracketIdParts.join('');

        const replyMsg1 = `✨ <b>PHÁT HIỆN CUSTOM EMOJI PREMIUM!</b> ✨\n\n📝 <b>Giao diện trực quan:</b>\n${formattedText}`;
        const replyMsg2 = `📋 <b>Mẫu dán CMS (Dạng ID Thô):</b>\n<code>${rawIdText}</code>`;
        const replyMsg3 = `📋 <b>Mẫu dán CMS (Dạng ngoặc []):</b>\n<code>${bracketIdText}</code>`;
        
        let replyMsg4 = `🔍 <b>Danh sách ID lẻ:</b>\n`;
        const uniqueEmojis = new Map();
        detectedEmojis.forEach((item) => {
            if (!uniqueEmojis.has(item.id)) {
                uniqueEmojis.set(item.id, item.emoji);
            }
        });
        uniqueEmojis.forEach((emoji, id) => {
            const visualEmoji = `<tg-emoji emoji-id="${id}">${escapeHTML(emoji)}</tg-emoji>`;
            replyMsg4 += `- Ký tự ${visualEmoji}: <code>${id}</code>\n`;
        });

        try {
            if (replyMsg1.length > 4000) await ctx.reply(replyMsg1.substring(0, 4000) + '... (bị cắt do quá dài)', { parse_mode: 'HTML' });
            else await ctx.reply(replyMsg1, { parse_mode: 'HTML' });

            if (replyMsg2.length > 4000) await ctx.reply(replyMsg2.substring(0, 4000) + '...', { parse_mode: 'HTML' });
            else await ctx.reply(replyMsg2, { parse_mode: 'HTML' });

            if (replyMsg3.length > 4000) await ctx.reply(replyMsg3.substring(0, 4000) + '...', { parse_mode: 'HTML' });
            else await ctx.reply(replyMsg3, { parse_mode: 'HTML' });

            if (replyMsg4.length > 4000) await ctx.reply(replyMsg4.substring(0, 4000) + '...', { parse_mode: 'HTML' });
            else await ctx.reply(replyMsg4, { parse_mode: 'HTML' });
        } catch (e: any) {
            console.error('Lỗi khi gửi reply:', e);
            await ctx.reply('❌ Lỗi khi phản hồi: ' + e.message).catch(() => {});
        }
    } else {
        const replyMsg = `✅ <b>Đã nhận tin nhắn!</b>\n\nℹ️ Tin nhắn này không chứa Custom Emoji Premium. Chọn tính năng dưới bàn phím để thao tác.`;
        try {
            await ctx.reply(replyMsg, { parse_mode: 'HTML' });
        } catch (e: any) {
            console.error('Lỗi khi gửi reply:', e);
            await ctx.reply('❌ Lỗi khi phản hồi: ' + e.message).catch(() => {});
        }
    }
});

bot.telegram.setMyCommands([
    { command: 'start', description: 'Mở Menu Quản trị Bot' }
]).catch(console.error);

bot.launch().then(() => {
    console.log('🚀 Bot Admin (Check Emoji + Broadcast) đang chạy...');
}).catch(console.error);
