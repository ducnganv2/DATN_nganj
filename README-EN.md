# Online Judge System with ATC AI-Generated Code Detection

[Vietnamese Version](./README.md)

## Overview

This repository is based on [Hydro](https://github.com/hydro-dev/Hydro) and customized for:

- Online Judge development (frontend + backend + judge)
- AI-generated code checking via ATC API integration

## Architecture

- **Frontend**: `packages/ui-default`
- **Backend**: `packages/hydrooj`
- **Database**: MongoDB
- **Judge**: `hydrojudge` in Docker
- **AI check API**: `C:\DATN\test\ATC_impl`

## Prerequisites

- Node.js 22
- Yarn 4 (`corepack`)
- Docker Desktop (Linux containers)
- MongoDB local

If MongoDB is not running yet:

```powershell
docker run -d --name hydro-mongo -p 27017:27017 mongo:7-jammy
```

## Setup

### 1. Install dependencies

```powershell
cd C:\DATN\test\Hydro-master
corepack yarn install
```

### 2. Create local Hydro config

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.hydro" | Out-Null
'{"url":"mongodb://localhost:27017/hydro"}' | Set-Content "$env:USERPROFILE\.hydro\config.json"
'["@hydrooj/ui-default"]' | Set-Content "$env:USERPROFILE\.hydro\addon.json"
```

## Run (New ATC Flow)

### 1. Start ATC API

Open a separate terminal:

```powershell
powershell -ExecutionPolicy Bypass -File C:\DATN\test\ATC_impl\start_atc_api.ps1
```

Optional ATC settings before starting:

```powershell
$env:ATC_MODE="heuristic"    # or "atc"
$env:ATC_THRESHOLD="0.5"
```

### 2. Start Hydro (frontend + backend) with ATC API

```powershell
cd C:\DATN\test\Hydro-master
corepack yarn dev:judge:atc-ai
```

This uses:

- `HYDRO_SUBMISSION_AI_API_URL=http://127.0.0.1:19091/check`

### 3. Start judge container

In another terminal:

```powershell
cd C:\DATN\test\Hydro-master\install\docker
docker compose -f docker-compose.local-judge.yml up -d --build
docker logs -f oj-judge-local
```

Judge connects to backend via:

- `http://host.docker.internal:2333/`

### 4. Create judge user (first run only)

If judge logs show `UserNotFoundError`:

```powershell
cd C:\DATN\test\Hydro-master
node packages\hydrooj\bin\hydrooj.js cli user create systemjudge@systemjudge.local judge examplepassword auto
node packages\hydrooj\bin\hydrooj.js cli user setJudge <UID>
```

Then restart judge:

```powershell
cd C:\DATN\test\Hydro-master\install\docker
docker restart oj-judge-local
docker logs -f oj-judge-local
```

## Access URLs

- Frontend: `http://localhost:8000`
- Backend: `http://127.0.0.1:2333`
- ATC API check: `http://127.0.0.1:19091/check`
- ATC API health: `http://127.0.0.1:19091/health`

## Daily Workflow

1. Make sure MongoDB is running.
2. Start ATC API (`start_atc_api.ps1`).
3. Start Hydro (`corepack yarn dev:judge:atc-ai`).
4. Start judge docker compose.

## Stop

- Stop ATC API: `Ctrl + C` in the ATC terminal
- Stop Hydro dev server: `Ctrl + C` in Hydro terminal
- Stop judge:

```powershell
cd C:\DATN\test\Hydro-master\install\docker
docker compose -f docker-compose.local-judge.yml down
```

## Troubleshooting

### Submission stuck at `0 Waiting`

- Judge container is not running
- Backend is not running on `2333`

Check:

```powershell
curl http://127.0.0.1:2333/status
docker logs -f oj-judge-local
```

### `connect ECONNREFUSED ...:2333`

- `corepack yarn dev:judge:atc-ai` is not running
- Port `2333` is not open

### AI check returns `error`

- ATC API process is not running
- `http://127.0.0.1:19091/health` is not healthy
- Hydro is not started with `dev:judge:atc-ai`

## Important Paths

- `packages/hydrooj`
- `packages/ui-default`
- `packages/hydrojudge`
- `install/docker`
- `C:\DATN\test\ATC_impl`
