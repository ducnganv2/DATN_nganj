param(
    [Parameter(Mandatory = $true)]
    [string]$ModelPath,

    [Parameter(Mandatory = $true)]
    [string]$KaggleUsername,

    [string]$DatasetSlug = "codellama-7b-instruct-hf",
    [string]$DatasetTitle = "CodeLlama 7B Instruct HF",
    [string]$OutputRoot = "C:\DATN\kaggle-models"
)

$ErrorActionPreference = "Stop"

function Require-Path {
    param([string]$PathToCheck, [string]$Label)
    if (-not (Test-Path -LiteralPath $PathToCheck)) {
        throw "$Label does not exist: $PathToCheck"
    }
}

function Ensure-Model-Looks-Valid {
    param([string]$PathToCheck)

    $requiredAny = @(
        "config.json",
        "tokenizer.json",
        "tokenizer_config.json",
        "special_tokens_map.json",
        "generation_config.json",
        "pytorch_model.bin",
        "model.safetensors"
    )

    $present = @()
    foreach ($name in $requiredAny) {
        if (Test-Path -LiteralPath (Join-Path $PathToCheck $name)) {
            $present += $name
        }
    }

    if (-not ($present -contains "config.json")) {
        throw "Model folder is missing config.json: $PathToCheck"
    }

    if (-not (($present -contains "model.safetensors") -or ($present -contains "pytorch_model.bin"))) {
        $shards = Get-ChildItem -LiteralPath $PathToCheck -Filter "*.safetensors" -File -ErrorAction SilentlyContinue
        if (-not $shards) {
            throw "Model folder does not contain model weights (.safetensors or pytorch_model.bin): $PathToCheck"
        }
    }
}

Require-Path -PathToCheck $ModelPath -Label "ModelPath"
Ensure-Model-Looks-Valid -PathToCheck $ModelPath

$resolvedModelPath = (Resolve-Path -LiteralPath $ModelPath).Path
$outputDir = Join-Path $OutputRoot $DatasetSlug

if (Test-Path -LiteralPath $outputDir) {
    Remove-Item -LiteralPath $outputDir -Recurse -Force
}

New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
Copy-Item -LiteralPath $resolvedModelPath -Destination (Join-Path $outputDir $DatasetSlug) -Recurse -Force

$metadata = @{
    title = $DatasetTitle
    id = "$KaggleUsername/$DatasetSlug"
    licenses = @(
        @{
            name = "other"
        }
    )
}

$metadataPath = Join-Path $outputDir "dataset-metadata.json"
$metadata | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $metadataPath -Encoding UTF8

$envExample = @"
\$env:HYDRO_SUBMISSION_AI_PROVIDER="kaggle"
\$env:HYDRO_KAGGLE_KERNEL_ID="tranducngan/atcv1"
\$env:HYDRO_KAGGLE_ATC_DATASET_SOURCE="tranducngan/atcv1-source"
\$env:HYDRO_KAGGLE_ATC_PREBUILT_PATH="/kaggle/input/datasets/tranducngan/atcv1-source/ATC-main"
\$env:HYDRO_KAGGLE_ATC_PROJECT_DIR="ATC-main"
\$env:HYDRO_KAGGLE_EXTRA_DATASET_SOURCES="$KaggleUsername/$DatasetSlug"
\$env:HYDRO_KAGGLE_ATC_BASE_MODEL="/kaggle/input/$DatasetSlug/$DatasetSlug"
\$env:HYDRO_KAGGLE_ENABLE_INTERNET="false"
\$env:HYDRO_KAGGLE_INSTALL_P100_TORCH="false"
\$env:HYDRO_KAGGLE_ATC_METHOD="entropy"
\$env:HYDRO_KAGGLE_ATC_DEVICE="auto"
\$env:HYDRO_KAGGLE_ATC_ALLOW_CPU_FALLBACK="true"
\$env:HYDRO_KAGGLE_ATC_INFER_TASK="true"
\$env:HYDRO_KAGGLE_ATC_PROMPT_STYLE="regular"
\$env:HYDRO_KAGGLE_ATC_PATTERN_WEIGHTS="comments:0,docstrings:0"
\$env:HYDRO_KAGGLE_ATC_THRESHOLD="-0.18"
\$env:HYDRO_KAGGLE_ATC_MIN_NONEMPTY_LINES="8"
\$env:HYDRO_KAGGLE_ATC_MIN_NONWHITESPACE_CHARS="120"
\$env:HYDRO_KAGGLE_POLL_INTERVAL_MS="5000"
\$env:HYDRO_KAGGLE_TIMEOUT_MS="0"
"@

$envPath = Join-Path $outputDir "hydro-kaggle-env.ps1"
Set-Content -LiteralPath $envPath -Value $envExample -Encoding UTF8

Write-Host "Prepared Kaggle model dataset folder:" -ForegroundColor Green
Write-Host "  $outputDir"
Write-Host ""
Write-Host "Next commands:" -ForegroundColor Cyan
Write-Host "  kaggle datasets create -p `"$outputDir`""
Write-Host "or update an existing dataset:"
Write-Host "  kaggle datasets version -p `"$outputDir`" -m `"update model`""
Write-Host ""
Write-Host "Generated helper env file:"
Write-Host "  $envPath"
