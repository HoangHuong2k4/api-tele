# Telehub API — System Guide

> Node.js + TypeScript · Express · MySQL · Telegraf · PM2  
> Cập nhật: 2026-08-07

---

## 1. Tổng quan kiến trúc

```
┌─────────────────────────────────────────────────────────────┐
│                        INTERNET                             │
│  Telegram Bot API  │  Bank Webhook  │  CMS / Admin Panel    │
└────────┬───────────┴───────┬────────┴──────────┬────────────┘
         │                   │                   │
         ▼                   ▼                   ▼
┌────────────────────────────────────────────────────────────┐
│              Express HTTP Server  (:3030)                   │
│                                                            │
│  POST /api/v1/webhooks/telegram/:tenantId/:tokenHash       │
│  POST /api/v1/webhooks/callback          (TPB, MB)         │
│  POST /api/v1/webhooks/callback-mb       (MB)              │
│  POST /api/v1/webhooks/callback-acb      (ACB)             │
│  GET  /api/v1/admin/reload               (hot-reload bots) │
│  /api/v1/auth  /products  /orders  /dealer  /admin         │
└───────┬──────────────────┬──────────────────┬──────────────┘
        │                  │                  │
        ▼                  ▼                  ▼
 TelegramService      BankService       CryptoService
 (Telegraf bots)   (QR bank payments) (Binance USDT)
        │                  │                  │
        └──────────────────┴──────────────────┘
                           │
                           ▼
                    MySQL Database
                   (huong_bot_tele)
```

### Dịch vụ nội bộ bổ sung: payment-service (Docker)
```
payment-service/  (Docker Compose, port 3006)
  ├── app      — NestJS: quét giao dịch ACB/MB tự động
  ├── redis    — Redis queue cho bank scanner
  └── captcha-resolver — Giải captcha ngân hàng tự động
```
`telehub-api` tự động fallback về `http://localhost:3006/payments`
khi `thueapibank.vn` bị lỗi/Cloudflare 522.

### Multi-tenant
Mỗi **tenant** (shop) có một bộ cấu hình riêng trong bảng `telehub_bot_configs`:
- Bot token Telegram riêng
- Tài khoản ngân hàng riêng
- Ví USDT riêng
- Admin Telegram riêng

---

## 2. Cấu trúc thư mục

```
api-tele/
├── src/
│   ├── index.ts              # Entry point — Express + cron intervals
│   ├── config/
│   │   ├── db.ts             # MySQL connection pool (mysql2)
│   │   ├── logger.ts         # Winston logger (daily rotate, /logs)
│   │   └── tables.ts         # DB table name constants
│   ├── routes/
│   │   ├── webhook.routes.ts # Bank webhook routes
│   │   ├── admin.routes.ts   # JWT-protected admin API
│   │   ├── auth.routes.ts    # Dealer auth (login/register)
│   │   ├── product.routes.ts # Public product listing (dealer API)
│   │   ├── order.routes.ts   # Dealer order placement
│   │   └── dealer.routes.ts  # Dealer management
│   ├── controllers/
│   │   ├── webhook.controller.ts  # Bank webhook handling
│   │   └── admin.controller.ts    # Admin CRUD
│   ├── middleware/
│   │   └── admin.middleware.ts    # JWT + role check
│   ├── services/
│   │   ├── telegram.service.ts    # Core bot logic (~2050 lines)
│   │   ├── bank.service.ts        # Bank transaction processing
│   │   ├── crypto.service.ts      # Binance USDT deposit check
│   │   └── i18n.service.ts        # Multi-language (vi/en)
│   └── locales/
│       ├── vi.json           # Vietnamese strings
│       └── en.json           # English strings
├── payment-service/          # Docker: quét ngân hàng nội bộ
│   ├── docker-compose.yml    # app + redis + captcha-resolver
│   └── config/config.yml     # Cấu hình bank account
├── dist/                     # Compiled JS (tsc output)
├── logs/                     # Winston log files (gitignored)
├── .env                      # Environment variables
├── package.json
└── tsconfig.json
```

---

## 3. Cấu hình môi trường (.env)

| Biến | Mô tả |
|------|-------|
| `DB_HOST` | MySQL host (thường `localhost`) |
| `DB_PORT` | MySQL port (mặc định `3306`) |
| `DB_NAME` | Database name |
| `DB_USER` | DB username |
| `DB_PASS` | DB password |
| `PORT` | HTTP port (mặc định `3030`) |
| `RELOAD_SECRET` | Secret để trigger hot-reload bot qua API |
| `WEBHOOK_SIGNATURE_KEY` | (optional) Global webhook signature |
| `MBBANK_API_TOKEN` | (optional) MB Bank API token |
| `TABLE_PREFIX` | Prefix bảng DB (mặc định `telehub_`) |

---

## 4. Database Schema

### `telehub_bot_configs` — Cấu hình mỗi tenant
| Cột | Mô tả |
|-----|-------|
| `tenant_id` | ID tenant (PK) |
| `bot_token` | Telegram bot token (bot bán hàng) |
| `telegram_notification_id` | Token bot thông báo (nếu dùng bot riêng) |
| `telegram_admin_id` | Chat ID admin nhận thông báo |
| `bank_code` | Mã ngân hàng: `TPB`, `MB`, `ACB`, `VTLMONEY` |
| `bank_num` | Số tài khoản ngân hàng |
| `bank_account_name` | Tên chủ tài khoản |
| `bank_api_token` | Token API ngân hàng (ThueApiBank) |
| `webhook_signature` | Signature để nhận diện webhook |
| `binance_api_key` | Binance API key |
| `binance_secret_key` | Binance secret key |
| `binance_pay_id` | Binance Pay ID (UID nhận tiền nội bộ qua Binance Pay) |
| `usdt_wallet_address` | Địa chỉ ví USDT nhận tiền |
| `usdt_network` | Mạng USDT: `BSC`, `TRC20`, ... |
| `usdt_exchange_rate` | Tỷ giá USDT/VNĐ |
| `welcome_message` | Tin nhắn chào tiếng Việt |
| `welcome_message_en` | Tin nhắn chào tiếng Anh |
| `status` | `published` / `draft` |

### `telehub_bot_customers` — Khách hàng
| Cột | Mô tả |
|-----|-------|
| `id` | PK |
| `tenant_id` | Thuộc tenant nào |
| `telegram_id` | Telegram user ID (string) |
| `full_name` | Tên đầy đủ |
| `username` | @username |
| `balance` | Số dư ví (VNĐ) |
| `language` | `vi` / `en` |
| `is_dealer` | Có phải CTV không |
| `api_key` | API key CTV (prefix `DLR_`) |

### `telehub_products` — Sản phẩm
| Cột | Mô tả |
|-----|-------|
| `id` | PK |
| `tenant_id` | Thuộc tenant |
| `name` | Tên sản phẩm (tiếng Việt) |
| `name_en` | Tên tiếng Anh |
| `icon` | Emoji hoặc Custom Emoji ID (số 19 chữ số) |
| `price` | Giá lẻ (VNĐ) |
| `price_usd` | Giá USD (override auto-convert nếu set) |
| `description` | Mô tả sản phẩm (hỗ trợ markdown + emoji ID) |
| `status` | `published` / `draft` |

### `telehub_product_items` — Kho tài khoản
| Cột | Mô tả |
|-----|-------|
| `id` | PK |
| `product_id` | FK → products |
| `tenant_id` | FK tenant |
| `username` | Username tài khoản |
| `password` | Password tài khoản |
| `note` | Ghi chú (recovery email, link, ...) |
| `is_sold` | 0 = còn hàng, 1 = đã bán |
| `order_id` | FK → orders (khi đã bán) |
| `customer_id` | FK → customers (khi đã bán) |
| `reserved_until` | Thời điểm hết hạn tạm giữ (NULL = tự do) |
| `reserved_by` | Key người đang giữ slot (vd: `tg_123456`, `qr_789`) |

### `telehub_deposit_requests` — Yêu cầu nạp tiền
| Cột | Mô tả |
|-----|-------|
| `id` | PK |
| `tenant_id` | FK tenant |
| `customer_id` | FK customer |
| `amount` | Số tiền VNĐ |
| `usdt_amount` | Số USDT (nếu thanh toán USDT) |
| `payment_code` | Mã 12 ký tự ngẫu nhiên (nội dung CK) |
| `product_id` | Nếu là mua hàng kèm nạp |
| `quantity` | Số lượng mua |
| `combo_id` | FK → product_combos |
| `bonus_qty` | Số acc tặng thêm (từ combo) |
| `status` | `pending` / `success` / `failed` / `completed` |

### `telehub_bank_webhooks` — Log webhook ngân hàng
| Cột | Mô tả |
|-----|-------|
| `tran_id_bank` | Mã giao dịch ngân hàng (unique) |
| `amount` | Số tiền |
| `description` | Nội dung giao dịch |
| `raw_json` | Payload gốc từ webhook |

### `telehub_balance_logs` — Lịch sử số dư
| Cột | Mô tả |
|-----|-------|
| `type` | `IN` (nạp) / `OUT` (mua) / `deposit` |
| `amount` | Số tiền |
| `note` | Mô tả giao dịch |
| `order_id` | FK → orders (nếu là mua hàng) |

### `telehub_product_combos` — Combo khuyến mãi
| Cột | Mô tả |
|-----|-------|
| `product_id` | FK → products |
| `min_quantity` | Số lượng tối thiểu để áp dụng |
| `type` | `discount` hoặc `bonus` |
| `discount_percent` | Giảm % (nếu type=discount) |
| `discount_amount` | Giảm tiền/acc (nếu type=discount) |
| `bonus_qty` | Số acc tặng thêm (nếu type=bonus) |
| `label` | Nhãn hiển thị (tuỳ chọn) |
| `is_active` | 0/1 |

### `telehub_dealer_prices` — Giá CTV
| Cột | Mô tả |
|-----|-------|
| `customer_id` | FK → customers |
| `product_id` | FK → products |
| `price` | Giá CTV override (VNĐ) |
| `price_usd` | Giá CTV override (USD) |

---

## 5. Luồng chính

### 5.1 Khởi động

```
pm2 start dist/index.js (telehub-api)
        │
        ├─► TelegramService.initAllBots()
        │       └─► Đọc telehub_bot_configs WHERE status="published"
        │           Tạo Telegraf instance mỗi tenant
        │           Set webhook: https://api.cataishop.shop/api/v1/webhooks/telegram/{tenantId}/{tokenHash}
        │
        ├─► TelegramService.startReservationCleanupJob()  ← MỚI
        │       └─► setInterval: mỗi 60s dọn dẹp reserved_until < NOW()
        │
        ├─► setInterval(bankService.cleanupExpiredRequests, 60s)
        ├─► setInterval(bankService.syncAllBanks, 10s)
        └─► setInterval(cryptoService.syncAllBinance, 20s)
```

### 5.2 Luồng Telegram Bot (User tương tác)

```
User gửi tin nhắn/nhấn nút
        │
        ▼
Telegram → POST /api/v1/webhooks/telegram/{tenantId}/{tokenHash}
        │
        ▼
TelegramService.handleUpdate(tenantId, update)
        │
        ├─► Middleware 1: Log message
        ├─► Middleware 2: Hot-reload config từ DB
        ├─► Middleware 3: Auto-register user (INSERT ... ON DUPLICATE KEY UPDATE)
        │
        ├─► /start     → Gửi welcome message + keyboard menu + chọn ngôn ngữ
        ├─► Text menu  → bot.hears() dispatch đến handler tương ứng
        └─► Callback   → dispatchCallback() → router theo data prefix:
                          balance/history/deposit/menu/cancel/get_api
                          setlang_*   → đổi ngôn ngữ
                          buy_{id}    → handlePurchaseInitiation
                          confirm_*   → handlePurchaseConfirmation (+ reserve slot 5 phút)
                          genqr_*     → handleGenQRFlow (tạo QR VietQR + reserve slot 5 phút)
                          genusdt_*   → handleGenUSDTFlow (tạo lệnh USDT + reserve slot 5 phút)
                          pay_*       → handleWalletPayment (thanh toán ví, dùng slot đã reserve)
                          cancelqr_*  → huỷ deposit request + giải phóng slot reserve
```

### 5.3 Luồng Tạm Giữ Hàng (Stock Reservation) ← MỚI

```
MỤC ĐÍCH: Tránh race condition khi nhiều người cùng mua cùng lúc
hoặc nhiều người cùng nhận thông báo restock rồi cùng chuyển tiền.

Bước 1 — Xem màn hình xác nhận (confirm_*):
  - Đếm stock TỰ DO: is_sold=0 AND (reserved_until IS NULL OR reserved_until < NOW())
  - Nếu không đủ → báo "Hết hàng" ngay lập tức
  - Nếu đủ → reserveStock(tenantId, productId, qty, "tg_{tgId}", 5 phút)

Bước 2 — Tạo QR hoặc USDT (genqr_*, genusdt_*):
  - Kiểm tra stock tự do (đã trừ slot đang reserve)
  - Nếu không đủ → báo "Hết hàng" ngay, không tạo QR
  - Nếu đủ → reserveStock(tenantId, productId, qty, "qr_{userId}", 5 phút)
                       hoặc       ("usdt_{userId}", 5 phút)

Bước 3 — Thanh toán thành công:
  - handleDirectPurchase() ưu tiên lấy slot đã reserve của user
  - UPDATE product_items SET is_sold=1, reserved_by=NULL, reserved_until=NULL

Bước 4 — Hủy đơn (cancelqr_*):
  - UPDATE deposit_requests SET status="failed"
  - releaseReservation() → SET reserved_by=NULL, reserved_until=NULL

Bước 5 — Cleanup tự động (mỗi 60 giây):
  - UPDATE product_items SET reserved_by=NULL, reserved_until=NULL
    WHERE reserved_until < NOW() AND is_sold=0
```

### 5.4 Luồng Thanh toán QR (Ngân hàng)

```
User nhấn "Chuyển khoản QR"
        │
        ▼
handleGenQRFlow()
  1. Kiểm tra stock tự do, nếu đủ → reserve slot 5 phút
  2. Tạo payment_code (12 ký tự random, ví dụ: ABCD3F9HKLMN)
  3. INSERT telehub_deposit_requests (status=pending, payment_code, amount, product_id, ...)
  4. Tạo URL QR: https://img.vietqr.io/image/{bankCode}-{bankNum}-compact.png
                  ?amount={amount}&addInfo={code}&accountName={name}
  5. Gửi ảnh QR cho user kèm nút "Huỷ đơn"
        │
        ▼
Khách chuyển khoản nội dung: ABCD3F9HKLMN
        │
  ┌─────┴──────────────────────────────────────────────────────┐
  │ Cách 1: Webhook ngân hàng (realtime)                       │
  │ Cách 2: Polling payment-service nội bộ localhost:3006 (10s)│
  │ Cách 3: Polling thueapibank.vn (10s, fallback khi 1+2 lỗi)│
  └─────┬──────────────────────────────────────────────────────┘
        │
        ▼
BankService.processTransaction(tx, config)
  1. Kiểm tra trùng: tran_id_bank OR (description + amount) đã xử lý chưa
  2. Tìm payment_code trong nội dung giao dịch:
     - Bước 1: Regex legacy prefix (nap/mua + code)
     - Bước 2: Scan token alphanumeric 6-16 ký tự → match Set pending codes
     - Bước 2b: Nếu không tìm thấy, kiểm tra desc có chứa mã đã success không
                → Nếu có → bỏ qua (tránh gạch nhầm sang đơn pending khác)
  3. Fallback auto-match: nếu không tìm thấy mã → match theo số tiền + thời gian
     (chỉ chạy khi desc KHÔNG chứa bất kỳ mã nào đã xử lý)
  4. Nếu không tìm thấy → lưu log + notify admin "GIAO DỊCH KHÔNG KHỚP MÃ"
  5. Nếu tìm thấy → BEGIN TRANSACTION:
     - INSERT bank_webhooks
     - UPDATE customers SET balance = balance + amount
     - UPDATE deposit_requests SET status = "success"
     - INSERT balance_logs (type=IN)
     - COMMIT
  6. Post-commit:
     - Nếu có product_id → processAutomatedPurchase() (ưu tiên slot đã reserve)
     - Nếu nạp ví thuần → notifyUser + notifyAdmin
```

### 5.5 Luồng Thanh toán USDT (Binance On-Chain & Binance Pay)

```
User nhấn "Thanh toán USDT"
        │
        ▼
handleGenUSDTFlow()
  1. Kiểm tra stock tự do, nếu đủ → reserve slot 5 phút
  2. Tính usdtAmount = amountVnd / exchangeRate
  3. Thêm fraction ngẫu nhiên để sinh số tiền độc nhất
     (ví dụ: 2.06990 USDT)
  4. INSERT telehub_deposit_requests (usdt_amount=2.06990, ...)
  5. Gửi tin nhắn hướng dẫn hỗ trợ 2 hình thức:
     - Cách 1: Qua Binance Pay (UID Binance, miễn phí gas)
     - Cách 2: Qua ví Blockchain (BSC/BEP20, ...)
     - Số USDT chính xác cần chuyển (copy được)
        │
        ▼
Khách chuyển đúng số USDT (bằng Binance Pay hoặc ví On-chain)
        │
        ▼
CryptoService (polling 20s)
  1. Với mỗi tenant có pending USDT requests:
  2. Lấy timestamp từ Binance server (bù clock drift)
  3. Quét song song 2 kênh:
     - Kênh On-Chain: GET /sapi/v1/capital/deposit/hisrec
     - Kênh Binance Pay: GET /sapi/v1/pay/transactions
  4. Tổng hợp danh sách giao dịch (unified transactions):
     - So khớp chính xác số tiền lẻ < 0.000005 USDT (hoặc fallback 2 số thập phân >= 2.0 USDT)
     - Kiểm tra txId/orderId chưa xử lý (tránh duplicate)
  5. Nếu khớp → processDeposit():
     - BEGIN TRANSACTION:
       UPDATE deposit_requests status="completed"
       UPDATE customers balance += amount
       INSERT balance_logs (type=deposit, note: Nạp qua Binance Pay hoặc USDT On-chain)
       COMMIT
     - Post-commit: notifyUser + (processAutomatedPurchase hoặc notifyAdmin)
```

### 5.6 Luồng Mua hàng bằng Ví (Wallet Payment)

```
User nhấn "💳 Thanh toán Ví"
        │
        ▼
handleWalletPayment()
  └─► handleDirectPurchase(reservedBy="tg_{tgId}") — DB Transaction:
        1. SELECT balance ... FOR UPDATE  (lock row)
        2. SELECT price, name FROM products
        3. SELECT price FROM dealer_prices (giá CTV nếu có)
        4. Ưu tiên lấy slot đã reserved_by = "tg_{tgId}" trước
        5. Nếu không đủ → lấy thêm slot TỰ DO (reserved_until < NOW())
        6. LIMIT totalQty FOR UPDATE SKIP LOCKED
        7. Kiểm tra: balance >= total, stock >= totalQty
        8. UPDATE customers SET balance = balance - total
        9. INSERT telehub_orders
       10. INSERT balance_logs (type=OUT)
       11. UPDATE product_items SET is_sold=1, reserved_by=NULL, reserved_until=NULL
       12. INSERT telehub_order_details (combo tracking)
       13. COMMIT
        │
        ▼
  sendSuccessDelivery():
    - Gửi tin nhắn kèm danh sách tài khoản (định dạng <code>)
    - Nếu qty > 5 → gửi thêm file .txt (deliveryAsFile)
    - notifyAdmin: chi tiết đơn hàng
```

### 5.7 Luồng Mua hàng Tự động (sau khi thanh toán QR/USDT)

```
processAutomatedPurchase(tenantId, customerId, productId, quantity, code, comboId, bonusQty)
  1. Lấy thông tin user, sản phẩm, giá CTV
  2. Nếu có comboId → applyCombo() → tính giá cuối + bonusQty
  3. handleDirectPurchase(reservedBy="qr_{customerId}")
     → Ưu tiên slot đã reserve khi tạo QR/USDT
  4. Nếu thành công:
     - sendSuccessDelivery() → user nhận tài khoản
     - notifyAdmin: phương thức thanh toán + danh sách acc
  5. Nếu thất bại (hết hàng, cạn số dư):
     - notifyUser lỗi (i18n)
     - notifyAdmin để xử lý thủ công
```

---

## 6. Hệ thống Combo

Combo được apply **tự động** khi user xác nhận mua:

```
getBestCombo(combos, qty, price):
  → Lọc combo có min_quantity <= qty
  → Quy đổi lợi ích về tiền (effectiveDiscount):
    • type=bonus:    effectiveDiscount = bonus_qty * price/acc
    • type=discount_percent: effectiveDiscount = qty * price * percent%
    • type=discount_amount:  effectiveDiscount = qty * discount/acc
  → Chọn combo có effectiveDiscount lớn nhất

applyCombo(combo, qty, price):
  → Trả về: { total, actualQty, bonusQty, finalPricePerAcc, discountText }
```

---

## 7. Webhook ngân hàng

### Endpoint chung (TPB, MB)
```
POST /api/v1/webhooks/callback
POST /api/v1/webhooks/callback-mb
```
Tenant nhận dạng qua header `x-api-key` / `signature` → match `webhook_signature` trong DB.

### Endpoint ACB
```
POST /api/v1/webhooks/callback-acb?token={token}
```
Tenant nhận dạng qua `?token=` hoặc header `signature` → match `bank_api_token` hoặc `webhook_signature` WHERE `bank_code='ACB'`.

### Fallback (không có signature)
Nếu không tìm được tenant qua signature:
1. Parse payment code trong `description`
2. Tìm `tenant_id` từ `telehub_deposit_requests`
3. Xử lý tiếp với config của tenant đó

---

## 8. Polling ngân hàng (fallback chain)

**Ưu tiên theo thứ tự:**

| Ưu tiên | Nguồn | Mô tả |
|---------|-------|-------|
| 1 | Webhook (realtime) | Bank gửi trực tiếp vào callback |
| 2 | `localhost:3006` (payment-service Docker) | Quét ACB nội bộ, luôn online |
| 3 | `thueapibank.vn` (ThueApiBank) | API bên ngoài, fallback khi cần |

**Cấu hình payment-service Docker:**
```bash
cd /home/huong/web/cms.cataishop.shop/public_html/api-tele/payment-service
docker compose up -d   # restart: always → tự khởi động khi VPS reboot
```

**ThueApiBank URLs:**
| Bank | URL |
|------|-----|
| TPB | `https://thueapibank.vn/historyapitpbv2/{token}` |
| VTLMONEY | `https://thueapibank.vn/historyapiviettelv2/{token}` |
| MB | `https://thueapibank.vn/historyapimbv2/{token}` |
| ACB | `https://thueapibank.vn/historyapiacbv2/{token}` |

---

## 9. Hot-reload Bot

Khi CMS thay đổi cấu hình (bot token, admin ID):

```
GET /api/v1/admin/reload?secret={RELOAD_SECRET}
  → TelegramService.initAllBots()
    - So sánh token/adminId với bots đang chạy
    - Nếu thay đổi → stopBot() → initBot() (đăng ký webhook mới)
    - Nếu bot mới → initBot()
    - Nếu bot bị xoá khỏi DB → stopBot()
```

---

## 10. Logs

Winston logger với daily rotate, lưu tại `/logs/`:

| File | Nội dung |
|------|----------|
| `application-YYYY-MM-DD.log` | Tất cả INFO trở lên |
| `error-YYYY-MM-DD.log` | Chỉ ERROR |

Rotate: giữ 30 ngày, nén file cũ (.gz).

---

## 11. Bảo mật

- Admin API: JWT Bearer token + `adminMiddleware` kiểm tra role
- Webhook signature: mỗi tenant có `webhook_signature` riêng
- Bot webhook: URL chứa `tokenHash` (MD5 8 ký tự của bot token) — chống replay từ URL cũ
- Binance: HMAC-SHA256 signature + recvWindow=60000ms + clock drift correction
- Payment code: 12 ký tự random crypto (`ABCDEFGHJKLMNPQRSTUVWXYZ23456789`)
- USDT identification: thêm fraction ngẫu nhiên (0.001~0.009) vào số USDT
- DB: Tất cả thanh toán dùng `BEGIN TRANSACTION ... FOR UPDATE` để tránh race condition
- Stock reservation: slot được tạm giữ 5 phút, ngăn 2 người mua cùng 1 acc cuối

---

## 12. PM2 Processes

| ID | Name | Mô tả |
|----|------|-------|
| 0 | `telehub-api` | API chính (src/index.ts) |
| 1 | `telehub-cms-queue-worker` | Xử lý queue từ CMS |
| 2 | `toolfb-queue-worker` | Worker tool Facebook |
| 3 | `telehub-emoji-checker` | Kiểm tra emoji bot |
| 4 | `telehub-emoji-checker-2` | Kiểm tra emoji bot (v2) |
| 5 | `email-inbox-phhuong` | Inbox email |

### Restart sau khi deploy:
```bash
npm run build
pm2 restart telehub-api
```

### Docker payment-service (quét ngân hàng nội bộ):
```bash
cd payment-service
docker compose up -d    # khởi động
docker compose ps       # kiểm tra trạng thái
docker compose logs -f  # xem log
```

---

## 13. Cron hệ thống (crontab root)

```cron
# Sync đồng hồ VPS với Binance server mỗi 5 phút (tránh HTTP 400 do clock drift)
*/5 * * * * BINANCE_MS=$(curl -s https://api.binance.com/api/v3/time 2>/dev/null | grep -o '[0-9]\{13\}'); \
            [ -n "$BINANCE_MS" ] && date -s "@$((BINANCE_MS / 1000))" > /dev/null 2>&1
```

---

## 14. Changelog gần đây (2026-08)

| Ngày | Thay đổi |
|------|---------|
| 2026-08-07 | **Stock Reservation System**: Tạm giữ slot 5 phút khi xem màn hình xác nhận / tạo QR / tạo USDT. Tránh race condition khi nhiều người mua cùng lúc. |
| 2026-08-07 | **Fix double-match bug**: Thêm kiểm tra nội dung giao dịch có chứa mã đã `success` trước khi chạy auto-match theo số tiền. Thêm dedup theo `(description + amount)`. |
| 2026-08-07 | **notifyAdmin 429 retry**: Tự động chờ và gửi lại khi bị Telegram rate limit. |
| 2026-08-07 | **payment-service Docker**: Khởi động nội bộ quét ACB/MB với `restart: always`. `bank.service.ts` tự fallback về `localhost:3006` khi `thueapibank.vn` timeout. |
| 2026-08-01 | **Giá USD ($)**: Thêm cột `price_usd` vào products và dealer_prices. Bot hiển thị giá USD. |
