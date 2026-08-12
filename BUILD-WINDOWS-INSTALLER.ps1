$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$connectorRoot = Join-Path $projectRoot "connector\TikTokLive-master"
$python = Join-Path $connectorRoot ".venv\Scripts\python.exe"
$resources = Join-Path $projectRoot "src-tauri\resources"
$icon = Join-Path $projectRoot "src-tauri\icons\icon.ico"

if (-not (Test-Path $python)) {
  throw "ไม่พบ Python virtual environment สำหรับขั้นตอน Build"
}

& $python -m pip show pyinstaller *> $null
if ($LASTEXITCODE -ne 0) {
  & $python -m pip install pyinstaller
}

New-Item -ItemType Directory -Force $resources | Out-Null
Push-Location $connectorRoot
try {
  # Keep the console subsystem so stdin/stdout pipes work. Tauri launches it with
  # CREATE_NO_WINDOW, therefore users still never see a console window.
  & $python -m PyInstaller --noconfirm --clean --onefile --console `
    --name liveflow-tiktok-connector --icon $icon --paths . `
    --collect-all TikTokLive --collect-all TikTokLiveProto `
    --distpath $resources --workpath .pyinstaller-build `
    --specpath .pyinstaller-spec tiktok_connector.py
} finally {
  Pop-Location
}

Push-Location $projectRoot
try {
  npm run tauri:build -- --bundles nsis
} finally {
  Pop-Location
}
