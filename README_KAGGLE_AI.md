# Hydro Kaggle AI Check

Tài liệu này mô tả cách dùng Kaggle làm provider AI check bất đồng bộ cho Hydro.

## Mô hình chạy

- Frontend pre-check trả về `pending` ngay.
- Sau khi record được tạo, Hydro đẩy một notebook lên Kaggle qua `kaggle kernels push`.
- Hydro poll trạng thái bằng `kaggle kernels status`.
- Khi notebook hoàn tất, Hydro tải output bằng `kaggle kernels output` và cập nhật `aiCheck` trong record.

Luồng này phù hợp cho đồ án/demonstration khi máy local không đủ VRAM/RAM để chạy ATC.

## Yêu cầu

- Đã cài Kaggle CLI trên máy chạy Hydro:
  - `pip install kaggle`
- Đã đặt `kaggle.json` hợp lệ để CLI có thể push/pull notebook.
- Trên Kaggle đã có dataset chứa mã nguồn ATC, ví dụ `tranducngan/atcv1-source`.
- Notebook worker của Kaggle phải được phép dùng:
  - `GPU`
  - `Internet`

## Biến môi trường bắt buộc

```powershell
$env:HYDRO_SUBMISSION_AI_PROVIDER="kaggle"
$env:HYDRO_KAGGLE_KERNEL_ID="<kaggle-username>/<kernel-slug>"
$env:HYDRO_KAGGLE_ATC_DATASET_SOURCE="<kaggle-username>/<dataset-slug>"
```

Ví dụ:

```powershell
$env:HYDRO_SUBMISSION_AI_PROVIDER="kaggle"
$env:HYDRO_KAGGLE_KERNEL_ID="tranducngan/hydro-atc-worker"
$env:HYDRO_KAGGLE_ATC_DATASET_SOURCE="tranducngan/atcv1-source"
```

## Biến môi trường tùy chọn

```powershell
$env:HYDRO_KAGGLE_ATC_PROJECT_DIR="ATC-main"
$env:HYDRO_KAGGLE_ATC_BASE_MODEL="google/codegemma-7b-it"
$env:HYDRO_KAGGLE_ATC_METHOD="entropy"
$env:HYDRO_KAGGLE_ATC_INFER_TASK="true"
$env:HYDRO_KAGGLE_ATC_PROMPT_STYLE="regular"
$env:HYDRO_KAGGLE_ATC_PATTERN_WEIGHTS="comments:0,docstrings:0"
$env:HYDRO_KAGGLE_ATC_THRESHOLD="-0.12"
$env:HYDRO_KAGGLE_ATC_MIN_NONEMPTY_LINES="8"
$env:HYDRO_KAGGLE_ATC_MIN_NONWHITESPACE_CHARS="120"
$env:HYDRO_KAGGLE_TIMEOUT_MS="1800000"
$env:HYDRO_KAGGLE_POLL_INTERVAL_MS="15000"
```

Ý nghĩa chính:

- `HYDRO_KAGGLE_ATC_PROJECT_DIR`: tên thư mục ATC sau khi mount trong Kaggle input.
- `HYDRO_KAGGLE_ATC_BASE_MODEL`: detector model dùng trong notebook Kaggle.
- `HYDRO_KAGGLE_ATC_THRESHOLD`: ngưỡng quyết định `isAI`.
- `HYDRO_KAGGLE_TIMEOUT_MS`: thời gian tối đa Hydro chờ Kaggle hoàn tất một lượt check.
- `HYDRO_KAGGLE_POLL_INTERVAL_MS`: chu kỳ poll trạng thái notebook.

## Chạy Hydro với provider Kaggle

```powershell
cd C:\DATN\test\Hydro-master
corepack yarn dev:judge:kaggle-ai
```

Script này chỉ set:

```powershell
HYDRO_SUBMISSION_AI_PROVIDER=kaggle
```

Các biến Kaggle còn lại vẫn phải được export trước khi chạy.

## Kết quả trên UI

- Khi user submit bài, record ban đầu sẽ có `aiCheck.state = pending`.
- Sau khi notebook Kaggle hoàn tất, record sẽ được cập nhật thành:
  - `checked`
  - `error`
  - hoặc `skipped`

## Lưu ý vận hành

- Provider Kaggle hiện được serialize trong một tiến trình Hydro để tránh nhiều submission cùng push đè lên một kernel Kaggle.
- Với cách này, AI check không phải realtime. Độ trễ thường tính bằng phút.
- Nếu muốn debug file tạm Hydro sinh ra, set:

```powershell
$env:HYDRO_KAGGLE_KEEP_WORKDIR="true"
```

- Thư mục tạm mặc định:

```text
%TEMP%\hydro-kaggle-ai-check
```

## Current recommended defaults

- Default threshold: `-0.12`
- Skip AI check when code has fewer than `8` non-empty lines
- Skip AI check when code has fewer than `120` non-whitespace characters
