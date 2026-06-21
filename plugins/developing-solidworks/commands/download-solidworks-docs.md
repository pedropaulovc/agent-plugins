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

$latestVersion = $response.tag_name
Write-Output "Latest release: $latestVersion"

$downloadUrl = $asset.browser_download_url
Write-Output "Downloading from: $downloadUrl"

# Download
$tempPath = Join-Path $env:TEMP 'solidworks-docs.zip'
Invoke-WebRequest -Uri $downloadUrl -OutFile $tempPath
Write-Output "Downloaded to: $tempPath"

# Resolve the developing-solidworks skill folder.
# NOTE: $env:CLAUDE_PLUGIN_ROOT is only populated for hook / MCP / LSP subprocesses
# that Claude Code launches itself — it is NOT set in a PowerShell/Bash tool call that
# an agent spawns, nor when a human runs this block in a plain shell. So we resolve in
# priority order rather than assuming the env var exists:
#   1. An explicit absolute path passed as an argument (the agent invoking the skill
#      passes its own skill directory here; a human can pass it on the command line).
#   2. $env:CLAUDE_PLUGIN_ROOT (correct, but only present in the hook context).
#   3. A search of the Claude plugins install tree as a last resort.
$skillRelative = 'skills\developing-solidworks'
$argPath = '$ARGUMENTS'.Trim()

if ($argPath -and ($argPath -ne '$ARGUMENTS') -and (Test-Path $argPath)) {
    $targetDir = $argPath
} elseif ($env:CLAUDE_PLUGIN_ROOT) {
    $targetDir = Join-Path $env:CLAUDE_PLUGIN_ROOT $skillRelative
} else {
    $pluginsRoot = Join-Path $env:USERPROFILE '.claude\plugins'
    $found = Get-ChildItem -Path $pluginsRoot -Recurse -Directory -Filter 'developing-solidworks' -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -like "*\$skillRelative" } |
        Select-Object -First 1
    if (-not $found) {
        Write-Error "Could not locate the developing-solidworks skill directory under $pluginsRoot. Re-run with the absolute skill path as an argument, e.g. /download-solidworks-docs C:\path\to\developing-solidworks\skills\developing-solidworks"
        exit 1
    }
    $targetDir = $found.FullName
}
if (-not (Test-Path $targetDir)) {
    New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
}

# Unpack — prefer 7-Zip, fall back to Expand-Archive.
# Locate 7-Zip without assuming a single install path: try the 7z/7za executables on
# PATH first, then the standard install locations under both Program Files trees.
Write-Output "Unpacking to: $targetDir"
$sevenZip = $null
foreach ($name in '7z', '7za') {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    if ($cmd) { $sevenZip = $cmd.Source; break }
}
if (-not $sevenZip) {
    $sevenZip = @($env:ProgramFiles, ${env:ProgramFiles(x86)}) |
        Where-Object { $_ } |
        ForEach-Object { Join-Path $_ '7-Zip\7z.exe' } |
        Where-Object { Test-Path $_ } |
        Select-Object -First 1
}

if ($sevenZip) {
    Write-Output "Using 7-Zip at: $sevenZip"
    # 7-Zip requires the output path glued to the -o switch with no space or quote
    # boundary between them. PowerShell tokenizes `-o"$targetDir"` into a bare `-o`
    # plus a separate path arg, so 7-Zip errors with "Too short switch: -o". Pass the
    # whole switch+path as one quoted token instead.
    & $sevenZip x $tempPath "-o$targetDir" -y
} else {
    Write-Warning "7-Zip (7z/7za) not found on PATH or under Program Files — falling back to Expand-Archive (significantly slower for large archives)."
    Expand-Archive -Path $tempPath -DestinationPath $targetDir -Force
}

# Record the installed version so the skill can detect a stale bundle later
$versionFile = Join-Path $targetDir '.bundle-version'
Set-Content -Path $versionFile -Value $latestVersion -NoNewline
Write-Output "Recorded bundle version $latestVersion to $versionFile"

# Clean up
Remove-Item $tempPath
Write-Output "Done! Unpacked $latestVersion to $targetDir"
```
