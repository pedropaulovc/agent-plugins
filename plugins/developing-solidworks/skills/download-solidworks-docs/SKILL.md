---
name: download-solidworks-docs
description: Windows/PowerShell — download and unpack the latest offline SolidWorks API documentation bundle into the developing-solidworks skill folder so the main skill can serve docs locally.
---

# Download SolidWorks API docs

Download and unpack the latest offline SolidWorks API documentation bundle from
GitHub releases into the `developing-solidworks` skill folder (the main skill in
this same plugin, at `skills/developing-solidworks/` under the plugin root). This
is a **Windows / PowerShell** task.

## Resolve the target directory

Before running the script, determine the absolute path of the sibling
`developing-solidworks` skill directory and pass it to the script as `$targetDir`:

- This skill's own file lives at `skills/download-solidworks-docs/SKILL.md` under
  the plugin root. Its sibling — the main skill — is `skills/developing-solidworks/`
  under the same plugin root. Resolve that absolute path from this skill's location
  (Codex tells you this skill's file path when it loads the skill).
- If you cannot resolve it that way, fall back to searching for a
  `*/skills/developing-solidworks` directory under BOTH `~/.claude/plugins` and
  `~/.codex/plugins`.

## Run the script

Set `$targetDir` to the resolved absolute path, then run the PowerShell block below:

```powershell
# $targetDir must already be set to the absolute path of the
# skills/developing-solidworks directory (resolved as described above).

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

if (-not $targetDir) {
    Write-Error "`$targetDir is not set. Resolve the skills/developing-solidworks directory (a sibling of this skill's directory), or search ~/.claude/plugins and ~/.codex/plugins for a */skills/developing-solidworks directory, then set `$targetDir to that absolute path and re-run."
    exit 1
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

Report the version that was unpacked and the target directory.
