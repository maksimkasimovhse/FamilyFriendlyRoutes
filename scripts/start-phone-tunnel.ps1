param([switch]$SkipBuild, [ValidateRange(15,180)][int]$StartupTimeoutSec=90)
$ErrorActionPreference = 'Stop'
$taskRepo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Set-Location -LiteralPath $taskRepo
if (!(Test-Path -LiteralPath '.env')) { throw 'Сначала настройте .env по .env.example.' }
docker compose --profile tunnel config --quiet
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
docker compose --profile tunnel up -d --no-build cloudflared
if ($LASTEXITCODE -ne 0) { throw 'Не удалось запустить cloudflared.' }

Write-Host 'Ожидаю публичную HTTPS-ссылку...'
$taskDeadline = [DateTime]::UtcNow.AddSeconds($StartupTimeoutSec)
$taskAttempt = 0
while ([DateTime]::UtcNow -lt $taskDeadline) {
    $taskLog = docker compose --profile tunnel logs --no-color --tail 150 cloudflared 2>&1 | Out-String
    $taskMatches = [regex]::Matches($taskLog, 'https://[a-z0-9-]+\.trycloudflare\.com')
    if ($taskMatches.Count -gt 0) {
        $taskURL = $taskMatches[$taskMatches.Count-1].Value
        if ($taskLog.LastIndexOf('Registered tunnel connection') -lt $taskLog.LastIndexOf($taskURL)) { Start-Sleep -Seconds 1; continue }
        try {
            $taskProbe = Invoke-WebRequest -Uri $taskURL -TimeoutSec 8 -UseBasicParsing
            if ($taskProbe.StatusCode -ne 200 -or $taskProbe.Content -notmatch 'js/app.js') { throw 'Приложение ещё не доступно.' }
        } catch { Start-Sleep -Seconds 1; continue }
        $taskOutput = Join-Path $taskRepo 'data/backend/phone-tunnel-url.txt'
        New-Item -ItemType Directory -Path (Split-Path $taskOutput) -Force | Out-Null
        [IO.File]::WriteAllText($taskOutput, $taskURL, [Text.UTF8Encoding]::new($false))
        Write-Host "`nОткройте на телефоне: $taskURL"
        Write-Host 'Установка сертификата не нужна. Разрешите геопозицию в браузере.'
        Write-Host 'Ссылка публичная и временная; компьютер и Docker должны работать.'
        Write-Host 'Остановить: docker compose --profile tunnel stop cloudflared'
        exit 0
    }
    if ($taskAttempt -in @(20,40)) { Write-Host 'Туннель ещё подключается; проверяю исходящее соединение с Cloudflare...' }
    $taskAttempt++
    Start-Sleep -Seconds 1
}
throw 'Туннель не подключился. Проверьте docker compose --profile tunnel logs --tail 50 cloudflared. Для Cloudflare нужны исходящие соединения UDP/TCP 7844.'
