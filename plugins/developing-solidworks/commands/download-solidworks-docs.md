---
description: Download and unpack the latest SolidWorks API documentation into the developing-solidworks skill folder
---

Download and unpack the latest SolidWorks API documentation from GitHub releases:

```powershell
# Get latest release info
$response = Invoke-RestMethod -Uri 'https://api.github.com/repos/pedropaulovc/offline-solidworks-api-docs/releases/latest'
$asset = $response.assets | Where-Object { $_.name -like '*llms.v*.zip' }

if (-not $asset) {
    Write-Error "Could not find llms zip file in release"
    exit 1
}

$downloadUrl = $asset.browser_download_url
Write-Output "Downloading from: $downloadUrl"

# Download
$tempPath = Join-Path $env:TEMP 'solidworks-docs.zip'
Invoke-WebRequest -Uri $downloadUrl -OutFile $tempPath
Write-Output "Downloaded to: $tempPath"

# Resolve the skill folder inside this plugin
if (-not $env:CLAUDE_PLUGIN_ROOT) {
    Write-Error "CLAUDE_PLUGIN_ROOT is not set. This command must be run from within Claude Code with the developing-solidworks plugin installed."
    exit 1
}
$targetDir = Join-Path $env:CLAUDE_PLUGIN_ROOT 'skills\developing-solidworks'
if (-not (Test-Path $targetDir)) {
    New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
}

# Unpack — prefer 7-Zip, fall back to Expand-Archive
Write-Output "Unpacking to: $targetDir"
$sevenZip = "C:\Program Files\7-Zip\7z.exe"
if (Test-Path $sevenZip) {
    & $sevenZip x $tempPath -o"$targetDir" -y
} else {
    Write-Warning "7-Zip not found at $sevenZip — falling back to Expand-Archive (significantly slower for large archives)."
    Expand-Archive -Path $tempPath -DestinationPath $targetDir -Force
}

# Clean up
Remove-Item $tempPath
Write-Output "Done! Unpacked to $targetDir"
```
