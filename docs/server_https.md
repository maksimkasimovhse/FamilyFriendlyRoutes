# Публичный HTTPS на существующем сервере

В репозитории подготовлены `compose.server.yaml` и `infra/docker/Caddyfile.public`.
Caddy получает и продлевает публичный сертификат, перенаправляет HTTP на HTTPS.
Установка сертификата на телефон не нужна. Геолокация требует разрешения браузера.

Путь: браузер → Caddy:443 → web:8001 → backend:8080. Внутренние порты backend и web:8001 не публикуются. Локальная диагностика доступна на 127.0.0.1:8000.

## Один раз на сервере

В существующий `.env` добавить адрес без https:// и без пути:

```dotenv
PUBLIC_HOST=ВАШ-ПУБЛИЧНЫЙ-IP.sslip.io
```

Например, IP `1.2.3.4` соответствует `1-2-3-4.sslip.io`.
Можно использовать свой домен, направленный на сервер. Адрес должен разрешаться в публичный IP этого сервера. Порты TCP 80/443 должны быть доступны снаружи и свободны; если Caddy уже обслуживает другое приложение на этих портах, нужно добавить сайт в существующий прокси вместо запуска второго. UDP 443 необязателен (HTTP/3).

Сохранить текущие POSTGRES_PASSWORD и данные БД. Для пароля со спецсимволами задать DOCKER_DATABASE_URL с URL-кодированным паролем; иначе используется POSTGRES_PASSWORD и внутренний адрес postgres:5432.

Из директории репозитория:

```bash
git pull origin main
docker compose -f compose.yaml -f compose.server.yaml up -d --build postgres
docker compose -f compose.yaml -f compose.server.yaml --profile tools run --rm --build migrate
docker compose -f compose.yaml -f compose.server.yaml --profile tools run --rm --build infra-import
docker compose -f compose.yaml -f compose.server.yaml up -d --build
```

OSM-файл и source-manifest должны уже находиться в data/routing (существующий deploy-main.sh подготавливает их сам). Не удалять тома БД/маршрутизатора. Сертификаты хранятся в отдельных именованных Docker-томах.

Открыть `https://ВАШ-АДРЕС` на телефоне. Не использовать localhost или локальный IP компьютера в PUBLIC_HOST.

## Обновления

Установленный updater `ops/deploy-main.sh` автоматически выбирает compose.server.yaml, когда PUBLIC_HOST задан в `.env`, и сохраняет HTTPS при последующих обновлениях. Если updater установлен отдельной копией в /usr/local/bin, один раз обновить её из репозитория:

```bash
sudo install -m 755 ops/deploy-main.sh /usr/local/bin/family-routes-deploy-main
```

Без updater после git pull использовать ту же пару `-f` при `up -d --build`. Локальный compose.override.yaml с компьютера не переносить: явные `-f` его не загружают.

## Проверка

```bash
docker compose -f compose.yaml -f compose.server.yaml ps
docker compose -f compose.yaml -f compose.server.yaml logs --tail 60 caddy
curl -I "https://ВАШ-АДРЕС/"
curl -f "https://ВАШ-АДРЕС/api/v1/session"
```

В этом изменении конфигурация проверена локально. Получение реального публичного сертификата проверяется после запуска на сервере с его адресом.
