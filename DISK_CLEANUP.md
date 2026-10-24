# 🧹 Hướng Dẫn Dọn Dẹp Ổ Đĩa & PM2 Logs

> **Triệu chứng bot không hoạt động**: Ổ đĩa đầy → MySQL không ghi được temp table → Bot crash.

---

## 1. Kiểm tra dung lượng ổ đĩa

```bash
# Xem tổng quan ổ đĩa
df -h

# Xem các thư mục lớn nhất trong /var/log
du -sh /var/log/* | sort -rh | head -20

# Xem PM2 logs lớn nhất
du -sh /root/.pm2/logs/* | sort -rh | head -20

# Xem storage Laravel
du -sh /home/huong/web/*/public_html/storage | sort -rh | head -10
```

---

## 2. Dọn dẹp PM2 logs (nhanh nhất, hiệu quả nhất)

```bash
# Xóa toàn bộ PM2 logs (giải phóng nhiều GB)
pm2 flush

# Kiểm tra lại dung lượng sau khi flush
df -h /dev/vda1
```

---

## 3. Dọn dẹp Journal logs hệ thống

```bash
# Xóa journal logs cũ hơn 7 ngày
journalctl --vacuum-time=7d

# Hoặc giới hạn dung lượng journal tối đa 200MB
journalctl --vacuum-size=200M
```

---

## 4. Dọn dẹp Nginx logs cũ

```bash
# Xem nginx logs
du -sh /var/log/nginx/*

# Xóa access log cũ (nén lại)
gzip /var/log/nginx/*.log.1 2>/dev/null || true
```

---

## 5. Cài đặt PM2 Log Rotate (chỉ cần chạy 1 lần)

```bash
# Cài module tự động rotate logs
pm2 install pm2-logrotate

# Config: mỗi file tối đa 100MB
pm2 set pm2-logrotate:max_size 100M

# Giữ tối đa 7 ngày log
pm2 set pm2-logrotate:retain 7

# Nén file log cũ
pm2 set pm2-logrotate:compress true

# Xem cấu hình hiện tại
pm2 conf pm2-logrotate
```

---

## 6. Kiểm tra process crash nhiều lần

```bash
# Xem danh sách tất cả process
pm2 list

# Xem log process đang crash (thay tên process)
pm2 logs telehub-emoji-checker --lines 50 --nostream

# Restart process bị lỗi
pm2 restart telehub-emoji-checker
```

---

## 7. Script dọn dẹp nhanh (chạy 1 lệnh)

```bash
# Chạy lệnh này khi ổ đĩa đầy
pm2 flush && journalctl --vacuum-time=7d && df -h /dev/vda1
```

---

## 8. Theo dõi real-time

```bash
# Xem log bot telegram real-time
pm2 logs telehub-api --lines 30

# Xem log lỗi real-time
pm2 logs telehub-api --err --lines 30

# Dashboard PM2
pm2 monit
```

---

## ⚠️ Ngưỡng cảnh báo

| Mức dùng | Trạng thái | Hành động |
|----------|-----------|-----------|
| < 70%    | ✅ Bình thường | Không cần làm gì |
| 70–85%   | ⚠️ Cảnh báo   | Chạy `pm2 flush` |
| 85–95%   | 🔴 Nguy hiểm  | Flush + dọn journal |
| > 95%    | 🚨 Khẩn cấp   | Bot sẽ crash! Dọn ngay! |

---

*Cập nhật: 2026-08-31 | Server: cp.phh.info.vn*
