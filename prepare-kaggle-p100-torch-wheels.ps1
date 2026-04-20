param(
    [string]$OutputDir = "C:\DATN\test\kaggle-p100-torch-cu124-wheels",
    [string]$DatasetRef = "tranducngan/p100-torch-cu124-wheels",
    [switch]$Upload,
    [switch]$Version
)

$ErrorActionPreference = "Stop"

$wheelDir = Join-Path $OutputDir "wheels"
New-Item -ItemType Directory -Force -Path $wheelDir | Out-Null

function Invoke-NativeChecked {
    param(
        [string]$FilePath,
        [string[]]$Arguments
    )
    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$FilePath failed with exit code $LASTEXITCODE"
    }
}

function Set-Utf8NoBomContent {
    param(
        [string]$Path,
        [string]$Value
    )
    $encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Value, $encoding)
}

$metadata = @{
    id = $DatasetRef
    title = "P100 Torch CU124 Wheels"
    licenses = @(@{ name = "CC0-1.0" })
}
Set-Utf8NoBomContent -Path (Join-Path $OutputDir "dataset-metadata.json") -Value ($metadata | ConvertTo-Json -Depth 5)

@"
# P100 Torch CU124 Wheels

Offline wheelhouse for Hydro Kaggle ATC on Tesla P100.

Hydro can install from this dataset by setting:

HYDRO_KAGGLE_EXTRA_DATASET_SOURCES=tranducngan/codellama-7b-instruct-hf,$DatasetRef
HYDRO_KAGGLE_P100_TORCH_WHEEL_PATH=/kaggle/input/p100-torch-cu124-wheels/wheels
"@ | ForEach-Object {
    Set-Utf8NoBomContent -Path (Join-Path $OutputDir "README.md") -Value $_
}

$pipArgs = @(
    "-m", "pip", "download",
    "--dest", $wheelDir,
    "--only-binary=:all:",
    "--platform", "linux_x86_64",
    "--platform", "manylinux2014_x86_64",
    "--platform", "manylinux_2_17_x86_64",
    "--python-version", "312",
    "--implementation", "cp",
    "--abi", "cp312",
    "--index-url", "https://download.pytorch.org/whl/cu124",
    "--extra-index-url", "https://pypi.org/simple",
    "torch==2.6.0",
    "MarkupSafe==3.0.3",
    "nvidia-cuda-nvrtc-cu12==12.4.127",
    "nvidia-cuda-runtime-cu12==12.4.127",
    "nvidia-cuda-cupti-cu12==12.4.127",
    "nvidia-cudnn-cu12==9.1.0.70",
    "nvidia-cublas-cu12==12.4.5.8",
    "nvidia-cufft-cu12==11.2.1.3",
    "nvidia-curand-cu12==10.3.5.147",
    "nvidia-cusolver-cu12==11.6.1.9",
    "nvidia-cusparse-cu12==12.3.1.170",
    "nvidia-cusparselt-cu12==0.6.2",
    "nvidia-nccl-cu12==2.21.5",
    "nvidia-nvtx-cu12==12.4.127",
    "nvidia-nvjitlink-cu12==12.4.127",
    "triton==3.2.0",
    "setuptools"
)
Invoke-NativeChecked -FilePath "python" -Arguments $pipArgs

if ($Upload) {
    Invoke-NativeChecked -FilePath "kaggle" -Arguments @("datasets", "create", "-p", $OutputDir, "-r", "zip")
}
elseif ($Version) {
    Invoke-NativeChecked -FilePath "kaggle" -Arguments @("datasets", "version", "-p", $OutputDir, "-m", "Update PyTorch P100 wheelhouse", "-r", "zip")
}
else {
    Write-Host "Wheelhouse is ready at $OutputDir"
    Write-Host "Upload first time: kaggle datasets create -p `"$OutputDir`" -r zip"
    Write-Host "Upload update:     kaggle datasets version -p `"$OutputDir`" -m `"Update PyTorch P100 wheelhouse`" -r zip"
}
