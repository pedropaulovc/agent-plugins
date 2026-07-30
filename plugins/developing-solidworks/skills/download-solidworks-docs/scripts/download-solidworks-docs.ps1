[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string] $TargetDir,

    [string] $ApiUri = 'https://api.github.com/repos/pedropaulovc/offline-solidworks-api-docs/releases/latest',

    [string] $TempPath = (Join-Path ([IO.Path]::GetTempPath()) ('solidworks-docs-{0}.zip' -f [guid]::NewGuid()))
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($TargetDir -notmatch '^(?:[A-Za-z]:[\\/]|\\\\)') {
    throw "TargetDir must be an absolute path: $TargetDir"
}

$TargetDir = [IO.Path]::GetFullPath($TargetDir)
$TempPath = [IO.Path]::GetFullPath($TempPath)

if (Test-Path -LiteralPath $TargetDir -PathType Leaf) {
    throw "TargetDir is a file, not a directory: $TargetDir"
}

if (-not (Test-Path -LiteralPath $TargetDir)) {
    New-Item -ItemType Directory -Path $TargetDir -Force | Out-Null
}

$tempDownloaded = $false

try {
    $response = Invoke-RestMethod -Uri $ApiUri -Headers @{
        Accept = 'application/vnd.github+json'
        'User-Agent' = 'developing-solidworks-docs-downloader'
    }
    $assets = @($response.assets | Where-Object { $_.name -like '*llms.v*.zip' })

    if ($assets.Count -ne 1) {
        throw "Expected exactly one llms zip asset in release, found $($assets.Count)"
    }

    $asset = $assets[0]
    $latestVersion = $response.tag_name
    $downloadUrl = $asset.browser_download_url

    Write-Output "Latest release: $latestVersion"
    Write-Output "Downloading from: $downloadUrl"

    Invoke-WebRequest -Uri $downloadUrl -OutFile $TempPath
    $tempDownloaded = $true
    Write-Output "Downloaded to: $TempPath"

    Write-Output "Unpacking to: $TargetDir"
    $sevenZip = $null
    foreach ($name in '7z', '7za') {
        $command = Get-Command $name -ErrorAction SilentlyContinue
        if ($command) {
            $sevenZip = $command.Source
            break
        }
    }

    if (-not $sevenZip) {
        $sevenZip = @($env:ProgramFiles, ${env:ProgramFiles(x86)}) |
            Where-Object { $_ } |
            ForEach-Object { Join-Path $_ '7-Zip\7z.exe' } |
            Where-Object { Test-Path -LiteralPath $_ } |
            Select-Object -First 1
    }

    if ($sevenZip) {
        Write-Output "Using 7-Zip at: $sevenZip"
        & $sevenZip x $TempPath "-o$TargetDir" -y
        if ($LASTEXITCODE -ne 0) {
            throw "7-Zip failed with exit code $LASTEXITCODE"
        }
    }

    if (-not $sevenZip) {
        Write-Warning '7-Zip (7z/7za) not found on PATH or under Program Files — falling back to Expand-Archive (significantly slower for large archives).'
        Expand-Archive -Path $TempPath -DestinationPath $TargetDir -Force
    }

    $versionFile = Join-Path $TargetDir '.bundle-version'
    Set-Content -Path $versionFile -Value $latestVersion -NoNewline
    Write-Output "Recorded bundle version $latestVersion to $versionFile"
    Write-Output "Done! Unpacked $latestVersion to $TargetDir"
}
finally {
    if ($tempDownloaded -and (Test-Path -LiteralPath $TempPath)) {
        Remove-Item -LiteralPath $TempPath -Force
    }
}
