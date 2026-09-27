param(
    [string]$CacheDirectory = (Join-Path $env:APPDATA 'chrome_143\mapviewer_nav_cache\v4'),
    [string]$OutputDirectory = (Join-Path (Get-Location) 'navigation-cache-parts'),
    [string]$PackageName = 'nemesis-navigation-cache-v4',
    [ValidateRange(8, 80)]
    [int]$PartSizeMiB = 64
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$cachePath = [System.IO.Path]::GetFullPath($CacheDirectory)
if (-not (Test-Path -LiteralPath $cachePath -PathType Container)) {
    throw "Cache directory does not exist: $cachePath"
}

$cacheFiles = @(Get-ChildItem -LiteralPath $cachePath -File -Filter '*.mvnav' | Sort-Object Name)
if ($cacheFiles.Count -eq 0) {
    throw "No .mvnav files found in: $cachePath"
}

$safePackageName = ($PackageName.Trim() -replace '[^a-zA-Z0-9._-]', '-')
if ([string]::IsNullOrWhiteSpace($safePackageName)) {
    throw 'PackageName must contain at least one letter or number.'
}

$outputRoot = [System.IO.Path]::GetFullPath($OutputDirectory)
[System.IO.Directory]::CreateDirectory($outputRoot) | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$sessionDirectory = Join-Path $outputRoot "$safePackageName-$stamp"
[System.IO.Directory]::CreateDirectory($sessionDirectory) | Out-Null

$archiveName = "$safePackageName-$stamp.zip"
$archivePath = Join-Path $sessionDirectory $archiveName
Write-Host "Compressing $($cacheFiles.Count) cache files..."
Compress-Archive -LiteralPath $cacheFiles.FullName -DestinationPath $archivePath -CompressionLevel Optimal

$archive = Get-Item -LiteralPath $archivePath
$maximumArchiveBytes = 2GB
if ($archive.Length -gt $maximumArchiveBytes) {
    throw "Archive exceeds the 2 GiB server limit: $($archive.Length) bytes"
}

$archiveSha256 = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
$partSizeBytes = [int64]$PartSizeMiB * 1MB
$partCount = [int][Math]::Ceiling($archive.Length / [double]$partSizeBytes)
if ($partCount -gt 64) {
    throw "Archive needs $partCount parts; the server accepts at most 64. Increase PartSizeMiB."
}

$parts = [System.Collections.Generic.List[object]]::new()
$inputStream = [System.IO.File]::OpenRead($archivePath)
$buffer = [byte[]]::new(4MB)
try {
    for ($partIndex = 1; $partIndex -le $partCount; $partIndex++) {
        $partName = '{0}.part{1:D4}.bin' -f $safePackageName, $partIndex
        $partPath = Join-Path $sessionDirectory $partName
        $remaining = [Math]::Min($partSizeBytes, $archive.Length - $inputStream.Position)
        $expectedPartBytes = $remaining
        $outputStream = [System.IO.File]::Create($partPath)
        try {
            while ($remaining -gt 0) {
                $requested = [int][Math]::Min($buffer.Length, $remaining)
                $read = $inputStream.Read($buffer, 0, $requested)
                if ($read -le 0) { throw 'Unexpected end of ZIP while splitting parts.' }
                $outputStream.Write($buffer, 0, $read)
                $remaining -= $read
            }
        }
        finally {
            $outputStream.Dispose()
        }

        $partHash = (Get-FileHash -LiteralPath $partPath -Algorithm SHA256).Hash.ToLowerInvariant()
        $parts.Add([ordered]@{
            index     = $partIndex
            file_name = $partName
            byte_size = [int64]$expectedPartBytes
            sha256    = $partHash
        })
        Write-Host ("Created part {0}/{1}: {2} ({3:N1} MiB)" -f
            $partIndex, $partCount, $partName, ($expectedPartBytes / 1MB))
    }
}
finally {
    $inputStream.Dispose()
}

$manifest = [ordered]@{
    format         = 'rabbit-navigation-cache-parts'
    version        = 1
    archive_name   = $archiveName
    archive_size   = [int64]$archive.Length
    archive_sha256 = $archiveSha256
    part_count     = $partCount
    part_size      = $partSizeBytes
    created_at     = (Get-Date).ToUniversalTime().ToString('o')
    parts          = $parts
}
$manifestPath = Join-Path $sessionDirectory 'navigation-cache-parts.json'
$manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $manifestPath -Encoding utf8

# The complete ZIP was only an intermediate artifact. The manifest plus parts
# are sufficient to recreate it byte-for-byte on the server.
[System.IO.File]::Delete($archivePath)

$totalMiB = [Math]::Round($manifest.archive_size / 1MB, 1)
Write-Host ''
Write-Host "Ready: $sessionDirectory"
Write-Host "$partCount parts, $totalMiB MiB compressed, SHA-256 $archiveSha256"
Write-Host 'Select this folder in Admin -> Navigation Caches.'
