param(
    [string]$InputDir = "C:\DATN\test\kaggle-models\codellama-7b-instruct-hf",
    [string]$OutputDir = "C:\DATN\test\kaggle-models\codellama-7b-instruct-hf-safetensors",
    [string]$DatasetRef = "tranducngan/codellama-7b-instruct-hf-safetensors",
    [switch]$InstallDeps,
    [switch]$Upload,
    [switch]$Version
)

$ErrorActionPreference = "Stop"

if ($InstallDeps) {
    python -m pip install --upgrade `
        "torch>=2.6,<2.7" `
        "safetensors>=0.4.5"
}

python "$PSScriptRoot\scripts\convert_model_bin_to_safetensors.py" `
    --input-dir $InputDir `
    --output-dir $OutputDir `
    --dataset-ref $DatasetRef

if ($Upload) {
    kaggle datasets create -p $OutputDir -r zip
}
elseif ($Version) {
    kaggle datasets version -p $OutputDir -m "Convert CodeLlama weights to safetensors" -r zip
}
else {
    Write-Host "Safetensors dataset folder is ready at $OutputDir"
    Write-Host "Upload first time: kaggle datasets create -p `"$OutputDir`" -r zip"
    Write-Host "Upload update:     kaggle datasets version -p `"$OutputDir`" -m `"Convert CodeLlama weights to safetensors`" -r zip"
}
