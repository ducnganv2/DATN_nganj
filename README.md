# Hệ thống Online Judge tích hợp kiểm tra mã nguồn sinh bởi AI

[English version](./README-EN.md)

## Tổng quan

Đây là repository chính của đồ án, phát triển trên nền tảng [Hydro](https://github.com/hydro-dev/Hydro) để xây dựng hệ thống Online Judge có tích hợp kiểm tra mã nguồn có dấu hiệu được sinh bởi AI.

Phạm vi làm việc hiện tại:

- Chỉ dùng thư mục `Hydro-master`.
- Không cần thư mục `ATC` local ở cấp ngoài repository.
- Không dùng API detector local kiểu `ATC_impl`.
- Luồng AI check chính chạy bất đồng bộ qua Kaggle bằng runtime/model đã được mount sẵn trên Kaggle.

Trong source code và biến môi trường vẫn có chữ `ATC` vì đó là tên thuật toán/runtime detector đang được Kaggle chạy. Điểm quan trọng là Hydro không đọc mã nguồn từ thư mục `../ATC` trên máy local nữa.

## Mục tiêu hệ thống

- Cung cấp Online Judge cho các bài lập trình với `C`, `C++`, `Python` và các ngôn ngữ Hydro hỗ trợ.
- Vận hành đầy đủ frontend, backend, database và judge worker.
- Lưu submission, trạng thái chấm bài, test cases, điểm số, thời gian chạy, bộ nhớ và metadata kiểm tra AI.
- Chỉ chạy AI check sau khi submission được chấm `Accepted`, tránh tốn tài nguyên cho bài sai.
- Dùng Kaggle GPU để chạy detector khi máy local không đủ VRAM/RAM.

## Kiến trúc tổng quan

```text
Người dùng submit bài
-> Frontend Hydro nhận form submit
-> Backend tạo record với trạng thái AI pending
-> Judge Docker chấm bài qua hydrojudge
-> Nếu bài không Accepted: AI check được đánh dấu skipped
-> Nếu bài Accepted: Hydro sinh notebook Kaggle và đẩy lên Kaggle
-> Kaggle chạy detector trên runtime/model đã mount sẵn
-> Hydro tải ai-check-result.json
-> Record được cập nhật aiCheck và UI hiển thị kết quả
```

Các thành phần chính:

| Thành phần | Vị trí | Vai trò |
| --- | --- | --- |
| Frontend | `packages/ui-default` | Giao diện danh sách bài, submit, record, contest |
| Backend | `packages/hydrooj` | Route, service, model, task queue, cập nhật record |
| Kiểu dữ liệu chung | `packages/common/types.ts` | Định nghĩa `SubmissionAICheck` và `RecordPayload.aiCheck` |
| Judge | `packages/hydrojudge` | Nhận task chấm bài và trả kết quả về backend |
| Docker judge local | `install/docker` | Chạy `hydrojudge` trong container |
| AI check service | `packages/hydrooj/src/service/submissionAI.ts` | Chọn provider, tạo notebook Kaggle, lấy kết quả |
| Kaggle helper | `prepare-kaggle-*.ps1`, `kaggle-model-local.example.ps1` | Chuẩn bị model/runtime phục vụ Kaggle |

## Cấu trúc thư mục cần quan tâm

```text
Hydro-master/
|- package.json
|- README.md
|- README-EN.md
|- kaggle-model-local.example.ps1
|- prepare-kaggle-model-dataset.ps1
|- prepare-kaggle-model-safetensors.ps1
|- prepare-kaggle-p100-torch-wheels.ps1
|- install/
|  `- docker/
|     |- docker-compose.local-judge.yml
|     `- judge/
|        |- Dockerfile
|        |- entrypoint.sh
|        `- judge.local.yaml
|- packages/
|  |- common/
|  |  `- types.ts
|  |- hydrojudge/
|  |- hydrooj/
|  |  `- src/
|  |     |- handler/
|  |     |  |- problem.ts
|  |     |  `- judge.ts
|  |     |- model/
|  |     |  `- record.ts
|  |     `- service/
|  |        `- submissionAI.ts
|  `- ui-default/
|     |- pages/
|     |  `- problem_submit.page.tsx
|     `- templates/
|        |- problem_submit.html
|        |- record_main_tr.html
|        `- record_detail_status.html
```

## Luồng AI check

### 1. Trước khi tạo record

Trang submit gắn `UiContext.aiCheckUrl` tới route:

```text
POST /p/:pid/submit/ai-check
```

Với provider Kaggle, route này trả nhanh `aiCheck.state = pending`. Submission vẫn được gửi tiếp để tạo record và chấm bài bình thường.

### 2. Khi tạo record

`packages/hydrooj/src/handler/problem.ts` parse `aiCheckPayload` từ form. Nếu payload thiếu, lỗi hoặc đang `pending`, record được lưu với trạng thái AI pending.

Record được tạo tại:

```text
packages/hydrooj/src/model/record.ts
```

Trường lưu trong MongoDB:

```json
{
  "aiCheck": {
    "state": "pending",
    "isAI": null,
    "score": null,
    "confidence": null,
    "provider": "kaggle-atc",
    "message": "Pending Kaggle AI check after judge result.",
    "checkedAt": "2026-05-04T00:00:00.000Z"
  }
}
```

### 3. Sau khi judge trả kết quả

`packages/hydrooj/src/handler/judge.ts` quyết định bước tiếp theo:

- Nếu submission không `Accepted`, AI check được đánh dấu `skipped`.
- Nếu submission `Accepted`, Hydro gọi `checkSubmissionForAI()` bất đồng bộ.

Cách này giúp tránh chạy detector cho bài sai, giảm tải Kaggle và làm record chấm bài xuất hiện trước khi AI check hoàn tất.

### 4. Khi chạy Kaggle

`packages/hydrooj/src/service/submissionAI.ts` thực hiện:

1. Đọc cấu hình từ biến môi trường `HYDRO_KAGGLE_*`.
2. Tạo thư mục tạm trong `%TEMP%\hydro-kaggle-ai-check`.
3. Sinh notebook `hydro-kaggle-ai-check.ipynb`.
4. Sinh `kernel-metadata.json`.
5. Chạy `kaggle kernels push`.
6. Poll bằng `kaggle kernels status`.
7. Tải output bằng `kaggle kernels output`.
8. Parse `ai-check-result.json`.
9. Cập nhật `record.aiCheck` và broadcast `record/change` để UI cập nhật.

### 5. Trạng thái hiển thị trên UI

Các trạng thái `aiCheck.state`:

| State | Ý nghĩa |
| --- | --- |
| `pending` | Đang chờ Kaggle hoặc chờ bài Accepted |
| `checked` | Đã có điểm detector và kết luận `Potential AI` hoặc `Not AI` |
| `skipped` | Bỏ qua, thường do bài không Accepted hoặc mã quá ngắn |
| `error` | Kaggle/CLI/runtime trả lỗi |

UI hiển thị tại:

- `packages/ui-default/templates/record_main_tr.html`
- `packages/ui-default/templates/record_detail_status.html`

## Yêu cầu môi trường

Môi trường đang hướng tới Windows + PowerShell:

- Node.js `22`
- Corepack/Yarn `4`
- Docker Desktop, bật Linux containers
- MongoDB local hoặc MongoDB chạy bằng Docker
- Python `3.10+`
- Kaggle CLI
- Tài khoản Kaggle có quyền push kernel và đọc dataset/model cần mount

Kiểm tra nhanh:

```powershell
node -v
corepack --version
docker --version
python --version
kaggle --version
```

## Cài đặt lần đầu

### 1. Vào đúng thư mục dự án

```powershell
cd C:\DATN\test\Hydro-master
```

### 2. Cài dependency Node.js

```powershell
corepack enable
corepack yarn install
```

### 3. Tạo config Hydro local

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.hydro" | Out-Null
'{"url":"mongodb://localhost:27017/hydro"}' | Set-Content "$env:USERPROFILE\.hydro\config.json"
'["@hydrooj/ui-default"]' | Set-Content "$env:USERPROFILE\.hydro\addon.json"
```

### 4. Chạy MongoDB

Nếu chưa có container MongoDB:

```powershell
docker run -d --name hydro-mongo -p 27017:27017 mongo:7-jammy
```

Nếu container đã tồn tại nhưng đang dừng:

```powershell
docker start hydro-mongo
```

Kiểm tra:

```powershell
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
```

### 5. Cài và cấu hình Kaggle CLI

```powershell
python -m pip install kaggle
```

Đặt file token tại:

```text
C:\Users\<user>\.kaggle\kaggle.json
```

Kiểm tra đăng nhập:

```powershell
kaggle kernels list -m
```

## Cấu hình Kaggle đang dùng

Script chính trong `package.json` là:

```powershell
corepack yarn dev:judge:kaggle-ai
```

Script này đã set sẵn các biến quan trọng:

| Biến | Giá trị mặc định hiện tại |
| --- | --- |
| `HYDRO_SUBMISSION_AI_PROVIDER` | `kaggle` |
| `HYDRO_KAGGLE_ATC_RUNTIME_MODE` | `prebuilt` |
| `HYDRO_KAGGLE_KERNEL_ID` | `tranducngan/atcv1` |
| `HYDRO_KAGGLE_ATC_DATASET_SOURCE` | `tranducngan/atcv1-source` |
| `HYDRO_KAGGLE_EXTRA_DATASET_SOURCES` | `tranducngan/codellama-7b-instruct-hf,tranducngan/p100-torch-cu124-wheels` |
| `HYDRO_KAGGLE_P100_TORCH_WHEEL_PATH` | `/kaggle/input/p100-torch-cu124-wheels/wheels` |
| `HYDRO_KAGGLE_ATC_PREBUILT_PATH` | `/kaggle/input/datasets/tranducngan/atcv1-source/ATC-main` |
| `HYDRO_KAGGLE_ATC_PROJECT_DIR` | `ATC-main` |
| `HYDRO_KAGGLE_ATC_BASE_MODEL` | `/kaggle/input/codellama-7b-instruct-hf` |
| `HYDRO_KAGGLE_ENABLE_INTERNET` | `false` |
| `HYDRO_KAGGLE_INSTALL_P100_TORCH` | `true` |
| `HYDRO_KAGGLE_ATC_METHOD` | `entropy` |
| `HYDRO_KAGGLE_ATC_DEVICE` | `auto` |
| `HYDRO_KAGGLE_ATC_THRESHOLD` | `-0.185` |
| `HYDRO_KAGGLE_ATC_MIN_NONEMPTY_LINES` | `8` |
| `HYDRO_KAGGLE_ATC_MIN_NONWHITESPACE_CHARS` | `120` |
| `HYDRO_KAGGLE_POLL_INTERVAL_MS` | `5000` |
| `HYDRO_KAGGLE_TIMEOUT_MS` | `0` |

`HYDRO_KAGGLE_TIMEOUT_MS=0` nghĩa là Hydro chờ Kaggle không giới hạn thời gian ở phía local. Việc chạy thực tế vẫn phụ thuộc quota, trạng thái kernel và giới hạn của Kaggle.

Nếu cần tùy chỉnh tài khoản/dataset/model riêng, dùng file mẫu:

```powershell
Copy-Item .\kaggle-model-local.example.ps1 .\kaggle-model-local.ps1
notepad .\kaggle-model-local.ps1
```

Sau khi sửa, có thể chạy:

```powershell
.\kaggle-model-local.ps1
```

## Chạy hệ thống hằng ngày

### 1. Đảm bảo MongoDB đang chạy

```powershell
docker start hydro-mongo
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
```

### 2. Terminal A: chạy Hydro frontend + backend

```powershell
cd C:\DATN\test\Hydro-master
corepack yarn dev:judge:kaggle-ai
```

Khi chạy đúng, console sẽ in:

```text
Backend:  http://127.0.0.1:2333
Frontend: http://localhost:8000
```

Kiểm tra backend:

```powershell
Invoke-WebRequest http://127.0.0.1:2333/status -UseBasicParsing | Select-Object -ExpandProperty StatusCode
```

### 3. Terminal B: chạy judge Docker

Lần đầu hoặc sau khi đổi Dockerfile:

```powershell
cd C:\DATN\test\Hydro-master\install\docker
docker compose -f docker-compose.local-judge.yml up -d --build
docker logs -f oj-judge-local
```

Những lần sau:

```powershell
cd C:\DATN\test\Hydro-master\install\docker
docker compose -f docker-compose.local-judge.yml up -d
docker logs -f oj-judge-local
```

Judge Docker kết nối backend local qua:

```text
http://host.docker.internal:2333/
```

`install/docker/judge/entrypoint.sh` đã có logic chờ `http://host.docker.internal:2333/status` sẵn sàng rồi mới khởi động `hydrojudge`.

### 4. Mở giao diện

- Frontend: `http://localhost:8000`
- Backend trực tiếp: `http://127.0.0.1:2333`

## Tạo tài khoản judge lần đầu

Nếu log judge báo `UserNotFoundError`, tạo user judge:

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

Thông tin đăng nhập judge local hiện nằm trong:

```text
install/docker/judge/judge.local.yaml
```

## Kiểm tra luồng submit

1. Mở `http://localhost:8000`.
2. Đăng nhập tài khoản có quyền submit.
3. Chọn bài, submit code.
4. Xem record mới tạo.
5. Nếu bài đang chấm, trạng thái AI thường là `Pending`.
6. Nếu bài không Accepted, trạng thái AI chuyển `Skipped`.
7. Nếu bài Accepted, Hydro đẩy job lên Kaggle.
8. Khi Kaggle xong, record chuyển sang `Potential AI` hoặc `Not AI`.

Kiểm tra Kaggle:

```powershell
kaggle kernels status tranducngan/atcv1
```

Tải output gần nhất nếu cần debug:

```powershell
kaggle kernels output tranducngan/atcv1 -p C:\DATN\kaggle-out -o
Get-Content C:\DATN\kaggle-out\ai-check-result.json
```

## Cách dừng hệ thống

Dừng Hydro:

```text
Ctrl + C
```

Dừng judge Docker:

```powershell
cd C:\DATN\test\Hydro-master\install\docker
docker compose -f docker-compose.local-judge.yml down
```

Dừng MongoDB nếu muốn:

```powershell
docker stop hydro-mongo
```

## Chuẩn bị model/runtime Kaggle

Luồng hiện tại giả định Kaggle đã có runtime detector và model được mount sẵn. Nếu cần chuẩn bị lại model dataset:

```powershell
cd C:\DATN\test\Hydro-master
.\prepare-kaggle-model-dataset.ps1 -ModelPath C:\DATN\models\CodeLlama-7b-Instruct-hf -KaggleUsername <kaggle-username>
```

Script sẽ:

- Kiểm tra thư mục model local.
- Tạo thư mục sẵn sàng upload Kaggle dataset.
- Sinh `dataset-metadata.json`.
- Sinh `hydro-kaggle-env.ps1` tương ứng.

Nếu model còn ở dạng `.bin` và cần chuyển sang safetensors:

```powershell
cd C:\DATN\test\Hydro-master
.\prepare-kaggle-model-safetensors.ps1
```

Nếu cần wheelhouse cho P100:

```powershell
cd C:\DATN\test\Hydro-master
.\prepare-kaggle-p100-torch-wheels.ps1
```

## Định dạng `aiCheck`

`aiCheck` được lưu trực tiếp trong record:

```json
{
  "state": "checked",
  "isAI": false,
  "score": -0.2314,
  "threshold": -0.185,
  "confidence": 28,
  "provider": "kaggle-atc",
  "message": "Kaggle ATC score -0.231400 < threshold -0.185000 on cpu.",
  "checkedAt": "2026-05-04T00:00:00.000Z"
}
```

Ý nghĩa:

- `state`: `pending`, `checked`, `skipped`, hoặc `error`.
- `isAI`: `true` nếu score vượt ngưỡng, `false` nếu không, `null` nếu chưa có kết luận.
- `score`: điểm detector trả về.
- `threshold`: ngưỡng quyết định.
- `confidence`: phần trăm quy đổi từ khoảng cách giữa `score` và `threshold`.
- `provider`: provider sinh kết quả, hiện là `kaggle-atc`.
- `message`: mô tả ngắn để debug trên UI.
- `checkedAt`: thời điểm tạo kết quả.

## Lệnh thường dùng

Cài dependency:

```powershell
corepack yarn install
```

Chạy dev Hydro có backend mở cho judge Docker:

```powershell
corepack yarn dev:judge:kaggle-ai
```

Build:

```powershell
corepack yarn build
```

Test:

```powershell
corepack yarn test
```

Chạy lint:

```powershell
corepack yarn lint:ci
```

## Lỗi thường gặp

### Submission bị `0 Waiting`

Nguyên nhân thường gặp:

- Judge Docker chưa chạy.
- Backend chưa chạy.
- Backend không mở được cổng `2333`.
- Judge chưa đăng nhập được bằng user `judge`.

Kiểm tra:

```powershell
Invoke-WebRequest http://127.0.0.1:2333/status -UseBasicParsing
docker logs -f oj-judge-local
```

### Judge báo `connect ECONNREFUSED ...:2333`

Judge không kết nối được backend local.

Kiểm tra:

- Terminal chạy `corepack yarn dev:judge:kaggle-ai` còn sống.
- Backend đã mở `http://127.0.0.1:2333/status`.
- Docker Desktop đang chạy Linux containers.
- File `install/docker/judge/judge.local.yaml` đang trỏ `server_url` tới `http://host.docker.internal:2333/`.

### Judge báo `UserNotFoundError`

Tạo user judge theo mục "Tạo tài khoản judge lần đầu", sau đó restart container `oj-judge-local`.

### AI check đứng ở `Pending` quá lâu

Kiểm tra:

```powershell
kaggle kernels status tranducngan/atcv1
```

Nguyên nhân có thể:

- Kaggle kernel đang queued/running lâu.
- Kaggle hết quota GPU.
- Kaggle CLI chưa đăng nhập đúng tài khoản.
- Kernel đang bị serialize, nhiều submission phải chờ nhau.
- `HYDRO_KAGGLE_TIMEOUT_MS=0` nên Hydro sẽ tiếp tục chờ thay vì timeout local.

### AI check trả `Check failed`

Tải output để xem lỗi:

```powershell
kaggle kernels output tranducngan/atcv1 -p C:\DATN\kaggle-out -o
Get-Content C:\DATN\kaggle-out\ai-check-result.json
```

Các lỗi phổ biến:

- Sai `HYDRO_KAGGLE_ATC_PREBUILT_PATH`.
- Dataset Kaggle không chứa runtime detector.
- Model path `/kaggle/input/codellama-7b-instruct-hf` không tồn tại.
- Thiếu wheel hoặc package Python trong Kaggle runtime.
- Kaggle không attach đúng dataset/model source.

### Backend không lên vì MongoDB

Kiểm tra container:

```powershell
docker ps -a --filter "name=hydro-mongo"
docker start hydro-mongo
```

Kiểm tra config:

```powershell
Get-Content "$env:USERPROFILE\.hydro\config.json"
```

Config mong đợi:

```json
{"url":"mongodb://localhost:27017/hydro"}
```

### Code ngắn bị `Skipped`

Theo cấu hình hiện tại, AI check bỏ qua code quá ngắn:

- Ít hơn `8` dòng không rỗng.
- Hoặc ít hơn `120` ký tự không phải whitespace.

Có thể điều chỉnh bằng:

```powershell
$env:HYDRO_KAGGLE_ATC_MIN_NONEMPTY_LINES="8"
$env:HYDRO_KAGGLE_ATC_MIN_NONWHITESPACE_CHARS="120"
```

## Ghi chú vận hành

- `dev:judge:kaggle-ai` là luồng chính cho đồ án hiện tại.
- `dev:judge:atc-ai` vẫn còn trong `package.json` để tương thích thử nghiệm cũ, nhưng không dùng cho hướng dẫn này.
- Không cần chạy `cd ..\ATC`, không cần cài dependency Python từ thư mục `ATC` local.
- Runtime detector dùng trong Kaggle phải được chuẩn bị và upload/mount trước.
- Với một kernel Kaggle, Hydro serialize job để tránh nhiều submission push đè lên cùng kernel.
- Nếu muốn tăng song song, cấu hình nhiều kernel bằng `HYDRO_KAGGLE_KERNEL_IDS` và đảm bảo các kernel đó có cùng dataset/model sources.
