$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$BuildDir = Join-Path $Root "build"
New-Item -ItemType Directory -Force -Path $BuildDir | Out-Null

$VsDevCmd = @(
    "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat",
    "C:\Program Files\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat",
    "C:\Program Files\Microsoft Visual Studio\2022\Professional\VC\Auxiliary\Build\vcvars64.bat"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $VsDevCmd) {
    throw "Could not find Visual Studio vcvars64.bat"
}

$cmd = @"
call "$VsDevCmd" >nul
pushd "$BuildDir"
cl /nologo /std:c++20 /O2 /EHsc /W4 /DAEGIS_CORE_EXPORTS /I"$Root\include" /I"$Root\src" /LD "$Root\src\c_api.cpp" "$Root\src\hnsw_cache.cpp" "$Root\src\guardrail.cpp" /Fe:"$BuildDir\aegis_core.dll" /link /IMPLIB:"$BuildDir\aegis_core.lib"
if errorlevel 1 exit /b 1
cl /nologo /std:c++20 /O2 /EHsc /W4 /DAEGIS_CORE_EXPORTS /I"$Root\include" /I"$Root\src" "$Root\tests\cpp_tests.cpp" "$Root\src\c_api.cpp" "$Root\src\hnsw_cache.cpp" "$Root\src\guardrail.cpp" /Fe:"$BuildDir\aegis_tests.exe"
if errorlevel 1 exit /b 1
cl /nologo /std:c++20 /O2 /EHsc /W4 /I"$Root\include" /I"$Root\src" "$Root\bench\cpp_bench.cpp" "$Root\src\hnsw_cache.cpp" "$Root\src\guardrail.cpp" /Fe:"$BuildDir\aegis_bench.exe"
if errorlevel 1 exit /b 1
popd
"@

$TempBat = Join-Path $BuildDir "compile_all.bat"
Set-Content -Path $TempBat -Value $cmd -Encoding Ascii
cmd /c "`"$TempBat`""
if ($LASTEXITCODE -ne 0) {
    throw "C++ build failed with exit code $LASTEXITCODE"
}
Write-Host "Built C++20 artifacts in $BuildDir"
