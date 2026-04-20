# Hệ thống Online Judge tích hợp phát hiện mã nguồn sinh bởi AI

## Giới thiệu

Repository này phục vụ đồ án tốt nghiệp tại Trường Đại học Nha Trang, phát triển trên nền tảng [Hydro](https://github.com/hydro-dev/Hydro) và mở rộng thêm khả năng phát hiện mã nguồn có dấu hiệu được sinh bởi AI qua provider Kaggle.

## Mục tiêu

- Xây dựng hệ thống Online Judge cho `C`, `C++`, `Python`.
- Vận hành đầy đủ luồng chấm bài với backend, frontend và judge.
- Tích hợp kiểm tra AI bất đồng bộ qua Kaggle để hỗ trợ đánh giá tính trung thực học thuật.

## Kiến trúc tổng quan

- **Frontend**: `packages/ui-default`
- **Backend**: `packages/hydrooj`
- **Database**: MongoDB
- **Judge**: `hydrojudge` chạy trong Docker
- **AI check**: provider Kaggle bất đồng bộ

## Công nghệ sử dụng

- `Node.js 22`
- `Yarn 4`
- `MongoDB`
- `Docker Desktop`
- `TypeScript`
- `Hydro / HydroOJ`

## Ghi chú về AI check

- README này mô tả trực tiếp luồng Kaggle bất đồng bộ đang dùng trong dự án.
- Prebuilt worker checklist: `README_KAGGLE_PREBUILT.md`

## Hướng dẫn chạy dự án (luồng Kaggle)

### 1. Điều kiện cần có

- Node.js 22
- Docker Desktop (Linux containers)
- MongoDB local

Nếu chưa có MongoDB local:

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

### 4. Chạy frontend + backend local với provider Kaggle

```powershell
$env:HYDRO_SUBMISSION_AI_PROVIDER="kaggle"
$env:HYDRO_KAGGLE_KERNEL_ID="tranducngan/atcv1"
$env:HYDRO_KAGGLE_ATC_DATASET_SOURCE="tranducngan/atcv1-source"
$env:HYDRO_KAGGLE_ATC_PROJECT_DIR="ATC-main"
$env:HYDRO_KAGGLE_ATC_BASE_MODEL="codellama/CodeLlama-7b-Instruct-hf"
$env:HYDRO_KAGGLE_ATC_METHOD="entropy"
$env:HYDRO_KAGGLE_ATC_INFER_TASK="true"
$env:HYDRO_KAGGLE_ATC_PROMPT_STYLE="regular"
$env:HYDRO_KAGGLE_ATC_PATTERN_WEIGHTS="comments:0,docstrings:0"
$env:HYDRO_KAGGLE_ATC_THRESHOLD="-0.18"
$env:HYDRO_KAGGLE_ATC_MIN_NONEMPTY_LINES="8"
$env:HYDRO_KAGGLE_ATC_MIN_NONWHITESPACE_CHARS="120"
$env:HYDRO_KAGGLE_TIMEOUT_MS="3600000"

cd C:\DATN\test\Hydro-master
corepack yarn dev:judge:kaggle-ai
```

### 5. Chạy judge bằng Docker

Mở terminal khác:

```powershell
cd C:\DATN\test\Hydro-master\install\docker
docker compose -f docker-compose.local-judge.yml up -d --build
docker logs -f oj-judge-local
```

Judge Docker kết nối backend local qua:

- `http://host.docker.internal:2333/`
- Image local hiện sẽ tự chờ backend `2333` sẵn sàng trước khi khởi động `hydrojudge`, nên không còn bị văng nếu backend lên chậm hơn vài giây.

### 6. Tạo tài khoản judge lần đầu (nếu cần)

Nếu log judge báo `UserNotFoundError`:

```powershell
cd C:\DATN\test\Hydro-master
node packages\hydrooj\bin\hydrooj.js cli user create systemjudge@systemjudge.local judge examplepassword auto
node packages\hydrooj\bin\hydrooj.js cli user setJudge <UID>
```

Sau đó restart judge:

```powershell
cd C:\DATN\test\Hydro-master\install\docker
docker restart oj-judge-local
docker logs -f oj-judge-local
```

## URL truy cập

- Frontend dev: `http://localhost:8000`
- Backend trực tiếp: `http://127.0.0.1:2333`

## Chạy luồng `ai:kaggle`

### 1. Điều kiện thêm cho Kaggle

- Đã cài Kaggle CLI:

```powershell
python -m pip install kaggle
```

- Đã đặt `kaggle.json` tại:

```text
C:\Users\<user>\.kaggle\kaggle.json
```

- Đã có:
  - kernel Kaggle: `tranducngan/atcv1`
  - dataset Kaggle: `tranducngan/atcv1-source`
- Notebook Kaggle phải bật:
  - `GPU`
  - `Internet`

### 2. Chạy Hydro với provider Kaggle

Mở terminal riêng:

```powershell
$env:HYDRO_SUBMISSION_AI_PROVIDER="kaggle"
$env:HYDRO_KAGGLE_KERNEL_ID="tranducngan/atcv1"
$env:HYDRO_KAGGLE_ATC_DATASET_SOURCE="tranducngan/atcv1-source"
$env:HYDRO_KAGGLE_ATC_PROJECT_DIR="ATC-main"
$env:HYDRO_KAGGLE_ATC_BASE_MODEL="codellama/CodeLlama-7b-Instruct-hf"
$env:HYDRO_KAGGLE_ATC_METHOD="entropy"
$env:HYDRO_KAGGLE_ATC_INFER_TASK="true"
$env:HYDRO_KAGGLE_ATC_PROMPT_STYLE="regular"
$env:HYDRO_KAGGLE_ATC_PATTERN_WEIGHTS="comments:0,docstrings:0"
$env:HYDRO_KAGGLE_ATC_THRESHOLD="-0.18"
$env:HYDRO_KAGGLE_ATC_MIN_NONEMPTY_LINES="8"
$env:HYDRO_KAGGLE_ATC_MIN_NONWHITESPACE_CHARS="120"
$env:HYDRO_KAGGLE_TIMEOUT_MS="3600000"

cd C:\DATN\test\Hydro-master
corepack yarn dev:judge:kaggle-ai
# Script tren da set san HYDRO_KAGGLE_KERNEL_ID va cac bien Kaggle mac dinh trong package.json.
```

### 3. Chạy judge Docker

Mở terminal khác:

```powershell
cd C:\DATN\test\Hydro-master\install\docker
docker compose -f docker-compose.local-judge.yml up -d --build
docker logs -f oj-judge-local
```

### 4. Hành vi mong đợi

- Submit bài xong, record sẽ hiện `AI check pending`
- Hydro đẩy notebook lên Kaggle
- Khi Kaggle chạy xong, record đổi sang:
  - `checked`
  - `skipped`
  - hoặc `error`

### 5. Kiểm tra nhanh Kaggle

```powershell
kaggle kernels status tranducngan/atcv1
```

Nếu cần lấy output mới nhất:

```powershell
kaggle kernels output tranducngan/atcv1 -p C:\DATN\kaggle-out -o
Get-Content C:\DATN\kaggle-out\ai-check-result.json
```

## Cách chạy hằng ngày

Mỗi lần bắt đầu làm việc, chạy theo đúng thứ tự dưới đây:

1. Kiểm tra MongoDB đã chạy.

```powershell
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
```

1. Terminal A: chạy Hydro (frontend + backend) với AI check qua Kaggle.

```powershell
$env:HYDRO_SUBMISSION_AI_PROVIDER="kaggle"
$env:HYDRO_KAGGLE_KERNEL_ID="tranducngan/atcv1"
$env:HYDRO_KAGGLE_ATC_DATASET_SOURCE="tranducngan/atcv1-source"
$env:HYDRO_KAGGLE_ATC_PROJECT_DIR="ATC-main"
$env:HYDRO_KAGGLE_ATC_BASE_MODEL="codellama/CodeLlama-7b-Instruct-hf"
$env:HYDRO_KAGGLE_ATC_METHOD="entropy"
$env:HYDRO_KAGGLE_ATC_INFER_TASK="true"
$env:HYDRO_KAGGLE_ATC_PROMPT_STYLE="regular"
$env:HYDRO_KAGGLE_ATC_PATTERN_WEIGHTS="comments:0,docstrings:0"
$env:HYDRO_KAGGLE_ATC_THRESHOLD="-0.18"
$env:HYDRO_KAGGLE_ATC_MIN_NONEMPTY_LNES="8"
$env:HYDRO_KAGGLE_ATC_MIN_NONWHITESPACE_CHARS="120"
$env:HYDRO_KAGGLE_TIMEOUT_MS="3600000"

cd C:\DATN\test\Hydro-master
corepack yarn dev:judge:kaggle-ai

```

1. Chỉ chạy judge Docker sau khi backend local mở được `http://127.0.0.1:2333/status`.

```powershell
Invoke-WebRequest http://127.0.0.1:2333/status -UseBasicParsing | Select-Object -ExpandProperty StatusCode
```

1. Terminal B: chạy judge Docker.

```powershell
cd C:\DATN\test\Hydro-master\install\docker
docker compose -f docker-compose.local-judge.yml up -d
docker logs -f oj-judge-local
```

1. Kiểm tra nhanh hệ thống đã sẵn sàng:

```powershell
curl http://127.0.0.1:2333/status
kaggle kernels status tranducngan/atcv1
```

1. Mở trình duyệt tại `http://localhost:8000`, submit bài và kiểm tra record.

## Cách dừng

- Dừng Hydro dev: `Ctrl + C` ở terminal chạy `corepack yarn dev:judge:kaggle-ai`
- Dừng judge Docker:

```powershell
cd C:\DATN\test\Hydro-master\install\docker
docker compose -f docker-compose.local-judge.yml down
```

## Lỗi thường gặp

### Submission bị `0 Waiting`

Nguyên nhân phổ biến:

- Judge Docker chưa chạy
- Backend local chưa chạy
- Backend không mở cổng `2333`

Kiểm tra nhanh:

```powershell
curl http://127.0.0.1:2333/status
docker logs -f oj-judge-local
```

### `connect ECONNREFUSED ...:2333`

Judge Docker không kết nối được backend local.

- Kiểm tra `corepack yarn dev:judge:kaggle-ai` còn chạy
- Kiểm tra cổng `2333` có mở

### AI check trả về `error`

Kiểm tra:

- `kaggle kernels status tranducngan/atcv1`
- `kaggle kernels output tranducngan/atcv1 -p C:\DATN\kaggle-out -o`
- Hydro đang chạy bằng `corepack yarn dev:judge:kaggle-ai`
