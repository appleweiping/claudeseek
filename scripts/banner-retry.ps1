# Retry gpt-image-2 banner generation until the relay channel recovers.
# Usage: powershell -File scripts/banner-retry.ps1 [-Tries 30] [-DelaySec 90]
param([int]$Tries = 30, [int]$DelaySec = 90)
$ErrorActionPreference = "Continue"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$env:OPENAI_BASE_URL = if ($env:OPENAI_BASE_URL) { $env:OPENAI_BASE_URL } else { "https://api.sbbbbbbbbb.xyz/v1" }
$env:BANNER_IMAGE_MODEL = "gpt-image-2"
for ($i = 1; $i -le $Tries; $i++) {
  Write-Host "[banner-retry] attempt $i/$Tries"
  python "$here\gen-banner.py"
  if ($LASTEXITCODE -eq 0 -and (Test-Path "$here\..\assets\banner.png")) {
    Write-Host "[banner-retry] SUCCESS — banner.png generated"
    exit 0
  }
  if ($i -lt $Tries) { Start-Sleep -Seconds $DelaySec }
}
Write-Host "[banner-retry] gave up after $Tries attempts; SVG banner remains in place"
exit 1
