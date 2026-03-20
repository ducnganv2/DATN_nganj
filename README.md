# Hệ thống Online Judge tích hợp phát hiện mã nguồn sinh bởi AI

[English Version](./README-EN.md)

## Giới thiệu

Repository này phục vụ đồ án tốt nghiệp ngành Công nghệ thông tin tại Trường Đại học Nha Trang, được phát triển trên nền tảng [Hydro](https://github.com/hydro-dev/Hydro) và được tùy biến theo hướng phục vụ giảng dạy, chấm bài lập trình, và hỗ trợ phát hiện mã nguồn có dấu hiệu được sinh bởi AI.

**Tên đề tài**  
Nghiên cứu hệ thống Online Judge tích hợp phát hiện mã nguồn sinh bởi AI-Human sử dụng Zero-shot Learning

**Giảng viên hướng dẫn**  
ThS. Nguyễn Hải Triều  
Email: `trieunh@ntu.edu.vn`

**Sinh viên thực hiện**  
Trần Đức Ngạn  
MSSV: `64131460`  
Email: `ngan.td.64cntt@ntu.edu.vn`

## Mục tiêu

Đồ án hướng đến các mục tiêu chính sau:

- Nghiên cứu kiến trúc, quy trình hoạt động và các thành phần chính của hệ thống Online Judge.
- Xây dựng hệ thống Online Judge hỗ trợ chấm bài tự động cho các ngôn ngữ `C`, `C++` và `Python`.
- Áp dụng phương pháp `Zero-shot Learning` để ước lượng khả năng mã nguồn được sinh bởi AI.
- Tích hợp chức năng cảnh báo hỗ trợ giảng viên đánh giá tính trung thực của bài nộp.
- Đánh giá hiệu quả hệ thống thông qua thực nghiệm trên dữ liệu mã nguồn do người và AI tạo ra.

## Phạm vi repository

Repository hiện tại tập trung vào 2 phần:

- Nền tảng Online Judge dựa trên Hydro để quản lý người dùng, bài toán, bài nộp và quá trình chấm bài.
- Workflow phát triển local để có thể sửa frontend và backend trực tiếp từ source, đồng thời vẫn chạy được judge bằng Docker.

Module phát hiện mã nguồn sinh bởi AI là hướng tích hợp của đồ án và có thể được triển khai như một phần mở rộng hoặc một service phân tích riêng tùy theo giai đoạn phát triển.

## Kiến trúc tổng quan

- **Frontend**: giao diện người dùng của hệ thống, nằm chủ yếu trong `packages/ui-default`
- **Backend**: dịch vụ web và nghiệp vụ chính, nằm trong `packages/hydrooj`
- **Database**: MongoDB
- **Judge**: `hydrojudge` và sandbox chạy trong Docker
- **AI Detection Module**: module phân tích mã nguồn theo hướng zero-shot learning

## Công nghệ sử dụng

- `Node.js 22`
- `Yarn 4`
- `MongoDB`
- `Docker Desktop`
- `Hydro / HydroOJ`
- `TypeScript`
- `Stylus`
- `Zero-shot Learning` cho bài toán phát hiện mã nguồn sinh bởi AI

## Hướng dẫn chạy dự án để sửa source

Workflow được khuyến nghị cho môi trường phát triển là:

- Frontend + Backend chạy local từ source
- Judge chạy riêng bằng Docker

Không nên dùng full Docker stack cũ trong `install/docker` nếu mục tiêu là sửa source và thấy thay đổi ngay.

### 1. Điều kiện cần có

- Node.js 22
- Docker Desktop đang chạy Linux containers
- MongoDB local đang chạy

Nếu chưa có Mongo local, có thể chạy nhanh bằng Docker:

```powershell
docker run -d --name hydro-mongo -p 27017:27017 mongo:7-jammy
```

### 2. Cài dependency

```powershell
cd C:\DATN\test\Hydro-master
corepack yarn install
```

### 3. Tạo config local cho Hydro

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.hydro" | Out-Null
'{"url":"mongodb://localhost:27017/hydro"}' | Set-Content "$env:USERPROFILE\.hydro\config.json"
'["@hydrooj/ui-default"]' | Set-Content "$env:USERPROFILE\.hydro\addon.json"
```

### 4. Chạy frontend + backend local

```powershell
cd C:\DATN\test\Hydro-master
corepack yarn dev:judge
```

Lệnh này sẽ:

- chạy backend ở `0.0.0.0:2333`
- chạy frontend dev server ở `localhost:8000`
- theo dõi source để tự nạp lại thay đổi khi sửa code

### 5. Chạy judge bằng Docker

Mở terminal khác:

```powershell
cd C:\DATN\test\Hydro-master\install\docker
docker compose -f docker-compose.local-judge.yml up -d --build
docker logs -f oj-judge-local
```

Judge Docker được cấu hình để kết nối vào backend local qua:

- `http://host.docker.internal:2333/`

### 6. Tạo tài khoản judge lần đầu

Nếu log judge báo lỗi `UserNotFoundError` hoặc không tìm thấy user `judge`, tạo user bằng CLI:

```powershell
cd C:\DATN\test\Hydro-master
node packages\hydrooj\bin\hydrooj.js cli user create systemjudge@systemjudge.local judge examplepassword auto
```

Lệnh trên sẽ in ra UID mới, ví dụ `3`. Sau đó gán quyền judge:

```powershell
node packages\hydrooj\bin\hydrooj.js cli user setJudge 3
```

Nếu UID in ra không phải `3`, thay `3` bằng UID thực tế.

Sau khi tạo xong, restart judge:

```powershell
cd C:\DATN\test\Hydro-master\install\docker
docker restart oj-judge-local
docker logs -f oj-judge-local
```

## URL truy cập

- Frontend dev: `http://localhost:8000`
- Backend trực tiếp: `http://127.0.0.1:2333`

## Cách chạy hằng ngày

Mỗi lần bắt đầu làm việc:

1. Đảm bảo Mongo đang chạy.
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

4. Mở trình duyệt tại:

- `http://localhost:8000`

## Cách dừng

Dừng FE + BE local:

- nhấn `Ctrl + C` ở terminal đang chạy `corepack yarn dev:judge`

Dừng judge Docker:

```powershell
cd C:\DATN\test\Hydro-master\install\docker
docker compose -f docker-compose.local-judge.yml down
```

## Lỗi thường gặp

### Submission bị `0 Waiting`

Nguyên nhân thường là:

- judge Docker chưa chạy
- backend local chưa chạy
- backend không mở ở cổng `2333`

Kiểm tra nhanh:

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

DB local chưa có user `judge`. Tạo lại user theo phần hướng dẫn phía trên.

### `No replica set found.`

Đây chỉ là log thông báo của Mongo trong local dev. Không phải lỗi chặn chấm bài.

### `sandbox version is vulnerable to symlink escape issue`

Đây là cảnh báo của sandbox trong image judge. Không phải nguyên nhân làm judge không kết nối được backend.

## Cấu trúc thư mục quan trọng

- `packages/hydrooj`: backend chính
- `packages/ui-default`: frontend và giao diện
- `packages/hydrojudge`: judge
- `install/docker`: cấu hình Docker
- `build/dev-all.js`: script chạy dev FE + BE

## Tài liệu tham khảo

- Domjudge Documentation: <https://www.domjudge.org>
- Codeforces Online Judge System: <https://codeforces.com>
- Brown et al. (2020), *Language Models are Few-Shot Learners*, NeurIPS
- Detecting AI-Generated Code Using Large Language Models, IEEE Conference, 2023

## Ghi chú

- Workflow này phù hợp để sửa source hằng ngày.
- Không cần build lại full Docker stack mỗi lần sửa frontend hoặc backend.
- Nếu sau này cần đóng gói production, có thể thiết lập thêm hướng triển khai riêng cho backend, judge và module AI detection.
