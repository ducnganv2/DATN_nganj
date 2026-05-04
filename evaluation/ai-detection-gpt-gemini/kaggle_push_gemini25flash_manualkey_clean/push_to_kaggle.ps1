$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Write-Host "Pushing Kaggle kernel from: $root"
Write-Host "Keep this Kaggle kernel private because the script contains a Gemini API key."

kaggle kernels push -p $root
