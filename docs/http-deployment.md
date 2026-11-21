# Публичный HTTP для тестового стенда

Nginx принимает HTTP на порту 80, а контейнеры остаются привязаны к `127.0.0.1`.
Наружу опубликованы только следующие маршруты:

| Маршрут | Назначение |
|---|---|
| `GET /health` | состояние стенда |
| `GET /parser/health` | readiness parser-service |
| `GET /model/health` | readiness model-service |
| `GET /routing/status` | readiness Valhalla |
| `POST /api/v1/rankings` | тестовое ранжирование без LLM credentials |
| `/*` | frontend и его backend API через внутренний web-контейнер |

PostgreSQL, полный Valhalla API и endpoints парсинга сайтов снаружи не публикуются. Для API
установлены лимит 256 KiB и rate limit 10 запросов/с на IP. До появления домена стенд доступен по
`http://51.250.0.195`; после привязки домена нужно выпустить TLS-сертификат и включить HTTPS.
