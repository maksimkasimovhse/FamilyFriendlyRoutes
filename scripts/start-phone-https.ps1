param(
    [string]$LanIP = '',
    [ValidateRange(1024, 65535)][int]$HttpsPort = 8443,
    [ValidateRange(1024, 65535)][int]$CertificatePort = 8088,
    [switch]$SkipBuild
)
$ErrorActionPreference = 'Stop'
$taskRepo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Set-Location -LiteralPath $taskRepo

if (!$LanIP) {
    $taskCandidates = foreach ($taskAdapter in [Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) {
        if ($taskAdapter.OperationalStatus -ne 'Up') { continue }
        $taskProperties = $taskAdapter.GetIPProperties()
        if (!($taskProperties.GatewayAddresses | Where-Object { $_.Address.ToString() -notin @('0.0.0.0', '::') })) { continue }
        foreach ($taskAddress in $taskProperties.UnicastAddresses) {
            $taskValue = $taskAddress.Address.ToString()
            if ($taskValue -match '^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.)') {
                [pscustomobject]@{ IP = $taskValue; Priority = [int]($taskAdapter.NetworkInterfaceType -ne 'Wireless80211') }
            }
        }
    }
    $LanIP = ($taskCandidates | Sort-Object Priority | Select-Object -First 1).IP
}
$taskParsedIP = $null
if (![Net.IPAddress]::TryParse($LanIP, [ref]$taskParsedIP) -or $taskParsedIP.AddressFamily -ne 'InterNetwork' -or $LanIP -notmatch '^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.)') {
    throw 'Укажите локальный IPv4 компьютера в Wi-Fi: -LanIP 192.168.1.10'
}
if ($HttpsPort -eq $CertificatePort) { throw 'Порты HTTPS и сертификата должны различаться.' }
if (!(Test-Path -LiteralPath '.env')) { throw 'Сначала создайте .env по .env.example и настройте PostgreSQL.' }

# Persist only these public local configuration values, preserving all secrets.
$taskEnvFile = Join-Path $taskRepo '.env'
$taskEnvText = [IO.File]::ReadAllText($taskEnvFile)
$taskSettings = @{CADDY_HOST=$LanIP; CADDY_BIND_ADDRESS=$LanIP; CADDY_HTTPS_PORT="$HttpsPort"; CADDY_CERT_PORT="$CertificatePort"}
foreach ($taskSetting in $taskSettings.GetEnumerator()) {
    $taskPattern = '(?m)^' + [regex]::Escape($taskSetting.Key) + '=.*$'
    $taskLine = $taskSetting.Key + '=' + $taskSetting.Value
    if ([regex]::IsMatch($taskEnvText, $taskPattern)) { $taskEnvText = [regex]::Replace($taskEnvText, $taskPattern, $taskLine) }
    else { $taskEnvText = $taskEnvText.TrimEnd() + "`n" + $taskLine + "`n" }
}
[IO.File]::WriteAllText($taskEnvFile, $taskEnvText, [Text.UTF8Encoding]::new($false))

docker compose --profile https config --quiet
if ($LASTEXITCODE -ne 0) { throw 'Ошибка конфигурации Compose.' }
if (!$SkipBuild) {
    docker compose build backend
    if ($LASTEXITCODE -ne 0) { throw 'Не удалось собрать backend.' }
}
docker compose up -d --no-build backend web
if ($LASTEXITCODE -ne 0) { throw 'Не удалось запустить backend/web.' }
docker compose exec -T web nginx -t
if ($LASTEXITCODE -ne 0) { throw 'Неверная конфигурация nginx.' }
docker compose exec -T web nginx -s reload
if ($LASTEXITCODE -ne 0) { throw 'Не удалось обновить nginx.' }
docker compose --profile https up -d --no-build caddy
if ($LASTEXITCODE -ne 0) { throw 'Не удалось запустить Caddy; проверьте, свободны ли выбранные порты и есть ли образ caddy:2.' }
docker compose --profile https exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
if ($LASTEXITCODE -ne 0) { throw 'Не удалось обновить конфигурацию Caddy.' }

$taskCertificateDir = Join-Path $taskRepo 'infra/docker/certs'
New-Item -ItemType Directory -Path $taskCertificateDir -Force | Out-Null
$taskCertificateFile = Join-Path $taskCertificateDir 'family-routes-root.crt'
for ($taskAttempt=0; $taskAttempt -lt 15; $taskAttempt++) {
    docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt $taskCertificateFile 2>$null
    if ($LASTEXITCODE -eq 0) { break }
    Start-Sleep -Seconds 1
}
if ($LASTEXITCODE -ne 0) { throw 'Caddy ещё не создал сертификат. Проверьте docker compose logs caddy.' }
Write-Host "`nС телефона в той же Wi-Fi-сети: https://${LanIP}:$HttpsPort"
Write-Host "Публичный корневой сертификат: http://${LanIP}:$CertificatePort/root.crt"
Write-Host "Копия сертификата на компьютере: $taskCertificateFile"
Write-Host 'Установите сертификат на телефон и включите полное доверие. Инструкция: docs/phone_https.md'
