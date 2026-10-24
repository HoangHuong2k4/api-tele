# Hướng Dẫn Xử Lý Lỗi & Thay Đổi Cấu Hình Ngân Hàng (Webhook & API)

Tài liệu này ghi chú lại các bước và câu lệnh cần thiết mỗi khi bạn **thay đổi API Token, Webhook của Ngân hàng** hoặc **gặp lỗi liên quan đến hệ thống quét thanh toán qua mã QR**. Áp dụng cho luồng từ CMS (Laravel) đến hệ thống Bot (API Tele).

---

## 1. Khi Nào Cần Chạy Các Lệnh Này?
- Khi bạn cập nhật **API Token** hoặc **Secret Key** mới trên thueapibank.vn và lưu vào CMS.
- Khi Webhook bên thứ 3 báo lỗi như `ACB_ACCOUNT_NOT_FOUND` hoặc ngưng hoạt động.
- Khi tiền của khách vào tài khoản ngân hàng nhưng Bot không tự động gạch nợ (treo trạng thái Pending).
- Sau khi thay đổi code hoặc cấu hình trong database mà chưa thấy hệ thống nhận.

---

## 2. Các Bước Xử Lý & Lệnh Cần Chạy

### Bước 1: Cập Nhật Phân Quyền Storage (CMS Laravel)
Đảm bảo hệ thống CMS không bị lỗi ghi log hoặc ghi cache do sai phân quyền.
Đứng tại thư mục gốc của CMS (`/home/huong/web/cms.cataishop.shop/public_html`) và chạy lệnh sau:

```bash
cd /home/huong/web/cms.cataishop.shop/public_html
sudo chmod -R 777 storage/
```

### Bước 2: Xóa Cache Của CMS
Sau khi thay đổi cấu hình Ngân Hàng trên giao diện CMS (như Token, Webhook url), bạn cần xóa bộ nhớ đệm (cache) để hệ thống nhận dữ liệu mới nhất:

```bash
cd /home/huong/web/cms.cataishop.shop/public_html
php artisan optimize:clear
```
*(Kết quả thành công sẽ hiển thị các dòng `DONE` cho config, cache, routes...)*

### Bước 3: Khởi Động Lại Hệ Thống Bot Telegram (API Tele)
Để Bot cập nhật ngay lập tức các Token mới (giúp chức năng Quét tự động 10 giây/lần hoạt động với Token mới), bạn cần restart lại Process của API qua PM2.
Di chuyển vào thư mục API và chạy lệnh restart:

```bash
cd /home/huong/web/cms.cataishop.shop/public_html/api-tele
pm2 restart telehub-api
```

### Bước 4: Kiểm Tra Lại Trạng Thái Hoạt Động (Log)
Để chắc chắn Bot đang quét đúng Token mới và hoạt động trơn tru:

```bash
cd /home/huong/web/cms.cataishop.shop/public_html/api-tele
pm2 logs telehub-api --lines 50
```
- Nếu thấy thông báo `🔄 Đang tải cấu hình Bot từ Database...` và `✅ Đã đồng bộ...`, tức là Bot đã nhận token.
- Đợi khoảng 10 giây, nếu có đơn Pending thì log sẽ hiện `[Bank] [tenant=...] tx=... committed ✅` là thành công.
- Nhấn `Ctrl + C` để thoát màn hình xem log.

---

## 3. Cơ Chế Hoạt Động Của Hệ Thống (Bảo Vệ 2 Lớp)
Hiện tại hệ thống đang được cấu hình bảo vệ đơn hàng của khách qua **2 lớp**:

1. **Lớp 1 - Webhook Realtime:** Khi có giao dịch, ngân hàng (thueapibank) sẽ bắn webhook (POST) trực tiếp vào link Callback của mình. Bot sẽ xử lý ngay tức thì (độ trễ 1-2 giây).
2. **Lớp 2 - Auto Polling (Quét Tự Động):** Trong trường hợp Webhook của bên cung cấp bị lỗi/bảo trì, hệ thống API Tele của chúng ta có một Cronjob chạy ngầm **10 giây 1 lần**. Vòng lặp này sẽ dùng API Token để gọi lên hệ thống của họ để "đòi" lịch sử giao dịch. Nếu phát hiện đơn đang Pending trùng khớp với giao dịch, nó sẽ tự động gạch nợ.

**LƯU Ý QUAN TRỌNG:**
Khi API Token của bạn hết hạn hoặc bị lỗi, chức năng **Lớp 2 (Quét Tự Động)** sẽ bị vô hiệu hóa tạm thời. Do đó, ngay khi thay Token mới trên giao diện CMS, bạn PHẢI làm theo **Bước 2** (Xóa Cache) và **Bước 3** (Restart PM2) ở trên để Bot lấy cấu hình mới nhất và kích hoạt lại chức năng này!
