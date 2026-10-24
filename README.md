# Hệ thống Central Hub (WEB - BOT - API) - Hương MMO

Dự án quản lý bán hàng đa kênh, tích hợp Telegram Bot và nạp tiền tự động qua MB Bank.

## 1. Kiến trúc Cơ sở dữ liệu (Database Schema)

### 1.1. Bảng `users` (Quản lý định danh & Ví)
- `id`: Primary Key.
- `username` / `password_hash`: Đăng nhập Website.
- `telegram_id`: ID định danh trên Telegram (dùng cho Bot).
- `balance`: Số dư ví điện tử (Wallet).
- `api_key`: Khóa truy cập dành cho đối tác (Open API).

### 1.2. Bảng `products` & `product_items` (Kho hàng 1-N)
- `products`: Lưu tên sản phẩm, giá lẻ, giá sỉ (API), mô tả, trạng thái.
- `product_items`: Lưu nội dung tài khoản (`user|pass|key`).
- Trạng thái: `available` (Sẵn sàng), `sold` (Đã bán), `error` (Lỗi).

### 1.3. Bảng `orders` & `order_details` (Giao dịch)
- `orders`: Lưu thông tin thanh toán tổng, `payment_code` (Mã nạp/mua), `type` (`topup` hoặc `purchase`).
- `order_details`: Chi tiết các sản phẩm trong đơn (Quantity, Price).

### 1.4. Bảng `bank_history` (Đối soát)
- `id`, `transaction_id`, `amount`, `description`.

## 2. Luồng Nghiệp vụ (Full Flow)

### 2.1. Nạp tiền tự động (Wallet Top-up) & Mua trực tiếp
1. User chọn nạp tiền hoặc mua trực tiếp trên Bot.
2. Bot sinh (Generate) mã QR động chứa sẵn số tiền và nội dung chuyển khoản (mã ngẫu nhiên không có prefix nạp/rút).
3. Khách hàng quét mã QR để chuyển khoản.
4. Hệ thống kiểm tra giao dịch (qua Webhook hoặc API Polling) và cộng tiền hoặc xuất tài khoản tự động.

### 2.2. Mua hàng trên Telegram Bot
1. `/start` hoặc `/menu` -> Xem danh sách gói sản phẩm.
2. Chọn gói sản phẩm và Số lượng.
3. Xác nhận thanh toán (Trừ tiền ví -> Lock tài khoản -> Đổi trạng thái `sold`).
4. Bot gửi danh sách tài khoản cho khách hàng.

### 2.3. Open API (Đối tác)
- `GET /v1/public/products`: Lấy danh sách sản phẩm.
- `POST /v1/public/buy`: Mua hàng tự động qua API Key.

## 3. Thông tin bảo mật (Đã cấu hình)
- **Bank Acc**: 2902090904 (MB Bank).
- **Callback URL**: `https://api.cataishop.shop/api/v1/webhooks/callback`
- **Signature Key**: `5db0a2abdaeff6184cf6d5bc1c35f5a6`
- **API Token**: `c225ec97931fc451e02b64ca75cf4236`

## 4. Quản lý Server
- Thư mục backend: `/home/huong/web/cms.cataishop.shop/public_html/api-tele`
- Lệnh build & reload PM2:
  ```bash
  npm run build
  pm2 reload telehub-api
  ```
- Server chạy trên port 3000.
- Log file: `server.log`.
