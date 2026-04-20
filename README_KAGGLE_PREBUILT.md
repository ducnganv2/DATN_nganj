# Kaggle Prebuilt Worker

This repo now generates Kaggle AI-check notebooks in prebuilt mode.

That means the Kaggle job will:

- use an ATC runtime already mounted under `/kaggle/input/...`
- `cd` into that runtime
- run the detector directly

The Kaggle job will not:

- run `pip install`
- copy the ATC project into `/kaggle/working`

## What must already exist on Kaggle

Your mounted runtime must contain at least:

- `detection/run.py`
- `detection/detector.py`

If you point `HYDRO_KAGGLE_ATC_PREBUILT_PATH` to a folder, Hydro will validate those files before running the detector.

## Python packages that must already be available

The current ATC code under `C:\DATN\test\ATC` imports or requires these packages:

- `datasets==2.19.1`
- `transformers==4.45.2`
- `openai==1.52.1`
- `accelerate==1.0.1`
- `torch==2.4.1`
- `torchtext==0.18.0`
- `torchvision==0.19.1`
- `tiktoken==0.7.0`
- `httpx==0.27.2`
- `boto3==1.34.34`
- `plotly==5.24.1`
- `pyrallis==0.3.1`
- `tqdm==4.67.1`
- `astor`
- `numpy`

Some of those are only needed for training, analysis, or optional generators. For the detector path used by Hydro, the important runtime packages are:

- `torch`
- `transformers`
- `accelerate`
- `numpy`
- `pyrallis`
- `tqdm`
- `astor`

If any of them is missing, the notebook will fail with `ModuleNotFoundError` because install-time fallback has been removed.

## Model mounting

For the fastest setup, do not load the base model from Hugging Face at runtime.

Instead:

1. Upload or attach the model to Kaggle.
2. If it was uploaded with `kaggle datasets create`, set `HYDRO_KAGGLE_EXTRA_DATASET_SOURCES`.
3. If it is a Kaggle Model, set `HYDRO_KAGGLE_MODEL_SOURCES`.
4. Point `HYDRO_KAGGLE_ATC_BASE_MODEL` to the mounted local path.

Example:

```powershell
$env:HYDRO_KAGGLE_EXTRA_DATASET_SOURCES="owner/codellama-7b-instruct-hf"
$env:HYDRO_KAGGLE_ATC_BASE_MODEL="/kaggle/input/codellama-7b-instruct-hf"
```

If `HYDRO_KAGGLE_ATC_BASE_MODEL` points to `/kaggle/input/...`, Hydro will automatically generate notebook metadata with `enable_internet=false` unless you override it.

If you still use a remote model id such as `codellama/CodeLlama-7b-Instruct-hf`, Hydro will keep Internet enabled unless you explicitly turn it off.

## Recommended environment variables

```powershell
$env:HYDRO_SUBMISSION_AI_PROVIDER="kaggle"
$env:HYDRO_KAGGLE_KERNEL_ID="tranducngan/atcv1"
$env:HYDRO_KAGGLE_ATC_DATASET_SOURCE="tranducngan/atcv1-source"
$env:HYDRO_KAGGLE_ATC_PREBUILT_PATH="/kaggle/input/atcv1-source/ATC-main"
$env:HYDRO_KAGGLE_ATC_PROJECT_DIR="ATC-main"
$env:HYDRO_KAGGLE_ATC_METHOD="entropy"
$env:HYDRO_KAGGLE_ATC_DEVICE="auto"
$env:HYDRO_KAGGLE_ATC_ALLOW_CPU_FALLBACK="true"
$env:HYDRO_KAGGLE_ATC_INFER_TASK="true"
$env:HYDRO_KAGGLE_ATC_PROMPT_STYLE="regular"
$env:HYDRO_KAGGLE_ATC_PATTERN_WEIGHTS="comments:0,docstrings:0"
$env:HYDRO_KAGGLE_ATC_THRESHOLD="-0.18"
$env:HYDRO_KAGGLE_ATC_MIN_NONEMPTY_LINES="8"
$env:HYDRO_KAGGLE_ATC_MIN_NONWHITESPACE_CHARS="120"
$env:HYDRO_KAGGLE_POLL_INTERVAL_MS="5000"
$env:HYDRO_KAGGLE_TIMEOUT_MS="0"
```

Then run:

```powershell
cd C:\DATN\test\Hydro-master
corepack yarn dev:judge:kaggle-ai
```

Repo helpers:

- env example: `kaggle-model-local.example.ps1`
- Kaggle dataset metadata template: `kaggle-model-dataset-metadata.example.json`
- dataset prep script: `prepare-kaggle-model-dataset.ps1`

Example:

```powershell
cd C:\DATN\test\Hydro-master
.\prepare-kaggle-model-dataset.ps1 -ModelPath C:\DATN\models\CodeLlama-7b-Instruct-hf -KaggleUsername tranducngan
```

The script will:

- validate the local model folder
- copy it into a Kaggle-upload-ready directory
- generate `dataset-metadata.json`
- generate `hydro-kaggle-env.ps1` with the matching `HYDRO_KAGGLE_EXTRA_DATASET_SOURCES` and `HYDRO_KAGGLE_ATC_BASE_MODEL`

## Optional Internet control

You can force the generated Kaggle notebook metadata either way:

```powershell
$env:HYDRO_KAGGLE_ENABLE_INTERNET="false"
```

Use `false` only when your runtime and model are already mounted locally.

## Device selection

- `HYDRO_KAGGLE_ATC_DEVICE=auto`: try CUDA first, then fall back to CPU on CUDA runtime errors.
- `HYDRO_KAGGLE_ATC_DEVICE=cuda`: force CUDA first; still falls back to CPU if `HYDRO_KAGGLE_ATC_ALLOW_CPU_FALLBACK=true`.
- `HYDRO_KAGGLE_ATC_DEVICE=cpu`: skip CUDA entirely.

`HYDRO_KAGGLE_TIMEOUT_MS=0` means Hydro will wait indefinitely for the Kaggle run instead of timing out locally.
