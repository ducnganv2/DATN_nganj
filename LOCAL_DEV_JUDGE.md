# Hydro Local Dev + Docker Judge

Hướng dẫn này dùng cho workflow:

- Frontend + Backend chạy local từ source
- Judge chạy riêng bằng Docker

## 1. Điều kiện cần có

- Node.js 22
- Docker Desktop đang chạy Linux containers
- MongoDB local đang chạy

Nếu chưa có Mongo local, chạy nhanh bằng Docker:

```powershell
docker run -d --name hydro-mongo -p 27017:27017 mongo:7-jammy
```

## 2. Cài dependency

Trong repo:

```powershell
cd C:\DATN\test\Hydro-master
corepack yarn install
```

## 3. Tạo config local cho Hydro

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.hydro" | Out-Null
'{"url":"mongodb://localhost:27017/hydro"}' | Set-Content "$env:USERPROFILE\.hydro\config.json"
'["@hydrooj/ui-default"]' | Set-Content "$env:USERPROFILE\.hydro\addon.json"
```

## 4. Chạy FE + BE local

```powershell
cd C:\DATN\test\Hydro-master
corepack yarn dev:judge
```

Script này sẽ:

- chạy backend ở `0.0.0.0:2333`
- chạy frontend dev server ở `localhost:8000`
- watch source để sửa code xong thay đổi sẽ được nạp lại

Mở web để làm việc:

- Frontend dev: `http://localhost:8000`
- Backend trực tiếp: `http://127.0.0.1:2333`

Kiểm tra backend đã lên chưa:

```powershell
curl http://127.0.0.1:2333/status
```

## 5. Chạy judge bằng Docker

Mở terminal khác:

```powershell
cd C:\DATN\test\Hydro-master\install\docker
docker compose -f docker-compose.local-judge.yml up -d --build
docker logs -f oj-judge-local
```

Judge Docker đã được cấu hình sẵn ở:

- `install/docker/docker-compose.local-judge.yml`
- `install/docker/judge/judge.local.yaml`

Judge sẽ kết nối vào backend local qua:

- `http://host.docker.internal:2333/`

## 6. Tạo tài khoản judge lần đầu

Nếu log judge báo lỗi `UserNotFoundError` hoặc không tìm thấy user `judge`, tạo user bằng CLI.

Chạy trong repo:

```powershell
cd C:\DATN\test\Hydro-master
node packages\hydrooj\bin\hydrooj.js cli user create systemjudge@systemjudge.local judge examplepassword auto
```

Lệnh này sẽ in ra UID mới. Ví dụ: `3`

Sau đó gán quyền judge:

```powershell
node packages\hydrooj\bin\hydrooj.js cli user setJudge 3
```

Nếu UID in ra không phải `3`, thay `3` bằng UID thật.

Không ép UID = `2` nếu DB local của bạn đã có user khác dùng UID đó.

Sau khi tạo xong, restart judge:

```powershell
cd C:\DATN\test\Hydro-master\install\docker
docker restart oj-judge-local
docker logs -f oj-judge-local
```

## 7. Cách chạy hằng ngày

Mỗi lần:

1. Đảm bảo Mongo đang chạy
2. Chạy FE + BE local:

```powershell
cd C:\DATN\test\Hydro-master
corepack yarn dev:judge
```

3. Mở terminal khác, chạy judge Docker:

```powershell
cd C:\DATN\test\Hydro-master\install\docker
docker compose -f docker-compose.local-judge.yml up -d
```

4. Mở trình duyệt:

- `http://localhost:8000`

## 8. Dừng hệ thống

Dừng FE + BE local:

- nhấn `Ctrl + C` ở terminal đang chạy `corepack yarn dev:judge`

Dừng judge Docker:

```powershell
cd C:\DATN\test\Hydro-master\install\docker
docker compose -f docker-compose.local-judge.yml down
```

## 9. Lỗi hay gặp

### Submission bị `0 Waiting`

Nguyên nhân thường là:

- judge Docker chưa chạy
- backend local chưa chạy
- backend không mở ở cổng `2333`

Kiểm tra:

```powershell
curl http://127.0.0.1:2333/status
docker logs -f oj-judge-local
```

### `connect ECONNREFUSED ...:2333`

Judge Docker không kết nối được vào backend local.

Thường do:

- chưa chạy `corepack yarn dev:judge`
- backend local bị tắt
- cổng `2333` chưa mở

### `UserNotFoundError: User judge not found`

DB local chưa có user `judge`. Làm lại mục 6.

### `No replica set found.`

Chỉ là log thông báo của Mongo trong local dev. Không phải lỗi chặn chấm bài.

### `sandbox version is vulnerable to symlink escape issue`

Đây là cảnh báo của sandbox trong image judge. Không phải nguyên nhân làm judge không kết nối được backend.

## 10. Ghi chú

- Workflow này dùng để sửa source hằng ngày.
- Không cần build lại full Docker stack mỗi lần sửa FE/BE.
- Web để sửa và test hằng ngày là `http://localhost:8000`, không phải `http://localhost` của full Docker stack cũ.

Nếu muốn dọn nhẹ máy trước khi làm, xóa 2 thư mục này là giảm mạnh nhất:

cd C:\DATN\test\Hydro-master
Remove-Item -Recurse -Force node_modules
Remove-Item -Recurse -Force .cache

Khi cần chạy lại:

corepack yarn install
corepack yarn dev:judge