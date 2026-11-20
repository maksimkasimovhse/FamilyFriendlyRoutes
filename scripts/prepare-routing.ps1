param([switch]$Refresh)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$dataDir = Join-Path $repoRoot 'data\routing'
New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
$baseUrl = 'https://download.openstreetmap.fr/extracts/russia/volga_federal_district'
$sourceUrl = "$baseUrl/nizhny_novgorod_oblast-latest.osm.pbf"
$pbfPath = Join-Path $dataDir 'nizhny-novgorod.osm.pbf'
$manifestPath = Join-Path $dataDir 'source-manifest.json'
function Get-RemoteText([string]$Url) {
    $content = (Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 30).Content
    if ($content -is [byte[]]) { return [Text.Encoding]::UTF8.GetString($content) }
    return [string]$content
}
if ((Test-Path -LiteralPath $pbfPath) -and (Test-Path -LiteralPath $manifestPath) -and -not $Refresh) {
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    if ((Get-FileHash -LiteralPath $pbfPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $manifest.sha256) {
        throw 'Existing PBF checksum does not match manifest. Use -Refresh to download again.'
    }
    Write-Output "Verified existing OSM snapshot: $($manifest.routing_data_version)"
    return
}
$partialPath = "$pbfPath.partial"
$oldProgressPreference = $ProgressPreference
try {
    $ProgressPreference = 'SilentlyContinue'
    Write-Output 'Downloading Nizhny Novgorod oblast OSM extract (approximately 75 MB)...'
    if (-not (Test-Path -LiteralPath $partialPath) -or $Refresh) {
        Invoke-WebRequest -UseBasicParsing -Uri $sourceUrl -OutFile $partialPath -TimeoutSec 300
    }
    $checksumText = Get-RemoteText "$baseUrl/nizhny_novgorod_oblast.osm.pbf.md5"
    $expectedMD5 = [regex]::Match([string]$checksumText, '[a-fA-F0-9]{32}').Value.ToLowerInvariant()
    if (-not $expectedMD5) { throw 'Provider returned no valid MD5 checksum.' }
    $actualMD5 = (Get-FileHash -LiteralPath $partialPath -Algorithm MD5).Hash.ToLowerInvariant()
    if ($actualMD5 -ne $expectedMD5) { throw 'Provider checksum mismatch; keep current snapshot and retry later.' }
    $sha256 = (Get-FileHash -LiteralPath $partialPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $stateText = Get-RemoteText "$baseUrl/nizhny_novgorod_oblast.state.txt"
    Move-Item -LiteralPath $partialPath -Destination $pbfPath -Force
    [ordered]@{
        source_url = $sourceUrl
        downloaded_at = [DateTimeOffset]::UtcNow.ToString('o')
        provider_state = $stateText.Trim()
        md5 = $actualMD5
        sha256 = $sha256
        size_bytes = (Get-Item -LiteralPath $pbfPath).Length
        routing_data_version = "osm-nizhny-$sha256"
        attribution = ([string][char]0x00A9 + ' OpenStreetMap contributors')
        license_url = 'https://www.openstreetmap.org/copyright'
    } | ConvertTo-Json | Set-Content -LiteralPath $manifestPath -Encoding utf8
    Write-Output "Verified and saved OSM snapshot: osm-nizhny-$sha256"
} finally { $ProgressPreference = $oldProgressPreference }
