# Messenger Playwright API

API cục bộ nhận URL group chat và nội dung qua JSON, sau đó dùng session Facebook đã
đăng nhập trong Playwright để gửi tin nhắn. Mật khẩu, URL group và nội dung tin nhắn
không được lưu trong source code hoặc `.env`.

## Cài đặt

Yêu cầu Node.js 20 trở lên.

```powershell
npm.cmd install
npx.cmd playwright install chromium
Copy-Item .env.example .env
```

## Đăng nhập lần đầu

```powershell
npm.cmd run messenger:login
```

Đăng nhập Facebook/Messenger và xử lý 2FA trong cửa sổ Chromium. Sau đó quay lại
terminal và nhấn Enter. Session được lưu tại `.playwright/messenger-profile`.

## Chạy API

```powershell
npm.cmd run api
```

Mặc định API chạy tại `http://127.0.0.1:3000`.

Gửi tin nhắn bằng PowerShell:

```powershell
$body = @{
  MESSENGER_CHAT_URL = 'https://www.messenger.com/t/ID_CUA_GROUP'
  MESSAGE_TEXT = 'Nội dung muốn gửi'
} | ConvertTo-Json

Invoke-RestMethod `
  -Method Post `
  -Uri 'http://127.0.0.1:3000/api/messages' `
  -ContentType 'application/json' `
  -Body $body
```

Hoặc bằng curl:

```powershell
curl.exe -X POST http://127.0.0.1:3000/api/messages `
  -H "Content-Type: application/json" `
  -d '{"MESSENGER_CHAT_URL":"https://www.messenger.com/t/ID_CUA_GROUP","MESSAGE_TEXT":"Hello"}'
```

Kết quả thành công:

```json
{"ok":true,"requestId":1,"message":"Đã gửi tin nhắn."}
```

Kiểm tra trạng thái API:

```powershell
Invoke-RestMethod http://127.0.0.1:3000/health
```

## Bảo mật và cấu hình

API mặc định chỉ nghe trên máy hiện tại (`127.0.0.1`). Nếu cần mở ra mạng LAN, đặt
`API_HOST=0.0.0.0` và bắt buộc thêm `API_KEY` trong `.env`, rồi gửi key bằng header:

```text
X-API-Key: your-api-key
```

Các request được xếp hàng và gửi tuần tự để không có hai Chromium cùng sử dụng một
profile. Script không vượt CAPTCHA, checkpoint hoặc 2FA.

## Chạy bằng Docker

Image dùng đúng Playwright `1.62.1` và đã có sẵn Chromium cùng các thư viện hệ thống.
Tạo file cấu hình rồi đặt một `API_KEY` đủ dài:

```bash
cp .env.example .env
mkdir -p .playwright/messenger-profile
```

Build và chạy API:

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f messenger-api
```

API chỉ được publish trên loopback của server tại `http://127.0.0.1:3001`. Kiểm tra:

```bash
curl http://127.0.0.1:3001/health
```

Thư mục `.playwright` được mount từ host để session Messenger không mất khi cập nhật
hoặc tạo lại container. Container production chạy `HEADLESS=true`, vì vậy cần chuẩn
bị profile đã đăng nhập trước khi gọi API gửi tin nhắn.
