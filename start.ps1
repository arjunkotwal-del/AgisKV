$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

if (-not (Test-Path "$Root\cpp_core\build\aegis_core.dll")) {
    Write-Host "Building C++20 native engine..."
    powershell -ExecutionPolicy Bypass -File "$Root\cpp_core\build.ps1"
}

if (-not (Test-Path "$Root\web\dist\index.html")) {
    Write-Host "Building 3D React Three Fiber showcase..."
    Push-Location "$Root\web"
    npm run build
    Pop-Location
}

Write-Host "Starting AegisKV on http://127.0.0.1:8000 ..."
& "$Root\.venv\Scripts\python.exe" -m uvicorn gateway.app:app --host 127.0.0.1 --port 8000
