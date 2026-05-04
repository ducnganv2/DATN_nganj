# Online Judge System with AI-Generated Code Checking

[Vietnamese version](./README.md)

## Overview

This is the main project repository for the graduation project. It is based on [Hydro](https://github.com/hydro-dev/Hydro) and extends it with AI-generated code checking for accepted submissions.

Current project scope:

- Work only inside `Hydro-master`.
- No local sibling `ATC` folder is required.
- No local `ATC_impl` detector API is used by the main workflow.
- AI checking is executed asynchronously on Kaggle with a prebuilt runtime and model mounted through Kaggle inputs.

The source code and environment variables still use the name `ATC` because that is the detector/runtime name used by the Kaggle job. The important point is that Hydro no longer reads detector code from a local `../ATC` directory.

## Goals

- Provide an Online Judge for programming submissions, including `C`, `C++`, `Python`, and other languages supported by Hydro.
- Run the full frontend, backend, database, and judge worker flow.
- Store submissions, judge status, test cases, score, runtime, memory usage, and AI-check metadata.
- Run AI checking only after a submission is judged `Accepted`, which avoids spending Kaggle resources on wrong submissions.
- Use Kaggle GPU runtime when the local machine does not have enough VRAM/RAM for the detector.

## Architecture

```text
User submits code
-> Hydro frontend receives the submit form
-> Backend creates a record with pending AI check metadata
-> Docker judge runs hydrojudge
-> If the submission is not Accepted: AI check is marked skipped
-> If the submission is Accepted: Hydro generates and pushes a Kaggle notebook
-> Kaggle runs the detector with the mounted runtime/model
-> Hydro downloads ai-check-result.json
-> Hydro updates record.aiCheck and the UI displays the result
```

Main components:

| Component | Path | Purpose |
| --- | --- | --- |
| Frontend | `packages/ui-default` | Problem, submit, record, and contest UI |
| Backend | `packages/hydrooj` | Routes, services, models, task queue, record updates |
| Shared types | `packages/common/types.ts` | `SubmissionAICheck` and `RecordPayload.aiCheck` |
| Judge | `packages/hydrojudge` | Receives judge tasks and reports results |
| Local Docker judge | `install/docker` | Runs `hydrojudge` in a container |
| AI check service | `packages/hydrooj/src/service/submissionAI.ts` | Selects provider, generates Kaggle notebooks, reads results |
| Kaggle helpers | `prepare-kaggle-*.ps1`, `kaggle-model-local.example.ps1` | Prepare model/runtime assets for Kaggle |

## Important Directory Structure

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

## AI Check Flow

### 1. Before record creation

The submit page sets `UiContext.aiCheckUrl` to:

```text
POST /p/:pid/submit/ai-check
```

When the Kaggle provider is active, this route returns quickly with `aiCheck.state = pending`. The real submission continues and is judged normally.

### 2. During record creation

`packages/hydrooj/src/handler/problem.ts` parses `aiCheckPayload` from the form. If the payload is missing, invalid, or still `pending`, the record is stored with pending AI-check metadata.

Records are created in:

```text
packages/hydrooj/src/model/record.ts
```

Example MongoDB field:

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

### 3. After judge result

`packages/hydrooj/src/handler/judge.ts` decides what to do next:

- If the submission is not `Accepted`, AI check is marked `skipped`.
- If the submission is `Accepted`, Hydro schedules `checkSubmissionForAI()` asynchronously.

This keeps judging responsive and saves Kaggle work for submissions that matter.

### 4. Kaggle execution

`packages/hydrooj/src/service/submissionAI.ts` performs these steps:

1. Reads `HYDRO_KAGGLE_*` environment variables.
2. Creates a temporary work directory under `%TEMP%\hydro-kaggle-ai-check`.
3. Generates `hydro-kaggle-ai-check.ipynb`.
4. Generates `kernel-metadata.json`.
5. Runs `kaggle kernels push`.
6. Polls with `kaggle kernels status`.
7. Downloads outputs with `kaggle kernels output`.
8. Parses `ai-check-result.json`.
9. Updates `record.aiCheck` and broadcasts `record/change` so the UI refreshes.

### 5. UI states

Possible `aiCheck.state` values:

| State | Meaning |
| --- | --- |
| `pending` | Waiting for Kaggle or waiting for an Accepted judge result |
| `checked` | Detector returned a score and a `Potential AI` or `Not AI` decision |
| `skipped` | Check was skipped, usually because the submission was not Accepted or the code is too short |
| `error` | Kaggle, CLI, runtime, or output parsing failed |

UI templates:

- `packages/ui-default/templates/record_main_tr.html`
- `packages/ui-default/templates/record_detail_status.html`

## Requirements

The expected development environment is Windows + PowerShell:

- Node.js `22`
- Corepack/Yarn `4`
- Docker Desktop with Linux containers
- Local MongoDB, or MongoDB running in Docker
- Python `3.10+`
- Kaggle CLI
- A Kaggle account that can push kernels and read the required dataset/model inputs

Quick checks:

```powershell
node -v
corepack --version
docker --version
python --version
kaggle --version
```

## First-Time Setup

### 1. Enter the project directory

```powershell
cd C:\DATN\test\Hydro-master
```

### 2. Install Node.js dependencies

```powershell
corepack enable
corepack yarn install
```

### 3. Create local Hydro config

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.hydro" | Out-Null
'{"url":"mongodb://localhost:27017/hydro"}' | Set-Content "$env:USERPROFILE\.hydro\config.json"
'["@hydrooj/ui-default"]' | Set-Content "$env:USERPROFILE\.hydro\addon.json"
```

### 4. Start MongoDB

If the container does not exist yet:

```powershell
docker run -d --name hydro-mongo -p 27017:27017 mongo:7-jammy
```

If it already exists but is stopped:

```powershell
docker start hydro-mongo
```

Check it:

```powershell
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
```

### 5. Install and configure Kaggle CLI

```powershell
python -m pip install kaggle
```

Place the token file at:

```text
C:\Users\<user>\.kaggle\kaggle.json
```

Check authentication:

```powershell
kaggle kernels list -m
```

## Current Kaggle Configuration

The main script in `package.json` is:

```powershell
corepack yarn dev:judge:kaggle-ai
```

It already sets the important variables:

| Variable | Current default |
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

`HYDRO_KAGGLE_TIMEOUT_MS=0` means Hydro waits indefinitely on the local side. The actual run still depends on Kaggle quota, kernel state, and Kaggle limits.

To customize the Kaggle account, dataset, or model paths:

```powershell
Copy-Item .\kaggle-model-local.example.ps1 .\kaggle-model-local.ps1
notepad .\kaggle-model-local.ps1
```

Then run:

```powershell
.\kaggle-model-local.ps1
```

## Daily Workflow

### 1. Make sure MongoDB is running

```powershell
docker start hydro-mongo
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
```

### 2. Terminal A: start Hydro frontend + backend

```powershell
cd C:\DATN\test\Hydro-master
corepack yarn dev:judge:kaggle-ai
```

Expected console lines:

```text
Backend:  http://127.0.0.1:2333
Frontend: http://localhost:8000
```

Check the backend:

```powershell
Invoke-WebRequest http://127.0.0.1:2333/status -UseBasicParsing | Select-Object -ExpandProperty StatusCode
```

### 3. Terminal B: start Docker judge

First run, or after changing the Dockerfile:

```powershell
cd C:\DATN\test\Hydro-master\install\docker
docker compose -f docker-compose.local-judge.yml up -d --build
docker logs -f oj-judge-local
```

Later runs:

```powershell
cd C:\DATN\test\Hydro-master\install\docker
docker compose -f docker-compose.local-judge.yml up -d
docker logs -f oj-judge-local
```

The judge container connects to the local backend through:

```text
http://host.docker.internal:2333/
```

`install/docker/judge/entrypoint.sh` waits for `http://host.docker.internal:2333/status` before starting `hydrojudge`.

### 4. Open the UI

- Frontend: `http://localhost:8000`
- Backend: `http://127.0.0.1:2333`

## First Judge User

If judge logs show `UserNotFoundError`, create the judge user:

```powershell
cd C:\DATN\test\Hydro-master
node packages\hydrooj\bin\hydrooj.js cli user create systemjudge@systemjudge.local judge examplepassword auto
node packages\hydrooj\bin\hydrooj.js cli user setJudge <UID>
```

Then restart the judge:

```powershell
cd C:\DATN\test\Hydro-master\install\docker
docker restart oj-judge-local
docker logs -f oj-judge-local
```

The local judge credentials are configured in:

```text
install/docker/judge/judge.local.yaml
```

## Verify the Submit Flow

1. Open `http://localhost:8000`.
2. Log in with an account that can submit.
3. Open a problem and submit code.
4. Open the new record.
5. While judging, AI state is usually `Pending`.
6. If the submission is not Accepted, AI state becomes `Skipped`.
7. If the submission is Accepted, Hydro pushes a Kaggle job.
8. When Kaggle finishes, the record becomes `Potential AI` or `Not AI`.

Check Kaggle status:

```powershell
kaggle kernels status tranducngan/atcv1
```

Download the latest output for debugging:

```powershell
kaggle kernels output tranducngan/atcv1 -p C:\DATN\kaggle-out -o
Get-Content C:\DATN\kaggle-out\ai-check-result.json
```

## Stop the System

Stop Hydro:

```text
Ctrl + C
```

Stop Docker judge:

```powershell
cd C:\DATN\test\Hydro-master\install\docker
docker compose -f docker-compose.local-judge.yml down
```

Stop MongoDB if needed:

```powershell
docker stop hydro-mongo
```

## Prepare Kaggle Model/Runtime Assets

The current workflow assumes the detector runtime and model are already mounted on Kaggle. To prepare a model dataset again:

```powershell
cd C:\DATN\test\Hydro-master
.\prepare-kaggle-model-dataset.ps1 -ModelPath C:\DATN\models\CodeLlama-7b-Instruct-hf -KaggleUsername <kaggle-username>
```

The script will:

- Validate the local model folder.
- Create a Kaggle-upload-ready dataset directory.
- Generate `dataset-metadata.json`.
- Generate a matching `hydro-kaggle-env.ps1`.

If the model needs conversion from `.bin` to safetensors:

```powershell
cd C:\DATN\test\Hydro-master
.\prepare-kaggle-model-safetensors.ps1
```

If a P100 wheelhouse is needed:

```powershell
cd C:\DATN\test\Hydro-master
.\prepare-kaggle-p100-torch-wheels.ps1
```

## `aiCheck` Format

`aiCheck` is stored directly in the record document:

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

Fields:

- `state`: `pending`, `checked`, `skipped`, or `error`.
- `isAI`: `true` if the score passes the threshold, `false` otherwise, `null` before a decision exists.
- `score`: detector score.
- `threshold`: decision threshold.
- `confidence`: percentage derived from the distance between `score` and `threshold`.
- `provider`: current provider, usually `kaggle-atc`.
- `message`: short debug message shown in the UI.
- `checkedAt`: result timestamp.

## Common Commands

Install dependencies:

```powershell
corepack yarn install
```

Run Hydro dev mode with backend exposed for Docker judge:

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

Lint:

```powershell
corepack yarn lint:ci
```

## Troubleshooting

### Submission stuck at `0 Waiting`

Common causes:

- Docker judge is not running.
- Backend is not running.
- Backend port `2333` is not open.
- Judge cannot log in with the `judge` user.

Check:

```powershell
Invoke-WebRequest http://127.0.0.1:2333/status -UseBasicParsing
docker logs -f oj-judge-local
```

### Judge reports `connect ECONNREFUSED ...:2333`

The judge cannot reach the local backend.

Check:

- The terminal running `corepack yarn dev:judge:kaggle-ai` is still alive.
- `http://127.0.0.1:2333/status` is reachable.
- Docker Desktop is running Linux containers.
- `install/docker/judge/judge.local.yaml` points `server_url` to `http://host.docker.internal:2333/`.

### Judge reports `UserNotFoundError`

Create the judge user using the "First Judge User" section, then restart `oj-judge-local`.

### AI check stays `Pending` for too long

Check:

```powershell
kaggle kernels status tranducngan/atcv1
```

Possible causes:

- Kaggle kernel is queued or running for a long time.
- Kaggle GPU quota is exhausted.
- Kaggle CLI is authenticated with the wrong account.
- Jobs are serialized, so multiple submissions wait for the same kernel.
- `HYDRO_KAGGLE_TIMEOUT_MS=0` tells Hydro to keep waiting locally.

### AI check returns `Check failed`

Download the output:

```powershell
kaggle kernels output tranducngan/atcv1 -p C:\DATN\kaggle-out -o
Get-Content C:\DATN\kaggle-out\ai-check-result.json
```

Common causes:

- Wrong `HYDRO_KAGGLE_ATC_PREBUILT_PATH`.
- The Kaggle dataset does not contain the detector runtime.
- Model path `/kaggle/input/codellama-7b-instruct-hf` does not exist.
- Missing wheel or Python package in the Kaggle runtime.
- Kaggle did not attach the expected dataset/model source.

### Backend cannot start because of MongoDB

Check the container:

```powershell
docker ps -a --filter "name=hydro-mongo"
docker start hydro-mongo
```

Check Hydro config:

```powershell
Get-Content "$env:USERPROFILE\.hydro\config.json"
```

Expected config:

```json
{"url":"mongodb://localhost:27017/hydro"}
```

### Short code is marked `Skipped`

The current configuration skips very short code:

- Fewer than `8` non-empty lines.
- Or fewer than `120` non-whitespace characters.

Tune it with:

```powershell
$env:HYDRO_KAGGLE_ATC_MIN_NONEMPTY_LINES="8"
$env:HYDRO_KAGGLE_ATC_MIN_NONWHITESPACE_CHARS="120"
```

## Operational Notes

- `dev:judge:kaggle-ai` is the main workflow for this project.
- `dev:judge:atc-ai` still exists in `package.json` for old experiments, but it is not used by this documentation.
- Do not run `cd ..\ATC`; do not install Python dependencies from a local `ATC` folder.
- The detector runtime used by Kaggle must be prepared and mounted before running Hydro.
- With a single Kaggle kernel, Hydro serializes jobs to avoid multiple submissions overwriting the same kernel.
- For parallel checking, configure multiple kernels with `HYDRO_KAGGLE_KERNEL_IDS` and make sure all kernels have the same dataset/model sources.
