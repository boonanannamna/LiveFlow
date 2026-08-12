param(
  [string]$Python = "py"
)

$ErrorActionPreference = "Stop"
Push-Location $PSScriptRoot
try {
  & $Python -m pip install --upgrade --force-reinstall "TikTokLive @ git+https://github.com/isaackogan/TikTokLive.git"
  & $Python -c "import TikTokLive; print('TikTokLive updated:', getattr(TikTokLive, '__version__', 'unknown'))"
} finally {
  Pop-Location
}

